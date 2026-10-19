use crate::commands::auth::LocalSessionState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

const MAX_BACKUP_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB, including live WAL snapshot.
const BACKUP_NAME: &str = "pharma_local.db";
const MANIFEST_NAME: &str = "backup_manifest.json";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024;
const BACKUP_FORMAT: &str = "pharma-backup-snapshot-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RecoveryFileIdentity {
    volume: u64,
    file_id: u64,
}

// The manifest and SQLite snapshot must each have their own file identity.
// A hard link can otherwise redirect a seemingly private recovery point back
// to a writable live/customer file without using a symlink or reparse point.
#[cfg(windows)]
fn recovery_file_identity(file: &File) -> Result<(RecoveryFileIdentity, u32), String> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct FileInfo {
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
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
    }
    // SAFETY: `file` owns a valid Win32 file handle; `FileInfo` is the exact
    // BY_HANDLE_FILE_INFORMATION fixed-size C layout. Windows writes only
    // into the uniquely borrowed stack object; the handle stays open.
    let info = unsafe {
        let mut info: FileInfo = std::mem::zeroed();
        if GetFileInformationByHandle(file.as_raw_handle(), &mut info) == 0 {
            return Err(format!(
                "Cannot inspect recovery file identity: {}",
                std::io::Error::last_os_error()
            ));
        }
        info
    };
    Ok((
        RecoveryFileIdentity {
            volume: u64::from(info.volume_serial),
            file_id: (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        },
        info.links,
    ))
}

#[cfg(unix)]
fn recovery_file_identity(file: &File) -> Result<(RecoveryFileIdentity, u32), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let links = u32::try_from(meta.nlink()).map_err(|_| "Recovery file has excessive links")?;
    Ok((
        RecoveryFileIdentity {
            volume: meta.dev(),
            file_id: meta.ino(),
        },
        links,
    ))
}

#[cfg(not(any(windows, unix)))]
fn recovery_file_identity(_file: &File) -> Result<(RecoveryFileIdentity, u32), String> {
    Err("Recovery preview is unavailable without trusted native file identities".into())
}

fn pin_recovery_file(path: &Path, max_bytes: u64) -> Result<(File, RecoveryFileIdentity), String> {
    assert_no_link_components(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Permit other readers, but deny all writers and deletions while the
        // verifier holds this file. This protects our separate SQLx reader
        // and streamed checksums from a concurrent Windows replace/write.
        options.share_mode(0x0000_0001); // FILE_SHARE_READ
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Cannot exclusively inspect recovery snapshot: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > max_bytes {
        return Err("Recovery snapshot member is missing or too large".into());
    }
    let (identity, links) = recovery_file_identity(&file)?;
    if links != 1 {
        return Err("Recovery snapshot member has an unsafe hard-link alias".into());
    }
    assert_no_link_components(path)?;
    Ok((file, identity))
}

#[derive(Serialize)]
struct BackupManifest<'a> {
    format: &'static str,
    backup_id: &'a str,
    database_file: &'static str,
    sha256: &'a str,
    size_bytes: u64,
    created_unix_ms: u128,
    source_name: &'a str,
    source_path_sha256: &'a str,
    created_by_owner: Option<&'a str>,
}

// Deserialize into a closed, typed shape instead of accepting arbitrary JSON
// fields or letting renderer-provided metadata override trusted native paths.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryManifest {
    format: String,
    backup_id: String,
    database_file: String,
    sha256: String,
    size_bytes: u64,
    created_unix_ms: u128,
    source_name: String,
    source_path_sha256: String,
    created_by_owner: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecoveryPreview {
    status: &'static str,
    backup_id: String,
    source_name: String,
    size_bytes: u64,
    created_unix_ms: u128,
    created_by_owner: Option<String>,
    sha256: String,
    warning: &'static str,
}

/// A rehearsal result is deliberately not a restore permission. The UI never
/// receives a path and cannot redirect the native staging destination.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRehearsalResult {
    status: &'static str,
    request_id: String,
    backup_id: String,
    sha256: String,
    size_bytes: u64,
    migration_count: usize,
    warning: &'static str,
}

// Files inside app-local-data can still be redirected by junctions/reparse
// points or symlinks. Check each path component rather than only its leaf.
fn assert_no_link_components(path: &Path) -> Result<(), String> {
    let mut cursor = path;
    loop {
        if let Ok(meta) = fs::symlink_metadata(cursor) {
            if meta.file_type().is_symlink() {
                return Err("Backup path contains a symlink".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("Backup path contains a Windows reparse point".into());
                }
            }
        }
        match cursor.parent() {
            Some(parent) if parent != cursor => cursor = parent,
            _ => break,
        }
    }
    Ok(())
}

fn assert_plain_file(path: &Path) -> Result<(), String> {
    assert_no_link_components(path)?;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BACKUP_BYTES {
        return Err("Backup source or snapshot has invalid type or excessive size".into());
    }
    Ok(())
}

async fn check_business_integrity(
    connection: &mut SqliteConnection,
    require_full_schema: bool,
) -> Result<(), String> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN
          ('users','inventory','daily_journals','journal_entries','accounts')",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if require_full_schema
        && (!tables.iter().any(|name| name == "users")
            || !tables.iter().any(|name| name == "inventory"))
    {
        return Err("Unrecognized source database; no trusted pharmacy provenance".into());
    }
    let has_financial = ["daily_journals", "journal_entries", "accounts"]
        .iter()
        .filter(|table| tables.iter().any(|name| name == **table))
        .count();
    if has_financial != 0 && has_financial != 3 {
        return Err("Incomplete accounting schema; refusing backup export".into());
    }
    if has_financial == 3 {
        let invalid = sqlx::query(
            r#"SELECT e.id FROM journal_entries e
               LEFT JOIN daily_journals j ON j.id=e.journal_id
               LEFT JOIN accounts a ON a.id=e.account_id
               WHERE j.id IS NULL OR a.id IS NULL
                  OR typeof(e.amount) NOT IN ('integer','real')
                  OR e.amount < 0 OR e.amount > 1000000000000
                  OR LOWER(TRIM(COALESCE(e.type,''))) NOT IN ('debit','credit')
               LIMIT 1"#,
        )
        .fetch_optional(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
        if invalid.is_some() {
            return Err("Backup financial integrity failed: invalid journal entry".into());
        }
        let unbalanced = sqlx::query(
            r#"SELECT e.journal_id FROM journal_entries e
               GROUP BY e.journal_id
               HAVING ABS(COALESCE(SUM(CASE
                 WHEN LOWER(TRIM(e.type))='debit' THEN e.amount ELSE -e.amount END),0)) > 0.005
               LIMIT 1"#,
        )
        .fetch_optional(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
        if unbalanced.is_some() {
            return Err("Backup financial integrity failed: unbalanced journal".into());
        }
    }
    Ok(())
}

async fn check_integrity(
    connection: &mut SqliteConnection,
    require_full_schema: bool,
) -> Result<(), String> {
    let results: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check(100)")
        .fetch_all(&mut *connection)
        .await
        .map_err(|e| format!("Database cannot be backed up safely: {e}"))?;
    if results != ["ok"] {
        return Err("Database integrity check failed. Keep the database and its WAL together; do not replace them with the seed database.".into());
    }
    let orphan = sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut *connection)
        .await
        .map_err(|e| format!("Database foreign-key check failed: {e}"))?;
    if orphan.is_some() {
        return Err("Database contains orphaned foreign-key references; backup rejected".into());
    }
    check_business_integrity(connection, require_full_schema).await?;
    Ok(())
}

fn file_hash(path: &Path) -> Result<(String, u64), String> {
    assert_plain_file(path)?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut block = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut block).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > MAX_BACKUP_BYTES {
            return Err("Backup exceeds maximum snapshot size".into());
        }
        hasher.update(&block[..n]);
    }
    Ok((format!("{:x}", hasher.finalize()), bytes))
}

fn sync_file(path: &Path) -> Result<(), String> {
    // FlushFileBuffers on Windows requires a writable file handle; the
    // isolated snapshot has not yet been sealed read-only at this point.
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())
}

fn private_directory(directory: &Path) -> Result<(), String> {
    let parent = directory.parent().ok_or("Backup parent missing")?;
    assert_no_link_components(parent)?;
    if !parent.is_dir() {
        return Err("Backup parent is not a directory".into());
    }
    if !directory.exists() {
        fs::create_dir(directory).map_err(|e| e.to_string())?;
    }
    assert_no_link_components(directory)?;
    if !fs::symlink_metadata(directory)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Backup destination is not a directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Existing folders are intentionally not changed (may contain backups
        // created by another app version). New directories are mode 0700.
        if directory
            .read_dir()
            .map_err(|e| e.to_string())?
            .next()
            .is_none()
        {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn cleanup_incomplete(directory: &Path) {
    // Only clean this freshly minted UUID directory; never recurse into other
    // backups or the customer database. Symlink replacement fails closed.
    if assert_no_link_components(directory).is_err() {
        return;
    }
    for file in [
        "pharma_local.db.partial",
        BACKUP_NAME,
        "backup_manifest.json.partial",
        MANIFEST_NAME,
    ] {
        let target = directory.join(file);
        if fs::symlink_metadata(&target)
            .map(|m| m.is_file())
            .unwrap_or(false)
            && assert_no_link_components(&target).is_ok()
        {
            let _ = fs::remove_file(target);
        }
    }
    let _ = fs::remove_dir(directory);
}

async fn validate_created_backup_snapshot(
    path: &Path,
    require_full_schema: bool,
) -> Result<(), String> {
    // The manifest hashes the copied MAIN database file, not an untrusted
    // WAL that may appear beside it after VACUUM INTO completes.
    let mut backup = SqliteConnection::connect_with(&immutable_snapshot_options(path))
        .await
        .map_err(|e| e.to_string())?;
    let check = check_integrity(&mut backup, require_full_schema).await;
    backup.close().await.map_err(|e| e.to_string())?;
    check
}

async fn create_backup_with_lineage(
    source: &Path,
    owner: Option<&str>,
) -> Result<(PathBuf, String, String), String> {
    assert_plain_file(source)?;
    let options = SqliteConnectOptions::new().filename(source).read_only(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    // Trusted automatic schema/catalog repair can back up historic partial
    // databases before forward migrations supply modern users/inventory.
    // Only the externally exposed full-system export requires that schema.
    check_integrity(&mut connection, owner.is_some()).await?;
    // page_count includes committed WAL pages from this reader's snapshot.
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    if pages <= 0
        || page_size <= 0
        || (pages as u128) * (page_size as u128) > MAX_BACKUP_BYTES as u128
    {
        return Err("Backup exceeds maximum snapshot size".into());
    }
    let directory = source
        .parent()
        .ok_or("Database directory is missing")?
        .join("backups");
    private_directory(&directory)?;
    // UUID namespace plus create_dir (not create_dir_all) is no-overwrite.
    let backup_id = uuid::Uuid::new_v4().to_string();
    let isolated = directory.join(&backup_id);
    fs::create_dir(&isolated).map_err(|e| e.to_string())?;
    private_directory(&isolated)?;
    let result = async {
        let destination = isolated.join("pharma_local.db.partial");
        let complete = isolated.join(BACKUP_NAME);
        let manifest = isolated.join(MANIFEST_NAME);
        let manifest_tmp = isolated.join("backup_manifest.json.partial");
        for target in [&destination, &complete, &manifest, &manifest_tmp] {
            if fs::symlink_metadata(target).is_ok() {
                return Err("Backup destination already exists; refusing overwrite".into());
            }
        }
        // SQLite's VACUUM INTO makes a committed WAL-aware snapshot; a
        // partially written file never receives the final filename.
        sqlx::query("VACUUM INTO ?")
            .bind(destination.to_str().ok_or("Invalid backup path")?)
            .execute(&mut connection)
            .await
            .map_err(|e| format!("Backup failed; do not use incomplete file: {e}"))?;
        connection.close().await.map_err(|e| e.to_string())?;
        assert_plain_file(&destination)?;
        validate_created_backup_snapshot(&destination, owner.is_some()).await?;
        let (digest, len) = file_hash(&destination)?;
        sync_file(&destination)?;
        let origin = source.canonicalize().map_err(|e| e.to_string())?;
        let source_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid source file name")?;
        let source_digest = format!("{:x}", Sha256::digest(origin.to_string_lossy().as_bytes()));
        let created_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let lineage = BackupManifest {
            format: "pharma-backup-snapshot-v1",
            backup_id: &backup_id,
            database_file: BACKUP_NAME,
            sha256: &digest,
            size_bytes: len,
            created_unix_ms,
            source_name,
            source_path_sha256: &source_digest,
            created_by_owner: owner,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&lineage).map_err(|e| e.to_string())?;
        {
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&manifest_tmp)
                .map_err(|e| e.to_string())?;
            output
                .write_all(&manifest_bytes)
                .map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
        }
        assert_no_link_components(&isolated)?;
        if fs::symlink_metadata(&complete).is_ok() || fs::symlink_metadata(&manifest).is_ok() {
            return Err("Backup target changed; refusing overwrite".into());
        }
        fs::rename(&destination, &complete).map_err(|e| e.to_string())?;
        fs::rename(&manifest_tmp, &manifest).map_err(|e| e.to_string())?;
        let (verified_digest, verified_len) = file_hash(&complete)?;
        if digest != verified_digest || len != verified_len {
            return Err("Backup checksum mismatch after publication".into());
        }
        // Seal the output as a noneditable recovery point after validation.
        fs::set_permissions(&complete, {
            let mut p = fs::metadata(&complete)
                .map_err(|e| e.to_string())?
                .permissions();
            p.set_readonly(true);
            p
        })
        .map_err(|e| e.to_string())?;
        fs::set_permissions(&manifest, {
            let mut p = fs::metadata(&manifest)
                .map_err(|e| e.to_string())?
                .permissions();
            p.set_readonly(true);
            p
        })
        .map_err(|e| e.to_string())?;
        Ok((complete, backup_id, digest))
    }
    .await;
    if result.is_err() {
        cleanup_incomplete(&isolated);
    }
    result
}

// Used by native schema-repair and catalog workflows. Callers are trusted
// Rust code, never renderer-controlled filesystem paths or credentials.
pub async fn create_backup(source: &Path) -> Result<PathBuf, String> {
    create_backup_with_lineage(source, None)
        .await
        .map(|(path, _, _)| path)
}

pub(crate) async fn require_backup_admin(
    source: &Path,
    user_id: &str,
    password: &str,
) -> Result<(), String> {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let hash: Option<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE id = ? AND is_active = 1 AND role IN ('owner', 'admin')",
    ).bind(user_id).fetch_optional(&mut connection).await.map_err(|e| e.to_string())?.flatten();
    if !hash.is_some_and(|hash| bcrypt::verify(password, &hash).unwrap_or(false)) {
        return Err("يلزم حساب مدير أو مالك نشط وكلمة مرور صحيحة لحفظ نسخة كاملة".into());
    }
    Ok(())
}

// A full database backup discloses every pharmacy's patients, procurement,
// inventory costs and journal history. Branch admins may perform narrowly
// scoped catalog repairs, but may NOT export the system-wide archive.
async fn require_backup_owner(source: &Path, user_id: &str, password: &str) -> Result<(), String> {
    if user_id.is_empty() || user_id.len() > 128 || password.is_empty() || password.len() > 1024 {
        return Err("A current owner account and password are required for full backup".into());
    }
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let hash: Option<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND LOWER(TRIM(role))='owner'",
    ).bind(user_id).fetch_optional(&mut connection).await.map_err(|e| e.to_string())?.flatten();
    connection.close().await.map_err(|e| e.to_string())?;
    if !hash.is_some_and(|stored| bcrypt::verify(password, &stored).unwrap_or(false)) {
        return Err("A current owner account and password are required for full backup".into());
    }
    Ok(())
}

// Building a full-system archive can take appreciable time. A login session
// held across the command only protects against local logout; another app
// instance can still demote/disable this owner or rotate its password in the
// live database during VACUUM INTO. Never disclose a newly completed archive
// path based solely on the pre-copy authorization check.
async fn release_owner_backup_path(
    source: &Path,
    user_id: &str,
    password: &str,
    archive: &Path,
) -> Result<String, String> {
    require_backup_owner(source, user_id, password).await?;
    Ok(archive.to_string_lossy().into_owned())
}

fn valid_backup_id(backup_id: &str) -> Result<(), String> {
    if backup_id.len() != 36
        || !matches!(backup_id.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        || uuid::Uuid::parse_str(backup_id)
            .map(|id| id.get_version_num() == 4 && id.to_string() == backup_id)
            .unwrap_or(false)
            == false
    {
        return Err("Backup ID must be a canonical UUIDv4; paths are not accepted".into());
    }
    Ok(())
}

fn read_recovery_manifest(path: &Path) -> Result<(RecoveryManifest, Vec<u8>), String> {
    assert_no_link_components(path)?;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_MANIFEST_BYTES {
        return Err("Backup manifest is missing or exceeds trusted size limits".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Backup manifest exceeds trusted size limits".into());
    }
    let parsed = serde_json::from_slice(&bytes)
        .map_err(|_| "Backup manifest has invalid or unexpected fields".to_string())?;
    Ok((parsed, bytes))
}

fn digest_is_canonical(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_manifest_provenance(
    manifest: &RecoveryManifest,
    backup_id: &str,
    source: &Path,
    checksum: &str,
    size: u64,
) -> Result<(), String> {
    if manifest.format != BACKUP_FORMAT
        || manifest.backup_id != backup_id
        || manifest.database_file != BACKUP_NAME
        || manifest.size_bytes != size
        || !digest_is_canonical(&manifest.sha256)
        || manifest.sha256 != checksum
        || !digest_is_canonical(&manifest.source_path_sha256)
    {
        return Err("Backup manifest lineage, size or SHA256 mismatch".into());
    }
    let expected_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid live database name")?;
    let canonical_source = source.canonicalize().map_err(|e| e.to_string())?;
    let expected_source_hash = format!(
        "{:x}",
        Sha256::digest(canonical_source.to_string_lossy().as_bytes(),)
    );
    if expected_name != BACKUP_NAME
        || manifest.source_name != expected_name
        || manifest.source_path_sha256 != expected_source_hash
    {
        return Err("Backup source does not match this application's live database".into());
    }
    if manifest.created_unix_ms < 946_684_800_000 {
        return Err("Backup timestamp is invalid".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    if manifest.created_unix_ms > now.saturating_add(5 * 60 * 1000) {
        return Err("Backup timestamp is in the future".into());
    }
    if manifest.created_by_owner.as_deref().is_some_and(|owner| {
        owner.is_empty()
            || owner.len() > 128
            || owner.trim() != owner
            || owner.chars().any(char::is_control)
    }) {
        return Err("Backup creator metadata is invalid".into());
    }
    Ok(())
}

// Preview's held handles are dropped before a rehearsal stages its own pinned
// files. A different on-disk manifest could therefore be opened between those
// two phases. Never associate a successful clone/receipt with manifest bytes
// that were not independently validated against BOTH the copy and preview.
// This is consistency verification, NOT a signature or trusted-origin proof.
fn validate_rehearsal_manifest_bytes(
    manifest_bytes: &[u8],
    preview: &BackupRecoveryPreview,
    backup_id: &str,
    source: &Path,
    digest: &str,
    size: u64,
) -> Result<(), String> {
    if manifest_bytes.is_empty() || manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Recovery manifest cannot be staged safely".into());
    }
    let manifest: RecoveryManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|_| "Recovery manifest has invalid or unexpected fields".to_string())?;
    validate_manifest_provenance(&manifest, backup_id, source, digest, size)?;
    if preview.status != "verified_read_only_preview"
        || preview.backup_id != backup_id
        || preview.sha256 != digest
        || preview.size_bytes != size
        || manifest.created_unix_ms != preview.created_unix_ms
        || manifest.created_by_owner != preview.created_by_owner
        || manifest.source_name != preview.source_name
    {
        return Err("Recovery manifest differs from the validated preview".into());
    }
    Ok(())
}

fn recovery_snapshot_paths(source: &Path, backup_id: &str) -> Result<(PathBuf, PathBuf), String> {
    valid_backup_id(backup_id)?;
    let root = source
        .parent()
        .ok_or("Missing database app-data directory")?
        .join("backups");
    let folder = root.join(backup_id);
    assert_no_link_components(&folder)?;
    if !fs::symlink_metadata(&folder)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Backup ID does not identify an existing directory".into());
    }
    // Published snapshots contain precisely these two names. Reject SQLite
    // sidecars, partial outputs and any other files that could affect
    // read-only SQLite interpretation.
    let mut saw_database = false;
    let mut saw_manifest = false;
    for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == BACKUP_NAME && !saw_database {
            saw_database = true;
        } else if name == MANIFEST_NAME && !saw_manifest {
            saw_manifest = true;
        } else {
            return Err("Backup directory contains unexpected or incomplete files".into());
        }
    }
    if !saw_database || !saw_manifest {
        return Err("Backup snapshot files are missing".into());
    }
    let database = folder.join(BACKUP_NAME);
    let manifest = folder.join(MANIFEST_NAME);
    assert_plain_file(&database)?;
    assert_no_link_components(&manifest)?;
    Ok((database, manifest))
}

// A previously pinned file descriptor proves which BYTES were read, but on
// Unix it does not prove that the same pathname still publishes those bytes.
// Re-resolve the trusted UUID directory as well as its two member identities.
// Keep the returned handles open while publishing the final receipt so Windows
// also denies concurrent write/delete after this last check.
fn pin_matching_recovery_source(
    source: &Path,
    backup_id: &str,
    expected_database: &Path,
    expected_manifest: &Path,
    expected_database_identity: RecoveryFileIdentity,
    expected_manifest_identity: RecoveryFileIdentity,
) -> Result<(File, File), String> {
    let (database, manifest) = recovery_snapshot_paths(source, backup_id)?;
    if database != expected_database || manifest != expected_manifest {
        return Err("Recovery source path changed during rehearsal".into());
    }
    let (database_handle, database_id) = pin_recovery_file(&database, MAX_BACKUP_BYTES)?;
    let (manifest_handle, manifest_id) = pin_recovery_file(&manifest, MAX_MANIFEST_BYTES)?;
    if database_id != expected_database_identity || manifest_id != expected_manifest_identity {
        return Err("Recovery source file identity changed during rehearsal".into());
    }
    Ok((database_handle, manifest_handle))
}

fn immutable_snapshot_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .immutable(true)
}

async fn release_owner_recovery_preview(
    source: &Path,
    actor_id: &str,
    password: &str,
    preview: BackupRecoveryPreview,
) -> Result<BackupRecoveryPreview, String> {
    // A separate instance can revoke or rotate credentials during the full
    // integrity scan; do not return verified backup metadata to stale owners.
    require_backup_owner(source, actor_id, password).await?;
    Ok(preview)
}

// This is deliberately PREVIEW ONLY. Verification cannot establish an
// authentic creator: the SHA256 in an unsigned JSON manifest is not a MAC or
// signature, and a local adversary can rewrite both the file and manifest.
// No file is copied, renamed, replaced, deleted or opened for writing here.
async fn verify_recovery_preview_on_source(
    source: &Path,
    backup_id: &str,
    actor_id: &str,
    password: &str,
) -> Result<BackupRecoveryPreview, String> {
    valid_backup_id(backup_id)?;
    assert_plain_file(source)?;
    require_backup_owner(source, actor_id, password).await?;
    let (database, manifest_path) = recovery_snapshot_paths(source, backup_id)?;
    // Pin both published members before opening any SQLx connection. Windows
    // sharing denies write/delete while these handles remain live; Unix path
    // replacement is detected by the inode comparison after validation.
    let (_held_database, original_database_identity) =
        pin_recovery_file(&database, MAX_BACKUP_BYTES)?;
    let (_held_manifest, original_manifest_identity) =
        pin_recovery_file(&manifest_path, MAX_MANIFEST_BYTES)?;
    if original_database_identity == original_manifest_identity {
        return Err("Backup manifest and snapshot cannot be the same file".into());
    }
    let (manifest, original_manifest) = read_recovery_manifest(&manifest_path)?;
    let (checksum, size) = file_hash(&database)?;
    validate_manifest_provenance(&manifest, backup_id, source, &checksum, size)?;

    // Open this immutable, isolated snapshot without ever creating a DB or
    // touching the live database. The existing business checker covers
    // accounting balance/orphan constraints as well as the FK pragma.
    let mut conn = SqliteConnection::connect_with(&immutable_snapshot_options(&database))
        .await
        .map_err(|e| format!("Cannot inspect backup snapshot: {e}"))?;
    let check = async {
        check_integrity(&mut conn, true).await?;
        // Unlike the 100-result save-time probe, preview also performs the
        // complete SQLite integrity scan before reporting a verified file.
        let full: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_all(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        if full != ["ok"] {
            return Err("Backup full SQLite integrity check failed".into());
        }
        Ok::<(), String>(())
    }
    .await;
    let close = conn.close().await.map_err(|e| e.to_string());
    check?;
    close?;

    // Recheck the exact bytes after SQLite has read them. This is a
    // non-authorizing preview; no file can be assumed immutable indefinitely.
    let (after_checksum, after_size) = file_hash(&database)?;
    if after_checksum != checksum || after_size != size {
        return Err("Backup contents changed while being verified".into());
    }
    let (after_database, after_manifest) = recovery_snapshot_paths(source, backup_id)?;
    let (_after_database_handle, after_database_identity) =
        pin_recovery_file(&after_database, MAX_BACKUP_BYTES)?;
    let (_after_manifest_handle, after_manifest_identity) =
        pin_recovery_file(&after_manifest, MAX_MANIFEST_BYTES)?;
    // Bound the second manifest read before checking for concurrent edits.
    let (_, after_manifest_bytes) = read_recovery_manifest(&after_manifest)?;
    if after_database != database
        || after_manifest != manifest_path
        || after_database_identity != original_database_identity
        || after_manifest_identity != original_manifest_identity
        || after_manifest_bytes != original_manifest
    {
        return Err("Backup path or manifest changed while being verified".into());
    }
    release_owner_recovery_preview(
        source,
        actor_id,
        password,
        BackupRecoveryPreview {
            status: "verified_read_only_preview",
            backup_id: backup_id.to_string(),
            source_name: manifest.source_name,
            size_bytes: size,
            created_unix_ms: manifest.created_unix_ms,
            created_by_owner: manifest.created_by_owner,
            sha256: checksum,
            warning: "Verification only; not authorization to restore. SHA256 is not a signature.",
        },
    )
    .await
}

#[tauri::command]
pub async fn verify_database_backup_recovery_preview(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    backup_id: String,
    password: String,
) -> Result<BackupRecoveryPreview, String> {
    let actor = session.authorize_session().await?;
    let actor_id = actor.as_deref().ok_or("Owner login required")?;
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(BACKUP_NAME);
    verify_recovery_preview_on_source(&source, &backup_id, actor_id, &password).await
}

// Compare migration checksums from trusted live storage to a read-only staged
// snapshot. This protects against loading an unknown or downgraded schema; it
// does not turn a checksum-only backup manifest into a signature.
async fn migration_fingerprint(
    path: &Path,
    immutable_clone: bool,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .immutable(immutable_clone),
    )
    .await
    .map_err(|e| format!("Cannot read migration lineage: {e}"))?;
    let result = async {
        let failed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success <> 1")
                .fetch_one(&mut conn)
                .await
                .map_err(|_| "Migration history is missing or incomplete".to_string())?;
        if failed != 0 {
            return Err("Unsuccessful source migration; rehearsal denied".into());
        }
        let rows = sqlx::query(
            "SELECT version, checksum FROM _sqlx_migrations ORDER BY version LIMIT 513",
        )
        .fetch_all(&mut conn)
        .await
        .map_err(|e| format!("Cannot establish migration lineage: {e}"))?;
        if rows.is_empty() || rows.len() > 512 {
            return Err("Migration provenance missing or outside bounded range".into());
        }
        let mut versions = Vec::with_capacity(rows.len());
        for row in rows {
            let version: i64 = row.try_get("version").map_err(|e| e.to_string())?;
            let checksum: Vec<u8> = row.try_get("checksum").map_err(|e| e.to_string())?;
            if version <= 0
                || checksum.len() != 48
                || versions
                    .last()
                    .is_some_and(|(last, _): &(i64, Vec<u8>)| *last >= version)
            {
                return Err("Malformed or duplicate migration version/checksum".into());
            }
            versions.push((version, checksum));
        }
        Ok::<_, String>(versions)
    }
    .await;
    let closed = conn.close().await.map_err(|e| e.to_string());
    closed?;
    result
}

/// Cross-check an explicitly bounded set of persisted tenant ownerships.
/// Never normalize missing historical pharmacy IDs to the current owner;
/// those snapshots require external accounting/site identity review.
async fn tenant_fingerprint(path: &Path, immutable_clone: bool) -> Result<Vec<String>, String> {
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .immutable(immutable_clone),
    )
    .await
    .map_err(|e| e.to_string())?;
    let result = async {
        let mut tenants = std::collections::BTreeSet::new();
        for table in [
            "users",
            "inventory",
            "sales_invoices",
            "purchase_invoices",
            "returns",
            "cash_movements",
            "daily_journals",
        ] {
            let exists: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
            )
            .bind(table)
            .fetch_optional(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
            if exists.is_none() {
                continue;
            }
            // Safe fixed names only; no renderer strings ever interpolate SQL.
            let sql = format!("SELECT DISTINCT pharmacy_id FROM main.{table} LIMIT 1001");
            let scope: Vec<Option<String>> = sqlx::query_scalar(&sql)
                .fetch_all(&mut conn)
                .await
                .map_err(|_| format!("Missing immutable tenant scope in {table}"))?;
            if scope.len() > 1000 {
                return Err("Tenant universe exceeds rehearsal limit".into());
            }
            for id in scope {
                let id =
                    id.ok_or("Historical NULL-pharmacy ownership cannot be rehearsed safely")?;
                if id.trim().is_empty()
                    || id.trim() != id
                    || id.len() > 256
                    || id.chars().any(char::is_control)
                {
                    return Err("Unverifiable historical tenant identity".into());
                }
                tenants.insert(id);
            }
        }
        if tenants.is_empty() {
            return Err("No provable tenant identity in staged backup".into());
        }
        Ok::<_, String>(tenants.into_iter().collect::<Vec<_>>())
    }
    .await;
    let closed = conn.close().await.map_err(|e| e.to_string());
    closed?;
    result
}

async fn require_unchanged_rehearsal_site(
    source: &Path,
    expected_migrations: &[(i64, Vec<u8>)],
    expected_tenants: &[String],
) -> Result<(), String> {
    if migration_fingerprint(source, false).await?.as_slice() != expected_migrations
        || tenant_fingerprint(source, false).await?.as_slice() != expected_tenants
    {
        return Err("Live migration or tenant ownership changed during recovery rehearsal".into());
    }
    Ok(())
}

fn create_new_synced(path: &Path, bytes: &[u8]) -> Result<File, String> {
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    out.write_all(bytes).map_err(|e| e.to_string())?;
    out.sync_all().map_err(|e| e.to_string())?;
    Ok(out)
}

// Staging is writable to this local user while the async SQLite rehearsal
// runs. Checking a clone's hash only immediately after rename is insufficient:
// a later replacement or a SQLite WAL sidecar can change the evidence used by
// SQLite without changing the previously recorded digest. This verifies the
// exact three pre-receipt members, their pinned native identities and bytes.
// Return the handles so Windows denies writes/removals through publication.
fn pin_matching_rehearsal_evidence(
    attempt: &Path,
    expected_database_identity: RecoveryFileIdentity,
    expected_manifest_identity: RecoveryFileIdentity,
    expected_started_identity: RecoveryFileIdentity,
    expected_database_digest: &str,
    expected_database_size: u64,
    expected_manifest: &[u8],
    expected_started: &[u8],
) -> Result<(File, File, File), String> {
    assert_no_link_components(attempt)?;
    let mut members = std::collections::BTreeSet::new();
    for entry in fs::read_dir(attempt).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name != BACKUP_NAME && name != MANIFEST_NAME && name != "attempt_started.json" {
            return Err("Recovery rehearsal has unexpected files or SQLite sidecars".into());
        }
        if !members.insert(name) {
            return Err("Recovery rehearsal contains duplicate evidence".into());
        }
    }
    if members.len() != 3 {
        return Err("Recovery rehearsal is missing staged evidence".into());
    }
    let staged = attempt.join(BACKUP_NAME);
    let manifest = attempt.join(MANIFEST_NAME);
    let started = attempt.join("attempt_started.json");
    let (staged_file, database_id) = pin_recovery_file(&staged, MAX_BACKUP_BYTES)?;
    let (manifest_file, manifest_id) = pin_recovery_file(&manifest, MAX_MANIFEST_BYTES)?;
    let (started_file, started_id) = pin_recovery_file(&started, MAX_MANIFEST_BYTES)?;
    if database_id != expected_database_identity
        || manifest_id != expected_manifest_identity
        || started_id != expected_started_identity
    {
        return Err("Recovery staged evidence file identity changed".into());
    }
    if file_hash(&staged)?
        != (
            expected_database_digest.to_string(),
            expected_database_size,
        )
    {
        return Err("Recovery staged database changed after hash verification".into());
    }
    for (file, expected) in [(&manifest_file, expected_manifest), (&started_file, expected_started)] {
        let mut bytes = Vec::new();
        file.take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes != expected {
            return Err("Recovery staged manifest or start evidence changed".into());
        }
    }
    // On Unix, a rename can detach a pinned inode from its pathname. Confirm
    // the original identities are STILL published after the bounded reads.
    let (_current_staged, current_database_id) = pin_recovery_file(&staged, MAX_BACKUP_BYTES)?;
    let (_current_manifest, current_manifest_id) = pin_recovery_file(&manifest, MAX_MANIFEST_BYTES)?;
    let (_current_started, current_started_id) = pin_recovery_file(&started, MAX_MANIFEST_BYTES)?;
    if current_database_id != expected_database_identity
        || current_manifest_id != expected_manifest_identity
        || current_started_id != expected_started_identity
    {
        return Err("Recovery staged evidence path changed during verification".into());
    }
    Ok((staged_file, manifest_file, started_file))
}

// A durable, one-time isolated *copy verification* rehearsal. The live DB is
// never renamed, replaced, updated, or used as a copy destination. An orphaned
// started attempt remains as crash evidence; replaying the UUID fails closed.
async fn stage_recovery_rehearsal_on_source(
    source: &Path,
    backup_id: &str,
    request_id: &str,
    actor_id: &str,
    password: &str,
) -> Result<RecoveryRehearsalResult, String> {
    valid_backup_id(request_id)?;
    let preview = verify_recovery_preview_on_source(source, backup_id, actor_id, password).await?;
    let live_migrations = migration_fingerprint(source, false).await?;
    let live_tenants = tenant_fingerprint(source, false).await?;
    let (backup, manifest_path) = recovery_snapshot_paths(source, backup_id)?;
    let (mut verified_backup, original_backup_id) = pin_recovery_file(&backup, MAX_BACKUP_BYTES)?;
    let (verified_manifest, original_manifest_id) =
        pin_recovery_file(&manifest_path, MAX_MANIFEST_BYTES)?;
    if original_backup_id == original_manifest_id {
        return Err("Recovery members alias the same file".into());
    }

    let app_data = source.parent().ok_or("Invalid live database directory")?;
    let rehearsal_root = app_data.join("recovery-rehearsals");
    private_directory(&rehearsal_root)?;
    // Bound accumulation: never delete or recycle another attempt, including
    // a half-written one that may be evidence of interrupted recovery.
    if fs::read_dir(&rehearsal_root)
        .map_err(|e| e.to_string())?
        .take(17)
        .count()
        >= 16
    {
        return Err(
            "Recovery rehearsal limit reached; operator must review existing receipts".into(),
        );
    }
    let attempt = rehearsal_root.join(request_id);
    assert_no_link_components(&attempt)?;
    fs::create_dir(&attempt).map_err(|_| {
        "Recovery request ID already used or destination is unavailable".to_string()
    })?;
    private_directory(&attempt)?;

    // Mark attempt BEFORE writing snapshot bytes; abrupt power loss leaves an
    // unambiguous, never silently overwritten pending record for the operator.
    let started = serde_json::json!({
        "format":"pharma-recovery-rehearsal-v1", "status":"started",
        "request_id":request_id,"backup_id":backup_id,"sha256":preview.sha256,
        "size_bytes":preview.size_bytes,"actor_id":actor_id,
    });
    let started_bytes = serde_json::to_vec(&started).map_err(|e| e.to_string())?;
    let started_handle = create_new_synced(
        &attempt.join("attempt_started.json"),
        &started_bytes,
    )?;
    // Anchor the marker to the file actually created at the start, not a
    // different file rediscovered only after an interruption/substitution.
    let (started_identity, started_links) = recovery_file_identity(&started_handle)?;
    if started_links != 1 {
        return Err("Recovery start evidence has an unsafe hard-link alias".into());
    }
    drop(started_handle);
    let partial = attempt.join("pharma_local.db.partial");
    let mut staged_writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = verified_backup
            .read(&mut buffer)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or("Recovery byte counter overflow")?;
        if bytes > MAX_BACKUP_BYTES {
            return Err("Recovery snapshot exceeds maximum safe size".into());
        }
        hasher.update(&buffer[..read]);
        staged_writer
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
    }
    staged_writer.sync_all().map_err(|e| e.to_string())?;
    drop(staged_writer);
    let digest = format!("{:x}", hasher.finalize());
    if digest != preview.sha256 || bytes != preview.size_bytes {
        return Err("Recovery source changed or does not match its validated manifest".into());
    }
    // Detect replacement of the original path while copying, not just edits
    // to the retained source handles.
    drop(pin_matching_recovery_source(
        source,
        backup_id,
        &backup,
        &manifest_path,
        original_backup_id,
        original_manifest_id,
    )?);

    let mut manifest_bytes = Vec::new();
    verified_manifest
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|e| e.to_string())?;
    validate_rehearsal_manifest_bytes(
        &manifest_bytes,
        &preview,
        backup_id,
        source,
        &digest,
        bytes,
    )?;
    create_new_synced(&attempt.join(MANIFEST_NAME), &manifest_bytes)?;
    let staged = attempt.join(BACKUP_NAME);
    if fs::symlink_metadata(&staged).is_ok() {
        return Err("Recovery staging path already exists".into());
    }
    fs::rename(&partial, &staged).map_err(|e| e.to_string())?;
    if file_hash(&staged)? != (digest.clone(), bytes) {
        return Err("Recovery stage hash failed after publication".into());
    }

    let (_staged_file, staged_identity) = pin_recovery_file(&staged, MAX_BACKUP_BYTES)?;
    let (_staged_manifest, staged_manifest_identity) =
        pin_recovery_file(&attempt.join(MANIFEST_NAME), MAX_MANIFEST_BYTES)?;
    drop(_staged_file);
    drop(_staged_manifest);
    // Ensure SQLite never starts interpreting a staged WAL/SHM sidecar or a
    // substituted database that was not the exact byte-verified clone.
    let during_rehearsal_pins = pin_matching_rehearsal_evidence(
        &attempt,
        staged_identity,
        staged_manifest_identity,
        started_identity,
        &digest,
        bytes,
        &manifest_bytes,
        &started_bytes,
    )?;

    // Stage validation uses its own SQLite connection and must match all
    // installed migration versions/checksums on the current licensed site.
    // SQLite immutable=1 never overlays an external WAL/SHM onto the exact
    // cloned main file. The live-source readers above remain WAL-aware.
    let staged_migrations = migration_fingerprint(&staged, true).await?;
    if staged_migrations != live_migrations {
        return Err("Staged schema/migration history differs from the live installation".into());
    }
    let staged_tenants = tenant_fingerprint(&staged, true).await?;
    if staged_tenants != live_tenants {
        return Err(
            "Staged tenant ownership does not match this installation; operator review required"
                .into(),
        );
    }
    let mut conn = SqliteConnection::connect_with(&immutable_snapshot_options(&staged))
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        check_integrity(&mut conn, true).await?;
        let full: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_all(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        if full != ["ok"] {
            return Err("Rehearsal clone full SQLite integrity check failed".into());
        }
        Ok::<_, String>(())
    }
    .await;
    let close = conn.close().await.map_err(|e| e.to_string());
    result?;
    close?;
    // Role/password can change while the bounded copy and reconciliation are
    // underway. Do not publish a successful receipt under stale privileges.
    require_backup_owner(source, actor_id, password).await?;
    // On Windows, setting the read-only attribute needs the pin released.
    // Re-pin and compare native identities AND bytes below before success.
    drop(during_rehearsal_pins);

    let mut permissions = fs::metadata(&staged)
        .map_err(|e| e.to_string())?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&staged, permissions).map_err(|e| e.to_string())?;
    let complete = serde_json::json!({
        "format":"pharma-recovery-rehearsal-v1", "status":"verified_isolated_copy_only",
        "request_id":request_id, "backup_id":backup_id, "sha256":digest,
        "size_bytes":bytes,"migration_count":live_migrations.len(),
        "warning":"No database was restored or replaced; unsigned source is not authenticated",
    });
    // Another application instance may have added a pharmacy or migration
    // since the initial live snapshot. Reject a stale site-match receipt.
    require_unchanged_rehearsal_site(source, &live_migrations, &live_tenants).await?;
    // The original paths may have been swapped *after* the copy-time pin but
    // during the staged SQLite, migration, tenant, or password checks. Do not
    // publish a successful receipt for an unpublished/different source pair.
    // Hold these last pins through create_new_synced on Windows.
    let _publish_source_handles = pin_matching_recovery_source(
        source,
        backup_id,
        &backup,
        &manifest_path,
        original_backup_id,
        original_manifest_id,
    )?;
    let _publish_staged_handles = pin_matching_rehearsal_evidence(
        &attempt,
        staged_identity,
        staged_manifest_identity,
        started_identity,
        &digest,
        bytes,
        &manifest_bytes,
        &started_bytes,
    )?;
    create_new_synced(
        &attempt.join("rehearsal_verified.json"),
        &serde_json::to_vec(&complete).map_err(|e| e.to_string())?,
    )?;
    Ok(RecoveryRehearsalResult {
        status:"verified_isolated_copy_only",request_id:request_id.to_string(),
        backup_id:backup_id.to_string(),sha256:digest,size_bytes:bytes,
        migration_count:live_migrations.len(),
        warning:"No restore was performed. An unsigned backup is not a trusted origin or an operator-approved recovery.",
    })
}

#[tauri::command]
pub async fn stage_database_recovery_rehearsal_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    backup_id: String,
    request_id: String,
    password: String,
) -> Result<RecoveryRehearsalResult, String> {
    let actor = session.authorize_session().await?;
    let actor_id = actor.as_deref().ok_or("System owner login required")?;
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(BACKUP_NAME);
    stage_recovery_rehearsal_on_source(&source, &backup_id, &request_id, actor_id, &password).await
}

#[tauri::command]
pub async fn export_database_backup(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    user_id: String,
    password: String,
) -> Result<String, String> {
    let _actor_guard = session.authorize_actor(&user_id).await?;
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    require_backup_owner(&source, &user_id, &password).await?;
    let (archive, _, _) = create_backup_with_lineage(&source, Some(&user_id)).await?;
    // No deletion on revoked access: the fully written archive remains
    // auditable, but a stale authenticated renderer never receives its path.
    release_owner_backup_path(&source, &user_id, &password, &archive).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn backup_includes_live_wal_and_never_overwrites_previous_snapshot() {
        let directory =
            std::env::temp_dir().join(format!("pharma-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("source.db");
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE inventory (id INTEGER PRIMARY KEY, quantity REAL);
            CREATE TABLE users (id TEXT, role TEXT, is_active INTEGER, password_hash TEXT);
            INSERT INTO users VALUES ('admin', 'admin', 1, NULL), ('cashier', 'cashier', 1, NULL), ('disabled', 'owner', 0, NULL);
            INSERT INTO inventory VALUES (1, 2.5);")
            .execute(&mut writer).await.unwrap();
        assert!(source.with_extension("db-wal").metadata().unwrap().len() > 0);
        sqlx::query("UPDATE users SET password_hash = ?")
            .bind(bcrypt::hash("test-password", 4).unwrap())
            .execute(&mut writer)
            .await
            .unwrap();
        assert!(require_backup_admin(&source, "admin", "test-password")
            .await
            .is_ok());
        assert!(require_backup_admin(&source, "admin", "wrong-password")
            .await
            .is_err());
        for user in ["cashier", "disabled", "unknown"] {
            assert!(require_backup_admin(&source, user, "test-password")
                .await
                .is_err());
        }
        let first = create_backup(&source).await.unwrap();
        sqlx::query("UPDATE inventory SET quantity = 3.5")
            .execute(&mut writer)
            .await
            .unwrap();
        let second = create_backup(&source).await.unwrap();
        assert_ne!(first, second);
        for (path, expected) in [(&first, 2.5), (&second, 3.5)] {
            assert!(!path.with_extension("db-wal").exists());
            // Open a copy with no source files or sidecars alongside it.
            let standalone = directory.join(format!("{}.db", uuid::Uuid::new_v4()));
            std::fs::copy(path, &standalone).unwrap();
            let mut reader = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(standalone)
                    .read_only(true),
            )
            .await
            .unwrap();
            let quantity: f64 = sqlx::query_scalar("SELECT quantity FROM inventory")
                .fetch_one(&mut reader)
                .await
                .unwrap();
            assert_eq!(quantity, expected);
            reader.close().await.unwrap();
        }
        let quantity: f64 = sqlx::query_scalar("SELECT quantity FROM inventory")
            .fetch_one(&mut writer)
            .await
            .unwrap();
        assert_eq!(quantity, 3.5);
        writer.close().await.unwrap();
        let corrupt = directory.join("corrupt.db");
        std::fs::write(&corrupt, b"not a SQLite database").unwrap();
        assert!(create_backup(&corrupt).await.is_err());
        assert!(create_backup(&directory.join("missing.db")).await.is_err());
        assert!(!directory.join("missing.db").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn created_backup_snapshot_rejects_wal_only_financial_repair() {
        let (source, backup, _) = recovery_fixture().await;
        let live_before = file_hash(&source).unwrap();
        let backup_before = file_hash(&backup).unwrap();
        // Model a local writer racing the integrity scan after VACUUM INTO:
        // main snapshot has an unbalanced journal, WAL alone makes it appear
        // balanced. The manifest hashes only the main file's broken bytes.
        let partial = source.parent().unwrap().join("forged-export.db.partial");
        fs::copy(&backup, &partial).unwrap();
        let mut permissions = fs::metadata(&partial).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&partial, permissions).unwrap();
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(&partial).create_if_missing(false),
        )
        .await
        .unwrap();
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("UPDATE journal_entries SET amount=75 WHERE id=2")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("UPDATE journal_entries SET amount=100 WHERE id=2")
            .execute(&mut writer)
            .await
            .unwrap();
        assert!(partial.with_file_name("forged-export.db.partial-wal").exists());
        let main_hash = file_hash(&partial).unwrap();

        let mut forged_reader = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(&partial).read_only(true),
        )
        .await
        .unwrap();
        assert!(check_integrity(&mut forged_reader, true).await.is_ok());
        forged_reader.close().await.unwrap();
        assert!(
            validate_created_backup_snapshot(&partial, true).await.is_err(),
            "Export must inspect the same main database bytes that its manifest hashes"
        );
        assert_eq!(file_hash(&partial).unwrap(), main_hash);
        writer.close().await.unwrap();
        assert_eq!(file_hash(&source).unwrap(), live_before);
        assert_eq!(file_hash(&backup).unwrap(), backup_before);
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn full_database_export_requires_live_owner_password_not_cross_branch_admin() {
        let dir =
            std::env::temp_dir().join(format!("pharma-backup-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let source = dir.join("source.db");
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT, role TEXT, is_active INTEGER, password_hash TEXT); \
                        CREATE TABLE inventory(id TEXT, pharmacy_id TEXT);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let hash = bcrypt::hash("correct-password", 4).unwrap();
        for (id, role, active) in [
            ("owner", "owner", 1),
            ("branch-admin", "admin", 1),
            ("disabled", "owner", 0),
            ("other", "cashier", 1),
        ] {
            sqlx::query("INSERT INTO users VALUES (?,?,?,?)")
                .bind(id)
                .bind(role)
                .bind(active)
                .bind(&hash)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        conn.close().await.unwrap();
        assert!(require_backup_owner(&source, "owner", "correct-password")
            .await
            .is_ok());
        for id in ["branch-admin", "disabled", "other", "missing"] {
            assert!(require_backup_owner(&source, id, "correct-password")
                .await
                .is_err());
        }
        assert!(require_backup_owner(&source, "owner", "incorrect")
            .await
            .is_err());
        assert!(require_backup_owner(&source, "owner", "").await.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn backup_rejects_unbalanced_or_orphan_financial_history_and_seals_verified_manifest() {
        let dir =
            std::env::temp_dir().join(format!("pharma-backup-ledger-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let source = dir.join("finance.db");
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY);
            CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            INSERT INTO accounts VALUES(1),(2);
            INSERT INTO daily_journals VALUES('j-1');
            INSERT INTO journal_entries VALUES(1,'j-1',1,'debit',100),(2,'j-1',2,'credit',50);
        "#).execute(&mut conn).await.unwrap();
        assert!(create_backup(&source)
            .await
            .unwrap_err()
            .contains("unbalanced"));
        assert!(!source.parent().unwrap().join("backups").exists());
        sqlx::query("UPDATE journal_entries SET amount=100 WHERE id=2")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE journal_entries SET account_id=999 WHERE id=2")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(create_backup(&source)
            .await
            .unwrap_err()
            .contains("invalid journal entry"));
        sqlx::query("UPDATE journal_entries SET account_id=2 WHERE id=2")
            .execute(&mut conn)
            .await
            .unwrap();
        let backup = create_backup(&source).await.unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(backup.parent().unwrap().join(MANIFEST_NAME)).unwrap(),
        )
        .unwrap();
        let (digest, size) = file_hash(&backup).unwrap();
        assert_eq!(manifest["format"], "pharma-backup-snapshot-v1");
        assert_eq!(manifest["sha256"], digest);
        assert_eq!(manifest["size_bytes"], size);
        assert_eq!(manifest["created_by_owner"], serde_json::Value::Null);
        assert!(backup.metadata().unwrap().permissions().readonly());
        conn.close().await.unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    async fn recovery_fixture() -> (PathBuf, PathBuf, String) {
        let root =
            std::env::temp_dir().join(format!("pharma-recovery-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join(BACKUP_NAME);
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, is_active INTEGER, password_hash TEXT);
            CREATE TABLE inventory(id INTEGER PRIMARY KEY, quantity REAL);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY, pharmacy_id TEXT);
            CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY, checksum BLOB, success INTEGER);
            INSERT INTO _sqlx_migrations(version,checksum,success) VALUES(1,zeroblob(48),1);
            CREATE TABLE journal_entries(
                id INTEGER PRIMARY KEY, journal_id TEXT, account_id INTEGER,
                type TEXT, amount REAL
            );
            INSERT INTO inventory VALUES (1, 5);
            INSERT INTO accounts VALUES(1),(2);
            INSERT INTO daily_journals VALUES('j-1','synthetic-pharmacy');
            INSERT INTO journal_entries VALUES
                (1, 'j-1', 1, 'debit', 100),
                (2, 'j-1', 2, 'credit', 100);
        "#).execute(&mut conn).await.unwrap();
        let owner_hash = bcrypt::hash("fresh-owner-secret", 4).unwrap();
        sqlx::query("INSERT INTO users VALUES ('owner','owner',1,?)")
            .bind(owner_hash)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(
            "ALTER TABLE users ADD COLUMN pharmacy_id TEXT;
          ALTER TABLE inventory ADD COLUMN pharmacy_id TEXT;
          UPDATE users SET pharmacy_id='synthetic-pharmacy';
          UPDATE inventory SET pharmacy_id='synthetic-pharmacy';",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
        let (backup, id, _) = create_backup_with_lineage(&source, Some("owner"))
            .await
            .unwrap();
        assert_eq!(backup, root.join("backups").join(&id).join(BACKUP_NAME));
        (source, backup, id)
    }

    #[tokio::test]
    async fn rehearsal_receipt_rejects_live_tenant_or_migration_change_after_initial_match() {
        let (source, backup, _) = recovery_fixture().await;
        let expected_migrations = migration_fingerprint(&source, false).await.unwrap();
        let expected_tenants = tenant_fingerprint(&source, false).await.unwrap();
        assert_eq!(migration_fingerprint(&backup, true).await.unwrap(), expected_migrations);
        assert_eq!(tenant_fingerprint(&backup, true).await.unwrap(), expected_tenants);
        assert!(require_unchanged_rehearsal_site(&source, &expected_migrations, &expected_tenants)
            .await
            .is_ok());
        let original_backup = file_hash(&backup).unwrap();

        // Another app instance adds tenant history after the rehearsal has
        // captured its initial live universe. The staged copy remains valid
        // against that stale value, but a success receipt must now be denied.
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(&source).create_if_missing(false),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO inventory(id,quantity,pharmacy_id) VALUES(2,1,'new-site')")
            .execute(&mut writer)
            .await
            .unwrap();
        assert!(require_unchanged_rehearsal_site(&source, &expected_migrations, &expected_tenants)
            .await
            .unwrap_err()
            .contains("tenant ownership changed"));

        sqlx::query("DELETE FROM inventory WHERE id=2")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("INSERT INTO _sqlx_migrations(version,checksum,success) VALUES(2,zeroblob(48),1)")
            .execute(&mut writer)
            .await
            .unwrap();
        assert_eq!(tenant_fingerprint(&source, false).await.unwrap(), expected_tenants);
        assert!(require_unchanged_rehearsal_site(&source, &expected_migrations, &expected_tenants)
            .await
            .unwrap_err()
            .contains("migration or tenant"));
        writer.close().await.unwrap();
        assert_eq!(file_hash(&backup).unwrap(), original_backup);
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn completed_backup_path_is_denied_after_owner_revocation_or_password_rotation() {
        // Model another native app instance changing owner authorization
        // after a full backup has been committed but before IPC returns the
        // archive pathname. No customer database or destructive restore.
        let (source, archive, _) = recovery_fixture().await;
        let original_archive = file_hash(&archive).unwrap();
        assert_eq!(
            release_owner_backup_path(&source, "owner", "fresh-owner-secret", &archive)
                .await
                .unwrap(),
            archive.to_string_lossy().into_owned()
        );

        let mut conn =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE users SET is_active = 0 WHERE id = 'owner'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            release_owner_backup_path(&source, "owner", "fresh-owner-secret", &archive)
                .await
                .is_err()
        );

        sqlx::query("UPDATE users SET is_active = 1, role = 'cashier' WHERE id = 'owner'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            release_owner_backup_path(&source, "owner", "fresh-owner-secret", &archive)
                .await
                .is_err()
        );

        let rotated_hash = bcrypt::hash("new-owner-secret", 4).unwrap();
        sqlx::query("UPDATE users SET role = 'owner', password_hash = ? WHERE id = 'owner'")
            .bind(rotated_hash)
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
        assert!(
            release_owner_backup_path(&source, "owner", "fresh-owner-secret", &archive)
                .await
                .is_err()
        );
        assert_eq!(
            release_owner_backup_path(&source, "owner", "new-owner-secret", &archive)
                .await
                .unwrap(),
            archive.to_string_lossy().into_owned()
        );
        // Revocation does not delete, replace, or alter a completed snapshot.
        assert_eq!(file_hash(&archive).unwrap(), original_archive);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn recovery_preview_refuses_success_after_owner_is_disabled_during_verification() {
        let (source, backup, id) = recovery_fixture().await;
        let before_backup = file_hash(&backup).unwrap();
        let before_live = file_hash(&source).unwrap();
        // The first authentication and full preview succeeded. A concurrent
        // native instance now removes the owner's authorization before IPC
        // publishes the verified cross-pharmacy backup metadata.
        let preview =
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret")
                .await
                .unwrap();
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(false),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE users SET is_active=0 WHERE id='owner'")
            .execute(&mut writer)
            .await
            .unwrap();
        assert!(
            release_owner_recovery_preview(&source, "owner", "fresh-owner-secret", preview)
                .await
                .unwrap_err()
                .contains("current owner")
        );
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret")
                .await
                .is_err()
        );
        writer.close().await.unwrap();
        assert_eq!(file_hash(&backup).unwrap(), before_backup);
        assert_ne!(file_hash(&source).unwrap(), before_live);
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    fn overwrite_test_file(path: &Path, contents: &[u8]) {
        // Test fixture snapshots are intentionally sealed read-only.
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn rewrite_test_manifest(path: &Path, change: impl FnOnce(&mut serde_json::Value)) {
        let mut json: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        change(&mut json);
        overwrite_test_file(path, &serde_json::to_vec(&json).unwrap());
    }

    fn clean_isolated_rehearsal_test_root(source: &Path) {
        let root = source.parent().unwrap();
        let rehearsals = root.join("recovery-rehearsals");
        if let Ok(attempts) = fs::read_dir(&rehearsals) {
            for attempt in attempts.flatten() {
                let clone = attempt.path().join(BACKUP_NAME);
                if let Ok(metadata) = fs::metadata(&clone) {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    fs::set_permissions(clone, permissions).unwrap();
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rehearsal_stages_verified_immutable_clone_without_touching_live_or_backup() {
        let (source, backup, backup_id) = recovery_fixture().await;
        let source_before = file_hash(&source).unwrap();
        let backup_before = file_hash(&backup).unwrap();
        let nonce = uuid::Uuid::new_v4().to_string();
        let stage = stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret",
        )
        .await
        .unwrap();
        assert_eq!(stage.status, "verified_isolated_copy_only");
        assert_eq!(stage.backup_id, backup_id);
        assert_eq!(stage.request_id, nonce);
        assert_eq!(stage.sha256, backup_before.0);
        assert_eq!(stage.size_bytes, backup_before.1);
        assert_eq!(stage.migration_count, 1);
        assert!(stage.warning.contains("No restore"));
        let attempt = source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(nonce);
        assert!(!attempt.join("pharma_local.db.partial").exists());
        assert_eq!(
            file_hash(&attempt.join(BACKUP_NAME)).unwrap(),
            backup_before
        );
        assert_eq!(fs::read_dir(&attempt).unwrap().count(), 4);
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(attempt.join("rehearsal_verified.json")).unwrap())
                .unwrap();
        assert_eq!(receipt["status"], "verified_isolated_copy_only");
        assert_eq!(file_hash(&source).unwrap(), source_before);
        assert_eq!(file_hash(&backup).unwrap(), backup_before);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn staged_rehearsal_receipt_rejects_sidecars_and_changed_evidence_after_first_hash() {
        // Synthetic evidence for the gap AFTER the clone's first hash but
        // BEFORE publishing a successful read-only rehearsal receipt.
        let (source, backup, _) = recovery_fixture().await;
        let live_before = file_hash(&source).unwrap();
        let original_backup = file_hash(&backup).unwrap();
        let rehearsal_root = source.parent().unwrap().join("recovery-rehearsals");
        private_directory(&rehearsal_root).unwrap();
        let attempt = rehearsal_root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&attempt).unwrap();
        private_directory(&attempt).unwrap();
        let staged = attempt.join(BACKUP_NAME);
        fs::copy(&backup, &staged).unwrap();
        let original_manifest = fs::read(backup.parent().unwrap().join(MANIFEST_NAME)).unwrap();
        let staged_manifest = attempt.join(MANIFEST_NAME);
        create_new_synced(&staged_manifest, &original_manifest).unwrap();
        let start_bytes = b"{\"format\":\"synthetic-test\",\"status\":\"started\"}";
        let started = attempt.join("attempt_started.json");
        let start_handle = create_new_synced(&started, start_bytes).unwrap();
        let (started_id, links) = recovery_file_identity(&start_handle).unwrap();
        assert_eq!(links, 1);
        drop(start_handle);
        let (db_pin, db_id) = pin_recovery_file(&staged, MAX_BACKUP_BYTES).unwrap();
        let (manifest_pin, manifest_id) =
            pin_recovery_file(&staged_manifest, MAX_MANIFEST_BYTES).unwrap();
        drop(db_pin);
        drop(manifest_pin);
        let verify = || {
            pin_matching_rehearsal_evidence(
                &attempt,
                db_id,
                manifest_id,
                started_id,
                &original_backup.0,
                original_backup.1,
                &original_manifest,
                start_bytes,
            )
        };
        drop(verify().unwrap());

        // SQLite can interpret -wal/-shm during read-only inspection, even if
        // the copied main .db still hashes to the expected source SHA256.
        for suffix in ["-wal", "-shm"] {
            let sidecar = attempt.join(format!("{BACKUP_NAME}{suffix}"));
            fs::write(&sidecar, b"attacker-controlled sidecar").unwrap();
            let error = verify().unwrap_err();
            assert!(error.contains("sidecars"), "{error}");
            assert_eq!(file_hash(&staged).unwrap(), original_backup);
            assert!(!attempt.join("rehearsal_verified.json").exists());
            fs::remove_file(sidecar).unwrap();
        }

        // Changing the manifest or the durable started receipt must also
        // preclude claiming this rehearsal completed with original evidence.
        fs::write(&staged_manifest, b"forged staged manifest").unwrap();
        assert!(verify().unwrap_err().contains("manifest or start evidence"));
        fs::write(&staged_manifest, &original_manifest).unwrap();
        fs::write(&started, b"forged actor").unwrap();
        assert!(verify().unwrap_err().contains("manifest or start evidence"));
        fs::write(&started, start_bytes).unwrap();

        // A byte-identical pathname replacement changes the native file ID
        // even when the original SHA256 is unchanged. Do not bless it.
        let mut permissions = fs::metadata(&staged).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&staged, permissions).unwrap();
        let displaced = source.parent().unwrap().join("detached-staged-archive.db");
        fs::rename(&staged, &displaced).unwrap();
        fs::copy(&displaced, &staged).unwrap();
        assert_eq!(file_hash(&staged).unwrap(), original_backup);
        assert!(verify().unwrap_err().contains("identity changed"));

        let (current_pin, current_db_id) = pin_recovery_file(&staged, MAX_BACKUP_BYTES).unwrap();
        drop(current_pin);
        let mut corrupted = fs::read(&staged).unwrap();
        corrupted[0] ^= 0xff;
        fs::write(&staged, corrupted).unwrap();
        assert!(pin_matching_rehearsal_evidence(
            &attempt,
            current_db_id,
            manifest_id,
            started_id,
            &original_backup.0,
            original_backup.1,
            &original_manifest,
            start_bytes,
        )
        .unwrap_err()
        .contains("database changed"));
        assert!(!attempt.join("rehearsal_verified.json").exists());
        assert_eq!(file_hash(&source).unwrap(), live_before);
        assert_eq!(file_hash(&backup).unwrap(), original_backup);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_rejects_byte_identical_replacement_of_started_receipt() {
        let (source, backup, _) = recovery_fixture().await;
        let original_backup = file_hash(&backup).unwrap();
        let root = source.parent().unwrap().join("recovery-rehearsals");
        private_directory(&root).unwrap();
        let attempt = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&attempt).unwrap();
        let staged = attempt.join(BACKUP_NAME);
        fs::copy(&backup, &staged).unwrap();
        let manifest_bytes = fs::read(backup.parent().unwrap().join(MANIFEST_NAME)).unwrap();
        fs::write(attempt.join(MANIFEST_NAME), &manifest_bytes).unwrap();
        let started = attempt.join("attempt_started.json");
        let started_bytes = b"{\"format\":\"synthetic-test\",\"status\":\"started\"}";
        create_new_synced(&started, started_bytes).unwrap();
        let (db_pin, db_id) = pin_recovery_file(&staged, MAX_BACKUP_BYTES).unwrap();
        let (manifest_pin, manifest_id) =
            pin_recovery_file(&attempt.join(MANIFEST_NAME), MAX_MANIFEST_BYTES).unwrap();
        let (start_pin, original_start_id) =
            pin_recovery_file(&started, MAX_MANIFEST_BYTES).unwrap();
        drop((db_pin, manifest_pin, start_pin));

        // Recreate the same marker bytes under another native file identity,
        // hiding that the original durable interruption marker was removed.
        let replacement = attempt.join("new-started.json");
        fs::write(&replacement, started_bytes).unwrap();
        fs::remove_file(&started).unwrap();
        fs::rename(replacement, &started).unwrap();
        let (replacement_pin, replacement_id) =
            pin_recovery_file(&started, MAX_MANIFEST_BYTES).unwrap();
        drop(replacement_pin);
        assert_ne!(original_start_id, replacement_id);
        assert_eq!(fs::read(&started).unwrap(), started_bytes);
        assert!(
            pin_matching_rehearsal_evidence(
                &attempt,
                db_id,
                manifest_id,
                original_start_id,
                &original_backup.0,
                original_backup.1,
                &manifest_bytes,
                started_bytes,
            )
            .is_err(),
            "A byte-identical new start marker must not inherit interruption evidence custody"
        );
        assert!(!attempt.join("rehearsal_verified.json").exists());
        assert_eq!(file_hash(&backup).unwrap(), original_backup);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_rechecks_pinned_manifest_against_preview_after_repinned_source() {
        // Deterministically model a writer replacing the manifest during the
        // preview->stage handle gap. The snapshot itself remains byte-identical.
        let (source, backup, backup_id) = recovery_fixture().await;
        let source_before = file_hash(&source).unwrap();
        let backup_before = file_hash(&backup).unwrap();
        let preview =
            verify_recovery_preview_on_source(&source, &backup_id, "owner", "fresh-owner-secret")
                .await
                .unwrap();
        let original = fs::read(backup.parent().unwrap().join(MANIFEST_NAME)).unwrap();
        validate_rehearsal_manifest_bytes(
            &original,
            &preview,
            &backup_id,
            &source,
            &backup_before.0,
            backup_before.1,
        )
        .unwrap();

        for field in [
            "backup_id",
            "sha256",
            "size_bytes",
            "source_path_sha256",
            "source_name",
            "created_by_owner",
            "created_unix_ms",
            "format",
            "database_file",
            "extra_field",
        ] {
            let mut forged: serde_json::Value = serde_json::from_slice(&original).unwrap();
            match field {
                "backup_id" => forged[field] = serde_json::json!(uuid::Uuid::new_v4().to_string()),
                "sha256" | "source_path_sha256" => {
                    forged[field] = serde_json::json!("a".repeat(64))
                }
                "size_bytes" => forged[field] = serde_json::json!(backup_before.1 + 1),
                "source_name" | "database_file" => {
                    forged[field] = serde_json::json!("wrong.sqlite")
                }
                "created_by_owner" => forged[field] = serde_json::json!("another-owner"),
                "created_unix_ms" => forged[field] = serde_json::json!(preview.created_unix_ms + 1),
                "format" => forged[field] = serde_json::json!("untrusted-format"),
                "extra_field" => forged[field] = serde_json::json!("untrusted"),
                _ => unreachable!(),
            }
            let replacement = serde_json::to_vec(&forged).unwrap();
            assert!(
                validate_rehearsal_manifest_bytes(
                    &replacement,
                    &preview,
                    &backup_id,
                    &source,
                    &backup_before.0,
                    backup_before.1,
                )
                .is_err(),
                "manifest substitution in {field} must not receive a verified rehearsal"
            );
        }
        for malformed in [b"{}".as_slice(), b"not-json", b""] {
            assert!(validate_rehearsal_manifest_bytes(
                malformed,
                &preview,
                &backup_id,
                &source,
                &backup_before.0,
                backup_before.1,
            )
            .is_err());
        }
        assert_eq!(file_hash(&source).unwrap(), source_before);
        assert_eq!(file_hash(&backup).unwrap(), backup_before);
        assert!(!source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .exists());
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_final_source_pin_refuses_same_bytes_republished_under_new_file_identity() {
        // Model a same-user filesystem writer after the copy-time pin and
        // before receipt publication. On Unix, an open file descriptor does
        // not stop a pathname replacement; on Windows, the attacker must
        // wait for the earlier read pins to close before attempting this.
        let (source, backup, backup_id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let live_before = file_hash(&source).unwrap();
        let original_snapshot = file_hash(&backup).unwrap();
        let original_manifest = fs::read(&manifest).unwrap();
        let (backup_handle, original_backup_id) =
            pin_recovery_file(&backup, MAX_BACKUP_BYTES).unwrap();
        let (manifest_handle, original_manifest_id) =
            pin_recovery_file(&manifest, MAX_MANIFEST_BYTES).unwrap();
        assert!(pin_matching_recovery_source(
            &source,
            &backup_id,
            &backup,
            &manifest,
            original_backup_id,
            original_manifest_id,
        )
        .is_ok());
        drop(backup_handle);
        drop(manifest_handle);

        // An identical byte-for-byte snapshot in the same pathname must not
        // inherit the previously verified file's identity.
        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&backup, permissions).unwrap();
        let displaced_backup = source.parent().unwrap().join("detached-backup.db");
        fs::rename(&backup, &displaced_backup).unwrap();
        fs::copy(&displaced_backup, &backup).unwrap();
        assert_eq!(file_hash(&backup).unwrap(), original_snapshot);
        let error = pin_matching_recovery_source(
            &source,
            &backup_id,
            &backup,
            &manifest,
            original_backup_id,
            original_manifest_id,
        )
        .unwrap_err();
        assert!(error.contains("identity changed"), "{error}");

        // Also detect a republished manifest even when its verified JSON
        // bytes, signed metadata assumptions, and SQLite hash are unchanged.
        let (current_backup_handle, current_backup_id) =
            pin_recovery_file(&backup, MAX_BACKUP_BYTES).unwrap();
        drop(current_backup_handle);
        let mut permissions = fs::metadata(&manifest).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&manifest, permissions).unwrap();
        let displaced_manifest = source.parent().unwrap().join("detached-manifest.json");
        fs::rename(&manifest, &displaced_manifest).unwrap();
        fs::copy(&displaced_manifest, &manifest).unwrap();
        assert_eq!(fs::read(&manifest).unwrap(), original_manifest);
        let error = pin_matching_recovery_source(
            &source,
            &backup_id,
            &backup,
            &manifest,
            current_backup_id,
            original_manifest_id,
        )
        .unwrap_err();
        assert!(error.contains("identity changed"), "{error}");

        assert!(!source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .exists());
        assert_eq!(file_hash(&source).unwrap(), live_before);
        assert_eq!(file_hash(&backup).unwrap(), original_snapshot);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_rejects_nonce_replay_across_restart_and_preserves_verified_receipt() {
        let (source, _backup, backup_id) = recovery_fixture().await;
        let nonce = uuid::Uuid::new_v4().to_string();
        stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret",
        )
        .await
        .unwrap();
        let receipt = source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(&nonce)
            .join("rehearsal_verified.json");
        let previous = fs::read(&receipt).unwrap();
        assert!(stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret"
        )
        .await
        .unwrap_err()
        .contains("already used"));
        assert_eq!(fs::read(&receipt).unwrap(), previous);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_refuses_explicit_forged_actor_password_ids_and_corrupt_snapshot() {
        let (source, backup, backup_id) = recovery_fixture().await;
        let nonce = uuid::Uuid::new_v4().to_string();
        let source_before = file_hash(&source).unwrap();
        for (actor, password) in [
            ("other", "fresh-owner-secret"),
            ("owner", "wrong"),
            ("", "fresh-owner-secret"),
        ] {
            assert!(stage_recovery_rehearsal_on_source(
                &source, &backup_id, &nonce, actor, password
            )
            .await
            .is_err());
        }
        for invalid_id in ["../../live", "", "00000000-0000-0000-0000-000000000000"] {
            assert!(stage_recovery_rehearsal_on_source(
                &source,
                &backup_id,
                invalid_id,
                "owner",
                "fresh-owner-secret"
            )
            .await
            .is_err());
        }
        assert!(!source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(&nonce)
            .exists());
        let mut damaged = fs::read(&backup).unwrap();
        damaged[0] ^= 0xff;
        overwrite_test_file(&backup, &damaged);
        assert!(stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret"
        )
        .await
        .is_err());
        assert_eq!(file_hash(&source).unwrap(), source_before);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_refuses_migration_downgrade_without_replacing_any_live_data() {
        let (source, backup, backup_id) = recovery_fixture().await;
        let before_backup = file_hash(&backup).unwrap();
        let mut conn =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum=randomblob(48) WHERE version=1")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
        let source_before = file_hash(&source).unwrap();
        let nonce = uuid::Uuid::new_v4().to_string();
        let error = stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret",
        )
        .await
        .unwrap_err();
        assert!(error.contains("migration"), "{error}");
        let attempt = source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(&nonce);
        assert!(attempt.join("attempt_started.json").exists());
        assert!(!attempt.join("rehearsal_verified.json").exists());
        assert_eq!(file_hash(&source).unwrap(), source_before);
        assert_eq!(file_hash(&backup).unwrap(), before_backup);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_rejects_cross_tenant_snapshot_even_if_unsigned_manifest_is_rehashed() {
        let (source, backup, backup_id) = recovery_fixture().await;
        let original_source = file_hash(&source).unwrap();
        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&backup, permissions).unwrap();
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&backup)
                .read_only(false),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE inventory SET pharmacy_id='foreign-pharmacy'")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let (sha, size) = file_hash(&backup).unwrap();
        rewrite_test_manifest(&manifest, |entry| {
            entry["sha256"] = serde_json::json!(sha);
            entry["size_bytes"] = serde_json::json!(size);
        });
        let nonce = uuid::Uuid::new_v4().to_string();
        let error = stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret",
        )
        .await
        .unwrap_err();
        assert!(error.contains("tenant ownership"), "{error}");
        let folder = source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(&nonce);
        assert!(folder.join("attempt_started.json").exists());
        assert!(!folder.join("rehearsal_verified.json").exists());
        assert_eq!(file_hash(&source).unwrap(), original_source);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn rehearsal_rejects_foreign_cash_movements_hidden_from_core_tenant_tables() {
        let (source, _, _) = recovery_fixture().await;
        let mut live =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
                .await
                .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE cash_movements(id TEXT PRIMARY KEY, pharmacy_id TEXT NOT NULL); \
             INSERT INTO cash_movements VALUES('cash-1','synthetic-pharmacy');",
        )
        .execute(&mut live)
        .await
        .unwrap();
        live.close().await.unwrap();
        let (backup, backup_id, _) = create_backup_with_lineage(&source, Some("owner"))
            .await
            .unwrap();
        let original_live = file_hash(&source).unwrap();

        // Only cash-movement ownership is forged. The existing five checked
        // tenant tables still match, and the unsigned manifest is recomputed.
        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&backup, permissions).unwrap();
        let mut forged =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backup))
                .await
                .unwrap();
        sqlx::query("UPDATE cash_movements SET pharmacy_id='foreign-pharmacy'")
            .execute(&mut forged)
            .await
            .unwrap();
        forged.close().await.unwrap();
        let (digest, size) = file_hash(&backup).unwrap();
        rewrite_test_manifest(&backup.parent().unwrap().join(MANIFEST_NAME), |manifest| {
            manifest["sha256"] = serde_json::json!(digest);
            manifest["size_bytes"] = serde_json::json!(size);
        });

        let nonce = uuid::Uuid::new_v4().to_string();
        let result = stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret",
        )
        .await;
        let rejected_for_tenant = result
            .as_ref()
            .is_err_and(|error| error.contains("tenant ownership"));
        let attempt = source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(&nonce);
        let published = attempt.join("rehearsal_verified.json").exists();
        let live_unchanged = file_hash(&source).unwrap() == original_live;
        clean_isolated_rehearsal_test_root(&source);
        assert!(
            rejected_for_tenant,
            "Rehearsal must reject foreign cash history even when core tenants match: {result:?}"
        );
        assert!(!published);
        assert!(live_unchanged);
    }

    #[tokio::test]
    async fn rehearsal_rejects_foreign_financial_journal_tenant_with_matching_core_tables() {
        let (source, _, _) = recovery_fixture().await;
        let (backup, backup_id, _) = create_backup_with_lineage(&source, Some("owner"))
            .await
            .unwrap();
        let original_live = file_hash(&source).unwrap();

        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&backup, permissions).unwrap();
        let mut forged = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backup))
            .await
            .unwrap();
        sqlx::query("UPDATE daily_journals SET pharmacy_id='foreign-pharmacy'")
            .execute(&mut forged)
            .await
            .unwrap();
        forged.close().await.unwrap();
        let (digest, size) = file_hash(&backup).unwrap();
        rewrite_test_manifest(&backup.parent().unwrap().join(MANIFEST_NAME), |manifest| {
            manifest["sha256"] = serde_json::json!(digest);
            manifest["size_bytes"] = serde_json::json!(size);
        });

        let nonce = uuid::Uuid::new_v4().to_string();
        let result = stage_recovery_rehearsal_on_source(
            &source, &backup_id, &nonce, "owner", "fresh-owner-secret",
        )
        .await;
        let rejected_for_tenant = result.as_ref().is_err_and(|e| e.contains("tenant ownership"));
        let published = source.parent().unwrap().join("recovery-rehearsals")
            .join(&nonce).join("rehearsal_verified.json").exists();
        let unchanged = file_hash(&source).unwrap() == original_live;
        clean_isolated_rehearsal_test_root(&source);
        assert!(rejected_for_tenant, "Journal-only foreign tenant must fail: {result:?}");
        assert!(!published);
        assert!(unchanged);
    }

    #[tokio::test]
    async fn interrupted_rehearsal_attempt_does_not_replay_or_erase_partial_evidence() {
        let (source, backup, backup_id) = recovery_fixture().await;
        let nonce = uuid::Uuid::new_v4().to_string();
        let root = source.parent().unwrap().join("recovery-rehearsals");
        private_directory(&root).unwrap();
        let attempt = root.join(&nonce);
        fs::create_dir(&attempt).unwrap();
        fs::write(attempt.join("attempt_started.json"), b"interrupted").unwrap();
        fs::write(attempt.join("pharma_local.db.partial"), b"partial").unwrap();
        let original = fs::read(attempt.join("pharma_local.db.partial")).unwrap();
        assert!(stage_recovery_rehearsal_on_source(
            &source,
            &backup_id,
            &nonce,
            "owner",
            "fresh-owner-secret"
        )
        .await
        .unwrap_err()
        .contains("already used"));
        assert_eq!(
            fs::read(attempt.join("pharma_local.db.partial")).unwrap(),
            original
        );
        assert!(!attempt.join("rehearsal_verified.json").exists());
        assert_eq!(file_hash(&backup).unwrap().1 > 0, true);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn concurrent_rehearsal_same_nonce_commits_one_isolated_receipt_only() {
        let (source, backup, backup_id) = recovery_fixture().await;
        let nonce = uuid::Uuid::new_v4().to_string();
        let before_live = file_hash(&source).unwrap();
        let before_backup = file_hash(&backup).unwrap();
        let (first, second) = tokio::join!(
            stage_recovery_rehearsal_on_source(
                &source,
                &backup_id,
                &nonce,
                "owner",
                "fresh-owner-secret"
            ),
            stage_recovery_rehearsal_on_source(
                &source,
                &backup_id,
                &nonce,
                "owner",
                "fresh-owner-secret"
            ),
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        let failure = first.err().or_else(|| second.err()).unwrap();
        assert!(failure.contains("already used"), "{failure}");
        let folder = source
            .parent()
            .unwrap()
            .join("recovery-rehearsals")
            .join(&nonce);
        assert_eq!(fs::read_dir(folder).unwrap().count(), 4);
        assert_eq!(file_hash(&source).unwrap(), before_live);
        assert_eq!(file_hash(&backup).unwrap(), before_backup);
        clean_isolated_rehearsal_test_root(&source);
    }

    #[tokio::test]
    async fn recovery_preview_requires_active_native_owner_password_and_never_changes_live_or_backup(
    ) {
        let (source, backup, id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let before_live = file_hash(&source).unwrap();
        let before_backup = file_hash(&backup).unwrap();
        let before_manifest = fs::read(&manifest).unwrap();
        let preview =
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret")
                .await
                .unwrap();
        assert_eq!(preview.status, "verified_read_only_preview");
        assert_eq!(preview.backup_id, id);
        assert_eq!(preview.source_name, BACKUP_NAME);
        assert_eq!(preview.size_bytes, before_backup.1);
        assert_eq!(preview.sha256, before_backup.0);
        assert_eq!(preview.created_by_owner.as_deref(), Some("owner"));
        assert!(preview.warning.contains("not authorization to restore"));
        assert_eq!(file_hash(&source).unwrap(), before_live);
        assert_eq!(file_hash(&backup).unwrap(), before_backup);
        assert_eq!(fs::read(&manifest).unwrap(), before_manifest);
        assert_eq!(fs::read_dir(backup.parent().unwrap()).unwrap().count(), 2);
        for (actor, password) in [
            ("owner", "incorrect"),
            ("not-the-owner", "fresh-owner-secret"),
            ("owner", ""),
            ("", "fresh-owner-secret"),
        ] {
            assert!(
                verify_recovery_preview_on_source(&source, &id, actor, password,)
                    .await
                    .is_err()
            );
        }
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recovery_preview_refuses_ids_paths_and_forged_or_oversized_manifests() {
        let (source, backup, id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let original = fs::read(&manifest).unwrap();
        for invalid in [
            "",
            "../",
            ".",
            "..\\",
            "pharma_local.db",
            "/etc/passwd",
            "00000000-0000-0000-0000-000000000000",
            "99999999-9999-1999-8999-999999999999",
            "99999999-9999-4999-7999-999999999999",
            "99999999-9999-4999-8999-99999999999Z",
        ] {
            assert!(
                verify_recovery_preview_on_source(&source, invalid, "owner", "fresh-owner-secret",)
                    .await
                    .is_err(),
                "accepted invalid backup ID: {invalid:?}"
            );
        }
        assert!(valid_backup_id(&id.to_ascii_uppercase()).is_err());
        for field in [
            "backup_id",
            "source_name",
            "source_path_sha256",
            "sha256",
            "size_bytes",
            "format",
            "database_file",
            "created_unix_ms",
            "created_by_owner",
            "unrecognized",
        ] {
            overwrite_test_file(&manifest, &original);
            rewrite_test_manifest(&manifest, |json| {
                json[field] = match field {
                    "size_bytes" => serde_json::json!(1),
                    "created_unix_ms" => serde_json::json!(9_999_999_999_999u64),
                    "created_by_owner" => serde_json::json!("x".repeat(200)),
                    _ => serde_json::json!("forged"),
                };
            });
            assert!(
                verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                    .await
                    .is_err(),
                "accepted forged manifest field: {field}"
            );
        }
        overwrite_test_file(&manifest, &vec![b'A'; MAX_MANIFEST_BYTES as usize + 1]);
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_err()
        );
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recovery_preview_rejects_corrupt_snapshot_even_with_recomputed_manifest_digest() {
        let (source, backup, id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let before_live = file_hash(&source).unwrap();
        // A changed backup cannot pass with its original manifest SHA256.
        let mut damaged = fs::read(&backup).unwrap();
        damaged[0] ^= 0xff;
        overwrite_test_file(&backup, &damaged);
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_err()
        );
        // Even attackers capable of re-signing the UNSIGNED manifest's hash
        // cannot make a structurally corrupt SQLite file pass its DB checks.
        let (digest, size) = file_hash(&backup).unwrap();
        rewrite_test_manifest(&manifest, |json| {
            json["sha256"] = serde_json::json!(digest);
            json["size_bytes"] = serde_json::json!(size);
        });
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_err()
        );
        assert_eq!(file_hash(&source).unwrap(), before_live);
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recovery_preview_rejects_unbalanced_financial_history_even_when_hash_matches() {
        let (source, backup, id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let before_live = file_hash(&source).unwrap();
        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&backup, permissions).unwrap();
        let mut conn = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&backup)
                .read_only(false),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE journal_entries SET amount=75 WHERE id=2")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
        let (new_digest, new_size) = file_hash(&backup).unwrap();
        rewrite_test_manifest(&manifest, |json| {
            json["sha256"] = serde_json::json!(new_digest);
            json["size_bytes"] = serde_json::json!(new_size);
        });
        let error = verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret")
            .await
            .unwrap_err();
        assert!(error.contains("unbalanced"), "{error}");
        assert_eq!(file_hash(&source).unwrap(), before_live);
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recovery_preview_rejects_extra_files_and_missing_snapshot_members() {
        let (source, backup, id) = recovery_fixture().await;
        let snapshot_dir = backup.parent().unwrap();
        fs::write(snapshot_dir.join("pharma_local.db-wal"), b"fake").unwrap();
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_err()
        );
        fs::remove_file(snapshot_dir.join("pharma_local.db-wal")).unwrap();
        let manifest = snapshot_dir.join(MANIFEST_NAME);
        let mut permissions = fs::metadata(&manifest).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&manifest, permissions).unwrap();
        fs::remove_file(&manifest).unwrap();
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_err()
        );
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn preview_immutable_reader_rejects_wal_only_financial_repair() {
        // The initial directory scan rejects existing sidecars, but a writer
        // can introduce a WAL between that scan and SQLite opening the file.
        // A read-only SQLite connection would validate the forged WAL view
        // while the manifest SHA256 still describes the broken main file.
        let (source, backup, _) = recovery_fixture().await;
        let before_live = file_hash(&source).unwrap();
        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&backup, permissions).unwrap();
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&backup)
                .create_if_missing(false),
        )
        .await
        .unwrap();
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("UPDATE journal_entries SET amount=75 WHERE id=2")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("UPDATE journal_entries SET amount=100 WHERE id=2")
            .execute(&mut writer)
            .await
            .unwrap();
        assert!(backup.with_file_name(format!("{BACKUP_NAME}-wal")).exists());

        let mut wal_reader = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&backup)
                .read_only(true)
                .create_if_missing(false),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT amount FROM journal_entries WHERE id=2")
                .fetch_one(&mut wal_reader)
                .await
                .unwrap(),
            100.0
        );
        assert!(check_integrity(&mut wal_reader, true).await.is_ok());
        wal_reader.close().await.unwrap();

        // The same options used by the actual preview ignore the attacker
        // sidecar and expose the broken file whose bytes will be hashed.
        let mut preview_reader =
            SqliteConnection::connect_with(&immutable_snapshot_options(&backup))
                .await
                .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT amount FROM journal_entries WHERE id=2")
                .fetch_one(&mut preview_reader)
                .await
                .unwrap(),
            75.0
        );
        assert!(check_integrity(&mut preview_reader, true)
            .await
            .unwrap_err()
            .contains("unbalanced journal"));
        preview_reader.close().await.unwrap();
        writer.close().await.unwrap();
        assert_eq!(file_hash(&source).unwrap(), before_live);
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recovery_preview_refuses_hard_link_aliases_without_changing_live_or_snapshot() {
        let (source, backup, id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let source_before = file_hash(&source).unwrap();
        let backup_before = file_hash(&backup).unwrap();
        let alias = source.parent().unwrap().join("hardlinked-backup.db");
        fs::hard_link(&backup, &alias).unwrap();
        let error = verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret")
            .await
            .unwrap_err();
        assert!(error.contains("hard-link"), "{error}");
        // Windows forbids deleting a hard link to a read-only file. This is
        // an isolated synthetic fixture; temporarily unseal the alias before
        // deleting it, then reseal the surviving published snapshot.
        let mut permissions = fs::metadata(&alias).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&alias, permissions).unwrap();
        fs::remove_file(&alias).unwrap();
        let mut permissions = fs::metadata(&backup).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&backup, permissions).unwrap();
        let manifest_alias = source.parent().unwrap().join("hardlinked-manifest.json");
        fs::hard_link(&manifest, &manifest_alias).unwrap();
        let error = verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret")
            .await
            .unwrap_err();
        assert!(error.contains("hard-link"), "{error}");
        let mut permissions = fs::metadata(&manifest_alias).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&manifest_alias, permissions).unwrap();
        fs::remove_file(&manifest_alias).unwrap();
        let mut permissions = fs::metadata(&manifest).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&manifest, permissions).unwrap();
        assert_eq!(file_hash(&source).unwrap(), source_before);
        assert_eq!(file_hash(&backup).unwrap(), backup_before);
        // Removing an external hard link must not destroy the original file.
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_ok()
        );
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn recovery_preview_pinned_windows_handles_refuse_concurrent_file_writes_and_rename() {
        let (source, backup, _id) = recovery_fixture().await;
        let (held, original) = pin_recovery_file(&backup, MAX_BACKUP_BYTES).unwrap();
        // A verified snapshot must not be writable or replaceable between
        // checksum and SQLx inspection while the native file handle is held.
        assert!(OpenOptions::new().write(true).open(&backup).is_err());
        assert!(fs::rename(&backup, backup.with_extension("db.renamed")).is_err());
        let (second, duplicate) = pin_recovery_file(&backup, MAX_BACKUP_BYTES).unwrap();
        assert_eq!(original, duplicate);
        drop(second);
        drop(held);
        assert!(backup.exists());
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn recovery_preview_rejects_windows_symlink_if_creation_is_permitted() {
        use std::os::windows::fs::symlink_file;
        let (source, backup, id) = recovery_fixture().await;
        let manifest = backup.parent().unwrap().join(MANIFEST_NAME);
        let external = source.parent().unwrap().join("safe-manifest-copy.json");
        fs::copy(&manifest, &external).unwrap();
        let mut permissions = fs::metadata(&manifest).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&manifest, permissions).unwrap();
        fs::remove_file(&manifest).unwrap();
        // Some managed Windows hosts disable symlink creation for unprivileged
        // tests. In that case preserve the fixture and rely on the explicit
        // reparse-attribute branch of assert_no_link_components.
        if symlink_file(&external, &manifest).is_ok() {
            assert!(
                verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                    .await
                    .is_err()
            );
        }
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_preview_rejects_symlink_backup_directories_and_manifest_files() {
        use std::os::unix::fs::symlink;
        let (source, backup, id) = recovery_fixture().await;
        let parent = backup.parent().unwrap();
        let alias_id = uuid::Uuid::new_v4().to_string();
        symlink(parent, parent.parent().unwrap().join(&alias_id)).unwrap();
        assert!(verify_recovery_preview_on_source(
            &source,
            &alias_id,
            "owner",
            "fresh-owner-secret",
        )
        .await
        .is_err());
        let manifest = parent.join(MANIFEST_NAME);
        let external = source.parent().unwrap().join("manifest-copy.json");
        fs::copy(&manifest, &external).unwrap();
        fs::remove_file(&manifest).unwrap();
        symlink(&external, &manifest).unwrap();
        assert!(
            verify_recovery_preview_on_source(&source, &id, "owner", "fresh-owner-secret",)
                .await
                .is_err()
        );
        fs::remove_dir_all(source.parent().unwrap()).unwrap();
    }
}
