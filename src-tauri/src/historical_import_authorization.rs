//! Native, read-only verification of a historical source import grant.
//!
//! This is a preparation primitive for an independently approved maintenance
//! process, never a commercial startup, installer, license or IPC bypass.
//! In particular an unsigned SQLx68 audit, a previously signed owner-only v67
//! copy ticket, and the old owner bcrypt are NOT historical import permission.
//! Financial cutover and authentic independent original-owner identity review
//! remain prerequisites. A customer need not generate or manage signing keys:
//! both witness keys belong to separately authorized operator custodians.
//! No current build contains those independently approved trust anchors.

use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const DENIED: &str = "Independent source-bound historical import approval required";
const DOMAIN: &[u8] = b"pharma/native/audited-historical-import-consent/v1\0";
const FORMAT: &str = "pharma-native-audited-historical-import-consent-v1";
const PURPOSE: &str = "historical-source-custody-review-only";
const TENANT: &str = "primary_pharmacy";
const MAX_AGE: u64 = 30 * 24 * 60 * 60;
const MAX_BYTES: u64 = 700_000_000;

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && value.trim() == value
        && !value.bytes().any(|b| b.is_ascii_control())
}

fn hex<const N: usize>(value: &str) -> Result<[u8; N], &'static str> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DENIED);
    }
    let mut result = [0_u8; N];
    for (i, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| DENIED)?;
    }
    Ok(result)
}

/// Private operator trust anchors provisioned after genuine historical owner
/// identity authentication. The original owner need not operate an Ed25519 key.
/// The first signer attests the authenticated owner event; the second reviews
/// the historical source independently. A grant never carries public keys.
struct TrustedApprovers {
    owner_id: String,
    identity_witness_id: String,
    identity_witness_key: [u8; 32],
    original_v29_sha256: [u8; 32],
    source_reviewer_id: String,
    source_reviewer_key: [u8; 32],
    expected_nonce: [u8; 32],
}

impl TrustedApprovers {
    fn from_native_custody(
        owner_id: &str,
        identity_witness_id: &str,
        identity_witness_key: [u8; 32],
        original_v29_sha256: [u8; 32],
        source_reviewer_id: &str,
        source_reviewer_key: [u8; 32],
        expected_nonce: [u8; 32],
    ) -> Result<Self, &'static str> {
        if !identifier(owner_id)
            || !identifier(identity_witness_id)
            || !identifier(source_reviewer_id)
            || identity_witness_id == source_reviewer_id
            || identity_witness_key == source_reviewer_key
            || identity_witness_key == [0; 32]
            || source_reviewer_key == [0; 32]
            || original_v29_sha256 == [0; 32]
            || expected_nonce == [0; 32]
        {
            return Err(DENIED);
        }
        Ok(Self {
            owner_id: owner_id.into(),
            identity_witness_id: identity_witness_id.into(),
            identity_witness_key,
            original_v29_sha256,
            source_reviewer_id: source_reviewer_id.into(),
            source_reviewer_key,
            expected_nonce,
        })
    }
}

fn independently_pinned_approvers() -> Result<TrustedApprovers, &'static str> {
    // These pins are separately enrolled by a trusted operator identity and
    // independent historical-source review, never asserted by a customer JSON
    // or by the historical database. A current owner self-statement alone
    // cannot authorize historical source ownership.
    let (
        Some(owner_id),
        Some(identity_id),
        Some(identity_key),
        Some(v29),
        Some(reviewer_id),
        Some(reviewer_key),
        Some(nonce),
    ) = (
        option_env!("PHARMA_NATIVE_HISTORICAL_OWNER_ID"),
        option_env!("PHARMA_NATIVE_HISTORICAL_IDENTITY_WITNESS_ID"),
        option_env!("PHARMA_NATIVE_HISTORICAL_IDENTITY_WITNESS_PUBLIC_HEX"),
        option_env!("PHARMA_NATIVE_HISTORICAL_ORIGINAL_V29_SHA256_HEX"),
        option_env!("PHARMA_NATIVE_HISTORICAL_SOURCE_REVIEWER_ID"),
        option_env!("PHARMA_NATIVE_HISTORICAL_SOURCE_REVIEWER_PUBLIC_HEX"),
        option_env!("PHARMA_NATIVE_HISTORICAL_IMPORT_NONCE_HEX"),
    )
    else {
        return Err(DENIED);
    };
    TrustedApprovers::from_native_custody(
        owner_id,
        identity_id,
        hex(identity_key)?,
        hex(v29)?,
        reviewer_id,
        hex(reviewer_key)?,
        hex(nonce)?,
    )
}

#[derive(Clone)]
struct HistoricalImportGrant {
    owner_id: String,
    identity_witness_id: String,
    source_reviewer_id: String,
    owner_authentication_record_sha256: [u8; 32],
    original_v29_sha256: [u8; 32],
    original_v67_sha256: [u8; 32],
    detached_sqlx69_sha256: [u8; 32],
    audit_sha256: [u8; 32],
    audit_evidence_sha256: [u8; 32],
    request_nonce: [u8; 32],
    issued_at_unix: u64,
    expires_at_unix: u64,
    identity_witness_signature: [u8; 64],
    source_reviewer_signature: [u8; 64],
}

/// Fixed JSON transport for the two signatures. Deliberately no approval
/// boolean, verification flag, signer public key, input path or actor override.
fn parse_grant(bytes: &[u8]) -> Result<HistoricalImportGrant, &'static str> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Wire {
        format: String,
        purpose: String,
        destination_pharmacy: String,
        owner_id: String,
        identity_witness_id: String,
        source_reviewer_id: String,
        owner_authentication_record_sha256: String,
        original_v29_sha256: String,
        original_v67_sha256: String,
        detached_sqlx69_sha256: String,
        audit_sha256: String,
        audit_evidence_sha256: String,
        request_nonce: String,
        issued_at_unix: u64,
        expires_at_unix: u64,
        identity_witness_ed25519_signature: String,
        source_reviewer_ed25519_signature: String,
    }
    if bytes.is_empty() || bytes.len() > 4096 {
        return Err(DENIED);
    }
    let parsed: Wire = serde_json::from_slice(bytes).map_err(|_| DENIED)?;
    // These values are also cryptographically bound by the message; accepting
    // fixed external identifiers prevents self-asserted or foreign signers.
    if parsed.format != FORMAT
        || parsed.purpose != PURPOSE
        || parsed.destination_pharmacy != TENANT
        || !identifier(&parsed.owner_id)
        || !identifier(&parsed.identity_witness_id)
        || !identifier(&parsed.source_reviewer_id)
    {
        return Err(DENIED);
    }
    // Signer IDs must be compared to native pins before signature verification.
    // They are returned separately because neither is ever a trust source.
    let grant = HistoricalImportGrant {
        owner_id: parsed.owner_id,
        identity_witness_id: parsed.identity_witness_id,
        source_reviewer_id: parsed.source_reviewer_id,
        owner_authentication_record_sha256: hex(&parsed.owner_authentication_record_sha256)?,
        original_v29_sha256: hex(&parsed.original_v29_sha256)?,
        original_v67_sha256: hex(&parsed.original_v67_sha256)?,
        detached_sqlx69_sha256: hex(&parsed.detached_sqlx69_sha256)?,
        audit_sha256: hex(&parsed.audit_sha256)?,
        audit_evidence_sha256: hex(&parsed.audit_evidence_sha256)?,
        request_nonce: hex(&parsed.request_nonce)?,
        issued_at_unix: parsed.issued_at_unix,
        expires_at_unix: parsed.expires_at_unix,
        identity_witness_signature: hex(&parsed.identity_witness_ed25519_signature)?,
        source_reviewer_signature: hex(&parsed.source_reviewer_ed25519_signature)?,
    };
    if grant.owner_authentication_record_sha256 == [0; 32]
        || grant.original_v29_sha256 == [0; 32]
        || grant.original_v67_sha256 == [0; 32]
        || grant.detached_sqlx69_sha256 == [0; 32]
        || grant.audit_sha256 == [0; 32]
        || grant.audit_evidence_sha256 == [0; 32]
        || grant.request_nonce == [0; 32]
        || grant.identity_witness_signature == [0; 64]
        || grant.source_reviewer_signature == [0; 64]
    {
        return Err(DENIED);
    }
    Ok(grant)
}

fn frame(message: &mut Vec<u8>, value: &[u8]) {
    message.extend_from_slice(&(value.len() as u32).to_be_bytes());
    message.extend_from_slice(value);
}

fn signed_statement(grant: &HistoricalImportGrant, trust: &TrustedApprovers) -> Vec<u8> {
    let mut message = DOMAIN.to_vec();
    for component in [
        FORMAT.as_bytes(),
        PURPOSE.as_bytes(),
        TENANT.as_bytes(),
        trust.owner_id.as_bytes(),
        trust.identity_witness_id.as_bytes(),
        trust.source_reviewer_id.as_bytes(),
    ] {
        frame(&mut message, component);
    }
    for digest in [
        &grant.owner_authentication_record_sha256,
        &grant.original_v29_sha256,
        &grant.original_v67_sha256,
        &grant.detached_sqlx69_sha256,
        &grant.audit_sha256,
        &grant.audit_evidence_sha256,
        &grant.request_nonce,
    ] {
        message.extend_from_slice(digest);
    }
    message.extend_from_slice(&grant.issued_at_unix.to_be_bytes());
    message.extend_from_slice(&grant.expires_at_unix.to_be_bytes());
    message
}

fn verify_signatures(
    grant: &HistoricalImportGrant,
    trust: &TrustedApprovers,
    actual_sha256: [u8; 32],
    now_unix: u64,
) -> Result<[u8; 32], &'static str> {
    if grant.original_v29_sha256 != trust.original_v29_sha256
        || grant.owner_id != trust.owner_id
        || grant.identity_witness_id != trust.identity_witness_id
        || grant.source_reviewer_id != trust.source_reviewer_id
        || grant.detached_sqlx69_sha256 != actual_sha256
        || grant.request_nonce != trust.expected_nonce
        || grant.issued_at_unix > now_unix.saturating_add(120)
        || grant.expires_at_unix <= now_unix
        || grant.expires_at_unix <= grant.issued_at_unix
        || grant.expires_at_unix - grant.issued_at_unix > MAX_AGE
    {
        return Err(DENIED);
    }
    let statement = signed_statement(grant, trust);
    // Role-specific domains prevent either signature being substituted for
    // the other, including if future code accidentally changes signer order.
    let mut digest = Sha256::new();
    for (role, key, signature) in [
        (
            b"identity-witness\0".as_slice(),
            &trust.identity_witness_key,
            &grant.identity_witness_signature,
        ),
        (
            b"source-reviewer\0".as_slice(),
            &trust.source_reviewer_key,
            &grant.source_reviewer_signature,
        ),
    ] {
        let mut signed = Vec::with_capacity(statement.len() + role.len());
        signed.extend_from_slice(role);
        signed.extend_from_slice(&statement);
        UnparsedPublicKey::new(&ED25519, key)
            .verify(&signed, signature)
            .map_err(|_| DENIED)?;
        digest.update(signature);
    }
    digest.update(&statement);
    Ok(digest.finalize().into())
}

async fn verify_audit(
    connection: &mut SqliteConnection,
    grant: &HistoricalImportGrant,
    trust: &TrustedApprovers,
) -> Result<(), &'static str> {
    // Check the full migrated audit ledger's exact typed counts, links and
    // source pins; the audit is unsigned evidence until BOTH signatures pass.
    let migration: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*),COUNT(DISTINCT version),COALESCE(MIN(version),0),\
         COALESCE(MAX(version),0),\
         COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0),\
         COALESCE(SUM(CASE WHEN typeof(version)='integer' AND \
           typeof(success)='integer' THEN 1 ELSE 0 END),0) FROM _sqlx_migrations",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| DENIED)?;
    if migration != (69, 69, 1, 69, 69, 69) {
        return Err(DENIED);
    }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| DENIED)?;
    if integrity != "ok"
        || !sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut *connection)
            .await
            .map_err(|_| DENIED)?
            .is_empty()
    {
        return Err(DENIED);
    }
    let owners: Vec<(String,)> = sqlx::query_as(
        "SELECT CAST(id AS TEXT) FROM users WHERE LOWER(TRIM(COALESCE(role,'')))='owner' \
         AND COALESCE(is_active,1)=1",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| DENIED)?;
    if owners.len() != 1 || owners[0].0 != trust.owner_id {
        return Err(DENIED);
    }
    let batches = sqlx::query(
        "SELECT b.audit_sha256,b.original_v67_sha256,b.sealed_v29_sha256,\
         b.pharmacy_id,b.evidence_kind,b.observed_native_schema_version,\
         b.original_physical_table_count,b.original_physical_row_count,\
         b.expected_original_scope_count,b.expected_table_witness_count,\
         b.expected_relation_witness_count,s.evidence_sha256 \
         FROM native_primary_scope_audit_batches b JOIN \
         native_primary_scope_audit_seals s ON s.audit_sha256=b.audit_sha256",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| DENIED)?;
    if batches.len() != 1 {
        return Err(DENIED);
    }
    let batch = &batches[0];
    let source_sha: String = batch.try_get("original_v67_sha256").map_err(|_| DENIED)?;
    let v29: String = batch.try_get("sealed_v29_sha256").map_err(|_| DENIED)?;
    let audit_sha: String = batch.try_get("audit_sha256").map_err(|_| DENIED)?;
    let audit_evidence: String = batch.try_get("evidence_sha256").map_err(|_| DENIED)?;
    let tenant: String = batch.try_get("pharmacy_id").map_err(|_| DENIED)?;
    let kind: String = batch.try_get("evidence_kind").map_err(|_| DENIED)?;
    let version: i64 = batch
        .try_get("observed_native_schema_version")
        .map_err(|_| DENIED)?;
    if hex::<32>(&source_sha)? != grant.original_v67_sha256
        || hex::<32>(&v29)? != grant.original_v29_sha256
        || hex::<32>(&audit_sha)? != grant.audit_sha256
        || hex::<32>(&audit_evidence)? != grant.audit_evidence_sha256
        || tenant != TENANT
        || kind != "UNSIGNED_TYPED_DISPOSABLE_AUDIT"
        || version != 67
    {
        return Err(DENIED);
    }
    let tables: i64 = batch
        .try_get("original_physical_table_count")
        .map_err(|_| DENIED)?;
    let rows: i64 = batch
        .try_get("original_physical_row_count")
        .map_err(|_| DENIED)?;
    let scopes: i64 = batch
        .try_get("expected_original_scope_count")
        .map_err(|_| DENIED)?;
    let table_witnesses: i64 = batch
        .try_get("expected_table_witness_count")
        .map_err(|_| DENIED)?;
    let relationships: i64 = batch
        .try_get("expected_relation_witness_count")
        .map_err(|_| DENIED)?;
    if tables <= 0 || rows <= 0 || scopes <= 0 || relationships <= 0 || table_witnesses != tables {
        return Err(DENIED);
    }
    let (actual_tables, actual_rows): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*),COALESCE(SUM(original_physical_rows),0) \
         FROM native_primary_scope_audit_tables WHERE audit_sha256=?",
    )
    .bind(&audit_sha)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| DENIED)?;
    let actual_scopes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM native_primary_scope_audit_originals WHERE audit_sha256=?",
    )
    .bind(&audit_sha)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| DENIED)?;
    let actual_relations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM native_primary_scope_audit_relations WHERE audit_sha256=?",
    )
    .bind(&audit_sha)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| DENIED)?;
    let attestations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM native_primary_scope_owner_attestations")
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| DENIED)?;
    if (actual_tables, actual_rows, actual_scopes, actual_relations)
        != (tables, rows, scopes, relationships)
        || attestations != 0
    {
        return Err(DENIED);
    }
    Ok(())
}

/// The result is evidence of two independently checked signatures for these
/// exact bytes. It has NO right to unlock startup or install historical data.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct VerifiedHistoricalImportCustody {
    pub(crate) source_sha256: [u8; 32],
    pub(crate) approval_sha256: [u8; 32],
}

async fn verify_on_connection(
    connection: &mut SqliteConnection,
    grant: &HistoricalImportGrant,
    trust: &TrustedApprovers,
    source_sha256: [u8; 32],
    now: u64,
) -> Result<VerifiedHistoricalImportCustody, &'static str> {
    let approval_sha256 = verify_signatures(grant, trust, source_sha256, now)?;
    verify_audit(connection, grant, trust).await?;
    Ok(VerifiedHistoricalImportCustody {
        source_sha256,
        approval_sha256,
    })
}

fn checked_detached_path(path: &Path, root: &Path) -> Result<(), &'static str> {
    if !path.is_absolute()
        || path.file_name().and_then(|v| v.to_str()) != Some("audited-sqlx69.sqlite3")
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(DENIED);
    }
    let stage = path.parent().ok_or(DENIED)?;
    let token = stage
        .file_name()
        .and_then(|v| v.to_str())
        .and_then(|v| v.strip_prefix("pharma-historical-import-stage-"))
        .ok_or(DENIED)?;
    if token.len() != 32
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DENIED);
    }
    if stage.parent() != Some(root) {
        return Err(DENIED);
    }
    for entry in [root, stage, path] {
        let metadata = fs::symlink_metadata(entry).map_err(|_| DENIED)?;
        if metadata.file_type().is_symlink() {
            return Err(DENIED);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x0400 != 0 {
                return Err(DENIED);
            }
        }
        if entry == path {
            if !metadata.is_file() || !(4096..=MAX_BYTES).contains(&metadata.len()) {
                return Err(DENIED);
            }
        } else if !metadata.is_dir() {
            return Err(DENIED);
        }
    }
    if stage.canonicalize().map_err(|_| DENIED)?.parent()
        != Some(root.canonicalize().map_err(|_| DENIED)?.as_path())
    {
        return Err(DENIED);
    }
    for sidecar in ["-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_owned();
        name.push(sidecar);
        match fs::symlink_metadata(PathBuf::from(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(DENIED),
        }
    }
    Ok(())
}

fn snapshot_sha256(path: &Path) -> Result<[u8; 32], &'static str> {
    let mut file = fs::File::open(path).map_err(|_| DENIED)?;
    let mut digest = Sha256::new();
    let mut header = [0_u8; 20];
    file.read_exact(&mut header).map_err(|_| DENIED)?;
    // A snapshot still in WAL mode may have uncheckpointed transactions.
    if &header[..16] != b"SQLite format 3\0" || header[18..20] != [1, 1] {
        return Err(DENIED);
    }
    digest.update(header);
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| DENIED)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().into())
}

/// Detached snapshot only; no live installed database, renderer, or SQL writer.
/// The independently pinned build roots must exist BEFORE examining the file.
/// The source is hashed before and after an immutable read-only SQL inspection.
pub(crate) fn verify_detached_historical_import_grant(
    stage_token: &str,
) -> Result<VerifiedHistoricalImportCustody, String> {
    let trust = independently_pinned_approvers().map_err(str::to_string)?;
    if stage_token.len() != 32
        || !stage_token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DENIED.into());
    }
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(DENIED)?)
        .join("pharma-disposable-data-copies");
    let stage = root.join(format!("pharma-historical-import-stage-{stage_token}"));
    let source = stage.join("audited-sqlx69.sqlite3");
    checked_detached_path(&source, &root).map_err(str::to_string)?;
    let approval_path = stage.join("historical-approval.json");
    let approval_metadata = fs::symlink_metadata(&approval_path).map_err(|_| DENIED)?;
    if !approval_metadata.file_type().is_file() || !(1..=4096).contains(&approval_metadata.len()) {
        return Err(DENIED.into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if approval_metadata.file_attributes() & 0x0400 != 0 {
            return Err(DENIED.into());
        }
    }
    let raw = fs::read(approval_path).map_err(|_| DENIED)?;
    let grant = parse_grant(&raw).map_err(str::to_string)?;
    // Neither JSON nor SQLite source selects an approver, trust root, source
    // custody request or destination; all are native-pinned.
    let source_sha256 = snapshot_sha256(&source).map_err(str::to_string)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| DENIED)?
        .as_secs();
    let verified = tauri::async_runtime::block_on(async {
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .read_only(true)
                .immutable(true)
                .create_if_missing(false),
        )
        .await
        .map_err(|_| DENIED)?;
        sqlx::query("PRAGMA query_only=ON")
            .execute(&mut connection)
            .await
            .map_err(|_| DENIED)?;
        let result =
            verify_on_connection(&mut connection, &grant, &trust, source_sha256, now).await;
        connection.close().await.map_err(|_| DENIED)?;
        result
    })
    .map_err(str::to_string)?;
    checked_detached_path(&source, &root).map_err(str::to_string)?;
    if snapshot_sha256(&source).map_err(str::to_string)? != source_sha256 {
        return Err(DENIED.into());
    }
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn lower(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn signer() -> Ed25519KeyPair {
        let random = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&random).unwrap();
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    fn synthetic_grant() -> (
        HistoricalImportGrant,
        TrustedApprovers,
        Ed25519KeyPair,
        Ed25519KeyPair,
    ) {
        // In-memory signers only. These are never enrolled as production trust.
        let identity = signer();
        let reviewer = signer();
        let trust = TrustedApprovers::from_native_custody(
            "historic-owner",
            "verified-owner-identity-witness",
            identity.public_key().as_ref().try_into().unwrap(),
            [29; 32],
            "independent-source-reviewer",
            reviewer.public_key().as_ref().try_into().unwrap(),
            [77; 32],
        )
        .unwrap();
        let mut grant = HistoricalImportGrant {
            owner_id: "historic-owner".into(),
            identity_witness_id: "verified-owner-identity-witness".into(),
            source_reviewer_id: "independent-source-reviewer".into(),
            owner_authentication_record_sha256: [48; 32],
            original_v29_sha256: [29; 32],
            original_v67_sha256: [67; 32],
            detached_sqlx69_sha256: [69; 32],
            audit_sha256: [41; 32],
            audit_evidence_sha256: [42; 32],
            request_nonce: [77; 32],
            issued_at_unix: 400_000,
            expires_at_unix: 500_000,
            identity_witness_signature: [0; 64],
            source_reviewer_signature: [0; 64],
        };
        let statement = signed_statement(&grant, &trust);
        let identity_message = [b"identity-witness\0".as_slice(), &statement].concat();
        let reviewer_message = [b"source-reviewer\0".as_slice(), &statement].concat();
        grant
            .identity_witness_signature
            .copy_from_slice(identity.sign(&identity_message).as_ref());
        grant
            .source_reviewer_signature
            .copy_from_slice(reviewer.sign(&reviewer_message).as_ref());
        (grant, trust, identity, reviewer)
    }

    fn wire(grant: &HistoricalImportGrant) -> serde_json::Value {
        serde_json::json!({
            "format": FORMAT,
            "purpose": PURPOSE,
            "destination_pharmacy": TENANT,
            "owner_id": grant.owner_id,
            "identity_witness_id": grant.identity_witness_id,
            "source_reviewer_id": grant.source_reviewer_id,
            "owner_authentication_record_sha256": lower(&grant.owner_authentication_record_sha256),
            "original_v29_sha256": lower(&grant.original_v29_sha256),
            "original_v67_sha256": lower(&grant.original_v67_sha256),
            "detached_sqlx69_sha256": lower(&grant.detached_sqlx69_sha256),
            "audit_sha256": lower(&grant.audit_sha256),
            "audit_evidence_sha256": lower(&grant.audit_evidence_sha256),
            "request_nonce": lower(&grant.request_nonce),
            "issued_at_unix": grant.issued_at_unix,
            "expires_at_unix": grant.expires_at_unix,
            "identity_witness_ed25519_signature": lower(&grant.identity_witness_signature),
            "source_reviewer_ed25519_signature": lower(&grant.source_reviewer_signature),
        })
    }

    async fn synthetic_sqlx69_audit() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE _sqlx_migrations(version INTEGER,success INTEGER);\
             WITH RECURSIVE versions(v) AS (SELECT 1 UNION ALL SELECT v+1 \
             FROM versions WHERE v<69) \
             INSERT INTO _sqlx_migrations SELECT v,1 FROM versions;\
             CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER,password_hash TEXT);\
             INSERT INTO users VALUES('historic-owner','owner','primary_pharmacy',1,NULL);"
        ).execute(&mut db).await.unwrap();
        // Exercise the actual registered SQLx68 custody tables and guards.
        sqlx::raw_sql(include_str!(
            "../migrations/068_primary_pharmacy_typed_scope_audit.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO native_primary_scope_audit_batches(\
             audit_sha256,original_v67_sha256,sealed_v29_sha256,\
             original_physical_table_count,original_physical_row_count,\
             expected_original_scope_count,expected_table_witness_count,\
             expected_relation_witness_count,observed_native_schema_version) \
             VALUES(?,?,?,1,1,1,1,1,67)",
        )
        .bind(lower(&[41; 32]))
        .bind(lower(&[67; 32]))
        .bind(lower(&[29; 32]))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO native_primary_scope_audit_originals(\
             audit_sha256,source_table,source_rowid,original_storage,original_literal,\
             original_row_typed_sha256) VALUES(?,'users',1,'null',NULL,?)",
        )
        .bind(lower(&[41; 32]))
        .bind(lower(&[71; 32]))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO native_primary_scope_audit_tables(\
             audit_sha256,source_table,original_physical_rows,directly_scoped,\
             original_typed_rows_sha256,normalized_typed_rows_sha256)\
             VALUES(?,'users',1,1,?,?)",
        )
        .bind(lower(&[41; 32]))
        .bind(lower(&[71; 32]))
        .bind(lower(&[72; 32]))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO native_primary_scope_audit_relations(\
             audit_sha256,relation_sha256,relation_kind,source_rows,matched_typed_rows,\
             coerced_only_rows,missing_parent_rows,unlinked_rows,partial_null_rows,\
             before_edge_sha256,after_edge_sha256)\
             VALUES(?,?,'FIXED',1,1,0,0,0,0,?,?)",
        )
        .bind(lower(&[41; 32]))
        .bind(lower(&[73; 32]))
        .bind(lower(&[74; 32]))
        .bind(lower(&[75; 32]))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO native_primary_scope_audit_seals(audit_sha256,evidence_sha256) VALUES(?,?)"
        ).bind(lower(&[41; 32])).bind(lower(&[42; 32]))
            .execute(&mut db).await.unwrap();
        db
    }

    #[test]
    fn production_trust_is_absent_and_roles_are_independent() {
        // Normal builds must not have an invented verifier or customer key.
        if option_env!("PHARMA_NATIVE_HISTORICAL_IDENTITY_WITNESS_PUBLIC_HEX").is_none()
            || option_env!("PHARMA_NATIVE_HISTORICAL_SOURCE_REVIEWER_PUBLIC_HEX").is_none()
        {
            assert!(independently_pinned_approvers().is_err());
        }
        assert!(TrustedApprovers::from_native_custody(
            "owner", "agent", [1; 32], [29; 32], "agent", [2; 32], [77; 32]
        )
        .is_err());
        assert!(TrustedApprovers::from_native_custody(
            "owner", "identity", [1; 32], [29; 32], "review", [1; 32], [77; 32]
        )
        .is_err());
        assert!(TrustedApprovers::from_native_custody(
            "owner", "identity", [1; 32], [0; 32], "review", [2; 32], [77; 32]
        )
        .is_err());
        assert!(TrustedApprovers::from_native_custody(
            "owner", "identity", [1; 32], [29; 32], "review", [2; 32], [0; 32]
        )
        .is_err());
    }

    #[test]
    fn grant_wire_rejects_injected_authority_and_malformed_custody() {
        let (grant, _, _, _) = synthetic_grant();
        let raw = wire(&grant);
        assert!(parse_grant(&serde_json::to_vec(&raw).unwrap()).is_ok());
        for (field, replacement) in [
            ("destination_pharmacy", serde_json::json!("local_default")),
            ("purpose", serde_json::json!("install-authorized")),
            (
                "owner_authentication_record_sha256",
                serde_json::json!("00".repeat(32)),
            ),
            ("detached_sqlx69_sha256", serde_json::json!("FF".repeat(32))),
            ("identity_witness_ed25519_signature", serde_json::json!("")),
            ("source_reviewer_id", serde_json::json!("")),
            ("expires_at_unix", serde_json::json!(-1)),
        ] {
            let mut altered = raw.clone();
            altered[field] = replacement;
            assert!(
                parse_grant(&serde_json::to_vec(&altered).unwrap()).is_err(),
                "Malformed grant field: {field}"
            );
        }
        for injected in [
            "authorized",
            "owner_key",
            "reviewer_public_key",
            "source_path",
        ] {
            let mut altered = raw.clone();
            altered[injected] = serde_json::json!(true);
            assert!(parse_grant(&serde_json::to_vec(&altered).unwrap()).is_err());
        }
        let mut no_review = raw.clone();
        no_review
            .as_object_mut()
            .unwrap()
            .remove("source_reviewer_ed25519_signature");
        assert!(parse_grant(&serde_json::to_vec(&no_review).unwrap()).is_err());
    }

    #[tokio::test]
    async fn independent_grant_validates_pinned_audit_without_creating_attestation() {
        let (grant, trust, _, _) = synthetic_grant();
        let mut db = synthetic_sqlx69_audit().await;
        let proof = verify_on_connection(&mut db, &grant, &trust, [69; 32], 400_001)
            .await
            .unwrap();
        assert_eq!(proof.source_sha256, [69; 32]);
        assert_ne!(proof.approval_sha256, [0; 32]);
        let attestations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_primary_scope_owner_attestations")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(
            attestations, 0,
            "Cryptographic review never fabricates owner enrollment"
        );

        assert!(
            verify_on_connection(&mut db, &grant, &trust, [68; 32], 400_001)
                .await
                .is_err(),
            "A different candidate cannot reuse this source approval"
        );
        assert!(
            verify_on_connection(&mut db, &grant, &trust, [69; 32], 500_001)
                .await
                .is_err(),
            "Expired grants cannot authorize historical custody"
        );
        let mut switched = grant.clone();
        std::mem::swap(
            &mut switched.identity_witness_signature,
            &mut switched.source_reviewer_signature,
        );
        assert!(
            verify_on_connection(&mut db, &switched, &trust, [69; 32], 400_001)
                .await
                .is_err(),
            "Distinct operator signatures are purpose-separated"
        );
        for altered in 0..5 {
            let mut tampered = grant.clone();
            match altered {
                0 => tampered.owner_authentication_record_sha256[0] ^= 1,
                1 => tampered.audit_evidence_sha256[0] ^= 1,
                2 => tampered.original_v67_sha256[0] ^= 1,
                3 => tampered.request_nonce[0] ^= 1,
                _ => tampered.owner_id.push('x'),
            }
            assert!(
                verify_on_connection(&mut db, &tampered, &trust, [69; 32], 400_001)
                    .await
                    .is_err(),
                "Changed source, identity or challenge invalidates signatures"
            );
        }
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version=69")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(
            verify_on_connection(&mut db, &grant, &trust, [69; 32], 400_001)
                .await
                .is_err(),
            "Downgraded source audit is ineligible"
        );
    }
}
