//! Fail-closed, native Ed25519 licensing. Never use renderer-supplied identity,
//! time, approval or expiry. See docs/LICENSING_SECURITY.md for residual risks.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// The issuer must set this at release COMPILE TIME; missing key denies access.
/// 32-byte raw Ed25519 public key, not an SPKI/private key.
const VERIFY_KEY: Option<&str> = option_env!("PHARMA_LICENSE_VERIFY_KEY_B64");
const MAX_LEASE_SECONDS: i64 = 86_400; // Legacy online-lease mode only.
const CLOCK_TOLERANCE_SECONDS: i64 = 120;
const MAX_LOCAL_LICENSE_BYTES: usize = 16_384;
const MAX_LOCAL_SEALED_STATE_BYTES: usize = 16_384;

fn read_bounded(path: &Path, maximum: usize, label: &'static str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|_| format!("{label} is missing"))?;
    // Limit the actual read, not merely metadata (which a local process can
    // race). Corrupt user-writable state must not allocate unbounded memory.
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("{label} cannot be read"))?;
    if bytes.len() > maximum {
        return Err(format!("{label} exceeds size limit"));
    }
    Ok(bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LicenseClaims {
    pub license_id: String,
    pub machine_fingerprint: String,
    pub issued_at_utc: i64,
    pub expires_at_utc: i64,
    // Only an explicitly issuer-signed offline_term grants access until
    // expires_at_utc with no periodic lease. A missing legacy lease alone
    // must NEVER enable the offline mode.
    pub lease_until_utc: Option<i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub offline_term: bool,
    pub activation_serial: u64,
    pub revoked: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedEnvelope {
    payload_b64: String,
    signature_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalAnchor {
    license_id: String,
    machine_fingerprint: String,
    highest_seen_utc: i64,
    highest_activation_serial: u64,
    // A revoked receipt at the high-watermark must never be replaced by an
    // earlier same-generation grant, including through manual offline import.
    #[serde(default)]
    revoked_at_highest_serial: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatus {
    pub valid: bool,
    pub reason: String,
    pub machine_fingerprint: String,
    pub license_id: Option<String>,
    pub expires_at_utc: Option<i64>,
    pub lease_until_utc: Option<i64>,
    pub offline_term: bool,
    /// Whether this binary has a reviewed HTTPS activation origin compiled in.
    /// Explicit manual-offline releases do not require Azure on the client.
    pub online_activation_available: bool,
    /// Native database initialization completed during this process lifetime.
    /// A renewed lease can restore access without a restart only in this case.
    pub startup_ready: bool,
    /// An existing customer data profile is deliberately quarantined pending
    /// independent ownership review; a license renewal/restart cannot cure it.
    pub startup_upgrade_blocked: bool,
}

pub struct LicenseGuard {
    directory: PathBuf,
    fingerprint: Result<String, String>,
    lock: Mutex<()>,
    startup_ready: AtomicBool,
    startup_upgrade_blocked: AtomicBool,
}

fn now_seconds() -> Result<i64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System time precedes 1970".to_string())?
        .as_secs() as i64)
}

fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fingerprint_from_marker(marker: &str) -> Result<String, String> {
    let marker = marker.trim();
    if marker.len() < 12 || marker.len() > 256 || marker.contains('\0') {
        return Err("Machine identity is invalid".into());
    }
    Ok(digest_hex(
        format!("PHARMA-MACHINE-V1:{}", marker.to_ascii_lowercase()).as_bytes(),
    ))
}

#[cfg(windows)]
fn windows_machine_guid() -> Result<String, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    // Use trusted advapi32.dll directly. Spawning `reg.exe` could pick up a
    // shadow executable from an attacker-controlled PATH/current directory.
    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "MachineGuid\0".encode_utf16().collect();
    let mut bytes = 0u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut bytes,
        )
    };
    if result != 0 || bytes < 26 || bytes > 514 || bytes % 2 != 0 {
        return Err("Windows MachineGuid unavailable or invalid".into());
    }
    let mut buffer = vec![0u16; (bytes / 2) as usize];
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr() as *mut c_void,
            &mut bytes,
        )
    };
    if result != 0 {
        return Err("Windows MachineGuid could not be read".into());
    }
    let marker = String::from_utf16(buffer.split(|unit| *unit == 0).next().unwrap_or(&[]))
        .map_err(|_| "Windows MachineGuid is not valid UTF-16".to_string())?;
    Ok(marker)
}

/// MachineGuid is an OS installation marker, not cryptographic TPM attestation.
/// Windows DPAPI additionally binds the replay/clock anchor to this Windows user.
/// Neither protects against a machine administrator who can patch the binary.
fn machine_fingerprint() -> Result<String, String> {
    #[cfg(windows)]
    let marker = windows_machine_guid()?;
    #[cfg(target_os = "linux")]
    let marker = fs::read_to_string("/etc/machine-id")
        .map_err(|_| "Linux machine-id unavailable".to_string())?;
    #[cfg(target_os = "macos")]
    let marker = {
        let output = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .map_err(|_| "macOS platform UUID unavailable".to_string())?;
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .find(|line| line.contains("IOPlatformUUID"))
            .and_then(|line| line.split('"').nth(3))
            .map(str::to_owned)
            .ok_or_else(|| "macOS machine UUID unavailable".to_string())?
    };
    #[cfg(windows)]
    if option_env!("PHARMA_LICENSE_DEVICE_MODE") == Some("tpm-v2") {
        // A legacy MachineGuid license can never satisfy this fingerprint;
        // the issuer must authorize a new binding on the hardware tier.
        let marker = marker.trim().to_ascii_lowercase();
        if marker.len() < 12 || marker.len() > 256 || marker.contains('\0') {
            return Err("Machine identity is invalid".into());
        }
        return crate::licensing_tpm::machine_fingerprint(&marker);
    }
    fingerprint_from_marker(&marker)
}

fn public_key() -> Result<Vec<u8>, String> {
    let value =
        VERIFY_KEY.ok_or("License verification public key was not configured at build time")?;
    crate::licensing_config::verification_key(value)
}

fn signed_claims(raw: &str, key: &[u8], fingerprint: &str) -> Result<LicenseClaims, String> {
    if raw.len() > 16_384 {
        return Err("License file is too large".into());
    }
    let envelope: SignedEnvelope =
        serde_json::from_str(raw).map_err(|_| "License format is invalid".to_string())?;
    let payload = URL_SAFE_NO_PAD
        .decode(&envelope.payload_b64)
        .map_err(|_| "License payload encoding is invalid".to_string())?;
    let signature = URL_SAFE_NO_PAD
        .decode(&envelope.signature_b64)
        .map_err(|_| "License signature encoding is invalid".to_string())?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&payload, &signature)
        .map_err(|_| "License signature verification failed".to_string())?;
    let claims: LicenseClaims = serde_json::from_slice(&payload)
        .map_err(|_| "Signed license claims are invalid".to_string())?;
    if claims.license_id.trim().is_empty()
        || claims.license_id.len() > 128
        || claims.machine_fingerprint.len() != 64
        || !claims
            .machine_fingerprint
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || claims.activation_serial == 0
    {
        return Err("Signed license identity or generation is invalid".into());
    }
    if claims.machine_fingerprint != fingerprint {
        return Err("License belongs to another computer".into());
    }
    Ok(claims)
}

fn verify_envelope(
    raw: &str,
    key: &[u8],
    fingerprint: &str,
    now: i64,
) -> Result<LicenseClaims, String> {
    let claims = signed_grant_for_clock_anchor(raw, key, fingerprint, now)?;
    require_unexpired_lease(&claims, now)?;
    Ok(claims)
}

// An authentic, structurally valid grant must advance the protected observed
// clock even when its deadline has passed. This never grants expired access.
fn signed_grant_for_clock_anchor(
    raw: &str,
    key: &[u8],
    fingerprint: &str,
    now: i64,
) -> Result<LicenseClaims, String> {
    let claims = signed_claims(raw, key, fingerprint)?;
    if claims.revoked {
        return Err("License has been revoked".into());
    }
    if claims.issued_at_utc > now.saturating_add(CLOCK_TOLERANCE_SECONDS) {
        return Err(
            "License is not yet valid or computer clock is behind trusted issuance time".into(),
        );
    }
    if claims.expires_at_utc <= claims.issued_at_utc {
        return Err("Signed license expiry interval is inconsistent".into());
    }
    if claims.offline_term {
        // The issuer must expressly sign this distinct mode; a lease-shaped
        // license or a missing lease may never silently become perpetual.
        if claims.lease_until_utc.is_some() {
            return Err("Offline-term license must not contain a lease".into());
        }
    } else {
        let lease = claims.lease_until_utc.ok_or("Signed offline lease is missing")?;
        if lease <= claims.issued_at_utc
            || lease > claims.expires_at_utc
            || lease > claims.issued_at_utc.saturating_add(MAX_LEASE_SECONDS)
        {
            return Err("Signed expiry or offline lease interval is inconsistent".into());
        }
    }
    Ok(claims)
}

fn require_unexpired_lease(claims: &LicenseClaims, now: i64) -> Result<(), String> {
    // Endpoints are exclusive: exactly at expiry the license is not valid.
    if now >= claims.expires_at_utc {
        return Err("License has expired".into());
    }
    if !claims.offline_term {
        if now >= claims.lease_until_utc.ok_or("Signed offline lease is missing")? {
            return Err("Offline lease has expired; reconnect and renew".into());
        }
    }
    Ok(())
}

/// A revocation is signed but deliberately *not* an access grant; storing a
/// higher-generation tombstone makes previously issued leases fail closed.
fn installable_claims(
    raw: &str,
    key: &[u8],
    fingerprint: &str,
    now: i64,
) -> Result<LicenseClaims, String> {
    let claims = signed_claims(raw, key, fingerprint)?;
    if claims.revoked {
        if claims.issued_at_utc > now.saturating_add(CLOCK_TOLERANCE_SECONDS) {
            return Err("Revocation token comes from the future".into());
        }
        Ok(claims)
    } else {
        verify_envelope(raw, key, fingerprint, now)
    }
}

fn require_requested_license(
    claims: &LicenseClaims,
    requested_license_id: Option<&str>,
) -> Result<(), String> {
    if requested_license_id.is_some_and(|requested| claims.license_id != requested) {
        return Err("License authority returned a different license identifier".into());
    }
    Ok(())
}

fn validate_installable_claims(
    raw: &str,
    key: &[u8],
    fingerprint: &str,
    now: i64,
    requested_license_id: Option<&str>,
) -> Result<LicenseClaims, String> {
    let claims = installable_claims(raw, key, fingerprint, now)?;
    require_requested_license(&claims, requested_license_id)?;
    Ok(claims)
}

fn validate_anchor(
    anchor: &LocalAnchor,
    claims: &LicenseClaims,
    fingerprint: &str,
    now: i64,
) -> Result<(), String> {
    if anchor.license_id != claims.license_id || anchor.machine_fingerprint != fingerprint {
        return Err("Activation state belongs to another license/computer".into());
    }
    if claims.activation_serial < anchor.highest_activation_serial {
        return Err("Old activation was replayed; renew with the license authority".into());
    }
    if anchor.revoked_at_highest_serial
        && !claims.revoked
        && claims.activation_serial == anchor.highest_activation_serial
    {
        return Err("Revoked activation was replayed; request a newer signed lease".into());
    }
    if now.saturating_add(CLOCK_TOLERANCE_SECONDS) < anchor.highest_seen_utc {
        return Err("System clock rollback detected; obtain a fresh signed lease".into());
    }
    Ok(())
}

fn reject_installed_tombstone_replay(
    previous: &LicenseClaims,
    candidate: &LicenseClaims,
) -> Result<(), String> {
    if previous.revoked
        && !candidate.revoked
        && previous.license_id == candidate.license_id
        && candidate.activation_serial <= previous.activation_serial
    {
        return Err("Revoked activation was replayed; request a newer signed lease".into());
    }
    Ok(())
}

fn require_fresh_online_activation(
    anchor: &LocalAnchor,
    claims: &LicenseClaims,
    requested_license_id: Option<&str>,
) -> Result<(), String> {
    // Every successful issuer activation/renewal consumes a new nonce and
    // increments the signed serial. The native anchor allows equal serials
    // for offline reinstall/recovery, but ONLINE equality would let a replayed
    // HTTPS response masquerade as fresh issuer approval. Tombstones are not
    // grants and must remain reinstallable to preserve revocation evidence.
    if requested_license_id.is_some()
        && !claims.revoked
        && claims.activation_serial <= anchor.highest_activation_serial
    {
        return Err(
            "License authority replayed a previously installed activation; request a fresh signed lease"
                .into(),
        );
    }
    Ok(())
}

fn missing_anchor_is_first_activation(
    anchor_exists: bool,
    signed_license_exists: bool,
) -> Result<(), String> {
    if anchor_exists || signed_license_exists {
        return Err("Protected activation state is missing or corrupt; previously installed license requires authorized recovery".into());
    }
    Ok(())
}

fn ensure_machine_has_not_changed(
    bound_fingerprint: &str,
    current_fingerprint: &str,
) -> Result<(), String> {
    if bound_fingerprint != current_fingerprint {
        return Err("Machine identity changed during this session; restart and request authorized license reassignment".into());
    }
    Ok(())
}

#[cfg(windows)]
fn protect_local_state(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let size =
        u32::try_from(bytes.len()).map_err(|_| "Protected activation input exceeds size limit")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: size,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let result = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if result == 0 {
        return Err("Windows DPAPI activation state is missing or cannot be opened".into());
    }
    let result_bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(result_bytes)
}

#[cfg(not(windows))]
fn protect_local_state(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err(
        "Secure licensing state storage is not implemented on this OS; license access denied"
            .into(),
    )
}

fn save_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid license storage path")?;
    fs::create_dir_all(dir).map_err(|_| "Cannot create license storage directory")?;
    let tmp = dir.join(format!(".license-{}.tmp", uuid::Uuid::new_v4()));
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|_| "Cannot create isolated temporary license state")?;
    file.write_all(bytes)
        .map_err(|_| "Cannot save temporary license state")?;
    file.sync_all()
        .map_err(|_| "Cannot flush temporary license state")?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let old: Vec<u16> = tmp.as_os_str().encode_wide().chain([0]).collect();
        let new: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        // Do not delete the previous state first: that introduced a gap where
        // interrupted renewal could leave the license/anchor missing. Windows
        // replace-in-place is atomic on the same local filesystem.
        if unsafe {
            MoveFileExW(
                old.as_ptr(),
                new.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            let _ = fs::remove_file(&tmp);
            return Err("Cannot atomically replace license state".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(&tmp, path).map_err(|_| "Cannot persist license state".to_string())
    }
}

impl LicenseGuard {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            fingerprint: machine_fingerprint(),
            lock: Mutex::new(()),
            startup_ready: AtomicBool::new(false),
            startup_upgrade_blocked: AtomicBool::new(false),
        }
    }
    fn license_path(&self) -> PathBuf {
        self.directory.join("signed-license.json")
    }
    fn anchor_path(&self) -> PathBuf {
        self.directory.join("license-clock.dpapi")
    }

    #[cfg(windows)]
    fn lock_state_across_processes(&self) -> Result<fs::File, String> {
        use std::os::windows::fs::OpenOptionsExt;

        // The per-guard Mutex only serializes threads in this process. Two
        // running desktop instances can otherwise both validate generation N,
        // then install N+1 (revocation) and finally overwrite it with N
        // (replayed grant). Windows denies *every* other opener while this
        // handle is live; the persistent file is not a stale lock after a
        // crash because NT releases the exclusive share reservation on close.
        fs::create_dir_all(&self.directory)
            .map_err(|_| "Cannot create protected licensing directory")?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .open(self.directory.join("license-state.lock"))
            .map_err(|_| {
                "Another application instance is updating license state; retry".to_string()
            })
    }

    #[cfg(not(windows))]
    fn lock_state_across_processes(&self) -> Result<(), String> {
        // Non-Windows licensing already denies access without secure local
        // state protection. Do not imply this portable stub is a file lock.
        Ok(())
    }

    pub(crate) fn credential_path(&self) -> PathBuf {
        self.directory.join("license-renewal.dpapi")
    }
    pub(crate) fn current_fingerprint(&self) -> Result<String, String> {
        Ok(self.live_fingerprint()?.to_owned())
    }
    pub(crate) fn store_online_credential(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_LOCAL_SEALED_STATE_BYTES / 2 {
            return Err("Online renewal credential exceeds size limit".into());
        }
        save_atomic(&self.credential_path(), &protect_local_state(bytes, false)?)
    }
    pub(crate) fn load_online_credential(&self) -> Result<Vec<u8>, String> {
        let sealed = read_bounded(
            &self.credential_path(),
            MAX_LOCAL_SEALED_STATE_BYTES,
            "Online renewal credential",
        )?;
        protect_local_state(&sealed, true)
    }

    fn live_fingerprint(&self) -> Result<&str, String> {
        let fingerprint = self.fingerprint.as_ref().map_err(Clone::clone)?;
        // Native RegGetValueW is inexpensive; recheck on EACH guarded IPC,
        // startup/status poll and installation instead of trusting the cached
        // startup identity after the registry/hardware marker changes.
        ensure_machine_has_not_changed(fingerprint, &machine_fingerprint()?)?;
        Ok(fingerprint)
    }

    fn read_anchor(&self) -> Result<LocalAnchor, String> {
        let data = read_bounded(
            &self.anchor_path(),
            MAX_LOCAL_SEALED_STATE_BYTES,
            "Protected activation state",
        )?;
        let clear = protect_local_state(&data, true)?;
        serde_json::from_slice(&clear).map_err(|_| "Protected activation state is corrupt".into())
    }
    fn save_anchor(&self, anchor: &LocalAnchor) -> Result<(), String> {
        let bytes = serde_json::to_vec(anchor).map_err(|_| "Invalid activation state")?;
        save_atomic(&self.anchor_path(), &protect_local_state(&bytes, false)?)
    }
    fn verify_at(&self, now: i64, update_clock: bool) -> Result<LicenseClaims, String> {
        let fingerprint = self.live_fingerprint()?;
        let key = public_key()?;
        let raw = String::from_utf8(read_bounded(
            &self.license_path(),
            MAX_LOCAL_LICENSE_BYTES,
            "Signed license",
        )?)
        .map_err(|_| "Signed license is not UTF-8".to_string())?;
        let claims = signed_grant_for_clock_anchor(&raw, &key, fingerprint, now)?;
        let mut anchor = self.read_anchor()?;
        validate_anchor(&anchor, &claims, fingerprint, now)?;
        if update_clock
            && (now > anchor.highest_seen_utc
                || claims.activation_serial > anchor.highest_activation_serial)
        {
            if claims.activation_serial > anchor.highest_activation_serial {
                // A newer, verified active serial supersedes an earlier
                // tombstone even if its file was imported outside this API.
                anchor.revoked_at_highest_serial = false;
            }
            anchor.highest_seen_utc = anchor.highest_seen_utc.max(now);
            anchor.highest_activation_serial = anchor
                .highest_activation_serial
                .max(claims.activation_serial);
            self.save_anchor(&anchor)?;
        }
        // Deny expired grants only AFTER the new observed time is durable.
        // Otherwise a clock that was observed past expiry can be rewound into
        // the still-signed offline window to restore access.
        require_unexpired_lease(&claims, now)?;
        Ok(claims)
    }
    pub fn check_license(&self) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "License gate unavailable".to_string())?;
        let _process_guard = self.lock_state_across_processes()?;
        self.verify_at(now_seconds()?, true).map(|_| ())
    }
    pub fn mark_startup_complete(&self) {
        self.startup_upgrade_blocked.store(false, Ordering::Release);
        self.startup_ready.store(true, Ordering::Release);
    }
    pub fn mark_legacy_upgrade_blocked(&self) {
        // This is informational status only; no release of financial IPC.
        self.startup_upgrade_blocked.store(true, Ordering::Release);
    }
    /// A just-installed license cannot unlock database IPC before a fresh,
    /// fully migrated startup. The activation screen asks for a restart.
    pub fn enforce(&self) -> Result<(), String> {
        if !self.startup_ready.load(Ordering::Acquire) {
            return Err(
                "Restart the application after activation before accessing pharmacy data".into(),
            );
        }
        self.check_license()
    }
    pub fn status(&self) -> LicenseStatus {
        // Never show a cached/stale binding after hardware identity becomes
        // unavailable: support must not issue a renewal for an unusable key.
        let machine = machine_fingerprint().unwrap_or_default();
        let startup_ready = self.startup_ready.load(Ordering::Acquire);
        let startup_upgrade_blocked = self.startup_upgrade_blocked.load(Ordering::Acquire);
        let online_activation_available = option_env!("PHARMA_LICENSE_AUTHORITY_URL")
            .is_some_and(|url| url.starts_with("https://") && !url.is_empty())
            && option_env!("PHARMA_LICENSE_OFFLINE_ONLY") != Some("1");
        let result = self
            .lock
            .lock()
            .map_err(|_| "License gate unavailable".to_string())
            .and_then(|_guard| {
                let _process_guard = self.lock_state_across_processes()?;
                self.verify_at(now_seconds()?, true)
            });
        match result {
            Ok(c) => LicenseStatus {
                valid: true,
                reason: "Licensed".into(),
                machine_fingerprint: machine,
                license_id: Some(c.license_id),
                expires_at_utc: Some(c.expires_at_utc),
                lease_until_utc: c.lease_until_utc,
                offline_term: c.offline_term,
                online_activation_available,
                startup_ready,
                startup_upgrade_blocked,
            },
            Err(error) => LicenseStatus {
                valid: false,
                reason: error,
                machine_fingerprint: machine,
                license_id: None,
                expires_at_utc: None,
                lease_until_utc: None,
                offline_term: false,
                online_activation_available,
                startup_ready,
                startup_upgrade_blocked,
            },
        }
    }
    pub fn install(&self, raw: &str) -> Result<(), String> {
        self.install_with_expected_license(raw, None)
    }

    /// Online issuance must bind the returned signed license ID to the
    /// credential that authorized the request, before writing either file.
    pub(crate) fn install_online(
        &self,
        raw: &str,
        expected_license_id: &str,
    ) -> Result<(), String> {
        self.install_with_expected_license(raw, Some(expected_license_id))
    }

    fn install_with_expected_license(
        &self,
        raw: &str,
        requested_license_id: Option<&str>,
    ) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "License gate unavailable".to_string())?;
        let _process_guard = self.lock_state_across_processes()?;
        let now = now_seconds()?;
        let fingerprint = self.live_fingerprint()?;
        // Signed tombstones (revoked=true) must be persisted even though they
        // cannot grant access. Otherwise the previously valid offline lease
        // would remain usable after the app receives a revocation response.
        let key = public_key()?;
        let claims =
            validate_installable_claims(raw, &key, fingerprint, now, requested_license_id)?;
        // Existing DPAPI anchors from earlier releases did not encode their
        // revoked bit. A still-installed authentic tombstone must be honored
        // during an upgrade, even when that old anchor lacks the new field.
        if let Ok(previous_raw) = read_bounded(
            &self.license_path(),
            MAX_LOCAL_LICENSE_BYTES,
            "Signed license",
        ) {
            if let Ok(previous_text) = std::str::from_utf8(&previous_raw) {
                if let Ok(previous) = signed_claims(previous_text, &key, fingerprint) {
                    reject_installed_tombstone_replay(&previous, &claims)?;
                }
            }
        }
        let old_anchor = self.read_anchor().ok();
        if let Some(ref old) = old_anchor {
            validate_anchor(old, &claims, fingerprint, now)?;
            require_fresh_online_activation(old, &claims, requested_license_id)?;
        } else {
            // Never interpret deletion/corruption of the DPAPI high-watermark
            // as a first activation while a signed grant/tombstone is still
            // present: that would undo clock-rollback and revocation defense.
            missing_anchor_is_first_activation(
                self.anchor_path().exists(),
                self.license_path().exists(),
            )?;
        }
        let anchor = LocalAnchor {
            license_id: claims.license_id,
            machine_fingerprint: fingerprint.to_string(),
            highest_seen_utc: old_anchor
                .as_ref()
                .map(|old| old.highest_seen_utc.max(now))
                .unwrap_or(now),
            highest_activation_serial: claims.activation_serial,
            revoked_at_highest_serial: claims.revoked,
        };
        // If the process crashes mid-replacement, it fails closed until a valid renewal.
        self.save_anchor(&anchor)?;
        save_atomic(&self.license_path(), raw.as_bytes())
    }
}

#[tauri::command]
pub fn license_status(state: tauri::State<'_, LicenseGuard>) -> LicenseStatus {
    state.status()
}

#[tauri::command]
pub fn license_install(
    state: tauri::State<'_, LicenseGuard>,
    signed_license: String,
) -> Result<LicenseStatus, String> {
    state.install(&signed_license)?;
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    fn fixture() -> (Ed25519KeyPair, String) {
        let pair = Ed25519KeyPair::from_seed_unchecked(&[31u8; 32]).unwrap();
        (pair, "a".repeat(64))
    }
    #[test]
    fn machine_marker_normalization_is_stable_without_external_executable() {
        let a = fingerprint_from_marker(" 00112233-4455-6677-8899-AABBCCDDEEFF ").unwrap();
        let b = fingerprint_from_marker("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(fingerprint_from_marker("spoof").is_err());
        assert!(fingerprint_from_marker("a\0hidden machine").is_err());
        assert!(ensure_machine_has_not_changed(&a, &b).is_ok());
        assert!(ensure_machine_has_not_changed(&a, &"0".repeat(64)).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn state_replacement_keeps_exactly_one_complete_file() {
        let root = std::env::temp_dir().join(format!("pharma-qa-state-{}", uuid::Uuid::new_v4()));
        let file = root.join("sealed-anchor.dpapi");
        save_atomic(&file, b"first signed anchor").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"first signed anchor");
        save_atomic(&file, b"newer signed anchor").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"newer signed anchor");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn independent_license_guards_exclusively_lock_local_state_until_release() {
        let root =
            std::env::temp_dir().join(format!("pharma-qa-license-lock-{}", uuid::Uuid::new_v4()));
        let a = LicenseGuard::new(root.clone());
        let b = LicenseGuard::new(root.clone());
        let first = a.lock_state_across_processes().unwrap();
        let blocked = b.lock_state_across_processes();
        assert!(
            blocked.is_err(),
            "a second guard must not concurrently load/write stale anchors"
        );
        assert!(blocked
            .err()
            .unwrap()
            .contains("Another application instance"));
        drop(first);
        let second = b.lock_state_across_processes().unwrap();
        assert!(a.lock_state_across_processes().is_err());
        drop(second);
        assert!(a.lock_state_across_processes().is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    // The v1 MachineGuid-only identity is intentionally disabled in TPM-v2
    // production profile; do not assert v1 parity in release builds.
    #[cfg(all(windows, not(pharma_security_release)))]
    #[test]
    fn win32_registry_identity_resolves_without_executable_lookup() {
        let marker =
            windows_machine_guid().expect("Windows MachineGuid must be present on this host");
        let fingerprint = machine_fingerprint().unwrap();
        assert_eq!(fingerprint, fingerprint_from_marker(&marker).unwrap());
        assert_eq!(fingerprint.len(), 64);
    }
    fn claims(machine: &str) -> LicenseClaims {
        LicenseClaims {
            license_id: "license-1".into(),
            machine_fingerprint: machine.into(),
            issued_at_utc: 1000,
            expires_at_utc: 4000,
            lease_until_utc: Some(3000),
            offline_term: false,
            activation_serial: 2,
            revoked: false,
        }
    }
    fn envelope(pair: &Ed25519KeyPair, c: &LicenseClaims) -> String {
        let payload = serde_json::to_vec(c).unwrap();
        serde_json::to_string(&SignedEnvelope {
            payload_b64: URL_SAFE_NO_PAD.encode(&payload),
            signature_b64: URL_SAFE_NO_PAD.encode(pair.sign(&payload).as_ref()),
        })
        .unwrap()
    }
    #[test]
    fn valid_license_machine_copy_and_precise_expiry() {
        let (pair, machine) = fixture();
        let text = envelope(&pair, &claims(&machine));
        let key = pair.public_key().as_ref();
        assert!(verify_envelope(&text, key, &machine, 2999).is_ok());
        assert!(verify_envelope(&text, key, &machine, 3000)
            .unwrap_err()
            .contains("Offline lease"));
        assert!(verify_envelope(&text, key, &"b".repeat(64), 2000)
            .unwrap_err()
            .contains("another computer"));
    }
    #[test]
    fn explicitly_signed_offline_term_works_without_lease_until_real_expiry() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let mut offline = claims(&machine);
        offline.offline_term = true;
        offline.lease_until_utc = None;
        let signed = envelope(&pair, &offline);
        // A term lasting well beyond the 24-hour lease window still permits
        // offline use when and only when the issuer signed offline_term=true.
        assert!(verify_envelope(&signed, key, &machine, 3999).is_ok());
        assert!(verify_envelope(&signed, key, &machine, 4000)
            .unwrap_err().contains("expired"));
        assert!(verify_envelope(&signed, key, &"b".repeat(64), 3900).is_err());
        let mut anchored = LocalAnchor {
            license_id: offline.license_id.clone(),
            machine_fingerprint: machine.clone(),
            highest_seen_utc: 3900,
            highest_activation_serial: offline.activation_serial,
            revoked_at_highest_serial: false,
        };
        assert!(validate_anchor(&anchored, &offline, &machine, 3999).is_ok());
        anchored.highest_seen_utc = 4150;
        assert!(validate_anchor(&anchored, &offline, &machine, 3900)
            .unwrap_err().contains("rollback"));
    }
    #[test]
    fn offline_term_requires_explicit_signed_mode_and_rejects_lease_smuggling() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let mut candidate = claims(&machine);
        candidate.lease_until_utc = None;
        assert!(verify_envelope(&envelope(&pair, &candidate), key, &machine, 2000)
            .unwrap_err().contains("missing"));

        candidate.offline_term = true;
        candidate.lease_until_utc = Some(3900);
        assert!(verify_envelope(&envelope(&pair, &candidate), key, &machine, 2000)
            .unwrap_err().contains("must not contain"));

        candidate.lease_until_utc = None;
        let signed = envelope(&pair, &candidate);
        let mut modified: SignedEnvelope = serde_json::from_str(&signed).unwrap();
        let mut claims: serde_json::Value = serde_json::to_value(candidate).unwrap();
        claims["expires_at_utc"] = serde_json::json!(90000000);
        modified.payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        assert!(verify_envelope(&serde_json::to_string(&modified).unwrap(), key, &machine, 2000)
            .unwrap_err().contains("signature"));

        claims["offline_term"] = serde_json::json!("true");
        let bytes = serde_json::to_vec(&claims).unwrap();
        modified.payload_b64 = URL_SAFE_NO_PAD.encode(&bytes);
        modified.signature_b64 = URL_SAFE_NO_PAD.encode(pair.sign(&bytes).as_ref());
        assert!(verify_envelope(&serde_json::to_string(&modified).unwrap(), key, &machine, 2000)
            .is_err());
    }
    #[test]
    fn invalid_signature_editing_and_invalid_lease_denied() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let text = envelope(&pair, &claims(&machine));
        let mut decoded: SignedEnvelope = serde_json::from_str(&text).unwrap();
        let mut edited = claims(&machine);
        edited.expires_at_utc += 500000;
        decoded.payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&edited).unwrap());
        assert!(verify_envelope(
            &serde_json::to_string(&decoded).unwrap(),
            key,
            &machine,
            2000
        )
        .is_err());
        let mut future = claims(&machine);
        future.issued_at_utc = 2500;
        assert!(verify_envelope(&envelope(&pair, &future), key, &machine, 2000).is_err());
        let mut bad = claims(&machine);
        bad.lease_until_utc = Some(200000);
        assert!(verify_envelope(&envelope(&pair, &bad), key, &machine, 2000).is_err());
        let mut revoked = claims(&machine);
        revoked.revoked = true;
        assert!(
            verify_envelope(&envelope(&pair, &revoked), key, &machine, 2000)
                .unwrap_err()
                .contains("revoked")
        );
    }
    #[test]
    fn altered_envelope_and_unknown_signed_claims_never_fail_open() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let valid = envelope(&pair, &claims(&machine));
        let mut signed: SignedEnvelope = serde_json::from_str(&valid).unwrap();
        let original = signed.signature_b64.clone();
        signed.signature_b64 = "not-a-valid-signature".into();
        assert!(verify_envelope(
            &serde_json::to_string(&signed).unwrap(),
            key,
            &machine,
            2000
        )
        .is_err());
        signed.signature_b64 = original;
        // Even a legitimately signed payload may not introduce unknown
        // authorization fields without a schema version and deliberate parser.
        let mut json_value = serde_json::to_value(claims(&machine)).unwrap();
        json_value["allow_unlicensed"] = serde_json::json!(true);
        let payload = serde_json::to_vec(&json_value).unwrap();
        signed.payload_b64 = URL_SAFE_NO_PAD.encode(&payload);
        signed.signature_b64 = URL_SAFE_NO_PAD.encode(pair.sign(&payload).as_ref());
        assert!(verify_envelope(
            &serde_json::to_string(&signed).unwrap(),
            key,
            &machine,
            2000
        )
        .is_err());
        let mut bad = valid.into_bytes();
        for index in (1..bad.len()).step_by(31) {
            bad[index] ^= 0x1f;
            let candidate = String::from_utf8_lossy(&bad);
            assert!(verify_envelope(&candidate, key, &machine, 2000).is_err());
            bad[index] ^= 0x1f;
        }
        assert!(verify_envelope(&"X".repeat(20_000), key, &machine, 2000).is_err());
    }

    #[test]
    fn expiration_boundary_is_exclusive_and_timezone_independent() {
        let (pair, machine) = fixture();
        let mut expiring = claims(&machine);
        expiring.expires_at_utc = 2800;
        expiring.lease_until_utc = Some(2800);
        let signed = envelope(&pair, &expiring);
        assert!(verify_envelope(&signed, pair.public_key().as_ref(), &machine, 2799).is_ok());
        assert!(
            verify_envelope(&signed, pair.public_key().as_ref(), &machine, 2800)
                .unwrap_err()
                .contains("expired")
        );
    }
    #[test]
    fn daylight_saving_transitions_are_utc_seconds_not_local_wall_labels() {
        let (pair, machine) = fixture();
        // Europe/Paris spring: 01:59:59 CET -> 03:00:00 CEST, one second.
        // Fall: 02:59:59 CEST -> 02:00:00 CET, also one second.
        for (one_second_before, deadline) in [
            (1_774_745_999, 1_774_746_000),
            (1_792_889_999, 1_792_890_000),
        ] {
            assert_eq!(deadline - one_second_before, 1);
            let c = LicenseClaims {
                license_id: "qa-dst".into(),
                machine_fingerprint: machine.clone(),
                issued_at_utc: one_second_before - 600,
                expires_at_utc: deadline,
                lease_until_utc: Some(deadline),
                offline_term: false,
                activation_serial: 1,
                revoked: false,
            };
            let signed = envelope(&pair, &c);
            assert!(verify_envelope(
                &signed,
                pair.public_key().as_ref(),
                &machine,
                one_second_before
            )
            .is_ok());
            assert!(
                verify_envelope(&signed, pair.public_key().as_ref(), &machine, deadline).is_err()
            );
        }
    }
    #[test]
    fn protected_anchor_blocks_serial_replay_and_clock_rollback() {
        let (_, machine) = fixture();
        let anchor = LocalAnchor {
            license_id: "license-1".into(),
            machine_fingerprint: machine.clone(),
            highest_seen_utc: 2400,
            highest_activation_serial: 5,
            revoked_at_highest_serial: false,
        };
        let mut c = claims(&machine);
        assert!(validate_anchor(&anchor, &c, &machine, 2400)
            .unwrap_err()
            .contains("replayed"));
        c.activation_serial = 5;
        assert!(validate_anchor(&anchor, &c, &machine, 2279)
            .unwrap_err()
            .contains("rollback"));
        assert!(validate_anchor(&anchor, &c, &"b".repeat(64), 2400)
            .unwrap_err()
            .contains("another license"));
        assert!(validate_anchor(&anchor, &c, &machine, 2280).is_ok()); // 120s drift tolerance
    }
    #[test]
    fn expired_authenticated_lease_must_ratchet_clock_before_rollback() {
        let (pair, machine) = fixture();
        let grant = claims(&machine); // Issued at 1000, signed offline lease ends at 3000.
        let signed = envelope(&pair, &grant);
        let key = pair.public_key().as_ref();
        let mut anchor = LocalAnchor {
            license_id: grant.license_id.clone(),
            machine_fingerprint: machine.clone(),
            highest_seen_utc: 2800,
            highest_activation_serial: grant.activation_serial,
            revoked_at_highest_serial: false,
        };
        assert!(validate_anchor(&anchor, &grant, &machine, 2900).is_ok());
        // The signature and interval are genuine, but on first seeing 3100
        // the lease has expired. The signed claims must still reach the anchor
        // before access is denied, or setting the clock back to 2900 unlocks it.
        assert!(verify_envelope(&signed, key, &machine, 3100)
            .unwrap_err()
            .contains("Offline lease"));
        let authenticated = signed_grant_for_clock_anchor(&signed, key, &machine, 3100)
            .expect("expired authentic lease still needs a protected clock record");
        validate_anchor(&anchor, &authenticated, &machine, 3100).unwrap();
        anchor.highest_seen_utc = anchor.highest_seen_utc.max(3100);
        assert!(validate_anchor(&anchor, &authenticated, &machine, 2900)
            .unwrap_err()
            .contains("rollback"));
        // Only genuine, well-formed active grants may influence secure time.
        let mut revoked = grant.clone();
        revoked.revoked = true;
        assert!(
            signed_grant_for_clock_anchor(&envelope(&pair, &revoked), key, &machine, 3100).is_err()
        );
        let mut bad_interval = grant.clone();
        bad_interval.lease_until_utc = Some(bad_interval.expires_at_utc + 1);
        assert!(signed_grant_for_clock_anchor(
            &envelope(&pair, &bad_interval),
            key,
            &machine,
            3100
        )
        .is_err());
    }
    #[test]
    fn online_lease_requires_signed_requested_license_id_before_installation() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let lease = envelope(&pair, &claims(&machine));
        assert!(validate_installable_claims(&lease, key, &machine, 2000, None).is_ok());
        assert!(
            validate_installable_claims(&lease, key, &machine, 2000, Some("license-1")).is_ok()
        );
        let mismatch = validate_installable_claims(&lease, key, &machine, 2000, Some("license-2"));
        assert!(mismatch
            .unwrap_err()
            .contains("different license identifier"));

        // Even a correctly signed tombstone must belong to the requested
        // license before replacing the persisted license and replay anchor.
        let mut revoked = claims(&machine);
        revoked.revoked = true;
        revoked.activation_serial = 3;
        let tombstone = envelope(&pair, &revoked);
        assert!(
            validate_installable_claims(&tombstone, key, &machine, 2000, Some("license-2"))
                .is_err()
        );
        assert!(
            validate_installable_claims(&tombstone, key, &machine, 2000, Some("license-1"))
                .unwrap()
                .revoked
        );
    }
    #[test]
    fn signed_same_serial_active_replay_is_not_fresh_online_renewal() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let anchor = LocalAnchor {
            license_id: "license-1".into(),
            machine_fingerprint: machine.clone(),
            highest_seen_utc: 2000,
            highest_activation_serial: 5,
            revoked_at_highest_serial: false,
        };
        let mut grant = claims(&machine);
        grant.activation_serial = 5;
        let previously_installed = envelope(&pair, &grant);
        let replayed = validate_installable_claims(
            &previously_installed,
            key,
            &machine,
            2000,
            Some("license-1"),
        )
        .unwrap();
        // A genuine signature, exact license ID, valid current lease and
        // matching anchor previously sufficed to claim an online renewal.
        assert!(validate_anchor(&anchor, &replayed, &machine, 2000).is_ok());
        assert!(
            require_fresh_online_activation(&anchor, &replayed, Some("license-1"))
                .unwrap_err()
                .contains("replayed")
        );
        // The existing manual/offline reimport path is intentionally allowed
        // to reinstall an authentic identical-generation lease.
        assert!(require_fresh_online_activation(&anchor, &replayed, None).is_ok());

        // A real new issuer response advances the protected high watermark.
        grant.activation_serial = 6;
        let renewed = validate_installable_claims(
            &envelope(&pair, &grant),
            key,
            &machine,
            2000,
            Some("license-1"),
        )
        .unwrap();
        assert!(validate_anchor(&anchor, &renewed, &machine, 2000).is_ok());
        assert!(require_fresh_online_activation(&anchor, &renewed, Some("license-1")).is_ok());

        // Higher or equal signed revocations are still installable tombstones
        // (never access grants), even if an issuer repeats the same receipt.
        grant.revoked = true;
        grant.activation_serial = 5;
        let tombstone = envelope(&pair, &grant);
        let revoked =
            validate_installable_claims(&tombstone, key, &machine, 2000, Some("license-1"))
                .unwrap();
        assert!(revoked.revoked);
        assert!(require_fresh_online_activation(&anchor, &revoked, Some("license-1")).is_ok());
        assert!(verify_envelope(&tombstone, key, &machine, 2000).is_err());

        // A legitimately signed grant for another license never reaches the
        // serial-replay decision under the credential-requested identity.
        grant.revoked = false;
        grant.license_id = "license-2".into();
        assert!(validate_installable_claims(
            &envelope(&pair, &grant),
            key,
            &machine,
            2000,
            Some("license-1")
        )
        .is_err());
    }
    #[test]
    fn signed_revocation_tombstone_can_be_received_but_never_activates() {
        let (pair, machine) = fixture();
        let mut c = claims(&machine);
        c.revoked = true;
        c.activation_serial = 6;
        let tombstone = envelope(&pair, &c);
        let key = pair.public_key().as_ref();
        assert!(
            installable_claims(&tombstone, key, &machine, 2000)
                .unwrap()
                .revoked
        );
        assert!(verify_envelope(&tombstone, key, &machine, 2000).is_err());
        c.issued_at_utc = 5000;
        assert!(installable_claims(&envelope(&pair, &c), key, &machine, 2000).is_err());
        let mut anchor = LocalAnchor {
            license_id: "license-1".into(),
            machine_fingerprint: machine.clone(),
            highest_seen_utc: 2000,
            highest_activation_serial: 6,
            revoked_at_highest_serial: true,
        };
        c.revoked = false;
        c.activation_serial = 5;
        assert!(validate_anchor(&anchor, &c, &machine, 2000).is_err());
        anchor.highest_activation_serial = 7;
        assert!(validate_anchor(&anchor, &c, &machine, 2000).is_err());
    }
    #[test]
    fn signed_same_generation_grant_cannot_undo_persisted_revocation() {
        let (pair, machine) = fixture();
        let key = pair.public_key().as_ref();
        let mut grant = claims(&machine);
        grant.activation_serial = 6;
        let original_grant = envelope(&pair, &grant);
        let mut tombstone = grant.clone();
        tombstone.revoked = true;
        let signed_tombstone = envelope(&pair, &tombstone);

        // Both receipts are issuer-signed and machine-bound. A same-serial
        // tombstone is accepted and must make the older grant unusable.
        assert!(
            validate_installable_claims(&signed_tombstone, key, &machine, 2000, None)
                .unwrap()
                .revoked
        );
        let sealed_after_revocation = serde_json::to_vec(&LocalAnchor {
            license_id: grant.license_id.clone(),
            machine_fingerprint: machine.clone(),
            highest_seen_utc: 2000,
            highest_activation_serial: 6,
            revoked_at_highest_serial: true,
        })
        .unwrap();
        let persisted: LocalAnchor = serde_json::from_slice(&sealed_after_revocation).unwrap();
        let replay =
            validate_installable_claims(&original_grant, key, &machine, 2000, None).unwrap();
        assert!(validate_anchor(&persisted, &replay, &machine, 2000)
            .unwrap_err()
            .contains("Revoked activation was replayed"));
        let installed_revocation = signed_claims(&signed_tombstone, key, &machine).unwrap();
        assert!(reject_installed_tombstone_replay(&installed_revocation, &replay).is_err());
        assert!(validate_anchor(&persisted, &tombstone, &machine, 2000).is_ok());

        // The authority can legitimately restore access by issuing a newer
        // signed serial; the revocation marker does not block that renewal.
        grant.activation_serial = 7;
        assert!(validate_anchor(&persisted, &grant, &machine, 2000).is_ok());
        assert!(reject_installed_tombstone_replay(&installed_revocation, &grant).is_ok());

        // Anchors written before this extra field remain readable during an
        // upgrade. Subsequent tombstones are persisted with the new marker.
        let legacy = serde_json::json!({
            "license_id":"license-1", "machine_fingerprint":machine,
            "highest_seen_utc":2000,"highest_activation_serial":5
        });
        let parsed: LocalAnchor = serde_json::from_value(legacy).unwrap();
        assert!(!parsed.revoked_at_highest_serial);
        // With a pre-upgrade anchor the still-installed signed tombstone
        // separately rejects replay until a newer generation is issued.
        assert!(reject_installed_tombstone_replay(&installed_revocation, &replay).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_dpapi_state_survives_restart_and_rejects_tamper() {
        let bytes = b"private local activation anchor";
        let sealed = protect_local_state(bytes, false).unwrap();
        assert_ne!(sealed.as_slice(), bytes);
        assert_eq!(protect_local_state(&sealed, true).unwrap(), bytes);
        let mut invalid = sealed;
        let last = invalid.len() - 1;
        invalid[last] ^= 0x40;
        assert!(protect_local_state(&invalid, true).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn online_renewal_secret_is_dpapi_sealed_and_corruption_fails_closed() {
        let folder =
            std::env::temp_dir().join(format!("pharma-renewal-test-{}", uuid::Uuid::new_v4()));
        let guard = LicenseGuard::new(folder.clone());
        let code = b"synthetic-private-activation-code-not-for-customers";
        guard.store_online_credential(code).unwrap();
        let encrypted = fs::read(guard.credential_path()).unwrap();
        assert!(!encrypted.windows(code.len()).any(|part| part == code));
        assert_eq!(guard.load_online_credential().unwrap(), code);
        let mut corrupt = encrypted;
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0x80;
        fs::write(guard.credential_path(), corrupt).unwrap();
        assert!(guard.load_online_credential().is_err());
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn newly_installed_license_cannot_bypass_required_restart() {
        let temporary =
            std::env::temp_dir().join(format!("pharma-license-test-{}", uuid::Uuid::new_v4()));
        let guard = LicenseGuard::new(temporary);
        assert!(!guard.status().startup_ready);
        assert!(!guard.status().startup_upgrade_blocked);
        guard.mark_legacy_upgrade_blocked();
        assert!(guard.status().startup_upgrade_blocked);
        assert!(guard.enforce().is_err());
        assert!(guard.enforce().unwrap_err().contains("Restart"));
        // Merely marking startup ready does not bypass signature/file checks.
        guard.mark_startup_complete();
        assert!(!guard.status().startup_upgrade_blocked);
        // A previously initialized process may later renew an expired lease
        // without rerunning migrations, even while its current status is denied.
        assert!(guard.status().startup_ready);
        assert!(guard.enforce().is_err());
    }
    #[test]
    fn deleting_only_protected_clock_anchor_does_not_reset_revocation_or_time() {
        assert!(missing_anchor_is_first_activation(false, true).is_err());
        assert!(missing_anchor_is_first_activation(true, false).is_err());
        assert!(missing_anchor_is_first_activation(true, true).is_err());
        assert!(missing_anchor_is_first_activation(false, false).is_ok());
    }
    #[test]
    fn oversized_user_writable_license_state_fails_closed_without_unbounded_reads() {
        let dir =
            std::env::temp_dir().join(format!("pharma-oversize-state-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("signed-license.json");
        fs::write(&file, vec![b'x'; MAX_LOCAL_LICENSE_BYTES + 1]).unwrap();
        assert!(
            read_bounded(&file, MAX_LOCAL_LICENSE_BYTES, "Signed license")
                .unwrap_err()
                .contains("size limit")
        );
        fs::write(&file, vec![b'x'; MAX_LOCAL_LICENSE_BYTES]).unwrap();
        assert_eq!(
            read_bounded(&file, MAX_LOCAL_LICENSE_BYTES, "Signed license")
                .unwrap()
                .len(),
            MAX_LOCAL_LICENSE_BYTES
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
