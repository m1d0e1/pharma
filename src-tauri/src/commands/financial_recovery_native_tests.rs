//! Cold-reopen, ambiguous-IPC and late-failure tests of *real* native financial
//! writers. All data lives in isolated test-created SQLite databases; never
//! connect to a Tauri profile, a copied customer database or a WebView.
use super::{patient_payments_native, supplier_payments_native};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Executor, SqliteConnection};
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

/// A unique throwaway local database lets a test prove the receipt survives
/// closing the native connection (unlike a single-connection :memory: test).
struct DisposableDb(PathBuf);

impl DisposableDb {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "pharma-financial-recovery-{}.sqlite",
            Uuid::new_v4()
        )))
    }

    async fn open(&self) -> SqliteConnection {
        let options = SqliteConnectOptions::new()
            .filename(&self.0)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(10));
        SqliteConnection::connect_with(&options).await.unwrap()
    }
}

impl Drop for DisposableDb {
    fn drop(&mut self) {
        // Only our own generated, UUID-named temp path may be removed.
        let _ = std::fs::remove_file(&self.0);
        for suffix in ["-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{}", self.0.display(), suffix));
        }
    }
}

fn supplier_request(id: &str, method: &str, amount: f64) -> supplier_payments_native::SupplierPaymentInput {
    serde_json::from_value(serde_json::json!({
        "supplierId": 7, "amount": amount, "paymentMethod": method,
        "date": "2026-10-18", "notes": "Synthetic restart settlement",
        "requestId": id
    }))
    .unwrap()
}

fn supplier_confirmation(
    id: &str,
    method: &str,
    amount: f64,
) -> supplier_payments_native::ConfirmSupplierPaymentInput {
    use sha2::{Digest, Sha256};
    let digest = format!(
        "{:x}",
        Sha256::digest("Synthetic restart settlement".as_bytes())
    );
    serde_json::from_value(serde_json::json!({
        "supplierId": 7, "amount": amount, "paymentMethod": method,
        "date": "2026-10-18", "notesSha256": digest,
        "requestId": id
    }))
    .unwrap()
}

async fn install_real_credit_purchase_and_supplier_receipts(db: &mut SqliteConnection) {
    sqlx::raw_sql(
        r#"
        CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
        INSERT INTO users VALUES('owner-a','owner','tenant-a',1,'{}'),('owner-b','owner','tenant-b',1,'{}');
        CREATE TABLE native_owner_scope_review(owner_id TEXT PRIMARY KEY);
        CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,balance REAL);
        INSERT INTO suppliers VALUES(7,'Isolated credit supplier',100);
        CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,
          status TEXT,payment_method TEXT,total_amount REAL,user_id TEXT);
        INSERT INTO purchase_invoices VALUES('original-credit',7,'tenant-a','completed','credit',100,'owner-a');
        CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
          quantity REAL,cost_price REAL);
        INSERT INTO inventory VALUES('original-lot',90001,'tenant-a',4,25);
        CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,
          inventory_id TEXT,quantity REAL,cost_price REAL,retail_price REAL);
        INSERT INTO purchase_invoice_items VALUES(1,'original-credit',90001,'original-lot',4,25,190);
        CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,supplier_id INTEGER,
          purchase_invoice_id TEXT,status TEXT,refund_method TEXT,total_amount REAL,user_id TEXT);
        CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,
          purchase_return_id TEXT,purchase_invoice_item_id INTEGER,inventory_id TEXT,
          drug_id INTEGER,quantity_returned REAL,total_price REAL);
        CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier_id INTEGER,
          user_id TEXT,type TEXT,amount REAL,reference_id TEXT,payment_method TEXT,notes TEXT,date TEXT);
        INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id,payment_method)
          VALUES(7,'invoice',100,'original-credit','credit');
        CREATE TABLE shifts(id TEXT PRIMARY KEY,pharmacy_id TEXT,status TEXT);
        INSERT INTO shifts VALUES('owned-shift','tenant-a','open'),('foreign-shift','tenant-b','open');
        CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,
          category TEXT,amount REAL,source_type TEXT,target_name TEXT,notes TEXT,date TEXT,pharmacy_id TEXT);
        CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
        INSERT INTO accounts VALUES(1,'2.1',0),(2,'1.1.1',0),(3,'1.1.4',0),(4,'1.1.3',0);
        CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
        CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,
          created_by TEXT,total_amount REAL,pharmacy_id TEXT);
        INSERT INTO daily_journals VALUES('origin-journal','2026-10-18',
          'Original credit purchase','owner-a',100,'tenant-a');
        CREATE TABLE journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,
          journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
        INSERT INTO journal_entries(journal_id,account_id,type,amount)
          VALUES('origin-journal',4,'debit',100),('origin-journal',1,'credit',100);
        CREATE TABLE activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,
          action TEXT,details TEXT,pharmacy_id TEXT);
        "#,
    )
    .execute(&mut *db)
    .await
    .unwrap();
    // Real migrations, not test-lookalike receipt tables or disabled guards.
    for migration in [
        include_str!("../../migrations/041_purchase_return_posting_provenance.sql"),
        include_str!("../../migrations/048_purchase_return_supplier_cash_provenance.sql"),
        include_str!("../../migrations/054_native_supplier_partial_payment.sql"),
        include_str!("../../migrations/057_supplier_cash_shift_identity_guard.sql"),
        include_str!("../../migrations/058_supplier_cash_shift_replace_guard.sql"),
        include_str!("../../migrations/059_supplier_payment_receipt_replace_guard.sql"),
        include_str!("../../migrations/042_purchase_posting_events.sql"),
    ] {
        sqlx::raw_sql(migration).execute(&mut *db).await.unwrap();
    }
    db.execute(
        r#"INSERT INTO native_purchase_posting_events
           (event_id,invoice_id,actor_id,pharmacy_id,supplier_id,event_kind,
            journal_id,payment_method,signed_cents,old_total_cents,new_total_cents,line_snapshot)
           VALUES('c715c827-482e-4c25-aed6-38f743f5a6f1','original-credit','owner-a','tenant-a',7,
                  'initial','origin-journal','credit',10000,0,10000,
                  '[{"sourceLineId":1,"quantity":4,"costPrice":25}]')"#,
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/044_purchase_create_request_receipts.sql"
    ))
    .execute(&mut *db)
    .await
    .unwrap();
    db.execute(
        "INSERT INTO native_purchase_create_requests
         (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,
          source_total_cents,source_line_count,initial_journal_id)
         VALUES('fc596adf-23f4-4cd3-a2d2-3a7f64761b1c','original-credit',
                'owner-a','tenant-a',7,'completed',10000,1,'origin-journal')",
    )
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/069_supplier_return_aware_payment_guard.sql"
    ))
    .execute(&mut *db)
    .await
    .unwrap();
}

async fn financial_counts(db: &mut SqliteConnection) -> (i64, i64, i64, i64, i64, f64) {
    sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM native_supplier_payment_receipts),
                (SELECT COUNT(*) FROM supplier_transactions WHERE type='payment'),
                (SELECT COUNT(*) FROM cash_movements),
                (SELECT COUNT(*) FROM daily_journals
                 WHERE id NOT IN ('origin-journal','credit-return-journal')),
                (SELECT COUNT(*) FROM activity_log),
                (SELECT balance FROM suppliers WHERE id=7)",
    )
    .fetch_one(db)
    .await
    .unwrap()
}

/// The real 041 insert guards certify item origin/quantity, balanced original
/// journal, actor and tenant; 048 then seals the exact supplier-return row.
async fn record_original_receipted_credit_return(db: &mut SqliteConnection) {
    db.execute("BEGIN IMMEDIATE").await.unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO purchase_returns
          (id,supplier_id,purchase_invoice_id,status,refund_method,total_amount,user_id)
          VALUES('native-credit-return',7,'original-credit','completed','credit',25,'owner-a');
        INSERT INTO purchase_return_items
          (id,purchase_return_id,purchase_invoice_item_id,inventory_id,drug_id,quantity_returned,total_price)
          VALUES(31,'native-credit-return',1,'original-lot',90001,1,25);
        INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
          VALUES(7,'return',25,'native-credit-return');
        INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
          VALUES('credit-return-journal','2026-10-18','Synthetic credit return','owner-a',25,'tenant-a');
        INSERT INTO journal_entries(journal_id,account_id,type,amount)
          VALUES('credit-return-journal',1,'debit',25),
                ('credit-return-journal',4,'credit',25);
        INSERT INTO native_purchase_return_line_provenance
          (return_item_id,return_id,purchase_invoice_item_id,inventory_id,
           quantity_returned,stock_quantity,refund_value)
          VALUES(31,'native-credit-return',1,'original-lot',1,1,25);
        INSERT INTO native_purchase_return_provenance
          (return_id,request_id,purchase_invoice_id,pharmacy_id,actor_id,supplier_id,
           journal_id,refund_method,amount_cents,line_count)
          VALUES('native-credit-return','7e8945be-34eb-44f5-8aef-7c77387b85cc',
                 'original-credit','tenant-a','owner-a',7,'credit-return-journal','credit',2500,1);
        UPDATE suppliers SET balance=75 WHERE id=7;
        UPDATE inventory SET quantity=3 WHERE id='original-lot';
        "#,
    )
    .execute(&mut *db)
    .await
    .unwrap();
    db.execute("COMMIT").await.unwrap();
}

#[tokio::test]
async fn financial_recovery_receipted_credit_return_then_bank_cash_and_replay() {
    let scratch = DisposableDb::new();
    let mut db = scratch.open().await;
    install_real_credit_purchase_and_supplier_receipts(&mut db).await;
    record_original_receipted_credit_return(&mut db).await;
    // A 25 credit return against the original 100 invoice is a deduction from
    // the *same* payable, not an unrelated supplier cash payment.
    assert_eq!(financial_counts(&mut db).await, (0, 0, 0, 0, 0, 75.0));
    let bank_nonce = "9d5c951c-64d8-4a6d-8db2-4b60d69bc389";
    let bank = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(bank_nonce, "bank", 50.0)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(&bank).unwrap()["remainingBalance"], 25.0);
    // Native COMMIT succeeded and the caller never received the reply.
    // Reopen the *same* one-off file through a new SQLx connection, with the
    // 041/048 credit return already reflected in the supplier payable.
    drop(db);
    let mut db = scratch.open().await;
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(bank_nonce, "bank", 50.0)
    ).await.unwrap().is_some(), "cold restart after a receipted supplier return must recover the exact bank debit");
    let replay = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(bank_nonce, "bank", 50.0)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(replay).unwrap()["id"],
               serde_json::to_value(bank).unwrap()["id"]);
    assert_eq!(financial_counts(&mut db).await, (1,1,0,1,1,25.0),
        "cold replay must not repeat the bank payment or consume the return twice");
    // A receipt UUID is not adequate evidence if the *current* payable was
    // silently changed while the desktop app was offline. The previously
    // successful retry must now reject the same nonce (never re-post).
    sqlx::query("UPDATE suppliers SET balance=24.99 WHERE id=7")
        .execute(&mut db).await.unwrap();
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(bank_nonce, "bank", 50.0)
    ).await.unwrap().is_none());
    let denied = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(bank_nonce, "bank", 50.0)
    ).await.unwrap_err();
    assert!(denied.contains("verifiable financial provenance"), "{denied}");
    assert_eq!(financial_counts(&mut db).await, (1,1,0,1,1,24.99),
        "the recovery failure must not hide the altered payable or emit new financial rows");
    sqlx::query("UPDATE suppliers SET balance=25 WHERE id=7")
        .execute(&mut db).await.unwrap();
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(bank_nonce, "bank", 50.0)
    ).await.unwrap().is_some(), "054 read-only ACK must accept the 041+048 return evolution");
    assert_eq!(financial_counts(&mut db).await, (1, 1, 0, 1, 1, 25.0));
    let cash_nonce = "5a291cec-bc3e-40db-bc86-3f5bf3eb50ee";
    let cash = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(cash_nonce, "cash", 25.0)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(cash).unwrap()["remainingBalance"], 0.0);
    assert_eq!(financial_counts(&mut db).await, (2, 2, 1, 2, 2, 0.0));
    let (return_count, invoice_count, supplier_rows): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM native_purchase_return_provenance
                 WHERE return_id='native-credit-return'),
                (SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id=7 AND type='invoice'),
                (SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id=7)",
    )
    .fetch_one(&mut db).await.unwrap();
    assert_eq!((return_count,invoice_count,supplier_rows),(1,1,4),
               "one immutable purchase return, one invoice, two receipts, no phantom supplier records");
    assert!(supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a",
        supplier_request("92effc6c-c91e-45d7-9045-6916cb7db1a0", "bank", 1.0)
    ).await.is_err(), "return plus payments cannot exceed original credit invoice");
}

#[tokio::test]
async fn financial_recovery_unreceipted_purchase_return_never_authorizes_supplier_money() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    install_real_credit_purchase_and_supplier_receipts(&mut db).await;
    // A syntactically plausible legacy return and mutable supplier ledger
    // cannot substitute for original immutable 041 line/journal provenance.
    sqlx::raw_sql(
        "INSERT INTO purchase_returns(id,supplier_id,purchase_invoice_id,status,refund_method,total_amount,user_id)
         VALUES('legacy-unreceipted',7,'original-credit','completed','credit',25,'owner-a');
         INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
         VALUES(7,'return',25,'legacy-unreceipted');
         UPDATE suppliers SET balance=75 WHERE id=7;",
    ).execute(&mut db).await.unwrap();
    assert!(supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a",
        supplier_request("05ef695b-c8b4-4615-8139-d0698e9f11ce", "bank", 50.0)
    ).await.unwrap_err().contains("unreceipted"));
    assert_eq!(financial_counts(&mut db).await, (0,0,0,0,0,75.0),
        "unverified legacy return must not produce a bank payment, supplier posting or ACK");
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a",
        supplier_confirmation("05ef695b-c8b4-4615-8139-d0698e9f11ce", "bank", 50.0)
    ).await.unwrap().is_none());
}

#[tokio::test]
async fn financial_recovery_concurrent_duplicate_supplier_nonce_posts_once_after_credit_return() {
    let scratch = DisposableDb::new();
    let mut source = scratch.open().await;
    install_real_credit_purchase_and_supplier_receipts(&mut source).await;
    record_original_receipted_credit_return(&mut source).await;
    drop(source);
    let mut first_conn = scratch.open().await;
    let mut second_conn = scratch.open().await;
    let nonce = "7e43d6ed-5e8f-448e-b3b5-285df5278473";
    let (first, second) = tokio::join!(
        supplier_payments_native::post_on_isolated_test_connection(
            &mut first_conn, "owner-a", supplier_request(nonce, "bank", 25.0)
        ),
        supplier_payments_native::post_on_isolated_test_connection(
            &mut second_conn, "owner-a", supplier_request(nonce, "bank", 25.0)
        ),
    );
    let first = first.expect("first competing bank payment should commit or recover");
    let second = second.expect("second identical nonce should only recover committed first intent");
    assert_eq!(serde_json::to_value(first).unwrap()["id"],
               serde_json::to_value(second).unwrap()["id"]);
    assert_eq!(financial_counts(&mut first_conn).await, (1,1,0,1,1,50.0),
        "two concurrent same-nonce requests across distinct SQLite connections must debit once");
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut second_conn, "owner-a", supplier_confirmation(nonce, "bank", 25.0)
    ).await.unwrap().is_some());
}

#[tokio::test]
async fn financial_recovery_receipted_return_with_foreign_inventory_source_cannot_pay() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    install_real_credit_purchase_and_supplier_receipts(&mut db).await;
    record_original_receipted_credit_return(&mut db).await;
    // Even when the separately sealed return still has a genuine 041 and 048
    // receipt, a subsequently corrupted lot owner must not become a new bank
    // disbursement authority. This tests the 069 *current source* check.
    sqlx::query("UPDATE inventory SET pharmacy_id='tenant-b' WHERE id='original-lot'")
        .execute(&mut db).await.unwrap();
    let refused = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a",
        supplier_request("db881cdb-bcd9-45a6-8694-f1c9f7020b9d", "bank", 50.0)
    ).await.unwrap_err();
    assert!(refused.contains("mismatched purchase return"), "{refused}");
    assert_eq!(financial_counts(&mut db).await, (0,0,0,0,0,75.0));
}

#[tokio::test]
async fn financial_recovery_supplier_lost_ack_cold_reopen_cash_bank_exactly_once() {
    let scratch = DisposableDb::new();
    let cash_nonce = "fce62c0d-dff0-4403-91d8-11b563f65ae4";
    let bank_nonce = "70ecb8e3-7658-4494-9202-fca794a0aa41";
    let mut db = scratch.open().await;
    install_real_credit_purchase_and_supplier_receipts(&mut db).await;
    let initial = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(cash_nonce, "cash", 35.75)
    ).await.unwrap();
    let original_id = serde_json::to_value(&initial).unwrap()["id"].as_str().unwrap().to_owned();
    assert_eq!(financial_counts(&mut db).await, (1, 1, 1, 1, 1, 64.25));

    // The financial COMMIT happened, but the original WebView response was
    // lost. Drop the entire SQLx connection before a new native connection
    // validates exactly the same immutable posting (no new write).
    drop(db);
    let mut db = scratch.open().await;
    let before_confirmation = financial_counts(&mut db).await;
    let proven = supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(cash_nonce, "cash", 35.75)
    ).await.unwrap().expect("042+044+054 original source must independently prove lost cash ACK");
    let proof = serde_json::to_value(proven).unwrap();
    assert_eq!(proof["id"], original_id);
    assert_eq!(proof["amountCents"], 3575);
    assert_eq!(proof["remainingBalance"], 64.25);
    assert_eq!(financial_counts(&mut db).await, before_confirmation,
        "read-only receipt confirmation may not create another payment");
    let retry = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(cash_nonce, "cash", 35.75)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(retry).unwrap()["id"], original_id);
    assert_eq!(financial_counts(&mut db).await, before_confirmation);
    for changed in [
        supplier_request(cash_nonce, "cash", 36.75),
        supplier_request(cash_nonce, "bank", 35.75),
    ] {
        assert!(supplier_payments_native::post_on_isolated_test_connection(
            &mut db, "owner-a", changed).await.unwrap_err().contains("another intent"));
    }
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-b", supplier_confirmation(cash_nonce, "cash", 35.75)
    ).await.unwrap().is_none(), "foreign native identity cannot confirm another branch's original cash");
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(cash_nonce, "bank", 35.75)
    ).await.unwrap().is_none(), "a forged bank method is not cash receipt recovery");

    let bank = supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(bank_nonce, "bank", 14.25)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(&bank).unwrap()["remainingBalance"], 50.0);
    assert_eq!(financial_counts(&mut db).await, (2, 2, 1, 2, 2, 50.0),
        "bank settlement must not create a cash drawer movement");
    let journal_legs: Vec<(String, String, f64)> = sqlx::query_as(
        "SELECT a.code,je.type,je.amount FROM native_supplier_payment_receipts r
         JOIN journal_entries je ON je.journal_id=r.journal_id
         JOIN accounts a ON a.id=je.account_id
         WHERE r.request_id=? ORDER BY a.code",
    ).bind(bank_nonce).fetch_all(&mut db).await.unwrap();
    assert_eq!(journal_legs, vec![
        ("1.1.4".into(),"credit".into(),14.25),
        ("2.1".into(),"debit".into(),14.25),
    ], "bank payment must debit payable and credit the bank clearing account exactly once");
    db.execute("UPDATE shifts SET status='closed' WHERE id='owned-shift'")
        .await.unwrap();
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(cash_nonce, "cash", 35.75)
    ).await.unwrap().is_some(),
        "closing a formerly valid cash shift must not erase its original 054 financial proof");
    assert!(supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a",
        supplier_request("3e288280-37e2-4de0-84cb-bec7a0a6c06c", "cash", 1.0)
    ).await.is_err(), "new cash payment cannot post into closed shift");
    assert_eq!(financial_counts(&mut db).await, (2, 2, 1, 2, 2, 50.0));
}

#[tokio::test]
async fn financial_recovery_supplier_late_receipt_and_activity_failures_rollback_then_retry() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    install_real_credit_purchase_and_supplier_receipts(&mut db).await;
    let nonce = "243c705b-f245-4df4-a82f-1b96e0807541";
    let original = financial_counts(&mut db).await;
    db.execute(
        "CREATE TRIGGER block_recovery_receipt BEFORE INSERT ON native_supplier_payment_receipts
         BEGIN SELECT RAISE(ABORT,'QA interruption after journal'); END",
    ).await.unwrap();
    assert!(supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(nonce, "cash", 20.0)
    ).await.unwrap_err().contains("QA interruption after journal"));
    assert_eq!(financial_counts(&mut db).await, original,
        "receipt-insert failure must roll back supplier, cash, ledger and shift-side writes");
    db.execute("DROP TRIGGER block_recovery_receipt").await.unwrap();
    supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(nonce, "cash", 20.0)
    ).await.unwrap();
    assert_eq!(financial_counts(&mut db).await, (1, 1, 1, 1, 1, 80.0));
    db.execute(
        "CREATE TRIGGER block_recovery_activity BEFORE INSERT ON activity_log
         BEGIN SELECT RAISE(ABORT,'QA interruption after balance update'); END",
    ).await.unwrap();
    let second_nonce = "dcf73c31-5c42-4b90-ae9a-849c4ab3b135";
    assert!(supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(second_nonce, "bank", 5.0)
    ).await.unwrap_err().contains("QA interruption after balance update"));
    assert_eq!(financial_counts(&mut db).await, (1, 1, 1, 1, 1, 80.0),
        "even a valid financial receipt must roll back if the final activity leg fails");
    assert!(supplier_payments_native::confirm_on_isolated_test_connection(
        &mut db, "owner-a", supplier_confirmation(second_nonce, "bank", 5.0)
    ).await.unwrap().is_none(), "no read-only recovery ACK after rolled-back COMMIT");
    db.execute("DROP TRIGGER block_recovery_activity").await.unwrap();
    supplier_payments_native::post_on_isolated_test_connection(
        &mut db, "owner-a", supplier_request(second_nonce, "bank", 5.0)
    ).await.unwrap();
    assert_eq!(financial_counts(&mut db).await, (2, 2, 1, 2, 2, 75.0));
}

fn wallet_request(id: &str, amount: f64) -> patient_payments_native::PatientWalletTopUpInput {
    serde_json::from_value(serde_json::json!({
        "patientId": "patient-owned-by-sale", "amount": amount,
        "notes": "Synthetic recovery wallet", "requestId": id
    })).unwrap()
}

async fn install_wallet_with_original_credit_sale(db: &mut SqliteConnection) {
    sqlx::raw_sql(
        r#"
        CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,is_active INTEGER,pharmacy_id TEXT);
        INSERT INTO users VALUES('owner-a','owner','{}',1,'tenant-a'),
                                ('owner-b','owner','{}',1,'tenant-b');
        CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,wallet_balance REAL DEFAULT 0);
        INSERT INTO patients VALUES('patient-owned-by-sale','Synthetic customer',0);
        CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,
          payment_method TEXT,status TEXT,total_amount REAL);
        -- Credit sale belongs to the patient but is NOT a wallet deduction.
        INSERT INTO sales_invoices VALUES('original-credit-sale','patient-owned-by-sale',
          'tenant-a','credit','completed',125);
        CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,sale_micros INTEGER);
        INSERT INTO native_sale_cogs_provenance VALUES('original-credit-sale','tenant-a',125000000);
        CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,
          refund_method TEXT,status TEXT,total_refund REAL);
        CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,
          pharmacy_id TEXT,refund_method TEXT,refund_micros INTEGER,actor_id TEXT);
        CREATE TABLE patient_transactions(id TEXT,patient_id TEXT,type TEXT,payment_method TEXT,
          amount REAL,user_id TEXT);
        CREATE TABLE patient_payment_scope(transaction_id TEXT,pharmacy_id TEXT);
        CREATE TABLE financial_notice_native_scope(patient_transaction_id TEXT,pharmacy_id TEXT,notice_id TEXT);
        CREATE TABLE financial_notices(id TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,
          type TEXT,amount REAL);
        CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
        INSERT INTO accounts VALUES(6,'1.1.1',0),(7,'2.2',0);
        CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
        INSERT INTO trial_balance_settings VALUES('cash_drawer',6),('patient_wallet_liability',7);
        CREATE TABLE shifts(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,
          start_time TEXT,starting_cash REAL,notes TEXT);
        INSERT INTO shifts VALUES('wallet-shift','owner-a','tenant-a','open','2026-10-18 10:00:00',0,'synthetic');
        CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,
          category TEXT,amount REAL,source_type TEXT,target_name TEXT,notes TEXT,date TEXT,pharmacy_id TEXT);
        CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,
          created_by TEXT,total_amount REAL,pharmacy_id TEXT);
        CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,
          type TEXT,amount REAL);
        CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
        "#,
    ).execute(&mut *db).await.unwrap();
    sqlx::raw_sql(include_str!("../../migrations/060_native_patient_wallet_topups.sql"))
        .execute(&mut *db).await.unwrap();
}

#[tokio::test]
async fn financial_recovery_wallet_credit_sale_shift_and_late_failure_conserve_money() {
    let scratch = DisposableDb::new();
    let nonce = "wallet-native-lost-ack";
    let mut db = scratch.open().await;
    install_wallet_with_original_credit_sale(&mut db).await;
    let posted = patient_payments_native::wallet_top_up(
        &mut db, "owner-a", wallet_request(nonce, 25.0)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(posted).unwrap()["balance"], 25.0);
    drop(db);
    let mut db = scratch.open().await;
    assert!(patient_payments_native::confirm_wallet_on_isolated_test_connection(
        &mut db, "owner-a", wallet_request(nonce, 25.0)
    ).await.unwrap().is_some(), "cold reopen must prove the prior wallet cash/journal + tenant");
    assert!(patient_payments_native::wallet_top_up(
        &mut db, "owner-a", wallet_request(nonce, 25.0)
    ).await.unwrap_err().contains("already processed"));
    assert!(patient_payments_native::wallet_top_up(
        &mut db, "owner-a", wallet_request(nonce, 26.0)
    ).await.unwrap_err().contains("already processed"),
        "a lost-ACK wallet nonce cannot be retargeted to a larger amount after restart");
    assert!(patient_payments_native::confirm_wallet_on_isolated_test_connection(
        &mut db, "owner-b", wallet_request(nonce, 25.0)
    ).await.unwrap().is_none(), "other pharmacy cannot acknowledge wallet cash");

    // Distinguish credit A/R from a verified wallet POS debit: only the
    // latter reduces the cash-funded wallet balance.
    db.execute(
        "INSERT INTO sales_invoices VALUES('wallet-pos','patient-owned-by-sale',
          'tenant-a','wallet','completed',10);
         INSERT INTO native_sale_cogs_provenance VALUES('wallet-pos','tenant-a',10000000);
         UPDATE patients SET wallet_balance=15 WHERE id='patient-owned-by-sale'",
    ).await.unwrap();
    let certified = patient_payments_native::certified_wallet_balance(
        &mut db, "patient-owned-by-sale", "tenant-a"
    ).await.unwrap();
    assert_eq!(certified.1, 15.0, "25 top-up - 10 wallet POS; 125 credit invoice stays in A/R");
    let receipts_before: (i64, i64, i64, f64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM native_patient_wallet_topup_receipts),
                (SELECT COUNT(*) FROM cash_movements),
                (SELECT COUNT(*) FROM journal_entries),
                (SELECT wallet_balance FROM patients WHERE id='patient-owned-by-sale')",
    ).fetch_one(&mut db).await.unwrap();
    assert_eq!(receipts_before, (1, 1, 2, 15.0));
    db.execute(
        "CREATE TRIGGER wallet_late_abort BEFORE INSERT ON activity_log
         BEGIN SELECT RAISE(ABORT,'Synthetic wallet final audit failure'); END",
    ).await.unwrap();
    let failed_nonce = "wallet-financial-late-rollback";
    assert!(patient_payments_native::wallet_top_up(
        &mut db, "owner-a", wallet_request(failed_nonce, 6.0)
    ).await.unwrap_err().contains("Synthetic wallet final audit failure"));
    let after_failed: (i64, i64, i64, f64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM native_patient_wallet_topup_receipts),
                (SELECT COUNT(*) FROM cash_movements),
                (SELECT COUNT(*) FROM journal_entries),
                (SELECT wallet_balance FROM patients WHERE id='patient-owned-by-sale')",
    ).fetch_one(&mut db).await.unwrap();
    assert_eq!(after_failed, receipts_before,
        "failed post-receipt step must atomically undo wallet, cash movement and balanced journal");
    assert!(patient_payments_native::confirm_wallet_on_isolated_test_connection(
        &mut db, "owner-a", wallet_request(failed_nonce, 6.0)
    ).await.unwrap().is_none(), "never confirm a rolled-back wallet receipt");
    db.execute("DROP TRIGGER wallet_late_abort").await.unwrap();
    patient_payments_native::wallet_top_up(
        &mut db, "owner-a", wallet_request(failed_nonce, 6.0)
    ).await.unwrap();
    assert_eq!(patient_payments_native::certified_wallet_balance(
        &mut db, "patient-owned-by-sale", "tenant-a"
    ).await.unwrap().1, 21.0);
    db.execute("UPDATE shifts SET status='closed' WHERE id='wallet-shift'")
        .await.unwrap();
    assert!(patient_payments_native::confirm_wallet_on_isolated_test_connection(
        &mut db, "owner-a", wallet_request(nonce, 25.0)
    ).await.unwrap().is_some(), "closed shift must retain evidence of original cash receipt");
    let safely_reopened = patient_payments_native::wallet_top_up(
        &mut db, "owner-a", wallet_request("new-closed-shift-tender", 1.0)
    ).await.unwrap();
    assert_eq!(serde_json::to_value(safely_reopened).unwrap()["balance"], 22.0);
    let opened_shift: (String, String) = sqlx::query_as(
        "SELECT r.shift_id,s.status FROM native_patient_wallet_topup_receipts r
         JOIN shifts s ON s.id=r.shift_id WHERE r.request_id='new-closed-shift-tender'",
    ).fetch_one(&mut db).await.unwrap();
    assert_ne!(opened_shift.0, "wallet-shift",
        "native wallet handler may auto-open another owned shift, never reuse a closed drawer");
    assert_eq!(opened_shift.1, "open");
}
