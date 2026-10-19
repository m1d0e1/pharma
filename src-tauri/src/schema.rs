use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::fmt::Write as _;
use std::path::Path;
use std::str::FromStr;

#[allow(dead_code)]
struct ChecksumRepair {
    version: i64,
    migration: &'static str,
    current_lf: &'static str,
    current_crlf: &'static str,
    legacy: &'static [&'static str],
}

fn current_checksum(repair: &ChecksumRepair) -> String {
    embedded_migration_checksum_hex(repair.version, "checksum_repair", repair.migration)
}

fn checksum_requires_repair(repair: &ChecksumRepair, checksum: &str) -> Result<bool, String> {
    if checksum == current_checksum(repair) {
        Ok(false)
    } else if checksum == repair.current_lf
        || checksum == repair.current_crlf
        || repair.legacy.contains(&checksum)
    {
        Ok(true)
    } else {
        Err(format!(
            "unrecognized checksum for migration {}",
            repair.version
        ))
    }
}

fn checksum_bytes_hex(checksum: &[u8]) -> String {
    let mut hex = String::with_capacity(checksum.len() * 2);
    for byte in checksum {
        write!(&mut hex, "{byte:02X}").expect("writing to a String cannot fail");
    }
    hex
}

fn embedded_migration_checksum_hex(
    version: i64,
    description: &'static str,
    sql: &'static str,
) -> String {
    let migration = sqlx::migrate::Migration::new(
        version,
        description.into(),
        sqlx::migrate::MigrationType::ReversibleUp,
        sql.into(),
        false,
    );
    checksum_bytes_hex(&migration.checksum)
}

const CHECKSUM_REPAIRS: &[ChecksumRepair] = &[
    ChecksumRepair {
        version: 1,
        migration: include_str!("../migrations/001_initial.sql"),
        current_lf: "BFCAAC7B5A1CEFC3C3C01F8E7DCC3CDB0D83447A39799B4FEAE46D97702BAF1FCD121650AF47C362BA020C4A83F99279",
        current_crlf: "42525F4D4569F70C306E310A9FA815167E3FFA7A8292BD5C2C4E403C49A30B8FFE42EC6DF1ECEA833E510D2843B6DCB7",
        legacy: &[
            "0A8DCA8624A89F518DA7B2D5C08BC364F3B675242BD57CC105E8B610B194E093325389EBF974166C8B7B082BEA0C111A",
            "00AEEB1683D8487B39C5B75AFACE44217DECC16A11A972E83E364A62A20F3AEA9126BCB2BCB6E3DBF4C368CF1E1162AA",
            "6EF41382A6590B2E6A487DB0D9560F9F826E203BA07ED7065E71016C53083911A864F55EFA6C204DDA6272167F8E6BDC",
            "BEC57847DA8403B63C28258329D6F9EEEB7FC894B1496393DCBB6527AAB25D7045EFE661B6BE6473B68C6A579C49A153",
            "F82014A0B12E5F2148E15B27514F88C074C127EA08140C38889D59CAC54695EF9BA4194FC77168A621732F9627A20AA2",
            "78532E45F393BD746018E6EC48E3DD3D661145347E5A0716C28424B1347B2F3BD98F4C7B70C9562950286660AFA22B6C",
            "2A80B93C05E98DF0C64648ED4C88215B5F0985853E4F389A2D2F82C721C7BDFA37823009D1FEA14B92E9AC979C0BB56A",
            "DE4E784D7C8659F5683F96DBD3C66E62D5A5EE715EC147C9E5E17D6915A97CF583065DE96F58C54450DF785BD6854D42",
        ],
    },
    ChecksumRepair {
        version: 2,
        migration: include_str!("../migrations/002_performance.sql"),
        current_lf: "8EE8A3F6C60E775A2E251D7566E966D8D23C6F3BFD43EBB6453C7C817B7B46C649D7D6C3611B1311B9BFF86922FFFD9C",
        current_crlf: "AFF13C262E80C34FF3F115DD6FB5C463760D247EB8B7B6705D0C775DE426E85F70D055F9DBEF1D3EDFF157E3D981261C",
        legacy: &[
            "1D375CF6D1CC6170CA5EC70CE930AD0F9F4D6E0355E5A7ED2637E683D5721A96D62D53C37E573E260B617513DF883375",
            "EB5B98F60883978153907406799C9010EE82FD3B6233E54E3EF0ABE66C182CC4B967378D5C2F431F4180AE8544F7B049",
        ],
    },
    ChecksumRepair {
        version: 3,
        migration: include_str!("../migrations/003_sync_metadata.sql"),
        current_lf: "AC4D263917A382C814AD54B4018090D5B867C42B949BAB27F208A1675F92DDB2B7DBA20363793E32F541509388D6A5F6",
        current_crlf: "78EAF1F3C3BC3CDCD5372F9B58CB7804E244B8F6383681759F6B4CED58C04A187D24571C10D0A02DD748E5DFFF771426",
        legacy: &[],
    },
    ChecksumRepair {
        version: 4,
        migration: include_str!("../migrations/004_return_items_patch.sql"),
        current_lf: "CF8CB76E3264BA762F3CC260B56FB253BEF65AD4C7B80D6E7DA2F950AB9AD5A88CB0DB45072EF2ECE5E3C553AD00D85F",
        current_crlf: "CCCC9C702E8C1C1D270BF2F43F4F7441C9FCAA3A83A074268BC8E1B52051B8B74E18BA70B79E6D8D1EC8E6948451CA3D",
        legacy: &["DC6E060272C078A60806DDBE5DBCC30F42837A45725E0A02163D72863B6F5523E2A51618D4215AEE0E3721748C90125D"],
    },
    ChecksumRepair {
        version: 5,
        migration: include_str!("../migrations/005_purchase_return_details.sql"),
        current_lf: "06CDB339DAF88B9A19B495D4F48AEB5450A3AEA9EE02BB36E69C6C4ABE3F7FA6BA4C0657841FEE7F0102ABFCC2115DC7",
        current_crlf: "EF47F00BA64B2FA378D716E2AD3325AB6E1938B2A97A9F0AD2CE6F047224CA0896896805EB3213B23613F310619F58C3",
        legacy: &["5EDF8FB853589FF8E8C5DE39B9A3432B940C4DB1BC1F0A43438C2B14D376DB187063BDE0F6C55E34C4C2EE261AA3F5A7"],
    },
    ChecksumRepair {
        version: 6,
        migration: include_str!("../migrations/006_accounting_upgrade_seed.sql"),
        current_lf: "8C1DEC5BFB088CCB52A98D085D81F34EFC948B37B2E6DE2946F067BAEA8D07F419C8E064553B850E9417EF03312E7D7A",
        current_crlf: "748A5081D73A5527CDBAACA558C0B515DBFD139826506E94FD8BB7E6700428B2AB07C05A01E7CD6DBBE689F970D37E1E",
        legacy: &[],
    },
    ChecksumRepair {
        version: 7,
        migration: include_str!("../migrations/007_purchase_inventory_links.sql"),
        current_lf: "ADD70A4E03CA17C0E204F600C91803410D880921B6C6A2504D39309E684CA58B2B7B2CA683BDF3E1EB7ABA6EE96C64AE",
        current_crlf: "1AF436DBA20429D9EF69ECA504162C15D8DA72A70758C5B53AAEE9B33D46A699704D8DC5F11C425E3D2E9F4A09175A63",
        legacy: &["48DF50E8B76D93E61F77DEB39E7498CFA1D34B6A7AB76DC1E773320F1B1D448C43B191746F5958858AD1C6F75C6E6013"],
    },
    ChecksumRepair {
        version: 8,
        migration: include_str!("../migrations/008_patient_accounting.sql"),
        current_lf: "09BB9D9AFA5BE22F074E9073ECEBA993227E4FE23CC90FEAB5F442B4A4FCD772456F4202856F49E6F653E4BFA8439D65",
        current_crlf: "8076D5E5B907A5E692896235AECDCCDD8068F023820E275B6FC2F334FD7850B29E7A8BB5A7A37601E5CC3EE2BA083DB8",
        legacy: &[],
    },
    ChecksumRepair {
        version: 9,
        migration: include_str!("../migrations/009_rebuild_master_drugs_fts.sql"),
        current_lf: "EF02EDB00A5C1F2EC8111E2E481083BE205ABE78B5FA2446DCC2F2359C867DD21B89CF58D19482B1E99983AFA311CEB1",
        current_crlf: "E1B2CCE223C6F5E2DB22E1044647D5AA2E756285B8624E6C30A1518014224EBB196B6ECA4FDFE25FB124BEAFCB621949",
        legacy: &[],
    },
    ChecksumRepair {
        version: 12,
        migration: include_str!("../migrations/012_shortages_pharmacy_scope.sql"),
        current_lf: "9B61A35D24740028564415DEBDAAFAC4034BE186059935E7E953102758B57FCF46493EED076DFCB3C4F4D4F6438E7FBE",
        current_crlf: "53A4E46FF6E3475A2E1CED2A37AB65C6F41B3066B07C7A1E4FD7A5499902B0C76B656359EAA13C76BA36609EBB5C71A0",
        legacy: &[
            "390BDCB64ED1FBE1C12E844281BB50251DED58D07B2B1AFB54F80BCE2B179E6C8E1026153452274980FC2271C2B6C1C6",
            "439E557C6F5CF1D421B704D34066717BDD3FF61D6FFA77B13BF51638F6FD4FD7FB70BBF6F32E4534E921A985E909B01A",
        ],
    },
    ChecksumRepair {
        version: 13,
        migration: include_str!("../migrations/013_shift_handover_details.sql"),
        current_lf: "FB62CCC62133EBA1964883C10193C40ECCD1F69CB661173D8018B2095BDD327E8FCB56DF476A46404375AC00C824E4DA",
        current_crlf: "B3F5FE13EA6263CFE816FFA5481069B18F96853A07F0962DAD3AD34339558CB6EFC2DCB48443E938F715C89D2909F3E1",
        legacy: &["8BB1234322CB986511F074EDB35A3F8EF37F4A1CC52784C20183047C7EAF27982EAD59A1C1717F606026F67E3A6BC78F"],
    },
    ChecksumRepair {
        version: 14,
        migration: include_str!("../migrations/014_inventory_performance.sql"),
        current_lf: "80E7B05251D3FF452E7C73F62C3314CE9BF728773C08C1C9AF39CD1058D03B17A3E3488E60A0DE8515AB9EF189A08A6E",
        current_crlf: "078311A26AB6AB59D7C81B074B6EDF92739A83B5D7E6F6254FD4251B9BAFCBBB1754E0F3A8F6E409CC47C2FC62A91265",
        legacy: &[],
    },
];

const DAILY_SNAPSHOT_SCOPE_MIGRATION: &str =
    include_str!("../migrations/020_daily_snapshot_pharmacy_scope.sql");
const DAILY_SNAPSHOT_SCOPE_CHECKSUM_LF: &str =
    "5B2E7C9A9D65C5BEB6CCB2B3CDBC57B7CDB008DD69997EFCA77C5274FBAEB8290C9CB826508EF4928D31526501805835";
const DAILY_SNAPSHOT_SCOPE_CHECKSUM_CRLF: &str =
    "97539E2CDB23A20DF1CC305EAFD07879294816C3D83A3FF2A658D58684186266DB463E129042C56E080794FABE78C5D3";

fn daily_snapshot_scope_migration_checksum() -> &'static str {
    if DAILY_SNAPSHOT_SCOPE_MIGRATION
        .as_bytes()
        .windows(2)
        .any(|bytes| bytes == b"\r\n")
    {
        DAILY_SNAPSHOT_SCOPE_CHECKSUM_CRLF
    } else {
        DAILY_SNAPSHOT_SCOPE_CHECKSUM_LF
    }
}

fn options(path: &Path) -> Result<SqliteConnectOptions, String> {
    SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
        .map(|options| options.create_if_missing(true).foreign_keys(true))
        .map_err(|error| error.to_string())
}

async fn connect(path: &Path) -> Result<SqliteConnection, String> {
    let mut connection = SqliteConnection::connect_with(&options(path)?)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

async fn table_exists(executor: &mut SqliteConnection, table: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
    )
    .bind(table)
    .fetch_one(executor)
    .await
}

async fn has_column(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
    column: &str,
) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(&mut **transaction)
        .await?;
    Ok(rows
        .iter()
        .any(|row| row.get::<String, _>("name") == column))
}

async fn table_exists_in_transaction(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
    )
    .bind(table)
    .fetch_one(&mut **transaction)
    .await
}

async fn ensure_trial_balance_metadata_columns(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(), sqlx::Error> {
    if !table_exists_in_transaction(transaction, "trial_balance_settings").await? {
        return Ok(());
    }
    for column in ["target_id", "target_name"] {
        if !has_column(transaction, "trial_balance_settings", column).await? {
            sqlx::query(&format!(
                "ALTER TABLE trial_balance_settings ADD COLUMN {column} TEXT"
            ))
            .execute(&mut **transaction)
            .await?;
        }
    }
    Ok(())
}

async fn preapply_shared_open_shift_per_pharmacy(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<bool, sqlx::Error> {
    for (table, columns) in [
        (
            "shifts",
            &[
                "id",
                "user_id",
                "start_time",
                "end_time",
                "starting_cash",
                "ending_cash",
                "status",
                "notes",
                "pharmacy_id",
            ][..],
        ),
        ("sales_invoices", &["shift_id"][..]),
        ("returns", &["shift_id"][..]),
        ("cash_movements", &["shift_id"][..]),
    ] {
        if !table_exists_in_transaction(transaction, table).await? {
            return Ok(false);
        }
        for column in columns {
            if !has_column(transaction, table, column).await? {
                return Ok(false);
            }
        }
    }

    // Migration 015 predates multi-pharmacy shift scope and merges every open
    // drawer in the database. On a pre-015 upgrade, compatibility has already
    // snapshotted shifts.pharmacy_id, so perform the same merge within each
    // pharmacy and record 015 as applied before the plugin sees it.
    sqlx::raw_sql(
        r#"
        UPDATE shifts AS target
        SET starting_cash = (
          SELECT COALESCE(SUM(CAST(COALESCE(source.starting_cash, 0) AS REAL)), 0)
          FROM shifts source
          WHERE LOWER(COALESCE(source.status, '')) = 'open'
            AND COALESCE(NULLIF(TRIM(source.pharmacy_id), ''), 'local_default') =
                COALESCE(NULLIF(TRIM(target.pharmacy_id), ''), 'local_default')
        )
        WHERE LOWER(COALESCE(target.status, '')) = 'open'
          AND target.id = (
            SELECT canonical.id
            FROM shifts canonical
            WHERE LOWER(COALESCE(canonical.status, '')) = 'open'
              AND COALESCE(NULLIF(TRIM(canonical.pharmacy_id), ''), 'local_default') =
                  COALESCE(NULLIF(TRIM(target.pharmacy_id), ''), 'local_default')
            ORDER BY datetime(canonical.start_time) ASC, canonical.rowid ASC
            LIMIT 1
          );

        UPDATE sales_invoices
        SET shift_id = (
          SELECT canonical.id
          FROM shifts current_shift
          JOIN shifts canonical
            ON COALESCE(NULLIF(TRIM(canonical.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(current_shift.pharmacy_id), ''), 'local_default')
          WHERE current_shift.id = sales_invoices.shift_id
            AND LOWER(COALESCE(current_shift.status, '')) = 'open'
            AND LOWER(COALESCE(canonical.status, '')) = 'open'
          ORDER BY datetime(canonical.start_time) ASC, canonical.rowid ASC
          LIMIT 1
        )
        WHERE shift_id IN (
          SELECT id FROM shifts WHERE LOWER(COALESCE(status, '')) = 'open'
        );

        UPDATE returns
        SET shift_id = (
          SELECT canonical.id
          FROM shifts current_shift
          JOIN shifts canonical
            ON COALESCE(NULLIF(TRIM(canonical.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(current_shift.pharmacy_id), ''), 'local_default')
          WHERE current_shift.id = returns.shift_id
            AND LOWER(COALESCE(current_shift.status, '')) = 'open'
            AND LOWER(COALESCE(canonical.status, '')) = 'open'
          ORDER BY datetime(canonical.start_time) ASC, canonical.rowid ASC
          LIMIT 1
        )
        WHERE shift_id IN (
          SELECT id FROM shifts WHERE LOWER(COALESCE(status, '')) = 'open'
        );

        UPDATE cash_movements
        SET shift_id = (
          SELECT canonical.id
          FROM shifts current_shift
          JOIN shifts canonical
            ON COALESCE(NULLIF(TRIM(canonical.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(current_shift.pharmacy_id), ''), 'local_default')
          WHERE current_shift.id = cash_movements.shift_id
            AND LOWER(COALESCE(current_shift.status, '')) = 'open'
            AND LOWER(COALESCE(canonical.status, '')) = 'open'
          ORDER BY datetime(canonical.start_time) ASC, canonical.rowid ASC
          LIMIT 1
        )
        WHERE shift_id IN (
          SELECT id FROM shifts WHERE LOWER(COALESCE(status, '')) = 'open'
        );

        UPDATE shifts AS extra
        SET end_time = COALESCE(end_time, CURRENT_TIMESTAMP),
            ending_cash = 0,
            status = 'merged',
            notes = CASE
              WHEN notes IS NULL OR TRIM(notes) = '' THEN 'دُمجت في الوردية المشتركة'
              ELSE notes || ' | دُمجت في الوردية المشتركة'
            END
        WHERE LOWER(COALESCE(extra.status, '')) = 'open'
          AND extra.id != (
            SELECT canonical.id
            FROM shifts canonical
            WHERE LOWER(COALESCE(canonical.status, '')) = 'open'
              AND COALESCE(NULLIF(TRIM(canonical.pharmacy_id), ''), 'local_default') =
                  COALESCE(NULLIF(TRIM(extra.pharmacy_id), ''), 'local_default')
            ORDER BY datetime(canonical.start_time) ASC, canonical.rowid ASC
            LIMIT 1
          );

        DROP INDEX IF EXISTS idx_shifts_single_open;
        CREATE UNIQUE INDEX idx_shifts_single_open
        ON shifts(COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default'))
        WHERE LOWER(COALESCE(status, '')) = 'open';
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    Ok(true)
}

async fn surface_legacy_patient_wallet_review(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<u64, sqlx::Error> {
    for table in [
        "_sqlx_migrations",
        "config",
        "patients",
        "sales_invoices",
        "returns",
        "activity_log",
    ] {
        if !table_exists_in_transaction(transaction, table).await? {
            return Ok(0);
        }
    }

    let migration_8_installed_on: Option<String> = sqlx::query_scalar(
        "SELECT CAST(installed_on AS TEXT) FROM _sqlx_migrations WHERE version = 8 AND success = 1 LIMIT 1",
    )
    .fetch_optional(&mut **transaction)
    .await?;

    let rows = sqlx::query(
        r#"
        SELECT
          p.id AS patient_id,
          COALESCE(NULLIF(TRIM(p.full_name), ''), p.id) AS patient_name,
          CAST(COALESCE(p.wallet_balance, 0) AS REAL) AS wallet_balance,
          CAST(SUM(COALESCE(r.total_refund, 0)) AS REAL) AS suspect_amount
        FROM returns r
        JOIN sales_invoices si ON si.id = r.invoice_id
        JOIN patients p ON p.id = si.patient_id
        WHERE r.refund_method = 'patient_account'
          AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
          AND (
            ? IS NULL
            OR datetime(r.created_at) < datetime(?)
          )
        GROUP BY p.id, p.full_name, p.wallet_balance
        HAVING ABS(SUM(COALESCE(r.total_refund, 0))) > 0.000001
        ORDER BY p.id
        "#,
    )
    .bind(migration_8_installed_on.as_deref())
    .bind(migration_8_installed_on.as_deref())
    .fetch_all(&mut **transaction)
    .await?;

    if rows.is_empty() {
        sqlx::query("DELETE FROM config WHERE key = 'legacy_patient_wallet_review_status'")
            .execute(&mut **transaction)
            .await?;
        return Ok(0);
    }

    let mut affected = Vec::with_capacity(rows.len());
    for row in &rows {
        let patient_id = row.get::<String, _>("patient_id");
        let patient_name = row.get::<String, _>("patient_name");
        let wallet_balance = row.get::<f64, _>("wallet_balance");
        let suspect_amount = row.get::<f64, _>("suspect_amount");
        affected.push(format!(
            "{patient_name} (#{patient_id}): {suspect_amount:.2} ج.م"
        ));

        let details = format!(
            "patient_id={patient_id}; suspect_patient_account_returns={suspect_amount:.2}; current_wallet_balance={wallet_balance:.2}; automatic_balance_change=none"
        );
        sqlx::query(
            r#"
            INSERT INTO activity_log (user_id, action, details)
            SELECT NULL, 'LEGACY_PATIENT_WALLET_REVIEW_REQUIRED', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM activity_log
              WHERE action = 'LEGACY_PATIENT_WALLET_REVIEW_REQUIRED' AND details = ?
            )
            "#,
        )
        .bind(&details)
        .bind(&details)
        .execute(&mut **transaction)
        .await?;
    }

    let status = format!(
        "تم اكتشاف {} عميل لديهم مرتجعات على الحساب من إصدار قديم قد تكون أضافت قيمة مكررة إلى المحفظة. لم يغيّر النظام أي رصيد تلقائياً لأن الإصدارات القديمة سمحت بتعديلات مشروعة على المحفظة دون سجل كافٍ لإعادة بنائها بأمان. يحتاج مراجعة: {}",
        rows.len(),
        affected.join("، ")
    );
    sqlx::query(
        "INSERT INTO config(key, value) VALUES ('legacy_patient_wallet_review_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(status)
    .execute(&mut **transaction)
    .await?;

    Ok(rows.len() as u64)
}

async fn add_column(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::Error> {
    if !has_column(transaction, table, column).await? {
        sqlx::raw_sql(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

async fn repair_unambiguous_shift_links(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<u64, sqlx::Error> {
    let shifts_ready = has_column(transaction, "shifts", "user_id").await?
        && has_column(transaction, "shifts", "start_time").await?
        && has_column(transaction, "shifts", "end_time").await?;
    if !shifts_ready {
        return Ok(0);
    }

    let mut repaired = 0;
    if has_column(transaction, "sales_invoices", "user_id").await?
        && has_column(transaction, "sales_invoices", "shift_id").await?
        && has_column(transaction, "sales_invoices", "status").await?
        && has_column(transaction, "sales_invoices", "created_at").await?
    {
        repaired += sqlx::query(
            r#"
            UPDATE sales_invoices AS invoice
            SET shift_id = (
              SELECT MIN(shift.id)
              FROM shifts shift
              WHERE shift.user_id = invoice.user_id
                AND datetime(invoice.created_at) >= datetime(shift.start_time)
                AND (shift.end_time IS NULL OR datetime(invoice.created_at) <= datetime(shift.end_time))
              HAVING COUNT(*) = 1
            )
            WHERE invoice.shift_id IS NULL
              AND LOWER(COALESCE(invoice.status, '')) IN ('completed', 'delivered')
              AND (
                SELECT COUNT(*)
                FROM shifts shift
                WHERE shift.user_id = invoice.user_id
                  AND datetime(invoice.created_at) >= datetime(shift.start_time)
                  AND (shift.end_time IS NULL OR datetime(invoice.created_at) <= datetime(shift.end_time))
              ) = 1
            "#,
        )
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    }

    if has_column(transaction, "returns", "user_id").await?
        && has_column(transaction, "returns", "shift_id").await?
        && has_column(transaction, "returns", "status").await?
        && has_column(transaction, "returns", "created_at").await?
    {
        repaired += sqlx::query(
            r#"
            UPDATE returns AS customer_return
            SET shift_id = (
              SELECT MIN(shift.id)
              FROM shifts shift
              WHERE shift.user_id = customer_return.user_id
                AND datetime(customer_return.created_at) >= datetime(shift.start_time)
                AND (shift.end_time IS NULL OR datetime(customer_return.created_at) <= datetime(shift.end_time))
              HAVING COUNT(*) = 1
            )
            WHERE customer_return.shift_id IS NULL
              AND LOWER(COALESCE(customer_return.status, '')) IN ('approved', 'completed')
              AND (
                SELECT COUNT(*)
                FROM shifts shift
                WHERE shift.user_id = customer_return.user_id
                  AND datetime(customer_return.created_at) >= datetime(shift.start_time)
                  AND (shift.end_time IS NULL OR datetime(customer_return.created_at) <= datetime(shift.end_time))
              ) = 1
            "#,
        )
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    }

    Ok(repaired)
}

async fn repair_unambiguous_user_pharmacy(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<u64, sqlx::Error> {
    if !has_column(transaction, "users", "pharmacy_id").await?
        || !has_column(transaction, "users", "role").await?
    {
        return Ok(0);
    }

    // One observed scope is NOT a grant to every legacy staff account. In
    // particular, a still-unscoped (or local_default) historical owner makes
    // even a nominally single-pharmacy source unauthenticated. Retain the
    // exact NULL / blank historical staff literals for ownership review rather
    // than making a one-way source identity change in native preparation.
    let unresolved_owners: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE LOWER(TRIM(COALESCE(role,'')))='owner' \
         AND (typeof(pharmacy_id)!='text' OR NULLIF(TRIM(pharmacy_id),'') IS NULL \
              OR LOWER(TRIM(pharmacy_id))='local_default')",
    )
    .fetch_one(&mut **transaction)
    .await?;
    if unresolved_owners != 0 {
        return Ok(0);
    }

    let scopes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT TRIM(pharmacy_id) FROM users WHERE pharmacy_id IS NOT NULL AND TRIM(pharmacy_id) != ''",
    )
    .fetch_all(&mut **transaction)
    .await?;
    if scopes.len() != 1 {
        return Ok(0);
    }

    sqlx::query(
        "UPDATE users SET pharmacy_id = ? WHERE (pharmacy_id IS NULL OR TRIM(pharmacy_id) = '') AND LOWER(COALESCE(role, '')) != 'owner'",
    )
    .bind(&scopes[0])
    .execute(&mut **transaction)
        .await
        .map(|result| result.rows_affected())
}

async fn snapshot_branch_local_pharmacy_scope(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(), sqlx::Error> {
    let users_ready = table_exists_in_transaction(transaction, "users").await?
        && has_column(transaction, "users", "id").await?
        && has_column(transaction, "users", "username").await?
        && has_column(transaction, "users", "pharmacy_id").await?;

    let sales_ready = table_exists_in_transaction(transaction, "sales_invoices").await?;
    if sales_ready {
        add_column(
            transaction,
            "sales_invoices",
            "pharmacy_id",
            "pharmacy_id TEXT",
        )
        .await?;
        if users_ready && has_column(transaction, "sales_invoices", "user_id").await? {
            sqlx::query(
                r#"
                UPDATE sales_invoices
                SET pharmacy_id = COALESCE(
                  (SELECT NULLIF(TRIM(u.pharmacy_id), '')
                   FROM users u
                   WHERE CAST(u.id AS TEXT) = CAST(sales_invoices.user_id AS TEXT)
                      OR LOWER(u.username) = LOWER(CAST(sales_invoices.user_id AS TEXT))
                   LIMIT 1),
                  'local_default'
                )
                WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        } else {
            sqlx::query("UPDATE sales_invoices SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''")
                .execute(&mut **transaction)
                .await?;
        }
    }

    let returns_ready = table_exists_in_transaction(transaction, "returns").await?;
    if returns_ready {
        add_column(transaction, "returns", "pharmacy_id", "pharmacy_id TEXT").await?;
        let has_invoice_id = has_column(transaction, "returns", "invoice_id").await?;
        let has_user_id = has_column(transaction, "returns", "user_id").await?;
        if sales_ready && has_invoice_id && users_ready && has_user_id {
            sqlx::query(
                r#"
                UPDATE returns
                SET pharmacy_id = COALESCE(
                  (SELECT NULLIF(TRIM(si.pharmacy_id), '') FROM sales_invoices si WHERE si.id = returns.invoice_id),
                  (SELECT NULLIF(TRIM(u.pharmacy_id), '')
                   FROM users u
                   WHERE CAST(u.id AS TEXT) = CAST(returns.user_id AS TEXT)
                      OR LOWER(u.username) = LOWER(CAST(returns.user_id AS TEXT))
                   LIMIT 1),
                  'local_default'
                )
                WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        } else if sales_ready && has_invoice_id {
            sqlx::query(
                "UPDATE returns SET pharmacy_id = COALESCE((SELECT NULLIF(TRIM(si.pharmacy_id), '') FROM sales_invoices si WHERE si.id = returns.invoice_id), 'local_default') WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''",
            )
            .execute(&mut **transaction)
            .await?;
        } else if users_ready && has_user_id {
            sqlx::query(
                r#"
                UPDATE returns
                SET pharmacy_id = COALESCE(
                  (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                   WHERE CAST(u.id AS TEXT) = CAST(returns.user_id AS TEXT)
                      OR LOWER(u.username) = LOWER(CAST(returns.user_id AS TEXT)) LIMIT 1),
                  'local_default'
                )
                WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        } else {
            sqlx::query("UPDATE returns SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''")
                .execute(&mut **transaction)
                .await?;
        }
    }

    let shifts_ready = table_exists_in_transaction(transaction, "shifts").await?;
    if shifts_ready {
        add_column(transaction, "shifts", "pharmacy_id", "pharmacy_id TEXT").await?;
        let has_user_id = has_column(transaction, "shifts", "user_id").await?;
        if sales_ready
            && has_column(transaction, "sales_invoices", "shift_id").await?
            && has_column(transaction, "sales_invoices", "pharmacy_id").await?
        {
            sqlx::query(
                r#"
                UPDATE shifts AS legacy_shift
                SET pharmacy_id = (
                  SELECT MIN(NULLIF(TRIM(invoice.pharmacy_id), ''))
                  FROM sales_invoices invoice
                  WHERE invoice.shift_id = legacy_shift.id
                    AND NULLIF(TRIM(invoice.pharmacy_id), '') IS NOT NULL
                  HAVING COUNT(DISTINCT NULLIF(TRIM(invoice.pharmacy_id), '')) = 1
                )
                WHERE (legacy_shift.pharmacy_id IS NULL OR TRIM(legacy_shift.pharmacy_id) = '')
                  AND (
                    SELECT COUNT(DISTINCT NULLIF(TRIM(invoice.pharmacy_id), ''))
                    FROM sales_invoices invoice
                    WHERE invoice.shift_id = legacy_shift.id
                  ) = 1
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        }
        if users_ready && has_user_id {
            sqlx::query(
                r#"
                UPDATE shifts
                SET pharmacy_id = COALESCE(
                  (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                   WHERE CAST(u.id AS TEXT) = CAST(shifts.user_id AS TEXT)
                      OR LOWER(u.username) = LOWER(CAST(shifts.user_id AS TEXT)) LIMIT 1),
                  'local_default'
                )
                WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        } else {
            sqlx::query("UPDATE shifts SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''")
                .execute(&mut **transaction)
                .await?;
        }

        if has_column(transaction, "shifts", "status").await? {
            sqlx::query("CREATE INDEX IF NOT EXISTS idx_shifts_pharmacy_status ON shifts(pharmacy_id, status)")
                .execute(&mut **transaction)
                .await?;
        }

        if users_ready && has_user_id && has_column(transaction, "shifts", "status").await? {
            sqlx::raw_sql(include_str!("../migrations/023_shift_immutable_scope.sql"))
                .execute(&mut **transaction)
                .await?;
            sqlx::raw_sql(
                r#"
                DROP TRIGGER IF EXISTS shifts_snapshot_pharmacy_insert;
                CREATE TRIGGER shifts_snapshot_pharmacy_insert
                AFTER INSERT ON shifts
                WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
                BEGIN
                  UPDATE shifts SET pharmacy_id = COALESCE(
                    (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                     WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
                        OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
                    'local_default'
                  ) WHERE id = NEW.id;
                END;
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        }
    }

    let cash_ready = table_exists_in_transaction(transaction, "cash_movements").await?;
    if cash_ready {
        add_column(
            transaction,
            "cash_movements",
            "pharmacy_id",
            "pharmacy_id TEXT",
        )
        .await?;
        let has_user_id = has_column(transaction, "cash_movements", "user_id").await?;
        let has_shift_id = has_column(transaction, "cash_movements", "shift_id").await?;
        if shifts_ready && has_shift_id && users_ready && has_user_id {
            sqlx::query(
                r#"
                UPDATE cash_movements
                SET pharmacy_id = COALESCE(
                  (SELECT NULLIF(TRIM(s.pharmacy_id), '') FROM shifts s WHERE s.id = cash_movements.shift_id LIMIT 1),
                  (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                   WHERE CAST(u.id AS TEXT) = CAST(cash_movements.user_id AS TEXT)
                      OR LOWER(u.username) = LOWER(CAST(cash_movements.user_id AS TEXT)) LIMIT 1),
                  'local_default'
                )
                WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        } else if users_ready && has_user_id {
            sqlx::query(
                r#"
                UPDATE cash_movements SET pharmacy_id = COALESCE(
                  (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                   WHERE CAST(u.id AS TEXT) = CAST(cash_movements.user_id AS TEXT)
                      OR LOWER(u.username) = LOWER(CAST(cash_movements.user_id AS TEXT)) LIMIT 1),
                  'local_default'
                ) WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        } else {
            sqlx::query("UPDATE cash_movements SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''")
                .execute(&mut **transaction)
                .await?;
        }
        if has_column(transaction, "cash_movements", "date").await? {
            sqlx::query("CREATE INDEX IF NOT EXISTS idx_cash_movements_pharmacy_date ON cash_movements(pharmacy_id, date)")
                .execute(&mut **transaction)
                .await?;
        }
        if users_ready && has_user_id && has_column(transaction, "cash_movements", "id").await? {
            let trigger_sql = if shifts_ready && has_shift_id {
                r#"
                DROP TRIGGER IF EXISTS cash_movements_snapshot_pharmacy_insert;
                CREATE TRIGGER cash_movements_snapshot_pharmacy_insert AFTER INSERT ON cash_movements
                WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
                BEGIN
                  UPDATE cash_movements SET pharmacy_id = COALESCE(
                    (SELECT NULLIF(TRIM(s.pharmacy_id), '') FROM shifts s WHERE s.id = NEW.shift_id LIMIT 1),
                    (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                     WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
                        OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
                    'local_default'
                  ) WHERE id = NEW.id;
                END;
                "#
            } else {
                r#"
                DROP TRIGGER IF EXISTS cash_movements_snapshot_pharmacy_insert;
                CREATE TRIGGER cash_movements_snapshot_pharmacy_insert AFTER INSERT ON cash_movements
                WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
                BEGIN
                  UPDATE cash_movements SET pharmacy_id = COALESCE(
                    (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                     WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
                        OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
                    'local_default'
                  ) WHERE id = NEW.id;
                END;
                "#
            };
            sqlx::raw_sql(trigger_sql)
                .execute(&mut **transaction)
                .await?;
        }
    }

    if cash_ready
        && table_exists_in_transaction(transaction, "expenses").await?
        && has_column(transaction, "expenses", "id").await?
        && has_column(transaction, "cash_movements", "id").await?
        && has_column(transaction, "cash_movements", "pharmacy_id").await?
    {
        add_column(transaction, "expenses", "pharmacy_id", "pharmacy_id TEXT").await?;
        sqlx::query(
            r#"
            UPDATE expenses
            SET pharmacy_id = (
              SELECT NULLIF(TRIM(cm.pharmacy_id), '')
              FROM cash_movements cm
              WHERE expenses.id = 'cash-movement-' || CAST(cm.id AS TEXT)
              LIMIT 1
            )
            WHERE (pharmacy_id IS NULL OR TRIM(pharmacy_id) = '')
              AND EXISTS (
                SELECT 1
                FROM cash_movements cm
                WHERE expenses.id = 'cash-movement-' || CAST(cm.id AS TEXT)
                  AND NULLIF(TRIM(cm.pharmacy_id), '') IS NOT NULL
              )
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    for (table, actor, date_column, index_name) in [
        (
            "daily_journals",
            "created_by",
            "date",
            "idx_daily_journals_pharmacy_date",
        ),
        ("expenses", "user_id", "date", "idx_expenses_pharmacy_date"),
        (
            "financial_notices",
            "user_id",
            "created_at",
            "idx_financial_notices_pharmacy_created",
        ),
        (
            "activity_log",
            "user_id",
            "created_at",
            "idx_activity_log_pharmacy_created",
        ),
        (
            "purchase_orders",
            "user_id",
            "created_at",
            "idx_purchase_orders_pharmacy_created",
        ),
    ] {
        if !table_exists_in_transaction(transaction, table).await? {
            continue;
        }
        add_column(transaction, table, "pharmacy_id", "pharmacy_id TEXT").await?;
        let actor_ready = has_column(transaction, table, actor).await?;
        if users_ready && actor_ready {
            let sql = format!(
                "UPDATE {table} SET pharmacy_id = COALESCE((SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u WHERE CAST(u.id AS TEXT) = CAST({table}.{actor} AS TEXT) OR LOWER(u.username) = LOWER(CAST({table}.{actor} AS TEXT)) LIMIT 1), 'local_default') WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''"
            );
            sqlx::query(&sql).execute(&mut **transaction).await?;
        } else {
            let sql = format!("UPDATE {table} SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''");
            sqlx::query(&sql).execute(&mut **transaction).await?;
        }
        if has_column(transaction, table, date_column).await? {
            let sql = format!(
                "CREATE INDEX IF NOT EXISTS {index_name} ON {table}(pharmacy_id, {date_column})"
            );
            sqlx::query(&sql).execute(&mut **transaction).await?;
        }
        if users_ready && actor_ready && has_column(transaction, table, "id").await? {
            let trigger_name = format!("{table}_snapshot_pharmacy_insert");
            let sql = format!(
                "DROP TRIGGER IF EXISTS {trigger_name}; CREATE TRIGGER {trigger_name} AFTER INSERT ON {table} WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = '' BEGIN UPDATE {table} SET pharmacy_id = COALESCE((SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u WHERE CAST(u.id AS TEXT) = CAST(NEW.{actor} AS TEXT) OR LOWER(u.username) = LOWER(CAST(NEW.{actor} AS TEXT)) LIMIT 1), 'local_default') WHERE id = NEW.id; END;"
            );
            sqlx::raw_sql(&sql).execute(&mut **transaction).await?;
        }
    }

    if users_ready
        && cash_ready
        && table_exists_in_transaction(transaction, "expenses").await?
        && has_column(transaction, "expenses", "id").await?
        && has_column(transaction, "expenses", "user_id").await?
        && has_column(transaction, "cash_movements", "id").await?
        && has_column(transaction, "cash_movements", "pharmacy_id").await?
    {
        sqlx::raw_sql(
            r#"
            DROP TRIGGER IF EXISTS expenses_snapshot_pharmacy_insert;
            CREATE TRIGGER expenses_snapshot_pharmacy_insert AFTER INSERT ON expenses
            WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
            BEGIN
              UPDATE expenses SET pharmacy_id = COALESCE(
                (SELECT NULLIF(TRIM(cm.pharmacy_id), '') FROM cash_movements cm
                 WHERE NEW.id = 'cash-movement-' || CAST(cm.id AS TEXT) LIMIT 1),
                (SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u
                 WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
                    OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT)) LIMIT 1),
                'local_default'
              ) WHERE id = NEW.id;
            END;
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    if table_exists_in_transaction(transaction, "commercial_papers").await? {
        add_column(
            transaction,
            "commercial_papers",
            "pharmacy_id",
            "pharmacy_id TEXT",
        )
        .await?;
        sqlx::query("UPDATE commercial_papers SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''")
            .execute(&mut **transaction)
            .await?;
        if has_column(transaction, "commercial_papers", "due_date").await? {
            sqlx::query("CREATE INDEX IF NOT EXISTS idx_commercial_papers_pharmacy_due ON commercial_papers(pharmacy_id, due_date)")
                .execute(&mut **transaction)
                .await?;
        }
    }

    Ok(())
}

pub(crate) async fn ensure_compatibility(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(), sqlx::Error> {
    ensure_trial_balance_metadata_columns(transaction).await?;
    sqlx::raw_sql(
        r#"
        CREATE TABLE IF NOT EXISTS purchase_returns (
          id TEXT PRIMARY KEY,
          supplier_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          purchase_invoice_id TEXT,
          reason TEXT,
          total_amount REAL,
          refund_method TEXT DEFAULT 'credit',
          status TEXT DEFAULT 'completed',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
        );

        CREATE TABLE IF NOT EXISTS purchase_return_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_return_id TEXT NOT NULL,
          inventory_id TEXT,
          drug_id INTEGER,
          drug_name TEXT,
          quantity_returned INTEGER,
          unit_price REAL,
          total_price REAL,
          reason TEXT,
          purchase_invoice_item_id INTEGER,
          unit TEXT DEFAULT 'large',
          FOREIGN KEY (purchase_return_id) REFERENCES purchase_returns (id)
        );

        CREATE TABLE IF NOT EXISTS returns (
          id TEXT PRIMARY KEY,
          invoice_id TEXT,
          user_id TEXT,
          shift_id TEXT,
          reason TEXT,
          total_refund REAL,
          refund_method TEXT DEFAULT 'cash',
          status TEXT DEFAULT 'pending',
          approved_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          name_en TEXT,
          phone TEXT,
          address TEXT,
          balance REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS supplier_transactions (
          id TEXT PRIMARY KEY,
          supplier_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          payment_method TEXT DEFAULT 'cash',
          notes TEXT,
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS return_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          return_id TEXT,
          inventory_id TEXT,
          drug_id INTEGER,
          drug_name TEXT,
          quantity_returned REAL,
          unit_price REAL,
          total_price REAL,
          sale_item_id INTEGER,
          unit TEXT DEFAULT 'large'
        );

        CREATE TABLE IF NOT EXISTS refill_reminders (
          id TEXT PRIMARY KEY,
          patient_id TEXT,
          drug_id INTEGER,
          last_sold_date TEXT,
          next_refill_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id),
          FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
        );

        CREATE TABLE IF NOT EXISTS patient_allergies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id TEXT NOT NULL,
          allergen TEXT NOT NULL,
          severity TEXT DEFAULT 'moderate',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id)
        );

        CREATE TABLE IF NOT EXISTS patient_conditions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id TEXT NOT NULL,
          condition_name TEXT NOT NULL,
          diagnosed_date TEXT,
          medications TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id)
        );

        CREATE TABLE IF NOT EXISTS patient_transactions (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          payment_method TEXT DEFAULT 'cash',
          notes TEXT,
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id),
          FOREIGN KEY (user_id) REFERENCES users (id)
        );

        CREATE TABLE IF NOT EXISTS financial_notices (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          reason TEXT,
          notes TEXT,
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        );

        CREATE TABLE IF NOT EXISTS cash_movements (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          shift_id TEXT,
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          sub_category TEXT,
          amount REAL NOT NULL,
          source_type TEXT,
          target_name TEXT,
          notes TEXT,
          date TEXT NOT NULL,
          actual_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (shift_id) REFERENCES shifts (id)
        );

        CREATE TABLE IF NOT EXISTS activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT,
          pharmacy_id TEXT,
          action TEXT,
          details TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS stock_adjustments (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          user_id TEXT NOT NULL,
          inventory_id TEXT NOT NULL,
          old_quantity REAL,
          new_quantity REAL,
          adjustment_quantity REAL NOT NULL,
          reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS shortages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_id INTEGER NOT NULL,
          pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
          requested_quantity REAL DEFAULT 1,
          priority TEXT DEFAULT 'normal',
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
        );

        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS drug_indications (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, indication TEXT);
        CREATE TABLE IF NOT EXISTS drug_interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_1_id INTEGER, drug_2_id INTEGER, severity TEXT, description TEXT);
        CREATE TABLE IF NOT EXISTS drug_alternatives (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, alternative_drug_id INTEGER);
        CREATE TABLE IF NOT EXISTS indications (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS usage_methods (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS scientific_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS item_natures (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS manufacturers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS employee_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, min_salary REAL DEFAULT 0, max_salary REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category TEXT, amount REAL, notes TEXT, user_id TEXT, date TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS expense_definitions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS banks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS credit_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS points_of_sale (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS commercial_papers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS opening_balances (id TEXT PRIMARY KEY, date TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS opening_balance_items (id INTEGER PRIMARY KEY AUTOINCREMENT, opening_balance_id TEXT, drug_id INTEGER, quantity REAL, cost_price REAL);
        CREATE TABLE IF NOT EXISTS adjustment_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT);
        CREATE TABLE IF NOT EXISTS purchase_orders (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          pharmacy_id TEXT,
          supplier_name TEXT,
          status TEXT DEFAULT 'pending',
          total_amount REAL DEFAULT 0,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          po_id TEXT,
          drug_id INTEGER,
          quantity INTEGER,
          expected_price REAL,
          received_quantity INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);

        CREATE VIRTUAL TABLE IF NOT EXISTS master_drugs_fts USING fts5(
          trade_name,
          trade_name_en,
          active_ingredient,
          barcode,
          content='master_drugs',
          content_rowid='id'
        );
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Older fallback databases used an incompatible shortage shape. Rebuild it once so
    // every UI path can use the same auto-increment id and requested_quantity columns.
    if !has_column(transaction, "shortages", "requested_quantity").await?
        && has_column(transaction, "shortages", "quantity_needed").await?
    {
        sqlx::raw_sql(
            r#"
            CREATE TABLE shortages_compat (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              drug_id INTEGER NOT NULL,
              pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
              requested_quantity REAL DEFAULT 1,
              priority TEXT DEFAULT 'normal',
              status TEXT DEFAULT 'pending',
              notes TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
            );

            INSERT INTO shortages_compat (
              drug_id, pharmacy_id, requested_quantity, priority, status, notes, created_at
            )
            SELECT
              drug_id,
              'local_default',
              MAX(1, COALESCE(quantity_needed, 1)),
              COALESCE(priority, 'normal'),
              COALESCE(status, 'pending'),
              notes,
              COALESCE(created_at, CURRENT_TIMESTAMP)
            FROM shortages
            WHERE drug_id IS NOT NULL;

            DROP TABLE shortages;
            ALTER TABLE shortages_compat RENAME TO shortages;
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    for (table, column, definition) in [
        ("master_drugs", "base_price", "base_price REAL DEFAULT 0"),
        ("master_drugs", "code_2", "code_2 TEXT"),
        ("master_drugs", "item_nature", "item_nature TEXT"),
        ("master_drugs", "scientific_group", "scientific_group TEXT"),
        ("master_drugs", "usage_method", "usage_method TEXT"),
        (
            "master_drugs",
            "active_ingredient_ratio",
            "active_ingredient_ratio TEXT",
        ),
        ("master_drugs", "is_table", "is_table INTEGER DEFAULT 0"),
        ("master_drugs", "indications", "indications TEXT"),
        ("master_drugs", "side_effects", "side_effects TEXT"),
        ("master_drugs", "no_return", "no_return INTEGER DEFAULT 0"),
        ("master_drugs", "barcode", "barcode TEXT"),
        ("master_drugs", "generic_name", "generic_name TEXT"),
        ("master_drugs", "manufacturer", "manufacturer TEXT"),
        (
            "master_drugs",
            "is_medicine",
            "is_medicine INTEGER DEFAULT 1",
        ),
        ("master_drugs", "is_service", "is_service INTEGER DEFAULT 0"),
        (
            "master_drugs",
            "is_refrigerated",
            "is_refrigerated INTEGER DEFAULT 0",
        ),
        ("master_drugs", "is_chronic", "is_chronic INTEGER DEFAULT 0"),
        ("master_drugs", "has_expiry", "has_expiry INTEGER DEFAULT 1"),
        ("master_drugs", "origin", "origin TEXT"),
        ("master_drugs", "notes", "notes TEXT"),
        ("master_drugs", "min_limit", "min_limit REAL DEFAULT 0"),
        ("master_drugs", "max_limit", "max_limit REAL DEFAULT 0"),
        (
            "master_drugs",
            "reorder_point",
            "reorder_point REAL DEFAULT 0",
        ),
        (
            "master_drugs",
            "default_purchase_qty",
            "default_purchase_qty REAL DEFAULT 1",
        ),
        (
            "master_drugs",
            "prevent_fractions",
            "prevent_fractions INTEGER DEFAULT 0",
        ),
        ("master_drugs", "tax_percent", "tax_percent REAL DEFAULT 0"),
        (
            "master_drugs",
            "discount_percent",
            "discount_percent REAL DEFAULT 0",
        ),
        (
            "master_drugs",
            "stop_dealing",
            "stop_dealing INTEGER DEFAULT 0",
        ),
        (
            "master_drugs",
            "large_to_medium",
            "large_to_medium INTEGER DEFAULT 1",
        ),
        (
            "master_drugs",
            "medium_to_small",
            "medium_to_small INTEGER DEFAULT 1",
        ),
        (
            "inventory",
            "min_stock_level",
            "min_stock_level INTEGER DEFAULT 5",
        ),
        ("inventory", "supplier", "supplier TEXT"),
        ("inventory", "unit_price", "unit_price REAL"),
        ("inventory", "barcode", "barcode TEXT"),
        (
            "inventory",
            "strips_per_box",
            "strips_per_box INTEGER DEFAULT 1",
        ),
        ("purchase_invoices", "expenses", "expenses REAL DEFAULT 0"),
        (
            "purchase_invoices",
            "discount_value",
            "discount_value REAL DEFAULT 0",
        ),
        (
            "purchase_invoices",
            "discount_percent",
            "discount_percent REAL DEFAULT 0",
        ),
        ("purchase_invoices", "updated_at", "updated_at DATETIME"),
        (
            "sales_invoices",
            "paid_amount",
            "paid_amount REAL DEFAULT 0",
        ),
        (
            "sales_invoices",
            "remaining_amount",
            "remaining_amount REAL DEFAULT 0",
        ),
        (
            "sales_invoices",
            "points_earned",
            "points_earned INTEGER DEFAULT 0",
        ),
        (
            "sales_invoices",
            "points_redeemed",
            "points_redeemed INTEGER DEFAULT 0",
        ),
        (
            "sales_invoices",
            "loyalty_discount_amount",
            "loyalty_discount_amount REAL DEFAULT 0",
        ),
        ("returns", "approved_by", "approved_by TEXT"),
        ("return_items", "drug_id", "drug_id INTEGER"),
        ("return_items", "total_price", "total_price REAL"),
        ("return_items", "sale_item_id", "sale_item_id INTEGER"),
        ("return_items", "unit", "unit TEXT DEFAULT 'large'"),
        (
            "purchase_invoice_items",
            "strips_per_box",
            "strips_per_box INTEGER DEFAULT 1",
        ),
        (
            "purchase_invoice_items",
            "inventory_id",
            "inventory_id TEXT",
        ),
        ("purchase_invoice_items", "barcode", "barcode TEXT"),
        (
            "purchase_returns",
            "purchase_invoice_id",
            "purchase_invoice_id TEXT",
        ),
        (
            "purchase_return_items",
            "purchase_invoice_item_id",
            "purchase_invoice_item_id INTEGER",
        ),
        ("purchase_return_items", "unit", "unit TEXT DEFAULT 'large'"),
        ("patients", "name_en", "name_en TEXT"),
        (
            "patients",
            "loyalty_level",
            "loyalty_level TEXT DEFAULT 'silver'",
        ),
        (
            "patients",
            "opening_balance",
            "opening_balance REAL DEFAULT 0",
        ),
        (
            "patients",
            "wallet_balance",
            "wallet_balance REAL DEFAULT 0",
        ),
        (
            "patients",
            "points_balance",
            "points_balance REAL DEFAULT 0",
        ),
        ("financial_notices", "target_type", "target_type TEXT"),
        ("financial_notices", "target_id", "target_id TEXT"),
        ("shifts", "ending_cash", "ending_cash REAL"),
        ("shifts", "notes", "notes TEXT"),
        ("shifts", "actual_cash", "actual_cash REAL"),
        (
            "shifts",
            "transfer_amount",
            "transfer_amount REAL DEFAULT 0",
        ),
        ("shifts", "transfer_target", "transfer_target TEXT"),
        (
            "shifts",
            "cash_difference",
            "cash_difference REAL DEFAULT 0",
        ),
        ("shifts", "receiver_id", "receiver_id TEXT"),
        (
            "shifts",
            "treasury_retained_cash",
            "treasury_retained_cash REAL",
        ),
        ("cash_movements", "sub_category", "sub_category TEXT"),
        ("cash_movements", "actual_date", "actual_date TEXT"),
        ("cash_movements", "source_type", "source_type TEXT"),
        ("cash_movements", "target_name", "target_name TEXT"),
        ("shortages", "priority", "priority TEXT DEFAULT 'normal'"),
        ("shortages", "notes", "notes TEXT"),
        (
            "shortages",
            "pharmacy_id",
            "pharmacy_id TEXT NOT NULL DEFAULT 'local_default'",
        ),
        (
            "shortages",
            "requested_quantity",
            "requested_quantity REAL DEFAULT 1",
        ),
        ("shortages", "status", "status TEXT DEFAULT 'pending'"),
        ("shortages", "created_at", "created_at DATETIME"),
        ("suppliers", "balance", "balance REAL DEFAULT 0"),
        ("suppliers", "phone", "phone TEXT"),
        ("suppliers", "address", "address TEXT"),
        ("suppliers", "name_en", "name_en TEXT"),
        ("supplier_transactions", "user_id", "user_id TEXT"),
        (
            "supplier_transactions",
            "payment_method",
            "payment_method TEXT DEFAULT 'cash'",
        ),
        ("supplier_transactions", "date", "date TEXT"),
        ("users", "username", "username TEXT"),
        ("users", "password_hash", "password_hash TEXT"),
        ("users", "role", "role TEXT DEFAULT 'cashier'"),
        ("users", "full_name", "full_name TEXT"),
        ("users", "pharmacy_id", "pharmacy_id TEXT"),
        ("sales_invoices", "user_id", "user_id TEXT"),
        ("sales_invoices", "pharmacy_id", "pharmacy_id TEXT"),
        ("returns", "pharmacy_id", "pharmacy_id TEXT"),
        ("activity_log", "user_id", "user_id TEXT"),
        ("activity_log", "pharmacy_id", "pharmacy_id TEXT"),
        ("activity_log", "action", "action TEXT"),
        ("activity_log", "details", "details TEXT"),
        ("activity_log", "created_at", "created_at DATETIME"),
        ("purchase_orders", "user_id", "user_id TEXT"),
        ("purchase_orders", "pharmacy_id", "pharmacy_id TEXT"),
        ("purchase_orders", "supplier_name", "supplier_name TEXT"),
        ("purchase_orders", "notes", "notes TEXT"),
        ("purchase_orders", "updated_at", "updated_at DATETIME"),
        ("purchase_order_items", "po_id", "po_id TEXT"),
        (
            "purchase_order_items",
            "expected_price",
            "expected_price REAL",
        ),
        (
            "purchase_order_items",
            "received_quantity",
            "received_quantity INTEGER DEFAULT 0",
        ),
        (
            "users",
            "permissions",
            "permissions TEXT DEFAULT '{\"can_sell\": true, \"can_manage_inventory\": false}'",
        ),
        ("users", "is_active", "is_active INTEGER DEFAULT 1"),
        ("users", "job_id", "job_id INTEGER"),
        ("users", "qualification", "qualification TEXT"),
        ("users", "hire_date", "hire_date TEXT"),
        ("users", "shift", "shift TEXT"),
        ("users", "code", "code TEXT"),
        ("sales_invoices", "notes", "notes TEXT"),
        ("adjustment_reasons", "name_ar", "name_ar TEXT"),
        ("adjustment_reasons", "name_en", "name_en TEXT"),
        ("adjustment_reasons", "reason", "reason TEXT"),
        ("master_drugs", "trade_name_en", "trade_name_en TEXT"),
        ("employee_jobs", "name_ar", "name_ar TEXT"),
        ("employee_jobs", "name_en", "name_en TEXT"),
        ("employee_jobs", "min_salary", "min_salary REAL DEFAULT 0"),
        ("employee_jobs", "max_salary", "max_salary REAL DEFAULT 0"),
        ("employee_jobs", "created_at", "created_at DATETIME"),
    ] {
        add_column(transaction, table, column, definition).await?;
    }

    sqlx::query(
        r#"
        INSERT INTO adjustment_reasons (name_ar, name_en, reason)
        SELECT seed.name_ar, seed.name_en, seed.reason
        FROM (
          SELECT 'جرد وتصحيح رصيد' AS name_ar, 'Stock count correction' AS name_en, 'جرد وتصحيح رصيد' AS reason
          UNION ALL SELECT 'تلف أو كسر', 'Damage or breakage', 'تلف أو كسر'
          UNION ALL SELECT 'منتهي الصلاحية', 'Expired stock', 'منتهي الصلاحية'
          UNION ALL SELECT 'خطأ إدخال', 'Entry correction', 'خطأ إدخال'
        ) AS seed
        WHERE NOT EXISTS (SELECT 1 FROM adjustment_reasons)
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    if has_column(transaction, "purchase_order_items", "order_id").await?
        && has_column(transaction, "purchase_order_items", "po_id").await?
    {
        sqlx::query(
            "UPDATE purchase_order_items SET po_id = order_id WHERE (po_id IS NULL OR TRIM(po_id) = '') AND order_id IS NOT NULL",
        )
        .execute(&mut **transaction)
        .await?;
    }
    if has_column(transaction, "purchase_order_items", "cost_price").await?
        && has_column(transaction, "purchase_order_items", "expected_price").await?
    {
        sqlx::query(
            "UPDATE purchase_order_items SET expected_price = cost_price WHERE expected_price IS NULL AND cost_price IS NOT NULL",
        )
        .execute(&mut **transaction)
        .await?;
    }

    // A withdrawn legacy import could place EAN/barcode-sized numbers into unit
    // conversion columns. These values are unmistakably not package ratios and
    // must not be frozen into the historical snapshot columns below.
    sqlx::query(
        "UPDATE master_drugs SET large_to_medium = 1 WHERE ABS(COALESCE(large_to_medium, 1)) >= 1000000",
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "UPDATE master_drugs SET medium_to_small = 1 WHERE ABS(COALESCE(medium_to_small, 1)) >= 1000000",
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"
        UPDATE inventory
        SET strips_per_box = COALESCE((
          SELECT CASE
            WHEN md.large_to_medium > 0 AND ABS(md.large_to_medium) < 1000000
            THEN md.large_to_medium
          END
          FROM master_drugs md
          WHERE md.id = inventory.drug_id
        ), 1)
        WHERE ABS(COALESCE(strips_per_box, 1)) >= 1000000
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    if table_exists_in_transaction(transaction, "purchase_invoice_items").await?
        && has_column(transaction, "purchase_invoice_items", "strips_per_box").await?
    {
        sqlx::query(
            r#"
            UPDATE purchase_invoice_items
            SET strips_per_box = COALESCE((
              SELECT CASE
                WHEN md.large_to_medium > 0 AND ABS(md.large_to_medium) < 1000000
                THEN md.large_to_medium
              END
              FROM master_drugs md
              WHERE md.id = purchase_invoice_items.drug_id
            ), 1)
            WHERE ABS(COALESCE(strips_per_box, 1)) >= 1000000
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    if table_exists_in_transaction(transaction, "inventory").await?
        && !has_column(transaction, "inventory", "medium_to_small").await?
    {
        add_column(
            transaction,
            "inventory",
            "medium_to_small",
            "medium_to_small INTEGER DEFAULT 1",
        )
        .await?;
        sqlx::query(
            r#"
            UPDATE inventory
            SET medium_to_small = COALESCE((
              SELECT CASE
                WHEN md.medium_to_small > 0 AND ABS(md.medium_to_small) < 1000000
                THEN md.medium_to_small
              END
              FROM master_drugs md
              WHERE md.id = inventory.drug_id
            ), 1)
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    if table_exists_in_transaction(transaction, "purchase_invoice_items").await?
        && !has_column(transaction, "purchase_invoice_items", "medium_to_small").await?
    {
        add_column(
            transaction,
            "purchase_invoice_items",
            "medium_to_small",
            "medium_to_small INTEGER DEFAULT 1",
        )
        .await?;
        sqlx::query(
            r#"
            UPDATE purchase_invoice_items
            SET medium_to_small = COALESCE((
              SELECT CASE
                WHEN md.medium_to_small > 0 AND ABS(md.medium_to_small) < 1000000
                THEN md.medium_to_small
              END
              FROM master_drugs md
              WHERE md.id = purchase_invoice_items.drug_id
            ), 1)
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    if table_exists_in_transaction(transaction, "sales_items").await? {
        let needs_large_to_medium = !has_column(transaction, "sales_items", "large_to_medium").await?;
        let needs_medium_to_small = !has_column(transaction, "sales_items", "medium_to_small").await?;
        // Migration 043 already installs the immutable receipted-sale UPDATE
        // guard on some databases that lack these legacy unit snapshots. SQLite
        // resolves *all* NEW.column references in that guard before executing
        // any UPDATE, even one matching zero rows. Install both definitions
        // first; never drop or bypass the financial source trigger.
        if needs_large_to_medium {
            add_column(
                transaction,
                "sales_items",
                "large_to_medium",
                "large_to_medium INTEGER DEFAULT 1",
            )
            .await?;
        }
        if needs_medium_to_small {
            add_column(
                transaction,
                "sales_items",
                "medium_to_small",
                "medium_to_small INTEGER DEFAULT 1",
            )
            .await?;
        }
        if needs_large_to_medium {
            sqlx::query(
                r#"
                UPDATE sales_items
                SET large_to_medium = COALESCE((
                  SELECT CASE
                    WHEN i.strips_per_box > 0 AND ABS(i.strips_per_box) < 1000000
                    THEN i.strips_per_box
                  END
                  FROM inventory i
                  WHERE i.id = sales_items.inventory_id
                ), (
                  SELECT CASE
                    WHEN md.large_to_medium > 0 AND ABS(md.large_to_medium) < 1000000
                    THEN md.large_to_medium
                  END
                  FROM master_drugs md
                  WHERE md.id = sales_items.drug_id
                ), 1)
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        }

        if needs_medium_to_small {
            sqlx::query(
                r#"
                UPDATE sales_items
                SET medium_to_small = COALESCE((
                  SELECT CASE
                    WHEN i.medium_to_small > 0 AND ABS(i.medium_to_small) < 1000000
                    THEN i.medium_to_small
                  END
                  FROM inventory i
                  WHERE i.id = sales_items.inventory_id
                ), (
                  SELECT CASE
                    WHEN md.medium_to_small > 0 AND ABS(md.medium_to_small) < 1000000
                    THEN md.medium_to_small
                  END
                  FROM master_drugs md
                  WHERE md.id = sales_items.drug_id
                ), 1)
                "#,
            )
            .execute(&mut **transaction)
            .await?;
        }

        if !has_column(transaction, "sales_items", "item_discount_percent").await? {
            add_column(
                transaction,
                "sales_items",
                "item_discount_percent",
                "item_discount_percent REAL DEFAULT 0",
            )
            .await?;
        }

        sqlx::query(
            r#"
            UPDATE sales_items
            SET large_to_medium = COALESCE((
              SELECT CASE
                WHEN i.strips_per_box > 0 AND ABS(i.strips_per_box) < 1000000
                THEN i.strips_per_box
              END
              FROM inventory i
              WHERE i.id = sales_items.inventory_id
            ), (
              SELECT CASE
                WHEN md.large_to_medium > 0 AND ABS(md.large_to_medium) < 1000000
                THEN md.large_to_medium
              END
              FROM master_drugs md
              WHERE md.id = sales_items.drug_id
            ), 1)
            WHERE ABS(COALESCE(large_to_medium, 1)) >= 1000000
            "#,
        )
        .execute(&mut **transaction)
        .await?;
        sqlx::query(
            r#"
            UPDATE sales_items
            SET medium_to_small = COALESCE((
              SELECT CASE
                WHEN i.medium_to_small > 0 AND ABS(i.medium_to_small) < 1000000
                THEN i.medium_to_small
              END
              FROM inventory i
              WHERE i.id = sales_items.inventory_id
            ), (
              SELECT CASE
                WHEN md.medium_to_small > 0 AND ABS(md.medium_to_small) < 1000000
                THEN md.medium_to_small
              END
              FROM master_drugs md
              WHERE md.id = sales_items.drug_id
            ), 1)
            WHERE ABS(COALESCE(medium_to_small, 1)) >= 1000000
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    sqlx::query(
        "UPDATE shortages SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''",
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query("UPDATE shortages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL")
        .execute(&mut **transaction)
        .await?;
    sqlx::raw_sql(
        r#"
        CREATE TRIGGER IF NOT EXISTS shortages_set_created_at
        AFTER INSERT ON shortages
        WHEN NEW.created_at IS NULL
        BEGIN
          UPDATE shortages SET created_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Repair only unambiguous legacy shift links before snapshotting branch ownership.
    repair_unambiguous_shift_links(transaction).await?;

    // Snapshot branch-local finance ownership before any legacy user pharmacy repair.
    snapshot_branch_local_pharmacy_scope(transaction).await?;

    // ponytail: legacy staff can inherit a pharmacy only when exactly one scope exists.
    repair_unambiguous_user_pharmacy(transaction).await?;

    sqlx::query(
        r#"
        UPDATE sales_invoices
        SET pharmacy_id = COALESCE(
          (SELECT COALESCE(NULLIF(TRIM(u.pharmacy_id), ''), 'local_default')
           FROM users u
           WHERE CAST(u.id AS TEXT) = CAST(sales_invoices.user_id AS TEXT)
              OR LOWER(u.username) = LOWER(CAST(sales_invoices.user_id AS TEXT))
           LIMIT 1),
          'local_default'
        )
        WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        UPDATE returns
        SET pharmacy_id = COALESCE(
          (SELECT COALESCE(NULLIF(TRIM(si.pharmacy_id), ''), 'local_default')
           FROM sales_invoices si
           WHERE si.id = returns.invoice_id),
          (SELECT COALESCE(NULLIF(TRIM(u.pharmacy_id), ''), 'local_default')
           FROM users u
           WHERE CAST(u.id AS TEXT) = CAST(returns.user_id AS TEXT)
              OR LOWER(u.username) = LOWER(CAST(returns.user_id AS TEXT))
           LIMIT 1),
          'local_default'
        )
        WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_returns_pharmacy_created ON returns(pharmacy_id, created_at)",
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_drug_status ON shortages(pharmacy_id, drug_id, status)",
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_status ON shortages(pharmacy_id, status)",
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_shortages_drug_id ON shortages(drug_id)")
        .execute(&mut **transaction)
        .await?;

    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&mut **transaction)
        .await?;
    if user_count == 0 {
        sqlx::raw_sql(
            r#"
            -- An empty legacy users table must never receive a public password.
            -- Applied migration 001 stays unchanged; native login blocks its
            -- historical default hash until operator-proven owner enrollment.
            INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name, permissions, is_active)
            VALUES (
              'admin',
              'admin',
              NULL,
              'owner',
              'System Administrator',
              '{"view_dashboard":true,"view_reports":true,"manage_inventory":true,"manage_staff":true,"process_sales":true,"manage_patients":true,"view_all_sales":true,"manage_settings":true,"void_transactions":true,"manage_shifts":true,"manage_pharmacy":true,"export_data":true,"import_data":true,"view_audit_logs":true,"can_sell":true,"can_view_patients":true,"can_view_sales":true,"can_manage_inventory":true,"can_view_reports":true,"can_manage_users":true,"can_manage_settings":true,"can_view_shifts":true,"can_manage_shifts":true,"can_view_returns":true,"can_view_purchases":true}',
              1
            );
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    sqlx::raw_sql(
        r#"
        UPDATE purchase_invoices
        SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        WHERE updated_at IS NULL;

        CREATE TRIGGER IF NOT EXISTS purchase_invoices_set_updated_at
        AFTER INSERT ON purchase_invoices
        WHEN NEW.updated_at IS NULL
        BEGIN
          UPDATE purchase_invoices SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

        UPDATE employee_jobs
        SET name_ar = 'وظيفة'
        WHERE (name_ar IS NULL OR name_ar = '');

        CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
        CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
        CREATE INDEX IF NOT EXISTS idx_shifts_user_status ON shifts(user_id, status) WHERE status = 'open';
        CREATE INDEX IF NOT EXISTS idx_purchase_items_inventory_id ON purchase_invoice_items(inventory_id);
        CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode) WHERE barcode IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_inventory_drug_qty_expiry ON inventory(drug_id, quantity, expiry_date) WHERE quantity > 0;
        CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_qty_exp ON inventory(pharmacy_id, quantity, expiry_date) WHERE quantity > 0;

        -- Legacy desktop builds accepted DD/MM/YYYY expiry strings. Normalize
        -- them before any inventory/purchase linking so renderer startup code
        -- never needs write access merely to repair stored date formatting.
        UPDATE inventory
        SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2)
        WHERE expiry_date LIKE '__/__/____';

        UPDATE purchase_invoice_items
        SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2)
        WHERE expiry_date LIKE '__/__/____';

        -- Old completed receipts predate inventory_id. Prefer their exact receipt
        -- batch; otherwise link only one unambiguous, sufficiently stocked lot.
        UPDATE purchase_invoice_items
        SET inventory_id = (
          SELECT MIN(i.id)
          FROM purchase_invoices pi
          JOIN inventory i
            ON i.drug_id = purchase_invoice_items.drug_id
           AND COALESCE(NULLIF(TRIM(i.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(pi.pharmacy_id), ''), 'local_default')
           AND COALESCE(
                 CASE WHEN i.expiry_date LIKE '__/__/____'
                      THEN substr(i.expiry_date, 7, 4) || '-' || substr(i.expiry_date, 4, 2) || '-' || substr(i.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(i.expiry_date), '') END,
                 ''
               ) = COALESCE(
                 CASE WHEN purchase_invoice_items.expiry_date LIKE '__/__/____'
                      THEN substr(purchase_invoice_items.expiry_date, 7, 4) || '-' || substr(purchase_invoice_items.expiry_date, 4, 2) || '-' || substr(purchase_invoice_items.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(purchase_invoice_items.expiry_date), '') END,
                 ''
               )
           AND NULLIF(TRIM(i.batch_number), '') = COALESCE(
                 NULLIF(TRIM(pi.invoice_number), ''),
                 'BATCH-' || substr(pi.id, 1, 8)
               )
          WHERE pi.id = purchase_invoice_items.invoice_id
            AND LOWER(COALESCE(pi.status, '')) = 'completed'
          HAVING COUNT(*) = 1
        )
        WHERE inventory_id IS NULL;

        -- ponytail: ambiguity is safer than a wrong historical link. If several
        -- compatible lots exist, leave the receipt unlinked for manual resolution.
        UPDATE purchase_invoice_items
        SET inventory_id = (
          SELECT MIN(i.id)
          FROM purchase_invoices pi
          JOIN inventory i
            ON i.drug_id = purchase_invoice_items.drug_id
           AND COALESCE(NULLIF(TRIM(i.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(pi.pharmacy_id), ''), 'local_default')
           AND COALESCE(
                 CASE WHEN i.expiry_date LIKE '__/__/____'
                      THEN substr(i.expiry_date, 7, 4) || '-' || substr(i.expiry_date, 4, 2) || '-' || substr(i.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(i.expiry_date), '') END,
                 ''
               ) = COALESCE(
                 CASE WHEN purchase_invoice_items.expiry_date LIKE '__/__/____'
                      THEN substr(purchase_invoice_items.expiry_date, 7, 4) || '-' || substr(purchase_invoice_items.expiry_date, 4, 2) || '-' || substr(purchase_invoice_items.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(purchase_invoice_items.expiry_date), '') END,
                 ''
               )
           AND CAST(i.quantity AS REAL) + 0.000001 >=
               CAST(purchase_invoice_items.quantity + COALESCE(purchase_invoice_items.bonus_quantity, 0) AS REAL)
          WHERE pi.id = purchase_invoice_items.invoice_id
            AND LOWER(COALESCE(pi.status, '')) = 'completed'
          HAVING COUNT(*) = 1
        )
        WHERE inventory_id IS NULL;

        -- Self-heal placeholder Drug xxxx names in master_drugs if the other name field holds the real name
        UPDATE master_drugs
        SET trade_name = trade_name_en
        WHERE (trade_name IS NULL OR TRIM(trade_name) = '' OR trade_name GLOB 'Drug [0-9]*' OR trade_name GLOB 'Drug #[0-9]*')
          AND trade_name_en IS NOT NULL AND TRIM(trade_name_en) != ''
          AND trade_name_en NOT GLOB 'Drug [0-9]*' AND trade_name_en NOT GLOB 'Drug #[0-9]*';

        UPDATE master_drugs
        SET trade_name_en = trade_name
        WHERE (trade_name_en IS NULL OR TRIM(trade_name_en) = '' OR trade_name_en GLOB 'Drug [0-9]*' OR trade_name_en GLOB 'Drug #[0-9]*')
          AND trade_name IS NOT NULL AND TRIM(trade_name) != ''
          AND trade_name NOT GLOB 'Drug [0-9]*' AND trade_name NOT GLOB 'Drug #[0-9]*';

        INSERT OR IGNORE INTO units (id, name_ar, name_en) VALUES
          (1, 'علبة', 'Box'), (2, 'شريط', 'Strip'), (3, 'قرص', 'Pill'),
          (4, 'كبسولة', 'Capsule'), (5, 'أمبول', 'Ampoule'), (6, 'فيال', 'Vial'),
          (7, 'زجاجة', 'Bottle'), (8, 'أنبوبة', 'Tube'), (9, 'كيس', 'Sachet'),
          (10, 'قطرة', 'Drops'), (11, 'حقنة', 'Syringe');

        INSERT OR IGNORE INTO item_natures (id, name_ar, name_en) VALUES
          (1, 'أدوية', 'Drugs'), (2, 'مستلزمات طبية', 'Medical Supplies'),
          (3, 'مستحضرات تجميل', 'Cosmetics'), (4, 'أجهزة طبية', 'Medical Devices'),
          (5, 'مكملات غذائية', 'Nutritional Supplements'), (6, 'مواد تعقيم', 'Disinfectants'),
          (7, 'حفاضات ومستلزمات الأطفال', 'Baby Products'),
          (8, 'منتجات الأم والطفل', 'Mother & Baby Care');

        CREATE TABLE IF NOT EXISTS supplier_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          reference_id TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
        );
        CREATE INDEX IF NOT EXISTS idx_supplier_transactions_supplier ON supplier_transactions(supplier_id);
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Seed rows added to old migrations are not replayed on upgrades. Keep every
    // account used by purchase/POS transactions self-healing on each startup.
    sqlx::raw_sql(
        r#"
        -- Ignored duplicate AUTOINCREMENT inserts still advance sqlite_sequence.
        -- Skip existing codes before attempting any insert; retain IGNORE for races.
        WITH required(position, code, name_ar, name_en, type, is_group) AS (VALUES
          (1, '1.1.1', 'الصندوق', 'Cash Drawer', 'asset', 0),
          (2, '2.1', 'دائنون', 'Accounts Payable', 'liability', 0),
          (3, '1.1.2', 'حسابات العملاء', 'Accounts Receivable', 'asset', 0),
          (4, '3.1', 'إيرادات المبيعات', 'Sales Revenue', 'revenue', 0),
          (5, '1.1.3', 'المخزون السلعي', 'Inventory Asset', 'asset', 0),
          (6, '4.1', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'expense', 0),
          (7, '1.1.4', 'تسويات البنوك', 'Bank Clearing', 'asset', 0),
          (8, '2.2', 'أرصدة محافظ العملاء', 'Patient Wallet Liability', 'liability', 0),
          (9, '4.2', 'تسويات حسابات العملاء', 'Customer Adjustments', 'expense', 0),
          (10, '3.9', 'حقوق ملكية الأرصدة الافتتاحية', 'Opening Balance Equity', 'equity', 0),
          (11, '3.2', 'إيرادات نقدية أخرى', 'Other Cash Income', 'revenue', 0),
          (12, '3.3', 'تسويات نقدية للموردين', 'Supplier Cash Adjustments', 'revenue', 0),
          (13, '3.8', 'مسحوبات المالك', 'Owner Drawings', 'equity', 0),
          (14, '4.4', 'مصروفات تشغيلية عامة', 'General Operating Expenses', 'expense', 0)
        )
        INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group)
        SELECT code, name_ar, name_en, type, is_group
        FROM required
        WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.code = required.code)
        ORDER BY position;

        WITH required(category, code) AS (VALUES
          ('cash_drawer', '1.1.1'),
          ('accounts_payable', '2.1'),
          ('accounts_receivable', '1.1.2'),
          ('sales_revenue', '3.1'),
          ('inventory_asset', '1.1.3'),
          ('cogs_expense', '4.1'),
          ('bank_clearing', '1.1.4'),
          ('patient_wallet_liability', '2.2'),
          ('customer_adjustments', '4.2'),
          ('opening_balance_equity', '3.9'),
          ('other_cash_income', '3.2'),
          ('supplier_cash_adjustments', '3.3'),
          ('owner_drawings', '3.8'),
          ('general_operating_expenses', '4.4')
        )
        UPDATE trial_balance_settings
        SET account_id = (
          SELECT a.id FROM required r JOIN accounts a ON a.code = r.code
          WHERE r.category = trial_balance_settings.category
        )
        WHERE category IN (SELECT category FROM required)
          AND COALESCE(
                (SELECT a.code FROM accounts a WHERE a.id = trial_balance_settings.account_id),
                ''
              ) <> (SELECT r.code FROM required r WHERE r.category = trial_balance_settings.category);

        WITH required(category, code) AS (VALUES
          ('cash_drawer', '1.1.1'),
          ('accounts_payable', '2.1'),
          ('accounts_receivable', '1.1.2'),
          ('sales_revenue', '3.1'),
          ('inventory_asset', '1.1.3'),
          ('cogs_expense', '4.1'),
          ('bank_clearing', '1.1.4'),
          ('patient_wallet_liability', '2.2'),
          ('customer_adjustments', '4.2'),
          ('opening_balance_equity', '3.9'),
          ('other_cash_income', '3.2'),
          ('supplier_cash_adjustments', '3.3'),
          ('owner_drawings', '3.8'),
          ('general_operating_expenses', '4.4')
        )
        INSERT INTO trial_balance_settings (category, target_type, account_id)
        SELECT r.category, 'account', a.id
        FROM required r JOIN accounts a ON a.code = r.code
        WHERE NOT EXISTS (
          SELECT 1
          FROM trial_balance_settings s JOIN accounts mapped ON mapped.id = s.account_id
          WHERE s.category = r.category
        );
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Remove only exact duplicate settings. Older installations can legitimately
    // contain conflicting legacy/custom category definitions. Preserve those
    // until migration 031 can fail closed instead of silently deleting metadata.
    sqlx::raw_sql(
        r#"
        DELETE FROM trial_balance_settings
        WHERE EXISTS (
          SELECT 1 FROM trial_balance_settings newer
          WHERE newer.category = trial_balance_settings.category
            AND newer.target_type IS trial_balance_settings.target_type
            AND newer.target_id IS trial_balance_settings.target_id
            AND newer.target_name IS trial_balance_settings.target_name
            AND newer.account_id IS trial_balance_settings.account_id
            AND newer.id > trial_balance_settings.id
        );
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    surface_legacy_patient_wallet_review(transaction).await?;

    Ok(())
}

async fn prepare_connection(connection: &mut SqliteConnection) -> Result<(), String> {
    if !table_exists(connection, "_sqlx_migrations")
        .await
        .map_err(|e| e.to_string())?
    {
        // Bundled and pre-plugin databases have a complete schema but no migration
        // ledger. Repair those; let the plugin initialize a genuinely blank file.
        if !table_exists(connection, "purchase_invoices")
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
        sqlx::raw_sql(
            r#"
            CREATE TABLE _sqlx_migrations (
              version BIGINT PRIMARY KEY,
              description TEXT NOT NULL,
              installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN NOT NULL,
              checksum BLOB NOT NULL,
              execution_time BIGINT NOT NULL
            );
            "#,
        )
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    }

    let applied = sqlx::query(
        "SELECT version, hex(checksum) AS checksum FROM _sqlx_migrations WHERE success = 1",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    let migration_13_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 13);
    let migration_15_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 15);
    let migration_20_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 20);
    let migration_25_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 25);
    let migration_26_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 26);
    let migration_28_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 28);
    let migration_29_applied = applied.iter().any(|row| row.get::<i64, _>("version") == 29);
    let (scoped_snapshot_without_migration_20, scoped_snapshot_needs_rebuild) =
        if migration_20_applied
            || !table_exists(connection, "daily_financial_snapshots")
                .await
                .map_err(|e| e.to_string())?
        {
            (false, false)
        } else {
            let columns = sqlx::query("PRAGMA table_info(daily_financial_snapshots)")
                .fetch_all(&mut *connection)
                .await
                .map_err(|e| e.to_string())?;
            let has_column = |name: &str| {
                columns
                    .iter()
                    .any(|row| row.get::<String, _>("name") == name)
            };
            let column = |name: &str| {
                columns
                    .iter()
                    .find(|row| row.get::<String, _>("name") == name)
            };
            let has_scoped_columns = [
                "date",
                "pharmacy_id",
                "total_sales",
                "total_returns",
                "total_cash_movements",
                "net_profit",
                "created_at",
            ]
            .iter()
            .all(|name| has_column(name));
            let exact_scoped_schema = has_scoped_columns
                && column("date").is_some_and(|row| {
                    row.get::<i64, _>("pk") == 1 && row.get::<i64, _>("notnull") == 1
                })
                && column("pharmacy_id").is_some_and(|row| {
                    row.get::<i64, _>("pk") == 2
                        && row.get::<i64, _>("notnull") == 1
                        && row.get::<Option<String>, _>("dflt_value").as_deref()
                            == Some("'local_default'")
                });
            (
                has_scoped_columns,
                has_scoped_columns && !exact_scoped_schema,
            )
        };
    let mut repairs = Vec::new();
    for row in applied {
        let version = row.get::<i64, _>("version");
        let checksum = row.get::<String, _>("checksum");
        let Some(repair) = CHECKSUM_REPAIRS
            .iter()
            .find(|repair| repair.version == version)
        else {
            continue;
        };
        if !checksum_requires_repair(repair, &checksum)? {
            continue;
        }
        repairs.push((repair, checksum));
    }
    let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
    // Some supported pre-plugin databases had trial-balance settings without
    // target_id/target_name. Migration 031 compares these fields to avoid
    // discarding distinct custom mappings. Add the nullable fields before
    // the plugin migrator runs, without touching existing settings or journals.
    ensure_trial_balance_metadata_columns(&mut transaction)
        .await
        .map_err(|e| e.to_string())?;
    ensure_compatibility(&mut transaction)
        .await
        .map_err(|e| e.to_string())?;
    let shared_open_shift_preapplied = !migration_15_applied
        && preapply_shared_open_shift_per_pharmacy(&mut transaction)
            .await
            .map_err(|e| e.to_string())?;
    let treasury_retained_cash_preapplied = !migration_29_applied
        && has_column(&mut transaction, "shifts", "treasury_retained_cash")
            .await
            .map_err(|e| e.to_string())?;
    let finance_definitions_scope_preapplied = if migration_28_applied {
        false
    } else {
        let mut columns_present = true;
        for table in ["banks", "credit_cards", "points_of_sale"] {
            if !has_column(&mut transaction, table, "pharmacy_id")
                .await
                .map_err(|e| e.to_string())?
            {
                columns_present = false;
                break;
            }
        }
        let indexes_present: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'idx_banks_pharmacy_name',
                'idx_credit_cards_pharmacy_name',
                'idx_points_of_sale_pharmacy_name'
              )
            "#,
        )
        .fetch_one(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
        columns_present && indexes_present == 3
    };
    if scoped_snapshot_needs_rebuild {
        sqlx::raw_sql(
            r#"
            DROP INDEX IF EXISTS idx_daily_snapshots_date;
            DROP INDEX IF EXISTS idx_daily_snapshots_pharmacy_date;
            ALTER TABLE daily_financial_snapshots RENAME TO daily_financial_snapshots_scope_compat;
            CREATE TABLE daily_financial_snapshots (
              date TEXT NOT NULL,
              pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
              total_sales REAL DEFAULT 0,
              total_returns REAL DEFAULT 0,
              total_cash_movements REAL DEFAULT 0,
              net_profit REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (date, pharmacy_id)
            );
            INSERT INTO daily_financial_snapshots (
              date, pharmacy_id, total_sales, total_returns, total_cash_movements, net_profit, created_at
            )
            SELECT
              date,
              COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default'),
              total_sales,
              total_returns,
              total_cash_movements,
              net_profit,
              created_at
            FROM daily_financial_snapshots_scope_compat;
            DROP TABLE daily_financial_snapshots_scope_compat;
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    if scoped_snapshot_without_migration_20 {
        sqlx::raw_sql(
            r#"
            DROP INDEX IF EXISTS idx_daily_snapshots_date;
            CREATE INDEX IF NOT EXISTS idx_daily_snapshots_pharmacy_date
            ON daily_financial_snapshots(pharmacy_id, date);
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    for (repair, checksum) in repairs {
        sqlx::query(&format!(
            "UPDATE _sqlx_migrations SET checksum = X'{}' WHERE version = ? AND hex(checksum) = ?",
            current_checksum(repair)
        ))
        .bind(repair.version)
        .bind(checksum)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    if scoped_snapshot_without_migration_20 {
        sqlx::query(&format!(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (20, 'daily_snapshot_pharmacy_scope', 1, X'{}', 0)",
            daily_snapshot_scope_migration_checksum()
        ))
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    if shared_open_shift_preapplied {
        let checksum = embedded_migration_checksum_hex(
            15,
            "shared_open_shift",
            include_str!("../migrations/015_shared_open_shift.sql"),
        );
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (15, 'shared_open_shift', 1, X'{checksum}', 0)"
        ))
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    for (version, description, sql, already_applied) in [
        (
            13_i64,
            "shift_handover_details",
            include_str!("../migrations/013_shift_handover_details.sql"),
            migration_13_applied,
        ),
        (
            25_i64,
            "sales_item_discount_snapshot",
            include_str!("../migrations/025_sales_item_discount_snapshot.sql"),
            migration_25_applied,
        ),
        (
            26_i64,
            "sales_loyalty_redemption_snapshot",
            include_str!("../migrations/026_sales_loyalty_redemption_snapshot.sql"),
            migration_26_applied,
        ),
    ] {
        if already_applied {
            continue;
        }
        let checksum = embedded_migration_checksum_hex(version, description, sql);
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, X'{checksum}', 0)"
        ))
        .bind(version)
        .bind(description)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    if finance_definitions_scope_preapplied {
        let checksum = embedded_migration_checksum_hex(
            28,
            "finance_definitions_pharmacy_scope",
            include_str!("../migrations/028_finance_definitions_pharmacy_scope.sql"),
        );
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (28, 'finance_definitions_pharmacy_scope', 1, X'{checksum}', 0)"
        ))
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    if treasury_retained_cash_preapplied {
        let checksum = embedded_migration_checksum_hex(
            29,
            "shift_treasury_retained_cash",
            include_str!("../migrations/029_shift_treasury_retained_cash.sql"),
        );
        sqlx::query(&format!(
            "INSERT OR IGNORE INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (29, 'shift_treasury_retained_cash', 1, X'{checksum}', 0)"
        ))
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    transaction.commit().await.map_err(|e| e.to_string())
}

// Some native unit tests deliberately start with registered migration 001 and
// exercise the remaining SQLx chain against an entirely new temp fixture.
// That is NOT the supported public upgrade entry point for an existing v001
// customer profile; keep this internal bypass unavailable in release builds.
#[cfg(test)]
pub(crate) async fn prepare_registered_001_synthetic_test_connection(
    connection: &mut SqliteConnection,
) -> Result<(), String> {
    prepare_connection(connection).await
}

/// The only native offline owner-proof input is a purpose-staged, single-file
/// v67 SQLite copy under the private disposable custody root. A live app
/// profile, WAL-active file, generic caller pathname or symlink is never
/// eligible. The source must be produced by SQLite's WAL-aware backup before
/// this verifier is called; this function does not open the installed source.
fn checked_detached_owner_stage(path: &Path, root: &Path) -> Result<(), String> {
    let denied = || "Detached primary_pharmacy source custody not verified".to_owned();
    if path.file_name().and_then(|name| name.to_str()) != Some("candidate.sqlite3") {
        return Err(denied());
    }
    let stage = path.parent().ok_or_else(denied)?;
    let token = stage.file_name().and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("pharma-owner-v67-stage-"))
        .ok_or_else(denied)?;
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_digit()
        || (b'a'..=b'f').contains(&byte)) {
        return Err(denied());
    }
    for folder in [root, stage] {
        let info = std::fs::symlink_metadata(folder).map_err(|_| denied())?;
        if !info.file_type().is_dir() { return Err(denied()); }
    }
    let source_info = std::fs::symlink_metadata(path).map_err(|_| denied())?;
    if !source_info.file_type().is_file() || source_info.len() == 0 {
        return Err(denied());
    }
    let canonical_root = root.canonicalize().map_err(|_| denied())?;
    let canonical_stage = stage.canonicalize().map_err(|_| denied())?;
    if canonical_stage.parent() != Some(canonical_root.as_path())
        || path.canonicalize().map_err(|_| denied())?.parent() != Some(canonical_stage.as_path())
    {
        return Err(denied());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = stage.join(format!("candidate.sqlite3{suffix}"));
        match std::fs::symlink_metadata(sidecar) {
            Ok(_) => return Err(denied()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err(denied()),
        }
    }
    Ok(())
}

fn pinned_detached_file_sha256(path: &Path) -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|_| "Detached owner source cannot be read".to_owned())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer)
            .map_err(|_| "Detached owner source read failed".to_owned())?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().into())
}

fn owner_receipt_hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Deliberately explicit, native-only entry point. Callers name ONLY a
/// disposable 32-hex stage token, never a filesystem path or owner key. The
/// trust anchor is compiled into an independently provisioned native build;
/// regular customer builds have no key and refuse BEFORE reading a source.
///
/// A valid owner proof writes a single immutable evidence sidecar, not an 068
/// database attestation and not a 065 reviewer authorization. Verification
/// of the whole original physical-row audit and its relationships is a
/// separate required gate before any future forward-only normalization.
pub(crate) fn run_native_owner_only_offline_stage(
    stage_token: &str,
) -> Result<std::path::PathBuf, String> {
    let trusted = crate::legacy_upgrade_guard::independently_pinned_native_owner_key()?;
    run_owner_only_stage_with_pinned_key(stage_token, &trusted)
}

fn run_owner_only_stage_with_pinned_key(
    stage_token: &str,
    trusted: &crate::legacy_upgrade_guard::IndependentlyAuthenticatedOwnerKey,
) -> Result<std::path::PathBuf, String> {
    if stage_token.len() != 32
        || !stage_token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid offline owner stage token".into());
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or("LOCALAPPDATA custody root unavailable")?;
    let root = std::path::PathBuf::from(local).join("pharma-disposable-data-copies");
    let stage = root.join(format!("pharma-owner-v67-stage-{stage_token}"));
    let source = stage.join("candidate.sqlite3");
    checked_detached_owner_stage(&source, &root)?;
    let proof_path = stage.join("owner-proof.json");
    let proof_metadata = std::fs::symlink_metadata(&proof_path)
        .map_err(|_| "Owner proof sidecar is missing")?;
    if !proof_metadata.file_type().is_file() || proof_metadata.len() == 0
        || proof_metadata.len() > 4096
    {
        return Err("Owner proof sidecar is unsafe or malformed".into());
    }
    let proof_bytes = std::fs::read(&proof_path)
        .map_err(|_| "Cannot read detached owner proof")?;
    let proof = crate::legacy_upgrade_guard::parse_detached_owner_only_proof_json(&proof_bytes)?;
    let (_verified, receipt) = import_owner_verified_detached_v67_authorization(
        &source, trusted, &proof,
    )?;
    Ok(receipt)
}

/// Native-only owner-authenticated OFFLINE evidence import for a staged v67
/// source. This is deliberately not a Tauri command or automatic startup
/// override. A separately authenticated owner public key is mandatory, and
/// the signed source/typed-row commitment must match the exact detached file.
/// The resulting create_new evidence receipt is cryptographically sealed,
/// durable and read-only; there are NO writes to source SQLite or 065 records.
///
/// Physical historical scope normalization and activation are separate
/// forward operations, and must independently check this receipt, reverify
/// its trusted owner key, and preserve 032/052 original source literals.
pub(crate) fn import_owner_verified_detached_v67_authorization(
    path: &Path,
    trusted: &crate::legacy_upgrade_guard::IndependentlyAuthenticatedOwnerKey,
    proof: &crate::legacy_upgrade_guard::OfflineOwnerOnlyProof,
) -> Result<(crate::legacy_upgrade_guard::VerifiedOwnerOnlyImport, std::path::PathBuf), String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or("LOCALAPPDATA custody root unavailable")?;
    let root = std::path::PathBuf::from(local).join("pharma-disposable-data-copies");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Cannot verify owner authorization expiry")?.as_secs();
    import_owner_verified_detached_v67_authorization_in_root(path, &root, trusted, proof, now)
}

fn import_owner_verified_detached_v67_authorization_in_root(
    path: &Path,
    root: &Path,
    trusted: &crate::legacy_upgrade_guard::IndependentlyAuthenticatedOwnerKey,
    proof: &crate::legacy_upgrade_guard::OfflineOwnerOnlyProof,
    now: u64,
) -> Result<(crate::legacy_upgrade_guard::VerifiedOwnerOnlyImport, std::path::PathBuf), String> {
    use std::io::Write;
    checked_detached_owner_stage(path, root)?;
    let pinned_before = pinned_detached_file_sha256(path)?;
    if pinned_before != proof.detached_v67_sha256 {
        return Err("Detached owner source SHA-256 mismatch".into());
    }
    let verified = tauri::async_runtime::block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(path).read_only(true).create_if_missing(false)
            .busy_timeout(std::time::Duration::from_secs(5));
        let mut db = SqliteConnection::connect_with(&options).await
            .map_err(|_| "Detached owner source unavailable")?;
        sqlx::query("PRAGMA query_only=ON").execute(&mut db).await
            .map_err(|_| "Cannot enforce read-only detached source")?;
        let result = crate::legacy_upgrade_guard::verify_detached_primary_pharmacy_owner_only(
            &mut db, trusted, proof, pinned_before, now
        ).await;
        db.close().await.map_err(|_| "Cannot close detached owner source")?;
        result
    })?;
    checked_detached_owner_stage(path, root)?;
    if pinned_detached_file_sha256(path)? != pinned_before {
        return Err("Detached owner source changed during signature verification".into());
    }
    let parent = path.parent().ok_or("Missing detached stage parent")?;
    let receipt = parent.join("primary_pharmacy.owner-only.signed-evidence.json");
    let json = serde_json::json!({
        "contract": "pharma/native/offline-owner-primary-pharmacy/v1",
        "tenant": crate::legacy_upgrade_guard::PRIMARY_PHARMACY_TENANT,
        "owner_id": verified.owner_id,
        "original_v29_sha256": owner_receipt_hex(&proof.original_v29_sha256),
        "detached_v67_sha256": owner_receipt_hex(&proof.detached_v67_sha256),
        "typed_scope_sha256": owner_receipt_hex(&verified.typed_scope_sha256),
        "mapping_rows": verified.mappings.len(),
        "request_nonce": owner_receipt_hex(&proof.request_nonce),
        "expires_unix_seconds": proof.expires_unix_seconds,
        "independently_pinned_owner_key_sha256": owner_receipt_hex(&trusted.key_fingerprint_sha256()),
        "signed_message_hex": owner_receipt_hex(&verified.signed_message),
        "ed25519_signature_hex": owner_receipt_hex(&proof.signature),
        "evidence_sha256": owner_receipt_hex(&verified.evidence_sha256),
        "authority": "owner-only-offline-evidence; no legacy SQL mutation or finance grant"
    });
    // A retry or already-present proof cannot silently overwrite custody.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(&receipt).map_err(|_| "Detached owner evidence already exists or cannot be sealed")?;
    file.write_all(serde_json::to_string_pretty(&json).map_err(|_| "Owner evidence serialization failed")?.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not durably seal owner evidence")?;
    let mut permissions = file.metadata().map_err(|_| "Owner receipt metadata failed")?.permissions();
    permissions.set_readonly(true);
    file.set_permissions(permissions).map_err(|_| "Could not seal owner evidence read-only")?;
    Ok((verified, receipt))
}

pub fn prepare_legacy_database(path: &Path) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        // Defence in depth: callers other than main.rs must not take the
        // compatibility-preparation shortcut around the read-only ownership
        // gate. Registered versions 001–063 predate complete source-row custody and their
        // old NULL/local_default identities must not be rewritten by staff
        // repairs, migration 032 credential reset or migration 052 owner scope
        // inference on an unapproved source. The first-run bundled seed has no
        // SQLx ledger, while an already migrated and reviewed v064+ profile
        // can follow the normal idempotent preparation path.
        if path.is_file() {
            let options = SqliteConnectOptions::new()
                .filename(path)
                .read_only(true)
                .create_if_missing(false);
            let mut probe = SqliteConnection::connect_with(&options)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("PRAGMA query_only=ON")
                .execute(&mut probe)
                .await
                .map_err(|e| e.to_string())?;
            let version: Option<i64> = if table_exists(&mut probe, "_sqlx_migrations")
                .await
                .map_err(|e| e.to_string())?
            {
                sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
                    .fetch_one(&mut probe)
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                None
            };
            if matches!(version, Some(1..=63)) {
                crate::legacy_upgrade_guard::assess_existing_connection(&mut probe)
                    .await
                    .map_err(|_| "Legacy ownership review required before native compatibility preparation; original database left unchanged".to_string())?;
            }
            probe.close().await.map_err(|e| e.to_string())?;
        }
        let mut connection = connect(path).await?;
        prepare_connection(&mut connection).await
    })
}

// Kept only to exercise recovery of databases that were already remapped by
// the withdrawn positional-repair build. New installs must never move a
// business record merely because catalog text changed.
#[cfg(test)]
async fn repair_legacy_catalog_name_drift_on_connection(
    connection: &mut SqliteConnection,
    seed_path: &Path,
) -> Result<u64, String> {
    let seed_path = seed_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''");
    sqlx::query(&format!("ATTACH DATABASE '{seed_path}' AS bundled_catalog"))
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;

    let repair_result = async {
        let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
        sqlx::raw_sql(
            r#"
            CREATE TEMP TABLE unique_bundled_catalog_names (
              trade_name TEXT COLLATE NOCASE PRIMARY KEY,
              drug_id INTEGER NOT NULL UNIQUE
            );

            INSERT INTO unique_bundled_catalog_names (trade_name, drug_id)
            SELECT TRIM(trade_name), MIN(id)
            FROM bundled_catalog.master_drugs
            WHERE TRIM(COALESCE(trade_name, '')) != ''
            GROUP BY TRIM(trade_name) COLLATE NOCASE
            HAVING COUNT(*) = 1;

            CREATE TEMP TABLE catalog_identity_repairs (
              source_id INTEGER PRIMARY KEY,
              target_id INTEGER NOT NULL UNIQUE
            );

            INSERT OR IGNORE INTO catalog_identity_repairs (source_id, target_id)
            SELECT source_id, target_id
            FROM (
              SELECT
                live.id AS source_id,
                duplicate.id AS target_id,
                (
                  CASE WHEN live.official_price IS NOT NULL
                         AND seed.official_price IS NOT NULL
                         AND ABS(live.official_price - seed.official_price) < 0.001
                    THEN 1 ELSE 0 END
                  + CASE WHEN TRIM(COALESCE(seed.active_ingredient, '')) != ''
                           AND TRIM(live.active_ingredient) = TRIM(seed.active_ingredient) COLLATE NOCASE
                    THEN 1 ELSE 0 END
                  + CASE WHEN TRIM(COALESCE(seed.category, '')) != ''
                           AND TRIM(live.category) = TRIM(seed.category) COLLATE NOCASE
                    THEN 1 ELSE 0 END
                  + CASE WHEN TRIM(COALESCE(seed.manufacturer, '')) != ''
                           AND TRIM(live.manufacturer) = TRIM(seed.manufacturer) COLLATE NOCASE
                    THEN 1 ELSE 0 END
                ) AS source_score,
                (
                  CASE WHEN live.official_price IS NOT NULL
                         AND duplicate.official_price IS NOT NULL
                         AND ABS(live.official_price - duplicate.official_price) < 0.001
                    THEN 1 ELSE 0 END
                  + CASE WHEN TRIM(COALESCE(duplicate.active_ingredient, '')) != ''
                           AND TRIM(live.active_ingredient) = TRIM(duplicate.active_ingredient) COLLATE NOCASE
                    THEN 1 ELSE 0 END
                  + CASE WHEN TRIM(COALESCE(duplicate.category, '')) != ''
                           AND TRIM(live.category) = TRIM(duplicate.category) COLLATE NOCASE
                    THEN 1 ELSE 0 END
                  + CASE WHEN TRIM(COALESCE(duplicate.manufacturer, '')) != ''
                           AND TRIM(live.manufacturer) = TRIM(duplicate.manufacturer) COLLATE NOCASE
                    THEN 1 ELSE 0 END
                ) AS target_score
              FROM main.master_drugs live
              JOIN bundled_catalog.master_drugs seed ON seed.id = live.id
              JOIN unique_bundled_catalog_names catalog_name
                ON catalog_name.trade_name = TRIM(live.trade_name)
               AND catalog_name.drug_id != live.id
              JOIN bundled_catalog.master_drugs duplicate ON duplicate.id = catalog_name.drug_id
              WHERE TRIM(COALESCE(live.trade_name, '')) != ''
                AND TRIM(live.trade_name) != TRIM(seed.trade_name) COLLATE NOCASE
                AND (
                  TRIM(COALESCE(live.trade_name_en, '')) = ''
                  OR TRIM(live.trade_name_en) = TRIM(duplicate.trade_name) COLLATE NOCASE
                  OR (
                    TRIM(COALESCE(duplicate.trade_name_en, '')) != ''
                    AND TRIM(live.trade_name_en) = TRIM(duplicate.trade_name_en) COLLATE NOCASE
                  )
                )
            ) candidates
            WHERE source_score >= 3 OR target_score >= 3;

            -- The legacy import attached the next visible catalog name to the old numeric ID.
            -- Move every business reference to that name's canonical ID before restoring names.
            UPDATE inventory
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = inventory.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE sales_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = sales_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE refill_reminders
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = refill_reminders.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE return_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = return_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE purchase_invoice_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = purchase_invoice_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE purchase_order_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = purchase_order_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE purchase_return_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = purchase_return_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE opening_balance_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = opening_balance_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE shortages
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = shortages.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            -- Migrate barcode from source to target when the target lacks one.
            -- The user entered the barcode under the wrong drug ID (due to CSV
            -- shift), so it should follow the business references to the
            -- canonical drug.
            UPDATE master_drugs
            SET barcode = (
              SELECT src.barcode
              FROM catalog_identity_repairs r
              JOIN master_drugs src ON src.id = r.source_id
              WHERE r.target_id = master_drugs.id
                AND TRIM(COALESCE(src.barcode, '')) != ''
            )
            WHERE id IN (SELECT target_id FROM catalog_identity_repairs)
              AND (barcode IS NULL OR TRIM(barcode) = '');

            -- Clear the barcode on the source row after it was migrated to the
            -- target, so it doesn't linger on the restored seed identity.
            UPDATE master_drugs
            SET barcode = NULL
            WHERE id IN (
              SELECT r.source_id FROM catalog_identity_repairs r
              JOIN master_drugs src ON src.id = r.source_id
              JOIN master_drugs tgt ON tgt.id = r.target_id
              WHERE TRIM(COALESCE(src.barcode, '')) != ''
                AND TRIM(COALESCE(tgt.barcode, '')) != ''
                AND src.barcode = tgt.barcode
            );

            -- Restore every catalog-owned field for both sides of a detected identity
            -- shift. Barcode has already been migrated above.
            UPDATE master_drugs
            SET
              trade_name = (
                SELECT seed.trade_name
                FROM bundled_catalog.master_drugs seed
                WHERE seed.id = master_drugs.id
              ),
              trade_name_en = (
                SELECT seed.trade_name_en
                FROM bundled_catalog.master_drugs seed
                WHERE seed.id = master_drugs.id
              ),
              official_price = (
                SELECT seed.official_price
                FROM bundled_catalog.master_drugs seed
                WHERE seed.id = master_drugs.id
              ),
              active_ingredient = (
                SELECT seed.active_ingredient
                FROM bundled_catalog.master_drugs seed
                WHERE seed.id = master_drugs.id
              ),
              category = (
                SELECT seed.category
                FROM bundled_catalog.master_drugs seed
                WHERE seed.id = master_drugs.id
              ),
              manufacturer = (
                SELECT seed.manufacturer
                FROM bundled_catalog.master_drugs seed
                WHERE seed.id = master_drugs.id
              )
            WHERE id IN (
              SELECT source_id FROM catalog_identity_repairs
              UNION
              SELECT target_id FROM catalog_identity_repairs
            );
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;

        if has_column(
            &mut transaction,
            "cloud_drug_mappings",
            "local_drug_id",
        )
        .await
        .map_err(|e| e.to_string())?
        {
            // These mappings are a derived sync cache. Keeping a mapping created by
            // the bad positional import would immediately corrupt the repaired row again.
            sqlx::query(
                r#"
                DELETE FROM cloud_drug_mappings
                WHERE local_drug_id IN (
                  SELECT source_id FROM catalog_identity_repairs
                  UNION
                  SELECT target_id FROM catalog_identity_repairs
                )
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        }

        if has_column(&mut transaction, "drug_indications", "indication_id")
            .await
            .map_err(|e| e.to_string())?
        {
            sqlx::raw_sql(
                r#"
                CREATE TEMP TABLE repaired_drug_indications AS
                SELECT
                  COALESCE(repair.target_id, relation.drug_id) AS drug_id,
                  relation.indication_id
                FROM drug_indications relation
                LEFT JOIN catalog_identity_repairs repair ON repair.source_id = relation.drug_id;
                DELETE FROM drug_indications;
                INSERT OR IGNORE INTO drug_indications (drug_id, indication_id)
                SELECT drug_id, indication_id FROM repaired_drug_indications;
                DROP TABLE repaired_drug_indications;
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            sqlx::query(
                r#"
                UPDATE drug_indications
                SET drug_id = (
                  SELECT target_id FROM catalog_identity_repairs
                  WHERE source_id = drug_indications.drug_id
                )
                WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs)
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        }

        if has_column(&mut transaction, "drug_alternatives", "alternative_id")
            .await
            .map_err(|e| e.to_string())?
        {
            sqlx::raw_sql(
                r#"
                CREATE TEMP TABLE repaired_drug_alternatives AS
                SELECT
                  COALESCE(drug_repair.target_id, relation.drug_id) AS drug_id,
                  COALESCE(alternative_repair.target_id, relation.alternative_id) AS alternative_id
                FROM drug_alternatives relation
                LEFT JOIN catalog_identity_repairs drug_repair
                  ON drug_repair.source_id = relation.drug_id
                LEFT JOIN catalog_identity_repairs alternative_repair
                  ON alternative_repair.source_id = relation.alternative_id;
                DELETE FROM drug_alternatives;
                INSERT OR IGNORE INTO drug_alternatives (drug_id, alternative_id)
                SELECT drug_id, alternative_id FROM repaired_drug_alternatives;
                DROP TABLE repaired_drug_alternatives;
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            sqlx::raw_sql(
                r#"
                UPDATE drug_alternatives
                SET drug_id = (
                  SELECT target_id FROM catalog_identity_repairs
                  WHERE source_id = drug_alternatives.drug_id
                )
                WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

                UPDATE drug_alternatives
                SET alternative_drug_id = (
                  SELECT target_id FROM catalog_identity_repairs
                  WHERE source_id = drug_alternatives.alternative_drug_id
                )
                WHERE alternative_drug_id IN (SELECT source_id FROM catalog_identity_repairs);
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        }

        let repaired: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM catalog_identity_repairs")
            .fetch_one(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;

        // Legacy workbooks wrote 1 when the per-lot pack factor was blank. Repair only
        // untouched lots; any transactional history makes the lot value authoritative.
        let unit_repairs = sqlx::query(
            r#"
            UPDATE inventory
            SET strips_per_box = (
              SELECT md.large_to_medium FROM master_drugs md WHERE md.id = inventory.drug_id
            )
            WHERE COALESCE(strips_per_box, 1) = 1
              AND COALESCE((
                SELECT md.large_to_medium FROM master_drugs md WHERE md.id = inventory.drug_id
              ), 1) > 1
              AND NOT EXISTS (SELECT 1 FROM sales_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM return_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM purchase_invoice_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM purchase_return_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM stock_adjustments WHERE inventory_id = inventory.id)
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected() as i64;

        // Phase 2: Fix metadata drift for drugs where the trade_name is
        // correct but active_ingredient / category / manufacturer /
        // official_price came from a different drug due to CSV ID
        // misalignment. Match by unique trade_name instead of by ID.
        let metadata_repairs = sqlx::query(
            r#"
            UPDATE master_drugs
            SET
              active_ingredient = seed.active_ingredient,
              category          = seed.category,
              manufacturer      = seed.manufacturer,
              official_price    = seed.official_price
            FROM (
              SELECT bc.trade_name, bc.active_ingredient, bc.category,
                     bc.manufacturer, bc.official_price
              FROM bundled_catalog.master_drugs bc
              WHERE TRIM(COALESCE(bc.trade_name, '')) != ''
              GROUP BY TRIM(bc.trade_name) COLLATE NOCASE
              HAVING COUNT(*) = 1
            ) seed
            INNER JOIN (
              SELECT TRIM(trade_name) AS uname
              FROM master_drugs
              WHERE TRIM(COALESCE(trade_name, '')) != ''
              GROUP BY TRIM(trade_name) COLLATE NOCASE
              HAVING COUNT(*) = 1
            ) live_unique ON live_unique.uname = TRIM(seed.trade_name) COLLATE NOCASE
            WHERE TRIM(master_drugs.trade_name) = TRIM(seed.trade_name) COLLATE NOCASE
              AND (
                COALESCE(TRIM(master_drugs.active_ingredient), '')
                  != COALESCE(TRIM(seed.active_ingredient), '') COLLATE NOCASE
                OR COALESCE(TRIM(master_drugs.manufacturer), '')
                  != COALESCE(TRIM(seed.manufacturer), '') COLLATE NOCASE
                OR COALESCE(TRIM(master_drugs.category), '')
                  != COALESCE(TRIM(seed.category), '') COLLATE NOCASE
                OR ABS(COALESCE(master_drugs.official_price, 0)
                     - COALESCE(seed.official_price, 0)) > 0.001
              )
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected() as i64;

        // Phase 3: Heal stranded barcodes.
        // If a canonical master_drug row has inventory or purchase items with a barcode,
        // but its master_drugs.barcode is empty (e.g. from an earlier migration
        // that didn't move barcodes), assign the barcode from inventory/purchases.
        // Also clear barcodes from rows that have no matching inventory/purchases
        // and whose barcode conflicts with an inventory-backed drug.
        let mut barcode_heals = 0;
        let inv_has_barcode = has_column(&mut transaction, "inventory", "barcode")
            .await
            .unwrap_or(false);
        let pii_has_barcode = has_column(&mut transaction, "purchase_invoice_items", "barcode")
            .await
            .unwrap_or(false);

        if inv_has_barcode {
            let healed = sqlx::raw_sql(
                r#"
                UPDATE master_drugs
                SET barcode = (
                  SELECT i.barcode FROM inventory i
                  WHERE i.drug_id = master_drugs.id AND TRIM(COALESCE(i.barcode, '')) != ''
                  LIMIT 1
                )
                WHERE (barcode IS NULL OR TRIM(barcode) = '')
                  AND id IN (
                    SELECT drug_id FROM inventory WHERE TRIM(COALESCE(barcode, '')) != ''
                  );

                UPDATE master_drugs
                SET barcode = NULL
                WHERE barcode IS NOT NULL AND TRIM(barcode) != ''
                  AND id NOT IN (
                    SELECT drug_id FROM inventory WHERE TRIM(COALESCE(barcode, '')) != ''
                  )
                  AND barcode IN (
                    SELECT i.barcode FROM inventory i
                    WHERE i.drug_id != master_drugs.id AND TRIM(COALESCE(i.barcode, '')) != ''
                  );
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected() as i64;
            barcode_heals += healed;
        }

        if pii_has_barcode {
            let healed = sqlx::raw_sql(
                r#"
                UPDATE master_drugs
                SET barcode = (
                  SELECT p.barcode FROM purchase_invoice_items p
                  WHERE p.drug_id = master_drugs.id AND TRIM(COALESCE(p.barcode, '')) != ''
                  LIMIT 1
                )
                WHERE (barcode IS NULL OR TRIM(barcode) = '')
                  AND id IN (
                    SELECT drug_id FROM purchase_invoice_items WHERE TRIM(COALESCE(barcode, '')) != ''
                  );

                UPDATE master_drugs
                SET barcode = NULL
                WHERE barcode IS NOT NULL AND TRIM(barcode) != ''
                  AND id NOT IN (
                    SELECT drug_id FROM purchase_invoice_items WHERE TRIM(COALESCE(barcode, '')) != ''
                  )
                  AND barcode IN (
                    SELECT p.barcode FROM purchase_invoice_items p
                    WHERE p.drug_id != master_drugs.id AND TRIM(COALESCE(p.barcode, '')) != ''
                  );
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected() as i64;
            barcode_heals += healed;
        }

            sqlx::query("DROP TABLE catalog_identity_repairs")
                .execute(&mut *transaction)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DROP TABLE unique_bundled_catalog_names")
                .execute(&mut *transaction)
                .await
                .map_err(|e| e.to_string())?;
        transaction.commit().await.map_err(|e| e.to_string())?;
        Ok::<u64, String>((repaired + unit_repairs + metadata_repairs + barcode_heals) as u64)
    }
    .await;

    let detach_result = sqlx::query("DETACH DATABASE bundled_catalog")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string());

    match (repair_result, detach_result) {
        (Ok(repaired), Ok(_)) => Ok(repaired),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

const CATALOG_REPAIR_VERSION: &str = "csv-catalog-name-metadata-v2";
const CATALOG_PRICE_REPAIR_VERSION: &str = "csv-inventory-selling-price-v1";

async fn attach_catalog_reference(
    connection: &mut SqliteConnection,
    seed_path: &Path,
) -> Result<(), String> {
    // Installed resources may be under Program Files. The seed is a checkpointed
    // read-only artifact, even though its SQLite header still says WAL mode.
    // A normal ATTACH can try to create -wal/-shm beside that protected resource.
    let absolute = std::fs::canonicalize(seed_path)
        .map_err(|e| format!("Cannot locate bundled catalog: {e}"))?;
    let mut wal = absolute.as_os_str().to_os_string();
    wal.push("-wal");
    match std::fs::metadata(std::path::PathBuf::from(wal)) {
        Ok(metadata) if metadata.len() > 0 => {
            return Err(
                "Bundled catalog has an uncheckpointed WAL; refusing to ignore its contents".into(),
            )
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(format!("Cannot check bundled catalog WAL: {error}"))
        }
        _ => {}
    }
    let mut uri =
        tauri::Url::from_file_path(&absolute).map_err(|_| "Invalid bundled catalog path")?;
    uri.set_query(Some("mode=ro&immutable=1"));
    sqlx::query("ATTACH DATABASE ? AS bundled_catalog")
        .bind(uri.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|e| format!("Cannot read bundled catalog: {e}"))?;
    Ok(())
}

/// The local name/barcode identifies stock; seed IDs are not portable across installations.
/// Only unambiguous CSV names can supply replacement metadata. Never move business rows.
async fn repair_catalog_name_drift_on_connection(
    connection: &mut SqliteConnection,
    seed_path: &Path,
) -> Result<u64, String> {
    let already_repaired: Option<String> = sqlx::query_scalar(
        "SELECT value FROM config WHERE key = 'catalog_name_metadata_repair_version'",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    let price_version: Option<String> = sqlx::query_scalar(
        "SELECT value FROM config WHERE key = 'catalog_inventory_price_repair_version'",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if already_repaired.as_deref() == Some(CATALOG_REPAIR_VERSION)
        && price_version.as_deref() == Some(CATALOG_PRICE_REPAIR_VERSION)
    {
        return Ok(0);
    }
    let legacy_repair: Option<String> = sqlx::query_scalar(
        "SELECT value FROM config WHERE key = 'catalog_reference_repair_version'",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if already_repaired.as_deref() != Some(CATALOG_REPAIR_VERSION)
        && legacy_repair.as_deref() == Some("csv-catalog-reference-v1")
    {
        return Err("Earlier ID-based catalog repair detected. Recover the original drug names from its pre-repair backup before applying name-based correction.".into());
    }

    attach_catalog_reference(connection, seed_path).await?;

    let repair_result = async {
        let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
        // ponytail: the offline recovery tool executes this exact SQL too.
        // Older installations have FTS triggers without rowid. Reuse the existing
        // migration so metadata edits do not leave stale or misidentified search hits.
        if has_column(&mut transaction, "master_drugs_fts", "trade_name").await.map_err(|e| e.to_string())? {
            sqlx::raw_sql(include_str!("../migrations/009_rebuild_master_drugs_fts.sql"))
                .execute(&mut *transaction).await.map_err(|e| e.to_string())?;
        }
        sqlx::raw_sql(include_str!("catalog_metadata_repair.sql"))
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
        let repaired: i64 = sqlx::query_scalar("SELECT changes()")
            .fetch_one(&mut *transaction).await.map_err(|e| e.to_string())?;
        sqlx::raw_sql(include_str!("catalog_inventory_price_repair.sql"))
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;
        let prices_repaired: i64 = sqlx::query_scalar("SELECT changes()")
            .fetch_one(&mut *transaction).await.map_err(|e| e.to_string())?;
        let skipped: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs drug LEFT JOIN catalog_repair_names names ON names.kind=0 AND names.drug_id=drug.id LEFT JOIN catalog_repair_reference reference ON reference.name=names.name WHERE reference.name IS NULL")
            .fetch_one(&mut *transaction).await.map_err(|e| e.to_string())?;
        sqlx::raw_sql("DROP TABLE catalog_repair_reference; DROP TABLE catalog_repair_names;")
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;

        if repaired > 0
            && has_column(&mut transaction, "cloud_drug_mappings", "local_drug_id")
                .await
                .map_err(|e| e.to_string())?
        {
            // This table is a cache. A positional mapping would immediately
            // overwrite the restored catalog during the next cloud sync.
            sqlx::query("DELETE FROM cloud_drug_mappings")
                .execute(&mut *transaction)
                .await
                .map_err(|e| e.to_string())?;
        }

        sqlx::query(
            "INSERT INTO config (key, value) VALUES ('catalog_name_metadata_repair_version', ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(CATALOG_REPAIR_VERSION)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query("INSERT INTO config(key,value) VALUES ('catalog_inventory_price_repair_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(CATALOG_PRICE_REPAIR_VERSION)
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO config(key,value) VALUES ('catalog_csv_repair_status', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(format!("اكتمل التصحيح المحلي: {repaired} سجل دواء و{prices_repaired} سعر مخزون. تم الاحتفاظ بالأسماء والباركود والكميات والتكاليف والفواتير. {skipped} صنف غير مطابق أو ملتبس تُرك دون تغيير ويحتاج مراجعة."))
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;

        // Block older installed executables from rerunning their unsafe ID-based repair.
        sqlx::query("INSERT INTO config(key,value) VALUES ('catalog_reference_repair_version','csv-catalog-reference-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;

        transaction.commit().await.map_err(|e| e.to_string())?;
        Ok::<u64, String>((repaired + prices_repaired) as u64)
    }
    .await;

    let detach_result = sqlx::query("DETACH DATABASE bundled_catalog")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string());

    match (repair_result, detach_result) {
        (Ok(repaired), Ok(_)) => Ok(repaired),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

async fn repair_catalog_with_backup(path: &Path, seed_path: &Path) -> Result<u64, String> {
    let mut connection = connect(path).await?;
    let version: Option<String> = sqlx::query_scalar(
        "SELECT value FROM config WHERE key = 'catalog_name_metadata_repair_version'",
    )
    .fetch_optional(&mut connection)
    .await
    .map_err(|e| e.to_string())?;
    let price_version: Option<String> = sqlx::query_scalar(
        "SELECT value FROM config WHERE key = 'catalog_inventory_price_repair_version'",
    )
    .fetch_optional(&mut connection)
    .await
    .map_err(|e| e.to_string())?;
    if version.as_deref() != Some(CATALOG_REPAIR_VERSION)
        || price_version.as_deref() != Some(CATALOG_PRICE_REPAIR_VERSION)
    {
        let legacy: Option<String> = sqlx::query_scalar(
            "SELECT value FROM config WHERE key = 'catalog_reference_repair_version'",
        )
        .fetch_optional(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
        if version.as_deref() != Some(CATALOG_REPAIR_VERSION)
            && legacy.as_deref() == Some("csv-catalog-reference-v1")
        {
            // The repair will explain the missing identity evidence; do not make
            // another full backup on every startup of an installation awaiting review.
            return repair_catalog_name_drift_on_connection(&mut connection, seed_path).await;
        }
        // Never modify catalog metadata unless a complete recovery point exists.
        let backup = crate::database_backup::create_backup(path).await?;
        sqlx::query("INSERT INTO config(key,value) VALUES ('catalog_csv_repair_backup_path', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(backup.to_string_lossy().as_ref()).execute(&mut connection).await.map_err(|e| e.to_string())?;
    }
    repair_catalog_name_drift_on_connection(&mut connection, seed_path).await
}

pub fn repair_catalog_name_drift(path: &Path, seed_path: &Path) -> Result<u64, String> {
    tauri::async_runtime::block_on(async {
        let result = repair_catalog_with_backup(path, seed_path).await;
        if let Err(ref error) = result {
            // Preserve a visible explanation when startup cannot safely repair.
            if let Ok(mut connection) = connect(path).await {
                let _ = sqlx::query("INSERT INTO config(key,value) VALUES ('catalog_csv_repair_status', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
                    .bind(format!("تعذر إكمال التحقق من التصحيح التلقائي بأمان؛ يرجى الاحتفاظ بالنسخة الاحتياطية ومراجعة الدعم. {error}"))
                    .execute(&mut connection).await;
            }
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_offline_owner_entry_denies_missing_compiled_owner_provenance_before_source_access() {
        use crate::legacy_upgrade_guard::independently_pinned_native_owner_key;
        // QA and regular customer builds have no independently enrolled
        // historical key. No fabricated credential or historical source path.
        if independently_pinned_native_owner_key().is_err() {
            let denial = run_native_owner_only_offline_stage("0123456789abcdef0123456789abcdef");
            assert!(denial.is_err());
            assert!(denial.unwrap_err().contains("original database left unchanged"),
                "Missing authentic owner provenance must fail before looking up a stage");
        }
        let token = "00112233445566778899aabbccddeeff";
        // The supplied synthetic key is deliberately NEVER made available to
        // the production CLI. This only tests the stage-token guard.
        let synthetic = crate::legacy_upgrade_guard::IndependentlyAuthenticatedOwnerKey::
            from_trusted_native_custody("synthetic", [1; 32], [2; 32]).unwrap();
        for malformed in ["", "..", "pharma_local.db", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            "0123456789abcdef0123456789abcdeg", "0123456789abcdef0123456789abcdef\\original.sqlite3"
        ] {
            assert!(run_owner_only_stage_with_pinned_key(malformed, &synthetic).is_err(),
                "Absolute paths, original profile names and malformed stage tokens must be rejected");
        }
        assert!(token.len() == 32);
    }

    #[test]
    fn owner_only_offline_v67_stage_requires_exact_private_candidate_and_no_sidecars() {
        let root = std::env::temp_dir().join(format!(
            "pharma-test-owner-only-stage-root-{}", uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&root).unwrap();
        let stage = root.join("pharma-owner-v67-stage-0123456789abcdef0123456789abcdef");
        std::fs::create_dir(&stage).unwrap();
        let detached = stage.join("candidate.sqlite3");
        std::fs::write(&detached, b"synthetic-staged-data-no-credential").unwrap();
        assert!(checked_detached_owner_stage(&detached, &root).is_ok());
        let sidecar = stage.join("candidate.sqlite3-wal");
        std::fs::write(&sidecar, b"synthetic-hot-wal").unwrap();
        assert!(checked_detached_owner_stage(&detached, &root).is_err());
        std::fs::remove_file(&sidecar).unwrap();
        assert!(checked_detached_owner_stage(&stage.join("pharma_local.db"), &root).is_err(),
            "An installed database filename must never satisfy detached custody");
        let unexpected = root.join("pharma-owner-v67-stage-unpinned");
        std::fs::create_dir(&unexpected).unwrap();
        std::fs::write(unexpected.join("candidate.sqlite3"), b"synthetic").unwrap();
        assert!(checked_detached_owner_stage(&unexpected.join("candidate.sqlite3"), &root).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn startup_schema_repair_must_not_be_renderer_callable() {
        // Compatibility repair writes account mappings and legacy financial
        // state. It is for the trusted startup migrator, never renderer IPC.
        assert!(
            !include_str!("main.rs").contains("schema::ensure_schema_compatibility,"),
            "Schema compatibility repair is registered as unauthenticated renderer IPC"
        );
    }

    #[tokio::test]
    async fn receipted_credit_patient_identity_cannot_be_reassigned() {
        use sqlx::Executor;
        // Use the real 043, 045 and forward-only 050 triggers on disposable
        // SQLite. A receipted credit source must retain its patient.
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,is_active INTEGER);
          INSERT INTO users VALUES('a','branch-a',1);
          CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,
            user_id TEXT,total_amount REAL,payment_method TEXT,status TEXT);
          CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,
            drug_id INTEGER,quantity_sold REAL,unit_price REAL,unit TEXT,
            is_negative INTEGER,cost_price REAL,large_to_medium INTEGER,medium_to_small INTEGER);
          CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,
            user_id TEXT,refund_method TEXT,status TEXT,total_refund REAL);
          CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT);
          INSERT INTO accounts VALUES(1,'1.1.2'),(2,'3.1');
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,
            created_by TEXT,total_amount REAL);
          CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,
            account_id INTEGER,type TEXT,amount REAL);
          CREATE TABLE cash_movements(id TEXT PRIMARY KEY);
          INSERT INTO sales_invoices VALUES('sale-a','patient-a','branch-a','a',100,'credit','completed');
          INSERT INTO sales_items VALUES(1,'sale-a',NULL,1,1,100,'large',0,0,1,1);
          INSERT INTO daily_journals VALUES('sale-j','branch-a','a',100);
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
            VALUES('sale-j',1,'debit',100),('sale-j',2,'credit',100);
        "#).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        db.execute(
            r#"INSERT INTO native_sale_cogs_provenance
          (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
           sale_micros,cogs_micros,line_count,line_snapshot)
          VALUES('sale-a','12345678-abcd-4abc-8abc-123456789abc','branch-a','a',
                 'sale-j','credit',100000000,0,1,'[{"lineId":1}]')"#,
        )
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../migrations/045_native_delivery_collection.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../migrations/050_receipted_credit_patient_ownership.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        let changed =
            sqlx::query("UPDATE sales_invoices SET patient_id='patient-b' WHERE id='sale-a'")
                .execute(&mut db)
                .await;
        assert!(
            changed.is_err(),
            "Receipted credit source was assigned to a different patient"
        );
        let current: String =
            sqlx::query_scalar("SELECT patient_id FROM sales_invoices WHERE id='sale-a'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(current, "patient-a");
        db.execute("UPDATE sales_invoices SET patient_id='patient-a' WHERE id='sale-a'")
            .await
            .unwrap();
        db.execute("INSERT INTO sales_invoices VALUES('legacy','patient-a','branch-a','a',5,'credit','completed')")
            .await.unwrap();
        db.execute("UPDATE sales_invoices SET patient_id='patient-b' WHERE id='legacy'")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn real_legacy_scope_snapshot_cannot_certify_inferred_patient_credit_or_return() {
        use sqlx::Executor;
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,pharmacy_id TEXT);
            INSERT INTO users VALUES('local','local','local_default');
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,user_id TEXT,patient_id TEXT,
                pharmacy_id TEXT,payment_method TEXT,status TEXT,total_amount REAL);
            INSERT INTO sales_invoices VALUES('old','local','legacy-patient',NULL,'credit','completed',100);
            CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,user_id TEXT,pharmacy_id TEXT,
                refund_method TEXT,status TEXT,total_refund REAL);
            INSERT INTO returns VALUES('old-return','old','local',NULL,'patient_account','approved',10);
            CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,
                payment_method TEXT,sale_micros INTEGER);
            CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,
                pharmacy_id TEXT,refund_method TEXT,refund_micros INTEGER);
        "#).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        snapshot_branch_local_pharmacy_scope(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        let inferred_sale: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices WHERE id='old'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        let inferred_return: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM returns WHERE id='old-return'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(inferred_sale, "local_default");
        assert_eq!(inferred_return, "local_default");
        let unsafe_origin =
            crate::commands::financial_notices_native::verify_proven_patient_credit_sources(
                &mut db,
                "legacy-patient",
                "local_default",
            )
            .await;
        assert!(unsafe_origin.as_ref().is_err_and(|e|e.contains("unverified credit source")),
            "Compatibility inference was mistaken for historical financial ownership: {unsafe_origin:?}");
        let old_source: String =
            sqlx::query_scalar("SELECT patient_id FROM sales_invoices WHERE id='old'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(old_source, "legacy-patient");
    }

    fn actual_native_startup_migrator(count: usize) -> sqlx::migrate::Migrator {
        let listed = crate::app_migrations();
        assert_eq!(
            listed.len(),
            69,
            "native startup must register 001 through 069"
        );
        assert_eq!(listed[32].description, "patient_payment_scope");
        assert_eq!(listed[33].description, "expense_posting_requests");
        assert_eq!(listed[34].description, "commercial_paper_replay");
        assert_eq!(listed[35].description, "financial_notice_provenance");
        assert_eq!(listed[36].description, "finance_device_create_requests");
        assert_eq!(listed[37].description, "inventory_lot_create_requests");
        assert_eq!(listed[38].description, "inventory_create_acknowledgements");
        assert_eq!(listed[39].description, "stock_ledger_provenance");
        assert_eq!(listed[40].description, "purchase_return_posting_provenance");
        assert_eq!(listed[41].description, "purchase_posting_events");
        assert_eq!(listed[42].description, "native_sales_cogs_provenance");
        assert_eq!(listed[46].description, "purchase_draft_create_witnesses");
        assert_eq!(
            listed[47].description,
            "purchase_return_supplier_cash_provenance"
        );
        assert_eq!(listed[48].description, "purchase_return_reference_indexes");
        assert_eq!(listed[49].description, "receipted_credit_patient_ownership");
        assert_eq!(listed[50].description, "patient_financial_journal_receipts");
        assert_eq!(listed[51].description, "explicit_local_owner_pharmacy");
        assert_eq!(listed[52].description, "ambiguous_owner_scope_review");
        assert_eq!(listed[53].description, "native_supplier_partial_payment");
        assert_eq!(listed[54].description, "patient_cash_movement_witness");
        assert_eq!(listed[55].description, "financial_notice_cash_witness");
        assert_eq!(listed[56].description, "supplier_cash_shift_identity_guard");
        assert_eq!(listed[57].description, "supplier_cash_shift_replace_guard");
        assert_eq!(listed[58].description, "supplier_payment_receipt_replace_guard");
        assert_eq!(listed[59].description, "native_patient_wallet_topups");
        assert_eq!(listed[60].description, "native_patient_directory_ownership");
        assert_eq!(listed[61].description, "native_supplier_directory_ownership");
        assert_eq!(listed[62].description, "unused_drug_reference_indexes");
        assert_eq!(listed[64].description, "legacy_upgrade_provenance");
        assert_eq!(listed[65].description, "legacy_mapped_source_row_seal");
        assert_eq!(listed[66].description, "legacy_original_detail_row_seal");
        assert_eq!(listed[67].description, "primary_pharmacy_typed_scope_audit");
        assert_eq!(listed[68].description, "supplier_return_aware_payment_guard");
        for (index, migration) in listed.iter().enumerate() {
            assert_eq!(migration.version, (index + 1) as i64);
            assert!(matches!(
                migration.kind,
                tauri_plugin_sql::MigrationKind::Up
            ));
        }
        sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                listed
                    .into_iter()
                    .take(count)
                    .map(|entry| {
                        sqlx::migrate::Migration::new(
                            entry.version,
                            entry.description.into(),
                            sqlx::migrate::MigrationType::ReversibleUp,
                            entry.sql.into(),
                            false,
                        )
                    })
                    .collect(),
            ),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        }
    }

    #[tokio::test]
    async fn native_051_real_startup_is_forward_only_without_guessing_old_financial_journals() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(1)
            .run(&mut db)
            .await
            .unwrap();
        let protected_001: Vec<u8> = sqlx::query_scalar(
            "SELECT checksum FROM _sqlx_migrations WHERE version=1 AND success=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        // This is the production order: compatibility prepares an existing
        // installation, then the native SQLx migrator installs the forward DDL.
        prepare_connection(&mut db).await.unwrap();
        actual_native_startup_migrator(51)
            .run(&mut db)
            .await
            .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success=1")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(count, 51);
        let current_001: Vec<u8> = sqlx::query_scalar(
            "SELECT checksum FROM _sqlx_migrations WHERE version=1 AND success=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(protected_001, current_001);
        let present:i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='native_patient_financial_journal_receipts' AND type='table'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(present, 1);
        let initially_empty: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_patient_financial_journal_receipts")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(
            initially_empty, 0,
            "No V1 payment or notice can be assigned an invented journal"
        );
    }

    #[tokio::test]
    async fn native_052_real_startup_explicitly_scopes_only_original_unambiguous_owner() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(1).run(&mut db).await.unwrap();
        prepare_connection(&mut db).await.unwrap();
        actual_native_startup_migrator(51).run(&mut db).await.unwrap();
        let old_043_checksum: Vec<u8> = sqlx::query_scalar(
            "SELECT checksum FROM _sqlx_migrations WHERE version=43 AND success=1",
        )
        .fetch_one(&mut db).await.unwrap();
        let before: Option<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(before, None);
        actual_native_startup_migrator(52).run(&mut db).await.unwrap();
        let after: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(after, "local_default");
        let preserved_043_checksum: Vec<u8> = sqlx::query_scalar(
            "SELECT checksum FROM _sqlx_migrations WHERE version=43 AND success=1",
        )
        .fetch_one(&mut db).await.unwrap();
        assert_eq!(preserved_043_checksum, old_043_checksum);
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE success=1",
        )
        .fetch_one(&mut db).await.unwrap();
        assert_eq!(count, 52);
    }

    #[tokio::test]
    async fn native_053_quarantines_original_owner_if_052_missed_foreign_bank_scope() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(1).run(&mut db).await.unwrap();
        prepare_connection(&mut db).await.unwrap();
        actual_native_startup_migrator(51).run(&mut db).await.unwrap();
        let original_043: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=43")
                .fetch_one(&mut db).await.unwrap();
        // The only branch-B evidence belongs to a bank, which the already
        // installed 052 did not check. Reproduce the original bad claim.
        sqlx::query("INSERT INTO banks(name_ar,pharmacy_id) VALUES ('Foreign bank','branch-B')")
            .execute(&mut db).await.unwrap();
        actual_native_startup_migrator(52).run(&mut db).await.unwrap();
        let mistakenly_claimed: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(mistakenly_claimed, "local_default");

        actual_native_startup_migrator(53).run(&mut db).await.unwrap();
        let review: String = sqlx::query_scalar(
            "SELECT reason FROM native_owner_scope_review WHERE owner_id='admin'",
        ).fetch_one(&mut db).await.unwrap();
        assert!(review.contains("Ambiguous"));
        let preserved_043: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=43")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(original_043, preserved_043);
        let still_scoped: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(still_scoped, "local_default", "Do not guess a different owner tenant");
        assert!(sqlx::query("DELETE FROM native_owner_scope_review WHERE owner_id='admin'")
            .execute(&mut db).await.is_err(), "Review cannot be removed through general SQL");
    }

    #[tokio::test]
    async fn native_053_keeps_unambiguous_original_local_owner_operational() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(1).run(&mut db).await.unwrap();
        prepare_connection(&mut db).await.unwrap();
        actual_native_startup_migrator(53).run(&mut db).await.unwrap();
        let pharmacy: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(pharmacy, "local_default");
        let review_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_owner_scope_review")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(review_count, 0);
    }

    #[tokio::test]
    async fn native_startup_001_to_032_disarms_only_original_owner_and_preserves_sqlx_history() {
        use crate::commands::auth::{
            authenticate_on_connection, enroll_owner_on_connection,
            owner_enrollment_pending_on_connection,
        };
        // Start from the actual 001 SQLx migration in memory. Do not open the
        // bundled seed or an operator/customer database.
        let migrator_001 = actual_native_startup_migrator(1);
        let migrator_032 = actual_native_startup_migrator(39);
        for changed_admin in [false, true] {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            migrator_001.run(&mut connection).await.unwrap();
            let published_hash: String = sqlx::query_scalar(
                "SELECT password_hash FROM users WHERE CAST(id AS TEXT) = 'admin'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert!(bcrypt::verify("admin", &published_hash).unwrap());
            let version_001_checksum_before: Vec<u8> = sqlx::query_scalar(
                "SELECT checksum FROM _sqlx_migrations WHERE version = 1 AND success = 1",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();

            let edited_hash = bcrypt::hash("Existing!OwnerPassword2026", 4).unwrap();
            if changed_admin {
                sqlx::query("UPDATE users SET password_hash = ? WHERE id = 'admin'")
                    .bind(&edited_hash)
                    .execute(&mut connection)
                    .await
                    .unwrap();
            }
            let another_hash = bcrypt::hash("Other!OwnerPassword2026", 4).unwrap();
            sqlx::query(
                "INSERT INTO users(id,username,role,full_name,pharmacy_id,password_hash,is_active) \
                 VALUES('existing-owner-b','owner-b','owner','Branch B Owner','branch-B',?,1)",
            ).bind(&another_hash).execute(&mut connection).await.unwrap();

            // Match main.rs licensed startup: prepare first, then run all the
            // pending native SQLx migrations. This also covers checksum repairs
            // and pre-applied ledger entries on a historical installation.
            prepare_connection(&mut connection).await.unwrap();
            migrator_032.run(&mut connection).await.unwrap();
            let version_001_checksum_after: Vec<u8> = sqlx::query_scalar(
                "SELECT checksum FROM _sqlx_migrations WHERE version = 1 AND success = 1",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(version_001_checksum_after, version_001_checksum_before);
            let versions: Vec<i64> = sqlx::query_scalar(
                "SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
            )
            .fetch_all(&mut connection)
            .await
            .unwrap();
            assert_eq!(versions, (1_i64..=39).collect::<Vec<_>>());

            let hash_after: Option<String> =
                sqlx::query_scalar("SELECT password_hash FROM users WHERE id = 'admin'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            if changed_admin {
                assert_eq!(hash_after.as_deref(), Some(edited_hash.as_str()));
                assert!(!owner_enrollment_pending_on_connection(&mut connection)
                    .await
                    .unwrap());
                assert!(
                    authenticate_on_connection(
                        &mut connection,
                        "admin",
                        "Existing!OwnerPassword2026",
                    )
                    .await
                    .unwrap()
                    .success
                );
                assert!(enroll_owner_on_connection(
                    &mut connection,
                    "Replacement!OwnerPassword2026",
                )
                .await
                .is_err());
            } else {
                assert!(
                    hash_after.is_none(),
                    "migration 032 must neutralize 001's public secret"
                );
                assert!(owner_enrollment_pending_on_connection(&mut connection)
                    .await
                    .unwrap());
                assert!(
                    !authenticate_on_connection(&mut connection, "admin", "admin")
                        .await
                        .unwrap()
                        .success
                );
                enroll_owner_on_connection(&mut connection, "New!OwnerPassword2026")
                    .await
                    .unwrap();
                assert!(!owner_enrollment_pending_on_connection(&mut connection)
                    .await
                    .unwrap());
                assert!(
                    authenticate_on_connection(&mut connection, "admin", "New!OwnerPassword2026",)
                        .await
                        .unwrap()
                        .success
                );
            }
            let branch_b_hash: String =
                sqlx::query_scalar("SELECT password_hash FROM users WHERE id = 'existing-owner-b'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(
                branch_b_hash, another_hash,
                "unrelated owner's hash must be preserved"
            );
            let branch_b_name: String =
                sqlx::query_scalar("SELECT full_name FROM users WHERE id = 'existing-owner-b'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(branch_b_name, "Branch B Owner");

            // Restarting the same isolated state cannot overwrite a changed
            // password, re-seed credentials or re-run the forward-only cleanup.
            prepare_connection(&mut connection).await.unwrap();
            migrator_032.run(&mut connection).await.unwrap();
            let restarted_hash: Option<String> =
                sqlx::query_scalar("SELECT password_hash FROM users WHERE id = 'admin'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert!(restarted_hash.is_some());
            assert!(
                enroll_owner_on_connection(&mut connection, "Replay!OwnerPassword2026")
                    .await
                    .is_err()
            );
            let after_replay: Option<String> =
                sqlx::query_scalar("SELECT password_hash FROM users WHERE id = 'admin'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(after_replay, restarted_hash);
            let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(integrity, "ok");
        }
    }

    #[tokio::test]
    async fn native_001_to_032_empty_users_recovery_creates_only_unconfigured_owner() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(1)
            .run(&mut connection)
            .await
            .unwrap();
        // Synthetic recovery of an emptied 001 users table: no customer data.
        sqlx::query("DELETE FROM users")
            .execute(&mut connection)
            .await
            .unwrap();
        prepare_connection(&mut connection).await.unwrap();
        let owner: (String, String, Option<String>) =
            sqlx::query_as("SELECT username, role, password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(owner, ("admin".into(), "owner".into(), None));
        actual_native_startup_migrator(37)
            .run(&mut connection)
            .await
            .unwrap();
        assert!(
            crate::commands::auth::owner_enrollment_pending_on_connection(&mut connection,)
                .await
                .unwrap()
        );
        let denied =
            crate::commands::auth::authenticate_on_connection(&mut connection, "admin", "admin")
                .await
                .unwrap();
        assert!(!denied.success);
        prepare_connection(&mut connection).await.unwrap();
        actual_native_startup_migrator(37)
            .run(&mut connection)
            .await
            .unwrap();
        let owner_after: Option<String> =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert!(
            owner_after.is_none(),
            "restart must not re-seed the public password"
        );
    }

    #[tokio::test]
    async fn native_upgrade_rejects_unknown_migration_001_checksum_without_mutating_owner() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(1)
            .run(&mut connection)
            .await
            .unwrap();
        let original: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00000000' WHERE version = 1")
            .execute(&mut connection)
            .await
            .unwrap();
        // Pre-migrator native compatibility must not silently accept an
        // unknown original migration signature and rewrite customer state.
        assert!(prepare_connection(&mut connection).await.is_err());
        let still_original: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(still_original, original);
        assert!(actual_native_startup_migrator(37)
            .run(&mut connection)
            .await
            .is_err());
        let ledger_032: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 32")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(ledger_032, 0);
    }

    #[tokio::test]
    async fn adds_missing_trial_balance_metadata_without_rewriting_custom_settings() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE trial_balance_settings (
              id INTEGER PRIMARY KEY, category TEXT NOT NULL,
              target_type TEXT, account_id INTEGER
            );
            INSERT INTO trial_balance_settings(id, category, target_type, account_id)
            VALUES (17, 'bank:legacy', 'bank', 44);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        ensure_trial_balance_metadata_columns(&mut transaction)
            .await
            .unwrap();
        ensure_trial_balance_metadata_columns(&mut transaction)
            .await
            .unwrap();
        assert!(
            has_column(&mut transaction, "trial_balance_settings", "target_id")
                .await
                .unwrap()
        );
        assert!(
            has_column(&mut transaction, "trial_balance_settings", "target_name")
                .await
                .unwrap()
        );
        let (id, category, target_type, account_id, target_id, target_name):
            (i64, String, String, i64, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT id, category, target_type, account_id, target_id, target_name FROM trial_balance_settings"
            ).fetch_one(&mut *transaction).await.unwrap();
        assert_eq!(
            (id, category.as_str(), target_type.as_str(), account_id),
            (17, "bank:legacy", "bank", 44)
        );
        assert_eq!(target_id, None);
        assert_eq!(target_name, None);
        transaction.commit().await.unwrap();
    }

    async fn application_schema_objects(
        connection: &mut SqliteConnection,
    ) -> Vec<(String, String)> {
        sqlx::query_as::<_, (String, String)>(
            r#"
            SELECT type, name
            FROM sqlite_master
            WHERE type IN ('table', 'index', 'trigger')
              AND name NOT LIKE 'sqlite_%'
              AND name != '_sqlx_migrations'
              AND name != 'catalog_csv_reference'
            ORDER BY type, name
            "#,
        )
        .fetch_all(connection)
        .await
        .unwrap()
    }

    async fn application_schema_signature(connection: &mut SqliteConnection) -> Vec<String> {
        let tables: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
              AND name != '_sqlx_migrations'
              AND name != 'catalog_csv_reference'
            ORDER BY name
            "#,
        )
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        let mut signature = Vec::new();
        for table in tables {
            let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_all(&mut *connection)
                .await
                .unwrap();
            for row in columns {
                signature.push(format!(
                    "column|{table}|{}|{}|{}|{}|{}",
                    row.get::<String, _>("name"),
                    row.get::<String, _>("type"),
                    row.get::<i64, _>("notnull"),
                    row.get::<Option<String>, _>("dflt_value")
                        .unwrap_or_default(),
                    row.get::<i64, _>("pk")
                ));
            }

            let foreign_keys = sqlx::query(&format!("PRAGMA foreign_key_list({table})"))
                .fetch_all(&mut *connection)
                .await
                .unwrap();
            for row in foreign_keys {
                signature.push(format!(
                    "fk|{table}|{}|{}|{}|{}|{}|{}|{}",
                    row.get::<i64, _>("id"),
                    row.get::<i64, _>("seq"),
                    row.get::<String, _>("table"),
                    row.get::<String, _>("from"),
                    row.get::<Option<String>, _>("to").unwrap_or_default(),
                    row.get::<String, _>("on_update"),
                    row.get::<String, _>("on_delete")
                ));
            }

            let indexes = sqlx::query(&format!("PRAGMA index_list({table})"))
                .fetch_all(&mut *connection)
                .await
                .unwrap();
            for row in indexes {
                let index_name = row.get::<String, _>("name");
                signature.push(format!(
                    "index|{table}|{index_name}|{}|{}|{}",
                    row.get::<i64, _>("unique"),
                    row.get::<String, _>("origin"),
                    row.get::<i64, _>("partial")
                ));
                let index_columns = sqlx::query(&format!("PRAGMA index_info({index_name})"))
                    .fetch_all(&mut *connection)
                    .await
                    .unwrap();
                for index_row in index_columns {
                    signature.push(format!(
                        "index-column|{table}|{index_name}|{}|{}|{}",
                        index_row.get::<i64, _>("seqno"),
                        index_row.get::<i64, _>("cid"),
                        index_row
                            .get::<Option<String>, _>("name")
                            .unwrap_or_default()
                    ));
                }
            }
        }

        let triggers: Vec<(String, String)> = sqlx::query_as(
            r#"
            SELECT name, COALESCE(sql, '')
            FROM sqlite_master
            WHERE type = 'trigger'
            ORDER BY name
            "#,
        )
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        signature.extend(triggers.into_iter().map(|(name, sql)| {
            format!(
                "trigger|{name}|{}",
                sql.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        }));
        signature.sort();
        signature
    }

    async fn assert_current_migration_ledger(connection: &mut SqliteConnection) {
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
        )
        .fetch_all(connection)
        .await
        .unwrap();
        assert_eq!(versions, (1_i64..=31_i64).collect::<Vec<_>>());
    }

    async fn assert_relationship_lookup_indexes(connection: &mut SqliteConnection) {
        for (table, index_name, expected_column) in [
            (
                "journal_entries",
                "idx_journal_entries_account",
                "account_id",
            ),
            (
                "journal_entries",
                "idx_journal_entries_journal",
                "journal_id",
            ),
            (
                "purchase_invoice_items",
                "idx_purchase_invoice_items_invoice",
                "invoice_id",
            ),
            (
                "purchase_invoice_items",
                "idx_purchase_invoice_items_drug",
                "drug_id",
            ),
            ("return_items", "idx_return_items_return", "return_id"),
            ("returns", "idx_returns_invoice_id", "invoice_id"),
        ] {
            let index_rows = sqlx::query(&format!("PRAGMA index_list({table})"))
                .fetch_all(&mut *connection)
                .await
                .unwrap();
            assert!(
                index_rows
                    .iter()
                    .any(|row| row.get::<String, _>("name") == index_name),
                "missing expected relationship index {index_name} on {table}"
            );

            let columns = sqlx::query(&format!("PRAGMA index_info({index_name})"))
                .fetch_all(&mut *connection)
                .await
                .unwrap();
            assert_eq!(
                columns.len(),
                1,
                "{index_name} should contain one key column"
            );
            assert_eq!(
                columns[0].get::<Option<String>, _>("name").as_deref(),
                Some(expected_column),
                "{index_name} points at the wrong key"
            );
        }
    }

    async fn assert_trial_balance_category_unique_index(connection: &mut SqliteConnection) {
        let indexes = sqlx::query("PRAGMA index_list(trial_balance_settings)")
            .fetch_all(&mut *connection)
            .await
            .unwrap();
        let index = indexes
            .iter()
            .find(|row| {
                row.get::<String, _>("name") == "idx_trial_balance_settings_category_unique"
            })
            .expect("missing trial balance category unique index");
        assert_eq!(index.get::<i64, _>("unique"), 1);
        let columns = sqlx::query("PRAGMA index_info(idx_trial_balance_settings_category_unique)")
            .fetch_all(&mut *connection)
            .await
            .unwrap();
        assert_eq!(
            columns[0].get::<Option<String>, _>("name").as_deref(),
            Some("category")
        );
    }

    async fn assert_catalog_delete_tombstone(connection: &mut SqliteConnection, id: i64) {
        sqlx::query("INSERT INTO master_drugs(id, trade_name) VALUES (?, ?)")
            .bind(id)
            .bind(format!("Schema parity sentinel {id}"))
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO drug_catalog_links(catalog_drug_id, master_drug_id, linked_by) VALUES (?, ?, 'schema-test')",
        )
        .bind(id)
        .bind(id)
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query("DELETE FROM master_drugs WHERE id = ?")
            .bind(id)
            .execute(&mut *connection)
            .await
            .unwrap();
        let reason: String = sqlx::query_scalar(
            "SELECT reason FROM drug_catalog_suppressions WHERE catalog_drug_id = ?",
        )
        .bind(id)
        .fetch_one(connection)
        .await
        .unwrap();
        assert_eq!(reason, "deleted_locally");
    }

    #[tokio::test]
    async fn surfaces_only_pre_patient_accounting_wallet_risk_without_mutating_balances() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE _sqlx_migrations (
              version BIGINT PRIMARY KEY,
              description TEXT NOT NULL,
              installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN NOT NULL,
              checksum BLOB NOT NULL,
              execution_time BIGINT NOT NULL
            );
            INSERT INTO _sqlx_migrations
              (version, description, installed_on, success, checksum, execution_time)
            VALUES (8, 'patient_accounting', '2026-02-01 00:00:00', 1, X'00', 0);
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT, wallet_balance REAL DEFAULT 0);
            CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT);
            CREATE TABLE returns (
              id TEXT PRIMARY KEY, invoice_id TEXT, total_refund REAL,
              refund_method TEXT, status TEXT, created_at TEXT
            );
            CREATE TABLE activity_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO patients VALUES
              ('legacy-patient', 'Legacy Patient', 40),
              ('post-fix-patient', 'Post Fix Patient', 20);
            INSERT INTO sales_invoices VALUES
              ('legacy-sale', 'legacy-patient'),
              ('post-fix-sale', 'post-fix-patient');
            INSERT INTO returns VALUES
              ('legacy-return', 'legacy-sale', 40, 'patient_account', 'approved', '2026-01-15 00:00:00'),
              ('post-fix-return', 'post-fix-sale', 20, 'patient_account', 'approved', '2026-03-01 00:00:00');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            surface_legacy_patient_wallet_review(&mut transaction)
                .await
                .unwrap(),
            1
        );
        transaction.commit().await.unwrap();

        let balances: Vec<(String, f64)> =
            sqlx::query_as("SELECT id, CAST(wallet_balance AS REAL) FROM patients ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            balances,
            vec![
                ("legacy-patient".into(), 40.0),
                ("post-fix-patient".into(), 20.0)
            ]
        );
        let status: String = sqlx::query_scalar(
            "SELECT value FROM config WHERE key = 'legacy_patient_wallet_review_status'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert!(status.contains("Legacy Patient"));
        assert!(status.contains("40.00"));
        assert!(!status.contains("Post Fix Patient"));
        let audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM activity_log WHERE action = 'LEGACY_PATIENT_WALLET_REVIEW_REQUIRED'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(audit_count, 1);

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            surface_legacy_patient_wallet_review(&mut transaction)
                .await
                .unwrap(),
            1
        );
        transaction.commit().await.unwrap();
        let audit_count_after_repeat: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM activity_log WHERE action = 'LEGACY_PATIENT_WALLET_REVIEW_REQUIRED'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(audit_count_after_repeat, 1);
    }

    #[tokio::test]
    async fn reads_checkpointed_read_only_resource_without_creating_sidecars() {
        let directory =
            std::env::temp_dir().join(format!("pharma-resource-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("catalog space # % ' عربي.db");
        let mut seed = connect(&path).await.unwrap();
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&mut seed)
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE catalog_csv_reference(trade_name TEXT); INSERT INTO catalog_csv_reference VALUES ('ANDODERMA');")
            .execute(&mut seed).await.unwrap();
        let mut live = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        assert!(attach_catalog_reference(&mut live, &path)
            .await
            .unwrap_err()
            .contains("uncheckpointed WAL"));
        seed.close().await.unwrap();
        let original = std::fs::read(&path).unwrap();
        let original_permissions = std::fs::metadata(&path).unwrap().permissions();
        let mut read_only = original_permissions.clone();
        read_only.set_readonly(true);
        std::fs::set_permissions(&path, read_only).unwrap();
        let result = attach_catalog_reference(&mut live, &path).await;
        // Restore permissions before asserting, so a failing test leaves no locked fixture.
        std::fs::set_permissions(&path, original_permissions).unwrap();
        result.unwrap();
        let name: String =
            sqlx::query_scalar("SELECT trade_name FROM bundled_catalog.catalog_csv_reference")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(name, "ANDODERMA");
        assert!(
            sqlx::query("DELETE FROM bundled_catalog.catalog_csv_reference")
                .execute(&mut live)
                .await
                .is_err()
        );
        live.close().await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            1,
            "No WAL/SHM should be created beside an installed resource"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn repairs_only_known_legacy_checksums() {
        let repair = &CHECKSUM_REPAIRS[0];
        assert_eq!(checksum_requires_repair(repair, repair.legacy[0]), Ok(true));
        assert_eq!(
            checksum_requires_repair(repair, &current_checksum(repair)),
            Ok(false)
        );
        assert!(checksum_requires_repair(repair, "UNKNOWN").is_err());
    }

    #[tokio::test]
    async fn repairs_sync_metadata_line_ending_checksum_before_pending_migrations() {
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let path = std::env::temp_dir().join(format!(
            "pharma-sync-metadata-checksum-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(&source, &path).unwrap();

        let mut connection = connect(&path).await.unwrap();
        prepare_connection(&mut connection).await.unwrap();

        const SYNC_METADATA_LF: &str = "AC4D263917A382C814AD54B4018090D5B867C42B949BAB27F208A1675F92DDB2B7DBA20363793E32F541509388D6A5F6";
        const SYNC_METADATA_CRLF: &str = "78EAF1F3C3BC3CDCD5372F9B58CB7804E244B8F6383681759F6B4CED58C04A187D24571C10D0A02DD748E5DFFF771426";
        let current = embedded_migration_checksum_hex(
            3,
            "sync_metadata",
            include_str!("../migrations/003_sync_metadata.sql"),
        );
        let historical = if current == SYNC_METADATA_LF {
            SYNC_METADATA_CRLF
        } else {
            SYNC_METADATA_LF
        };
        sqlx::query(&format!(
            "INSERT OR REPLACE INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (3, 'sync_metadata', 1, X'{historical}', 0)"
        ))
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        let checksum: String = sqlx::query_scalar(
            "SELECT hex(checksum) FROM _sqlx_migrations WHERE version = 3 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(checksum, current);

        connection.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn repairs_released_legacy_eol_checksums_before_pending_migrations() {
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let path = std::env::temp_dir().join(format!(
            "pharma-legacy-eol-checksums-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(&source, &path).unwrap();

        let mut connection = connect(&path).await.unwrap();
        prepare_connection(&mut connection).await.unwrap();

        for (version, description, historical) in [
            (
                6_i64,
                "accounting_upgrade_seed",
                "748A5081D73A5527CDBAACA558C0B515DBFD139826506E94FD8BB7E6700428B2AB07C05A01E7CD6DBBE689F970D37E1E",
            ),
            (
                8_i64,
                "patient_accounting",
                "8076D5E5B907A5E692896235AECDCCDD8068F023820E275B6FC2F334FD7850B29E7A8BB5A7A37601E5CC3EE2BA083DB8",
            ),
            (
                9_i64,
                "rebuild_master_drugs_fts",
                "E1B2CCE223C6F5E2DB22E1044647D5AA2E756285B8624E6C30A1518014224EBB196B6ECA4FDFE25FB124BEAFCB621949",
            ),
            (
                13_i64,
                "shift_handover_details",
                "8BB1234322CB986511F074EDB35A3F8EF37F4A1CC52784C20183047C7EAF27982EAD59A1C1717F606026F67E3A6BC78F",
            ),
            (
                14_i64,
                "inventory_performance",
                "078311A26AB6AB59D7C81B074B6EDF92739A83B5D7E6F6254FD4251B9BAFCBBB1754E0F3A8F6E409CC47C2FC62A91265",
            ),
        ] {
            sqlx::query(&format!(
                "INSERT OR REPLACE INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, X'{historical}', 0)"
            ))
            .bind(version)
            .bind(description)
            .execute(&mut connection)
            .await
            .unwrap();
        }

        prepare_connection(&mut connection).await.unwrap();

        for (version, description, sql) in [
            (
                6_i64,
                "accounting_upgrade_seed",
                include_str!("../migrations/006_accounting_upgrade_seed.sql"),
            ),
            (
                8_i64,
                "patient_accounting",
                include_str!("../migrations/008_patient_accounting.sql"),
            ),
            (
                9_i64,
                "rebuild_master_drugs_fts",
                include_str!("../migrations/009_rebuild_master_drugs_fts.sql"),
            ),
            (
                13_i64,
                "shift_handover_details",
                include_str!("../migrations/013_shift_handover_details.sql"),
            ),
            (
                14_i64,
                "inventory_performance",
                include_str!("../migrations/014_inventory_performance.sql"),
            ),
        ] {
            let expected = embedded_migration_checksum_hex(version, description, sql);
            let actual: String = sqlx::query_scalar(
                "SELECT hex(checksum) FROM _sqlx_migrations WHERE version = ? AND success = 1",
            )
            .bind(version)
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(
                actual, expected,
                "migration {version} checksum was not normalized"
            );
        }

        connection.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn repairs_only_unambiguous_historical_shift_links() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE shifts (
              id TEXT PRIMARY KEY, user_id TEXT, start_time TEXT, end_time TEXT
            );
            CREATE TABLE sales_invoices (
              id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, status TEXT, created_at TEXT
            );
            CREATE TABLE returns (
              id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, status TEXT, created_at TEXT
            );
            INSERT INTO shifts VALUES
              ('shift-one', 'user-one', '2026-08-14 10:00:00', '2026-08-14 12:00:00'),
              ('shift-overlap', 'user-one', '2026-08-14 11:00:00', '2026-08-14 13:00:00'),
              ('shift-two', 'user-two', '2026-08-14 10:00:00', '2026-08-14 12:00:00');
            INSERT INTO sales_invoices VALUES
              ('unique-sale', 'user-one', NULL, 'completed', '2026-08-14 10:30:00'),
              ('ambiguous-sale', 'user-one', NULL, 'completed', '2026-08-14 11:30:00'),
              ('outside-sale', 'user-one', NULL, 'completed', '2026-08-14 09:30:00'),
              ('draft-sale', 'user-one', NULL, 'draft', '2026-08-14 10:30:00'),
              ('other-user-sale', 'user-two', NULL, 'delivered', '2026-08-14 10:30:00'),
              ('existing-sale', 'user-one', 'manual-shift', 'completed', '2026-08-14 10:30:00');
            INSERT INTO returns VALUES
              ('unique-return', 'user-two', NULL, 'approved', '2026-08-14 10:45:00'),
              ('pending-return', 'user-two', NULL, 'pending', '2026-08-14 10:45:00');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            repair_unambiguous_shift_links(&mut transaction)
                .await
                .unwrap(),
            3
        );
        transaction.commit().await.unwrap();

        let links: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, shift_id FROM sales_invoices ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            links,
            vec![
                ("ambiguous-sale".into(), None),
                ("draft-sale".into(), None),
                ("existing-sale".into(), Some("manual-shift".into())),
                ("other-user-sale".into(), Some("shift-two".into())),
                ("outside-sale".into(), None),
                ("unique-sale".into(), Some("shift-one".into())),
            ]
        );
        let return_links: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, shift_id FROM returns ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            return_links,
            vec![
                ("pending-return".into(), None),
                ("unique-return".into(), Some("shift-two".into())),
            ]
        );

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            repair_unambiguous_shift_links(&mut transaction)
                .await
                .unwrap(),
            0
        );
        transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn never_assigns_legacy_staff_while_historical_owner_is_unresolved() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, pharmacy_id TEXT);
            INSERT INTO users VALUES
              ('owner-one', 'owner', 'ph-1'),
              ('legacy-staff', 'pharmacist', NULL),
              ('legacy-cashier', 'cashier', ''),
              ('legacy-owner', 'owner', NULL);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            repair_unambiguous_user_pharmacy(&mut transaction)
                .await
                .unwrap(),
            0
        );
        transaction.commit().await.unwrap();

        let repaired: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, pharmacy_id FROM users ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            repaired,
            vec![
                ("legacy-cashier".into(), Some("".into())),
                ("legacy-owner".into(), None),
                ("legacy-staff".into(), None),
                ("owner-one".into(), Some("ph-1".into())),
            ]
        );

        sqlx::raw_sql(
            r#"
            INSERT INTO users VALUES ('owner-two', 'owner', 'ph-2');
            INSERT INTO users VALUES ('ambiguous-staff', 'pharmacist', NULL);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            repair_unambiguous_user_pharmacy(&mut transaction)
                .await
                .unwrap(),
            0
        );
        transaction.commit().await.unwrap();
        let ambiguous: Option<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id = 'ambiguous-staff'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(ambiguous, None);
    }

    #[tokio::test]
    async fn finance_scope_snapshot_survives_legacy_staff_repair_and_staff_move() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, pharmacy_id TEXT);
            INSERT INTO users VALUES
              ('known', 'known', 'admin', 'ph-1'),
              ('legacy', 'legacy', 'pharmacist', NULL);

            CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, user_id TEXT, pharmacy_id TEXT);
            INSERT INTO sales_invoices VALUES ('sale-known', 'known', NULL), ('sale-legacy', 'legacy', NULL);

            CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT);
            INSERT INTO returns VALUES ('return-known', 'sale-known', 'known', NULL), ('return-legacy', 'sale-legacy', 'legacy', NULL);

            CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, start_time TEXT, end_time TEXT);
            INSERT INTO shifts VALUES ('shift-known', 'known', 'closed', '2026-01-01', '2026-01-01'), ('shift-legacy', 'legacy', 'closed', '2026-01-01', '2026-01-01');

            CREATE TABLE cash_movements (id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, date TEXT);
            INSERT INTO cash_movements VALUES ('cash-known', 'known', 'shift-known', '2026-01-01'), ('cash-legacy', 'legacy', 'shift-legacy', '2026-01-01');

            CREATE TABLE daily_journals (id TEXT PRIMARY KEY, created_by TEXT, date TEXT, total_amount REAL);
            INSERT INTO daily_journals VALUES ('journal-known', 'known', '2026-01-01', 10), ('journal-legacy', 'legacy', '2026-01-01', 20);

            CREATE TABLE expenses (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, amount REAL);
            INSERT INTO expenses VALUES ('expense-known', 'known', '2026-01-01', 30), ('expense-legacy', 'legacy', '2026-01-01', 40);

            CREATE TABLE financial_notices (id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);
            INSERT INTO financial_notices VALUES ('notice-known', 'known', '2026-01-01'), ('notice-legacy', 'legacy', '2026-01-01');

            CREATE TABLE activity_log (id INTEGER PRIMARY KEY, user_id TEXT, action TEXT, created_at TEXT);
            INSERT INTO activity_log VALUES (1, 'known', 'KNOWN', '2026-01-01'), (2, 'legacy', 'LEGACY', '2026-01-01');

            CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, created_at TEXT);
            INSERT INTO purchase_orders VALUES ('po-known', 'known', 'pending', '2026-01-01'), ('po-legacy', 'legacy', 'pending', '2026-01-01');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        snapshot_branch_local_pharmacy_scope(&mut transaction)
            .await
            .unwrap();
        assert_eq!(
            repair_unambiguous_user_pharmacy(&mut transaction)
                .await
                .unwrap(),
            1
        );
        transaction.commit().await.unwrap();

        for table in [
            "sales_invoices",
            "returns",
            "shifts",
            "cash_movements",
            "daily_journals",
            "expenses",
            "financial_notices",
            "purchase_orders",
        ] {
            let rows: Vec<String> =
                sqlx::query_scalar(&format!("SELECT pharmacy_id FROM {table} ORDER BY id"))
                    .fetch_all(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(
                rows,
                vec!["ph-1".to_string(), "local_default".to_string()],
                "{table}"
            );
        }
        let activity_rows: Vec<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM activity_log ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            activity_rows,
            vec!["ph-1".to_string(), "local_default".to_string()]
        );

        sqlx::query("INSERT INTO daily_journals (id, created_by, date, total_amount) VALUES ('journal-after-snapshot', 'known', '2026-01-02', 77.5)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO expenses (id, user_id, date, amount) VALUES ('expense-after-snapshot', 'known', '2026-01-02', 12.25)")
            .execute(&mut connection)
            .await
            .unwrap();

        sqlx::query("UPDATE users SET pharmacy_id = 'ph-2' WHERE id = 'known'")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cash_movements (id, user_id, shift_id, date) VALUES ('cash-after-move', 'known', 'shift-known', '2026-01-02')")
            .execute(&mut connection)
            .await
            .unwrap();

        let historical: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM daily_journals WHERE id = 'journal-known'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(historical, "ph-1");
        let new_journal: (String, f64) = sqlx::query_as(
            "SELECT pharmacy_id, total_amount FROM daily_journals WHERE id = 'journal-after-snapshot'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(new_journal, ("ph-1".to_string(), 77.5));
        let new_expense: (String, f64) = sqlx::query_as(
            "SELECT pharmacy_id, amount FROM expenses WHERE id = 'expense-after-snapshot'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(new_expense, ("ph-1".to_string(), 12.25));
        let historical_activity: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM activity_log WHERE id = 1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(historical_activity, "ph-1");
        let historical_po: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM purchase_orders WHERE id = 'po-known'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(historical_po, "ph-1");
        let shifted_cash: String = sqlx::query_scalar(
            "SELECT pharmacy_id FROM cash_movements WHERE id = 'cash-after-move'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(shifted_cash, "ph-1");
    }

    #[tokio::test]
    async fn legacy_shift_scope_uses_unambiguous_historical_sale_after_preupgrade_staff_move() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, pharmacy_id TEXT);
            INSERT INTO users VALUES ('moved', 'moved', 'pharmacist', 'ph-B');

            CREATE TABLE shifts (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              status TEXT,
              start_time TEXT,
              end_time TEXT
            );
            INSERT INTO shifts VALUES ('old-shift', 'moved', 'closed', '2026-01-01 08:00:00', '2026-01-01 16:00:00');

            CREATE TABLE sales_invoices (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              pharmacy_id TEXT,
              shift_id TEXT,
              status TEXT,
              created_at TEXT
            );
            INSERT INTO sales_invoices VALUES (
              'old-sale', 'moved', 'ph-A', 'old-shift', 'completed', '2026-01-01 10:00:00'
            );

            CREATE TABLE cash_movements (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              shift_id TEXT,
              date TEXT
            );
            INSERT INTO cash_movements VALUES ('old-cash', 'moved', 'old-shift', '2026-01-01');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        snapshot_branch_local_pharmacy_scope(&mut transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let sale_scope: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices WHERE id = 'old-sale'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let shift_scope: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM shifts WHERE id = 'old-shift'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let cash_scope: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM cash_movements WHERE id = 'old-cash'")
                .fetch_one(&mut connection)
                .await
                .unwrap();

        assert_eq!(sale_scope, "ph-A");
        assert_eq!(shift_scope, "ph-A");
        assert_eq!(cash_scope, "ph-A");
    }

    #[tokio::test]
    async fn migration16_expense_keeps_exact_source_cash_pharmacy_after_preupgrade_staff_move() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, pharmacy_id TEXT);
            INSERT INTO users VALUES ('moved', 'moved', 'pharmacist', 'ph-B');

            CREATE TABLE shifts (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              status TEXT,
              start_time TEXT,
              end_time TEXT
            );
            INSERT INTO shifts VALUES ('old-shift', 'moved', 'closed', '2026-01-01 08:00:00', '2026-01-01 16:00:00');

            CREATE TABLE sales_invoices (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              pharmacy_id TEXT,
              shift_id TEXT,
              status TEXT,
              created_at TEXT
            );
            INSERT INTO sales_invoices VALUES (
              'old-sale', 'moved', 'ph-A', 'old-shift', 'completed', '2026-01-01 10:00:00'
            );

            CREATE TABLE cash_movements (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              shift_id TEXT,
              type TEXT,
              category TEXT,
              sub_category TEXT,
              amount REAL,
              source_type TEXT,
              target_name TEXT,
              notes TEXT,
              date TEXT,
              created_at TEXT
            );
            INSERT INTO cash_movements VALUES (
              'old-cash', 'moved', 'old-shift', 'disbursement', 'operating_expenses',
              'rent', 25, NULL, NULL, 'Historical rent', '2026-01-01', '2026-01-01 11:00:00'
            );

            CREATE TABLE expenses (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              category TEXT,
              amount REAL,
              description TEXT,
              date TEXT,
              created_at TEXT
            );
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        snapshot_branch_local_pharmacy_scope(&mut transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        sqlx::raw_sql(include_str!(
            "../migrations/016_financial_expense_wiring.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();

        let scopes: (String, String, String, String) = sqlx::query_as(
            r#"
            SELECT
              (SELECT pharmacy_id FROM sales_invoices WHERE id = 'old-sale'),
              (SELECT pharmacy_id FROM shifts WHERE id = 'old-shift'),
              (SELECT pharmacy_id FROM cash_movements WHERE id = 'old-cash'),
              (SELECT pharmacy_id FROM expenses WHERE id = 'cash-movement-old-cash')
            "#,
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            scopes,
            ("ph-A".into(), "ph-A".into(), "ph-A".into(), "ph-A".into())
        );
    }

    #[tokio::test]
    async fn legacy_name_repair_handles_duplicate_catalog_name_drift() {
        let seed_path =
            std::env::temp_dir().join(format!("pharma-catalog-seed-{}.db", uuid::Uuid::new_v4()));
        let live_path =
            std::env::temp_dir().join(format!("pharma-catalog-live-{}.db", uuid::Uuid::new_v4()));
        let mut seed = connect(&seed_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              large_to_medium INTEGER,
              barcode TEXT,
              notes TEXT
            );
            INSERT INTO master_drugs VALUES
              (417, 'AGIOLAX', NULL, 'ISPAGHULA', 'laxative', 'VIATRIS', 150, NULL, NULL, NULL),
              (429, 'AIG ESOMEPRAZOLE', NULL, 'ESOMEPRAZOLE', 'ppi', 'PLANET CURE', 296, NULL, NULL, NULL),
              (500, 'ORIGINAL CUSTOM', NULL, 'CUSTOM ACTIVE', 'custom', 'CUSTOM MAKER', 10, NULL, NULL, NULL),
              (501, 'ORIGINAL TWO', NULL, 'SECOND ACTIVE', 'second', 'SECOND MAKER', 20, NULL, NULL, NULL),
              (502, 'ORIGINAL THREE', NULL, 'THIRD ACTIVE', 'third', 'THIRD MAKER', 30, NULL, NULL, NULL),
              (600, 'ALPHA', NULL, 'ACTIVE A', 'category a', 'MAKER A', 40, NULL, NULL, NULL),
              (601, 'BETA', NULL, 'ACTIVE B', 'category b', 'MAKER B', 50, NULL, NULL, NULL),
              (602, 'GAMMA', NULL, 'ACTIVE C', 'category c', 'MAKER C', 60, NULL, NULL, NULL),
              (700, 'HIBIOTIC 1GM', NULL, 'AMOXICILLIN', 'penicillin', 'AMOUN', 173, NULL, NULL, NULL);
            CREATE INDEX idx_seed_master_drugs_trade_name ON master_drugs(trade_name COLLATE NOCASE);
            "#,
        )
        .execute(&mut seed)
        .await
        .unwrap();
        seed.close().await.unwrap();

        let mut live = connect(&live_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              large_to_medium INTEGER,
              barcode TEXT,
              notes TEXT
            );
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              quantity REAL,
              strips_per_box INTEGER
            );
            CREATE TABLE sales_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE refill_reminders (id TEXT PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE purchase_order_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE stock_adjustments (id INTEGER PRIMARY KEY, inventory_id TEXT);
            CREATE TABLE opening_balance_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE shortages (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE cloud_drug_mappings (
              cloud_id INTEGER PRIMARY KEY,
              local_drug_id INTEGER NOT NULL UNIQUE,
              last_cloud_name TEXT NOT NULL
            );
            CREATE TABLE drug_indications (
              drug_id INTEGER,
              indication_id INTEGER,
              PRIMARY KEY (drug_id, indication_id)
            );
            CREATE TABLE drug_alternatives (
              drug_id INTEGER,
              alternative_id INTEGER,
              PRIMARY KEY (drug_id, alternative_id)
            );
            CREATE VIRTUAL TABLE master_drugs_fts USING fts5(
              trade_name,
              trade_name_en,
              content='master_drugs',
              content_rowid='id'
            );
            CREATE TRIGGER master_drugs_au AFTER UPDATE ON master_drugs BEGIN
              INSERT INTO master_drugs_fts(master_drugs_fts, rowid, trade_name, trade_name_en)
              VALUES ('delete', OLD.id, OLD.trade_name, OLD.trade_name_en);
              INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en)
              VALUES (NEW.id, NEW.trade_name, NEW.trade_name_en);
            END;
            INSERT INTO master_drugs VALUES
              (417, 'AIG ESOMEPRAZOLE', 'AIG ESOMEPRAZOLE', 'ISPAGHULA', 'laxative', 'VIATRIS', 292, 1, 'USER-BARCODE-417', 'user note 417'),
              (429, 'AIG ESOMEPRAZOLE', 'AIG ESOMEPRAZOLE', 'ESOMEPRAZOLE', 'ppi', 'PLANET CURE', 292, 2, 'USER-BARCODE-429', 'user note 429'),
              (500, 'USER LABEL', 'USER LABEL EN', 'CUSTOM ACTIVE', 'custom', 'CUSTOM MAKER', 11, 3, 'CUSTOM-BARCODE', 'custom note'),
              (501, 'AIG ESOMEPRAZOLE', 'AIG ESOMEPRAZOLE', 'SECOND ACTIVE', 'second', 'USER MAKER', 21, 4, NULL, NULL),
              (502, 'AIG ESOMEPRAZOLE', 'Custom English Translation', 'THIRD ACTIVE', 'third', 'THIRD MAKER', 31, 5, NULL, NULL),
              (600, 'BETA', 'BETA', 'ACTIVE B', 'category b', 'MAKER B', 50, 6, 'USER-BARCODE-600', 'user note 600'),
              (601, 'GAMMA', 'GAMMA', 'ACTIVE C', 'category c', 'MAKER C', 60, 7, NULL, 'user note 601'),
              (602, 'GAMMA', 'GAMMA', 'ACTIVE C', 'category c', 'MAKER C', 61, 8, 'USER-BARCODE-602', 'user note 602'),
              (700, 'HIBIOTIC 1GM', NULL, 'SOFOSBUVIR', 'hepatitis', 'PHARCO', 900, NULL, 'HIB-BARCODE', 'user note hib');
            INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en)
            SELECT id, trade_name, trade_name_en FROM master_drugs;
            INSERT INTO inventory VALUES
              ('lot-417', 417, 0.5, 2),
              ('lot-600', 600, 1, 7),
              ('lot-601', 601, 2, 8),
              ('lot-unit', 500, 1, 1);
            INSERT INTO sales_items VALUES (1, 417, 'lot-417');
            INSERT INTO refill_reminders VALUES ('refill-1', 417);
            INSERT INTO return_items VALUES (1, 417, 'lot-417');
            INSERT INTO purchase_invoice_items VALUES (1, 417, 'lot-417');
            INSERT INTO purchase_order_items VALUES (1, 417);
            INSERT INTO purchase_return_items VALUES (1, 417, 'lot-417');
            INSERT INTO opening_balance_items VALUES (1, 417);
            INSERT INTO shortages VALUES (1, 417);
            INSERT INTO cloud_drug_mappings VALUES
              (417, 417, 'AIG ESOMEPRAZOLE'),
              (500, 500, 'USER LABEL'),
              (600, 600, 'BETA'),
              (601, 601, 'GAMMA');
            INSERT INTO drug_indications VALUES (417, 1), (429, 1);
            INSERT INTO drug_alternatives VALUES (417, 600), (429, 601);
            "#,
        )
        .execute(&mut live)
        .await
        .unwrap();

        let repaired = repair_legacy_catalog_name_drift_on_connection(&mut live, &seed_path)
            .await
            .unwrap();
        assert_eq!(repaired, 5);

        let repaired_row = sqlx::query(
            "SELECT trade_name, trade_name_en, active_ingredient, category, manufacturer, official_price, large_to_medium, barcode, notes FROM master_drugs WHERE id = 417",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(repaired_row.get::<String, _>("trade_name"), "AGIOLAX");
        assert_eq!(repaired_row.get::<Option<String>, _>("trade_name_en"), None);
        assert_eq!(
            repaired_row.get::<String, _>("active_ingredient"),
            "ISPAGHULA"
        );
        assert_eq!(repaired_row.get::<String, _>("category"), "laxative");
        assert_eq!(repaired_row.get::<String, _>("manufacturer"), "VIATRIS");
        assert_eq!(repaired_row.get::<f64, _>("official_price"), 150.0);
        assert_eq!(repaired_row.get::<i64, _>("large_to_medium"), 1);
        assert_eq!(repaired_row.get::<String, _>("barcode"), "USER-BARCODE-417");
        assert_eq!(repaired_row.get::<String, _>("notes"), "user note 417");

        let target_row = sqlx::query(
            "SELECT trade_name, active_ingredient, category, manufacturer, official_price, large_to_medium, barcode, notes FROM master_drugs WHERE id = 429",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(
            target_row.get::<String, _>("trade_name"),
            "AIG ESOMEPRAZOLE"
        );
        assert_eq!(
            target_row.get::<String, _>("active_ingredient"),
            "ESOMEPRAZOLE"
        );
        assert_eq!(target_row.get::<String, _>("category"), "ppi");
        assert_eq!(target_row.get::<String, _>("manufacturer"), "PLANET CURE");
        assert_eq!(target_row.get::<f64, _>("official_price"), 296.0);
        assert_eq!(target_row.get::<i64, _>("large_to_medium"), 2);
        assert_eq!(target_row.get::<String, _>("barcode"), "USER-BARCODE-429");
        assert_eq!(target_row.get::<String, _>("notes"), "user note 429");

        let custom_row: (String, f64, String, String) = sqlx::query_as(
            "SELECT trade_name, official_price, barcode, notes FROM master_drugs WHERE id = 500",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(
            custom_row,
            (
                "USER LABEL".into(),
                11.0,
                "CUSTOM-BARCODE".into(),
                "custom note".into()
            )
        );
        let remaining_mappings: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT cloud_id, local_drug_id FROM cloud_drug_mappings ORDER BY cloud_id",
        )
        .fetch_all(&mut live)
        .await
        .unwrap();
        assert_eq!(remaining_mappings, vec![(500, 500)]);

        // Verify metadata-by-name sync: HIBIOTIC 1GM had correct trade_name
        // but wrong metadata (SOFOSBUVIR/hepatitis/PHARCO/900 from CSV shift).
        // The sync should fix metadata from the seed while preserving user data.
        let hib_row = sqlx::query(
            "SELECT active_ingredient, category, manufacturer, official_price, barcode, notes FROM master_drugs WHERE id = 700",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(hib_row.get::<String, _>("active_ingredient"), "AMOXICILLIN");
        assert_eq!(hib_row.get::<String, _>("category"), "penicillin");
        assert_eq!(hib_row.get::<String, _>("manufacturer"), "AMOUN");
        assert_eq!(hib_row.get::<f64, _>("official_price"), 173.0);
        // User-owned fields preserved
        assert_eq!(hib_row.get::<String, _>("barcode"), "HIB-BARCODE");
        assert_eq!(hib_row.get::<String, _>("notes"), "user note hib");

        for (id, expected_name) in [
            (429, "AIG ESOMEPRAZOLE"),
            (500, "USER LABEL"),
            (501, "AIG ESOMEPRAZOLE"),
            (502, "AIG ESOMEPRAZOLE"),
            (600, "ALPHA"),
            (601, "BETA"),
            (602, "GAMMA"),
        ] {
            let actual: String =
                sqlx::query_scalar("SELECT trade_name FROM master_drugs WHERE id = ?")
                    .bind(id)
                    .fetch_one(&mut live)
                    .await
                    .unwrap();
            assert_eq!(actual, expected_name);
        }
        let inventory: (i64, f64) =
            sqlx::query_as("SELECT drug_id, quantity FROM inventory WHERE id = 'lot-417'")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(inventory, (429, 0.5));

        let repaired_unit_factor: i64 =
            sqlx::query_scalar("SELECT strips_per_box FROM inventory WHERE id = 'lot-unit'")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(repaired_unit_factor, 3);

        let chained_inventory: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id, drug_id FROM inventory WHERE id IN ('lot-600', 'lot-601') ORDER BY id",
        )
        .fetch_all(&mut live)
        .await
        .unwrap();
        assert_eq!(
            chained_inventory,
            vec![("lot-600".into(), 601), ("lot-601".into(), 602)]
        );

        // Barcode migration: source #600 had USER-BARCODE-600, target #601 had
        // no barcode. The barcode should follow the business refs to #601.
        let target_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM master_drugs WHERE id = 601")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(target_barcode.as_deref(), Some("USER-BARCODE-600"));

        let source_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM master_drugs WHERE id = 600")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(
            source_barcode, None,
            "barcode should be cleared from source after migration"
        );

        for table in [
            "sales_items",
            "refill_reminders",
            "return_items",
            "purchase_invoice_items",
            "purchase_order_items",
            "purchase_return_items",
            "opening_balance_items",
            "shortages",
        ] {
            let remapped: i64 = sqlx::query_scalar(&format!("SELECT drug_id FROM {table} LIMIT 1"))
                .fetch_one(&mut live)
                .await
                .unwrap();
            assert_eq!(remapped, 429, "{table} kept the drifted catalog ID");
        }

        let indication_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_indications WHERE drug_id = 429 AND indication_id = 1",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(indication_rows, 1);
        let alternative_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_alternatives WHERE drug_id = 429 AND alternative_id = 601",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(alternative_rows, 1);

        let display_name: String = sqlx::query_scalar(
            "SELECT COALESCE(NULLIF(TRIM(trade_name_en), ''), trade_name) FROM master_drugs WHERE id = 417",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(display_name, "AGIOLAX");
        let fts_matches: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM master_drugs_fts WHERE master_drugs_fts MATCH 'AGIOLAX' AND rowid = 417",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(fts_matches, 1);

        assert_eq!(
            repair_legacy_catalog_name_drift_on_connection(&mut live, &seed_path)
                .await
                .unwrap(),
            0
        );

        live.close().await.unwrap();
        std::fs::remove_file(seed_path).unwrap();
        std::fs::remove_file(live_path).unwrap();
    }

    #[tokio::test]
    async fn restores_csv_metadata_by_name_without_moving_barcodes_or_history() {
        let directory =
            std::env::temp_dir().join(format!("pharma-stable-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let seed_path = directory.join("seed.db");
        let live_path = directory.join("live.db");

        let mut seed = connect(&seed_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              barcode TEXT,
              notes TEXT
            );
            INSERT INTO master_drugs VALUES
              (201, 'ALPHA', NULL, 'ACTIVE A', 'CATEGORY A', 'MAKER A', 10, NULL, NULL),
              (202, 'BETA', NULL, 'ACTIVE B', 'CATEGORY B', 'MAKER B', 20, NULL, NULL),
              (203, 'GAMMA', NULL, 'ACTIVE C', 'CATEGORY C', 'MAKER C', 30, NULL, NULL);
            CREATE TABLE catalog_csv_reference AS SELECT trade_name, official_price, active_ingredient, category, manufacturer FROM master_drugs;
            INSERT INTO catalog_csv_reference VALUES ('AMBIGUOUS', 1, 'A', '', ''), ('AMBIGUOUS', 2, 'B', '', '');
            INSERT INTO master_drugs VALUES (101, 'UNRELATED SEED ID', NULL, 'WRONG', '', '', 999, NULL, NULL);
            "#,
        )
        .execute(&mut seed)
        .await
        .unwrap();
        seed.close().await.unwrap();

        let mut live = connect(&live_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              barcode TEXT,
              notes TEXT
            );
            CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, barcode TEXT, quantity REAL, local_selling_price REAL, cost_price REAL, strips_per_box REAL);
            CREATE TABLE sales_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE cloud_drug_mappings (
              cloud_id INTEGER PRIMARY KEY,
              local_drug_id INTEGER NOT NULL,
              last_cloud_name TEXT NOT NULL
            );

            -- Confirmed customer scenario: names/barcodes are correct, metadata
            -- is shifted, and the reference uses completely different IDs.
            INSERT INTO master_drugs VALUES
              (101, 'ALPHA', 'ALPHA', 'ACTIVE B', 'CATEGORY B', 'MAKER B', 20, 'BAR-ALPHA', 'alpha note'),
              (102, 'BETA', 'Local Beta translation', 'ACTIVE C', 'CATEGORY C', 'MAKER C', 30, 'BAR-BETA', 'beta note'),
              (103, 'GAMMA', 'GAMMA', 'ACTIVE A', 'CATEGORY A', 'MAKER A', 10, 'BAR-GAMMA', 'gamma note'),
              (900, 'LOCAL CUSTOM', 'Local custom', 'CUSTOM ACTIVE', 'CUSTOM CATEGORY', 'CUSTOM MAKER', 99, 'BAR-CUSTOM', 'custom note'),
              (901, 'AMBIGUOUS', NULL, 'KEEP', 'KEEP', 'KEEP', 5, 'BAR-AMBIGUOUS', 'keep'),
              (902, 'ALPHA', NULL, 'WRONG', 'WRONG', 'WRONG', 999, 'BAR-ALPHA-NEW', 'duplicate name, different id');
            INSERT INTO inventory VALUES
              ('lot-alpha', 101, 'BAR-ALPHA', 4, 20, 7, 2),
              ('lot-beta', 102, 'BAR-BETA', 3, 30, 18, 1),
              ('lot-gamma', 103, 'BAR-GAMMA', 2, 10, 25, 3);
            INSERT INTO sales_items VALUES (1, 101, 'lot-alpha'), (2, 102, 'lot-beta');
            INSERT INTO cloud_drug_mappings VALUES
              (101, 101, 'BETA'), (102, 102, 'GAMMA'), (103, 103, 'ALPHA');
            "#,
        )
        .execute(&mut live)
        .await
        .unwrap();

        // An unavailable backup location must prevent any catalog write.
        std::fs::write(directory.join("backups"), b"blocked directory").unwrap();
        assert!(repair_catalog_with_backup(&live_path, &seed_path)
            .await
            .is_err());
        let marker_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM config WHERE key = 'catalog_reference_repair_version'",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(marker_count, 0);
        std::fs::remove_file(directory.join("backups")).unwrap();
        assert_eq!(
            repair_catalog_with_backup(&live_path, &seed_path)
                .await
                .unwrap(),
            7
        );
        let backups: Vec<_> = std::fs::read_dir(directory.join("backups"))
            .unwrap()
            .collect();
        assert_eq!(backups.len(), 1);
        let backup_path = backups[0].as_ref().unwrap().path().join("pharma_local.db");
        let mut before = connect(&backup_path).await.unwrap();
        let old_name: String =
            sqlx::query_scalar("SELECT trade_name FROM master_drugs WHERE id = 101")
                .fetch_one(&mut before)
                .await
                .unwrap();
        assert_eq!(old_name, "ALPHA");
        let old_ingredient: String =
            sqlx::query_scalar("SELECT active_ingredient FROM master_drugs WHERE id = 101")
                .fetch_one(&mut before)
                .await
                .unwrap();
        assert_eq!(old_ingredient, "ACTIVE B");
        let before_quantity: f64 = sqlx::query_scalar("SELECT SUM(quantity) FROM inventory")
            .fetch_one(&mut before)
            .await
            .unwrap();
        assert_eq!(before_quantity, 9.0);
        let backup_price: f64 =
            sqlx::query_scalar("SELECT local_selling_price FROM inventory WHERE id='lot-alpha'")
                .fetch_one(&mut before)
                .await
                .unwrap();
        assert_eq!(backup_price, 20.0);
        before.close().await.unwrap();

        #[allow(clippy::type_complexity)]
        let restored: Vec<(i64, String, Option<String>, String, String, String, f64, String, String)> =
            sqlx::query_as(
                "SELECT id, trade_name, trade_name_en, active_ingredient, category, manufacturer, official_price, barcode, notes FROM master_drugs WHERE id BETWEEN 101 AND 103 ORDER BY id",
            )
            .fetch_all(&mut live)
            .await
            .unwrap();
        assert_eq!(
            restored,
            vec![
                (
                    101,
                    "ALPHA".into(),
                    Some("ALPHA".into()),
                    "ACTIVE A".into(),
                    "CATEGORY A".into(),
                    "MAKER A".into(),
                    10.0,
                    "BAR-ALPHA".into(),
                    "alpha note".into()
                ),
                (
                    102,
                    "BETA".into(),
                    Some("Local Beta translation".into()),
                    "ACTIVE B".into(),
                    "CATEGORY B".into(),
                    "MAKER B".into(),
                    20.0,
                    "BAR-BETA".into(),
                    "beta note".into()
                ),
                (
                    103,
                    "GAMMA".into(),
                    Some("GAMMA".into()),
                    "ACTIVE C".into(),
                    "CATEGORY C".into(),
                    "MAKER C".into(),
                    30.0,
                    "BAR-GAMMA".into(),
                    "gamma note".into()
                ),
            ]
        );

        let inventory: Vec<(String, i64, String, f64)> =
            sqlx::query_as("SELECT id, drug_id, barcode, quantity FROM inventory ORDER BY id")
                .fetch_all(&mut live)
                .await
                .unwrap();
        assert_eq!(
            inventory,
            vec![
                ("lot-alpha".into(), 101, "BAR-ALPHA".into(), 4.0),
                ("lot-beta".into(), 102, "BAR-BETA".into(), 3.0),
                ("lot-gamma".into(), 103, "BAR-GAMMA".into(), 2.0),
            ]
        );
        let sale_drug_ids: Vec<i64> =
            sqlx::query_scalar("SELECT drug_id FROM sales_items ORDER BY id")
                .fetch_all(&mut live)
                .await
                .unwrap();
        assert_eq!(sale_drug_ids, vec![101, 102]);
        let custom: (String, String, String) =
            sqlx::query_as("SELECT trade_name, barcode, notes FROM master_drugs WHERE id = 900")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(
            custom,
            (
                "LOCAL CUSTOM".into(),
                "BAR-CUSTOM".into(),
                "custom note".into()
            )
        );
        let mappings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cloud_drug_mappings")
            .fetch_one(&mut live)
            .await
            .unwrap();
        assert_eq!(mappings, 0);
        let lot_prices: Vec<(f64, f64, f64)> = sqlx::query_as(
            "SELECT local_selling_price, cost_price, strips_per_box FROM inventory ORDER BY id",
        )
        .fetch_all(&mut live)
        .await
        .unwrap();
        assert_eq!(
            lot_prices,
            vec![(10.0, 7.0, 2.0), (20.0, 18.0, 1.0), (30.0, 25.0, 3.0)]
        );
        let note: String =
            sqlx::query_scalar("SELECT value FROM config WHERE key='catalog_csv_repair_status'")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert!(note.contains("4 سجل دواء و3 سعر مخزون"));
        let ambiguous: (String, f64) = sqlx::query_as(
            "SELECT active_ingredient, official_price FROM master_drugs WHERE id=901",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(ambiguous, ("KEEP".into(), 5.0));
        let duplicate: (String, String, f64) = sqlx::query_as(
            "SELECT barcode, active_ingredient, official_price FROM master_drugs WHERE id=902",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(duplicate, ("BAR-ALPHA-NEW".into(), "ACTIVE A".into(), 10.0));

        // The repair runs once per reference version, so a later intentional
        // local edit is not silently overwritten on every application start.
        sqlx::query("UPDATE master_drugs SET official_price = 12 WHERE id = 101")
            .execute(&mut live)
            .await
            .unwrap();
        sqlx::query("UPDATE inventory SET local_selling_price=13 WHERE id='lot-alpha'")
            .execute(&mut live)
            .await
            .unwrap();
        assert_eq!(
            repair_catalog_with_backup(&live_path, &seed_path)
                .await
                .unwrap(),
            0
        );
        let local_price: f64 =
            sqlx::query_scalar("SELECT official_price FROM master_drugs WHERE id = 101")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(local_price, 12.0);
        let lot_price: f64 =
            sqlx::query_scalar("SELECT local_selling_price FROM inventory WHERE id='lot-alpha'")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(lot_price, 13.0);
        assert_eq!(
            std::fs::read_dir(directory.join("backups"))
                .unwrap()
                .count(),
            1
        );
        // Upgrade from a metadata-only repair: it must still back up and apply
        // the newly approved selling-price correction, then stop on later starts.
        sqlx::query("DELETE FROM config WHERE key='catalog_inventory_price_repair_version'")
            .execute(&mut live)
            .await
            .unwrap();
        sqlx::query("UPDATE master_drugs SET official_price=10 WHERE id=101")
            .execute(&mut live)
            .await
            .unwrap();
        assert_eq!(
            repair_catalog_with_backup(&live_path, &seed_path)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            std::fs::read_dir(directory.join("backups"))
                .unwrap()
                .count(),
            2
        );
        assert_eq!(
            repair_catalog_with_backup(&live_path, &seed_path)
                .await
                .unwrap(),
            0
        );
        sqlx::query("DELETE FROM config WHERE key='catalog_name_metadata_repair_version'")
            .execute(&mut live)
            .await
            .unwrap();
        sqlx::query("UPDATE config SET value='csv-catalog-reference-v1' WHERE key='catalog_reference_repair_version'")
            .execute(&mut live).await.unwrap();
        assert!(repair_catalog_with_backup(&live_path, &seed_path)
            .await
            .unwrap_err()
            .contains("pre-repair backup"));

        live.close().await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn upgrades_v014_schema_and_normalizes_its_checksum() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT NOT NULL);
            CREATE TABLE shortages (
              id INTEGER PRIMARY KEY,
              drug_id INTEGER NOT NULL,
              pharmacy_id TEXT,
              requested_quantity REAL,
              status TEXT
            );
            INSERT INTO shortages (id, drug_id, pharmacy_id, requested_quantity, status)
            VALUES (1, 1, NULL, 1, 'pending'), (2, 2, '', 1, 'ordered');
            CREATE TABLE suppliers (id INTEGER PRIMARY KEY);
            CREATE TABLE users (id TEXT PRIMARY KEY);
            CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
            CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY);
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              pharmacy_id TEXT,
              quantity REAL,
              expiry_date TEXT,
              batch_number TEXT
            );
            CREATE TABLE purchase_invoices (
              id TEXT PRIMARY KEY,
              pharmacy_id TEXT,
              invoice_number TEXT,
              status TEXT,
              created_at DATETIME
            );
            CREATE TABLE purchase_invoice_items (
              id INTEGER PRIMARY KEY,
              invoice_id TEXT,
              drug_id INTEGER,
              quantity REAL,
              bonus_quantity REAL,
              expiry_date TEXT
            );
            CREATE TABLE purchase_orders (
              id TEXT PRIMARY KEY,
              supplier_id INTEGER,
              status TEXT,
              total_amount REAL,
              created_at DATETIME
            );
            INSERT INTO purchase_orders (id, supplier_id, status, total_amount, created_at)
            VALUES ('legacy-po', 1, 'pending', 25, '2026-01-01');
            CREATE TABLE purchase_order_items (
              id INTEGER PRIMARY KEY,
              order_id TEXT,
              drug_id INTEGER,
              quantity INTEGER,
              cost_price REAL
            );
            INSERT INTO purchase_order_items (id, order_id, drug_id, quantity, cost_price)
            VALUES (1, 'legacy-po', 1, 5, 5);
            CREATE TABLE activity_log (id INTEGER PRIMARY KEY, action TEXT, created_at DATETIME);
            CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT);
            CREATE TABLE units (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE item_natures (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE adjustment_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT);
            CREATE TABLE accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              code TEXT NOT NULL UNIQUE,
              name_ar TEXT NOT NULL,
              name_en TEXT,
              type TEXT NOT NULL,
              is_group INTEGER DEFAULT 0
            );
            CREATE TABLE trial_balance_settings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL UNIQUE,
              target_type TEXT NOT NULL,
              account_id INTEGER
            );
            INSERT INTO accounts (code, name_ar, name_en, type, is_group)
            VALUES ('9.9', 'Legacy account', 'Legacy account', 'asset', 0);
            INSERT INTO trial_balance_settings (category, target_type, account_id)
            SELECT 'legacy_setting', 'account', id FROM accounts WHERE code = '9.9';
            CREATE TABLE _sqlx_migrations (
              version BIGINT PRIMARY KEY,
              description TEXT NOT NULL,
              installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN NOT NULL,
              checksum BLOB NOT NULL,
              execution_time BIGINT NOT NULL
            );
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (1, 'initial_schema', 1, X'F82014A0B12E5F2148E15B27514F88C074C127EA08140C38889D59CAC54695EF9BA4194FC77168A621732F9627A20AA2', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (2, 'performance_tuning', 1, X'EB5B98F60883978153907406799C9010EE82FD3B6233E54E3EF0ABE66C182CC4B967378D5C2F431F4180AE8544F7B049', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (3, 'sync_metadata', 1, X'78EAF1F3C3BC3CDCD5372F9B58CB7804E244B8F6383681759F6B4CED58C04A187D24571C10D0A02DD748E5DFFF771426', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (4, 'return_items_patch', 1, X'DC6E060272C078A60806DDBE5DBCC30F42837A45725E0A02163D72863B6F5523E2A51618D4215AEE0E3721748C90125D', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (5, 'purchase_return_details', 1, X'5EDF8FB853589FF8E8C5DE39B9A3432B940C4DB1BC1F0A43438C2B14D376DB187063BDE0F6C55E34C4C2EE261AA3F5A7', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (6, 'accounting_upgrade_seed', 1, X'748A5081D73A5527CDBAACA558C0B515DBFD139826506E94FD8BB7E6700428B2AB07C05A01E7CD6DBBE689F970D37E1E', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (7, 'purchase_inventory_links', 1, X'48DF50E8B76D93E61F77DEB39E7498CFA1D34B6A7AB76DC1E773320F1B1D448C43B191746F5958858AD1C6F75C6E6013', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (8, 'patient_accounting', 1, X'8076D5E5B907A5E692896235AECDCCDD8068F023820E275B6FC2F334FD7850B29E7A8BB5A7A37601E5CC3EE2BA083DB8', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (9, 'rebuild_master_drugs_fts', 1, X'E1B2CCE223C6F5E2DB22E1044647D5AA2E756285B8624E6C30A1518014224EBB196B6ECA4FDFE25FB124BEAFCB621949', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (12, 'shortages_pharmacy_scope', 1, X'390BDCB64ED1FBE1C12E844281BB50251DED58D07B2B1AFB54F80BCE2B179E6C8E1026153452274980FC2271C2B6C1C6', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (13, 'shift_handover_details', 1, X'8BB1234322CB986511F074EDB35A3F8EF37F4A1CC52784C20183047C7EAF27982EAD59A1C1717F606026F67E3A6BC78F', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (14, 'inventory_performance', 1, X'078311A26AB6AB59D7C81B074B6EDF92739A83B5D7E6F6254FD4251B9BAFCBBB1754E0F3A8F6E409CC47C2FC62A91265', 0);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        let default_reasons: Vec<String> = sqlx::query_scalar(
            "SELECT COALESCE(NULLIF(name_ar, ''), reason) FROM adjustment_reasons ORDER BY id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            default_reasons,
            vec![
                "جرد وتصحيح رصيد".to_string(),
                "تلف أو كسر".to_string(),
                "منتهي الصلاحية".to_string(),
                "خطأ إدخال".to_string(),
            ]
        );
        sqlx::query("DELETE FROM adjustment_reasons")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO adjustment_reasons (reason) VALUES ('سبب مخصص')")
            .execute(&mut connection)
            .await
            .unwrap();

        let shortage_scopes: Vec<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM shortages ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            shortage_scopes,
            vec!["local_default".to_string(), "local_default".to_string()]
        );

        for repair in CHECKSUM_REPAIRS {
            let checksum: String =
                sqlx::query_scalar("SELECT hex(checksum) FROM _sqlx_migrations WHERE version = ?")
                    .bind(repair.version)
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(checksum, current_checksum(repair));
        }

        let mut transaction = connection.begin().await.unwrap();
        ensure_compatibility(&mut transaction).await.unwrap();
        transaction.commit().await.unwrap();
        let preserved_reasons: Vec<String> = sqlx::query_scalar(
            "SELECT COALESCE(NULLIF(name_ar, ''), reason) FROM adjustment_reasons ORDER BY id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(preserved_reasons, vec!["سبب مخصص".to_string()]);

        for (table, column) in [
            ("master_drugs", "base_price"),
            ("master_drugs", "indications"),
            ("return_items", "sale_item_id"),
            ("purchase_invoice_items", "barcode"),
            ("purchase_returns", "purchase_invoice_id"),
            ("patients", "opening_balance"),
            ("patients", "wallet_balance"),
            ("patients", "points_balance"),
            ("financial_notices", "target_type"),
            ("financial_notices", "target_id"),
            ("cash_movements", "source_type"),
            ("cash_movements", "target_name"),
            ("activity_log", "user_id"),
            ("activity_log", "pharmacy_id"),
            ("activity_log", "details"),
            ("purchase_orders", "user_id"),
            ("purchase_orders", "pharmacy_id"),
            ("purchase_orders", "supplier_name"),
            ("purchase_orders", "notes"),
            ("purchase_orders", "updated_at"),
            ("purchase_order_items", "po_id"),
            ("purchase_order_items", "expected_price"),
            ("purchase_order_items", "received_quantity"),
            ("shortages", "pharmacy_id"),
            ("shortages", "priority"),
            ("shortages", "notes"),
            ("shortages", "requested_quantity"),
            ("shortages", "status"),
            ("shortages", "created_at"),
        ] {
            let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(rows.get::<String, _>("name"), "id");
            let mut transaction = connection.begin().await.unwrap();
            assert!(has_column(&mut transaction, table, column).await.unwrap());
            transaction.commit().await.unwrap();
        }

        let legacy_po_item: (String, f64, i64) = sqlx::query_as(
            "SELECT po_id, expected_price, received_quantity FROM purchase_order_items WHERE id = 1",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(legacy_po_item, ("legacy-po".into(), 5.0, 0));

        for (category, code) in [
            ("bank_clearing", "1.1.4"),
            ("patient_wallet_liability", "2.2"),
            ("customer_adjustments", "4.2"),
            ("opening_balance_equity", "3.9"),
        ] {
            let mapped_code: String = sqlx::query_scalar(
                "SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = ?",
            )
            .bind(category)
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(mapped_code, code);
        }

        for table in [
            "refill_reminders",
            "patient_allergies",
            "patient_conditions",
            "patient_transactions",
            "financial_notices",
            "cash_movements",
        ] {
            assert!(
                table_exists(&mut connection, table).await.unwrap(),
                "{table}"
            );
        }

        sqlx::query(
            "INSERT INTO patients (id, full_name) VALUES ('legacy-patient', 'Legacy Patient')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let patient_balances = sqlx::query(
            "SELECT opening_balance, wallet_balance, points_balance FROM patients WHERE id = 'legacy-patient'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(patient_balances.get::<f64, _>("opening_balance"), 0.0);
        assert_eq!(patient_balances.get::<f64, _>("wallet_balance"), 0.0);
        assert_eq!(patient_balances.get::<f64, _>("points_balance"), 0.0);

        // A later startup with already-normalized checksums must still repair schema drift.
        sqlx::query("ALTER TABLE master_drugs DROP COLUMN side_effects")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("DELETE FROM trial_balance_settings WHERE category = 'bank_clearing'")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("DELETE FROM accounts WHERE code = '1.1.4'")
            .execute(&mut connection)
            .await
            .unwrap();
        prepare_connection(&mut connection).await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        assert!(has_column(&mut transaction, "master_drugs", "side_effects")
            .await
            .unwrap());
        transaction.commit().await.unwrap();
        let bank_mapping_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = 'bank_clearing' AND a.code = '1.1.4'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(bank_mapping_count, 1);
    }

    async fn representative_purchase_database(v239: bool) -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY);
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT NOT NULL,
              large_to_medium INTEGER,
              medium_to_small INTEGER
            );
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              pharmacy_id TEXT,
              quantity INTEGER DEFAULT 0,
              local_selling_price REAL,
              cost_price REAL DEFAULT 0,
              expiry_date TEXT,
              barcode TEXT,
              batch_number TEXT,
              min_stock_level INTEGER DEFAULT 10,
              supplier TEXT,
              unit_price REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              strips_per_box INTEGER DEFAULT 1,
              FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
            );
            CREATE TABLE suppliers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name_ar TEXT NOT NULL,
              balance REAL DEFAULT 0
            );
            CREATE TABLE purchase_invoices (
              id TEXT PRIMARY KEY,
              supplier_id INTEGER NOT NULL,
              pharmacy_id TEXT,
              user_id TEXT,
              invoice_number TEXT,
              invoice_date TEXT,
              total_amount REAL DEFAULT 0,
              paid_amount REAL DEFAULT 0,
              payment_method TEXT DEFAULT 'credit',
              status TEXT DEFAULT 'pending',
              notes TEXT,
              check_number TEXT,
              expenses REAL DEFAULT 0,
              discount_value REAL DEFAULT 0,
              discount_percent REAL DEFAULT 0,
              tax_percent REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
              FOREIGN KEY (user_id) REFERENCES users (id)
            );
            CREATE TABLE supplier_transactions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              supplier_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              amount REAL NOT NULL,
              reference_id TEXT,
              notes TEXT,
              FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
            );
            CREATE TABLE accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              code TEXT NOT NULL UNIQUE,
              name_ar TEXT NOT NULL,
              name_en TEXT,
              type TEXT NOT NULL,
              is_group INTEGER DEFAULT 0
            );
            CREATE TABLE trial_balance_settings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL,
              target_type TEXT,
              account_id INTEGER,
              FOREIGN KEY (account_id) REFERENCES accounts (id)
            );
            CREATE TABLE daily_journals (
              id TEXT PRIMARY KEY,
              date TEXT NOT NULL,
              description TEXT,
              created_by TEXT,
              total_amount REAL NOT NULL,
              FOREIGN KEY (created_by) REFERENCES users (id)
            );
            CREATE TABLE journal_entries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              journal_id TEXT NOT NULL,
              account_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              amount REAL NOT NULL,
              FOREIGN KEY (journal_id) REFERENCES daily_journals (id),
              FOREIGN KEY (account_id) REFERENCES accounts (id)
            );
            CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
            CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY);
            CREATE TABLE activity_log (id INTEGER PRIMARY KEY, action TEXT, created_at DATETIME);
            CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT);
            CREATE TABLE units (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE item_natures (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE _sqlx_migrations (
              version BIGINT PRIMARY KEY,
              description TEXT NOT NULL,
              installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN NOT NULL,
              checksum BLOB NOT NULL,
              execution_time BIGINT NOT NULL
            );
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        if v239 {
            sqlx::raw_sql(
                r#"
                CREATE TABLE purchase_invoice_items (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  invoice_id TEXT NOT NULL,
                  drug_id INTEGER NOT NULL,
                  quantity INTEGER NOT NULL,
                  unit_id INTEGER,
                  expiry_date TEXT,
                  cost_price REAL NOT NULL,
                  selling_price REAL,
                  bonus_quantity INTEGER DEFAULT 0,
                  tax_percent REAL DEFAULT 0,
                  discount_percent REAL DEFAULT 0,
                  strips_per_box INTEGER DEFAULT 1,
                  inventory_id TEXT,
                  FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id),
                  FOREIGN KEY (drug_id) REFERENCES master_drugs (id),
                  FOREIGN KEY (inventory_id) REFERENCES inventory (id) ON DELETE SET NULL
                );
                CREATE TABLE purchase_returns (
                  id TEXT PRIMARY KEY,
                  supplier_id INTEGER NOT NULL,
                  user_id TEXT NOT NULL,
                  purchase_invoice_id TEXT,
                  reason TEXT,
                  total_amount REAL,
                  refund_method TEXT DEFAULT 'credit',
                  status TEXT DEFAULT 'completed',
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
                );
                CREATE TABLE purchase_return_items (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  purchase_return_id TEXT NOT NULL,
                  inventory_id TEXT,
                  drug_id INTEGER,
                  drug_name TEXT,
                  quantity_returned INTEGER,
                  unit_price REAL,
                  total_price REAL,
                  reason TEXT,
                  purchase_invoice_item_id INTEGER,
                  unit TEXT DEFAULT 'large',
                  FOREIGN KEY (purchase_return_id) REFERENCES purchase_returns (id)
                );
                INSERT INTO accounts (id, code, name_ar, name_en, type, is_group) VALUES
                  (6, '1.1.1', 'Cash', 'Cash Drawer', 'asset', 0),
                  (7, '2.1', 'Payable', 'Accounts Payable', 'liability', 0),
                  (8, '1.1.2', 'Receivable', 'Accounts Receivable', 'asset', 0),
                  (9, '3.1', 'Sales', 'Sales Revenue', 'revenue', 0),
                  (10, '1.1.3', 'Inventory', 'Inventory Asset', 'asset', 0),
                  (11, '4.1', 'COGS', 'Cost of Goods Sold', 'expense', 0);
                INSERT INTO trial_balance_settings (category, target_type, account_id) VALUES
                  ('cash_drawer', 'account', 6),
                  ('accounts_receivable', 'account', 8),
                  ('sales_revenue', 'account', 9),
                  ('inventory_asset', 'account', 10),
                  ('cogs_expense', 'account', 11);
                INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES
                  (1, 'initial_schema', 1, X'BEC57847DA8403B63C28258329D6F9EEEB7FC894B1496393DCBB6527AAB25D7045EFE661B6BE6473B68C6A579C49A153', 0),
                  (2, 'performance_tuning', 1, X'1D375CF6D1CC6170CA5EC70CE930AD0F9F4D6E0355E5A7ED2637E683D5721A96D62D53C37E573E260B617513DF883375', 0),
                  (3, 'sync_metadata', 1, X'AC4D263917A382C814AD54B4018090D5B867C42B949BAB27F208A1675F92DDB2B7DBA20363793E32F541509388D6A5F6', 0),
                  (4, 'return_items_patch', 1, X'CF8CB76E3264BA762F3CC260B56FB253BEF65AD4C7B80D6E7DA2F950AB9AD5A88CB0DB45072EF2ECE5E3C553AD00D85F', 0),
                  (5, 'purchase_return_details', 1, X'06CDB339DAF88B9A19B495D4F48AEB5450A3AEA9EE02BB36E69C6C4ABE3F7FA6BA4C0657841FEE7F0102ABFCC2115DC7', 0),
                  (6, 'accounting_upgrade_seed', 1, X'8C1DEC5BFB088CCB52A98D085D81F34EFC948B37B2E6DE2946F067BAEA8D07F419C8E064553B850E9417EF03312E7D7A', 0),
                  (7, 'purchase_inventory_links', 1, X'ADD70A4E03CA17C0E204F600C91803410D880921B6C6A2504D39309E684CA58B2B7B2CA683BDF3E1EB7ABA6EE96C64AE', 0),
                  (8, 'patient_accounting', 1, X'09BB9D9AFA5BE22F074E9073ECEBA993227E4FE23CC90FEAB5F442B4A4FCD772456F4202856F49E6F653E4BFA8439D65', 0);
                "#,
            )
            .execute(&mut connection)
            .await
            .unwrap();
        } else {
            sqlx::raw_sql(
                r#"
                CREATE TABLE purchase_invoice_items (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  invoice_id TEXT NOT NULL,
                  drug_id INTEGER NOT NULL,
                  quantity INTEGER NOT NULL,
                  unit_id INTEGER,
                  expiry_date TEXT,
                  cost_price REAL NOT NULL,
                  selling_price REAL,
                  bonus_quantity INTEGER DEFAULT 0,
                  tax_percent REAL DEFAULT 0,
                  discount_percent REAL DEFAULT 0,
                  FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id),
                  FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
                );
                INSERT INTO accounts (id, code, name_ar, name_en, type, is_group)
                VALUES (6, '9.9', 'Legacy account', 'Legacy account', 'asset', 0);
                INSERT INTO trial_balance_settings (category, target_type, account_id)
                VALUES ('cash_drawer', 'account', 6);
                INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                VALUES (1, 'initial_schema', 1, X'78532E45F393BD746018E6EC48E3DD3D661145347E5A0716C28424B1347B2F3BD98F4C7B70C9562950286660AFA22B6C', 0);
                "#,
            )
            .execute(&mut connection)
            .await
            .unwrap();
        }

        sqlx::raw_sql(
            r#"
            INSERT INTO users (id) VALUES ('legacy-purchase-user');
            INSERT INTO suppliers (id, name_ar, balance) VALUES (70, 'Legacy Supplier', 0);
            INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small) VALUES
              (9100, 'Exact legacy lot', 10, 1),
              (9101, 'Unique fallback lot', 10, 1),
              (9102, 'Ambiguous legacy lot', 10, 1);
            INSERT INTO inventory
              (id, drug_id, pharmacy_id, quantity, expiry_date, batch_number)
            VALUES
              ('legacy-exact', 9100, 'local_default', 6, '2028-12-31', 'LEGACY-EXACT'),
              ('legacy-fallback', 9101, NULL, 8, '2028-12-31', 'OLD-BATCH'),
              ('legacy-ambiguous-a', 9102, 'local_default', 6, '2028-12-31', 'OLD-A'),
              ('legacy-ambiguous-b', 9102, 'local_default', 6, '2028-12-31', 'OLD-B');
            INSERT INTO purchase_invoices
              (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date,
               payment_method, status)
            VALUES
              ('legacy-exact-invoice', 70, NULL, 'legacy-purchase-user', 'LEGACY-EXACT', '2026-01-01', 'credit', 'completed'),
              ('legacy-fallback-invoice', 70, 'local_default', 'legacy-purchase-user', 'NEW-BATCH', '2026-01-01', 'credit', 'completed'),
              ('legacy-ambiguous-invoice', 70, 'local_default', 'legacy-purchase-user', 'NEW-AMBIGUOUS', '2026-01-01', 'credit', 'completed');
            INSERT INTO purchase_invoice_items
              (invoice_id, drug_id, quantity, expiry_date, cost_price, bonus_quantity)
            VALUES
              ('legacy-exact-invoice', 9100, 6, '31/12/2028', 10, 0),
              ('legacy-fallback-invoice', 9101, 6, '31/12/2028', 10, 0),
              ('legacy-ambiguous-invoice', 9102, 6, '31/12/2028', 10, 0);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn compatibility_normalizes_legacy_expiry_dates_before_renderer_startup() {
        let mut connection = representative_purchase_database(false).await;
        sqlx::query("UPDATE inventory SET expiry_date = '31/12/2028' WHERE id = 'legacy-exact'")
            .execute(&mut connection)
            .await
            .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        let inventory_expiry: String =
            sqlx::query_scalar("SELECT expiry_date FROM inventory WHERE id = 'legacy-exact'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(inventory_expiry, "2028-12-31");
        let purchase_expiries: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT expiry_date FROM purchase_invoice_items ORDER BY expiry_date",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(purchase_expiries, vec!["2028-12-31".to_string()]);
    }

    #[tokio::test]
    async fn snapshot_backfill_rejects_barcode_sized_conversion_outliers() {
        let mut connection = representative_purchase_database(true).await;
        sqlx::raw_sql(
            r#"
            CREATE TABLE sales_items (
              id INTEGER PRIMARY KEY,
              invoice_id TEXT,
              inventory_id TEXT,
              drug_id INTEGER,
              quantity_sold REAL,
              unit_price REAL,
              unit TEXT,
              cost_price REAL
            );
            UPDATE inventory
            SET strips_per_box = 6224010000000
            WHERE id = 'legacy-exact';
            UPDATE purchase_invoice_items
            SET strips_per_box = 6224010000000
            WHERE invoice_id = 'legacy-exact-invoice';
            INSERT INTO sales_items
              (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price)
            VALUES
              (1, 'legacy-exact-invoice', 'legacy-exact', 9100, 1, 10, 'large', 10),
              (2, 'legacy-fallback-invoice', 'legacy-fallback', 9101, 1, 10, 'large', 10);
            UPDATE master_drugs SET large_to_medium = 6223000000000 WHERE id = 9101;
            UPDATE inventory SET strips_per_box = 6223000000000 WHERE id = 'legacy-fallback';
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT strips_per_box FROM inventory WHERE id = 'legacy-exact'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            10
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT strips_per_box FROM purchase_invoice_items WHERE invoice_id = 'legacy-exact-invoice'")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            10
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT large_to_medium FROM master_drugs WHERE id = 9101"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT strips_per_box FROM inventory WHERE id = 'legacy-fallback'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            1
        );

        let snapshots =
            sqlx::query("SELECT id, large_to_medium, medium_to_small FROM sales_items ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(snapshots[0].get::<i64, _>("large_to_medium"), 10);
        assert_eq!(snapshots[0].get::<i64, _>("medium_to_small"), 1);
        assert_eq!(snapshots[1].get::<i64, _>("large_to_medium"), 1);
        assert_eq!(snapshots[1].get::<i64, _>("medium_to_small"), 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            "ok"
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn upgraded_purchase_schemas_support_inventory_links_returns_and_accounting() {
        for (label, v239) in [("v0.2.14", false), ("v0.2.39", true)] {
            let mut connection = representative_purchase_database(v239).await;
            prepare_connection(&mut connection).await.unwrap();

            let linked_lots = sqlx::query(
                "SELECT invoice_id, inventory_id FROM purchase_invoice_items WHERE invoice_id LIKE 'legacy-%' ORDER BY invoice_id",
            )
            .fetch_all(&mut connection)
            .await
            .unwrap();
            let links: std::collections::HashMap<String, Option<String>> = linked_lots
                .into_iter()
                .map(|row| {
                    (
                        row.get::<String, _>("invoice_id"),
                        row.try_get::<Option<String>, _>("inventory_id").unwrap(),
                    )
                })
                .collect();
            assert_eq!(
                links["legacy-exact-invoice"].as_deref(),
                Some("legacy-exact")
            );
            assert_eq!(
                links["legacy-fallback-invoice"].as_deref(),
                Some("legacy-fallback")
            );
            assert_eq!(links["legacy-ambiguous-invoice"], None);

            let mut transaction = connection.begin().await.unwrap();
            for column in ["strips_per_box", "inventory_id", "barcode"] {
                assert!(
                    has_column(&mut transaction, "purchase_invoice_items", column)
                        .await
                        .unwrap(),
                    "{label} is missing purchase_invoice_items.{column}"
                );
            }
            assert!(
                has_column(&mut transaction, "purchase_invoices", "updated_at")
                    .await
                    .unwrap(),
                "{label} is missing purchase_invoices.updated_at"
            );
            transaction.commit().await.unwrap();

            for (category, code) in [
                ("cash_drawer", "1.1.1"),
                ("accounts_payable", "2.1"),
                ("accounts_receivable", "1.1.2"),
                ("sales_revenue", "3.1"),
                ("inventory_asset", "1.1.3"),
                ("cogs_expense", "4.1"),
            ] {
                let mapped_code: String = sqlx::query_scalar(
                    "SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = ? LIMIT 1",
                )
                .bind(category)
                .fetch_one(&mut connection)
                .await
                .unwrap();
                assert_eq!(mapped_code, code, "{label} has a bad {category} mapping");
            }

            let mut transaction = connection.begin().await.unwrap();
            sqlx::raw_sql(
                r#"
                INSERT INTO users (id) VALUES ('purchase-user');
                INSERT INTO suppliers (id, name_ar, balance) VALUES (77, 'Supplier', 0);
                INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small)
                VALUES (9001, 'Upgrade Drug', 10, 1);
                INSERT INTO inventory
                  (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price,
                   expiry_date, barcode, batch_number, strips_per_box)
                VALUES ('upgrade-lot', 9001, 'local_default', 6, 15, 10,
                        '2028-12-31', '6220000009001', 'UPGRADE-1', 10);
                INSERT INTO purchase_invoices
                  (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date,
                   total_amount, payment_method, status, tax_percent)
                VALUES ('upgrade-invoice', 77, 'local_default', 'purchase-user', 'UPGRADE-1',
                        '2026-08-12', 63, 'credit', 'completed', 5);
                INSERT INTO purchase_invoice_items
                  (invoice_id, drug_id, quantity, expiry_date, cost_price, selling_price,
                   tax_percent, strips_per_box, inventory_id, barcode)
                VALUES ('upgrade-invoice', 9001, 6, '2028-12-31', 10, 15,
                        5, 10, 'upgrade-lot', '6220000009001');
                INSERT INTO supplier_transactions
                  (supplier_id, type, amount, reference_id, notes)
                VALUES (77, 'invoice', 63, 'upgrade-invoice', 'Upgrade purchase');
                UPDATE suppliers SET balance = balance + 63 WHERE id = 77;
                INSERT INTO daily_journals
                  (id, date, description, created_by, total_amount)
                VALUES ('upgrade-journal', '2026-08-12', 'Purchase invoice UPGRADE-1',
                        'purchase-user', 63);
                "#,
            )
            .execute(&mut *transaction)
            .await
            .unwrap();
            let inventory_account: i64 = sqlx::query_scalar(
                "SELECT account_id FROM trial_balance_settings WHERE category = 'inventory_asset' LIMIT 1",
            )
            .fetch_one(&mut *transaction)
            .await
            .unwrap();
            let payable_account: i64 = sqlx::query_scalar(
                "SELECT account_id FROM trial_balance_settings WHERE category = 'accounts_payable' LIMIT 1",
            )
            .fetch_one(&mut *transaction)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('upgrade-journal', ?, 'debit', 63), ('upgrade-journal', ?, 'credit', 63)",
            )
            .bind(inventory_account)
            .bind(payable_account)
            .execute(&mut *transaction)
            .await
            .unwrap();
            sqlx::raw_sql(
                r#"
                INSERT INTO purchase_returns
                  (id, purchase_invoice_id, supplier_id, user_id, total_amount, refund_method, status)
                VALUES ('upgrade-return', 'upgrade-invoice', 77, 'purchase-user', 10.5, 'credit', 'completed');
                INSERT INTO purchase_return_items
                  (purchase_return_id, purchase_invoice_item_id, inventory_id, drug_id,
                   drug_name, quantity_returned, unit_price, total_price, unit)
                SELECT 'upgrade-return', id, 'upgrade-lot', 9001, 'Upgrade Drug', 1, 10.5, 10.5, 'large'
                FROM purchase_invoice_items WHERE invoice_id = 'upgrade-invoice';
                "#,
            )
            .execute(&mut *transaction)
            .await
            .unwrap();
            transaction.commit().await.unwrap();

            let linked: (String, String, String) = sqlx::query_as(
                "SELECT pii.inventory_id, pii.barcode, i.batch_number FROM purchase_invoice_items pii JOIN inventory i ON i.id = pii.inventory_id WHERE pii.invoice_id = 'upgrade-invoice'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(
                linked,
                (
                    "upgrade-lot".into(),
                    "6220000009001".into(),
                    "UPGRADE-1".into()
                )
            );
            let journal_entries: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM journal_entries WHERE journal_id = 'upgrade-journal'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(journal_entries, 2, "{label} purchase journal is incomplete");
            let fk_errors = sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&mut connection)
                .await
                .unwrap();
            assert!(fk_errors.is_empty(), "{label} has foreign-key errors");
        }
    }

    #[tokio::test]
    async fn repairs_untracked_seeded_database_but_leaves_blank_database_for_migrations() {
        let mut seeded = representative_purchase_database(false).await;
        sqlx::query("DROP TABLE _sqlx_migrations")
            .execute(&mut seeded)
            .await
            .unwrap();
        prepare_connection(&mut seeded).await.unwrap();

        let mut transaction = seeded.begin().await.unwrap();
        assert!(
            has_column(&mut transaction, "purchase_invoice_items", "barcode")
                .await
                .unwrap()
        );
        assert!(
            has_column(&mut transaction, "purchase_invoices", "updated_at")
                .await
                .unwrap()
        );
        transaction.commit().await.unwrap();
        let inventory_code: String = sqlx::query_scalar(
            "SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = 'inventory_asset' LIMIT 1",
        )
        .fetch_one(&mut seeded)
        .await
        .unwrap();
        assert_eq!(inventory_code, "1.1.3");

        let mut blank = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        prepare_connection(&mut blank).await.unwrap();
        assert!(!table_exists(&mut blank, "purchase_invoices").await.unwrap());
    }

    #[tokio::test]
    async fn prepared_bundled_seed_accepts_full_migration_chain_without_losing_seed_data() {
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let path = std::env::temp_dir().join(format!(
            "pharma-fresh-install-seed-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(&source, &path).unwrap();

        let mut connection = connect(&path).await.unwrap();
        let user_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let drug_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
            .fetch_one(&mut connection)
            .await
            .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        let sources = [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_performance.sql"),
            include_str!("../migrations/003_sync_metadata.sql"),
            include_str!("../migrations/004_return_items_patch.sql"),
            include_str!("../migrations/005_purchase_return_details.sql"),
            include_str!("../migrations/006_accounting_upgrade_seed.sql"),
            include_str!("../migrations/007_purchase_inventory_links.sql"),
            include_str!("../migrations/008_patient_accounting.sql"),
            include_str!("../migrations/009_rebuild_master_drugs_fts.sql"),
            include_str!("../migrations/010_shift_handover_indexes.sql"),
            include_str!("../migrations/011_shift_cash_difference_account.sql"),
            include_str!("../migrations/012_shortages_pharmacy_scope.sql"),
            include_str!("../migrations/013_shift_handover_details.sql"),
            include_str!("../migrations/014_inventory_performance.sql"),
            include_str!("../migrations/015_shared_open_shift.sql"),
            include_str!("../migrations/016_financial_expense_wiring.sql"),
            include_str!("../migrations/017_cloud_drug_identity.sql"),
            include_str!("../migrations/018_unit_conversion_snapshots.sql"),
            include_str!("../migrations/019_shift_pharmacy_scope.sql"),
            include_str!("../migrations/020_daily_snapshot_pharmacy_scope.sql"),
            include_str!("../migrations/021_returns_pharmacy_scope.sql"),
            include_str!("../migrations/022_finance_pharmacy_scope.sql"),
            include_str!("../migrations/023_shift_immutable_scope.sql"),
            include_str!("../migrations/024_commercial_papers_pharmacy_scope.sql"),
            include_str!("../migrations/025_sales_item_discount_snapshot.sql"),
            include_str!("../migrations/026_sales_loyalty_redemption_snapshot.sql"),
            include_str!("../migrations/027_drug_catalog_reconciliation.sql"),
            include_str!("../migrations/028_finance_definitions_pharmacy_scope.sql"),
            include_str!("../migrations/029_shift_treasury_retained_cash.sql"),
            include_str!("../migrations/030_relationship_lookup_indexes.sql"),
            include_str!("../migrations/031_trial_balance_unique_categories.sql"),
        ];
        let migrator = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                sources
                    .iter()
                    .enumerate()
                    .map(|(index, sql)| {
                        sqlx::migrate::Migration::new(
                            (index + 1) as i64,
                            format!("migration_{}", index + 1).into(),
                            sqlx::migrate::MigrationType::ReversibleUp,
                            (*sql).into(),
                            false,
                        )
                    })
                    .collect(),
            ),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        };
        migrator.run(&mut connection).await.unwrap();

        let user_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let drug_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(user_count_after, user_count_before);
        assert_eq!(drug_count_after, drug_count_before);

        let mut transaction = connection.begin().await.unwrap();
        for (table, column) in [
            ("users", "pharmacy_id"),
            ("shifts", "pharmacy_id"),
            ("returns", "pharmacy_id"),
            ("cash_movements", "pharmacy_id"),
            ("daily_journals", "pharmacy_id"),
            ("expenses", "pharmacy_id"),
            ("financial_notices", "pharmacy_id"),
            ("activity_log", "pharmacy_id"),
            ("purchase_orders", "pharmacy_id"),
            ("sales_items", "item_discount_percent"),
            ("sales_invoices", "points_redeemed"),
            ("sales_invoices", "loyalty_discount_amount"),
            ("banks", "pharmacy_id"),
            ("credit_cards", "pharmacy_id"),
            ("points_of_sale", "pharmacy_id"),
            ("shifts", "treasury_retained_cash"),
        ] {
            assert!(
                has_column(&mut transaction, table, column).await.unwrap(),
                "{table}.{column}"
            );
        }
        transaction.commit().await.unwrap();

        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");

        let migration_max: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(migration_max, 31);
        assert_current_migration_ledger(&mut connection).await;
        assert_relationship_lookup_indexes(&mut connection).await;
        assert_trial_balance_category_unique_index(&mut connection).await;
        let foreign_key_violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert!(foreign_key_violations.is_empty());

        // A first-run install starts from the bundled seed, while tests and some
        // recovery paths can start from a blank database. After the complete
        // migration chain both paths must expose the same application schema
        // objects; otherwise fresh installs can behave differently from updates.
        let mut blank_current = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        migrator.run(&mut blank_current).await.unwrap();
        prepare_connection(&mut blank_current).await.unwrap();
        assert_current_migration_ledger(&mut blank_current).await;
        assert_relationship_lookup_indexes(&mut blank_current).await;
        assert_trial_balance_category_unique_index(&mut blank_current).await;
        assert_eq!(
            application_schema_objects(&mut connection).await,
            application_schema_objects(&mut blank_current).await,
            "bundled-seed fresh install drifted from a blank current-schema install"
        );
        assert_eq!(
            application_schema_signature(&mut connection).await,
            application_schema_signature(&mut blank_current).await,
            "bundled-seed fresh install has structurally different columns/indexes/FKs/triggers"
        );

        prepare_connection(&mut connection).await.unwrap();
        let user_count_after_restart: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let drug_count_after_restart: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(user_count_after_restart, user_count_before);
        assert_eq!(drug_count_after_restart, drug_count_before);
        connection.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn migration_31_preserves_custom_settings_and_rejects_conflicting_categories() {
        let migrator = || sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(vec![sqlx::migrate::Migration::new(
                31,
                "trial_balance_unique_categories".into(),
                sqlx::migrate::MigrationType::ReversibleUp,
                include_str!("../migrations/031_trial_balance_unique_categories.sql").into(),
                false,
            )]),
            ignore_missing: true,
            locking: true,
            no_tx: false,
        };

        let mut connection = representative_purchase_database(true).await;
        prepare_connection(&mut connection).await.unwrap();
        sqlx::raw_sql(
            r#"
            INSERT INTO trial_balance_settings(category, target_type, target_id, target_name)
            VALUES
              ('bank:preserved', 'bank', 'bank-1', 'Primary bank'),
              ('bank:exact', 'bank', 'bank-2', 'Duplicate bank'),
              ('bank:exact', 'bank', 'bank-2', 'Duplicate bank');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        migrator().run(&mut connection).await.unwrap();
        assert_eq!(
            sqlx::query_as::<_, (String, String, String)>(
                "SELECT target_type, target_id, target_name FROM trial_balance_settings WHERE category = 'bank:preserved'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            ("bank".into(), "bank-1".into(), "Primary bank".into())
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM trial_balance_settings WHERE category = 'bank:exact'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            1
        );
        assert_trial_balance_category_unique_index(&mut connection).await;

        let mut conflicting = representative_purchase_database(true).await;
        prepare_connection(&mut conflicting).await.unwrap();
        sqlx::raw_sql(
            r#"
            INSERT INTO trial_balance_settings(category, target_type, target_id, target_name)
            VALUES
              ('bank:conflict', 'bank', 'bank-a', 'Bank A'),
              ('bank:conflict', 'bank', 'bank-b', 'Bank B');
            "#,
        )
        .execute(&mut conflicting)
        .await
        .unwrap();
        assert!(migrator().run(&mut conflicting).await.is_err());
        let conflict_rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT target_id, target_name FROM trial_balance_settings WHERE category = 'bank:conflict' ORDER BY target_id",
        )
        .fetch_all(&mut conflicting)
        .await
        .unwrap();
        assert_eq!(
            conflict_rows,
            vec![
                ("bank-a".into(), "Bank A".into()),
                ("bank-b".into(), "Bank B".into()),
            ]
        );
    }

    #[tokio::test]
    async fn preapplied_finance_scope_seed_records_migration_28_before_plugin_migrations() {
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let path = std::env::temp_dir().join(format!(
            "pharma-preapplied-finance-scope-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(&source, &path).unwrap();

        let mut connection = connect(&path).await.unwrap();
        prepare_connection(&mut connection).await.unwrap();

        let recorded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 28 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(recorded, 1);

        connection.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn preapplied_treasury_column_records_migration_29_before_plugin_migrations() {
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let path = std::env::temp_dir().join(format!(
            "pharma-preapplied-treasury-retained-cash-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(&source, &path).unwrap();

        let mut connection = connect(&path).await.unwrap();
        prepare_connection(&mut connection).await.unwrap();

        let column_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('shifts') WHERE name = 'treasury_retained_cash'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(column_count, 1);
        let recorded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 29 AND success = 1",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(recorded, 1);

        connection.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn pre015_upgrade_keeps_open_shifts_and_transactions_in_their_pharmacies() {
        let sources = [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_performance.sql"),
            include_str!("../migrations/003_sync_metadata.sql"),
            include_str!("../migrations/004_return_items_patch.sql"),
            include_str!("../migrations/005_purchase_return_details.sql"),
            include_str!("../migrations/006_accounting_upgrade_seed.sql"),
            include_str!("../migrations/007_purchase_inventory_links.sql"),
            include_str!("../migrations/008_patient_accounting.sql"),
            include_str!("../migrations/009_rebuild_master_drugs_fts.sql"),
            include_str!("../migrations/010_shift_handover_indexes.sql"),
            include_str!("../migrations/011_shift_cash_difference_account.sql"),
            include_str!("../migrations/012_shortages_pharmacy_scope.sql"),
            include_str!("../migrations/013_shift_handover_details.sql"),
            include_str!("../migrations/014_inventory_performance.sql"),
            include_str!("../migrations/015_shared_open_shift.sql"),
            include_str!("../migrations/016_financial_expense_wiring.sql"),
            include_str!("../migrations/017_cloud_drug_identity.sql"),
            include_str!("../migrations/018_unit_conversion_snapshots.sql"),
            include_str!("../migrations/019_shift_pharmacy_scope.sql"),
            include_str!("../migrations/020_daily_snapshot_pharmacy_scope.sql"),
            include_str!("../migrations/021_returns_pharmacy_scope.sql"),
            include_str!("../migrations/022_finance_pharmacy_scope.sql"),
            include_str!("../migrations/023_shift_immutable_scope.sql"),
            include_str!("../migrations/024_commercial_papers_pharmacy_scope.sql"),
            include_str!("../migrations/025_sales_item_discount_snapshot.sql"),
            include_str!("../migrations/026_sales_loyalty_redemption_snapshot.sql"),
            include_str!("../migrations/027_drug_catalog_reconciliation.sql"),
            include_str!("../migrations/028_finance_definitions_pharmacy_scope.sql"),
            include_str!("../migrations/029_shift_treasury_retained_cash.sql"),
            include_str!("../migrations/030_relationship_lookup_indexes.sql"),
            include_str!("../migrations/031_trial_balance_unique_categories.sql"),
        ];
        let migrator = |count: usize| sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                sources
                    .iter()
                    .take(count)
                    .enumerate()
                    .map(|(index, sql)| {
                        sqlx::migrate::Migration::new(
                            (index + 1) as i64,
                            format!("migration_{}", index + 1).into(),
                            sqlx::migrate::MigrationType::ReversibleUp,
                            (*sql).into(),
                            false,
                        )
                    })
                    .collect(),
            ),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        };

        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        migrator(14).run(&mut connection).await.unwrap();
        sqlx::raw_sql(
            r#"
            INSERT INTO users(id, username, role, pharmacy_id) VALUES
              ('a', 'a', 'cashier', 'A'),
              ('b', 'b', 'cashier', 'B');
            INSERT INTO shifts(id, user_id, start_time, starting_cash, status) VALUES
              ('a-open', 'a', '2026-08-01 08:00:00', 10, 'open'),
              ('b-open', 'b', '2026-08-01 09:00:00', 20, 'open');
            INSERT INTO sales_invoices(id, user_id, pharmacy_id, shift_id, total_amount, status) VALUES
              ('a-sale', 'a', 'A', 'a-open', 10, 'completed'),
              ('b-sale', 'b', 'B', 'b-open', 20, 'completed');
            INSERT INTO returns(id, invoice_id, user_id, shift_id, total_refund, status) VALUES
              ('b-return', 'b-sale', 'b', 'b-open', 2, 'approved');
            INSERT INTO cash_movements(id, user_id, shift_id, type, category, amount, date) VALUES
              ('b-movement', 'b', 'b-open', 'receipt', 'pharmacy', 3, '2026-08-01');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();
        let scoped_open_before: Vec<(String, String)> =
            sqlx::query_as("SELECT id, pharmacy_id FROM shifts WHERE status = 'open' ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            scoped_open_before,
            vec![("a-open".into(), "A".into()), ("b-open".into(), "B".into())]
        );

        migrator(31).run(&mut connection).await.unwrap();

        let open_after: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT id, pharmacy_id, starting_cash FROM shifts WHERE status = 'open' ORDER BY id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            open_after,
            vec![
                ("a-open".into(), "A".into(), 10.0),
                ("b-open".into(), "B".into(), 20.0),
            ]
        );
        let sale_shift: String =
            sqlx::query_scalar("SELECT shift_id FROM sales_invoices WHERE id = 'b-sale'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(sale_shift, "b-open");
        let return_shift: String =
            sqlx::query_scalar("SELECT shift_id FROM returns WHERE id = 'b-return'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(return_shift, "b-open");
        let movement_shift: String =
            sqlx::query_scalar("SELECT shift_id FROM cash_movements WHERE id = 'b-movement'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(movement_shift, "b-open");
    }

    #[tokio::test]
    async fn v091_upgrade_keeps_shift_scope_after_pending_migrations_and_restart() {
        let sources = [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_performance.sql"),
            include_str!("../migrations/003_sync_metadata.sql"),
            include_str!("../migrations/004_return_items_patch.sql"),
            include_str!("../migrations/005_purchase_return_details.sql"),
            include_str!("../migrations/006_accounting_upgrade_seed.sql"),
            include_str!("../migrations/007_purchase_inventory_links.sql"),
            include_str!("../migrations/008_patient_accounting.sql"),
            include_str!("../migrations/009_rebuild_master_drugs_fts.sql"),
            include_str!("../migrations/010_shift_handover_indexes.sql"),
            include_str!("../migrations/011_shift_cash_difference_account.sql"),
            include_str!("../migrations/012_shortages_pharmacy_scope.sql"),
            include_str!("../migrations/013_shift_handover_details.sql"),
            include_str!("../migrations/014_inventory_performance.sql"),
            include_str!("../migrations/015_shared_open_shift.sql"),
            include_str!("../migrations/016_financial_expense_wiring.sql"),
            include_str!("../migrations/017_cloud_drug_identity.sql"),
            include_str!("../migrations/018_unit_conversion_snapshots.sql"),
            include_str!("../migrations/019_shift_pharmacy_scope.sql"),
            include_str!("../migrations/020_daily_snapshot_pharmacy_scope.sql"),
            include_str!("../migrations/021_returns_pharmacy_scope.sql"),
            include_str!("../migrations/022_finance_pharmacy_scope.sql"),
            include_str!("../migrations/023_shift_immutable_scope.sql"),
            include_str!("../migrations/024_commercial_papers_pharmacy_scope.sql"),
            include_str!("../migrations/025_sales_item_discount_snapshot.sql"),
            include_str!("../migrations/026_sales_loyalty_redemption_snapshot.sql"),
            include_str!("../migrations/027_drug_catalog_reconciliation.sql"),
            include_str!("../migrations/028_finance_definitions_pharmacy_scope.sql"),
            include_str!("../migrations/029_shift_treasury_retained_cash.sql"),
            include_str!("../migrations/030_relationship_lookup_indexes.sql"),
            include_str!("../migrations/031_trial_balance_unique_categories.sql"),
        ];
        let migrator = |count: usize| sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                sources
                    .iter()
                    .take(count)
                    .enumerate()
                    .map(|(index, sql)| {
                        sqlx::migrate::Migration::new(
                            (index + 1) as i64,
                            format!("migration_{}", index + 1).into(),
                            sqlx::migrate::MigrationType::ReversibleUp,
                            (*sql).into(),
                            false,
                        )
                    })
                    .collect(),
            ),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        };
        // Migrations 1..17 are unchanged from v0.2.91; use the real SQLx ledger.
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        migrator(17).run(&mut connection).await.unwrap();
        sqlx::raw_sql(r#"
            INSERT INTO users(id, username, role, pharmacy_id, permissions) VALUES
              ('moved', 'moved', 'cashier', 'A', '{"can_access_pos":true}'),
              ('a', 'a', 'cashier', 'A', '{}'),
              ('b', 'b', 'cashier', 'B', NULL),
              ('local', 'local', 'cashier', NULL, '[]');
            INSERT INTO shifts(id, user_id, starting_cash, status) VALUES('old', 'moved', 123.45, 'open');
            INSERT INTO master_drugs(id, trade_name) VALUES(999001, 'Upgrade sentinel');
            INSERT INTO inventory(id, drug_id, pharmacy_id, quantity) VALUES('sentinel', 999001, 'A', 2.5);
            INSERT INTO sales_invoices(id,user_id,pharmacy_id,shift_id,total_amount,status)
              VALUES('old-sale','moved','A','old',25,'completed');
        "#).execute(&mut connection).await.unwrap();
        prepare_connection(&mut connection).await.unwrap();
        // Once snapshotted, a staff move cannot move the original open drawer.
        sqlx::query("UPDATE users SET pharmacy_id = 'B' WHERE id = 'moved'")
            .execute(&mut connection)
            .await
            .unwrap();
        migrator(31).run(&mut connection).await.unwrap();

        for restart in [false, true] {
            if restart {
                prepare_connection(&mut connection).await.unwrap();
                migrator(31).run(&mut connection).await.unwrap();
            }
            // The second pharmacy can open a drawer; the first cannot open another.
            sqlx::query(
                "INSERT INTO shifts(id,user_id,pharmacy_id,status) VALUES('new-b','b','B','open')",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            assert!(sqlx::query("INSERT INTO shifts(id,user_id,pharmacy_id,status) VALUES('duplicate-a','a','A','open')")
                .execute(&mut connection).await.is_err());
            assert!(
                sqlx::query("UPDATE shifts SET pharmacy_id='A' WHERE id='new-b'")
                    .execute(&mut connection)
                    .await
                    .is_err()
            );
            // An omitted scope is inferred from the new creator, not the old creator.
            assert!(sqlx::query(
                "INSERT INTO shifts(id,user_id,status) VALUES('duplicate-b','b','open')"
            )
            .execute(&mut connection)
            .await
            .is_err());
            sqlx::query(
                "INSERT INTO shifts(id,user_id,status) VALUES('local-shift','local','open')",
            )
            .execute(&mut connection)
            .await
            .unwrap();
            assert!(sqlx::query("INSERT INTO shifts(id,user_id,pharmacy_id,status) VALUES('duplicate-local','local','local_default','open')")
                .execute(&mut connection).await.is_err());
            sqlx::query("DELETE FROM shifts WHERE id IN ('new-b','local-shift')")
                .execute(&mut connection)
                .await
                .unwrap();
        }
        let old: (String, String, f64, String) = sqlx::query_as(
            "SELECT user_id,pharmacy_id,starting_cash,status FROM shifts WHERE id='old'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(old, ("moved".into(), "A".into(), 123.45, "open".into()));
        let quantity: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='sentinel'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(quantity, 2.5);
        let sale: (String, String, String, f64) = sqlx::query_as(
            "SELECT user_id,pharmacy_id,shift_id,total_amount FROM sales_invoices WHERE id='old-sale'")
            .fetch_one(&mut connection).await.unwrap();
        assert_eq!(sale, ("moved".into(), "A".into(), "old".into(), 25.0));
        let permissions: Option<String> =
            sqlx::query_scalar("SELECT permissions FROM users WHERE id='b'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(permissions, None);
        let stored_permissions: String =
            sqlx::query_scalar("SELECT permissions FROM users WHERE id='moved'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(stored_permissions, r#"{"can_access_pos":true}"#);
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .is_empty());
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");

        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let fresh_path = std::env::temp_dir().join(format!(
            "pharma-schema-parity-fresh-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::copy(&source, &fresh_path).unwrap();
        let mut fresh = connect(&fresh_path).await.unwrap();
        prepare_connection(&mut fresh).await.unwrap();
        migrator(31).run(&mut fresh).await.unwrap();
        assert_current_migration_ledger(&mut connection).await;
        assert_current_migration_ledger(&mut fresh).await;
        assert_relationship_lookup_indexes(&mut connection).await;
        assert_relationship_lookup_indexes(&mut fresh).await;
        assert_trial_balance_category_unique_index(&mut connection).await;
        assert_trial_balance_category_unique_index(&mut fresh).await;
        assert_eq!(
            application_schema_objects(&mut connection).await,
            application_schema_objects(&mut fresh).await,
            "upgraded v0.2.91 schema drifted from the current bundled-seed fresh-install schema"
        );
        assert_eq!(
            application_schema_signature(&mut connection).await,
            application_schema_signature(&mut fresh).await,
            "upgraded v0.2.91 schema is structurally different from a fresh install"
        );
        let fresh_integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut fresh)
            .await
            .unwrap();
        assert_eq!(fresh_integrity, "ok");
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut fresh)
            .await
            .unwrap()
            .is_empty());
        assert_catalog_delete_tombstone(&mut connection, 2_000_000_001).await;
        assert_catalog_delete_tombstone(&mut fresh, 2_000_000_002).await;
        fresh.close().await.unwrap();
        std::fs::remove_file(fresh_path).unwrap();
    }

    #[tokio::test]
    async fn skips_destructive_snapshot_migration_when_scoped_schema_already_exists() {
        let mut connection = representative_purchase_database(false).await;
        sqlx::raw_sql(
            r#"
            CREATE TABLE daily_financial_snapshots (
              date TEXT NOT NULL,
              pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
              total_sales REAL DEFAULT 0,
              total_returns REAL DEFAULT 0,
              total_cash_movements REAL DEFAULT 0,
              net_profit REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (date, pharmacy_id)
            );
            INSERT INTO daily_financial_snapshots (date, pharmacy_id, total_sales) VALUES
              ('2026-09-20', 'ph-1', 10),
              ('2026-09-20', 'ph-2', 20);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        let rows: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT date, pharmacy_id, total_sales FROM daily_financial_snapshots ORDER BY pharmacy_id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("2026-09-20".to_string(), "ph-1".to_string(), 10.0),
                ("2026-09-20".to_string(), "ph-2".to_string(), 20.0),
            ]
        );
        let migration_20_checksum: String =
            sqlx::query_scalar("SELECT hex(checksum) FROM _sqlx_migrations WHERE version = 20")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        let sqlx_migration = sqlx::migrate::Migration::new(
            20,
            "daily_snapshot_pharmacy_scope".into(),
            sqlx::migrate::MigrationType::ReversibleUp,
            DAILY_SNAPSHOT_SCOPE_MIGRATION.into(),
            false,
        );
        let sqlx_checksum = checksum_bytes_hex(&sqlx_migration.checksum);
        assert_eq!(
            migration_20_checksum,
            daily_snapshot_scope_migration_checksum()
        );
        assert_eq!(migration_20_checksum, sqlx_checksum);

        let migration_1 = sqlx::migrate::Migration::new(
            1,
            "initial_schema".into(),
            sqlx::migrate::MigrationType::ReversibleUp,
            include_str!("../migrations/001_initial.sql").into(),
            false,
        );
        let migrator = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(vec![migration_1, sqlx_migration]),
            // This focused test intentionally supplies only migrations 1 and 20.
            // Compatibility may have recorded other current pre-applied migrations.
            ignore_missing: true,
            locking: true,
            no_tx: false,
        };
        migrator.run(&mut connection).await.unwrap();

        let rows_after_migrator: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT date, pharmacy_id, total_sales FROM daily_financial_snapshots ORDER BY pharmacy_id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(rows_after_migrator, rows);
    }

    #[tokio::test]
    async fn repairs_weak_partial_snapshot_schema_before_marking_migration_20() {
        let mut connection = representative_purchase_database(false).await;
        sqlx::raw_sql(
            r#"
            CREATE TABLE daily_financial_snapshots (
              date TEXT,
              pharmacy_id TEXT,
              total_sales REAL DEFAULT 0,
              total_returns REAL DEFAULT 0,
              total_cash_movements REAL DEFAULT 0,
              net_profit REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (date, pharmacy_id)
            );
            INSERT INTO daily_financial_snapshots (date, pharmacy_id, total_sales) VALUES
              ('2026-09-20', 'ph-1', 10),
              ('2026-09-20', 'ph-2', 20);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        let rows: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT date, pharmacy_id, total_sales FROM daily_financial_snapshots ORDER BY pharmacy_id",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("2026-09-20".to_string(), "ph-1".to_string(), 10.0),
                ("2026-09-20".to_string(), "ph-2".to_string(), 20.0),
            ]
        );
        let columns = sqlx::query("PRAGMA table_info(daily_financial_snapshots)")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        let date = columns
            .iter()
            .find(|row| row.get::<String, _>("name") == "date")
            .unwrap();
        let pharmacy = columns
            .iter()
            .find(|row| row.get::<String, _>("name") == "pharmacy_id")
            .unwrap();
        assert_eq!(date.get::<i64, _>("notnull"), 1);
        assert_eq!(date.get::<i64, _>("pk"), 1);
        assert_eq!(pharmacy.get::<i64, _>("notnull"), 1);
        assert_eq!(pharmacy.get::<i64, _>("pk"), 2);
        assert_eq!(
            pharmacy.get::<Option<String>, _>("dflt_value").as_deref(),
            Some("'local_default'")
        );
        let migration_20_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 20")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(migration_20_count, 1);
    }

    #[tokio::test]
    async fn heals_stranded_barcodes_from_inventory_and_purchases() {
        let seed_path =
            std::env::temp_dir().join(format!("pharma-stranded-seed-{}.db", uuid::Uuid::new_v4()));
        let live_path =
            std::env::temp_dir().join(format!("pharma-stranded-live-{}.db", uuid::Uuid::new_v4()));
        let mut seed = connect(&seed_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              large_to_medium INTEGER,
              barcode TEXT,
              notes TEXT
            );
            INSERT INTO master_drugs VALUES
              (6862, 'EFUCISAN 1% VISCOUS EYE DROPS 5 GM', NULL, 'FUSIDIC ACID', 'antibiotic', 'ORCHIDIA', 28, NULL, NULL, NULL),
              (7399, 'ERASTAPEX TRIO 10/40/25MG 30 F.C. TABS.', NULL, 'AMLODIPINE...', 'anti-hypertensive', 'MULTI-APEX', 162, NULL, NULL, NULL);
            CREATE INDEX idx_seed_master_drugs_trade_name ON master_drugs(trade_name COLLATE NOCASE);
            "#,
        )
        .execute(&mut seed)
        .await
        .unwrap();
        seed.close().await.unwrap();

        let mut live = connect(&live_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              large_to_medium INTEGER,
              barcode TEXT,
              notes TEXT
            );
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              quantity REAL,
              strips_per_box INTEGER,
              barcode TEXT
            );
            CREATE TABLE purchase_invoice_items (
              id INTEGER PRIMARY KEY,
              drug_id INTEGER,
              inventory_id TEXT,
              barcode TEXT
            );
            CREATE TABLE sales_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE refill_reminders (id TEXT PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE purchase_order_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE stock_adjustments (id INTEGER PRIMARY KEY, inventory_id TEXT);
            CREATE TABLE opening_balance_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE shortages (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE drug_indications (drug_id INTEGER, indication_id INTEGER, PRIMARY KEY (drug_id, indication_id));
            CREATE TABLE drug_alternatives (drug_id INTEGER, alternative_id INTEGER, PRIMARY KEY (drug_id, alternative_id));

            -- Simulate state after an older repair restored names, but left
            -- the barcode stranded on #6862, while canonical #7399 has NULL barcode:
            INSERT INTO master_drugs VALUES
              (6862, 'EFUCISAN 1% VISCOUS EYE DROPS 5 GM', NULL, 'FUSIDIC ACID', 'antibiotic', 'ORCHIDIA', 28, NULL, '6223003205577', NULL),
              (7399, 'ERASTAPEX TRIO 10/40/25MG 30 F.C. TABS.', NULL, 'AMLODIPINE...', 'anti-hypertensive', 'MULTI-APEX', 162, NULL, NULL, NULL);

            -- Inventory was moved to #7399 and carries the barcode:
            INSERT INTO inventory VALUES ('inv-erast', 7399, 5, 3, '6223003205577');
            "#,
        )
        .execute(&mut live)
        .await
        .unwrap();

        let repaired = repair_legacy_catalog_name_drift_on_connection(&mut live, &seed_path)
            .await
            .unwrap();
        assert!(repaired > 0);

        // #7399 should now have the barcode:
        let target_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM master_drugs WHERE id = 7399")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(target_barcode.as_deref(), Some("6223003205577"));

        // #6862 should have its barcode cleared:
        let source_barcode: Option<String> =
            sqlx::query_scalar("SELECT barcode FROM master_drugs WHERE id = 6862")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(source_barcode, None);

        // Idempotency: second run does nothing:
        let second_run = repair_legacy_catalog_name_drift_on_connection(&mut live, &seed_path)
            .await
            .unwrap();
        assert_eq!(second_run, 0);

        live.close().await.unwrap();
        std::fs::remove_file(seed_path).unwrap();
        std::fs::remove_file(live_path).unwrap();
    }

    #[tokio::test]
    async fn opt_in_pinned_v29_custody_copy_uses_real_native_sqlx_startup_and_blocks_source_drift() {
        use sha2::{Digest, Sha256};
        use std::fs;
        use std::io::Read;
        use std::path::PathBuf;

        // Opt-in only: the source must be the separately staged CUSTODY COPY,
        // never an installed profile, immutable archive or sealed backup.
        // The upstream custody tool generated a private candidate.sqlite3.
        const SOURCE_ENV: &str = "PHARMA_NATIVE_SQLX_V29_STAGE_CANDIDATE";
        const PIN_ENV: &str = "PHARMA_NATIVE_SQLX_V29_STAGE_SHA256";
        let (Some(source), Some(pin)) = (std::env::var_os(SOURCE_ENV), std::env::var_os(PIN_ENV))
        else {
            assert!(
                std::env::var_os(SOURCE_ENV).is_none()
                    && std::env::var_os(PIN_ENV).is_none(),
                "Partial v29 custody pin is refused"
            );
            eprintln!("Native SQLx v29 staged-copy rehearsal not requested; no database opened");
            return;
        };

        fn file_sha256(path: &Path) -> String {
            let mut reader = fs::File::open(path).expect("pinned stage unreadable");
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = reader.read(&mut buffer).expect("pinned stage read failed");
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
        }

        let expected = pin.to_str().expect("Pin must be ASCII");
        assert!(
            expected.len() == 64
                && expected.starts_with("06fc00f3")
                && expected.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Explicit full SHA-256 pin for the fresh private v29 candidate is required"
        );
        let source = PathBuf::from(source);
        assert!(source.is_absolute(), "Custody candidate path must be absolute");
        assert_eq!(source.file_name().and_then(|name| name.to_str()), Some("candidate.sqlite3"));
        let stage = source.parent().expect("No custody parent");
        let stage_name = stage.file_name().and_then(|name| name.to_str()).unwrap_or("");
        let token = stage_name.strip_prefix("pharma-legacy-stage-")
            .expect("Only custody-stage candidate paths are accepted");
        assert!(
            token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Custody stage token is not canonical"
        );
        assert!(
            fs::symlink_metadata(stage).expect("Custody stage absent").file_type().is_dir()
                && fs::symlink_metadata(&source).expect("Custody candidate absent").file_type().is_file(),
            "Symlinked stage/candidate is refused"
        );
        let parent = stage.parent().expect("Custody stage root absent").canonicalize().unwrap();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let app_data_root = std::env::var_os("LOCALAPPDATA")
            .and_then(|root| {
                PathBuf::from(root).join("pharma-disposable-data-copies").canonicalize().ok()
            });
        assert!(
            parent == temp || app_data_root.as_ref() == Some(&parent),
            "Only an isolated private custody-stage root is permitted"
        );
        let canonical_stage = stage.canonicalize().unwrap();
        assert_eq!(canonical_stage.parent(), Some(parent.as_path()),
            "Custody stage cannot redirect outside its private root");
        assert_eq!(
            source.canonicalize().unwrap().parent(),
            Some(canonical_stage.as_path()),
            "Candidate cannot escape the pinned custody stage"
        );
        let size = fs::metadata(&source).unwrap().len();
        assert!(size > 4096 && size < 1_000_000_000, "Invalid pinned v29 candidate size");
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(
                !source.with_file_name(format!("candidate.sqlite3{suffix}")).exists(),
                "Custody stage with active SQLite sidecars is refused"
            );
        }
        let original_pin = file_sha256(&source);
        assert_eq!(original_pin, expected.to_ascii_lowercase(), "Custody candidate pin mismatch");

        // Copy bytes into a NEW unique temp directory; all SQLx/compatibility
        // writes occur only there. A drop guard cannot remove anything except
        // this test-owned path, even if an assertion rejects the migration.
        struct DisposableNativeSqlxCopy(PathBuf);
        impl Drop for DisposableNativeSqlxCopy {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let folder = std::env::temp_dir().join(format!(
            "pharma-native-sqlx-v29-{}", uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&folder).expect("Cannot create isolated native SQLx test dir");
        let _cleanup = DisposableNativeSqlxCopy(folder.clone());
        let candidate = folder.join("working-clone.sqlite3");
        assert_eq!(fs::copy(&source, &candidate).unwrap(), size);
        assert_eq!(file_sha256(&candidate), original_pin);
        assert_eq!(file_sha256(&source), original_pin, "Custody stage changed during copy");

        // The public native preparation entry point must refuse this legacy
        // source BEFORE mutating even a disposable copy. Direct SQLx below is
        // deliberately a negative *diagnostic*, not a customer migration.
        let guard_path = candidate.clone();
        let denied = tokio::task::spawn_blocking(move || prepare_legacy_database(&guard_path))
            .await
            .expect("Native legacy guard worker failed");
        assert!(denied.is_err(), "Native preparer bypassed old-history ownership guard");
        assert_eq!(file_sha256(&candidate), original_pin,
            "Denied native preparation changed original v29 record bytes");

        let mut db = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&candidate)
                .create_if_missing(false)
                .foreign_keys(true),
        ).await.expect("Cannot open isolated v29 SQLx clone");
        let before_versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE success=1 ORDER BY version"
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(before_versions, (1_i64..=29).collect::<Vec<_>>(),
            "Pinned custody candidate is not a complete original SQLx v29 source");
        let inherited_foreign_key_issues = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut db).await.unwrap().len();

        // Witness the real original storage class + exact bytes, without
        // logging any user identity, password hash, or pharmacy literal.
        let user_witness = r#"
            SELECT CAST(id AS TEXT), typeof(password_hash),
                   CASE WHEN password_hash IS NULL THEN NULL
                        ELSE hex(CAST(password_hash AS BLOB)) END,
                   typeof(pharmacy_id),
                   CASE WHEN pharmacy_id IS NULL THEN NULL
                        ELSE hex(CAST(pharmacy_id AS BLOB)) END
            FROM users ORDER BY CAST(id AS TEXT)
        "#;
        type OriginalUser = (String, String, Option<String>, String, Option<String>);
        let original_users: Vec<OriginalUser> =
            sqlx::query_as(user_witness).fetch_all(&mut db).await.unwrap();
        assert!(!original_users.is_empty(), "No original users; refusing staged upgrade");

        // Exactly mirror trusted licensed startup; DO NOT run migrations
        // without prepare_connection and call that an application upgrade.
        prepare_connection(&mut db).await
            .expect("RELEASE BLOCKED: native pre-migrator compatibility refused v29 clone");
        actual_native_startup_migrator(67).run(&mut db).await
            .expect("RELEASE BLOCKED: real native SQLx migration sequence refused v29 clone");
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE success=1 ORDER BY version"
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(versions, (1_i64..=67).collect::<Vec<_>>(),
            "Real SQLx upgrade has missing/unexpected versions");
        for registry in [
            "native_legacy_upgrade_manifests",
            "native_legacy_upgrade_source_mappings",
            "native_legacy_upgrade_manifest_seals",
            "native_legacy_original_detail_rows",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {registry}"))
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(count, 0, "Native migration must not fabricate any 065-067 grants");
        }
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(integrity, "ok", "RELEASE BLOCKED: SQLite integrity failure");
        let after_foreign_key_issues = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut db).await.unwrap().len();
        assert!(
            after_foreign_key_issues <= inherited_foreign_key_issues,
            "RELEASE BLOCKED: native migration added foreign-key violations"
        );

        // Verify restart/idempotency through the SAME compatibility gate.
        prepare_connection(&mut db).await
            .expect("RELEASE BLOCKED: native post-upgrade restart compatibility refused clone");
        actual_native_startup_migrator(67).run(&mut db).await
            .expect("RELEASE BLOCKED: second native SQLx startup refused clone");
        let post_versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE success=1 ORDER BY version"
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(post_versions, versions, "Native SQLx restart changed applied migration list");
        let after_users: Vec<OriginalUser> =
            sqlx::query_as(user_witness).fetch_all(&mut db).await.unwrap();
        assert_eq!(original_users.len(), after_users.len(), "Original user records changed");
        assert!(
            original_users.iter().zip(&after_users).all(|(old, new)| old.0 == new.0),
            "Original user identities changed"
        );
        let password_drift = original_users.iter().zip(&after_users)
            .filter(|(old, new)| old.1 != new.1 || old.2 != new.2).count();
        let tenant_drift = original_users.iter().zip(&after_users)
            .filter(|(old, new)| old.3 != new.3 || old.4 != new.4).count();

        // Optional private proof of what REAL native SQLx and compatibility
        // produced. SQLite VACUUM INTO copies the committed state consistently,
        // including WAL-backed writes; unlike copying a live base file it
        // cannot omit committed sidecars. Only a separate, uniquely named
        // private QA evidence folder is allowed, never an installed profile.
        // The file remains QUARANTINED even if the release-blocking assertion
        // below fails. A separate read-only Python typed-graph auditor must
        // compare every original source row against this actual native output.
        if std::env::var("PHARMA_NATIVE_SQLX_RETAIN_PRIVATE_DIAGNOSTIC").as_deref() == Ok("1") {
            let root = PathBuf::from(std::env::var_os("LOCALAPPDATA")
                .expect("Private SQLx diagnostic requires Windows LocalAppData"))
                .join("pharma-disposable-data-copies");
            assert!(root.is_dir() && !fs::symlink_metadata(&root).unwrap().file_type().is_symlink(),
                "Private custody root missing or redirected");
            let output_dir = root.join(format!(
                "pharma-v02110-native-sqlx-diagnostic-{}", uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir(&output_dir).expect("Private native diagnostic folder collision");
            let diagnostic_file = output_dir.join("native-v67-working-only.sqlite3");
            let filename = diagnostic_file.to_str().expect("Private SQLite path not UTF-8");
            sqlx::query("VACUUM INTO ?")
                .bind(filename)
                .execute(&mut db)
                .await
                .expect("Committed native SQLx output could not be snapshotted");
            assert!(diagnostic_file.is_file(), "Native diagnostic was not committed");
            eprintln!(
                "PRIVATE_UNACTIVATED_NATIVE_SQLX_STAGE={} WORKING_COPY_SHA256={} SOURCE_UNCHANGED=true",
                output_dir.file_name().unwrap().to_string_lossy(),
                file_sha256(&diagnostic_file)
            );
        }
        db.close().await.unwrap();
        assert_eq!(file_sha256(&source), original_pin,
            "RELEASE BLOCKED: protected custody candidate changed");
        assert_eq!(
            (password_drift, tenant_drift), (0, 0),
            "RELEASE BLOCKED: native SQLx v29→v67 changed original users.password_hash \
            ({password_drift}) or original users.pharmacy_id ({tenant_drift}); \
            no historical tenant authorization or release approval is inferred"
        );
        eprintln!(
            "Native v29→v67 disposable-clone SQLx sequencing checked; \
            historical ownership and activation remain NOT authorized"
        );
    }

    #[test]
    fn registered_pre29_source_direct_preparer_denies_before_original_bytes_change() {
        // This is a new isolated SQLite fixture, never the installed profile.
        // The public preparer must not treat migrations 001–028 as exempt from
        // the same v029+ read-only historical identity protection.
        let path = std::env::temp_dir().join(format!(
            "pharma-guard-pre29-{}.sqlite3", uuid::Uuid::new_v4().simple()
        ));
        tauri::async_runtime::block_on(async {
            let mut db = SqliteConnection::connect_with(
                &SqliteConnectOptions::new().filename(&path).create_if_missing(true),
            ).await.unwrap();
            sqlx::raw_sql(
                "CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER,password_hash TEXT); \
                 CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER); \
                 WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<12) \
                 INSERT INTO _sqlx_migrations SELECT v,1 FROM n; \
                 INSERT INTO users VALUES('admin','owner',NULL,1,'synthetic-only-stub-hash');"
            ).execute(&mut db).await.unwrap();
            db.close().await.unwrap();
        });
        let before = std::fs::read(&path).unwrap();
        let refused = prepare_legacy_database(&path);
        assert!(refused.is_err(), "Old registered source bypassed direct native preflight");
        assert_eq!(std::fs::read(&path).unwrap(), before,
            "Denied legacy preparation rewrote original SQLite bytes");
        // Windows can briefly keep a read-only SQLite sharing lease alive
        // after the preflight rejects a synthetic fixture. Fixture disposal is
        // not part of the checked original-byte preservation assertion.
        for attempt in 0..10 {
            match std::fs::remove_file(&path) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) if attempt < 9 && error.raw_os_error() == Some(32) => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    }

    #[tokio::test]
    async fn synthetic_v67_explicit_one_owner_authenticates_after_native_restart_without_legacy_grant() {
        // Genuine native auth/SQLx functions, but strictly in-memory with a
        // NEW synthetic owner. This is NOT a grant to any old v29 records.
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        actual_native_startup_migrator(67).run(&mut db).await.unwrap();
        sqlx::query("DELETE FROM users WHERE id='admin'")
            .execute(&mut db).await.unwrap();
        let synthetic_password = "SyntheticUnique!2026NativeOnly";
        let synthetic_hash = bcrypt::hash(synthetic_password, 4).unwrap();
        sqlx::query(
            "INSERT INTO users(id,username,role,full_name,pharmacy_id,password_hash,is_active,permissions) \
             VALUES('qa-v67-owner','qa-v67-owner','owner','Synthetic owner','qa_v67_explicit',?,1,'{}')"
        ).bind(&synthetic_hash).execute(&mut db).await.unwrap();
        crate::legacy_upgrade_guard::assess_existing_connection(&mut db)
            .await.expect("One explicit synthetic owner should satisfy the native read-only guard");

        prepare_connection(&mut db).await.unwrap();
        actual_native_startup_migrator(67).run(&mut db).await.unwrap();
        prepare_connection(&mut db).await.unwrap();
        actual_native_startup_migrator(67).run(&mut db).await.unwrap();

        let successful = crate::commands::auth::authenticate_on_connection(
            &mut db, "qa-v67-owner", synthetic_password,
        ).await.unwrap();
        assert!(successful.success, "Native login of explicit synthetic owner failed");
        let actor = successful.user.expect("Native login omitted approved QA actor");
        assert_eq!(actor.id, "qa-v67-owner");
        assert_eq!(actor.pharmacy_id.as_deref(), Some("qa_v67_explicit"));

        let wrong = crate::commands::auth::authenticate_on_connection(
            &mut db, "qa-v67-owner", "SyntheticDefinitelyWrongPassword",
        ).await.unwrap();
        assert!(!wrong.success, "Native login accepted incorrect password");

        let (owner_count, explicit_count): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), SUM(CASE WHEN pharmacy_id='qa_v67_explicit' THEN 1 ELSE 0 END) \
             FROM users WHERE role='owner'"
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!((owner_count, explicit_count), (1, 1));
        for registration in [
            "native_legacy_upgrade_manifests",
            "native_legacy_upgrade_source_mappings",
            "native_legacy_upgrade_manifest_seals",
            "native_legacy_original_detail_rows",
        ] {
            let rows: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {registration}"))
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(rows, 0, "Synthetic test cannot mint historical owner grants");
        }
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(version, 67);
        let check: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(check, "ok");
    }
}
