//! Explicit, original-owner-signed, COPY-ONLY tenant repair for detached v52/v67.
//!
//! This module is deliberately NOT registered with startup or IPC. Production
//! integration must first independently enroll the ORIGINAL owner Ed25519 key
//! and source-v29 SHA256 in native custody (never from the source DB, renderer,
//! unsigned evidence, historical bcrypt, or an activation/license token).
//! Missing enrollment is a hard error. The input is an already-consistent,
//! SHA-pinned disposable snapshot, not a running customer profile. The caller
//! may install neither a resulting copy nor owner permissions on this result
//! alone. No source file is opened for write, checkpointed, or migrated.

use futures_util::StreamExt;
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const DENIED: &str = "Signed original-owner source-bound copy-only upgrade required";
const TENANT: &str = "primary_pharmacy";
const DOMAIN: &[u8] = b"pharma/native/copy-only-v52-v67-primary-pharmacy/v1\0";
const MAX_AGE_SECONDS: u64 = 30 * 24 * 3600;

/// The signature binds one detached file, one full typed scope census, the
/// original historical owner and its v29 custody digest. The ticket carries
/// NO signer/public key or trusted owner selection. The native trusted key is
/// compiled from separately authenticated local owner-custody pins.
pub(crate) struct SignedCopyOnlyTicket {
    pub(crate) source_sha256: [u8; 32],
    pub(crate) scope_sha256: [u8; 32],
    pub(crate) nonce: [u8; 32],
    pub(crate) expires_unix_seconds: u64,
    pub(crate) ed25519_signature: [u8; 64],
}

struct TrustedOriginalOwner {
    id: String,
    key: [u8; 32],
    sealed_v29_sha256: [u8; 32],
}

/// The only production entry to trust construction. A source/sidecar/argv
/// cannot choose the trust anchor. Ordinary builds without owner enrollment
/// fail closed without creating a disposable output.
fn independently_enrolled_owner() -> Result<TrustedOriginalOwner, &'static str> {
    let (Some(id), Some(key), Some(seal)) = (
        option_env!("PHARMA_NATIVE_OWNER_ID"),
        option_env!("PHARMA_NATIVE_OWNER_ED25519_PUBLIC_HEX"),
        option_env!("PHARMA_NATIVE_OWNER_ORIGINAL_V29_SHA256_HEX"),
    ) else {
        return Err(DENIED);
    };
    if id.is_empty()
        || id.len() > 128
        || !id.is_ascii()
        || id.trim() != id
        || id.bytes().any(|c| c.is_ascii_control())
    {
        return Err(DENIED);
    }
    let trusted = TrustedOriginalOwner {
        id: id.to_string(),
        key: parse_hex::<32>(key)?,
        sealed_v29_sha256: parse_hex::<32>(seal)?,
    };
    if trusted.key.iter().all(|b| *b == 0) || trusted.sealed_v29_sha256.iter().all(|b| *b == 0) {
        return Err(DENIED);
    }
    Ok(trusted)
}

fn parse_hex<const N: usize>(value: &str) -> Result<[u8; N], &'static str> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DENIED);
    }
    let mut result = [0_u8; N];
    for (i, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 * i..2 * i + 2], 16).map_err(|_| DENIED)?;
    }
    Ok(result)
}

fn framed(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn checked_component(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DENIED)?;
    if metadata.file_type().is_symlink() {
        return Err(DENIED);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // NTFS junctions and other reparse-point aliases are not always
        // exposed as Rust symlinks. Never follow one to a live profile.
        if metadata.file_attributes() & 0x0400 != 0 {
            return Err(DENIED);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn require_single_hard_link(file: &File) -> Result<(), &'static str> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct FileInformation {
        attrs: u32,
        created: FileTime,
        accessed: FileTime,
        modified: FileTime,
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            info: *mut FileInformation,
        ) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<FileInformation>::uninit();
    // SAFETY: File owns an open Win32 handle, and GetFileInformationByHandle
    // writes a complete structure only when it reports success.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(DENIED);
    }
    if unsafe { info.assume_init().links } != 1 {
        return Err(DENIED);
    }
    Ok(())
}

fn checked_detached_source(source: &Path, root: &Path) -> Result<Vec<u8>, &'static str> {
    if !source.is_file()
        || !source.is_absolute()
        || !root.is_dir()
        || source.parent().and_then(Path::parent) != Some(root)
        || source
            .components()
            .any(|item| matches!(item, std::path::Component::ParentDir))
        || source.file_name().is_none()
    {
        return Err(DENIED);
    }
    let mut cursor = Some(root);
    while let Some(part) = cursor {
        if part.exists() {
            checked_component(part)?;
        }
        cursor = part.parent();
    }
    checked_component(source.parent().ok_or(DENIED)?)?;
    checked_component(source)?;
    let metadata = fs::metadata(source).map_err(|_| DENIED)?;
    if metadata.len() < 4096 || metadata.len() > 700_000_000 {
        return Err(DENIED);
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = source.as_os_str().to_os_string();
        name.push(suffix);
        if PathBuf::from(name).exists() {
            return Err(DENIED);
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Pin the detached source against replacement/write during reading.
        options.share_mode(0x0000_0001); // FILE_SHARE_READ
    }
    let handle = options.open(source).map_err(|_| DENIED)?;
    #[cfg(windows)]
    require_single_hard_link(&handle)?;
    let mut raw = Vec::new();
    handle
        .take(700_000_001)
        .read_to_end(&mut raw)
        .map_err(|_| DENIED)?;
    checked_component(source)?;
    if !raw.starts_with(b"SQLite format 3\0") || raw.len() as u64 != metadata.len() {
        return Err(DENIED);
    }
    Ok(raw)
}

fn digest_message(
    ticket: &SignedCopyOnlyTicket,
    trust: &TrustedOriginalOwner,
    version: i64,
) -> Result<Vec<u8>, &'static str> {
    if !matches!(version, 52 | 67) {
        return Err(DENIED);
    }
    let mut msg = DOMAIN.to_vec();
    msg.extend(version.to_be_bytes());
    msg.extend(trust.sealed_v29_sha256);
    msg.extend(ticket.source_sha256);
    msg.extend(ticket.scope_sha256);
    msg.extend(ticket.nonce);
    msg.extend(ticket.expires_unix_seconds.to_be_bytes());
    let mut identity = Sha256::new();
    framed(&mut identity, trust.id.as_bytes());
    framed(&mut identity, TENANT.as_bytes());
    msg.extend(identity.finalize());
    Ok(msg)
}

#[derive(Debug)]
pub(crate) struct CopyOnlyUpgradeReceipt {
    pub(crate) path: PathBuf,
    pub(crate) sha256: [u8; 32],
    pub(crate) source_sha256: [u8; 32],
    pub(crate) prior_version: i64,
    pub(crate) changed_scope_rows: u64,
    pub(crate) authorization_granted: bool,
}

/// A future authenticated native maintenance flow may call this ONLY after
/// making a detached, WAL-consistent, pinned source snapshot under the private
/// disposable root. The source profile itself is NEVER a valid input path.
pub(crate) async fn prepare_signed_copy_only_upgrade(
    detached_snapshot: &Path,
    ticket: &SignedCopyOnlyTicket,
) -> Result<CopyOnlyUpgradeReceipt, String> {
    // Never accept client/IPC-supplied clock input for a future authorized
    // operation. Only the native process decides the ticket's current time.
    let now_unix_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| DENIED.to_string())?
        .as_secs();
    let owner = independently_enrolled_owner().map_err(str::to_string)?;
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(DENIED)?)
        .join("pharma-disposable-data-copies");
    prepare_with_trust(detached_snapshot, &root, ticket, now_unix_seconds, &owner).await
}

async fn version_and_owner(
    db: &mut SqliteConnection,
    trust: &TrustedOriginalOwner,
) -> Result<i64, &'static str> {
    let versions: Vec<(i64, i64, String, String, Vec<u8>, String)> =
        sqlx::query_as("SELECT version,success,typeof(version),typeof(success),checksum,typeof(checksum) FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *db)
            .await
            .map_err(|_| DENIED)?;
    if versions.is_empty() {
        return Err(DENIED);
    }
    let version = versions.len() as i64;
    if !matches!(version, 52 | 67) {
        return Err(DENIED);
    }
    let embedded = crate::app_migrations();
    if versions
        .iter()
        .enumerate()
        .any(|(i, (v, ok, vtype, stype, checksum, ctype))| {
            let registered = match embedded.get(i) {
                Some(migration) => migration,
                None => return true,
            };
            let expected = sqlx::migrate::Migration::new(
                registered.version,
                registered.description.into(),
                sqlx::migrate::MigrationType::ReversibleUp,
                registered.sql.into(),
                false,
            );
            *v != i as i64 + 1
                || *ok != 1
                || vtype != "integer"
                || stype != "integer"
                || ctype != "blob"
                || checksum.as_slice() != expected.checksum.as_ref()
        })
    {
        return Err(DENIED);
    }
    // Historical 053 disputed-owner markers remain immutable evidence. An
    // independently signed owner-only COPY may preserve a marker for precisely
    // the trusted historical owner, but can never clear it or authorize login.
    // Another owner/disputed identity still refuses the entire copy.
    let has_review: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='native_owner_scope_review'"
    ).fetch_one(&mut *db).await.map_err(|_| DENIED)?;
    if has_review == 1 {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_owner_scope_review WHERE typeof(owner_id)!='text' OR owner_id!=?"
        )
            .bind(&trust.id)
            .fetch_one(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        if count != 0 {
            return Err(DENIED);
        }
    }
    // The actor query is complete and typed: NEVER infer owner from an old
    // local_default scope or from the pre-032 source password.
    let owner_rows: Vec<(String, i64)> = sqlx::query_as(concat!(
        "SELECT CAST(id AS TEXT),COALESCE(is_active,1) FROM users WHERE ",
        "LOWER(TRIM(COALESCE(role,'')))='owner' AND COALESCE(is_active,1)=1"
    ))
    .fetch_all(&mut *db)
    .await
    .map_err(|_| DENIED)?;
    if owner_rows.len() != 1 || owner_rows[0] != (trust.id.clone(), 1) {
        return Err(DENIED);
    }
    let good: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *db)
        .await
        .map_err(|_| DENIED)?;
    let fk = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *db)
        .await
        .map_err(|_| DENIED)?;
    if good != "ok" || !fk.is_empty() {
        return Err(DENIED);
    }
    Ok(version)
}

#[derive(Clone)]
struct ScopeOriginal {
    table: String,
    rowid_alias: &'static str,
    rowid: i64,
    storage: String,
    literal: Option<String>,
}

/// Full typed witness for every pre-existing physical table (including FTS
/// shadow tables, `sqlite_sequence`, finance and archived user records).
/// A SQL UPDATE can change derived/indirect cells even if it names only the
/// pharmacy_id field. Scope-only custody requires the typed non-scope history
/// to be *identical* before and after the transaction.
async fn non_scope_physical_witness(db: &mut SqliteConnection) -> Result<[u8; 32], &'static str> {
    let tables: Vec<(String, String)> = sqlx::query_as(
        "SELECT name,COALESCE(sql,'') FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .fetch_all(&mut *db)
    .await
    .map_err(|_| DENIED)?;
    if tables.is_empty() || tables.len() > 512 {
        return Err(DENIED);
    }
    let mut overall = Sha256::new();
    framed(
        &mut overall,
        b"pharma/v52-v67/typed-non-scope-physical-witness/v1",
    );
    for (name, ddl) in tables {
        if matches!(
            name.as_str(),
            "native_copy_only_scope_originals" | "native_copy_only_scope_audit"
        ) {
            continue;
        }
        let escaped = name.replace('"', "\"\"");
        let fields = sqlx::query(&format!("PRAGMA table_xinfo(\"{escaped}\")"))
            .fetch_all(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        let column_names: Vec<String> = fields
            .iter()
            .map(|field| field.try_get::<String, _>("name").map_err(|_| DENIED))
            .collect::<Result<_, _>>()?;
        let is_scoped = column_names.iter().any(|name| name == "pharmacy_id");
        // Every named data column is included except the one approved tenant
        // cell. Any unscoped table must be byte/typed-value identical.
        let declared_columns: Vec<String> = column_names
            .iter()
            .filter(|column| !(is_scoped && column.as_str() == "pharmacy_id"))
            .cloned()
            .collect();
        framed(&mut overall, name.as_bytes());
        framed(&mut overall, ddl.as_bytes());
        for column in &declared_columns {
            framed(&mut overall, column.as_bytes());
        }
        let wr: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(wr),0) FROM pragma_table_list WHERE name=?")
                .bind(&name)
                .fetch_one(&mut *db)
                .await
                .map_err(|_| DENIED)?;
        let alias = ["_rowid_", "rowid", "oid"]
            .iter()
            .find(|alias| !column_names.iter().any(|column| column == **alias));
        if wr == 0 && alias.is_none() && !ddl.to_ascii_uppercase().contains("VIRTUAL TABLE") {
            // Even an unscoped ordinary table must retain its physical row
            // identity. Shadowing all three SQLite rowid aliases otherwise
            // weakens the non-scope witness silently.
            return Err(DENIED);
        }
        let has_rowid =
            wr == 0 && alias.is_some() && !ddl.to_ascii_uppercase().contains("VIRTUAL TABLE");
        let mut selected = Vec::new();
        if has_rowid {
            selected.push(format!(
                "{} AS \"__native_witness_rowid__\"",
                alias.unwrap()
            ));
        }
        for column in &declared_columns {
            selected.push(format!("\"{}\"", column.replace('"', "\"\"")));
        }
        if selected.is_empty() {
            return Err(DENIED);
        }
        let select = format!("SELECT {} FROM \"{escaped}\"", selected.join(","));
        let mut rows = Vec::<[u8; 32]>::new();
        {
            let mut stream = sqlx::query(&select).fetch(&mut *db);
            while let Some(next) = stream.next().await {
                let row = next.map_err(|_| DENIED)?;
                let mut row_hash = Sha256::new();
                for (index, column) in row.columns().iter().enumerate() {
                    framed(&mut row_hash, column.name().as_bytes());
                    let cell = row.try_get_raw(index).map_err(|_| DENIED)?;
                    if cell.is_null() {
                        framed(&mut row_hash, b"null");
                        continue;
                    }
                    match cell.type_info().name().to_ascii_uppercase().as_str() {
                        "INTEGER" => {
                            framed(&mut row_hash, b"integer");
                            let value: i64 = row.try_get(index).map_err(|_| DENIED)?;
                            framed(&mut row_hash, &value.to_be_bytes());
                        }
                        "REAL" => {
                            framed(&mut row_hash, b"real");
                            let value: f64 = row.try_get(index).map_err(|_| DENIED)?;
                            framed(&mut row_hash, &value.to_bits().to_be_bytes());
                        }
                        "TEXT" => {
                            framed(&mut row_hash, b"text");
                            let value: String = row.try_get(index).map_err(|_| DENIED)?;
                            framed(&mut row_hash, value.as_bytes());
                        }
                        "BLOB" => {
                            framed(&mut row_hash, b"blob");
                            let value: Vec<u8> = row.try_get(index).map_err(|_| DENIED)?;
                            framed(&mut row_hash, &value);
                        }
                        _ => return Err(DENIED),
                    }
                }
                rows.push(row_hash.finalize().into());
                if rows.len() > 3_000_000 {
                    return Err(DENIED);
                }
            }
        }
        rows.sort_unstable();
        framed(&mut overall, &(rows.len() as u64).to_be_bytes());
        for row_hash in &rows {
            overall.update(row_hash);
        }
    }
    Ok(overall.finalize().into())
}

async fn originals_and_scope_sha(
    db: &mut SqliteConnection,
) -> Result<(Vec<ScopeOriginal>, [u8; 32]), &'static str> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7) COLLATE BINARY != 'sqlite_' ORDER BY name"
    ).fetch_all(&mut *db).await.map_err(|_| DENIED)?;
    if names.is_empty() || names.len() > 512 {
        return Err(DENIED);
    }
    let mut digest = Sha256::new();
    framed(
        &mut digest,
        b"pharma/native/v52-v67-all-direct-scope-cells/v1",
    );
    let mut originals = Vec::new();
    let mut has_scopes = false;
    for name in names {
        let escaped = name.replace('"', "\"\"");
        // table_info intentionally omits STORED/VIRTUAL generated fields.
        // Writing pharmacy_id could silently rewrite derived patient/finance
        // cells; table_xinfo exposes those schema columns so we refuse them.
        let fields = sqlx::query(&format!("PRAGMA table_xinfo(\"{escaped}\")"))
            .fetch_all(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        let scoped = fields
            .iter()
            .any(|r| r.try_get::<String, _>("name").ok().as_deref() == Some("pharmacy_id"));
        if !scoped {
            continue;
        }
        if fields
            .iter()
            .any(|f| f.try_get::<i64, _>("hidden").unwrap_or(-1) != 0)
        {
            return Err(DENIED);
        }
        has_scopes = true;
        let without_rowid: i64 =
            sqlx::query_scalar("SELECT wr FROM pragma_table_list WHERE name=?")
                .bind(&name)
                .fetch_one(&mut *db)
                .await
                .map_err(|_| DENIED)?;
        if without_rowid != 0
            || ["rowid", "_rowid_", "oid"].iter().all(|r| {
                fields
                    .iter()
                    .any(|f| f.try_get::<String, _>("name").ok().as_deref() == Some(r))
            })
        {
            return Err(DENIED);
        }
        let alias = ["_rowid_", "rowid", "oid"]
            .into_iter()
            .find(|r| {
                !fields
                    .iter()
                    .any(|f| f.try_get::<String, _>("name").ok().as_deref() == Some(r))
            })
            .ok_or(DENIED)?;
        framed(&mut digest, name.as_bytes());
        let rows = sqlx::query(&format!(
            "SELECT {alias} AS scope_rowid,typeof(pharmacy_id) AS scope_kind,\
             pharmacy_id AS scope_text FROM \"{escaped}\" ORDER BY {alias}"
        ))
        .fetch_all(&mut *db)
        .await
        .map_err(|_| DENIED)?;
        for row in rows {
            let rowid: i64 = row.try_get("scope_rowid").map_err(|_| DENIED)?;
            let storage: String = row.try_get("scope_kind").map_err(|_| DENIED)?;
            let literal: Option<String> = row.try_get("scope_text").map_err(|_| DENIED)?;
            if !matches!(storage.as_str(), "null" | "text") {
                return Err(DENIED);
            }
            if let Some(value) = literal.as_deref() {
                if value != TENANT && value != "local_default" && !value.trim().is_empty() {
                    // Unknown/foreign explicit tenant values are not owned by
                    // this signature, regardless of other matching rows.
                    return Err(DENIED);
                }
            } else if storage != "null" {
                return Err(DENIED);
            }
            framed(&mut digest, &rowid.to_be_bytes());
            framed(&mut digest, storage.as_bytes());
            framed(&mut digest, literal.as_deref().unwrap_or("").as_bytes());
            if literal.as_deref() != Some(TENANT) {
                originals.push(ScopeOriginal {
                    table: name.clone(),
                    rowid_alias: alias,
                    rowid,
                    storage,
                    literal,
                });
            }
        }
    }
    if !has_scopes || originals.is_empty() {
        return Err(DENIED);
    }
    Ok((originals, digest.finalize().into()))
}

/// A full row/foreign-key checksum alone does not detect a new fan-out in a
/// business query that joins by tenant plus an unindexed human-entered number.
/// One supplier can legitimately use the same invoice number as another, so
/// check the supplier AND the invoice number. If different original tenant
/// labels used the same natural key, normalizing them could make one historical
/// supplier payment match more than one invoice despite perfectly identical
/// row counts. Such records need a separately reviewed linkage, not auto-merge.
async fn deny_purchase_reference_fanout(db: &mut SqliteConnection) -> Result<(), &'static str> {
    let columns = sqlx::query("PRAGMA table_xinfo('purchase_invoices')")
        .fetch_all(&mut *db)
        .await
        .map_err(|_| DENIED)?;
    if columns.is_empty() {
        // Purchase invoices are a required original-history table at both
        // accepted historical source versions. Absence must not waive the
        // document/ledger fanout precondition.
        return Err(DENIED);
    }
    for required in ["pharmacy_id", "supplier_id", "invoice_number"] {
        if !columns
            .iter()
            .any(|c| c.try_get::<String, _>("name").ok().as_deref() == Some(required))
        {
            return Err(DENIED);
        }
    }
    let fanout: i64 = sqlx::query_scalar(concat!(
        "SELECT EXISTS(SELECT 1 FROM purchase_invoices ",
        "WHERE typeof(invoice_number)='text' AND trim(invoice_number)<>'' ",
        "AND typeof(supplier_id)='integer' ",
        "GROUP BY supplier_id, invoice_number COLLATE NOCASE ",
        "HAVING COUNT(DISTINCT quote(pharmacy_id))>1)"
    ))
    .fetch_one(&mut *db)
    .await
    .map_err(|_| DENIED)?;
    if fanout != 0 {
        return Err(DENIED);
    }
    // Other legacy readers use human-entered sale numbers or an invoice-built
    // stock batch key as scope-relative joins. SQL foreign_key_check cannot
    // detect an extra query match after distinct old scopes converge; no
    // record should be dropped or picked arbitrarily to "solve" a fan-out.
    // A missing optional field in an older registered schema is not inferred.
    for (table, required, group_by, eligible) in [
        (
            "sales_invoices",
            &["invoice_number"][..],
            "invoice_number COLLATE NOCASE",
            "typeof(invoice_number)='text' AND trim(invoice_number)<>''",
        ),
        (
            "inventory",
            &["drug_id", "batch_number", "expiry_date"][..],
            "drug_id, batch_number COLLATE NOCASE, expiry_date",
            "typeof(drug_id)='integer' AND typeof(batch_number)='text' AND trim(batch_number)<>''",
        ),
    ] {
        let info = sqlx::query(&format!("PRAGMA table_xinfo('{table}')"))
            .fetch_all(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        if info.is_empty() {
            continue;
        }
        let columns: Vec<String> = info
            .iter()
            .map(|field| field.try_get::<String, _>("name").map_err(|_| DENIED))
            .collect::<Result<_, _>>()?;
        if !columns.iter().any(|column| column == "pharmacy_id") {
            return Err(DENIED);
        }
        if required.iter().any(|required| !columns.iter().any(|column| column == required)) {
            continue;
        }
        let ambiguous: i64 = sqlx::query_scalar(&format!(
            "SELECT EXISTS(SELECT 1 FROM \"{table}\" WHERE {eligible} GROUP BY {group_by} HAVING COUNT(DISTINCT quote(pharmacy_id))>1)"
        ))
        .fetch_one(&mut *db)
        .await
        .map_err(|_| DENIED)?;
        if ambiguous != 0 {
            return Err(DENIED);
        }
    }
    Ok(())
}

async fn transactional_normalize(
    db: &mut SqliteConnection,
    source_sha256: [u8; 32],
    typed_scope_sha256: [u8; 32],
    signed_owner_evidence_sha256: [u8; 32],
    version: i64,
    originals: &[ScopeOriginal],
) -> Result<u64, &'static str> {
    // Only the NEW cloned file is writable. Guard triggers are dropped and
    // restored inside the SAME SQLite transaction, so failure rolls back.
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *db)
        .await
        .map_err(|_| DENIED)?;
    let work = async {
        deny_purchase_reference_fanout(db).await?;
        let original_witness = non_scope_physical_witness(db).await?;
        let trigger_rows =
            sqlx::query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
                .fetch_all(&mut *db)
                .await
                .map_err(|_| DENIED)?;
        let mut triggers = Vec::new();
        for row in trigger_rows {
            let name: String = row.try_get("name").map_err(|_| DENIED)?;
            let definition: String = row.try_get("sql").map_err(|_| DENIED)?;
            if definition.is_empty() {
                return Err(DENIED);
            }
            triggers.push((name, definition));
        }
        sqlx::query(concat!(
            "CREATE TABLE native_copy_only_scope_originals (",
            "source_table TEXT NOT NULL,source_rowid INTEGER NOT NULL,",
            "original_storage TEXT NOT NULL,original_literal BLOB,",
            "PRIMARY KEY(source_table,source_rowid)) WITHOUT ROWID"
        ))
        .execute(&mut *db)
        .await
        .map_err(|_| DENIED)?;
        sqlx::query(concat!(
            "CREATE TABLE native_copy_only_scope_audit (",
            "source_sha256 BLOB NOT NULL,source_version INTEGER NOT NULL,",
            "typed_scope_sha256 BLOB NOT NULL,signed_owner_evidence_sha256 BLOB NOT NULL,",
            "pharmacy_id TEXT NOT NULL CHECK(pharmacy_id='primary_pharmacy'),",
            "changed_rows INTEGER NOT NULL)"
        ))
        .execute(&mut *db)
        .await
        .map_err(|_| DENIED)?;
        for (name, _) in &triggers {
            let escaped = name.replace('"', "\"\"");
            sqlx::query(&format!("DROP TRIGGER \"{escaped}\""))
                .execute(&mut *db)
                .await
                .map_err(|_| DENIED)?;
        }
        for original in originals {
            sqlx::query(concat!(
                "INSERT INTO native_copy_only_scope_originals ",
                "(source_table,source_rowid,original_storage,original_literal) VALUES(?,?,?,?)"
            ))
            .bind(&original.table)
            .bind(original.rowid)
            .bind(&original.storage)
            .bind(&original.literal)
            .execute(&mut *db)
            .await
            .map_err(|_| DENIED)?;
            let escaped = original.table.replace('"', "\"\"");
            let result = sqlx::query(&format!(
                "UPDATE \"{escaped}\" SET pharmacy_id=? WHERE {}=? AND pharmacy_id IS NOT ?",
                original.rowid_alias
            ))
            .bind(TENANT)
            .bind(original.rowid)
            .bind(TENANT)
            .execute(&mut *db)
            .await
            .map_err(|_| DENIED)?;
            if result.rows_affected() != 1 {
                return Err(DENIED);
            }
        }
        for (_, definition) in &triggers {
            sqlx::query(definition)
                .execute(&mut *db)
                .await
                .map_err(|_| DENIED)?;
        }
        sqlx::query("INSERT INTO native_copy_only_scope_audit VALUES(?,?,?,?,'primary_pharmacy',?)")
            .bind(source_sha256.to_vec())
            .bind(version)
            .bind(typed_scope_sha256.to_vec())
            .bind(signed_owner_evidence_sha256.to_vec())
            .bind(originals.len() as i64)
            .execute(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        // Unlike the old v52/v67 financial triggers (reinstated above), these
        // new COPY-ONLY custody guards are never suspended. Even a future
        // rollback must leave the exact originals and original source pin.
        for trigger in [
            "CREATE TRIGGER native_copy_scope_original_no_update BEFORE UPDATE ON native_copy_only_scope_originals BEGIN SELECT RAISE(ABORT,'Original scope custody immutable'); END",
            "CREATE TRIGGER native_copy_scope_original_no_delete BEFORE DELETE ON native_copy_only_scope_originals BEGIN SELECT RAISE(ABORT,'Original scope custody immutable'); END",
            "CREATE TRIGGER native_copy_scope_original_no_append BEFORE INSERT ON native_copy_only_scope_originals WHEN EXISTS(SELECT 1 FROM native_copy_only_scope_audit) BEGIN SELECT RAISE(ABORT,'Original scope custody sealed'); END",
            "CREATE TRIGGER native_copy_scope_audit_no_update BEFORE UPDATE ON native_copy_only_scope_audit BEGIN SELECT RAISE(ABORT,'Source-bound scope audit immutable'); END",
            "CREATE TRIGGER native_copy_scope_audit_no_delete BEFORE DELETE ON native_copy_only_scope_audit BEGIN SELECT RAISE(ABORT,'Source-bound scope audit immutable'); END",
            "CREATE TRIGGER native_copy_scope_audit_no_append BEFORE INSERT ON native_copy_only_scope_audit WHEN EXISTS(SELECT 1 FROM native_copy_only_scope_audit) BEGIN SELECT RAISE(ABORT,'Source-bound scope audit sealed'); END",
        ] {
            sqlx::query(trigger)
                .execute(&mut *db)
                .await
                .map_err(|_| DENIED)?;
        }
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        let fk = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut *db)
            .await
            .map_err(|_| DENIED)?;
        if integrity != "ok" || !fk.is_empty() {
            return Err(DENIED);
        }
        if non_scope_physical_witness(db).await? != original_witness {
            // Includes original rowid, typed finance values, FTS shadows,
            // supplier/patient records, auto-increment state and native audit.
            return Err(DENIED);
        }
        Ok(originals.len() as u64)
    }
    .await;
    match work {
        Ok(count) => {
            sqlx::query("COMMIT")
                .execute(&mut *db)
                .await
                .map_err(|_| DENIED)?;
            Ok(count)
        }
        Err(reason) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *db).await;
            Err(reason)
        }
    }
}

async fn prepare_with_trust(
    source: &Path,
    root: &Path,
    ticket: &SignedCopyOnlyTicket,
    now: u64,
    owner: &TrustedOriginalOwner,
) -> Result<CopyOnlyUpgradeReceipt, String> {
    if ticket.nonce.iter().all(|b| *b == 0)
        || ticket.expires_unix_seconds < now
        || ticket.expires_unix_seconds.saturating_sub(now) > MAX_AGE_SECONDS
    {
        return Err(DENIED.into());
    }
    let raw = checked_detached_source(source, root)?;
    if Sha256::digest(&raw).as_slice() != ticket.source_sha256 {
        return Err(DENIED.into());
    }
    // Authenticate the actual detached snapshot *before* creating any new
    // customer-history-bearing file. Previously an unsigned or bad-signature
    // request copied the whole source and relied on best-effort deletion,
    // which is not a reliable privacy boundary on Windows with SQLite handles.
    let inspect_options = SqliteConnectOptions::new()
        .filename(source)
        .read_only(true)
        .create_if_missing(false)
        .foreign_keys(false);
    let mut inspect = SqliteConnection::connect_with(&inspect_options)
        .await
        .map_err(|_| DENIED)?;
    let verified_version = version_and_owner(&mut inspect, owner).await?;
    let (_, verified_scope_sha) = originals_and_scope_sha(&mut inspect).await?;
    if verified_scope_sha != ticket.scope_sha256 {
        return Err(DENIED.into());
    }
    let verified_message = digest_message(ticket, owner, verified_version)?;
    UnparsedPublicKey::new(&ED25519, owner.key)
        .verify(&verified_message, &ticket.ed25519_signature)
        .map_err(|_| DENIED)?;
    inspect.close().await.map_err(|_| DENIED)?;
    if Sha256::digest(fs::read(source).map_err(|_| DENIED)?).as_slice() != ticket.source_sha256 {
        return Err(DENIED.into());
    }
    let folder = root.join(format!(
        "pharma-copy-only-owner-signed-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&folder).map_err(|_| DENIED)?;
    let output = folder.join("OWNER-SIGNED-COPY-ONLY-NOT-INSTALLED.sqlite3");
    let result = async {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|_| DENIED)?;
        file.write_all(&raw).map_err(|_| DENIED)?;
        file.sync_all().map_err(|_| DENIED)?;
        drop(file);
        let options = SqliteConnectOptions::new()
            .filename(&output)
            .create_if_missing(false)
            .foreign_keys(false)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete);
        let mut db = SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| DENIED)?;
        let version = version_and_owner(&mut db, owner).await?;
        let (originals, typed_sha) = originals_and_scope_sha(&mut db).await?;
        if typed_sha != ticket.scope_sha256 || version != verified_version {
            return Err(DENIED);
        }
        let message = digest_message(ticket, owner, version)?;
        UnparsedPublicKey::new(&ED25519, owner.key)
            .verify(&message, &ticket.ed25519_signature)
            .map_err(|_| DENIED)?;
        let mut signed = Sha256::new();
        framed(&mut signed, &message);
        framed(&mut signed, &ticket.ed25519_signature);
        framed(&mut signed, &owner.key);
        let evidence: [u8; 32] = signed.finalize().into();
        let changed = transactional_normalize(
            &mut db,
            ticket.source_sha256,
            ticket.scope_sha256,
            evidence,
            version,
            &originals,
        )
        .await?;
        db.close().await.map_err(|_| DENIED)?;
        if Sha256::digest(fs::read(source).map_err(|_| DENIED)?).as_slice() != ticket.source_sha256
        {
            return Err(DENIED);
        }
        let new_sha: [u8; 32] = Sha256::digest(fs::read(&output).map_err(|_| DENIED)?).into();
        Ok(CopyOnlyUpgradeReceipt {
            path: output.clone(),
            sha256: new_sha,
            source_sha256: ticket.source_sha256,
            prior_version: version,
            changed_scope_rows: changed,
            authorization_granted: false,
        })
    }
    .await;
    if result.is_err() {
        // Never remove an arbitrary path: both are freshly created by this
        // call with create_new under the validated private disposable root.
        let _ = fs::remove_file(&output);
        let _ = fs::remove_dir(&folder);
    }
    result.map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn fixture() -> (TrustedOriginalOwner, Ed25519KeyPair) {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[11; 32]).unwrap();
        let mut key = [0; 32];
        key.copy_from_slice(signer.public_key().as_ref());
        (
            TrustedOriginalOwner {
                id: "synthetic-owner".into(),
                key,
                sealed_v29_sha256: [31; 32],
            },
            signer,
        )
    }

    async fn detached_synthetic_source(version: i64) -> (PathBuf, PathBuf, SignedCopyOnlyTicket) {
        let root = std::env::temp_dir().join(format!(
            "pharma-detached-scope-unit-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let input_dir = root.join("snapshot");
        fs::create_dir_all(&input_dir).unwrap();
        let source = input_dir.join("synthetic-snapshot.sqlite3");
        let opts = SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
            .foreign_keys(false);
        let mut db = SqliteConnection::connect_with(&opts).await.unwrap();
        sqlx::query("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER,checksum BLOB NOT NULL)")
            .execute(&mut db).await.unwrap();
        for entry in crate::app_migrations().into_iter().take(version as usize) {
            let registered = sqlx::migrate::Migration::new(
                entry.version,
                entry.description.into(),
                sqlx::migrate::MigrationType::ReversibleUp,
                entry.sql.into(),
                false,
            );
            sqlx::query("INSERT INTO _sqlx_migrations VALUES(?,1,?)")
                .bind(entry.version)
                .bind(registered.checksum.as_ref())
                .execute(&mut db)
                .await
                .unwrap();
        }
        sqlx::query(
            "CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,is_active INTEGER,pharmacy_id TEXT)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO users VALUES('synthetic-owner','owner',1,'local_default')")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,amount REAL)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES('synthetic-legacy',NULL,17.123456789),('already-owned','primary_pharmacy',2.05)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,supplier_id INTEGER,invoice_number TEXT,total_amount REAL)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TRIGGER synthetic_no_finance_rewrite BEFORE UPDATE ON sales_invoices BEGIN SELECT RAISE(ABORT,'Finance is immutable'); END")
            .execute(&mut db).await.unwrap();
        let (_, scope_sha256) = originals_and_scope_sha(&mut db).await.unwrap();
        db.close().await.unwrap();
        let source_sha256: [u8; 32] = Sha256::digest(fs::read(&source).unwrap()).into();
        let ticket = SignedCopyOnlyTicket {
            source_sha256,
            scope_sha256,
            nonce: [3; 32],
            expires_unix_seconds: 1000,
            ed25519_signature: [0; 64],
        };
        (root, source, ticket)
    }

    #[tokio::test]
    async fn signed_detached_copy_never_installs_and_invalid_proof_never_clones() {
        for version in [52, 67] {
            let (root, source, mut ticket) = detached_synthetic_source(version).await;
            let (trust, signer) = fixture();
            let original_sha = ticket.source_sha256;
            assert!(prepare_with_trust(&source, &root, &ticket, 100, &trust)
                .await
                .is_err());
            assert_eq!(
                fs::read_dir(&root).unwrap().count(),
                1,
                "An invalid Ed25519 signature must leave no new customer-derived file"
            );
            assert_eq!(
                Sha256::digest(fs::read(&source).unwrap()).as_slice(),
                original_sha
            );
            let message = digest_message(&ticket, &trust, version).unwrap();
            ticket
                .ed25519_signature
                .copy_from_slice(signer.sign(&message).as_ref());
            let receipt = prepare_with_trust(&source, &root, &ticket, 100, &trust)
                .await
                .unwrap();
            assert_eq!(receipt.prior_version, version);
            assert_eq!(receipt.source_sha256, original_sha);
            assert_eq!(receipt.changed_scope_rows, 2);
            assert!(
                !receipt.authorization_granted,
                "A staged signed copy is not sufficient to authorize installation or finance"
            );
            assert_eq!(
                Sha256::digest(fs::read(&receipt.path).unwrap()).as_slice(),
                receipt.sha256
            );
            assert_eq!(
                Sha256::digest(fs::read(&source).unwrap()).as_slice(),
                original_sha
            );
            let read = SqliteConnectOptions::new()
                .filename(&receipt.path)
                .read_only(true)
                .create_if_missing(false)
                .foreign_keys(false);
            let mut result = SqliteConnection::connect_with(&read).await.unwrap();
            let scopes: Vec<String> =
                sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices ORDER BY id")
                    .fetch_all(&mut result)
                    .await
                    .unwrap();
            assert_eq!(scopes, vec!["primary_pharmacy", "primary_pharmacy"]);
            let amount: f64 =
                sqlx::query_scalar("SELECT amount FROM sales_invoices WHERE id='synthetic-legacy'")
                    .fetch_one(&mut result)
                    .await
                    .unwrap();
            assert_eq!(amount, 17.123456789);
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM native_copy_only_scope_originals"
                )
                .fetch_one(&mut result)
                .await
                .unwrap(),
                2
            );
            result.close().await.unwrap();
            fs::remove_dir_all(&root).unwrap();
        }
    }

    async fn memory_fixture(
        version: i64,
        foreign: Option<&str>,
        disputed: bool,
    ) -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER,checksum BLOB NOT NULL)")
            .execute(&mut db)
            .await
            .unwrap();
        for entry in crate::app_migrations().into_iter().take(version as usize) {
            let registered = sqlx::migrate::Migration::new(
                entry.version,
                entry.description.into(),
                sqlx::migrate::MigrationType::ReversibleUp,
                entry.sql.into(),
                false,
            );
            sqlx::query("INSERT INTO _sqlx_migrations VALUES(?,1,?)")
                .bind(entry.version)
                .bind(registered.checksum.as_ref())
                .execute(&mut db)
                .await
                .unwrap();
        }
        sqlx::query("CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users VALUES('synthetic-owner','owner',1,'local_default')")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,amount REAL)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,supplier_id INTEGER,invoice_number TEXT,total_amount REAL)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES('synthetic-sale',?,17.123456789)")
            .bind(foreign)
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query(concat!(
            "CREATE TRIGGER native_financial_scope_guard BEFORE UPDATE ON sales_invoices ",
            "BEGIN SELECT RAISE(ABORT,'Synthetic native financial guard'); END"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        if disputed {
            sqlx::query("CREATE TABLE native_owner_scope_review(owner_id TEXT,reason TEXT)")
                .execute(&mut db)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO native_owner_scope_review VALUES('synthetic-owner','unresolved')",
            )
            .execute(&mut db)
            .await
            .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn signed_scope_census_includes_sqlitex_table_but_excludes_sqlite_internal_tables() {
        let mut db = memory_fixture(67, None, false).await;
        sqlx::raw_sql(
            "CREATE TABLE sqliteXcustom(id INTEGER PRIMARY KEY,pharmacy_id TEXT,amount REAL);
             INSERT INTO sqliteXcustom VALUES(1,'local_default',9.25),(2,'primary_pharmacy',7.50);
             CREATE TABLE synthetic_sequence(id INTEGER PRIMARY KEY AUTOINCREMENT);
             INSERT INTO synthetic_sequence DEFAULT VALUES;",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let table_names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7) COLLATE BINARY != 'sqlite_' ORDER BY name",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert!(table_names.iter().any(|name| name == "sqliteXcustom"));
        assert!(!table_names.iter().any(|name| name == "sqlite_sequence"));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            1,
        );

        let (originals, digest) = originals_and_scope_sha(&mut db).await.unwrap();
        assert!(originals.iter().any(|row| {
            row.table == "sqliteXcustom" && row.rowid == 1 && row.literal.as_deref() == Some("local_default")
        }));
        assert!(!originals.iter().any(|row| row.table == "sqlite_sequence"));
        assert_eq!(originals.len(), 3);
        assert_eq!(
            transactional_normalize(&mut db, [19; 32], digest, [29; 32], 67, &originals)
                .await
                .unwrap(),
            3,
        );
        let values: Vec<(String, f64)> = sqlx::query_as(
            "SELECT pharmacy_id,amount FROM sqliteXcustom ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(values, vec![(TENANT.into(), 9.25), (TENANT.into(), 7.50)]);
    }

    #[tokio::test]
    async fn synthetic_v52_and_v67_accept_only_scoped_sources() {
        for version in [52, 67] {
            let (trust, _) = fixture();
            let mut db = memory_fixture(version, None, false).await;
            assert_eq!(version_and_owner(&mut db, &trust).await.unwrap(), version);
            let (originals, sha) = originals_and_scope_sha(&mut db).await.unwrap();
            assert_eq!(originals.len(), 2);
            assert_ne!(sha, [0; 32]);
            let changed =
                transactional_normalize(&mut db, [19; 32], sha, [29; 32], version, &originals)
                    .await
                    .unwrap();
            assert_eq!(changed, 2);
            let scope: String = sqlx::query_scalar(
                "SELECT pharmacy_id FROM sales_invoices WHERE id='synthetic-sale'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert_eq!(scope, TENANT);
            let amount: f64 = sqlx::query_scalar("SELECT amount FROM sales_invoices")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(amount, 17.123456789);
            assert!(sqlx::query("UPDATE sales_invoices SET amount=100")
                .execute(&mut db)
                .await
                .is_err());
            let archived: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM native_copy_only_scope_originals")
                    .fetch_one(&mut db)
                    .await
                    .unwrap();
            assert_eq!(archived, 2);
            assert!(sqlx::query(
                "UPDATE native_copy_only_scope_originals SET original_literal='fake'"
            )
            .execute(&mut db)
            .await
            .is_err());
            assert!(
                sqlx::query("UPDATE native_copy_only_scope_audit SET changed_rows=0")
                    .execute(&mut db)
                    .await
                    .is_err()
            );
            assert!(sqlx::query("INSERT INTO native_copy_only_scope_audit VALUES(X'01',52,X'02',X'03','primary_pharmacy',0)")
                .execute(&mut db).await.is_err());
        }
    }

    #[tokio::test]
    async fn synthetic_mixed_legacy_labels_converge_without_merging_distinct_business_rows() {
        // A label normalization is NOT a DELETE/UPSERT, record re-creation,
        // or cross-installation merge. Every pre-existing row and reference
        // retains its physical identity; only explicitly attested scope cells
        // change, and a pre-existing canonical row remains untouched.
        for version in [52, 67] {
            let (owner, _) = fixture();
            let mut db = memory_fixture(version, None, false).await;
            sqlx::query(
                "INSERT INTO sales_invoices VALUES\
                 ('legacy-default','local_default',2.01),\
                 ('legacy-blank','',3.02),\
                 ('legacy-spaces',' ',4.03),\
                 ('already-primary','primary_pharmacy',5.04)",
            )
            .execute(&mut db)
            .await
            .unwrap();
            sqlx::query("CREATE UNIQUE INDEX synthetic_sale_id_for_fk ON sales_invoices(id)")
                .execute(&mut db)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE synthetic_sale_items(\
                  id TEXT PRIMARY KEY,invoice_id TEXT REFERENCES sales_invoices(id),\
                  lot_id TEXT,quantity INTEGER,net_amount REAL)",
            )
            .execute(&mut db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO synthetic_sale_items VALUES\
                 ('line-a','synthetic-sale','lot-a',1,17.123456789),\
                 ('line-b','legacy-default','lot-b',2,2.01),\
                 ('line-c','already-primary','lot-c',3,5.04)",
            )
            .execute(&mut db)
            .await
            .unwrap();
            let original_witness = non_scope_physical_witness(&mut db).await.unwrap();
            assert_eq!(version_and_owner(&mut db, &owner).await.unwrap(), version);
            let (originals, scope_sha) = originals_and_scope_sha(&mut db).await.unwrap();
            // Five changed cells: owner + null, local_default, blank, spaces.
            // The already-canonical invoice is not modified or duplicated.
            assert_eq!(originals.len(), 5);
            let changed = transactional_normalize(
                &mut db, [19; 32], scope_sha, [29; 32], version, &originals,
            )
            .await
            .unwrap();
            assert_eq!(changed, 5);
            assert_eq!(
                non_scope_physical_witness(&mut db).await.unwrap(),
                original_witness
            );
            let scopes: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*),SUM(CASE WHEN pharmacy_id='primary_pharmacy' THEN 1 ELSE 0 END) FROM sales_invoices",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert_eq!(scopes, (5, 5));
            let old_labels: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sales_invoices WHERE pharmacy_id IS NULL OR pharmacy_id != 'primary_pharmacy'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert_eq!(old_labels, 0);
            let references: Vec<(String, String, i64, f64)> = sqlx::query_as(
                "SELECT id,invoice_id,quantity,net_amount FROM synthetic_sale_items ORDER BY id",
            )
            .fetch_all(&mut db)
            .await
            .unwrap();
            assert_eq!(
                references,
                vec![
                    ("line-a".into(), "synthetic-sale".into(), 1, 17.123456789),
                    ("line-b".into(), "legacy-default".into(), 2, 2.01),
                    ("line-c".into(), "already-primary".into(), 3, 5.04),
                ]
            );
            let foreign_violations = sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&mut db)
                .await
                .unwrap();
            assert!(foreign_violations.is_empty());
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM native_copy_only_scope_originals"
                )
                .fetch_one(&mut db)
                .await
                .unwrap(),
                5
            );
        }
    }

    #[tokio::test]
    async fn synthetic_scope_key_collision_refuses_with_complete_rollback() {
        let mut db = memory_fixture(67, None, false).await;
        sqlx::query(
            "CREATE UNIQUE INDEX synthetic_invoice_scope_key ON sales_invoices(pharmacy_id,id)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        // Different physical invoices with a shared business document number
        // can be valid across old NULL/placeholder scopes. Never silently
        // discard one to satisfy an index once scopes converge.
        sqlx::query("CREATE TABLE synthetic_business_document(pharmacy_id TEXT,invoice_number TEXT,amount REAL,UNIQUE(pharmacy_id,invoice_number))")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO synthetic_business_document VALUES('local_default','DUPLICATE-1',10),('primary_pharmacy','DUPLICATE-1',20)")
            .execute(&mut db).await.unwrap();
        let (originals, sha) = originals_and_scope_sha(&mut db).await.unwrap();
        assert!(
            transactional_normalize(&mut db, [19; 32], sha, [29; 32], 67, &originals)
                .await
                .is_err()
        );
        let originals_unmodified: Vec<(String, f64)> = sqlx::query_as(
            "SELECT pharmacy_id,amount FROM synthetic_business_document ORDER BY amount",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(
            originals_unmodified,
            vec![
                ("local_default".into(), 10.0),
                ("primary_pharmacy".into(), 20.0)
            ]
        );
        let old_owner: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='synthetic-owner'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(old_owner, "local_default");
        let audit_exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='native_copy_only_scope_audit'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(audit_exists, 0);
        assert!(
            sqlx::query("UPDATE sales_invoices SET amount=0")
                .execute(&mut db)
                .await
                .is_err(),
            "Original financial trigger must survive rollback"
        );
    }

    #[tokio::test]
    async fn synthetic_unindexed_supplier_reference_join_fanout_is_denied() {
        let mut db = memory_fixture(67, None, false).await;
        sqlx::query("INSERT INTO purchase_invoices VALUES('legacy-1','local_default',7,'Vendor-0007',10),('new-2','primary_pharmacy',7,'Vendor-0007',20)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY,supplier_id INTEGER,reference_id TEXT,amount REAL)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO supplier_transactions VALUES(1,7,'Vendor-0007',10)")
            .execute(&mut db)
            .await
            .unwrap();
        let (originals, sha) = originals_and_scope_sha(&mut db).await.unwrap();
        let original_witness = non_scope_physical_witness(&mut db).await.unwrap();
        assert!(deny_purchase_reference_fanout(&mut db).await.is_err());
        assert!(
            transactional_normalize(&mut db, [19; 32], sha, [29; 32], 67, &originals)
                .await
                .is_err()
        );
        assert_eq!(
            non_scope_physical_witness(&mut db).await.unwrap(),
            original_witness
        );
        let labels: Vec<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM purchase_invoices ORDER BY id")
                .fetch_all(&mut db)
                .await
                .unwrap();
        assert_eq!(labels, vec!["local_default", "primary_pharmacy"]);
        let legacy_actor: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='synthetic-owner'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(legacy_actor, "local_default");
        let kept_payment: (i64, f64) =
            sqlx::query_as("SELECT COUNT(*),SUM(amount) FROM supplier_transactions")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(kept_payment, (1, 10.0));
    }

    #[tokio::test]
    async fn scope_convergence_cannot_make_sales_document_or_stock_batch_join_ambiguous() {
        for domain in ["sale", "stock"] {
            let mut db = memory_fixture(67, None, false).await;
            if domain == "sale" {
                sqlx::raw_sql(
                    "ALTER TABLE sales_invoices ADD COLUMN invoice_number TEXT;
                     INSERT INTO sales_invoices(id,pharmacy_id,amount,invoice_number)
                       VALUES('historical-sale','local_default',9,'SAME-NUMBER'),
                             ('another-real-sale','primary_pharmacy',5,'same-number');",
                ).execute(&mut db).await.unwrap();
            } else {
                sqlx::raw_sql(
                    "CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
                         batch_number TEXT,expiry_date TEXT,quantity REAL,cost_price REAL);
                     INSERT INTO inventory VALUES
                       ('historic-lot',42,'local_default','BATCH-42','2030-01-01',2,23),
                       ('newer-lot',42,'primary_pharmacy','batch-42','2030-01-01',1,24);",
                ).execute(&mut db).await.unwrap();
            }
            let before = non_scope_physical_witness(&mut db).await.unwrap();
            let (originals, census) = originals_and_scope_sha(&mut db).await.unwrap();
            assert!(transactional_normalize(&mut db,[19;32],census,[29;32],67,&originals).await.is_err());
            assert_eq!(non_scope_physical_witness(&mut db).await.unwrap(),before);
            assert_eq!(sqlx::query_scalar::<_,i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='native_copy_only_scope_audit'")
                .fetch_one(&mut db).await.unwrap(),0);
        }
    }

    #[tokio::test]
    async fn synthetic_foreign_scope_and_disputed_owner_are_never_approved() {
        let (trust, _) = fixture();
        let mut foreign = memory_fixture(67, Some("other-tenant"), false).await;
        assert!(originals_and_scope_sha(&mut foreign).await.is_err());
        let original: String = sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices")
            .fetch_one(&mut foreign)
            .await
            .unwrap();
        assert_eq!(original, "other-tenant");
        let mut disputed = memory_fixture(52, None, true).await;
        assert!(
            version_and_owner(&mut disputed, &trust).await.is_ok(),
            "Exact signed original owner may stage a copy while custody marker is retained"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM native_owner_scope_review")
            .fetch_one(&mut disputed)
            .await
            .unwrap();
        assert_eq!(count, 1);
        sqlx::query("INSERT INTO native_owner_scope_review VALUES('other-owner','still disputed')")
            .execute(&mut disputed)
            .await
            .unwrap();
        assert!(
            version_and_owner(&mut disputed, &trust).await.is_err(),
            "A different historical disputed owner is never inherited"
        );
    }

    #[tokio::test]
    async fn synthetic_checksum_tamper_is_not_an_authorized_scope_source() {
        let (trust, _) = fixture();
        let mut db = memory_fixture(52, None, false).await;
        assert_eq!(version_and_owner(&mut db, &trust).await.unwrap(), 52);
        sqlx::query("UPDATE _sqlx_migrations SET checksum=X'010203' WHERE version=32")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(version_and_owner(&mut db, &trust).await.is_err());
        let original: String = sqlx::query_scalar("SELECT pharmacy_id FROM users")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(original, "local_default");
    }

    #[tokio::test]
    async fn synthetic_generated_scope_dependents_fail_closed_before_any_update() {
        let mut db = memory_fixture(52, None, false).await;
        sqlx::query(concat!(
            "CREATE TABLE derived_scope(id TEXT PRIMARY KEY,pharmacy_id TEXT,",
            "amount REAL, derived_owner TEXT GENERATED ALWAYS AS(pharmacy_id || ':' || amount) STORED)"
        ))
        .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO derived_scope(id,pharmacy_id,amount) VALUES('receipt','local_default',17.125)")
            .execute(&mut db).await.unwrap();
        let old: String = sqlx::query_scalar("SELECT derived_owner FROM derived_scope")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(old, "local_default:17.125");
        assert!(
            originals_and_scope_sha(&mut db).await.is_err(),
            "Scoped generated columns must not change as an unreviewed side effect"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT derived_owner FROM derived_scope")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            old
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT pharmacy_id FROM derived_scope")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            "local_default"
        );
    }

    #[tokio::test]
    async fn typed_physical_witness_detects_even_tiny_financial_changes_and_rowid_loss() {
        let mut db = memory_fixture(52, None, false).await;
        let before = non_scope_physical_witness(&mut db).await.unwrap();
        assert_eq!(before, non_scope_physical_witness(&mut db).await.unwrap());
        sqlx::query("UPDATE sales_invoices SET amount=17.123456788 WHERE id='synthetic-sale'")
            .execute(&mut db)
            .await
            .err()
            .expect("original guard should block a direct write");
        sqlx::query("DROP TRIGGER native_financial_scope_guard")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("UPDATE sales_invoices SET amount=17.123456788 WHERE id='synthetic-sale'")
            .execute(&mut db)
            .await
            .unwrap();
        assert_ne!(before, non_scope_physical_witness(&mut db).await.unwrap());
        sqlx::query("UPDATE sales_invoices SET amount=17.123456789 WHERE id='synthetic-sale'")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM sales_invoices WHERE id='synthetic-sale'")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices(rowid,id,pharmacy_id,amount) VALUES(1000,'synthetic-sale',NULL,17.123456789)")
            .execute(&mut db)
            .await
            .unwrap();
        assert_ne!(
            before,
            non_scope_physical_witness(&mut db).await.unwrap(),
            "Physically replaced rows cannot masquerade as identical history"
        );
    }

    #[tokio::test]
    async fn synthetic_inactive_historical_owner_remains_preserved_without_becoming_actor() {
        let (trust, _) = fixture();
        let mut db = memory_fixture(52, None, false).await;
        sqlx::query("INSERT INTO users VALUES('retired-owner','owner',0,NULL)")
            .execute(&mut db)
            .await
            .unwrap();
        assert_eq!(version_and_owner(&mut db, &trust).await.unwrap(), 52);
        assert_eq!(originals_and_scope_sha(&mut db).await.unwrap().0.len(), 3);
    }

    #[tokio::test]
    async fn synthetic_atomic_failure_restores_original_cells_and_native_triggers() {
        let mut db = memory_fixture(67, None, false).await;
        let (mut originals, digest) = originals_and_scope_sha(&mut db).await.unwrap();
        originals.push(ScopeOriginal {
            table: "sales_invoices".into(),
            rowid_alias: "_rowid_",
            rowid: 999999,
            storage: "null".into(),
            literal: None,
        });
        assert!(
            transactional_normalize(&mut db, [19; 32], digest, [29; 32], 67, &originals)
                .await
                .is_err()
        );
        let old: Option<String> = sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(old, None);
        let actor: String = sqlx::query_scalar("SELECT pharmacy_id FROM users")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(actor, "local_default");
        assert!(sqlx::query("UPDATE sales_invoices SET amount=10")
            .execute(&mut db)
            .await
            .is_err());
        let archives: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='native_copy_only_scope_originals'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(archives, 0);
    }

    #[test]
    fn synthetic_signature_is_bound_to_source_tenant_owner_version_and_expiry() {
        let (trust, signer) = fixture();
        let mut ticket = SignedCopyOnlyTicket {
            source_sha256: [1; 32],
            scope_sha256: [2; 32],
            nonce: [3; 32],
            expires_unix_seconds: 99,
            ed25519_signature: [0; 64],
        };
        let message = digest_message(&ticket, &trust, 67).unwrap();
        ticket
            .ed25519_signature
            .copy_from_slice(signer.sign(&message).as_ref());
        let verify = |msg: &[u8]| {
            UnparsedPublicKey::new(&ED25519, trust.key)
                .verify(msg, &ticket.ed25519_signature)
                .is_ok()
        };
        assert!(verify(&message));
        assert!(!verify(&digest_message(&ticket, &trust, 52).unwrap()));
        let mut changed = ticket.source_sha256;
        changed[0] ^= 1;
        ticket.source_sha256 = changed;
        assert!(!verify(&digest_message(&ticket, &trust, 67).unwrap()));
    }

    #[tokio::test]
    async fn synthetic_expired_or_missing_nonce_refuses_before_any_file_write() {
        let (trust, _) = fixture();
        let mut expired = SignedCopyOnlyTicket {
            source_sha256: [1; 32],
            scope_sha256: [2; 32],
            nonce: [3; 32],
            expires_unix_seconds: 99,
            ed25519_signature: [0; 64],
        };
        let impossible = Path::new("no-file-should-be-opened-for-an-expired-approval.sqlite3");
        let root = Path::new("no-disposable-stage-should-be-created");
        assert!(prepare_with_trust(impossible, root, &expired, 100, &trust)
            .await
            .is_err());
        expired.nonce = [0; 32];
        expired.expires_unix_seconds = 200;
        assert!(prepare_with_trust(impossible, root, &expired, 100, &trust)
            .await
            .is_err());
    }
}
