//! Read-only release gate before ANY startup compatibility repair or migration.
//! A previous installation without independently identified pharmacy ownership
//! must be preserved as-is and reviewed on a separately backed-up copy.
//! This module never inserts a tenant, rewrites a source row, or accepts an
//! installer/renderer-supplied assertion of who owns historical financial data.

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const BLOCKED: &str = "Legacy pharmacy ownership requires an independently witnessed preservation and upgrade review; original database left unchanged";

/// Operator-selected permanent tenant for the single-pharmacy upgrade.
/// This destination is a future reviewed-copy input, never a claim that
/// historical NULL/blank/local_default source rows already belong to it.
pub(crate) const PRIMARY_PHARMACY_TENANT: &str = "primary_pharmacy";

/// Bind a prospective locally authenticated owner grant to the exact chosen
/// tenant. Matching this string is only one prerequisite: it does not verify
/// an owner credential, a signed source commitment, or authorize source writes.
/// In particular, never silently adopt `local_default` as a destination.
pub(crate) fn validate_primary_pharmacy_destination(candidate: &str) -> Result<&'static str, String> {
    if candidate == PRIMARY_PHARMACY_TENANT {
        Ok(PRIMARY_PHARMACY_TENANT)
    } else {
        Err(BLOCKED.into())
    }
}

const OWNER_ONLY_DOMAIN: &[u8] = b"pharma/native/offline-owner-primary-pharmacy/v1\0";
const OWNER_PROOF_MAX_AGE_SECONDS: u64 = 30 * 24 * 60 * 60;
const SOURCE_SCOPE_TABLES: [&str; 12] = [
    "users", "inventory", "sales_invoices", "purchase_invoices", "returns",
    "activity_log", "shortages", "purchase_orders", "cash_movements",
    "daily_journals", "expenses", "financial_notices",
];

/// The public key must be pinned by a separately authenticated local owner
/// custody channel before this type is built. An archive, unsigned JSON file,
/// renderer, stored legacy bcrypt hash, or activation/license claim cannot
/// establish that trust. No startup/IPC path currently constructs this type.
pub(crate) struct IndependentlyAuthenticatedOwnerKey {
    owner_id: String,
    key: [u8; 32],
    pinned_original_v29_sha256: [u8; 32],
}

impl IndependentlyAuthenticatedOwnerKey {
    pub(crate) fn from_trusted_native_custody(
        owner_id: &str, key: [u8; 32], pinned_original_v29_sha256: [u8; 32],
    ) -> Result<Self, String> {
        if owner_id.is_empty() || owner_id.len() > 128
            || owner_id.trim() != owner_id || !owner_id.is_ascii()
            || owner_id.bytes().any(|byte| byte.is_ascii_control())
            || key.iter().all(|byte| *byte == 0)
            || pinned_original_v29_sha256.iter().all(|byte| *byte == 0)
        {
            return Err(BLOCKED.into());
        }
        Ok(Self { owner_id: owner_id.to_owned(), key, pinned_original_v29_sha256 })
    }

    pub(crate) fn key_fingerprint_sha256(&self) -> [u8; 32] {
        Sha256::digest(self.key).into()
    }
}

/// A native build may pin an independently authenticated owner key, original
/// owner identity and *source archive digest* at packaging time. The proof
/// sidecar, argv, renderer, v29/v67 database, license key and runtime process
/// environment can never select or replace these values. Ordinary builds have
/// no such custody: the result MUST remain an error.
///
/// The three values are customer-specific native build inputs supplied by a
/// genuine independent owner-enrollment procedure (which is NOT implemented
/// here). They are not generated from, or authenticated by, the public 032
/// bootstrap password.
pub(crate) fn independently_pinned_native_owner_key(
) -> Result<IndependentlyAuthenticatedOwnerKey, String> {
    native_owner_key_from_compile_pins(
        option_env!("PHARMA_NATIVE_OWNER_ID"),
        option_env!("PHARMA_NATIVE_OWNER_ED25519_PUBLIC_HEX"),
        option_env!("PHARMA_NATIVE_OWNER_ORIGINAL_V29_SHA256_HEX"),
    )
}

fn decode_strict_hex<const N: usize>(value: &str) -> Result<[u8; N], String> {
    if value.len() != N * 2 || !value.as_bytes().iter().all(|digit|
        digit.is_ascii_digit() || (b'a'..=b'f').contains(digit))
    {
        return Err(BLOCKED.into());
    }
    let mut decoded = [0_u8; N];
    for (index, byte) in decoded.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| BLOCKED.to_string())?;
    }
    Ok(decoded)
}

fn native_owner_key_from_compile_pins(
    owner_id: Option<&str>, public_key_hex: Option<&str>, original_v29_sha256_hex: Option<&str>,
) -> Result<IndependentlyAuthenticatedOwnerKey, String> {
    let (Some(owner_id), Some(public_key_hex), Some(original_v29_sha256_hex)) =
        (owner_id, public_key_hex, original_v29_sha256_hex)
    else { return Err(BLOCKED.into()); };
    IndependentlyAuthenticatedOwnerKey::from_trusted_native_custody(
        owner_id,
        decode_strict_hex::<32>(public_key_hex)?,
        decode_strict_hex::<32>(original_v29_sha256_hex)?,
    )
}

/// The signer commits to the ORIGINAL v29 archive SHA, separately pinned
/// detached v67 SHA, all observed typed scope rows and one canonical tenant.
/// Signatures never authorize in-place migration of either source.
#[derive(Clone)]
pub(crate) struct OfflineOwnerOnlyProof {
    pub(crate) original_v29_sha256: [u8; 32],
    pub(crate) detached_v67_sha256: [u8; 32],
    pub(crate) typed_scope_sha256: [u8; 32],
    pub(crate) request_nonce: [u8; 32],
    pub(crate) expires_unix_seconds: u64,
    pub(crate) signature: [u8; 64],
}

/// Strict signed-proof transfer format. All six fields are typed and bounded;
/// specifically, it contains NO public key, asserted owner identity,
/// destination tenant, archive pathname or authority flag. Supplying a
/// signature never enrolls a public key.
pub(crate) fn parse_detached_owner_only_proof_json(
    bytes: &[u8],
) -> Result<OfflineOwnerOnlyProof, String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct WireProof {
        original_v29_sha256: String,
        detached_v67_sha256: String,
        typed_scope_sha256: String,
        request_nonce: String,
        expires_unix_seconds: u64,
        ed25519_signature: String,
    }
    if bytes.len() > 4096 || bytes.is_empty() { return Err(BLOCKED.into()); }
    let raw: WireProof = serde_json::from_slice(bytes).map_err(|_| BLOCKED.to_string())?;
    Ok(OfflineOwnerOnlyProof {
        original_v29_sha256: decode_strict_hex::<32>(&raw.original_v29_sha256)?,
        detached_v67_sha256: decode_strict_hex::<32>(&raw.detached_v67_sha256)?,
        typed_scope_sha256: decode_strict_hex::<32>(&raw.typed_scope_sha256)?,
        request_nonce: decode_strict_hex::<32>(&raw.request_nonce)?,
        expires_unix_seconds: raw.expires_unix_seconds,
        signature: decode_strict_hex::<64>(&raw.ed25519_signature)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OriginalScopeMapping {
    pub(crate) table: &'static str,
    pub(crate) source_rowid: i64,
    pub(crate) source_id: String,
    pub(crate) original_id_type: String,
    pub(crate) original_scope_storage: String,
    pub(crate) original_scope_class: &'static str,
    pub(crate) original_scope_literal: Option<String>,
}

/// An authorized offline projection, not a 065 two-actor reviewer seal or a
/// native finance posting credential. Downstream importers MUST additionally
/// preserve complete original row evidence and native permission boundaries.
pub(crate) struct VerifiedOwnerOnlyImport {
    pub(crate) owner_id: String,
    pub(crate) mappings: Vec<OriginalScopeMapping>,
    pub(crate) typed_scope_sha256: [u8; 32],
    pub(crate) evidence_sha256: [u8; 32],
    pub(crate) signed_message: Vec<u8>,
}

fn hash_component(hash: &mut Sha256, value: &[u8]) -> Result<(), String> {
    let length = u32::try_from(value.len()).map_err(|_| BLOCKED.to_string())?;
    hash.update(length.to_be_bytes());
    hash.update(value);
    Ok(())
}

fn owner_only_message(
    owner_id: &str,
    proof: &OfflineOwnerOnlyProof,
) -> Result<Vec<u8>, String> {
    validate_primary_pharmacy_destination(PRIMARY_PHARMACY_TENANT)?;
    if owner_id.is_empty() || owner_id.len() > 128 || !owner_id.is_ascii()
        || owner_id.trim() != owner_id || owner_id.bytes().any(|b| b.is_ascii_control())
    {
        return Err(BLOCKED.into());
    }
    let mut message = OWNER_ONLY_DOMAIN.to_vec();
    message.extend_from_slice(&proof.original_v29_sha256);
    message.extend_from_slice(&proof.detached_v67_sha256);
    message.extend_from_slice(&proof.typed_scope_sha256);
    message.extend_from_slice(&proof.request_nonce);
    message.extend_from_slice(&proof.expires_unix_seconds.to_be_bytes());
    let mut identity = Sha256::new();
    hash_component(&mut identity, owner_id.as_bytes())?;
    hash_component(&mut identity, PRIMARY_PHARMACY_TENANT.as_bytes())?;
    message.extend_from_slice(&identity.finalize());
    Ok(message)
}

/// Build a strictly read-only, typed-row source map. The exact SQLite file
/// digest independently commits ALL other tables, columns, detail/ledger and
/// schema bytes; this commitment additionally binds every directly scoped
/// original actor/header identity and storage class to the selected tenant.
pub(crate) async fn inspect_detached_v67_scope_map(
    conn: &mut SqliteConnection,
) -> Result<(String, Vec<OriginalScopeMapping>, [u8; 32]), String> {
    if !has_table(conn, "_sqlx_migrations").await? || !has_table(conn, "users").await?
        || !has_column(conn, "users", "password_hash").await?
    {
        return Err(BLOCKED.into());
    }
    let (count, successful, first, last): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0),\
         COALESCE(MIN(version),0),COALESCE(MAX(version),0) FROM _sqlx_migrations"
    ).fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    let contiguous: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT version) FROM _sqlx_migrations WHERE typeof(version)='integer'"
    ).fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if (count, successful, first, last, contiguous) != (67, 67, 1, 67, 67) {
        return Err(BLOCKED.into());
    }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if integrity != "ok" || !sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *conn).await.map_err(|_| BLOCKED.to_string())?.is_empty()
    {
        return Err(BLOCKED.into());
    }
    let owners = sqlx::query(
        "SELECT CAST(id AS TEXT) AS owner_id,password_hash FROM users \
         WHERE LOWER(TRIM(COALESCE(role,'')))='owner' AND COALESCE(is_active,1)=1 LIMIT 2"
    ).fetch_all(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if owners.len() != 1 { return Err(BLOCKED.into()); }
    let owner_id: String = owners[0].try_get("owner_id").map_err(|_| BLOCKED.to_string())?;
    if has_table(conn, "native_owner_scope_review").await? {
        // 053's immutable quarantine is original EVIDENCE of ambiguous 052
        // attribution. A genuine offline owner proof may be inspected while
        // the marker remains (and MUST NOT remove the marker, allow live login
        // or grant 065/068 registration). Reject any other disputed owner.
        let foreign_or_invalid: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_owner_scope_review \
             WHERE typeof(owner_id)!='text' OR owner_id!=?"
        ).bind(&owner_id)
        .fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
        if foreign_or_invalid != 0 { return Err(BLOCKED.into()); }
    }
    let original_hash: Option<String> = owners[0].try_get("password_hash")
        .map_err(|_| BLOCKED.to_string())?;
    // Never treat the original bcrypt as proof. A public/known credential in
    // the v67 clone is an incomplete 032 quarantine, regardless of signature.
    if let Some(hash) = original_hash.as_deref() {
        if hash == bootstrap_hash_from_registered_032()?
            || bcrypt::verify("admin", hash).unwrap_or(false)
        {
            return Err(BLOCKED.into());
        }
    }

    let mut digest = Sha256::new();
    hash_component(&mut digest, b"pharma/native/v67-typed-scope-rows/v1")?;
    let mut mappings = Vec::new();
    for table in SOURCE_SCOPE_TABLES {
        if !has_table(conn, table).await? || !has_column(conn, table, "id").await?
            || !has_column(conn, table, "pharmacy_id").await?
        {
            return Err(BLOCKED.into());
        }
        hash_component(&mut digest, table.as_bytes())?;
        // Every identifier comes from the fixed Rust allowlist.
        let sql = format!(
            "SELECT rowid AS source_rowid, CAST(id AS TEXT) AS source_id,typeof(id) AS id_type,\
             hex(CAST(id AS BLOB)) AS id_hex,typeof(pharmacy_id) AS scope_type,\
             CASE WHEN pharmacy_id IS NULL THEN NULL \
             ELSE hex(CAST(pharmacy_id AS BLOB)) END AS scope_hex,\
             pharmacy_id AS scope FROM \"{table}\" \
             ORDER BY CAST(id AS TEXT) COLLATE BINARY,typeof(id),hex(CAST(id AS BLOB))"
        );
        let rows = sqlx::query(&sql).fetch_all(&mut *conn).await
            .map_err(|_| BLOCKED.to_string())?;
        let mut seen = HashSet::new();
        for row in rows {
            let rowid: i64 = row.try_get("source_rowid").map_err(|_| BLOCKED.to_string())?;
            let id: String = row.try_get("source_id").map_err(|_| BLOCKED.to_string())?;
            let id_type: String = row.try_get("id_type").map_err(|_| BLOCKED.to_string())?;
            let id_hex: String = row.try_get("id_hex").map_err(|_| BLOCKED.to_string())?;
            let scope_type: String = row.try_get("scope_type").map_err(|_| BLOCKED.to_string())?;
            let scope_hex: Option<String> = row.try_get("scope_hex")
                .map_err(|_| BLOCKED.to_string())?;
            let scope: Option<String> = row.try_get("scope").map_err(|_| BLOCKED.to_string())?;
            if id.is_empty() || id.len() > 128 || !id.is_ascii()
                || id.trim() != id || id.bytes().any(|b| b.is_ascii_control())
                || !matches!(id_type.as_str(), "integer" | "text") || !seen.insert(id.clone())
                || !matches!(scope_type.as_str(), "null" | "text")
            {
                return Err(BLOCKED.into());
            }
            let class = match scope.as_deref() {
                None if scope_type == "null" => "null",
                Some(s) if s.trim().is_empty() => "blank",
                Some("local_default") => "local_default",
                Some(PRIMARY_PHARMACY_TENANT) => "explicit",
                _ => return Err(BLOCKED.into()), // Never adopt an unknown tenant.
            };
            hash_component(&mut digest, &rowid.to_be_bytes())?;
            for field in [id_type.as_str(), id_hex.as_str(), scope_type.as_str(),
                scope_hex.as_deref().unwrap_or("NULL"), class] {
                hash_component(&mut digest, field.as_bytes())?;
            }
            mappings.push(OriginalScopeMapping {
                table, source_rowid: rowid, source_id: id, original_id_type: id_type,
                original_scope_storage: scope_type,
                original_scope_class: class, original_scope_literal: scope,
            });
        }
    }
    if !mappings.iter().any(|row| row.table == "users" && row.source_id == owner_id) {
        return Err(BLOCKED.into());
    }
    Ok((owner_id, mappings, digest.finalize().into()))
}

/// An owner signature is checked against an INDEPENDENTLY provisioned native
/// trust anchor, exact detached v67 file pin, typed source map and original
/// v29 archive pin. It cannot be self-authorized by a JSON-provided key.
pub(crate) async fn verify_detached_primary_pharmacy_owner_only(
    conn: &mut SqliteConnection,
    trusted: &IndependentlyAuthenticatedOwnerKey,
    proof: &OfflineOwnerOnlyProof,
    actual_detached_sha256: [u8; 32],
    now_unix_seconds: u64,
) -> Result<VerifiedOwnerOnlyImport, String> {
    if proof.detached_v67_sha256 != actual_detached_sha256
        || proof.original_v29_sha256 != trusted.pinned_original_v29_sha256
        || proof.detached_v67_sha256.iter().all(|b| *b == 0)
        || proof.request_nonce.iter().all(|b| *b == 0)
        || proof.expires_unix_seconds < now_unix_seconds
        || proof.expires_unix_seconds.saturating_sub(now_unix_seconds) > OWNER_PROOF_MAX_AGE_SECONDS
    {
        return Err(BLOCKED.into());
    }
    let (owner_id, mappings, typed_sha256) = inspect_detached_v67_scope_map(conn).await?;
    if trusted.owner_id != owner_id || proof.typed_scope_sha256 != typed_sha256 {
        return Err(BLOCKED.into());
    }
    let message = owner_only_message(&owner_id, proof)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, trusted.key)
        .verify(&message, &proof.signature).map_err(|_| BLOCKED.to_string())?;
    let mut digest = Sha256::new();
    hash_component(&mut digest, &message)?;
    hash_component(&mut digest, &proof.signature)?;
    hash_component(&mut digest, &trusted.key)?;
    Ok(VerifiedOwnerOnlyImport {
        owner_id, mappings, typed_scope_sha256: typed_sha256,
        evidence_sha256: digest.finalize().into(), signed_message: message,
    })
}

// Migration 032 is an already registered, immutable SQLx checksum contract.
// Read the exact public bootstrap hash from that source rather than defining
// another native/test copy of a known credential. An altered/unparseable SQL
// contract must refuse compatibility instead of skipping credential custody.
fn bootstrap_hash_from_registered_032() -> Result<&'static str, String> {
    let sql = include_str!("../migrations/032_remove_public_owner_bootstrap_credential.sql");
    let (_, predicate) = sql
        .split_once("AND password_hash = '")
        .ok_or_else(|| BLOCKED.to_string())?;
    let (hash, tail) = predicate
        .split_once('\'')
        .ok_or_else(|| BLOCKED.to_string())?;
    if hash.len() != 60 || !hash.starts_with("$2b$12$") || tail.trim() != ";" {
        return Err(BLOCKED.into());
    }
    Ok(hash)
}

// The sole clean-install signal is the absence of the database AND of SQLite
// sidecars. A zero-byte preexisting file, symlink, orphaned hot WAL or rollback
// journal is damaged/unfinished custody, NOT consent to overwrite a pharmacy's
// prior installation with a bundled seed. Never touch these inputs here.
fn existing_profile_state(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.len() == 0 {
                return Err(BLOCKED.into());
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            for suffix in ["-wal", "-shm", "-journal"] {
                let mut path_with_suffix = path.as_os_str().to_os_string();
                path_with_suffix.push(suffix);
                let sidecar = PathBuf::from(path_with_suffix);
                match std::fs::symlink_metadata(&sidecar) {
                    Ok(_) => return Err(BLOCKED.into()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(BLOCKED.into()),
                }
            }
            Ok(false)
        }
        Err(_) => Err(BLOCKED.into()),
    }
}

async fn has_table(conn: &mut SqliteConnection, table: &str) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
    )
    .bind(table)
    .fetch_one(&mut *conn)
    .await
    .map_err(|_| BLOCKED.to_string())?;
    Ok(count == 1)
}

async fn has_column(conn: &mut SqliteConnection, table: &str, column: &str) -> Result<bool, String> {
    // Most callers use compile-time constants. Candidate inventory also scans
    // database-defined names, so safely double embedded identifier quotes.
    let escaped = table.replace('"', "\"\"");
    let rows = sqlx::query(&format!("PRAGMA table_info(\"{escaped}\")"))
        .fetch_all(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
    Ok(rows.iter().any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some(column)))
}

/// Aggregate-only preview for an owner considering the single-pharmacy
/// upgrade. In particular, this is NOT an ownership attestation, migration
/// permission, recovery artifact or alternate path through the startup gate.
#[derive(Debug, serde::Serialize)]
pub(crate) struct SinglePharmacyUpgradePreview {
    pub(crate) status: &'static str,
    pub(crate) native_migration_version: i64,
    pub(crate) directly_scoped_rows: i64,
    pub(crate) scopes_needing_reviewed_normalization: i64,
    pub(crate) already_primary_rows: i64,
    pub(crate) unresolved_owner_scope_markers: i64,
    pub(crate) proposed_tenant: &'static str,
    pub(crate) ownership_verified: bool,
    pub(crate) upgrade_authorized: bool,
}

/// Observe *every* directly scoped physical table in an existing, strictly
/// read-only SQLite connection, including inactive staff and old receipts.
/// A foreign nonempty tenant or malformed storage fails closed, regardless of
/// whether a single active owner is visible. No user/financial cells leave the
/// native process. Unknown v1–28 and future ledgers require manual review.
pub(crate) async fn assess_single_pharmacy_candidate(
    conn: &mut SqliteConnection,
) -> Result<SinglePharmacyUpgradePreview, String> {
    if !has_table(conn, "users").await?
        || !has_column(conn, "users", "pharmacy_id").await?
        || !has_column(conn, "users", "role").await?
        || !has_column(conn, "users", "is_active").await?
        || !has_table(conn, "_sqlx_migrations").await?
    {
        return Err(BLOCKED.into());
    }
    let (total, success, unique, first, last, integer_versions): (i64, i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT COUNT(*),\
             COALESCE(SUM(CASE WHEN typeof(success)='integer' AND success=1 THEN 1 ELSE 0 END),0),\
             COUNT(DISTINCT version),COALESCE(MIN(version),0),COALESCE(MAX(version),0),\
             COALESCE(SUM(CASE WHEN typeof(version)='integer' THEN 1 ELSE 0 END),0)\
             FROM _sqlx_migrations",
        )
        .fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if !(29..=69).contains(&total) || success != total || unique != total
        || integer_versions != total || first != 1 || last != total
    {
        return Err(BLOCKED.into());
    }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if integrity != "ok" || sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut *conn).await.map_err(|_| BLOCKED.to_string())?.is_some()
    {
        return Err(BLOCKED.into());
    }
    let disputed: i64 = if has_table(conn, "native_owner_scope_review").await? {
        sqlx::query_scalar("SELECT COUNT(*) FROM native_owner_scope_review")
            .fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?
    } else { 0 };
    let owners: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE LOWER(TRIM(COALESCE(role,'')))='owner'\
         AND COALESCE(is_active,1)=1",
    ).fetch_one(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if owners != 1 { return Err(BLOCKED.into()); }
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).fetch_all(&mut *conn).await.map_err(|_| BLOCKED.to_string())?;
    if names.len() > 512 || names.is_empty() { return Err(BLOCKED.into()); }
    let mut scanned = 0_i64;
    let mut normalized = 0_i64;
    let mut explicit = 0_i64;
    let mut saw_scope = false;
    for name in names {
        if !has_column(conn, &name, "pharmacy_id").await? { continue; }
        saw_scope = true;
        // SQLite table names are DB input, never a trusted identifier. Double
        // every quote; values and table lists are otherwise not interpolated.
        let escaped = name.replace('"', "\"\"");
        let sql = format!(
            "SELECT COUNT(*),\
             COALESCE(SUM(CASE WHEN pharmacy_id IS NULL OR\
                  (typeof(pharmacy_id)='text' AND TRIM(pharmacy_id)='') OR\
                  (typeof(pharmacy_id)='text' AND pharmacy_id='local_default')\
                  THEN 1 ELSE 0 END),0),\
             COALESCE(SUM(CASE WHEN typeof(pharmacy_id)='text'\
                  AND pharmacy_id='primary_pharmacy' THEN 1 ELSE 0 END),0)\
             FROM \"{escaped}\""
        );
        let (rows, placeholders, primary): (i64, i64, i64) =
            sqlx::query_as(&sql).fetch_one(&mut *conn).await
                .map_err(|_| BLOCKED.to_string())?;
        if rows < 0 || placeholders < 0 || primary < 0
            || placeholders.checked_add(primary) != Some(rows)
        {
            return Err(BLOCKED.into());
        }
        scanned = scanned.checked_add(rows).ok_or_else(|| BLOCKED.to_string())?;
        normalized = normalized.checked_add(placeholders).ok_or_else(|| BLOCKED.to_string())?;
        explicit = explicit.checked_add(primary).ok_or_else(|| BLOCKED.to_string())?;
        if scanned > 3_000_000 { return Err(BLOCKED.into()); }
    }
    if !saw_scope || scanned == 0 { return Err(BLOCKED.into()); }
    Ok(SinglePharmacyUpgradePreview {
        status: "SINGLE_PHARMACY_CANDIDATE_ONLY",
        native_migration_version: last,
        directly_scoped_rows: scanned,
        scopes_needing_reviewed_normalization: normalized,
        already_primary_rows: explicit,
        unresolved_owner_scope_markers: disputed,
        proposed_tenant: PRIMARY_PHARMACY_TENANT,
        ownership_verified: false,
        upgrade_authorized: false,
    })
}

pub(crate) async fn inspect_single_pharmacy_candidate(
    path: &Path,
) -> Result<SinglePharmacyUpgradePreview, String> {
    if !existing_profile_state(path)? { return Err(BLOCKED.into()); }
    let path = path.to_path_buf();
    let options = SqliteConnectOptions::new().filename(path)
        .read_only(true).create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options).await
        .map_err(|_| BLOCKED.to_string())?;
    sqlx::query("PRAGMA query_only=ON").execute(&mut db).await
        .map_err(|_| BLOCKED.to_string())?;
    let result = assess_single_pharmacy_candidate(&mut db).await;
    db.close().await.map_err(|_| BLOCKED.to_string())?;
    result
}

/// Guard a *pre-existing* customer profile. Success does not certify legacy
/// ownership or authorize copying: it only allows the normal native migration
/// path for a profile with an already explicit active pharmacy owner and no
/// outstanding immutable owner-scope review.
pub(crate) async fn assess_existing_connection(conn: &mut SqliteConnection) -> Result<(), String> {
    if !has_table(conn, "users").await?
        || !has_column(conn, "users", "pharmacy_id").await?
        || !has_column(conn, "users", "role").await?
    {
        return Err(BLOCKED.into());
    }

    let (active_owners, unscoped_owners, explicitly_owned): (i64, i64, i64) = {
        let row = sqlx::query(
            r#"SELECT
                 SUM(CASE WHEN LOWER(TRIM(COALESCE(role,'')))='owner' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN LOWER(TRIM(COALESCE(role,'')))='owner'
                     AND (typeof(pharmacy_id)!='text'
                       OR NULLIF(TRIM(pharmacy_id),'') IS NULL
                       OR LOWER(TRIM(pharmacy_id))='local_default'
                       OR pharmacy_id!=TRIM(pharmacy_id)) THEN 1 ELSE 0 END),
                 SUM(CASE WHEN LOWER(TRIM(COALESCE(role,'')))='owner'
                     AND typeof(pharmacy_id)='text'
                     AND pharmacy_id=TRIM(pharmacy_id)
                     AND NULLIF(TRIM(pharmacy_id),'') IS NOT NULL
                     AND LOWER(TRIM(pharmacy_id))<>'local_default' THEN 1 ELSE 0 END)
               FROM users WHERE COALESCE(is_active,1)=1"#,
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
        (
            row.try_get::<Option<i64>, _>(0).ok().flatten().unwrap_or(0),
            row.try_get::<Option<i64>, _>(1).ok().flatten().unwrap_or(0),
            row.try_get::<Option<i64>, _>(2).ok().flatten().unwrap_or(0),
        )
    };
    // An empty pre-existing file is not a clean install. The normal startup
    // only creates a seed for a missing/zero-byte file; do not guess here.
    if active_owners != 1 || unscoped_owners != 0 || explicitly_owned != 1 {
        return Err(BLOCKED.into());
    }

    let candidate_owner_scope: String = sqlx::query_scalar(
        "SELECT pharmacy_id FROM users WHERE LOWER(TRIM(COALESCE(role,'')))='owner'
         AND COALESCE(is_active,1)=1 LIMIT 1",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|_| BLOCKED.to_string())?;
    if candidate_owner_scope.is_empty()
        || candidate_owner_scope == "local_default"
        || candidate_owner_scope.trim() != candidate_owner_scope
    {
        return Err(BLOCKED.into());
    }

    if has_table(conn, "native_owner_scope_review").await? {
        let disputed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM native_owner_scope_review")
            .fetch_one(&mut *conn)
            .await
            .map_err(|_| BLOCKED.to_string())?;
        if disputed != 0 {
            return Err(BLOCKED.into());
        }
    }

    // SQLx68 can retain a complete, *unsigned* history-normalization audit.
    // Its exact typed rows and a now-canonical owner scope are not a native
    // owner-authorization grant, let alone legacy financial acceptance.
    // The regular commercial startup has NO verified importer for these audit
    // batches: keep all such staged original-history copies quarantined even
    // if a separately licensed QA process is pointed at one. This condition
    // does not involve, or burden, normal new-pharmacy license activation.
    if has_table(conn, "native_primary_scope_audit_batches").await? {
        let awaiting_verified_import: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_primary_scope_audit_batches",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
        if awaiting_verified_import != 0 {
            return Err(BLOCKED.into());
        }
    }

    // Before the receipts/source-era migration chain existed, legacy NULL,
    // blank, and literal local_default are distinct, unauthenticated original
    // facts. Do not allow the compatibility upgrader to reinterpret them.
    let migration_version: i64 = if has_table(conn, "_sqlx_migrations").await? {
        let row = sqlx::query(
            "SELECT COUNT(*),COUNT(DISTINCT version),COALESCE(MIN(version),0),\
                    COALESCE(MAX(version),0),\
                    COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0),\
                    COALESCE(SUM(CASE WHEN typeof(version)='integer' THEN 1 ELSE 0 END),0)\
             FROM _sqlx_migrations",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
        let count: i64 = row.try_get(0).map_err(|_| BLOCKED.to_string())?;
        let unique: i64 = row.try_get(1).map_err(|_| BLOCKED.to_string())?;
        let min: i64 = row.try_get(2).map_err(|_| BLOCKED.to_string())?;
        let max: i64 = row.try_get(3).map_err(|_| BLOCKED.to_string())?;
        let success: i64 = row.try_get(4).map_err(|_| BLOCKED.to_string())?;
        let integral: i64 = row.try_get(5).map_err(|_| BLOCKED.to_string())?;
        if count != unique || count != success || count != integral
            || (count > 0 && (min != 1 || max != count))
        {
            return Err(BLOCKED.into());
        }
        max
    } else {
        0
    };
    if (1..64).contains(&migration_version) {
        // Native compatibility preparation can silently populate missing staff
        // scopes even when one explicit owner exists. A single visible tenant
        // is not independent authority to change any original staff identity.
        let unresolved_staff: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users WHERE LOWER(TRIM(COALESCE(role,'')))!='owner' \
             AND (typeof(pharmacy_id)!='text' OR NULLIF(TRIM(pharmacy_id),'') IS NULL \
                  OR LOWER(TRIM(pharmacy_id))='local_default' \
                  OR pharmacy_id!=TRIM(pharmacy_id))",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
        if unresolved_staff != 0 {
            return Err(BLOCKED.into());
        }
    }
    if (1..32).contains(&migration_version) {
        // Immutable registered migration 032 would NULL the PUBLIC bootstrap
        // credential on these older profiles. Never allow an apparently
        // explicit owner scope to conceal that original-field mutation; keep
        // both credential neutralization and historical custody fail-closed.
        if !has_column(conn, "users", "password_hash").await? {
            return Err(BLOCKED.into());
        }
        let public_owner_credential: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users WHERE CAST(id AS TEXT)='admin' \
             AND role='owner' AND COALESCE(is_active,1)=1 \
             AND password_hash=?",
        )
        .bind(bootstrap_hash_from_registered_032()?)
        .fetch_one(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
        if public_owner_credential != 0 {
            return Err(BLOCKED.into());
        }
    }
    // Neither old pre064 registrations nor newer migrations independently
    // prove that *all* directly-scoped source facts were reconciled: 052 may
    // have changed the admin's scope while invoices/staff retained their old
    // literal storage. A whitelist (even an old migration's full table list)
    // misses future or historical extension tables and foreign scopes.
    // Enumerate every directly scoped physical table rather than a whitelist.
    // A completely current/healthy installation has one explicit tenant and
    // no leftover or competing original storage class in any scoped table.
    // Otherwise never permit the normal startup's in-place compatibility or
    // forward-migration writers to guess owner or relation identities.
    {
        let table_names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type='table'
             AND substr(name,1,7) COLLATE BINARY != 'sqlite_' ORDER BY name",
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(|_| BLOCKED.to_string())?;
        for table in table_names {
            let quoted = format!("\"{}\"", table.replace('"', "\"\""));
            let columns = sqlx::query(&format!("PRAGMA table_xinfo({quoted})"))
                .fetch_all(&mut *conn)
                .await
                .map_err(|_| BLOCKED.to_string())?;
            if columns.is_empty() {
                return Err(BLOCKED.into());
            }
            let mut scoped = false;
            for column in &columns {
                let name: String = column.try_get("name").map_err(|_| BLOCKED.to_string())?;
                if !name.eq_ignore_ascii_case("pharmacy_id") {
                    continue;
                }
                let hidden: i64 = column.try_get("hidden").map_err(|_| BLOCKED.to_string())?;
                if name != "pharmacy_id" || hidden != 0 || scoped {
                    // SQLite column identifiers are case-insensitive, and
                    // generated/hidden expressions are not original physical
                    // tenant identity evidence. Never ignore or trust them.
                    return Err(BLOCKED.into());
                }
                scoped = true;
            }
            if !scoped {
                continue;
            }
            let inconsistent: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM {quoted}
                 WHERE typeof(pharmacy_id)!='text'
                    OR pharmacy_id COLLATE BINARY <> ?
                    OR pharmacy_id COLLATE BINARY <> TRIM(pharmacy_id)"
            ))
            .bind(&candidate_owner_scope)
            .fetch_one(&mut *conn)
            .await
            .map_err(|_| BLOCKED.to_string())?;
            if inconsistent != 0 {
                return Err(BLOCKED.into());
            }
        }
    }
    Ok(())
}

pub(crate) fn inspect_preexisting_profile(path: &Path) -> Result<(), String> {
    if !existing_profile_state(path)? {
        return Ok(());
    }
    let path = path.to_path_buf();
    tauri::async_runtime::block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(std::time::Duration::from_secs(5));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| BLOCKED.to_string())?;
        // Deliberately do not request WAL checkpoints or migration writes.
        sqlx::query("PRAGMA query_only=ON")
            .execute(&mut connection)
            .await
            .map_err(|_| BLOCKED.to_string())?;
        let result = assess_existing_connection(&mut connection).await;
        connection.close().await.map_err(|_| BLOCKED.to_string())?;
        result
    })
}

/// Determine whether startup is about to cross a forward migration boundary.
/// This is evaluated with a read-only WAL-aware connection before either the
/// compatibility layer or SQLx can modify the customer's original DB. A
/// missing migration ledger is an *older* source, never a blank new install.
pub(crate) fn requires_forward_backup(path: &Path, latest: i64) -> Result<bool, String> {
    if !existing_profile_state(path)? {
        return Ok(false);
    }
    let path = path.to_path_buf();
    tauri::async_runtime::block_on(async {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(std::time::Duration::from_secs(5));
        let mut db = SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| BLOCKED.to_string())?;
        sqlx::query("PRAGMA query_only=ON")
            .execute(&mut db)
            .await
            .map_err(|_| BLOCKED.to_string())?;
        let newest = if has_table(&mut db, "_sqlx_migrations").await? {
            sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1",
            )
            .fetch_one(&mut db)
            .await
            .map_err(|_| BLOCKED.to_string())?
        } else {
            0
        };
        db.close().await.map_err(|_| BLOCKED.to_string())?;
        if newest > latest {
            return Err("Installed pharmacy database is newer than this executable; no downgrade permitted".into());
        }
        Ok(newest < latest)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn real_original_history_sqlx69_is_not_implicitly_authorized_by_offline_license() {
        // Optional real-source QA: if the independently created, SHA-pinned
        // disposable Windows stage exists, run the ACTUAL native startup
        // guard against it read-only. This never reads the installed database,
        // enrolls an owner, or opens a business/financial writer.
        let Some(local) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let root = PathBuf::from(local).join("pharma-disposable-data-copies");
        let file = root
            .join("pharma-v02110-native-sqlx69-primary-scope-43d756ccfe4d43a0a6b0c07ee742b53a")
            .join("NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3");
        if !file.exists() {
            return;
        }
        for part in [&root, file.parent().unwrap(), file.as_path()] {
            let metadata = std::fs::symlink_metadata(part).unwrap();
            assert!(!metadata.file_type().is_symlink(), "QA alias refused");
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                assert_eq!(metadata.file_attributes() & 0x0400, 0, "QA reparse point refused");
            }
        }
        for ext in ["-wal", "-shm", "-journal"] {
            let mut sidecar = file.as_os_str().to_os_string();
            sidecar.push(ext);
            assert!(!PathBuf::from(sidecar).exists(), "QA sidecar refused");
        }
        let sha_hex = |raw: &[u8]| -> String {
            Sha256::digest(raw).iter().map(|b| format!("{b:02x}")).collect()
        };
        let source_bytes = std::fs::read(&file).unwrap();
        assert_eq!(source_bytes.len(), 62_697_472, "Unexpected QA source length");
        assert_eq!(sha_hex(&source_bytes),
            "bf0a85e37bce355a75cd741186f206887e4e9912df0d7a511ee299a0fde15e08",
            "Real SQLx69 candidate changed");
        let mut db = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&file)
                .read_only(true)
                .immutable(true)
                .create_if_missing(false),
        ).await.unwrap();
        sqlx::query("PRAGMA query_only=ON").execute(&mut db).await.unwrap();
        let audits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_primary_scope_audit_batches",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(audits, 1, "Historical scope audit cannot disappear");
        let historic_sales: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sales_invoices",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(historic_sales, 1_529);
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "Signed offline commercial licensing is never an original-history import grant");
        db.close().await.unwrap();
        assert_eq!(sha_hex(&std::fs::read(&file).unwrap()),
            "bf0a85e37bce355a75cd741186f206887e4e9912df0d7a511ee299a0fde15e08",
            "Native history guard must not change detached QA DB");
    }

    #[tokio::test]
    async fn v52_primary_candidate_preview_is_read_only_and_requires_owner_approval() {
        let mut db = synthetic_detached_v67_scope_fixture().await;
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version>52")
            .execute(&mut db).await.unwrap();
        let before_owner: Option<String> = sqlx::query_scalar(
            "SELECT pharmacy_id FROM users WHERE id='historic-owner'"
        ).fetch_one(&mut db).await.unwrap();
        let preview = assess_single_pharmacy_candidate(&mut db).await.unwrap();
        assert_eq!(preview.native_migration_version, 52);
        assert_eq!(preview.directly_scoped_rows, 4);
        assert_eq!(preview.scopes_needing_reviewed_normalization, 4);
        assert_eq!(preview.already_primary_rows, 0);
        assert!(!preview.ownership_verified && !preview.upgrade_authorized);
        assert_eq!(sqlx::query_scalar::<_, Option<String>>(
            "SELECT pharmacy_id FROM users WHERE id='historic-owner'"
        ).fetch_one(&mut db).await.unwrap(), before_owner);
    }

    #[tokio::test]
    async fn primary_candidate_rejects_foreign_inactive_staff_and_broken_migrations() {
        let mut db = synthetic_detached_v67_scope_fixture().await;
        sqlx::query("UPDATE users SET pharmacy_id='other_pharmacy' WHERE id='historic-staff'")
            .execute(&mut db).await.unwrap();
        assert!(assess_single_pharmacy_candidate(&mut db).await.is_err());
        sqlx::query("UPDATE users SET pharmacy_id='local_default' WHERE id='historic-staff'")
            .execute(&mut db).await.unwrap();
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version=40")
            .execute(&mut db).await.unwrap();
        assert!(assess_single_pharmacy_candidate(&mut db).await.is_err());
    }

    #[test]
    fn native_owner_only_pins_must_precede_proof_and_never_be_supplied_by_payload() {
        assert!(native_owner_key_from_compile_pins(None, None, None).is_err());
        assert!(native_owner_key_from_compile_pins(
            Some("historic-owner"), Some(&"01".repeat(32)), None
        ).is_err());
        assert!(native_owner_key_from_compile_pins(
            Some("historic-owner"), None, Some(&"ab".repeat(32))
        ).is_err());
        for invalid_key in ["", "aa", &"0".repeat(64), &"AA".repeat(32), &"xy".repeat(32)] {
            assert!(native_owner_key_from_compile_pins(
                Some("historic-owner"), Some(invalid_key), Some(&"ab".repeat(32))
            ).is_err(), "No absent, all-zero or noncanonical native key");
        }
        for invalid_archive in ["", "ab", &"AB".repeat(32), &"00".repeat(32)] {
            assert!(native_owner_key_from_compile_pins(
                Some("historic-owner"), Some(&"01".repeat(32)), Some(invalid_archive)
            ).is_err(), "Cannot silently use unknown original source custody");
        }
        let json = serde_json::json!({
            "original_v29_sha256":"11".repeat(32),
            "detached_v67_sha256":"22".repeat(32),
            "typed_scope_sha256":"33".repeat(32),
            "request_nonce":"44".repeat(32),
            "expires_unix_seconds":1234,
            "ed25519_signature":"55".repeat(64),
        });
        let bytes = serde_json::to_vec(&json).unwrap();
        let parsed = parse_detached_owner_only_proof_json(&bytes).unwrap();
        assert_eq!(parsed.original_v29_sha256, [0x11; 32]);
        assert_eq!(parsed.signature, [0x55; 64]);
        for injected_key in ["public_key", "verified_owner_id", "pharmacy_id",
            "owner_key_from_json", "authorized"] {
            let mut forged = json.clone();
            forged.as_object_mut().unwrap()
                .insert(injected_key.to_owned(), serde_json::json!("self-asserted"));
            assert!(parse_detached_owner_only_proof_json(
                &serde_json::to_vec(&forged).unwrap()
            ).is_err(), "Proof must not enroll its own owner, key or tenant");
        }
        let mut altered = json.clone();
        altered["ed25519_signature"] = serde_json::json!("55");
        assert!(parse_detached_owner_only_proof_json(&serde_json::to_vec(&altered).unwrap()).is_err());
        altered["ed25519_signature"] = serde_json::json!("FF".repeat(64));
        assert!(parse_detached_owner_only_proof_json(&serde_json::to_vec(&altered).unwrap()).is_err());
    }

    async fn synthetic_detached_v67_scope_fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER);\
             WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<67)\
             INSERT INTO _sqlx_migrations SELECT v,1 FROM n;\
             CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER,password_hash TEXT);\
             INSERT INTO users VALUES('historic-owner','owner',NULL,1,NULL);\
             INSERT INTO users VALUES('historic-staff','cashier','local_default',1,'synthetic-audit-only');\
             CREATE TABLE inventory(id TEXT,pharmacy_id TEXT);\
             INSERT INTO inventory VALUES('historic-stock','local_default');\
             CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT);\
             INSERT INTO sales_invoices VALUES('historic-sale',NULL);\
             CREATE TABLE purchase_invoices(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE returns(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE activity_log(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE shortages(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE purchase_orders(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE cash_movements(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE daily_journals(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE expenses(id TEXT,pharmacy_id TEXT);\
             CREATE TABLE financial_notices(id TEXT,pharmacy_id TEXT);"
        ).execute(&mut db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn offline_owner_only_witness_never_removes_v53_quarantine_or_accepts_other_owner() {
        let mut db = synthetic_detached_v67_scope_fixture().await;
        sqlx::raw_sql(
            "CREATE TABLE native_owner_scope_review(owner_id TEXT PRIMARY KEY,reason TEXT);\
             INSERT INTO native_owner_scope_review VALUES('historic-owner','052 inferred source scope');"
        ).execute(&mut db).await.unwrap();
        assert!(inspect_detached_v67_scope_map(&mut db).await.is_ok(),
            "The immutable owner quarantine is evidence, not a second-reviewer mandate for offline signing");
        let preserved: String = sqlx::query_scalar(
            "SELECT reason FROM native_owner_scope_review WHERE owner_id='historic-owner'"
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(preserved, "052 inferred source scope");
        sqlx::query("INSERT INTO native_owner_scope_review VALUES('other-owner','Unresolved')")
            .execute(&mut db).await.unwrap();
        assert!(inspect_detached_v67_scope_map(&mut db).await.is_err(),
            "Another disputed owner cannot be silently authorized by one signed source");
        let remains: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM native_owner_scope_review")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(remains, 2, "Verifier may not clear historical review custody markers");
    }

    #[tokio::test]
    async fn synthetic_owner_only_signature_accepts_exact_pinned_v67_typed_history() {
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let mut db = synthetic_detached_v67_scope_fixture().await;
        let (owner_id, expected_mappings, typed_sha256) =
            inspect_detached_v67_scope_map(&mut db).await.unwrap();
        assert_eq!(owner_id, "historic-owner");
        assert_eq!(expected_mappings.len(), 4);
        assert!(expected_mappings.iter().any(|row|
            row.table == "sales_invoices" && row.original_scope_class == "null"));
        assert!(expected_mappings.iter().any(|row|
            row.table == "inventory" && row.original_scope_literal.as_deref() == Some("local_default")));
        // Ephemeral test signer. No production trust anchor, password, or
        // owner grant is created by this synthetic test.
        let key_document = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let signer = Ed25519KeyPair::from_pkcs8(key_document.as_ref()).unwrap();
        let public_key: [u8; 32] = signer.public_key().as_ref().try_into().unwrap();
        let trusted = IndependentlyAuthenticatedOwnerKey::from_trusted_native_custody(
            &owner_id, public_key, [29; 32]
        ).unwrap();
        let mut proof = OfflineOwnerOnlyProof {
            original_v29_sha256: [29; 32],
            detached_v67_sha256: [67; 32],
            typed_scope_sha256: typed_sha256,
            request_nonce: [7; 32],
            expires_unix_seconds: 500_000,
            signature: [0; 64],
        };
        let signed_message = owner_only_message(&owner_id, &proof).unwrap();
        proof.signature.copy_from_slice(signer.sign(&signed_message).as_ref());
        let accepted = verify_detached_primary_pharmacy_owner_only(
            &mut db, &trusted, &proof, [67; 32], 400_000
        ).await.unwrap();
        assert_eq!(accepted.owner_id, owner_id);
        assert_eq!(accepted.mappings, expected_mappings);
        assert_eq!(accepted.typed_scope_sha256, typed_sha256);
        assert_ne!(accepted.evidence_sha256, [0; 32]);
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM users WHERE pharmacy_id='primary_pharmacy'"
        ).fetch_one(&mut db).await.unwrap(), 0, "Proof verification cannot rewrite historical rows");
    }

    #[tokio::test]
    async fn synthetic_owner_only_signature_rejects_tampering_and_wrong_identity() {
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let mut db = synthetic_detached_v67_scope_fixture().await;
        let (owner_id, _, digest) = inspect_detached_v67_scope_map(&mut db).await.unwrap();
        let key_document = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let signer = Ed25519KeyPair::from_pkcs8(key_document.as_ref()).unwrap();
        let key: [u8; 32] = signer.public_key().as_ref().try_into().unwrap();
        let trusted = IndependentlyAuthenticatedOwnerKey::from_trusted_native_custody(
            &owner_id, key, [29; 32]
        ).unwrap();
        let mut proof = OfflineOwnerOnlyProof {
            original_v29_sha256: [29; 32], detached_v67_sha256: [67; 32],
            typed_scope_sha256: digest, request_nonce: [1; 32],
            expires_unix_seconds: 500_000, signature: [0; 64],
        };
        let signed_message = owner_only_message(&owner_id, &proof).unwrap();
        proof.signature.copy_from_slice(signer.sign(&signed_message).as_ref());
        assert!(verify_detached_primary_pharmacy_owner_only(
            &mut db, &trusted, &proof, [68; 32], 400_000
        ).await.is_err(), "Another detached database cannot reuse this proof");
        assert!(verify_detached_primary_pharmacy_owner_only(
            &mut db, &trusted, &proof, [67; 32], 500_001
        ).await.is_err(), "Expired proof must fail");
        let wrong_identity = IndependentlyAuthenticatedOwnerKey::from_trusted_native_custody(
            "not-the-historical-owner", key, [29; 32]
        ).unwrap();
        let wrong_source = IndependentlyAuthenticatedOwnerKey::from_trusted_native_custody(
            &owner_id, key, [30; 32]
        ).unwrap();
        assert!(verify_detached_primary_pharmacy_owner_only(
            &mut db, &wrong_source, &proof, [67; 32], 400_000
        ).await.is_err(), "Signing a claim does not override independently pinned original custody");
        assert!(verify_detached_primary_pharmacy_owner_only(
            &mut db, &wrong_identity, &proof, [67; 32], 400_000
        ).await.is_err(), "Same signing key cannot substitute another historical owner");
        for tamper in 0..4 {
            let mut changed = proof.clone();
            match tamper {
                0 => changed.original_v29_sha256 = [30; 32],
                1 => changed.typed_scope_sha256 = [99; 32],
                2 => changed.request_nonce = [2; 32],
                _ => changed.signature[0] ^= 1,
            };
            assert!(verify_detached_primary_pharmacy_owner_only(
                &mut db, &trusted, &changed, [67; 32], 400_000
            ).await.is_err(), "Signature, source archive, typed rows, and nonce must all be bound");
        }
        sqlx::query("UPDATE inventory SET pharmacy_id='primary_pharmacy'")
            .execute(&mut db).await.unwrap();
        assert!(verify_detached_primary_pharmacy_owner_only(
            &mut db, &trusted, &proof, [67; 32], 400_000
        ).await.is_err(), "New source scope invalidates the typed-row digest");
    }

    #[tokio::test]
    async fn synthetic_owner_only_v67_mapping_rejects_public_bootstrap_and_foreign_tenant() {
        let mut db = synthetic_detached_v67_scope_fixture().await;
        sqlx::query("UPDATE users SET password_hash=? WHERE id='historic-owner'")
            .bind(bootstrap_hash_from_registered_032().unwrap())
            .execute(&mut db).await.unwrap();
        assert!(inspect_detached_v67_scope_map(&mut db).await.is_err(),
            "The publicly seeded historical hash cannot authenticate an owner");
        sqlx::query("UPDATE users SET password_hash=NULL WHERE id='historic-owner'")
            .execute(&mut db).await.unwrap();
        sqlx::query("UPDATE inventory SET pharmacy_id='another_pharmacy'")
            .execute(&mut db).await.unwrap();
        assert!(inspect_detached_v67_scope_map(&mut db).await.is_err(),
            "A foreign explicit scope cannot be silently mapped to primary_pharmacy");
    }

    #[test]
    fn reviewed_single_pharmacy_destination_never_falls_back_to_local_default() {
        assert_eq!(validate_primary_pharmacy_destination(PRIMARY_PHARMACY_TENANT),
            Ok(PRIMARY_PHARMACY_TENANT));
        for unapproved_destination in ["", " ", "local_default", "LOCAL_DEFAULT",
            " primary_pharmacy", "primary_pharmacy ", "PRIMARY_PHARMACY",
            "other_pharmacy", "pharmacy_primary"] {
            assert!(validate_primary_pharmacy_destination(unapproved_destination).is_err(),
                "An unspecified, provisional, or competing tenant cannot substitute for the chosen destination");
        }
    }

    async fn fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER);\
             CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER);\
             WITH RECURSIVE versions(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM versions WHERE n<64)\
             INSERT INTO _sqlx_migrations(version,success) SELECT n,1 FROM versions;\
             CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT);",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db
    }

    #[tokio::test]
    async fn tenantless_original_owner_blocks_without_repair_or_attribution() {
        let mut db = fixture().await;
        sqlx::raw_sql("INSERT INTO users VALUES('admin','owner',NULL,1); INSERT INTO sales_invoices VALUES('historic',NULL)")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err());
        let original: Option<String> = sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices WHERE id='historic'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(original, None);
    }

    #[tokio::test]
    async fn version_29_tenantless_owner_cannot_reach_legacy_052_scope_assignment() {
        // Real preserved one-pharmacy archive originates at version 29. A
        // SQL-only bypass of startup changes one original user pharmacy_id
        // in migration 052. Guard BEFORE migrations, with no ownership guess.
        let mut db = fixture().await;
        sqlx::raw_sql(
            "DELETE FROM _sqlx_migrations WHERE version>29;\
             INSERT INTO users VALUES('admin','owner',NULL,1);\
             INSERT INTO sales_invoices VALUES('old-receipt','local_default');",
        ).execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "Unverified version-29 owner must be denied before 032/052 SQL");
        let original_user: Option<String> = sqlx::query_scalar(
            "SELECT pharmacy_id FROM users WHERE id='admin'",
        ).fetch_one(&mut db).await.unwrap();
        let original_sale: String = sqlx::query_scalar(
            "SELECT pharmacy_id FROM sales_invoices WHERE id='old-receipt'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(original_user, None, "Do not assign owner a guessed tenant");
        assert_eq!(original_sale, "local_default", "Keep historical scope literal");
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT MAX(version) FROM _sqlx_migrations",
        ).fetch_one(&mut db).await.unwrap(), 29);
    }

    #[tokio::test]
    async fn v29_primary_pharmacy_claim_cannot_replace_authenticated_source_owner_proof() {
        // Every input is synthetic. In the actual installed v29 source the
        // original password hash must stay an audit fact, never a native
        // enrollment secret or evidence that NULL/placeholder rows belong to
        // the selected permanent tenant. A local-looking approval table is
        // also untrusted when it has no independent cryptographic binding.
        for original_owner_scope in [None, Some("local_default"), Some(PRIMARY_PHARMACY_TENANT)] {
            let mut db = fixture().await;
            sqlx::raw_sql(
                "ALTER TABLE users ADD COLUMN password_hash TEXT; \
                 DELETE FROM _sqlx_migrations WHERE version>29; \
                 CREATE TABLE unsigned_upgrade_claim(owner_id TEXT, target_tenant TEXT);",
            ).execute(&mut db).await.unwrap();
            let audit_hash = bcrypt::hash("SyntheticAuditOnly!Owner2026", 4).unwrap();
            sqlx::query(
                "INSERT INTO users(id,role,pharmacy_id,is_active,password_hash) \
                 VALUES('admin','owner',?,1,?)",
            ).bind(original_owner_scope).bind(&audit_hash)
                .execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO users(id,role,pharmacy_id,is_active) VALUES('staff','cashier',NULL,1)")
                .execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO sales_invoices(id,pharmacy_id) VALUES('old-receipt','local_default')")
                .execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO unsigned_upgrade_claim VALUES('admin',?)")
                .bind(PRIMARY_PHARMACY_TENANT).execute(&mut db).await.unwrap();

            let before: (Option<String>, String, Option<String>, String) = sqlx::query_as(
                "SELECT u.pharmacy_id,u.password_hash,s.pharmacy_id,i.pharmacy_id \
                 FROM users u JOIN users s ON s.id='staff' \
                 JOIN sales_invoices i ON i.id='old-receipt' WHERE u.id='admin'",
            ).fetch_one(&mut db).await.unwrap();
            assert!(assess_existing_connection(&mut db).await.is_err(),
                "A selected tenant and unsigned local claim must not authorize legacy scope changes");
            let after: (Option<String>, String, Option<String>, String) = sqlx::query_as(
                "SELECT u.pharmacy_id,u.password_hash,s.pharmacy_id,i.pharmacy_id \
                 FROM users u JOIN users s ON s.id='staff' \
                 JOIN sales_invoices i ON i.id='old-receipt' WHERE u.id='admin'",
            ).fetch_one(&mut db).await.unwrap();
            assert_eq!(after, before, "Preflight may not change original owner, staff, receipts or password audit hash");
            assert_eq!(after.1, audit_hash);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM _sqlx_migrations")
                .fetch_one(&mut db).await.unwrap(), 29);
        }
    }

    #[tokio::test]
    async fn explicit_legacy_owner_with_public_bootstrap_hash_cannot_silently_cross_032() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            "ALTER TABLE users ADD COLUMN password_hash TEXT; \
             DELETE FROM _sqlx_migrations WHERE version>29; \
             INSERT INTO users(id,role,pharmacy_id,is_active,password_hash) \
             VALUES('admin','owner','qa-explicit-tenant',1,'independent-private-hash');",
        ).execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_ok(),
            "An explicit owner with no unscoped history/public password should pass the structural gate");
        let public_hash = bootstrap_hash_from_registered_032().unwrap();
        sqlx::query("UPDATE users SET password_hash=? WHERE id='admin'")
            .bind(public_hash).execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "Migration 032 must not silently change a publicly seeded historical credential");
        let unchanged: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(unchanged, public_hash, "Preflight never overwrites historical credentials");
    }

    #[tokio::test]
    async fn pre64_explicit_owner_cannot_silently_scope_unresolved_staff() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            "ALTER TABLE users ADD COLUMN password_hash TEXT; \
             DELETE FROM _sqlx_migrations WHERE version>29; \
             INSERT INTO users(id,role,pharmacy_id,is_active) VALUES('owner','owner','qa-tenant',1); \
             INSERT INTO users(id,role,pharmacy_id,is_active) VALUES('staff','cashier',NULL,1);",
        ).execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "Single scoped owner is no authority to overwrite missing staff source scope");
        let unscoped: Option<String> = sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='staff'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(unscoped, None);
        sqlx::query("UPDATE users SET pharmacy_id='qa-tenant' WHERE id='staff'")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_ok(),
            "Already explicit and consistent original actors may pass this structural gate");
        sqlx::query("UPDATE users SET pharmacy_id='local_default' WHERE id='staff'")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "Provisional staff scope cannot be adopted without separate review");
    }

    #[tokio::test]
    async fn registered_pre29_history_requires_same_credential_review() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            "ALTER TABLE users ADD COLUMN password_hash TEXT; \
             DELETE FROM _sqlx_migrations WHERE version>12; \
             INSERT INTO users(id,role,pharmacy_id,is_active,password_hash) \
             VALUES('admin','owner','qa-explicit-tenant',1,'independent-private-hash');",
        ).execute(&mut db).await.unwrap();
        sqlx::query("UPDATE users SET password_hash=? WHERE id='admin'")
            .bind(bootstrap_hash_from_registered_032().unwrap())
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "Older registered source must not evade public-credential preservation");
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&mut db).await.unwrap(), 12);
    }

    #[tokio::test]
    async fn explicit_current_owner_does_not_adopt_unowned_archived_history() {
        let mut db = fixture().await;
        sqlx::raw_sql("INSERT INTO users VALUES('qa','owner','verified-tenant',1); INSERT INTO users VALUES('old','cashier','local_default',1); INSERT INTO sales_invoices VALUES('historic','local_default')")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "v64+ must refuse compatibility migrations while historical local_default business rows remain");
        let original: String = sqlx::query_scalar("SELECT pharmacy_id FROM sales_invoices WHERE id='historic'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(original, "local_default");
    }

    #[tokio::test]
    async fn current_schema_startup_refuses_multiple_owners_and_any_unreconciled_scope_cells() {
        let mut db = fixture().await;
        sqlx::raw_sql("INSERT INTO users VALUES('owner','owner','primary_pharmacy',1);
                       INSERT INTO users VALUES('cashier','cashier','primary_pharmacy',1);
                       INSERT INTO sales_invoices VALUES('current-sale','primary_pharmacy');")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_ok());
        // A second explicit owner is not independent confirmation of shared
        // original historical custody. Preserve both and refuse startup.
        sqlx::query("INSERT INTO users VALUES('second-owner','owner','primary_pharmacy',1)")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err());
        sqlx::query("DELETE FROM users WHERE id='second-owner'")
            .execute(&mut db).await.unwrap();
        for old in [Some("local_default"), None, Some("another_installation"), Some(" ")] {
            sqlx::query("UPDATE sales_invoices SET pharmacy_id=? WHERE id='current-sale'")
                .bind(old).execute(&mut db).await.unwrap();
            assert!(assess_existing_connection(&mut db).await.is_err(),
                "old/foreign scope cannot authorize normal startup repair");
        }
        sqlx::query("UPDATE sales_invoices SET pharmacy_id='primary_pharmacy' WHERE id='current-sale'")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE historical_patient_balance_link(id TEXT,pharmacy_id TEXT,amount REAL)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO historical_patient_balance_link VALUES('patient-finance','local_default',91.25)")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "a new scoped finance domain omitted from prior table lists must be checked");
        let original: (String, f64) = sqlx::query_as(
            "SELECT pharmacy_id,CAST(amount AS REAL) FROM historical_patient_balance_link"
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(original,("local_default".to_string(),91.25));
    }

    #[tokio::test]
    async fn unsigned_canonical_history_audit_cannot_enable_commercial_startup() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            "INSERT INTO users VALUES('admin','owner','primary_pharmacy',1);\
             INSERT INTO sales_invoices VALUES('historic','primary_pharmacy');\
             CREATE TABLE native_primary_scope_audit_batches(audit_sha256 TEXT PRIMARY KEY);",
        )
        .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_ok(),
            "An empty audit schema must not interfere with normal pharmacies");
        sqlx::query("INSERT INTO native_primary_scope_audit_batches VALUES('unsigned-qa')")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err(),
            "A normalized historical audit is not signed financial or owner acceptance");
        let preserved: String = sqlx::query_scalar(
            "SELECT pharmacy_id FROM sales_invoices WHERE id='historic'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(preserved, "primary_pharmacy");
    }

    #[tokio::test]
    async fn every_migration_era_denies_hidden_noncanonical_and_foreign_pharmacy_sources_without_writes() {
        for version in [63_i64, 64, 69] {
            for bad_table in [
                "CREATE TABLE invoice_extension(id TEXT,pharmacy_id TEXT); INSERT INTO invoice_extension VALUES('x',NULL)",
                "CREATE TABLE invoice_extension(id TEXT,pharmacy_id TEXT COLLATE NOCASE); INSERT INTO invoice_extension VALUES('x','PRIMARY_PHARMACY')",
                "CREATE TABLE invoice_extension(id TEXT,Pharmacy_ID TEXT); INSERT INTO invoice_extension VALUES('x',NULL)",
                "CREATE TABLE invoice_extension(id TEXT,pharmacy_id TEXT GENERATED ALWAYS AS ('primary_pharmacy') VIRTUAL); INSERT INTO invoice_extension(id) VALUES('x')",
                "CREATE TABLE sqliteXledger(id TEXT,pharmacy_id TEXT); INSERT INTO sqliteXledger VALUES('x','local_default')",
                "CREATE TABLE invoice_extension(id TEXT,pharmacy_id INTEGER); INSERT INTO invoice_extension VALUES('x',42)",
                "CREATE TABLE invoice_extension(id TEXT,pharmacy_id TEXT); INSERT INTO invoice_extension VALUES('x','foreign_pharmacy')",
            ] {
                let mut db = fixture().await;
                if version < 64 {
                    sqlx::query("DELETE FROM _sqlx_migrations WHERE version>63")
                        .execute(&mut db).await.unwrap();
                } else if version == 69 {
                    sqlx::raw_sql("WITH RECURSIVE versions(n) AS (SELECT 65 UNION ALL SELECT n+1 FROM versions WHERE n<69) INSERT INTO _sqlx_migrations(version,success) SELECT n,1 FROM versions")
                        .execute(&mut db).await.unwrap();
                }
                sqlx::query("INSERT INTO users VALUES('original-owner','owner','primary_pharmacy',1)")
                    .execute(&mut db).await.unwrap();
                sqlx::raw_sql(bad_table).execute(&mut db).await.unwrap();
                let before: i64 = sqlx::query_scalar("SELECT total_changes()")
                    .fetch_one(&mut db).await.unwrap();
                assert!(assess_existing_connection(&mut db).await.is_err(),
                    "migration {version} must refuse an unreconciled physical scope");
                let after: i64 = sqlx::query_scalar("SELECT total_changes()")
                    .fetch_one(&mut db).await.unwrap();
                assert_eq!(before, after, "preflight cannot mutate original records or schema");
                assert_eq!(sqlx::query_scalar::<_,i64>("SELECT MAX(version) FROM _sqlx_migrations")
                    .fetch_one(&mut db).await.unwrap(),version);
            }
        }
    }

    #[tokio::test]
    async fn incomplete_older_finance_schema_denied_before_compatibility_writes() {
        let mut db = fixture().await;
        sqlx::raw_sql("INSERT INTO users VALUES('owner','owner','t-1',1); DELETE FROM _sqlx_migrations WHERE version>51; INSERT INTO sales_invoices VALUES('old',NULL)")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err());
    }

    #[tokio::test]
    async fn older_cash_and_expense_sources_cannot_be_silently_adopted() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            "INSERT INTO users VALUES('owner','owner','verified-tenant',1);\
             DELETE FROM _sqlx_migrations WHERE version>63;\
             CREATE TABLE expenses(id TEXT PRIMARY KEY, pharmacy_id TEXT, amount REAL);\
             INSERT INTO expenses VALUES('original-expense',NULL,17.25);",
        ).execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err());
        let expense: (Option<String>, f64) = sqlx::query_as(
            "SELECT pharmacy_id,amount FROM expenses WHERE id='original-expense'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(expense, (None, 17.25));
    }

    #[tokio::test]
    async fn immutable_quarantine_denies_reuse_of_disputed_owner() {
        let mut db = fixture().await;
        sqlx::raw_sql("INSERT INTO users VALUES('owner','owner','t-1',1); CREATE TABLE native_owner_scope_review(owner_id TEXT,reason TEXT); INSERT INTO native_owner_scope_review VALUES('owner','ambiguous')")
            .execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err());
    }

    #[tokio::test]
    async fn mixed_explicit_and_placeholder_owners_never_inherit_ownership() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            "INSERT INTO users VALUES('verified','owner','pharmacy-a',1);\
             INSERT INTO users VALUES('historic','OWNER','local_default',1);\
             INSERT INTO sales_invoices VALUES('legacy-sale','local_default');",
        ).execute(&mut db).await.unwrap();
        assert!(assess_existing_connection(&mut db).await.is_err());
        let original: String = sqlx::query_scalar(
            "SELECT pharmacy_id FROM sales_invoices WHERE id='legacy-sale'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(original, "local_default");
    }

    #[tokio::test]
    async fn malformed_owner_pharmacy_never_counts_as_independent_tenant() {
        for scope in [" local_default ", "pharmacy-a ", "", "LOCAL_DEFAULT"] {
            let mut db = fixture().await;
            sqlx::query("INSERT INTO users VALUES('legacy','owner',?,1)")
                .bind(scope).execute(&mut db).await.unwrap();
            assert!(assess_existing_connection(&mut db).await.is_err(), "scope class denied");
        }
    }

    #[tokio::test]
    async fn migration_ledger_gap_or_failure_blocks_before_schema_repair() {
        for bad in ["DELETE FROM _sqlx_migrations WHERE version=42",
                    "UPDATE _sqlx_migrations SET success=0 WHERE version=42",
                    "INSERT INTO _sqlx_migrations VALUES(64,1)"] {
            let mut db = fixture().await;
            sqlx::raw_sql("INSERT INTO users VALUES('verified','owner','pharmacy-a',1)")
                .execute(&mut db).await.unwrap();
            sqlx::query(bad).execute(&mut db).await.unwrap();
            assert!(assess_existing_connection(&mut db).await.is_err(), "ledger denied");
        }
    }

    #[test]
    fn version_transition_requires_recovery_snapshot_and_refuses_downgrade() {
        let path = std::env::temp_dir().join(format!(
            "pharma-legacy-preflight-{}.sqlite3",
            uuid::Uuid::new_v4(),
        ));
        tauri::async_runtime::block_on(async {
            let mut db = SqliteConnection::connect_with(
                &SqliteConnectOptions::new().filename(&path).create_if_missing(true),
            )
            .await
            .unwrap();
            sqlx::raw_sql("CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER); INSERT INTO _sqlx_migrations VALUES (64,1)")
                .execute(&mut db).await.unwrap();
            db.close().await.unwrap();
        });
        assert_eq!(requires_forward_backup(&path, 65), Ok(true));
        assert_eq!(requires_forward_backup(&path, 64), Ok(false));
        assert!(requires_forward_backup(&path, 63).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn zero_byte_existing_profile_is_not_a_fresh_seed_or_backup_exemption() {
        let directory = std::env::temp_dir().join(format!(
            "pharma-preserve-empty-profile-{}", uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("pharma_local.db");
        std::fs::write(&file, b"").unwrap();
        assert!(inspect_preexisting_profile(&file).is_err());
        assert!(requires_forward_backup(&file, 66).is_err());
        assert!(file.is_file());
        assert_eq!(std::fs::metadata(&file).unwrap().len(), 0);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_sqlite_file_with_orphaned_hot_wal_or_journal_cannot_install_seed() {
        let directory = std::env::temp_dir().join(format!(
            "pharma-preserve-sidecars-{}", uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("pharma_local.db");
        // Missing main and no historical sidecars is the only fresh install.
        assert!(inspect_preexisting_profile(&file).is_ok());
        assert_eq!(requires_forward_backup(&file, 66), Ok(false));
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = directory.join(format!("pharma_local.db{suffix}"));
            let unchanged_bytes = b"orphaned legacy SQLite recovery payload";
            std::fs::write(&sidecar, unchanged_bytes).unwrap();
            assert!(inspect_preexisting_profile(&file).is_err());
            assert!(requires_forward_backup(&file, 66).is_err());
            assert!(!file.exists(), "no seed may be created on refusal");
            assert_eq!(std::fs::read(&sidecar).unwrap(), unchanged_bytes);
            std::fs::remove_file(sidecar).unwrap();
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn independently_pinned_private_historical_copy_refuses_tenantless_upgrade_without_changes() {
        // Opt-in ONLY. This test must never open or mutate the live pharmacy DB
        // or the independently pinned historical source archive. The operator
        // supplies the separate private `sqlite3.Connection.backup` rehearsal
        // copy previously verified by the Python historical full-row parity.
        let Some(path) = std::env::var_os("PHARMA_QA_LEGACY_PRESERVED_COPY") else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        let local = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default());
        let root = local.join("pharma-disposable-data-copies");
        let folder = path.parent().expect("Private stage directory required");
        let folder_name = folder.file_name().unwrap().to_string_lossy();
        let suffix = folder_name.strip_prefix("pharma-legacy-stage-")
            .expect("Only an explicitly private rehearsal stage is permitted");
        assert_eq!(suffix.len(), 32);
        assert!(suffix.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(path.file_name().unwrap(), "candidate.sqlite3");
        assert_eq!(folder.parent().unwrap(), root);
        assert!(path.is_file());
        assert!(!path.is_symlink());
        assert!(!folder.is_symlink());
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let digest = |path: &std::path::Path| {
            let mut file = std::fs::File::open(path).expect("Private snapshot is required");
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let n = file.read(&mut buffer).unwrap();
                if n == 0 { break; }
                hash.update(&buffer[..n]);
            }
            hash.finalize().to_vec()
        };
        let before = digest(&path);
        let mut db = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(&path).read_only(true).create_if_missing(false),
        ).await.unwrap();
        sqlx::query("PRAGMA query_only=ON").execute(&mut db).await.unwrap();
        let actual_unscoped_owner: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users WHERE lower(trim(role))='owner' "
        ).fetch_one(&mut db).await.unwrap();
        assert!(actual_unscoped_owner > 0, "Pinned legacy archive has no owner source rows");
        assert!(assess_existing_connection(&mut db).await.is_err(),
                "Never auto-migrate a real historic archive without verified owner scope");
        db.close().await.unwrap();
        assert_eq!(digest(&path), before, "Historic rehearsal copy bytes must stay unchanged");
    }
}
