//! Registered fail-closed detached legacy archive inspector. The command is
//! deliberately unusable until a separately authorized native custody grant
//! is installed; no renderer can provision that grant or select the archive.
//! No renderer SQL/path/digest/tenant/actor parameters; no active finance DB
//! or financial writers. NULL/blank/local_default scopes are never owned.
//! Explicit historical tenant strings are NOT independently certified rights.
//! Never provision a custody grant without an independently pinned snapshot
//! and approved source-owner authorization. Missing grants always deny.

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteOwnedBuf, Connection, Row, SqliteConnection};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::GuardedReadPool;

const ROOT_NAME: &str = "pharma-disposable-data-copies";
const ARCHIVE_NAME: &str = "production_snapshot_immutable.sqlite3";
const FOLDER_PREFIX: &str = "production-profile-qa-snapshot-";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SCANNED_ROWS: i64 = 3_000_000;
const READ_TIMEOUT: Duration = Duration::from_secs(12);

/// Only native bootstrap may provision this separately approved archive/grant.
/// A snapshot or unsigned manifest MUST NOT create its own approval. Missing
/// State is a hard-denial, including for owners of the active pharmacy.
pub(crate) struct PreapprovedLegacyArchiveGrant {
    folder: String,
    expected_sha256: [u8; 32],
    actor_id: String,
    tenant_id: String,
}

impl PreapprovedLegacyArchiveGrant {
    pub(crate) fn from_independent_native_custody(
        folder: &str, approved_sha256: &str, actor: &str, tenant: &str,
    ) -> Result<Self, String> {
        if !trusted_folder(folder) || !trusted_id(actor) || !trusted_id(tenant)
            || approved_sha256.len() != 64
            || !approved_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Detached archive has no approved native custody/grant".into());
        }
        let mut digest = [0_u8; 32];
        for (index, chunk) in approved_sha256.as_bytes().chunks_exact(2).enumerate() {
            let part = std::str::from_utf8(chunk).map_err(|_| "Invalid archive digest")?;
            digest[index] = u8::from_str_radix(part, 16)
                .map_err(|_| "Invalid archive digest")?;
        }
        Ok(Self { folder: folder.to_owned(), expected_sha256: digest,
            actor_id: actor.to_owned(), tenant_id: tenant.to_owned() })
    }

    fn authorizes(&self, actor: &str, role: &str, tenant: &str, active: bool) -> bool {
        active && role == "owner" && trusted_id(tenant)
            && actor == self.actor_id && tenant == self.tenant_id
    }
}

fn trusted_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.trim() == value
        && value != "local_default" && !value.chars().any(char::is_control)
}

fn trusted_folder(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(FOLDER_PREFIX) else { return false };
    let bytes = suffix.as_bytes();
    if bytes.len() != 41 || bytes[8] != b'-'
        || !bytes[..8].iter().all(u8::is_ascii_digit)
        || !bytes[9..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
        return false;
    }
    let month = suffix[4..6].parse::<u32>().unwrap_or(0);
    let day = suffix[6..8].parse::<u32>().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

#[derive(Default, Debug, PartialEq, Eq)]
struct ScopeTotals { tenant: i64, null: i64, blank: i64, placeholder: i64, other: i64 }

// Pure classification mirrors the native fixed SQL. A similar prefix, case
// change or a space after the tenant ID does not gain archive access.
fn classify(scope: Option<&str>, tenant: &str) -> &'static str {
    match scope {
        None => "null",
        Some(s) if s.trim().is_empty() => "blank",
        Some("local_default") => "placeholder",
        Some(s) if s == tenant => "tenant",
        _ => "other",
    }
}

fn add_count(totals: &mut ScopeTotals, category: &str, amount: i64) -> Result<(), String> {
    if !(0..=MAX_SCANNED_ROWS).contains(&amount) {
        return Err("Archive scope aggregate out of bounds".into());
    }
    let count = match category {
        "tenant" => &mut totals.tenant, "null" => &mut totals.null,
        "blank" => &mut totals.blank, "placeholder" => &mut totals.placeholder,
        "other" => &mut totals.other,
        _ => return Err("Unrecognized archive scope category".into()),
    };
    *count = count.checked_add(amount)
        .filter(|total| *total <= MAX_SCANNED_ROWS)
        .ok_or("Archive aggregate exceeds row cap")?;
    Ok(())
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitScopeBusinessCounts {
    inventory: i64, sale_headers: i64, purchase_headers: i64,
    journal_headers: i64, cash_movements: i64, user_rows: i64,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpaqueQuarantineCounts {
    null_scope: i64, blank_scope: i64, local_default_scope: i64, other_scope: i64,
}

/// Historical foreign-key *structure* is not prospective directory ownership.
/// Every tenant-scoped source row is counted exactly once; unknown parent IDs
/// stay unresolved even when SQLite affinity can coerce their storage type.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalIndirectLinkCounts {
    scoped_source_headers: i64,
    null_parent_reference: i64,
    typed_parent_present: i64,
    coercion_only_parent: i64,
    missing_parent: i64,
    tenant_ownership_inferred: bool,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalIndirectSourceGraph {
    sale_to_patient: HistoricalIndirectLinkCounts,
    purchase_to_supplier: HistoricalIndirectLinkCounts,
    historic_directory_ownership_certified: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchiveFacts {
    read_only: bool,
    authenticated_active_owner_granted: bool,
    independent_digest_matched: bool,
    explicit_scope_business_counts: ExplicitScopeBusinessCounts,
    opaque_quarantine_counts: OpaqueQuarantineCounts,
    historical_indirect_source_graph: HistoricalIndirectSourceGraph,
    historical_ownership_certified: bool,
    financial_amounts_certified: bool,
    financial_writer_available: bool,
}

// Frozen tables and SQL. No dynamic identifiers, row projection, payments,
// patient names, supplier names, account balances or financial math are sent.
// All category counts are combined across fixed tables to limit disclosure.
const SCOPE_SQL: [&str; 6] = [
    "SELECT COUNT(*) AS n, SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id=? THEN 1 ELSE 0 END) AS own,
       SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)='' THEN 1 ELSE 0 END) AS blank,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id='local_default' THEN 1 ELSE 0 END) AS placeholder FROM main.inventory",
    "SELECT COUNT(*) AS n, SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id=? THEN 1 ELSE 0 END) AS own,
       SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)='' THEN 1 ELSE 0 END) AS blank,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id='local_default' THEN 1 ELSE 0 END) AS placeholder FROM main.sales_invoices",
    "SELECT COUNT(*) AS n, SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id=? THEN 1 ELSE 0 END) AS own,
       SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)='' THEN 1 ELSE 0 END) AS blank,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id='local_default' THEN 1 ELSE 0 END) AS placeholder FROM main.purchase_invoices",
    "SELECT COUNT(*) AS n, SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id=? THEN 1 ELSE 0 END) AS own,
       SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)='' THEN 1 ELSE 0 END) AS blank,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id='local_default' THEN 1 ELSE 0 END) AS placeholder FROM main.daily_journals",
    "SELECT COUNT(*) AS n, SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id=? THEN 1 ELSE 0 END) AS own,
       SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)='' THEN 1 ELSE 0 END) AS blank,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id='local_default' THEN 1 ELSE 0 END) AS placeholder FROM main.cash_movements",
    "SELECT COUNT(*) AS n, SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id=? THEN 1 ELSE 0 END) AS own,
       SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)='' THEN 1 ELSE 0 END) AS blank,
       SUM(CASE WHEN typeof(pharmacy_id)='text' AND pharmacy_id='local_default' THEN 1 ELSE 0 END) AS placeholder FROM main.users",
];

// Exact, fixed historical SOURCE edges, not ownership witnesses. Deliberately
// no JOIN that can multiply rows if historic global IDs or collations differ.
// Prospective native_patient_directory_ownership and
// native_supplier_directory_ownership are *separate* v61/v62 evidence; they
// must not be manufactured or inferred from these old invoice references.
const INDIRECT_SOURCE_SQL: [&str; 2] = [
    "SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN s.patient_id IS NULL THEN 1 ELSE 0 END),0) AS blank_ref,
       COALESCE(SUM(CASE WHEN s.patient_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM main.patients p WHERE typeof(p.id)=typeof(s.patient_id)
           AND p.id COLLATE BINARY=s.patient_id COLLATE BINARY
       ) THEN 1 ELSE 0 END),0) AS typed_match,
       COALESCE(SUM(CASE WHEN s.patient_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM main.patients p WHERE typeof(p.id)=typeof(s.patient_id)
           AND p.id COLLATE BINARY=s.patient_id COLLATE BINARY
       ) AND EXISTS (
         SELECT 1 FROM main.patients p
         WHERE CAST(p.id AS TEXT)=CAST(s.patient_id AS TEXT)
       ) THEN 1 ELSE 0 END),0) AS affinity_match
     FROM main.sales_invoices s
     WHERE typeof(s.pharmacy_id)='text' AND s.pharmacy_id=?",
    "SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN s.supplier_id IS NULL THEN 1 ELSE 0 END),0) AS blank_ref,
       COALESCE(SUM(CASE WHEN s.supplier_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM main.suppliers p WHERE typeof(p.id)=typeof(s.supplier_id)
           AND p.id COLLATE BINARY=s.supplier_id COLLATE BINARY
       ) THEN 1 ELSE 0 END),0) AS typed_match,
       COALESCE(SUM(CASE WHEN s.supplier_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM main.suppliers p WHERE typeof(p.id)=typeof(s.supplier_id)
           AND p.id COLLATE BINARY=s.supplier_id COLLATE BINARY
       ) AND EXISTS (
         SELECT 1 FROM main.suppliers p
         WHERE CAST(p.id AS TEXT)=CAST(s.supplier_id AS TEXT)
       ) THEN 1 ELSE 0 END),0) AS affinity_match
     FROM main.purchase_invoices s
     WHERE typeof(s.pharmacy_id)='text' AND s.pharmacy_id=?",
];

fn checked_indirect_source(
    row: &sqlx::sqlite::SqliteRow, expected_headers: i64,
) -> Result<HistoricalIndirectLinkCounts, String> {
    let value = |key| -> Result<i64, String> {
        row.try_get::<i64, _>(key)
            .map_err(|_| "Historical source relationship count is not integral".into())
    };
    let (n, null, typed, coerced) = (
        value("n")?, value("blank_ref")?, value("typed_match")?,
        value("affinity_match")?,
    );
    if n != expected_headers || !(0..=MAX_SCANNED_ROWS).contains(&n)
        || [null, typed, coerced].iter().any(|x| !(0..=n).contains(x)) {
        return Err("Historical source edge census disagrees with direct scope".into());
    }
    let missing = n.checked_sub(null).and_then(|n| n.checked_sub(typed))
        .and_then(|n| n.checked_sub(coerced))
        .ok_or("Historical source edge partition is incomplete")?;
    Ok(HistoricalIndirectLinkCounts {
        scoped_source_headers: n, null_parent_reference: null,
        typed_parent_present: typed, coercion_only_parent: coerced,
        missing_parent: missing, tenant_ownership_inferred: false,
    })
}

fn checked_scope_row(row: &sqlx::sqlite::SqliteRow) -> Result<(ScopeTotals, i64), String> {
    let number = |key| -> Result<i64, String> {
        let v: Option<i64> = row.try_get(key)
            .map_err(|_| "Detached archive scope is not integral".to_owned())?;
        Ok(v.unwrap_or(0))
    };
    let n = number("n")?;
    let own = number("own")?;
    let missing = number("missing")?;
    let blank = number("blank")?;
    let placeholder = number("placeholder")?;
    if !(0..=MAX_SCANNED_ROWS).contains(&n)
        || [own, missing, blank, placeholder].iter()
            .any(|x| !(0..=MAX_SCANNED_ROWS).contains(x)) {
        return Err("Detached archive source count unbounded".into());
    }
    let other = n.checked_sub(own).and_then(|v| v.checked_sub(missing))
        .and_then(|v| v.checked_sub(blank))
        .and_then(|v| v.checked_sub(placeholder))
        .ok_or("Contradictory detached archive scope classification")?;
    Ok((ScopeTotals { tenant: own, null: missing, blank, placeholder, other }, n))
}

/// Source facts only, never historic ownership or financial reconciliation.
/// A missing table/column is an error, not empty history.
async fn inspect_source(
    db: &mut SqliteConnection, tenant: &str,
) -> Result<LegacyArchiveFacts, String> {
    let mut explicit = ExplicitScopeBusinessCounts::default();
    let mut indirect = HistoricalIndirectSourceGraph::default();
    let mut quarantine = ScopeTotals::default();
    let mut scanned = 0_i64;
    tokio::time::timeout(READ_TIMEOUT, async {
        for (index, statement) in SCOPE_SQL.iter().enumerate() {
            let row = sqlx::query(statement).bind(tenant)
                .fetch_one(&mut *db).await
                .map_err(|_| "Required archived direct tenant source missing")?;
            let (counts, total) = checked_scope_row(&row)?;
            scanned = scanned.checked_add(total)
                .filter(|value| *value <= MAX_SCANNED_ROWS)
                .ok_or("Bounded archive source scan exceeded")?;
            match index {
                0 => explicit.inventory = counts.tenant,
                1 => explicit.sale_headers = counts.tenant,
                2 => explicit.purchase_headers = counts.tenant,
                3 => explicit.journal_headers = counts.tenant,
                4 => explicit.cash_movements = counts.tenant,
                5 => explicit.user_rows = counts.tenant,
                _ => return Err("Non-preapproved source projection".into()),
            }
            for (kind, value) in [
                ("null", counts.null), ("blank", counts.blank),
                ("placeholder", counts.placeholder), ("other", counts.other),
            ] {
                add_count(&mut quarantine, kind, value)?;
            }
        }
        for (index, statement) in INDIRECT_SOURCE_SQL.iter().enumerate() {
            let row = sqlx::query(statement).bind(tenant)
                .fetch_one(&mut *db).await
                .map_err(|_| "Required historical relationship source missing")?;
            let expected = if index == 0 { explicit.sale_headers } else {
                explicit.purchase_headers
            };
            let counts = checked_indirect_source(&row, expected)?;
            match index {
                0 => indirect.sale_to_patient = counts,
                1 => indirect.purchase_to_supplier = counts,
                _ => return Err("Non-preapproved indirect source projection".into()),
            }
        }
        Ok::<(), String>(())
    }).await.map_err(|_| "Detached archive source scan timed out")??;
    Ok(LegacyArchiveFacts {
        read_only: true,
        authenticated_active_owner_granted: true,
        independent_digest_matched: true,
        explicit_scope_business_counts: explicit,
        historical_indirect_source_graph: indirect,
        opaque_quarantine_counts: OpaqueQuarantineCounts {
            null_scope: quarantine.null, blank_scope: quarantine.blank,
            local_default_scope: quarantine.placeholder, other_scope: quarantine.other,
        },
        historical_ownership_certified: false,
        financial_amounts_certified: false,
        financial_writer_available: false,
    })
}

fn ordinary_component(path: &Path, directory: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Detached archive path component not present")?;
    if meta.file_type().is_symlink() || (directory && !meta.is_dir())
        || (!directory && !meta.is_file()) {
        return Err("Detached archive contains unsupported path indirection".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Archive path contains a reparse point/junction".into());
        }
    }
    Ok(())
}

fn fixed_archive_path(grant: &PreapprovedLegacyArchiveGrant) -> Result<PathBuf, String> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")
        .ok_or("Trusted native local app data location missing")?);
    if !local.is_absolute() || !trusted_folder(&grant.folder) {
        return Err("Unapproved detached archive location".into());
    }
    ordinary_component(&local, true)?;
    let root = local.join(ROOT_NAME);
    let folder = root.join(&grant.folder);
    let archive = folder.join(ARCHIVE_NAME);
    ordinary_component(&root, true)?;
    ordinary_component(&folder, true)?;
    ordinary_component(&archive, false)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        if archive.with_file_name(format!("{ARCHIVE_NAME}{suffix}")).exists() {
            return Err("Detached archive has active SQLite sidecar".into());
        }
    }
    if fs::metadata(&archive).map_err(|_| "Unreadable detached archive metadata")?
        .len() > MAX_ARCHIVE_BYTES {
        return Err("Detached archive exceeds fixed file limit".into());
    }
    Ok(archive)
}

#[cfg(windows)]
fn locked_read_handle(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ only. No existing writer may share this handle; a later
    // write/delete cannot replace the inspected source while it stays open.
    OpenOptions::new().read(true).share_mode(0x0000_0001)
        .open(path).map_err(|_| "Cannot lock detached archive for read-only custody".into())
}
#[cfg(not(windows))]
fn locked_read_handle(_path: &Path) -> Result<File, String> {
    Err("Independent archive file identity needs a Windows read-sharing lock".into())
}

fn digest_locked(handle: &mut File) -> Result<[u8; 32], String> {
    handle.seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot rewind detached archive handle")?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let count = handle.read(&mut buffer).map_err(|_| "Cannot read archived bytes")?;
        if count == 0 { break; }
        size = size.checked_add(count as u64)
            .filter(|n| *n <= MAX_ARCHIVE_BYTES)
            .ok_or("Detached archive exceeds byte limit")?;
        digest.update(&buffer[..count]);
    }
    if size == 0 { return Err("Detached archive is empty".into()); }
    Ok(digest.finalize().into())
}

/// Read only from the already locked source handle. Never open a second SQLite
/// connection by its pathname: a parent directory could be renamed/replaced
/// between the pinned file hash and SQLite's separate path-based open. In that
/// case the old post-read hash still checks the original handle, not SQLite's
/// substitute database. Reading and deserializing these exact bytes closes
/// that source-identity TOCTOU without authorizing any filesystem writes.
fn read_locked_snapshot<R: Read + Seek>(handle: &mut R) -> Result<Vec<u8>, String> {
    handle.seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot rewind detached archive handle")?;
    let mut bytes = Vec::new();
    handle.take(MAX_ARCHIVE_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| "Cannot read locked detached archive snapshot")?;
    if bytes.len() < 100 || bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("Locked archive snapshot has an unsupported size".into());
    }
    Ok(bytes)
}

/// The only SQLite connection that inspects archive rows is an in-memory,
/// read-only deserialization of the SHA-pinned *locked handle bytes*.
async fn inspect_pinned_snapshot(
    snapshot: Vec<u8>, expected_sha256: [u8; 32], tenant: &str,
) -> Result<LegacyArchiveFacts, String> {
    if snapshot.len() < 100 || snapshot.len() as u64 > MAX_ARCHIVE_BYTES
        || !snapshot.starts_with(b"SQLite format 3\0")
        // WAL-mode base-file bytes omit sidecar records, even if that sidecar
        // was moved just before inspection. Such a file cannot prove custody.
        || snapshot[18..20] != [1, 1]
    {
        return Err("Pinned archive is not a complete rollback-mode SQLite snapshot".into());
    }
    if <[u8; 32]>::from(Sha256::digest(&snapshot)) != expected_sha256 {
        return Err("Archive differs from separately preapproved digest".into());
    }
    // SQLx allocates this buffer with sqlite3_malloc, and transfers its
    // ownership to SQLite. Discard the source Vec before scanning so the
    // duplicate transient copy is not retained for the whole read.
    let data = SqliteOwnedBuf::try_from(snapshot.as_slice())
        .map_err(|_| "Cannot allocate read-only pinned archive snapshot")?;
    drop(snapshot);
    let mut db = SqliteConnection::connect("sqlite::memory:").await
        .map_err(|_| "Cannot establish in-memory archive reader")?;
    db.deserialize(None, data, true).await
        .map_err(|_| "Cannot load pinned archive in read-only memory")?;
    sqlx::query("PRAGMA query_only=ON").execute(&mut db).await
        .map_err(|_| "Cannot enforce query-only archive connection")?;
    let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
        .fetch_one(&mut db).await.map_err(|_| "Cannot verify query-only mode")?;
    if query_only != 1 { return Err("Archive is not query-only".into()); }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db).await.map_err(|_| "Archived source integrity unreadable")?;
    if integrity != "ok" { return Err("Archived source integrity failed".into()); }
    if sqlx::query("PRAGMA foreign_key_check").fetch_optional(&mut db).await
        .map_err(|_| "Archived foreign-key integrity unreadable")?.is_some() {
        return Err("Archived source has broken foreign keys".into());
    }
    let facts = inspect_source(&mut db, tenant).await?;
    db.close().await.map_err(|_| "Read-only archive connection failed to close")?;
    Ok(facts)
}

async fn inspect_approved(grant: &PreapprovedLegacyArchiveGrant) -> Result<LegacyArchiveFacts, String> {
    let path = fixed_archive_path(grant)?;
    let mut held = locked_read_handle(&path)?;
    let snapshot = read_locked_snapshot(&mut held)?;
    let facts = inspect_pinned_snapshot(snapshot, grant.expected_sha256, &grant.tenant_id).await?;
    // Detect even a changed original file: the source was only read from the
    // already pinned immutable in-memory copy, never any reopened pathname.
    if digest_locked(&mut held)? != grant.expected_sha256 {
        return Err("Detached archive changed during source inspection".into());
    }
    Ok(facts)
}

/// Recheck the live identity on both sides of detached source inspection.
/// This must require an explicitly active owner; nullable legacy account
/// flags cannot silently become independent custody authorization.
async fn permitted(
    db: &mut SqliteConnection, actor: &str,
    grant: &PreapprovedLegacyArchiveGrant,
) -> Result<bool, String> {
    let rows = sqlx::query(
        "SELECT role, pharmacy_id, is_active AS active
         FROM main.users WHERE CAST(id AS TEXT)=? LIMIT 2")
        .bind(actor).fetch_all(db).await
        .map_err(|_| "Cannot certify active archive reader")?;
    if rows.len() != 1 { return Ok(false); }
    let role: Option<String> = rows[0].try_get("role")
        .map_err(|_| "Invalid active reader role")?;
    let tenant: Option<String> = rows[0].try_get("pharmacy_id")
        .map_err(|_| "Invalid active reader pharmacy")?;
    let active: Option<i64> = rows[0].try_get("active")
        .map_err(|_| "Invalid active reader status")?;
    Ok(grant.authorizes(actor, role.as_deref().unwrap_or(""),
        tenant.as_deref().unwrap_or(""), active == Some(1)))
}

/// Intentionally zero IPC parameters. Registration by the prime is only safe
/// AFTER independent immutable snapshot custody and explicit bootstrap grant.
#[tauri::command]
pub async fn read_legacy_archive_scope_facts_native(
    app: tauri::AppHandle, session: State<'_, LocalSessionState>,
) -> Result<LegacyArchiveFacts, String> {
    let guard = session.authorize_session().await?;
    let actor = guard.as_deref().ok_or("Native owner login required")?;
    let grant = app.try_state::<PreapprovedLegacyArchiveGrant>()
        .ok_or("Archive reading has not been independently authorized")?;
    let pool = app.try_state::<GuardedReadPool>()
        .ok_or("Live native identity database unavailable")?;
    let mut live = pool.0.acquire().await
        .map_err(|_| "Cannot read active owner authorization")?;
    // Explicit raw pharmacy_id; no normalize-to-local_default alias.
    if !permitted(&mut live, actor, &grant).await? {
        return Err("Native archive grant or live owner scope is not verified".into());
    }
    let facts = inspect_approved(&grant).await?;
    if !permitted(&mut live, actor, &grant).await? {
        return Err("Native archive reader access changed during inspection".into());
    }
    // Holding LocalSessionState guard prevents logout throughout inspection.
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOLDER: &str = "production-profile-qa-snapshot-20261017-0123456789abcdef0123456789abcdef";

    fn approved() -> PreapprovedLegacyArchiveGrant {
        PreapprovedLegacyArchiveGrant::from_independent_native_custody(
            FOLDER, &"a".repeat(64), "owner", "ph-a",
        ).expect("synthetic separately preapproved grant")
    }

    #[test]
    fn rejects_untrusted_folder_digest_and_archive_grant() {
        assert!(trusted_folder(FOLDER));
        assert_eq!(ARCHIVE_NAME, "production_snapshot_immutable.sqlite3");
        for name in [
            "../production-profile-qa-snapshot-20261017-0123456789abcdef0123456789abcdef",
            "production-profile-qa-snapshot-20261317-0123456789abcdef0123456789abcdef",
            "production-profile-qa-snapshot-20261017-0123456789abcdef0123456789abcdeF",
            "production-profile-qa-snapshot-20261017-0123456789abcdef0123456789abcdef/a",
            "production-profile-qa-snapshot-20261017-0123456789abcdef0123456789abcdeg",
        ] {
            assert!(!trusted_folder(name));
        }
        for (digest, actor, tenant) in [
            ("untrusted", "owner", "ph-a"),
            ("", "owner", "ph-a"),
            ("", "owner", "local_default"),
            ("", "owner", " "),
        ] {
            assert!(PreapprovedLegacyArchiveGrant::from_independent_native_custody(
                FOLDER, digest, actor, tenant,
            ).is_err());
        }
    }

    #[test]
    fn live_owner_role_explicit_archive_grant_and_tenant_must_all_match() {
        assert!(approved().authorizes("owner", "owner", "ph-a", true));
        for (actor, role, tenant, active) in [
            ("different-owner", "owner", "ph-a", true),
            ("owner", "admin", "ph-a", true),
            ("owner", "cashier", "ph-a", true),
            ("owner", "owner", "ph-b", true),
            ("owner", "owner", "local_default", true),
            ("owner", "owner", "ph-a ", true),
            ("owner", "owner", "ph-a", false),
        ] {
            assert!(!approved().authorizes(actor, role, tenant, active));
        }
    }

    #[test]
    fn ambiguous_legacy_tenant_labels_never_promote_to_archive_owner() {
        for (scope, kind) in [
            (None, "null"),
            (Some(""), "blank"),
            (Some(" "), "blank"),
            (Some("local_default"), "placeholder"),
            (Some("ph-a"), "tenant"),
            (Some("ph-a "), "other"),
            (Some("ph-ab"), "other"),
            (Some("PH-A"), "other"),
            (Some("ph-b"), "other"),
        ] {
            assert_eq!(classify(scope, "ph-a"), kind);
        }
        let mut counts = ScopeTotals::default();
        for row in [None, Some(""), Some("local_default"), Some("ph-a"), Some("ph-b")] {
            add_count(&mut counts, classify(row, "ph-a"), 1).unwrap();
        }
        assert_eq!(counts, ScopeTotals { tenant: 1, null: 1,
            blank: 1, placeholder: 1, other: 1 });
        assert!(add_count(&mut counts, "tenant", -1).is_err());
        assert!(add_count(&mut counts, "other", MAX_SCANNED_ROWS).is_err());
    }

    #[tokio::test]
    async fn disposable_memory_database_only_exposes_direct_scope_counts() {
        // The test owns ONLY an in-memory synthetic SQLite database. No
        // physical archive, live patient, ledger, writer, or GUI is touched.
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE patients(id TEXT PRIMARY KEY)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE suppliers(id INTEGER PRIMARY KEY)")
            .execute(&mut db).await.unwrap();
        for table in [
            "inventory", "sales_invoices", "purchase_invoices",
            "daily_journals", "cash_movements", "users",
        ] {
            let ddl = match table {
                "sales_invoices" => "CREATE TABLE sales_invoices(pharmacy_id TEXT,patient_id TEXT)".to_owned(),
                "purchase_invoices" => "CREATE TABLE purchase_invoices(pharmacy_id TEXT,supplier_id INTEGER)".to_owned(),
                _ => format!("CREATE TABLE {table}(pharmacy_id TEXT)"),
            };
            sqlx::query(&ddl).execute(&mut db).await.unwrap();
            for scope in [
                Some("ph-a"), Some("ph-a"), None, Some(""), Some(" "),
                Some("local_default"), Some("ph-b"),
            ] {
                let insert = format!("INSERT INTO {table}(pharmacy_id) VALUES (?)");
                sqlx::query(&insert).bind(scope).execute(&mut db).await.unwrap();
            }
        }
        let facts = inspect_source(&mut db, "ph-a").await.unwrap();
        assert!(facts.read_only);
        assert_eq!(facts.explicit_scope_business_counts, ExplicitScopeBusinessCounts {
            inventory: 2, sale_headers: 2, purchase_headers: 2,
            journal_headers: 2, cash_movements: 2, user_rows: 2,
        });
        assert_eq!(facts.opaque_quarantine_counts, OpaqueQuarantineCounts {
            null_scope: 6, blank_scope: 12, local_default_scope: 6, other_scope: 6,
        });
        assert_eq!(facts.historical_indirect_source_graph.sale_to_patient.scoped_source_headers, 2);
        assert_eq!(facts.historical_indirect_source_graph.sale_to_patient.null_parent_reference, 2);
        assert_eq!(facts.historical_indirect_source_graph.purchase_to_supplier.null_parent_reference, 2);
        assert!(!facts.historical_indirect_source_graph.historic_directory_ownership_certified);
        assert!(!facts.historical_ownership_certified);
        assert!(!facts.financial_amounts_certified);
        assert!(!facts.financial_writer_available);
        assert!(!serde_json::to_string(&facts).unwrap().contains("ph-a"));
    }

    #[tokio::test]
    async fn unknown_schema_fails_instead_of_inventing_zero_financial_history() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE inventory(pharmacy_id TEXT)").execute(&mut db)
            .await.unwrap();
        assert!(inspect_source(&mut db, "ph-a").await.is_err());
        let mut wrong = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE inventory(legacy_scope TEXT)").execute(&mut wrong)
            .await.unwrap();
        assert!(inspect_source(&mut wrong, "ph-a").await.is_err());
    }

    #[tokio::test]
    async fn live_archive_approval_rejects_legacy_null_or_inactive_accounts() {
        let mut live = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER)"
        ).execute(&mut live).await.unwrap();
        for (id, role, tenant, active) in [
            ("owner", "owner", "ph-a", Some(1_i64)),
            ("null-owner", "owner", "ph-a", None),
            ("off-owner", "owner", "ph-a", Some(0)),
            ("wrong-role", "admin", "ph-a", Some(1)),
            ("wrong-scope", "owner", "ph-b", Some(1)),
        ] {
            sqlx::query("INSERT INTO users VALUES(?,?,?,?)")
                .bind(id).bind(role).bind(tenant).bind(active)
                .execute(&mut live).await.unwrap();
        }
        let grant = approved();
        assert!(permitted(&mut live, "owner", &grant).await.unwrap());
        sqlx::query("UPDATE users SET is_active=NULL WHERE id='owner'")
            .execute(&mut live).await.unwrap();
        assert!(!permitted(&mut live, "owner", &grant).await.unwrap(),
                "legacy NULL is_active must never authorize archive inspection");
        for id in ["null-owner", "off-owner", "wrong-role", "wrong-scope", "missing"] {
            assert!(!permitted(&mut live, id, &grant).await.unwrap());
        }
    }

    #[tokio::test]
    async fn pinned_locked_snapshot_is_the_exact_read_only_source_not_a_second_path() {
        // All source data is synthetic SQLite RAM. No physical archive, active
        // customer DB, archive file writes, GUI, or signer authority exists.
        let mut source = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE patients(id TEXT PRIMARY KEY)")
            .execute(&mut source).await.unwrap();
        sqlx::query("CREATE TABLE suppliers(id INTEGER PRIMARY KEY)")
            .execute(&mut source).await.unwrap();
        for table in [
            "inventory", "sales_invoices", "purchase_invoices",
            "daily_journals", "cash_movements", "users",
        ] {
            let ddl = match table {
                "sales_invoices" => "CREATE TABLE sales_invoices(pharmacy_id TEXT,patient_id TEXT)".to_owned(),
                "purchase_invoices" => "CREATE TABLE purchase_invoices(pharmacy_id TEXT,supplier_id INTEGER)".to_owned(),
                _ => format!("CREATE TABLE {table}(pharmacy_id TEXT)"),
            };
            sqlx::query(&ddl)
                .execute(&mut source).await.unwrap();
            sqlx::query(&format!("INSERT INTO {table}(pharmacy_id) VALUES(?)"))
                .bind("ph-a").execute(&mut source).await.unwrap();
        }
        let serialized = source.serialize(None).await.unwrap();
        let pinned = serialized.to_vec();
        let digest: [u8; 32] = Sha256::digest(&pinned).into();
        let result = inspect_pinned_snapshot(pinned.clone(), digest, "ph-a")
            .await.unwrap();
        assert!(result.read_only);
        assert_eq!(result.explicit_scope_business_counts,
            ExplicitScopeBusinessCounts {
                inventory: 1, sale_headers: 1, purchase_headers: 1,
                journal_headers: 1, cash_movements: 1, user_rows: 1,
            });
        assert!(!result.historical_ownership_certified);
        assert!(!result.financial_writer_available);
        assert!(inspect_pinned_snapshot(pinned.clone(), [0; 32], "ph-a")
            .await.is_err(), "unapproved bytes cannot be inspected");

        let mut changed = pinned.clone();
        let source_marker = b"ph-a";
        let offset = changed.windows(source_marker.len())
            .position(|window| window == source_marker)
            .expect("synthetic tenant bytes exist in serialized fixture");
        changed[offset..offset + source_marker.len()].copy_from_slice(b"ph-b");
        assert!(inspect_pinned_snapshot(changed, digest, "ph-a")
            .await.is_err(), "a second substituted snapshot must fail its pin");

        let mut wal = pinned.clone();
        wal[18..20].copy_from_slice(&[2, 2]);
        let wal_digest: [u8; 32] = Sha256::digest(&wal).into();
        assert!(inspect_pinned_snapshot(wal, wal_digest, "ph-a").await.is_err(),
            "WAL base files cannot prove full source custody");

        let mut locked = std::io::Cursor::new(pinned.clone());
        locked.set_position(27);
        assert_eq!(read_locked_snapshot(&mut locked).unwrap(), pinned,
            "source must be read from the beginning of the existing handle");
        assert!(read_locked_snapshot(&mut std::io::Cursor::new(vec![1u8; 50]))
            .is_err(), "truncated source files must be rejected");
    }

    #[tokio::test]
    async fn indirect_historic_patient_supplier_links_do_not_mint_ownership_or_hide_missing_rows() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE patients(id TEXT PRIMARY KEY)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE suppliers(id INTEGER PRIMARY KEY)")
            .execute(&mut db).await.unwrap();
        for name in ["inventory", "daily_journals", "cash_movements", "users"] {
            sqlx::query(&format!("CREATE TABLE {name}(pharmacy_id TEXT)"))
                .execute(&mut db).await.unwrap();
        }
        // BLOB affinity preserves the original SQLite storage class for the
        // coercion-only negative cases, independently of normal FK affinity.
        sqlx::query("CREATE TABLE sales_invoices(pharmacy_id TEXT,patient_id BLOB)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE purchase_invoices(pharmacy_id TEXT,supplier_id BLOB)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO patients VALUES('patient-synthetic'),('7')")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO suppliers VALUES(7)").execute(&mut db).await.unwrap();
        for (scope, id) in [
            ("ph-a", Some("patient-synthetic")), ("ph-a", None),
            ("ph-a", Some("missing-patient")), ("ph-b", Some("patient-synthetic")),
        ] {
            sqlx::query("INSERT INTO sales_invoices VALUES(?,?)")
                .bind(scope).bind(id).execute(&mut db).await.unwrap();
        }
        sqlx::query("INSERT INTO sales_invoices VALUES('ph-a',7)")
            .execute(&mut db).await.unwrap();
        for (scope, id) in [
            ("ph-a", Some(7_i64)), ("ph-a", None),
            ("ph-a", Some(99)), ("ph-b", Some(7)),
        ] {
            sqlx::query("INSERT INTO purchase_invoices VALUES(?,?)")
                .bind(scope).bind(id).execute(&mut db).await.unwrap();
        }
        sqlx::query("INSERT INTO purchase_invoices VALUES('ph-a','7')")
            .execute(&mut db).await.unwrap();
        let facts = inspect_source(&mut db, "ph-a").await.unwrap();
        let patient = &facts.historical_indirect_source_graph.sale_to_patient;
        let supplier = &facts.historical_indirect_source_graph.purchase_to_supplier;
        assert_eq!(
            (patient.scoped_source_headers, patient.typed_parent_present,
             patient.null_parent_reference, patient.coercion_only_parent,
             patient.missing_parent),
            (4, 1, 1, 1, 1)
        );
        assert_eq!(
            (supplier.scoped_source_headers, supplier.typed_parent_present,
             supplier.null_parent_reference, supplier.coercion_only_parent,
             supplier.missing_parent),
            (4, 1, 1, 1, 1)
        );
        assert_eq!(facts.explicit_scope_business_counts.sale_headers, 4);
        assert_eq!(facts.explicit_scope_business_counts.purchase_headers, 4);
        assert!(!patient.tenant_ownership_inferred && !supplier.tenant_ownership_inferred);
        assert!(!facts.historical_indirect_source_graph.historic_directory_ownership_certified);
        let serialized = serde_json::to_string(&facts).unwrap();
        for forbidden in ["patient-synthetic", "missing-patient", "ph-a", "ph-b"] {
            assert!(!serialized.contains(forbidden), "No private source values in facts");
        }
    }
}
