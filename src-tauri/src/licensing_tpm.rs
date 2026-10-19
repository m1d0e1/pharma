//! Windows TPM-backed installation identity. This is deliberately a
//! separate, opt-in *v2* identity: never silently reinterpret old v1 grants.
//! The RSA private key lives in Microsoft's Platform Crypto Provider and is
//! never exported. This is key possession, NOT TPM attestation/certification
//! to a remote issuer; VM vTPMs and administrator-level binary patching remain
//! outside the guarantees of this offline design.
#![cfg(windows)]

use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    ptr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use windows_sys::Win32::Security::Cryptography::{
    NCryptCreatePersistedKey, NCryptExportKey, NCryptFinalizeKey, NCryptFreeObject,
    NCryptGetProperty, NCryptOpenKey, NCryptOpenStorageProvider, NCryptSignHash,
    NCryptVerifySignature, BCRYPT_PKCS1_PADDING_INFO, BCRYPT_RSAPUBLIC_BLOB,
    BCRYPT_RSAPUBLIC_MAGIC, BCRYPT_SHA256_ALGORITHM, MS_PLATFORM_CRYPTO_PROVIDER,
    NCRYPT_IMPL_HARDWARE_FLAG, NCRYPT_IMPL_TYPE_PROPERTY, NCRYPT_KEY_HANDLE, NCRYPT_PAD_PKCS1_FLAG,
    NCRYPT_PROV_HANDLE, NCRYPT_RSA_ALGORITHM, NCRYPT_SILENT_FLAG,
};

// Scoped to the Windows user account; administrator-authorized license moves
// are required when Windows is reinstalled or another user profile is used.
const KEY_NAME: &str = "Pharma-Licensing-Device-Binding-v2";
const PROOF_INTERVAL: Duration = Duration::from_secs(30);

struct Handle(usize);
impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                NCryptFreeObject(self.0);
            }
        }
    }
}

struct ProvenIdentity {
    marker: String,
    fingerprint: String,
    checked_at: Instant,
}
static RECENT_PROOF: OnceLock<Mutex<Option<ProvenIdentity>>> = OnceLock::new();

fn check(status: i32, what: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "TPM-backed device identity unavailable ({what}, 0x{:08x}); contact licensing support",
            status as u32
        ))
    }
}

fn key() -> Result<(Handle, Handle), String> {
    let mut provider: NCRYPT_PROV_HANDLE = 0;
    check(
        unsafe { NCryptOpenStorageProvider(&mut provider, MS_PLATFORM_CRYPTO_PROVIDER, 0) },
        "provider",
    )?;
    let provider = Handle(provider);
    // Defense against accidentally switching to a software-only provider.
    let mut implementation = 0u32;
    let mut received = 0u32;
    check(
        unsafe {
            NCryptGetProperty(
                provider.0,
                NCRYPT_IMPL_TYPE_PROPERTY,
                &mut implementation as *mut u32 as *mut u8,
                4,
                &mut received,
                0,
            )
        },
        "provider capabilities",
    )?;
    if received != 4 || implementation & NCRYPT_IMPL_HARDWARE_FLAG == 0 {
        return Err(
            "TPM hardware-backed key storage is required; software provider refused".into(),
        );
    }
    let key_name: Vec<u16> = KEY_NAME.encode_utf16().chain([0]).collect();
    let mut handle: NCRYPT_KEY_HANDLE = 0;
    let open = unsafe {
        NCryptOpenKey(
            provider.0,
            &mut handle,
            key_name.as_ptr(),
            0,
            NCRYPT_SILENT_FLAG,
        )
    };
    if open != 0 {
        // Do not overwrite a damaged/inaccessible existing key: the license
        // must fail closed, rather than silently create a new identity.
        const NTE_BAD_KEYSET: u32 = 0x80090016;
        if open as u32 != NTE_BAD_KEYSET {
            check(open, "open persisted key")?;
        }
        check(
            unsafe {
                NCryptCreatePersistedKey(
                    provider.0,
                    &mut handle,
                    NCRYPT_RSA_ALGORITHM,
                    key_name.as_ptr(),
                    0,
                    NCRYPT_SILENT_FLAG,
                )
            },
            "create key",
        )?;
        let created = Handle(handle);
        check(
            unsafe { NCryptFinalizeKey(created.0, NCRYPT_SILENT_FLAG) },
            "finalize TPM key",
        )?;
        return Ok((provider, created));
    }
    Ok((provider, Handle(handle)))
}

fn prove_device(marker: &str) -> Result<String, String> {
    let (_provider, key) = key()?;
    let mut size = 0u32;
    check(
        unsafe {
            NCryptExportKey(
                key.0,
                0,
                BCRYPT_RSAPUBLIC_BLOB,
                ptr::null(),
                ptr::null_mut(),
                0,
                &mut size,
                0,
            )
        },
        "public key length",
    )?;
    if !(200..=4096).contains(&size) {
        return Err("TPM public key blob has unexpected length".into());
    }
    let mut public = vec![0u8; size as usize];
    check(
        unsafe {
            NCryptExportKey(
                key.0,
                0,
                BCRYPT_RSAPUBLIC_BLOB,
                ptr::null(),
                public.as_mut_ptr(),
                size,
                &mut size,
                0,
            )
        },
        "export public key",
    )?;
    public.truncate(size as usize);
    if public.len() < 24
        || u32::from_le_bytes(public[0..4].try_into().unwrap()) != BCRYPT_RSAPUBLIC_MAGIC
        || !(2048..=4096).contains(&u32::from_le_bytes(public[4..8].try_into().unwrap()))
    {
        return Err("TPM public key must be RSA 2048-4096".into());
    }

    // Prove that this platform can currently USE the nonexportable private key
    // before allowing its public half to contribute to the license identity.
    let challenge = uuid::Uuid::new_v4();
    let digest =
        Sha256::digest([b"PHARMA-TPM-PROOF-V2:".as_slice(), challenge.as_bytes()].concat());
    let padding = BCRYPT_PKCS1_PADDING_INFO {
        pszAlgId: BCRYPT_SHA256_ALGORITHM,
    };
    let mut sig_len = 0u32;
    check(
        unsafe {
            NCryptSignHash(
                key.0,
                &padding as *const _ as *const c_void,
                digest.as_ptr(),
                digest.len() as u32,
                ptr::null_mut(),
                0,
                &mut sig_len,
                NCRYPT_PAD_PKCS1_FLAG | NCRYPT_SILENT_FLAG,
            )
        },
        "proof length",
    )?;
    if !(128..=1024).contains(&sig_len) {
        return Err("TPM proof length is invalid".into());
    }
    let mut signature = vec![0u8; sig_len as usize];
    check(
        unsafe {
            NCryptSignHash(
                key.0,
                &padding as *const _ as *const c_void,
                digest.as_ptr(),
                digest.len() as u32,
                signature.as_mut_ptr(),
                sig_len,
                &mut sig_len,
                NCRYPT_PAD_PKCS1_FLAG | NCRYPT_SILENT_FLAG,
            )
        },
        "sign challenge",
    )?;
    check(
        unsafe {
            NCryptVerifySignature(
                key.0,
                &padding as *const _ as *const c_void,
                digest.as_ptr(),
                digest.len() as u32,
                signature.as_ptr(),
                sig_len,
                NCRYPT_PAD_PKCS1_FLAG | NCRYPT_SILENT_FLAG,
            )
        },
        "verify challenge",
    )?;

    Ok(fingerprint_from_public_key(marker, &public))
}

fn fingerprint_from_public_key(marker: &str, public: &[u8]) -> String {
    // Domain-separated hash; only digest leaves the app. Preserve the legacy
    // 64 lowercase hex activation interface and authority database schema.
    let mut hasher = Sha256::new();
    hasher.update(b"PHARMA-MACHINE-V2-TPM:\0");
    hasher.update(marker.as_bytes());
    hasher.update(b"\0");
    hasher.update(public);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn machine_fingerprint(marker: &str) -> Result<String, String> {
    let cache = RECENT_PROOF.get_or_init(|| Mutex::new(None));
    let mut cache = cache
        .lock()
        .map_err(|_| "TPM identity state unavailable".to_string())?;
    if let Some(previous) = cache.as_ref() {
        if previous.marker == marker && previous.checked_at.elapsed() < PROOF_INTERVAL {
            return Ok(previous.fingerprint.clone());
        }
    }
    let fingerprint = prove_device(marker)?;
    *cache = Some(ProvenIdentity {
        marker: marker.to_string(),
        fingerprint: fingerprint.clone(),
        checked_at: Instant::now(),
    });
    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_fingerprint_binds_both_os_install_and_tpm_public_key() {
        let a = fingerprint_from_public_key("windows-a", b"rsa-key-a");
        assert_eq!(a.len(), 64);
        assert!(a
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_ne!(a, fingerprint_from_public_key("windows-b", b"rsa-key-a"));
        assert_ne!(a, fingerprint_from_public_key("windows-a", b"rsa-key-b"));
        let legacy = Sha256::digest(b"PHARMA-MACHINE-V1:windows-a");
        let legacy_hex: String = legacy.iter().map(|b| format!("{b:02x}")).collect();
        assert_ne!(a, legacy_hex);
    }

    #[test]
    #[ignore = "Manual QA only: requires a provisioned Windows TPM and persists a device key in the current Windows profile"]
    fn real_tpm_key_survives_reopening_and_proves_private_key_possession_twice() {
        // Run explicitly only in an isolated QA Windows account on a real TPM
        // device. Never execute this integration test on customer machines.
        let marker = "test-windows-installation-qa";
        assert_eq!(prove_device(marker).unwrap(), prove_device(marker).unwrap());
    }
}
