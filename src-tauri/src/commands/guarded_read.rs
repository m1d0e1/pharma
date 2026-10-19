//! Bounded execution for SQLx-backed renderer reads.
//! The caller enforces license/session actor; this module denies credential
//! reads and applies SQLite VM/output budgets on the authenticated IPC surface.

use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use std::{
    ffi::CStr,
    os::raw::{c_char, c_int, c_void},
    ptr,
    sync::Arc,
    time::{Duration, Instant},
};

use super::critical::{bind_json_value, sqlite_row_to_json};

#[derive(Clone, Copy)]
pub(super) struct ReadLimits {
    pub max_duration: Duration,
    pub max_rows: usize,
    pub max_bytes: usize,
}

pub(super) const DEFAULT_READ_LIMITS: ReadLimits = ReadLimits {
    // Full catalog cache and Excel exports may legitimately include ~191k
    // records. Keep a real upper bound without truncating those workflows.
    max_duration: Duration::from_secs(12),
    max_rows: 250_000,
    max_bytes: 256 * 1024 * 1024,
};

/// If a reader future was canceled before the normal cleanup path, the
/// progress callback and query_only flag can remain on a reused connection.
/// Reset those native-only, query-local guards before its next operation.
pub(super) async fn reset_cancelled_read_state(conn: &mut SqliteConnection) -> Result<(), String> {
    let mut handle = conn.lock_handle().await.map_err(|e| e.to_string())?;
    handle.remove_progress_handler();
    // SAFETY: SQLx LockedSqliteHandle gives exclusive FFI access; no callback
    // context pointer is shared or freed by the caller.
    unsafe {
        libsqlite3_sys::sqlite3_set_authorizer(
            handle.as_raw_handle().as_ptr(),
            None,
            ptr::null_mut(),
        );
        libsqlite3_sys::sqlite3_limit(
            handle.as_raw_handle().as_ptr(),
            libsqlite3_sys::SQLITE_LIMIT_LENGTH,
            1_000_000_000,
        );
    }
    drop(handle);
    sqlx::query("PRAGMA query_only = OFF")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

const MAX_SQLITE_VALUE_BYTES: i32 = 8 * 1024 * 1024;

fn is_unowned_clinical_table(table: &[u8]) -> bool {
    [
        b"patients".as_slice(),
        b"patient_allergies",
        b"patient_conditions",
        b"patient_transactions",
        b"refill_reminders",
        b"native_patient_wallet_topup_receipts",
        b"native_patient_financial_journal_receipts",
    ]
    .iter()
    .any(|name| table.eq_ignore_ascii_case(name))
}

/// Trusted fixed native SQL already checks its actor and tenant provenance;
/// it may read clinical rows, but never password hashes.
/// SQLite's prepare-time authorizer sees real column references through
/// SELECT *, aliases, subqueries and CTEs (unlike regexing the SQL string).
unsafe extern "C" fn deny_native_credentials_on_read(
    _context: *mut c_void,
    operation: c_int,
    table: *const c_char,
    column: *const c_char,
    _database: *const c_char,
    _source: *const c_char,
) -> c_int {
    let is_name = |ptr: *const c_char, expected: &[u8]| {
        !ptr.is_null()
            && CStr::from_ptr(ptr)
                .to_bytes()
                .eq_ignore_ascii_case(expected)
    };
    if operation == libsqlite3_sys::SQLITE_READ
        && is_name(table, b"users") && is_name(column, b"password_hash")
    {
        libsqlite3_sys::SQLITE_DENY
    } else {
        libsqlite3_sys::SQLITE_OK
    }
}

/// Arbitrary renderer-selected SQL may never read globally unowned patient
/// rows, including by preparing nested statements or views.
unsafe extern "C" fn deny_credentials_on_read(
    context: *mut c_void,
    operation: c_int,
    table: *const c_char,
    column: *const c_char,
    database: *const c_char,
    source: *const c_char,
) -> c_int {
    if operation == libsqlite3_sys::SQLITE_READ
        && !table.is_null()
        && is_unowned_clinical_table(unsafe { CStr::from_ptr(table) }.to_bytes())
    {
        libsqlite3_sys::SQLITE_DENY
    } else {
        unsafe { deny_native_credentials_on_read(context, operation, table, column, database, source) }
    }
}

/// Release builds refuse arbitrary renderer reads of pharmacy/customer data.
/// This cannot be substituted with an ad-hoc WHERE rewrite or a SQLite view:
/// a malicious CTE can masquerade as a view authorizer source. Only *trusted
/// native static query IDs* may read business tables via fetch_scoped_limited.
fn generic_read_allowed(table: &[u8], column: &[u8], strict: bool) -> bool {
    if is_unowned_clinical_table(table) {
        return false;
    }
    if table.eq_ignore_ascii_case(b"users") && column.eq_ignore_ascii_case(b"password_hash") {
        return false;
    }
    if !strict {
        return true;
    }
    if table.eq_ignore_ascii_case(b"master_drugs") {
        // The master catalog is global, not pharmacy-owned; however global
        // visibility does not authorize unstructured free-text notes or a
        // new private column added by a later migration. Explicitly enumerate
        // the established public catalog fields for *renderer chosen SQL*.
        // Typed native commands independently authorize any other projection.
        // SQLite reports an empty column for COUNT(*) on some query plans.
        return column.is_empty()
            || [
                b"id".as_slice(),
                b"trade_name",
                b"trade_name_en",
                b"generic_name",
                b"active_ingredient",
                b"barcode",
                b"official_price",
                b"category",
                b"manufacturer",
                b"is_medicine",
                b"is_service",
                b"is_refrigerated",
                b"is_chronic",
                b"has_expiry",
                b"no_return",
                b"origin",
                b"large_unit",
                b"medium_unit",
                b"small_unit",
                b"large_to_medium",
                b"medium_to_small",
                b"min_limit",
                b"max_limit",
                b"reorder_point",
                b"default_purchase_qty",
                b"prevent_fractions",
                b"tax_percent",
                b"discount_percent",
                b"stop_dealing",
                b"code_2",
                b"item_nature",
                b"scientific_group",
                b"usage_method",
                b"active_ingredient_ratio",
                b"is_table",
                b"indications",
                b"side_effects",
                b"created_at",
            ]
            .iter()
            .any(|safe| column.eq_ignore_ascii_case(safe));
    }
    // Genuinely shared pharmaceutical reference data. Unknown/new tables are
    // denied by default; no customer, staff, transaction or finance table.
    [
        b"units".as_slice(),
        b"scientific_groups",
        b"indications",
        b"manufacturers",
        b"item_natures",
        b"usage_methods",
        b"product_categories",
        b"drug_interactions",
        b"drug_alternatives",
        b"drug_indications",
    ]
    .iter()
    .any(|safe| table.eq_ignore_ascii_case(safe))
}

unsafe extern "C" fn deny_legacy_business_reads(
    _context: *mut c_void,
    operation: c_int,
    table: *const c_char,
    column: *const c_char,
    _database: *const c_char,
    _source: *const c_char,
) -> c_int {
    if operation != libsqlite3_sys::SQLITE_READ {
        return libsqlite3_sys::SQLITE_OK;
    }
    let table = if table.is_null() {
        &[][..]
    } else {
        CStr::from_ptr(table).to_bytes()
    };
    let column = if column.is_null() {
        &[][..]
    } else {
        CStr::from_ptr(column).to_bytes()
    };
    if generic_read_allowed(table, column, true) {
        libsqlite3_sys::SQLITE_OK
    } else if table.eq_ignore_ascii_case(b"master_drugs") {
        // SQLITE_IGNORE replaces this source column with NULL *inside the
        // SQLite VM*. That preserves legitimate existing SELECT * catalogue
        // screens, while notes, future private columns, predicates, nested
        // expressions and aggregates cannot observe the original value.
        // Do not use SQL string matching: aliases and CTEs must be covered.
        libsqlite3_sys::SQLITE_IGNORE
    } else {
        libsqlite3_sys::SQLITE_DENY
    }
}

pub(super) async fn fetch_limited(
    conn: &mut SqliteConnection,
    sql: &str,
    params: Vec<Value>,
    limits: ReadLimits,
) -> Result<Vec<Value>, String> {
    fetch_limited_internal(conn, sql, params, limits, false).await
}

/// Static native SQL only, with a native database-authenticated actor and
/// bound pharmacy predicate already constructed by the calling command.
pub(super) async fn fetch_scoped_limited(
    conn: &mut SqliteConnection,
    sql: &str,
    params: Vec<Value>,
    limits: ReadLimits,
) -> Result<Vec<Value>, String> {
    fetch_limited_internal(conn, sql, params, limits, true).await
}

async fn fetch_limited_internal(
    conn: &mut SqliteConnection,
    sql: &str,
    params: Vec<Value>,
    limits: ReadLimits,
    trusted_native_scoped: bool,
) -> Result<Vec<Value>, String> {
    // The authorizer runs when SQLite prepares SQL, not when it steps a
    // previously compiled statement. Renderer-selected queries must never
    // reuse a statement compiled before this read-isolation policy applied.
    if !trusted_native_scoped {
        conn.clear_cached_statements()
            .await
            .map_err(|e| e.to_string())?;
    }
    // SQLite's progress callback runs on the actual statement execution thread.
    // tokio::time::timeout alone cannot reliably stop a running SQLite VM.
    // The weak reference also aborts a SQLite VM if the Rust future was
    // cancelled while SQLite kept executing on its dedicated worker thread.
    let lifetime = Arc::new(());
    let weak = Arc::downgrade(&lifetime);
    let deadline = Instant::now() + limits.max_duration;
    let previous_length_limit = {
        let mut handle = conn.lock_handle().await.map_err(|e| e.to_string())?;
        // Length caps act before the SQLx row/JSON conversion. Post-fetch
        // response limits alone would still permit giant randomblob values.
        // SAFETY: SQLx LockedSqliteHandle exclusively owns the SQLite FFI
        // handle for this scope, and sqlite3_limit needs no user pointers.
        let prior = unsafe {
            libsqlite3_sys::sqlite3_limit(
                handle.as_raw_handle().as_ptr(),
                libsqlite3_sys::SQLITE_LIMIT_LENGTH,
                MAX_SQLITE_VALUE_BYTES,
            )
        };
        // SAFETY: the callback is static and receives no user-data pointer;
        // SQLx owns an exclusive LockedSqliteHandle during installation.
        let strict_renderer = cfg!(pharma_security_release) || cfg!(pharma_strict_renderer_sql_qa);
        let callback = if trusted_native_scoped {
            Some(deny_native_credentials_on_read as unsafe extern "C" fn(_, _, _, _, _, _) -> _)
        } else if !strict_renderer {
            Some(deny_credentials_on_read as unsafe extern "C" fn(_, _, _, _, _, _) -> _)
        } else {
            Some(deny_legacy_business_reads as unsafe extern "C" fn(_, _, _, _, _, _) -> _)
        };
        let authorizer = unsafe {
            libsqlite3_sys::sqlite3_set_authorizer(
                handle.as_raw_handle().as_ptr(),
                callback,
                ptr::null_mut(),
            )
        };
        if authorizer != libsqlite3_sys::SQLITE_OK {
            return Err("Cannot enforce native credential-read policy".into());
        }
        handle.set_progress_handler(1000, move || {
            weak.upgrade().is_some() && Instant::now() < deadline
        });
        prior
    };

    // Stream one SQLite row at a time. fetch_all used to collect all rows
    // before any row-count/IPC-byte limit could be enforced.
    let result = async {
        // Do not reuse precompiled statements from another authorization
        // context: SQLite invokes authorizer on PREPARE, not on every STEP.
        let mut query = sqlx::query(sql).persistent(false);
        for param in params {
            query = bind_json_value(query, param);
        }
        let mut rows = query.fetch(&mut *conn);
        let mut collected = Vec::new();
        let mut bytes = 2usize; // JSON array brackets
        while let Some(row) = rows.try_next().await.map_err(|e| e.to_string())? {
            if collected.len() >= limits.max_rows {
                return Err("Native database read row limit exceeded".into());
            }
            let value = sqlite_row_to_json(&row)?;
            let row_bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?.len();
            let additional = row_bytes.saturating_add(usize::from(!collected.is_empty()));
            if additional > limits.max_bytes.saturating_sub(bytes) {
                return Err("Native database read size limit exceeded".into());
            }
            bytes += additional;
            collected.push(value);
        }
        Ok(collected)
    }
    .await;

    // The same SQLx connection is exclusively held here. Always clean up the
    // SQLite handler after normal/error completion before pooling it again.
    drop(lifetime);
    let reset = conn.lock_handle().await.map_err(|e| e.to_string());
    match reset {
        Ok(mut handle) => {
            handle.remove_progress_handler();
            // SAFETY: SQLx holds the exclusive connection lock. Removing the
            // query-local authorizer restores normal trusted native commands.
            unsafe {
                libsqlite3_sys::sqlite3_set_authorizer(
                    handle.as_raw_handle().as_ptr(),
                    None,
                    ptr::null_mut(),
                );
            }
            // SAFETY: the SQLx lock still exclusively owns this SQLite FFI
            // handle. Restore the previous connection-local default.
            unsafe {
                libsqlite3_sys::sqlite3_limit(
                    handle.as_raw_handle().as_ptr(),
                    libsqlite3_sys::SQLITE_LIMIT_LENGTH,
                    previous_length_limit,
                );
            }
        }
        Err(error) => return Err(error),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Row};

    #[test]
    fn strict_release_policy_denies_real_tenant_tables_without_view_or_cte_exceptions() {
        for name in [
            b"users".as_slice(),
            b"patients",
            b"inventory",
            b"sales_invoices",
            b"sales_items",
            b"expenses",
            b"accounts",
            b"suppliers",
            b"supplier_transactions",
            b"purchase_invoices",
            b"purchase_invoice_items",
            b"purchase_returns",
            b"purchase_return_items",
            b"sqlite_master",
            b"new_private_table",
        ] {
            assert!(!generic_read_allowed(name, b"id", true));
        }
        assert!(generic_read_allowed(b"master_drugs", b"trade_name", true));
        assert!(generic_read_allowed(b"master_drugs", b"barcode", true));
        assert!(generic_read_allowed(
            b"master_drugs",
            b"official_price",
            true
        ));
        assert!(generic_read_allowed(b"MASTER_DRUGS", b"Trade_Name", true));
        // Globally owned reference rows are not a blanket permission to read
        // internal notes or any new column added by a future migration.
        for column in [b"notes".as_slice(), b"internal_secret", b"password_hash"] {
            assert!(!generic_read_allowed(b"master_drugs", column, true));
            assert!(generic_read_allowed(b"master_drugs", column, false));
        }
        assert!(generic_read_allowed(b"units", b"name", true));
        assert!(!generic_read_allowed(b"users", b"password_hash", false));
    }

    #[tokio::test]
    async fn sqlite_native_strict_authorizer_blocks_nested_and_cte_business_reads() {
        use sqlx::Connection;
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE patients(id TEXT, full_name TEXT); INSERT INTO patients VALUES('secret','PRIVATE');
          CREATE TABLE suppliers(id INTEGER, name_ar TEXT); INSERT INTO suppliers VALUES(7,'PRIVATE-SUPPLIER');
          CREATE TABLE supplier_transactions(id INTEGER, notes TEXT); INSERT INTO supplier_transactions VALUES(1,'PRIVATE-STATEMENT');
          CREATE TABLE purchase_returns(id TEXT, reason TEXT); INSERT INTO purchase_returns VALUES('return-secret','PRIVATE-RETURN');
          CREATE TABLE purchase_invoices(id TEXT, notes TEXT); INSERT INTO purchase_invoices VALUES('invoice-secret','PRIVATE-INVOICE');
          CREATE TABLE master_drugs(id INTEGER,trade_name TEXT,barcode TEXT,notes TEXT,internal_secret TEXT);
          INSERT INTO master_drugs VALUES(1,'PUBLIC','PUBLIC-CODE','CONFIDENTIAL-NOTE','FUTURE-PRIVATE');
          CREATE VIEW catalog_note_view AS SELECT notes FROM master_drugs;")
            .execute(&mut conn).await.unwrap();
        {
            let mut handle = conn.lock_handle().await.unwrap();
            let rc = unsafe {
                libsqlite3_sys::sqlite3_set_authorizer(
                    handle.as_raw_handle().as_ptr(),
                    Some(deny_legacy_business_reads),
                    ptr::null_mut(),
                )
            };
            assert_eq!(rc, libsqlite3_sys::SQLITE_OK);
        }
        for sql in [
            "SELECT * FROM patients",
            "SELECT (SELECT full_name FROM patients LIMIT 1) AS leaked",
            "WITH x AS (SELECT * FROM patients) SELECT * FROM x",
            "WITH patients AS (SELECT full_name FROM main.patients) SELECT * FROM patients",
            "SELECT name_ar FROM suppliers",
            "SELECT notes FROM supplier_transactions",
            "WITH returns AS (SELECT reason FROM purchase_returns) SELECT * FROM returns",
            "SELECT notes FROM purchase_invoices",
            "SELECT * FROM catalog_note_view",
        ] {
            assert!(
                sqlx::query(sql)
                    .persistent(false)
                    .fetch_all(&mut conn)
                    .await
                    .is_err(),
                "{sql}"
            );
        }
        let public = sqlx::query("SELECT trade_name, barcode FROM master_drugs")
            .persistent(false)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(public.try_get::<String, _>("trade_name").unwrap(), "PUBLIC");
        assert_eq!(
            public.try_get::<String, _>("barcode").unwrap(),
            "PUBLIC-CODE"
        );
        // Existing catalogue screens often use SELECT *. Mask private and
        // newly added columns to NULL without breaking public row shapes.
        let all = sqlx::query("SELECT * FROM master_drugs")
            .persistent(false)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(all.try_get::<String, _>("trade_name").unwrap(), "PUBLIC");
        assert_eq!(all.try_get::<Option<String>, _>("notes").unwrap(), None);
        assert_eq!(
            all.try_get::<Option<String>, _>("internal_secret").unwrap(),
            None
        );
        for sql in [
            "SELECT notes AS secret FROM master_drugs",
            "SELECT m.\"notes\" AS secret FROM main.master_drugs AS m",
            "SELECT (SELECT notes FROM master_drugs LIMIT 1) AS secret",
            "WITH q AS (SELECT notes AS secret FROM master_drugs) SELECT secret FROM q",
            "SELECT internal_secret AS secret FROM master_drugs",
            "SELECT * FROM (SELECT internal_secret AS secret FROM master_drugs)",
        ] {
            let row = sqlx::query(sql)
                .persistent(false)
                .fetch_one(&mut conn)
                .await
                .unwrap();
            let secret: Option<String> = row
                .try_get("secret")
                .or_else(|_| row.try_get("notes"))
                .unwrap();
            assert_eq!(secret, None, "{sql}");
        }
        let matches: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM master_drugs WHERE notes='CONFIDENTIAL-NOTE' OR internal_secret='FUTURE-PRIVATE'",
        ).persistent(false).fetch_one(&mut conn).await.unwrap();
        assert_eq!(
            matches, 0,
            "masked columns must not leak through predicates"
        );
        let materialized: i64 =
            sqlx::query_scalar("SELECT COUNT(notes)+COUNT(internal_secret) FROM master_drugs")
                .persistent(false)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            materialized, 0,
            "masked columns must not leak through aggregates"
        );
        // Legitimate global catalog references remain visible; arbitrary
        // renderer SQL cannot inspect the unrestricted notes behind them.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
            .persistent(false)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 1);
        {
            let mut handle = conn.lock_handle().await.unwrap();
            unsafe {
                libsqlite3_sys::sqlite3_set_authorizer(
                    handle.as_raw_handle().as_ptr(),
                    None,
                    ptr::null_mut(),
                );
            }
        }
        let private = sqlx::query("SELECT full_name FROM patients")
            .persistent(false)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            private.try_get::<String, _>("full_name").unwrap(),
            "PRIVATE"
        );
        let notes: String = sqlx::query_scalar("SELECT notes FROM master_drugs")
            .persistent(false)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(notes, "CONFIDENTIAL-NOTE");
    }

    #[cfg(pharma_security_release)]
    #[tokio::test]
    async fn secure_release_renderer_catalog_star_masks_confidential_and_future_fields() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE master_drugs(id INTEGER,trade_name TEXT,notes TEXT,private_future TEXT);
             CREATE TABLE sales_invoices(id TEXT,patient_id TEXT);
             INSERT INTO master_drugs VALUES(1,'Shared Medicine','PRIVATE-NOTE','PRIVATE-FUTURE');
             INSERT INTO sales_invoices VALUES('s-1','patient-secret');",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let rows = fetch_limited(
            &mut conn,
            "SELECT * FROM master_drugs",
            vec![],
            DEFAULT_READ_LIMITS,
        )
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![serde_json::json!({
                "id":1,"trade_name":"Shared Medicine","notes":null,"private_future":null,
            })]
        );
        let queried = fetch_limited(&mut conn,
            "SELECT COUNT(*) AS leaks FROM master_drugs WHERE notes='PRIVATE-NOTE' OR private_future='PRIVATE-FUTURE'",
            vec![], DEFAULT_READ_LIMITS).await.unwrap();
        assert_eq!(queried, vec![serde_json::json!({"leaks":0})]);
        assert!(fetch_limited(
            &mut conn,
            "SELECT * FROM sales_invoices",
            vec![],
            DEFAULT_READ_LIMITS
        )
        .await
        .is_err());
        // The SQLite authorizer must be cleaned up after each renderer query,
        // so trusted native commands still read their own authorized fields.
        let native: String = sqlx::query_scalar("SELECT notes FROM master_drugs")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(native, "PRIVATE-NOTE");
    }

    #[tokio::test]
    async fn bounded_reader_stops_recursion_and_restores_connection_for_next_query() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let limits = ReadLimits {
            max_duration: Duration::from_millis(25),
            max_rows: 10,
            max_bytes: 4096,
        };
        let infinite = "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1000000000) SELECT MAX(n) FROM numbers";
        assert!(fetch_limited(&mut conn, infinite, vec![], limits)
            .await
            .is_err());
        let rows = fetch_limited(&mut conn, "SELECT 42 AS answer", vec![], limits)
            .await
            .unwrap();
        assert_eq!(rows, vec![serde_json::json!({"answer":42})]);
    }

    // Non-secure QA builds exercise broad renderer SQL resource budgets;
    // commercial release deliberately rejects these private tables earlier.
    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn bounded_reader_rejects_extra_rows_and_large_results_without_poisoning_connection() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE stock(id INTEGER, name TEXT); INSERT INTO stock VALUES (1,'A'),(2,'B'),(3,'C');")
            .execute(&mut conn).await.unwrap();
        let limits = ReadLimits {
            max_duration: Duration::from_secs(2),
            max_rows: 2,
            max_bytes: 4096,
        };
        assert!(
            fetch_limited(&mut conn, "SELECT * FROM stock ORDER BY id", vec![], limits)
                .await
                .unwrap_err()
                .contains("row limit")
        );
        let tiny = ReadLimits {
            max_bytes: 10,
            ..limits
        };
        assert!(fetch_limited(
            &mut conn,
            "SELECT name FROM stock WHERE id = ?",
            vec![serde_json::json!(1)],
            tiny
        )
        .await
        .unwrap_err()
        .contains("size limit"));
        let rows = fetch_limited(
            &mut conn,
            "SELECT id FROM stock WHERE id = 1",
            vec![],
            limits,
        )
        .await
        .unwrap();
        assert_eq!(rows, vec![serde_json::json!({"id":1})]);
        assert!(fetch_limited(
            &mut conn,
            "SELECT zeroblob(9000000) AS oversized",
            vec![],
            limits
        )
        .await
        .is_err());
        let zero: i64 = sqlx::query("PRAGMA query_only")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .get(0);
        assert_eq!(zero, 0);
    }

    #[tokio::test]
    async fn cancelled_recursive_read_does_not_strand_sqlite_worker_or_pool() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let (started, started_rx) = tokio::sync::oneshot::channel::<()>();
        let writer_pool = pool.clone();
        let query = tokio::spawn(async move {
            let mut conn = writer_pool.acquire().await.unwrap();
            let _ = started.send(());
            fetch_limited(&mut conn,
                "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT MAX(x) FROM n",
                vec![], ReadLimits { max_duration: Duration::from_secs(60),
                    max_rows: 2, max_bytes: 4096 }).await
        });
        started_rx.await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        query.abort();
        let next = tokio::time::timeout(Duration::from_secs(3), async {
            let mut conn = pool.acquire().await.unwrap();
            fetch_limited(
                &mut conn,
                "SELECT 1 AS healthy",
                vec![],
                DEFAULT_READ_LIMITS,
            )
            .await
        })
        .await
        .expect("cancelled SQLite read must release its worker/pooled connection")
        .expect("subsequent read must succeed");
        assert_eq!(next, vec![serde_json::json!({"healthy":1})]);
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn generic_reads_cannot_expose_password_hash_via_star_alias_cte_or_aggregate() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users (id TEXT, username TEXT, password_hash TEXT);
            INSERT INTO users VALUES ('owner','boss','private-hash');",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        // A trusted native module may already have prepared/cached a SQL
        // statement on a reused connection. Authorization must not be skipped
        // if identical SQL later arrives from a renderer.
        let previously_prepared: String = sqlx::query_scalar("SELECT password_hash FROM users")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(previously_prepared, "private-hash");
        for sql in [
            "SELECT password_hash FROM users",
            "SELECT u.\"password_hash\" FROM users AS u",
            "SELECT * FROM users",
            "WITH c AS (SELECT password_hash FROM users) SELECT * FROM c",
            "SELECT COUNT(password_hash) FROM users",
            "SELECT (SELECT password_hash FROM users) AS secret",
        ] {
            assert!(
                fetch_limited(&mut conn, sql, vec![], DEFAULT_READ_LIMITS)
                    .await
                    .is_err(),
                "{sql}"
            );
        }
        let safe = fetch_limited(
            &mut conn,
            "SELECT id, username FROM users",
            vec![],
            DEFAULT_READ_LIMITS,
        )
        .await
        .unwrap();
        assert_eq!(
            safe,
            vec![serde_json::json!({"id":"owner","username":"boss"})]
        );
        // The per-read SQLite authorizer is removed before this trusted native
        // operation; native authentication still verifies stored hashes.
        let stored: String = sqlx::query_scalar("SELECT password_hash FROM users")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(stored, "private-hash");
    }
}
