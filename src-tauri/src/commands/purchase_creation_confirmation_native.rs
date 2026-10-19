//! Read-only recovery of an uncertain 044 purchase-creation IPC response.
//! A 044 nonce remains single-use: this command never invokes the writer.
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::purchase_dto::NativePurchaseRequest;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurchaseCreationConfirmationInput {
    request_id: String,
    supplier_id: i64,
    expected_status: String,
    expected_line_count: i64,
    expected_total_cents: i64,
    #[serde(default)]
    expected_draft_payload: Option<NativePurchaseRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseCreationAcknowledged {
    request_id: String,
    invoice_id: String,
    status: String,
    total_cents: i64,
    supplier_id: i64,
    line_count: i64,
}

async fn confirm_purchase_creation(
    conn: &mut SqliteConnection,
    actor: &str,
    input: &PurchaseCreationConfirmationInput,
) -> Result<Option<PurchaseCreationAcknowledged>, String> {
    super::sales_cogs_provenance::canonical_request_id(&input.request_id)?;
    if !matches!(input.expected_status.as_str(), "draft" | "completed")
        || input.supplier_id <= 0
        || !(0..=200).contains(&input.expected_line_count)
        || !(0..=100_000_000_000_000).contains(&input.expected_total_cents)
        || (input.expected_status == "draft" && input.expected_total_cents != 0)
        || (input.expected_status == "completed"
            && (input.expected_total_cents == 0 || input.expected_line_count == 0))
    {
        return Err("Invalid purchase creation acknowledgement request".into());
    }
    reset_cancelled_read_state(conn).await?;
    // Bind actor, receipt, mutable source and original request/source hashes
    // to one SQLite read snapshot. Otherwise an edit could interleave between
    // the receipt SELECT and source fingerprint verification.
    let mut snapshot = conn.begin().await.map_err(|e| e.to_string())?;
    let (role, pharmacy) = active_generic_actor(&mut snapshot, actor).await?;
    // A live owner is not the only legitimate native purchase creator.
    // Mirror the writer's can_view_purchases grant instead of making a
    // permitted pharmacist/admin unable to resolve an ambiguous IPC success.
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *snapshot)
    .await
    .map_err(|e| e.to_string())?;
    if !super::permission_policy::user_can_view_purchases(Some(&role), permissions.as_deref()) {
        return Err("Purchase creation acknowledgement requires live purchase permission".into());
    }
    // 047 adds prospective, source-derived draft content witnesses. The
    // original 044 rows without those witnesses remain unverifiable when
    // nonempty; the renderer cannot manufacture the stored request digest.
    if input.expected_status != "draft" && input.expected_draft_payload.is_some() {
        return Err("Draft content was supplied for a completed purchase".into());
    }
    let row = sqlx::query(
        r#"
        SELECT r.invoice_id, r.source_status, r.source_total_cents, r.source_line_count
        FROM main.native_purchase_create_requests r
        JOIN main.purchase_invoices p ON p.id=r.invoice_id
        WHERE r.request_id=? AND r.actor_id=? AND r.pharmacy_id=?
          AND r.supplier_id=? AND r.source_status=?
          AND r.source_line_count=? AND r.source_total_cents=?
          AND p.pharmacy_id=r.pharmacy_id AND CAST(p.user_id AS TEXT)=r.actor_id
          AND p.supplier_id=r.supplier_id AND p.status=r.source_status
          AND typeof(p.total_amount) IN ('integer','real')
          AND abs(p.total_amount*100-r.source_total_cents)<0.0001
          AND (SELECT count(*) FROM main.purchase_invoice_items i
               WHERE i.invoice_id=p.id)=r.source_line_count
          AND (
            (r.source_status='draft'
             AND r.initial_journal_id IS NULL AND r.source_total_cents=0
             AND NOT EXISTS(SELECT 1 FROM main.native_purchase_posting_events ev
                            WHERE ev.invoice_id=p.id))
            OR
            (r.source_status='completed' AND r.initial_journal_id IS NOT NULL
             AND (SELECT count(*) FROM main.native_purchase_posting_events initial
                  WHERE initial.invoice_id=p.id AND initial.event_kind='initial')=1
             AND EXISTS(
              SELECT 1 FROM main.native_purchase_posting_events ev
              JOIN main.daily_journals j ON j.id=ev.journal_id
              WHERE ev.invoice_id=p.id AND ev.event_kind='initial'
                AND ev.journal_id=r.initial_journal_id
                AND ev.actor_id=r.actor_id AND ev.pharmacy_id=r.pharmacy_id
                AND ev.supplier_id=r.supplier_id
                AND ev.new_total_cents=r.source_total_cents
                AND ev.old_total_cents=0
                AND ev.signed_cents=r.source_total_cents
                AND ev.payment_method=p.payment_method
                AND j.pharmacy_id=r.pharmacy_id
                AND CAST(j.created_by AS TEXT)=r.actor_id
                AND typeof(j.total_amount) IN ('integer','real')
                AND abs(j.total_amount*100-r.source_total_cents)<0.0001
                AND json_valid(ev.line_snapshot)
                AND json_type(ev.line_snapshot)='array'
                AND json_array_length(ev.line_snapshot)=r.source_line_count
                AND (SELECT count(DISTINCT json_extract(w.value,'$.lineId'))
                     FROM json_each(ev.line_snapshot) w)=r.source_line_count
                AND NOT EXISTS(
                  SELECT 1 FROM json_each(ev.line_snapshot) witness
                  LEFT JOIN main.purchase_invoice_items line
                    ON line.id=CAST(json_extract(witness.value,'$.lineId') AS INTEGER)
                      AND line.invoice_id=p.id
                  LEFT JOIN main.inventory lot
                    ON lot.id=line.inventory_id AND lot.pharmacy_id=r.pharmacy_id
                      AND lot.drug_id=line.drug_id
                  WHERE line.id IS NULL OR lot.id IS NULL
                    OR json_type(witness.value,'$.lineId') IS NULL
                    OR json_type(witness.value,'$.inventoryId')!='text'
                    OR json_type(witness.value,'$.drugId') IS NULL
                    OR COALESCE(json_type(witness.value,'$.quantity'),'null') NOT IN ('integer','real')
                    OR COALESCE(json_type(witness.value,'$.bonus'),'null') NOT IN ('integer','real')
                    OR COALESCE(json_type(witness.value,'$.cost'),'null') NOT IN ('integer','real')
                    OR COALESCE(json_type(witness.value,'$.tax'),'null') NOT IN ('integer','real')
                    OR COALESCE(json_type(witness.value,'$.discount'),'null') NOT IN ('integer','real')
                    OR typeof(line.quantity) NOT IN ('integer','real')
                    OR typeof(line.cost_price) NOT IN ('integer','real')
                    OR typeof(line.bonus_quantity) NOT IN ('integer','real','null')
                    OR typeof(line.tax_percent) NOT IN ('integer','real','null')
                    OR typeof(line.discount_percent) NOT IN ('integer','real','null')
                    OR json_extract(witness.value,'$.originalLotVerifiable') IS NOT 1
                    OR json_extract(witness.value,'$.inventoryId') IS NOT line.inventory_id
                    OR json_extract(witness.value,'$.drugId') IS NOT line.drug_id
                    OR abs(CAST(json_extract(witness.value,'$.quantity') AS REAL)-line.quantity)>0.0000001
                    OR abs(CAST(json_extract(witness.value,'$.bonus') AS REAL)-COALESCE(line.bonus_quantity,0))>0.0000001
                    OR abs(CAST(json_extract(witness.value,'$.cost') AS REAL)-line.cost_price)>0.0000001
                    OR abs(CAST(json_extract(witness.value,'$.tax') AS REAL)-COALESCE(line.tax_percent,0))>0.0000001
                    OR abs(CAST(json_extract(witness.value,'$.discount') AS REAL)-COALESCE(line.discount_percent,0))>0.0000001
                )
                AND EXISTS(
                  SELECT 1 FROM main.journal_entries entry
                  JOIN main.accounts a ON a.id=entry.account_id
                  WHERE entry.journal_id=j.id GROUP BY entry.journal_id
                  HAVING count(*)=2
                    AND sum(CASE WHEN typeof(entry.amount) IN ('integer','real')
                             THEN 1 ELSE 0 END)=2
                    AND abs(sum(CASE WHEN entry.type='debit' THEN entry.amount ELSE 0 END)
                          -sum(CASE WHEN entry.type='credit' THEN entry.amount ELSE 0 END))<0.000001
                    AND sum(CASE WHEN a.code='1.1.3' AND entry.type='debit'
                      AND abs(entry.amount*100-r.source_total_cents)<0.0001
                      THEN 1 ELSE 0 END)=1
                    AND sum(CASE WHEN a.code=(CASE WHEN ev.payment_method='cash'
                             THEN '1.1.1' ELSE '2.1' END) AND entry.type='credit'
                      AND abs(entry.amount*100-r.source_total_cents)<0.0001
                      THEN 1 ELSE 0 END)=1
                )
             )
             AND NOT EXISTS(SELECT 1 FROM main.native_purchase_posting_events later
                            WHERE later.invoice_id=p.id AND later.event_kind!='initial'))
          )
        LIMIT 1
        "#,
    )
    .bind(&input.request_id)
    .bind(actor)
    .bind(&pharmacy)
    .bind(input.supplier_id)
    .bind(&input.expected_status)
    .bind(input.expected_line_count)
    .bind(input.expected_total_cents)
    .fetch_optional(&mut *snapshot)
    .await
    .map_err(|e| format!("Cannot verify purchase creation receipt: {e}"))?;
    let Some(row) = row else { return Ok(None) };
    let status: String = row.try_get("source_status").map_err(|e| e.to_string())?;
    if status == "draft" {
        let evidence = sqlx::query(
            "SELECT original_request_sha256,original_source_sha256
             FROM main.native_purchase_draft_create_witnesses
             WHERE request_id=? AND invoice_id=? AND actor_id=? AND pharmacy_id=?",
        )
        .bind(&input.request_id)
        .bind(
            row.try_get::<String, _>("invoice_id")
                .map_err(|e| e.to_string())?,
        )
        .bind(actor)
        .bind(&pharmacy)
        .fetch_optional(&mut *snapshot)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(evidence) = evidence {
            let Some(expected) = input.expected_draft_payload.as_ref() else {
                return Ok(None);
            };
            if expected.supplier_id != input.supplier_id
                || expected.cart.len() as i64 != input.expected_line_count
                || expected.status.as_deref() != Some("draft")
            {
                return Ok(None);
            }
            let expected_hash =
                super::purchase_posting_provenance::purchase_draft_request_sha256(expected)?;
            if evidence
                .try_get::<String, _>("original_request_sha256")
                .ok()
                .as_deref()
                != Some(expected_hash.as_str())
            {
                return Ok(None);
            }
            let original_source_hash: String = evidence
                .try_get("original_source_sha256")
                .map_err(|e| e.to_string())?;
            let current_hash = super::purchase_posting_provenance::purchase_draft_source_sha256(
                &mut snapshot,
                &row.try_get::<String, _>("invoice_id")
                    .map_err(|e| e.to_string())?,
                actor,
                &pharmacy,
            )
            .await?;
            if current_hash.as_deref() != Some(original_source_hash.as_str()) {
                return Ok(None);
            }
        } else if input.expected_line_count != 0 {
            // 044 has no full-content proof of older nonempty drafts.
            return Ok(None);
        }
    }
    let result = PurchaseCreationAcknowledged {
        request_id: input.request_id.clone(),
        invoice_id: row.try_get("invoice_id").map_err(|e| e.to_string())?,
        status,
        total_cents: row
            .try_get("source_total_cents")
            .map_err(|e| e.to_string())?,
        supplier_id: input.supplier_id,
        line_count: row
            .try_get("source_line_count")
            .map_err(|e| e.to_string())?,
    };
    snapshot.commit().await.map_err(|e| e.to_string())?;
    Ok(Some(result))
}

#[tauri::command]
pub async fn confirm_purchase_creation_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PurchaseCreationConfirmationInput,
) -> Result<Option<PurchaseCreationAcknowledged>, String> {
    let actor = session.authorize_session().await?;
    let actor = actor
        .as_deref()
        .ok_or("Purchase creation acknowledgement requires login")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    confirm_purchase_creation(&mut conn, actor, &payload).await
}

#[cfg(test)]
mod tests {
    use super::super::purchase_posting_provenance::{
        purchase_draft_request_sha256, purchase_draft_source_sha256,
    };
    use super::*;
    use sqlx::{Connection, Executor};

    const NONCE: &str = "12345678-abcd-4abc-8abc-123456789abc";

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,is_active INTEGER,role TEXT,permissions TEXT);
            INSERT INTO users VALUES('owner-a','A',1,'owner','{}'),('owner-b','B',1,'owner','{}'),
              ('cashier-a','A',1,'cashier','{"can_view_purchases":false}'),('inactive-a','A',0,'owner','{}');
            CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT,
              supplier_id INTEGER,status TEXT,total_amount REAL,payment_method TEXT);
            INSERT INTO purchase_invoices VALUES('invoice-a','A','owner-a',7,'completed',20,'credit'),
              ('draft-a','A','owner-a',7,'draft',0,'credit');
            CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,
              inventory_id TEXT,drug_id INTEGER,quantity REAL,bonus_quantity REAL,
              cost_price REAL,tax_percent REAL,discount_percent REAL);
            INSERT INTO purchase_invoice_items VALUES
              (1,'invoice-a','lot-a',9,2,0,10,0,0);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
            INSERT INTO inventory VALUES('lot-a','A',9);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,
              created_by TEXT,total_amount REAL);
            INSERT INTO daily_journals VALUES('journal-a','A','owner-a',20);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,type TEXT);
            INSERT INTO accounts VALUES(1,'1.1.3','asset'),(2,'2.1','liability');
            CREATE TABLE journal_entries(journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            INSERT INTO journal_entries VALUES('journal-a',1,'debit',20),('journal-a',2,'credit',20);
            CREATE TABLE native_purchase_posting_events(invoice_id TEXT,actor_id TEXT,
              pharmacy_id TEXT,supplier_id INTEGER,event_kind TEXT,journal_id TEXT,
              new_total_cents INTEGER,old_total_cents INTEGER,signed_cents INTEGER,
              payment_method TEXT,line_snapshot TEXT);
            INSERT INTO native_purchase_posting_events VALUES
              ('invoice-a','owner-a','A',7,'initial','journal-a',2000,0,2000,'credit',
              '[{"lineId":1,"inventoryId":"lot-a","originalLotVerifiable":true,
                 "drugId":9,"quantity":2,"bonus":0,"cost":10,"tax":0,"discount":0}]');"#,
        ).execute(&mut conn).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/044_purchase_create_request_receipts.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/047_purchase_draft_create_witnesses.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO native_purchase_create_requests
             (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,
              source_total_cents,source_line_count,initial_journal_id)
             VALUES('12345678-abcd-4abc-8abc-123456789abc','invoice-a','owner-a','A',7,
                    'completed',2000,1,'journal-a')",
        )
        .await
        .unwrap();
        conn
    }

    fn request(nonce: &str) -> PurchaseCreationConfirmationInput {
        PurchaseCreationConfirmationInput {
            request_id: nonce.into(),
            supplier_id: 7,
            expected_status: "completed".into(),
            expected_line_count: 1,
            expected_total_cents: 2000,
            expected_draft_payload: None,
        }
    }

    async fn receipted_nonempty_draft() -> (SqliteConnection, PurchaseCreationConfirmationInput) {
        let mut conn = fixture().await;
        // Expand the minimal legacy-044 test fixture with the actual 047
        // source-bound fields, not a synthetic digest supplied by a renderer.
        sqlx::raw_sql(
            "ALTER TABLE purchase_invoices ADD COLUMN invoice_number TEXT;
             ALTER TABLE purchase_invoices ADD COLUMN invoice_date TEXT;
             ALTER TABLE purchase_invoices ADD COLUMN notes TEXT;
             ALTER TABLE purchase_invoices ADD COLUMN check_number TEXT;
             ALTER TABLE purchase_invoices ADD COLUMN expenses REAL DEFAULT 0;
             ALTER TABLE purchase_invoices ADD COLUMN discount_value REAL DEFAULT 0;
             ALTER TABLE purchase_invoices ADD COLUMN discount_percent REAL DEFAULT 0;
             ALTER TABLE purchase_invoices ADD COLUMN tax_percent REAL DEFAULT 0;
             ALTER TABLE purchase_invoice_items ADD COLUMN unit_id INTEGER;
             ALTER TABLE purchase_invoice_items ADD COLUMN expiry_date TEXT;
             ALTER TABLE purchase_invoice_items ADD COLUMN selling_price REAL;
             ALTER TABLE purchase_invoice_items ADD COLUMN strips_per_box INTEGER DEFAULT 1;
             ALTER TABLE purchase_invoice_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
             ALTER TABLE purchase_invoice_items ADD COLUMN barcode TEXT;
             INSERT INTO purchase_invoice_items
                (id,invoice_id,drug_id,quantity,bonus_quantity,cost_price,tax_percent,discount_percent)
                VALUES(2,'draft-a',9,2,0,10,0,0);
             INSERT INTO native_purchase_create_requests
                (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,
                 source_total_cents,source_line_count,initial_journal_id)
                VALUES('55555555-1234-4abc-8abc-123456789abc',
                       'draft-a','owner-a','A',7,'draft',0,1,NULL);",
        )
        .execute(&mut conn).await.unwrap();
        let request: NativePurchaseRequest = serde_json::from_value(serde_json::json!({
            "supplier_id":7,"status":"draft","cart":[{
                "id":9,"quantity":2,"cost_price":10,"bonus_quantity":0,
                "tax_percent":0,"discount_percent":0,"strips_per_box":1
            }]
        }))
        .unwrap();
        let request_hash = purchase_draft_request_sha256(&request).unwrap();
        let source_hash = purchase_draft_source_sha256(&mut conn, "draft-a", "owner-a", "A")
            .await
            .unwrap()
            .unwrap();
        sqlx::query(
            "INSERT INTO native_purchase_draft_create_witnesses
             (request_id,invoice_id,actor_id,pharmacy_id,original_request_sha256,original_source_sha256)
             VALUES(?,'draft-a','owner-a','A',?,?)",
        )
        .bind("55555555-1234-4abc-8abc-123456789abc")
        .bind(request_hash)
        .bind(source_hash)
        .execute(&mut conn).await.unwrap();
        (
            conn,
            PurchaseCreationConfirmationInput {
                request_id: "55555555-1234-4abc-8abc-123456789abc".into(),
                supplier_id: 7,
                expected_status: "draft".into(),
                expected_line_count: 1,
                expected_total_cents: 0,
                expected_draft_payload: Some(request),
            },
        )
    }

    #[tokio::test]
    async fn new_nonempty_draft_requires_both_original_request_and_unchanged_source() {
        let (mut conn, original) = receipted_nonempty_draft().await;
        assert_eq!(
            confirm_purchase_creation(&mut conn, "owner-a", &original)
                .await
                .unwrap()
                .unwrap()
                .invoice_id,
            "draft-a"
        );
        let mut missing = original;
        missing.expected_draft_payload = None;
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &missing)
            .await
            .unwrap()
            .is_none());
        let (mut conn, mut altered) = receipted_nonempty_draft().await;
        altered.expected_draft_payload.as_mut().unwrap().cart[0].quantity = 3.0;
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &altered)
            .await
            .unwrap()
            .is_none());
        let (mut conn, mut altered) = receipted_nonempty_draft().await;
        altered.expected_draft_payload.as_mut().unwrap().notes =
            Some("different original draft".into());
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &altered)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn draft_witness_fails_closed_on_tamper_tenant_and_later_edit() {
        for mutation in [
            "UPDATE purchase_invoice_items SET quantity=3 WHERE id=2",
            "UPDATE purchase_invoice_items SET cost_price=15 WHERE id=2",
            "UPDATE purchase_invoice_items SET drug_id=12 WHERE id=2",
            "UPDATE purchase_invoices SET notes='edited since original' WHERE id='draft-a'",
            "UPDATE purchase_invoices SET pharmacy_id='B' WHERE id='draft-a'",
            "UPDATE purchase_invoices SET user_id='owner-b' WHERE id='draft-a'",
            "DELETE FROM purchase_invoice_items WHERE id=2",
            "DELETE FROM purchase_invoices WHERE id='draft-a'",
        ] {
            let (mut conn, original) = receipted_nonempty_draft().await;
            conn.execute(mutation).await.unwrap();
            assert!(
                confirm_purchase_creation(&mut conn, "owner-a", &original)
                    .await
                    .unwrap()
                    .is_none(),
                "Accepted changed draft: {mutation}"
            );
        }
        let (mut conn, original) = receipted_nonempty_draft().await;
        assert!(confirm_purchase_creation(&mut conn, "owner-b", &original)
            .await
            .unwrap()
            .is_none());
        for mutation in [
            "UPDATE native_purchase_draft_create_witnesses SET original_request_sha256=replace(original_request_sha256,'a','b')",
            "DELETE FROM native_purchase_draft_create_witnesses",
        ] {
            assert!(conn.execute(mutation).await.is_err(),"Witness mutation succeeded: {mutation}");
        }
    }

    #[tokio::test]
    async fn receipt_requires_active_owner_tenant_nonce_and_exact_source_expectations() {
        let mut conn = fixture().await;
        let good = request(NONCE);
        assert_eq!(
            confirm_purchase_creation(&mut conn, "owner-a", &good)
                .await
                .unwrap()
                .unwrap()
                .invoice_id,
            "invoice-a"
        );
        assert!(confirm_purchase_creation(&mut conn, "owner-b", &good)
            .await
            .unwrap()
            .is_none());
        assert!(confirm_purchase_creation(&mut conn, "cashier-a", &good)
            .await
            .is_err());
        assert!(confirm_purchase_creation(&mut conn, "inactive-a", &good)
            .await
            .is_err());
        // Creation itself accepts explicitly permitted non-owner users. The
        // read-only acknowledgement must not strand one after losing its IPC
        // response, and it must revoke access with the current permissions.
        conn.execute("UPDATE users SET role='pharmacist',permissions='{\"can_view_purchases\":true}' WHERE id='owner-a'")
            .await.unwrap();
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &good)
            .await
            .unwrap()
            .is_some());
        conn.execute(
            "UPDATE users SET permissions='{\"can_view_purchases\":false}' WHERE id='owner-a'",
        )
        .await
        .unwrap();
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &good)
            .await
            .is_err());
        conn.execute("UPDATE users SET role='owner',permissions='{}' WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(confirm_purchase_creation(
            &mut conn,
            "owner-a",
            &request("12345678-abcd-4abc-8abc-123456789abd")
        )
        .await
        .unwrap()
        .is_none());
        assert!(
            confirm_purchase_creation(&mut conn, "owner-a", &request("not-a-uuid"))
                .await
                .is_err()
        );
        let mut changed = request(NONCE);
        changed.expected_total_cents = 2100;
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &changed)
            .await
            .unwrap()
            .is_none());
        changed = request(NONCE);
        changed.supplier_id = 8;
        assert!(confirm_purchase_creation(&mut conn, "owner-a", &changed)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn never_acknowledges_deleted_reassigned_reposted_or_relinked_purchase() {
        for mutation in [
            "DELETE FROM purchase_invoices WHERE id='invoice-a'",
            "UPDATE purchase_invoices SET pharmacy_id='B' WHERE id='invoice-a'",
            "UPDATE purchase_invoices SET user_id='owner-b' WHERE id='invoice-a'",
            "UPDATE purchase_invoices SET status='draft' WHERE id='invoice-a'",
            "UPDATE purchase_invoices SET total_amount=19 WHERE id='invoice-a'",
            "UPDATE purchase_invoices SET payment_method='cash' WHERE id='invoice-a'",
            "UPDATE journal_entries SET amount=19 WHERE account_id=1",
            "UPDATE daily_journals SET pharmacy_id='B' WHERE id='journal-a'",
            "DELETE FROM journal_entries WHERE account_id=2",
            "UPDATE purchase_invoice_items SET drug_id=10 WHERE id=1",
            "UPDATE purchase_invoice_items SET quantity=3 WHERE id=1",
            "UPDATE purchase_invoice_items SET inventory_id='foreign-lot' WHERE id=1",
            "UPDATE inventory SET pharmacy_id='B' WHERE id='lot-a'",
            "INSERT INTO native_purchase_posting_events VALUES
             ('invoice-a','owner-a','A',7,'edit_delta','journal-new',0,0,0,'credit','[]')",
        ] {
            let mut conn = fixture().await;
            conn.execute(mutation).await.unwrap();
            assert!(
                confirm_purchase_creation(&mut conn, "owner-a", &request(NONCE))
                    .await
                    .unwrap()
                    .is_none(),
                "Mutation incorrectly confirmed: {mutation}"
            );
        }
    }

    #[tokio::test]
    async fn absent_and_rolled_back_nonce_never_confirm_and_draft_evidence_is_conservative() {
        let mut conn = fixture().await;
        let draft_nonce = "12345678-9999-4999-8999-123456789abc";
        let draft_input = PurchaseCreationConfirmationInput {
            request_id: draft_nonce.into(),
            supplier_id: 7,
            expected_status: "draft".into(),
            expected_line_count: 0,
            expected_total_cents: 0,
            expected_draft_payload: None,
        };
        assert!(
            confirm_purchase_creation(&mut conn, "owner-a", &draft_input)
                .await
                .unwrap()
                .is_none()
        );
        let mut tx = conn.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO native_purchase_create_requests
             (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,
              source_total_cents,source_line_count,initial_journal_id)
             VALUES(?,'draft-a','owner-a','A',7,'draft',0,0,NULL)",
        )
        .bind(draft_nonce)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.rollback().await.unwrap();
        assert!(
            confirm_purchase_creation(&mut conn, "owner-a", &draft_input)
                .await
                .unwrap()
                .is_none()
        );
        conn.execute(
            "INSERT INTO native_purchase_create_requests
             (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,
              source_total_cents,source_line_count,initial_journal_id)
             VALUES('12345678-9999-4999-8999-123456789abc',
                    'draft-a','owner-a','A',7,'draft',0,0,NULL)",
        )
        .await
        .unwrap();
        assert!(
            confirm_purchase_creation(&mut conn, "owner-a", &draft_input)
                .await
                .unwrap()
                .is_some()
        );
        conn.execute("INSERT INTO purchase_invoice_items(invoice_id) VALUES('draft-a')")
            .await
            .unwrap();
        assert!(
            confirm_purchase_creation(&mut conn, "owner-a", &draft_input)
                .await
                .unwrap()
                .is_none()
        );
    }
}
