//! Standalone native maintenance CLI for an owner-signed, detached COPY ONLY.
//! This module is never registered with Tauri IPC or normal licensed startup.
//! Stage input is fixed to LOCALAPPDATA/pharma-disposable-data-copies/<token>/
//! with precisely snapshot.sqlite3 and ticket.json, and no caller-selected key.

use crate::primary_pharmacy_upgrade::{self, SignedCopyOnlyTicket};
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DENIED: &str = "Signed original-owner source-bound copy-only upgrade required";
const FLAG: &str = "--native-prepare-signed-copy-only-v52-v67";
const ROOT_NAME: &str = "pharma-disposable-data-copies";
const SOURCE_NAME: &str = "snapshot.sqlite3";
const TICKET_NAME: &str = "ticket.json";
const ATTEMPT_NAME: &str = ".native-copy-only-attempt.sealed";
const DOMAIN: &[u8] = b"pharma/native/copy-only-v52-v67-primary-pharmacy/v1\0";
const TENANT: &[u8] = b"primary_pharmacy";
const MAX_AGE_SECONDS: u64 = 30 * 24 * 3600;

#[derive(Clone)]
struct PinnedOwner {
    id: String,
    key: [u8; 32],
    original_v29_sha256: [u8; 32],
}

pub(crate) fn parse_stage_argument(args: &[OsString]) -> Option<Result<String, &'static str>> {
    if args.first().map(OsString::as_os_str) != Some(OsStr::new(FLAG)) {
        return None;
    }
    Some(match args {
        [_, token] => match token.to_str() {
            Some(token) if valid_token(token) => Ok(token.to_owned()),
            _ => Err(DENIED),
        },
        _ => Err(DENIED),
    })
}

fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(is_lower_hex)
}

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N], &'static str> {
    if value.len() != N * 2 || !value.bytes().all(is_lower_hex) {
        return Err(DENIED);
    }
    let mut decoded = [0_u8; N];
    for (slot, pair) in decoded.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        let nibble = |c| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
        *slot = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    Ok(decoded)
}

// All three pins must be independently authenticated BEFORE compilation.
// These exact variable names and checks mirror primary_pharmacy_upgrade.rs;
// neither argv, ticket, source SQLite nor QA license can supply trust.
fn compile_pinned_owner() -> Result<PinnedOwner, &'static str> {
    let (Some(id), Some(key), Some(original)) = (
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
    let pins = PinnedOwner {
        id: id.to_owned(),
        key: decode_hex(key)?,
        original_v29_sha256: decode_hex(original)?,
    };
    if pins.key.iter().all(|b| *b == 0) || pins.original_v29_sha256.iter().all(|b| *b == 0) {
        return Err(DENIED);
    }
    Ok(pins)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTicket {
    source_sha256: String,
    scope_sha256: String,
    nonce: String,
    expires_unix_seconds: u64,
    ed25519_signature: String,
}

fn parse_ticket(bytes: &[u8]) -> Result<SignedCopyOnlyTicket, &'static str> {
    if bytes.is_empty() || bytes.len() > 4096 {
        return Err(DENIED);
    }
    let raw: WireTicket = serde_json::from_slice(bytes).map_err(|_| DENIED)?;
    Ok(SignedCopyOnlyTicket {
        source_sha256: decode_hex(&raw.source_sha256)?,
        scope_sha256: decode_hex(&raw.scope_sha256)?,
        nonce: decode_hex(&raw.nonce)?,
        expires_unix_seconds: raw.expires_unix_seconds,
        ed25519_signature: decode_hex(&raw.ed25519_signature)?,
    })
}

fn checked_regular_component(path: &Path, directory: bool) -> Result<(), &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| DENIED)?;
    if meta.file_type().is_symlink()
        || if directory {
            !meta.file_type().is_dir()
        } else {
            !meta.file_type().is_file()
        }
    {
        return Err(DENIED);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Symlink checks alone miss NTFS junctions and other reparse points.
        if meta.file_attributes() & 0x0400 != 0 {
            return Err(DENIED);
        }
    }
    Ok(())
}

fn checked_ancestors(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(DENIED);
    }
    for ancestor in path.ancestors() {
        checked_regular_component(ancestor, true)?;
    }
    Ok(())
}

#[cfg(windows)]
fn require_single_hard_link(handle: &File) -> Result<(), &'static str> {
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
    if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(DENIED);
    }
    // SAFETY: Win32 only reports success after populating the complete struct.
    if unsafe { info.assume_init().links } != 1 {
        return Err(DENIED);
    }
    Ok(())
}

fn checked_open_read(path: &Path, min: u64, max: u64) -> Result<File, &'static str> {
    checked_regular_component(path, false)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x0000_0001); // FILE_SHARE_READ; no concurrent write/delete
    }
    let file = options.open(path).map_err(|_| DENIED)?;
    let meta = file.metadata().map_err(|_| DENIED)?;
    if !meta.is_file() || meta.len() < min || meta.len() > max {
        return Err(DENIED);
    }
    #[cfg(windows)]
    require_single_hard_link(&file)?;
    Ok(file)
}

struct Stage {
    root: PathBuf,
    dir: PathBuf,
    source: PathBuf,
    ticket: PathBuf,
}

fn checked_stage(root: &Path, token: &str) -> Result<Stage, &'static str> {
    if !valid_token(token) || root.file_name() != Some(OsStr::new(ROOT_NAME)) {
        return Err(DENIED);
    }
    checked_ancestors(root)?;
    let dir = root.join(token);
    checked_regular_component(&dir, true)?;
    let source = dir.join(SOURCE_NAME);
    let ticket = dir.join(TICKET_NAME);

    // The only allowed input files are these exact names, with no SQLite WAL,
    // SHM, journal, unexpected sidecars, junctions or prior consumed marker.
    let mut has_source = false;
    let mut has_ticket = false;
    for entry in fs::read_dir(&dir).map_err(|_| DENIED)? {
        let name = entry.map_err(|_| DENIED)?.file_name();
        if name == OsStr::new(SOURCE_NAME) && !has_source {
            has_source = true;
        } else if name == OsStr::new(TICKET_NAME) && !has_ticket {
            has_ticket = true;
        } else {
            return Err(DENIED);
        }
    }
    if !has_source || !has_ticket {
        return Err(DENIED);
    }
    let _source_handle = checked_open_read(&source, 4096, 700_000_000)?;
    checked_regular_component(&ticket, false)?;
    Ok(Stage {
        root: root.to_path_buf(),
        dir,
        source,
        ticket,
    })
}

fn read_ticket(path: &Path) -> Result<SignedCopyOnlyTicket, &'static str> {
    let mut file = checked_open_read(path, 1, 4096)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| DENIED)?;
    parse_ticket(&bytes)
}

fn framed(hash: &mut Sha256, value: &[u8]) {
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value);
}

// This is the exact signature envelope used by primary_pharmacy_upgrade.
// Try the two supported migration versions; the existing helper independently
// checks the actual source version and full typed scope before creating a copy.
fn authenticated_ticket(
    ticket: &SignedCopyOnlyTicket,
    now: u64,
    pins: &PinnedOwner,
) -> Result<(), &'static str> {
    if ticket.nonce.iter().all(|b| *b == 0)
        || ticket.expires_unix_seconds < now
        || ticket.expires_unix_seconds.saturating_sub(now) > MAX_AGE_SECONDS
    {
        return Err(DENIED);
    }
    let mut owner_scope = Sha256::new();
    framed(&mut owner_scope, pins.id.as_bytes());
    framed(&mut owner_scope, TENANT);
    let identity = owner_scope.finalize();
    let verifier = UnparsedPublicKey::new(&ED25519, pins.key);
    for version in [52_i64, 67] {
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&version.to_be_bytes());
        message.extend_from_slice(&pins.original_v29_sha256);
        message.extend_from_slice(&ticket.source_sha256);
        message.extend_from_slice(&ticket.scope_sha256);
        message.extend_from_slice(&ticket.nonce);
        message.extend_from_slice(&ticket.expires_unix_seconds.to_be_bytes());
        message.extend_from_slice(&identity);
        if verifier.verify(&message, &ticket.ed25519_signature).is_ok() {
            return Ok(());
        }
    }
    Err(DENIED)
}

fn lower_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut result, "{byte:02x}").expect("String writes cannot fail");
    }
    result
}

fn seal_once(path: &Path) -> Result<(), &'static str> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| DENIED)?;
    file.write_all(b"authenticated native copy-only attempt; one-time claim\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| DENIED)?;
    let mut permissions = file.metadata().map_err(|_| DENIED)?.permissions();
    permissions.set_readonly(true);
    file.set_permissions(permissions).map_err(|_| DENIED)?;
    file.sync_all().map_err(|_| DENIED)?;
    #[cfg(unix)]
    File::open(path.parent().ok_or(DENIED)?)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| DENIED)?;
    Ok(())
}

fn claim_signed_request(stage: &Stage, ticket: &SignedCopyOnlyTicket) -> Result<(), &'static str> {
    // One nonce globally across this disposable root, including cloned tickets
    // in other token folders. The global claim comes first: failure midway
    // burns the nonce and cannot allow a second history-bearing output.
    let nonce_digest = Sha256::digest(ticket.nonce);
    let nonce_name = format!(
        ".native-copy-only-nonce-{}.sealed",
        lower_hex(&nonce_digest)
    );
    seal_once(&stage.root.join(nonce_name))?;
    // An additional durable local marker makes interrupted stages visible.
    // Never delete either marker, even if validation/normalization later fails.
    seal_once(&stage.dir.join(ATTEMPT_NAME))
}

/// Complete before app startup; success means an authenticated disposable copy
/// was prepared, never installed, promoted, licensed or authorized for finance.
pub(crate) fn run(token: &str) -> Result<(), &'static str> {
    if !valid_token(token) {
        return Err(DENIED);
    }
    // Absent native owner enrollment MUST refuse before opening ANY stage.
    let pins = compile_pinned_owner()?;
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(DENIED)?);
    if !local.is_absolute() {
        return Err(DENIED);
    }
    #[cfg(windows)]
    {
        // LOCALAPPDATA must resolve from a normal local-drive path, never a
        // UNC share, device namespace or caller-selected verbatim alias.
        if !matches!(
            local.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::Disk(_))
        ) {
            return Err(DENIED);
        }
    }
    let root = local.join(ROOT_NAME);
    let stage = checked_stage(&root, token)?;
    let ticket = read_ticket(&stage.ticket)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DENIED)?
        .as_secs();
    authenticated_ticket(&ticket, now, &pins)?;
    // Full helper repeats signature, full source hash and typed-scope proof.
    // Claim BEFORE it creates the first customer-history-bearing derived file.
    claim_signed_request(&stage, &ticket)?;
    let receipt = tauri::async_runtime::block_on(
        primary_pharmacy_upgrade::prepare_signed_copy_only_upgrade(&stage.source, &ticket),
    )
    .map_err(|_| DENIED)?;
    if receipt.authorization_granted || receipt.source_sha256 != ticket.source_sha256 {
        return Err(DENIED);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn ticket() -> SignedCopyOnlyTicket {
        SignedCopyOnlyTicket {
            source_sha256: [1; 32],
            scope_sha256: [2; 32],
            nonce: [3; 32],
            expires_unix_seconds: 1_000,
            ed25519_signature: [0; 64],
        }
    }

    fn ticket_json() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "source_sha256": lower_hex(&[1; 32]),
            "scope_sha256": lower_hex(&[2; 32]),
            "nonce": lower_hex(&[3; 32]),
            "expires_unix_seconds": 1000,
            "ed25519_signature": lower_hex(&[4; 64]),
        }))
        .unwrap()
    }

    #[test]
    fn cli_only_accepts_one_canonical_stage_token() {
        let valid = "0123456789abcdef0123456789abcdef";
        assert!(parse_stage_argument(&[]).is_none());
        assert!(parse_stage_argument(&[OsString::from("--help")]).is_none());
        assert_eq!(
            parse_stage_argument(&[OsString::from(FLAG), OsString::from(valid)])
                .unwrap()
                .unwrap(),
            valid
        );
        for suffix in [
            vec![],
            vec![OsString::from("..")],
            vec![OsString::from("0123456789ABCDEF0123456789abcdef")],
            vec![OsString::from("0123456789abcdef0123456789abcdeg")],
            vec![
                OsString::from(valid),
                OsString::from("--owner-public-key=qa"),
            ],
            vec![
                OsString::from(valid),
                OsString::from("--db=pharma_local.db"),
            ],
        ] {
            let mut args = vec![OsString::from(FLAG)];
            args.extend(suffix);
            assert!(parse_stage_argument(&args).unwrap().is_err());
        }
    }

    #[test]
    fn strict_json_ticket_rejects_unknown_duplicate_wrong_types_and_hex() {
        let baseline = ticket_json();
        assert!(parse_ticket(&baseline).is_ok());
        assert!(parse_ticket(&[]).is_err());
        assert!(parse_ticket(&vec![b'x'; 4097]).is_err());
        let mut json: serde_json::Value = serde_json::from_slice(&baseline).unwrap();
        json["owner_public_key"] = serde_json::json!(lower_hex(&[9; 32]));
        assert!(parse_ticket(&serde_json::to_vec(&json).unwrap()).is_err());
        json.as_object_mut().unwrap().remove("owner_public_key");
        json["nonce"] = serde_json::json!(lower_hex(&[3; 31]));
        assert!(parse_ticket(&serde_json::to_vec(&json).unwrap()).is_err());
        json["nonce"] = serde_json::json!("GG".repeat(32));
        assert!(parse_ticket(&serde_json::to_vec(&json).unwrap()).is_err());
        json["nonce"] = serde_json::json!(lower_hex(&[3; 32]));
        json["expires_unix_seconds"] = serde_json::json!(-1);
        assert!(parse_ticket(&serde_json::to_vec(&json).unwrap()).is_err());
        let duplicate = String::from_utf8(baseline).unwrap().replacen(
            "\"nonce\":",
            "\"nonce\":\"00\",\"nonce\":",
            1,
        );
        assert!(parse_ticket(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn signature_is_pinned_to_owner_source_nonce_expiry_and_version() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[11; 32]).unwrap();
        let pins = PinnedOwner {
            id: "synthetic-owner".to_owned(),
            key: signer.public_key().as_ref().try_into().unwrap(),
            original_v29_sha256: [8; 32],
        };
        let mut signed = ticket();
        let mut identity = Sha256::new();
        framed(&mut identity, pins.id.as_bytes());
        framed(&mut identity, TENANT);
        let mut message = DOMAIN.to_vec();
        message.extend(67_i64.to_be_bytes());
        message.extend(pins.original_v29_sha256);
        message.extend(signed.source_sha256);
        message.extend(signed.scope_sha256);
        message.extend(signed.nonce);
        message.extend(signed.expires_unix_seconds.to_be_bytes());
        message.extend(identity.finalize());
        signed.ed25519_signature = signer.sign(&message).as_ref().try_into().unwrap();
        assert!(authenticated_ticket(&signed, 100, &pins).is_ok());
        assert!(authenticated_ticket(&signed, 1001, &pins).is_err());
        let mut other_pins = pins.clone();
        other_pins.id.push('x');
        assert!(authenticated_ticket(&signed, 100, &other_pins).is_err());
        other_pins = pins.clone();
        other_pins.original_v29_sha256[0] ^= 1;
        assert!(authenticated_ticket(&signed, 100, &other_pins).is_err());
        let mut tampered = SignedCopyOnlyTicket {
            source_sha256: [4; 32],
            ..signed
        };
        assert!(authenticated_ticket(&tampered, 100, &pins).is_err());
        tampered.source_sha256 = signed.source_sha256;
        tampered.nonce = [0; 32];
        assert!(authenticated_ticket(&tampered, 100, &pins).is_err());
        tampered.nonce = signed.nonce;
        tampered.expires_unix_seconds = 100 + MAX_AGE_SECONDS + 1;
        assert!(authenticated_ticket(&tampered, 100, &pins).is_err());
    }

    #[test]
    fn stage_requires_exact_fixed_regular_files_and_no_reparse_or_extras() {
        let dir =
            std::env::temp_dir().join(format!("pharma-copy-cli-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join(ROOT_NAME);
        let token = "0123456789abcdef0123456789abcdef";
        let stage = root.join(token);
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join(SOURCE_NAME), vec![0_u8; 4096]).unwrap();
        fs::write(stage.join(TICKET_NAME), ticket_json()).unwrap();
        assert!(checked_stage(&root, token).is_ok());
        assert!(checked_stage(&root, "../outside").is_err());
        let alias = root.join("fedcba9876543210fedcba9876543210");
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&stage, &alias);
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(&stage, &alias);
        if created.is_ok() {
            assert!(checked_stage(&root, "fedcba9876543210fedcba9876543210").is_err());
            #[cfg(unix)]
            fs::remove_file(&alias).unwrap();
            #[cfg(windows)]
            fs::remove_dir(&alias).unwrap();
        }
        fs::write(stage.join("snapshot.sqlite3-wal"), b"sidecar").unwrap();
        assert!(checked_stage(&root, token).is_err());
        fs::remove_file(stage.join("snapshot.sqlite3-wal")).unwrap();
        fs::write(stage.join(ATTEMPT_NAME), b"consumed").unwrap();
        assert!(checked_stage(&root, token).is_err());
        fs::remove_file(stage.join(ATTEMPT_NAME)).unwrap();
        fs::remove_file(stage.join(TICKET_NAME)).unwrap();
        assert!(checked_stage(&root, token).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_nonce_and_stage_markers_burn_duplicate_requests() {
        let dir =
            std::env::temp_dir().join(format!("pharma-copy-nonce-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join(ROOT_NAME);
        let token = "0123456789abcdef0123456789abcdef";
        let stage_dir = root.join(token);
        fs::create_dir_all(&stage_dir).unwrap();
        let stage = Stage {
            root,
            dir: stage_dir,
            source: PathBuf::new(),
            ticket: PathBuf::new(),
        };
        let signed = ticket();
        assert!(claim_signed_request(&stage, &signed).is_ok());
        assert!(stage.dir.join(ATTEMPT_NAME).is_file());
        assert!(claim_signed_request(&stage, &signed).is_err());
        // Same nonce in another token folder cannot create a new copy.
        let other = Stage {
            dir: stage.root.join("fedcba9876543210fedcba9876543210"),
            ..stage
        };
        fs::create_dir_all(&other.dir).unwrap();
        assert!(claim_signed_request(&other, &signed).is_err());
        // Windows does not allow deleting readonly files directly.
        let mut stage_permissions = fs::metadata(other.root.join(token).join(ATTEMPT_NAME))
            .unwrap()
            .permissions();
        stage_permissions.set_readonly(false);
        fs::set_permissions(other.root.join(token).join(ATTEMPT_NAME), stage_permissions).unwrap();
        let nonce_claim = fs::read_dir(&other.root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.is_file())
            .unwrap();
        let mut nonce_permissions = fs::metadata(&nonce_claim).unwrap().permissions();
        nonce_permissions.set_readonly(false);
        fs::set_permissions(nonce_claim, nonce_permissions).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
