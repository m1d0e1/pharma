//! Single-machine Windows custody store for verified historical approval.
//!
//! Caller supplies only an already authenticated, hashed source receipt.
//! All content is DPAPI CurrentUser encrypted and create_new at a nonce-scoped
//! name under an operator-provisioned, owner/SYSTEM-only ACL directory.
//! No folder is silently created with an inherited or permissive ACL. Neither
//! this receipt nor the DPAPI account authenticates a historical pharmacy.

use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const DENIED: &str = "Historical owner evidence custody is not independently protected";
const RECEIPT_FORMAT: &str = "pharma-native-historical-source-review-receipt-v1";
const RECEIPT_PURPOSE: &str = "verified-custody-only-no-startup-or-finance-authority";
const STORE_NAME: &str = "native-historical-owner-evidence-receipts";

#[cfg(windows)]
mod win {
    use super::DENIED;
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr::{null, null_mut, read_unaligned};

    const FILE_ALL_ACCESS: u32 = 0x001f_01ff;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_USER: u32 = 1;
    const SYSTEM_SID: u32 = 22;
    const SE_FILE_OBJECT: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;
    const SE_DACL_PROTECTED: u16 = 0x1000;
    const ACL_REVISION: u32 = 2;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    #[repr(C)]
    struct AclHeader {
        revision: u8,
        reserved: u8,
        bytes: u16,
        count: u16,
        reserved2: u16,
    }
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        modified: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "Advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            result: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn CreateWellKnownSid(
            kind: u32,
            domain: *mut c_void,
            sid: *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn EqualSid(first: *mut c_void, second: *mut c_void) -> i32;
        fn GetNamedSecurityInfoW(
            name: *mut u16,
            kind: u32,
            query: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            kind: u32,
            query: u32,
            owner: *mut c_void,
            group: *mut c_void,
            dacl: *mut c_void,
            sacl: *mut c_void,
        ) -> u32;
        fn GetSecurityDescriptorControl(
            descriptor: *mut c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: *mut c_void,
            present: *mut i32,
            dacl: *mut *mut c_void,
            defaulted: *mut i32,
        ) -> i32;
        fn IsValidAcl(acl: *mut c_void) -> i32;
        fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> i32;
        fn InitializeAcl(acl: *mut c_void, bytes: u32, revision: u32) -> i32;
        fn AddAccessAllowedAce(
            acl: *mut c_void,
            revision: u32,
            rights: u32,
            sid: *mut c_void,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn LocalFree(pointer: *mut c_void) -> *mut c_void;
        fn GetFileInformationByHandle(handle: *mut c_void, information: *mut FileInfo) -> i32;
    }

    struct Token(*mut c_void);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Descriptor(*mut c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn principals() -> Result<(Vec<u8>, Vec<u8>), &'static str> {
        let mut token = null_mut();
        // SAFETY: Valid process pseudo-handle and output pointer.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(DENIED);
        }
        let token = Token(token);
        let mut needed = 0;
        // Probe is expected to report a required buffer size.
        unsafe {
            GetTokenInformation(token.0, TOKEN_USER, null_mut(), 0, &mut needed);
        }
        if !(16..=4096).contains(&needed) {
            return Err(DENIED);
        }
        let mut user_info = vec![0_usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        let length = (user_info.len() * std::mem::size_of::<usize>()) as u32;
        if unsafe {
            GetTokenInformation(
                token.0,
                TOKEN_USER,
                user_info.as_mut_ptr().cast(),
                length,
                &mut needed,
            )
        } == 0
        {
            return Err(DENIED);
        }
        // TOKEN_USER begins with SID_AND_ATTRIBUTES, whose first member is
        // PSID. The pointer points within our live TokenInformation buffer.
        let user_sid = unsafe { read_unaligned(user_info.as_ptr().cast::<*mut c_void>()) };
        if user_sid.is_null() {
            return Err(DENIED);
        }
        let mut system_sid = vec![0_usize; 16]; // >= SECURITY_MAX_SID_SIZE
        let mut system_length = (system_sid.len() * std::mem::size_of::<usize>()) as u32;
        if unsafe {
            CreateWellKnownSid(
                SYSTEM_SID,
                null_mut(),
                system_sid.as_mut_ptr().cast(),
                &mut system_length,
            )
        } == 0
        {
            return Err(DENIED);
        }
        let user_bytes =
            unsafe { std::slice::from_raw_parts(user_sid.cast::<u8>(), sid_size(user_sid)?) };
        Ok((
            user_bytes.to_vec(),
            unsafe {
                std::slice::from_raw_parts(system_sid.as_ptr().cast::<u8>(), system_length as usize)
            }
            .to_vec(),
        ))
    }

    fn sid_size(sid: *mut c_void) -> Result<usize, &'static str> {
        // Revision (1) and at most 15 sub-authorities; requires caller to
        // supply an OS-generated valid SID pointer.
        let bytes = unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), 8) };
        if bytes[0] != 1 || bytes[1] > 15 {
            return Err(DENIED);
        }
        Ok(8 + bytes[1] as usize * 4)
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }

    pub(super) fn protect(path: &Path) -> Result<(), &'static str> {
        let (mut user, mut system) = principals()?;
        let mut acl = vec![0_usize; 128]; // aligned, enough for two Windows SIDs
        let acl_ptr = acl.as_mut_ptr().cast();
        let acl_length = (acl.len() * std::mem::size_of::<usize>()) as u32;
        // SAFETY: All SIDs are OS-issued copies, the ACL buffer is aligned,
        // and Windows APIs validate SID and ACL content before assigning.
        if unsafe {
            InitializeAcl(acl_ptr, acl_length, ACL_REVISION) != 0
                && AddAccessAllowedAce(
                    acl_ptr,
                    ACL_REVISION,
                    FILE_ALL_ACCESS,
                    user.as_mut_ptr().cast(),
                ) != 0
                && AddAccessAllowedAce(
                    acl_ptr,
                    ACL_REVISION,
                    FILE_ALL_ACCESS,
                    system.as_mut_ptr().cast(),
                ) != 0
                && SetNamedSecurityInfoW(
                    wide(path).as_mut_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl_ptr,
                    null_mut(),
                ) == 0
        } {
            Ok(())
        } else {
            Err(DENIED)
        }
    }

    pub(super) fn assert_private(path: &Path) -> Result<(), &'static str> {
        let (mut user, mut system) = principals()?;
        let mut descriptor = null_mut();
        let mut name = wide(path);
        if unsafe {
            GetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        } != 0
            || descriptor.is_null()
        {
            return Err(DENIED);
        }
        let _owner = Descriptor(descriptor);
        let mut control = 0;
        let mut revision = 0_u32;
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = null_mut();
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || (control & SE_DACL_PROTECTED) == 0
            || unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
            } == 0
            || present == 0
            || acl.is_null()
            || unsafe { IsValidAcl(acl) } == 0
        {
            return Err(DENIED);
        }
        let acl_header = unsafe { &*(acl.cast::<AclHeader>()) };
        if acl_header.count != 2 {
            return Err(DENIED);
        }
        let mut identities = [false; 2];
        for index in 0..2 {
            let mut ace = null_mut();
            if unsafe { GetAce(acl, index, &mut ace) } == 0 || ace.is_null() {
                return Err(DENIED);
            }
            let header = unsafe { std::slice::from_raw_parts(ace.cast::<u8>(), 8) };
            if header[0] != ACCESS_ALLOWED_ACE_TYPE
                || header[1] != 0
                || u32::from_le_bytes(header[4..8].try_into().map_err(|_| DENIED)?)
                    != FILE_ALL_ACCESS
            {
                return Err(DENIED);
            }
            let sid = unsafe { ace.cast::<u8>().add(8).cast::<c_void>() };
            if unsafe { EqualSid(sid, user.as_mut_ptr().cast()) } != 0 {
                if identities[0] {
                    return Err(DENIED);
                }
                identities[0] = true;
            } else if unsafe { EqualSid(sid, system.as_mut_ptr().cast()) } != 0 {
                if identities[1] {
                    return Err(DENIED);
                }
                identities[1] = true;
            } else {
                return Err(DENIED);
            }
        }
        if identities == [true, true] {
            Ok(())
        } else {
            Err(DENIED)
        }
    }

    pub(super) fn single_link(file: &File) -> Result<(), &'static str> {
        let mut info = std::mem::MaybeUninit::<FileInfo>::uninit();
        // SAFETY: valid file handle and an output structure with C-compatible layout.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(DENIED);
        }
        if unsafe { info.assume_init() }.links == 1 {
            Ok(())
        } else {
            Err(DENIED)
        }
    }

    pub(super) fn dpapi(input: &[u8], decrypt: bool) -> Result<Vec<u8>, &'static str> {
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        let mut blob = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(input.len()).map_err(|_| DENIED)?,
            pbData: input.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        let result = unsafe {
            if decrypt {
                CryptUnprotectData(
                    &mut blob,
                    null_mut(),
                    null(),
                    null_mut(),
                    null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptProtectData(
                    &mut blob,
                    null(),
                    null(),
                    null_mut(),
                    null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if result == 0 || output.pbData.is_null() || output.cbData == 0 || output.cbData > 8192 {
            return Err(DENIED);
        }
        let output_bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(output.pbData.cast());
        }
        Ok(output_bytes)
    }
}

#[cfg(windows)]
use win::{assert_private, dpapi, protect, single_link};

#[cfg(windows)]
fn no_alias(path: &Path, directory: bool) -> Result<(), &'static str> {
    use std::os::windows::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).map_err(|_| DENIED)?;
    if meta.file_type().is_symlink()
        || (meta.file_attributes() & 0x0400) != 0
        || (if directory {
            !meta.is_dir()
        } else {
            !meta.is_file()
        })
    {
        return Err(DENIED);
    }
    Ok(())
}

/// Read-only inspection of source evidence: an operator must have protected
/// the preexisting staging directory and both signed input files first.
#[cfg(windows)]
pub(super) fn locked_input(path: &Path) -> Result<File, &'static str> {
    use std::os::windows::fs::OpenOptionsExt;
    no_alias(path, false)?;
    assert_private(path)?;
    let file = OpenOptions::new()
        .read(true)
        .share_mode(0x1)
        .open(path)
        .map_err(|_| DENIED)?;
    single_link(&file)?;
    Ok(file)
}

#[cfg(not(windows))]
pub(super) fn locked_input(_path: &Path) -> Result<File, &'static str> {
    Err(DENIED)
}

#[cfg(windows)]
pub(super) fn assert_private_stage(stage: &Path) -> Result<(), &'static str> {
    no_alias(stage, true)?;
    assert_private(stage)
}

#[cfg(not(windows))]
pub(super) fn assert_private_stage(_stage: &Path) -> Result<(), &'static str> {
    Err(DENIED)
}

#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CustodyReceipt {
    format: String,
    purpose: String,
    tenant: String,
    source_sha256: String,
    approval_sha256: String,
    owner_evidence_sha256: String,
    request_nonce_sha256: String,
}

fn as_hex(input: &[u8]) -> String {
    input.iter().map(|b| format!("{b:02x}")).collect()
}

fn receipt_bytes(
    source_sha256: [u8; 32],
    approval_sha256: [u8; 32],
    owner_evidence_sha256: [u8; 32],
    nonce: [u8; 32],
) -> Result<(Vec<u8>, String), &'static str> {
    if source_sha256 == [0; 32]
        || approval_sha256 == [0; 32]
        || owner_evidence_sha256 == [0; 32]
        || nonce == [0; 32]
    {
        return Err(DENIED);
    }
    let nonce_sha = Sha256::digest(nonce);
    let receipt = CustodyReceipt {
        format: RECEIPT_FORMAT.into(),
        purpose: RECEIPT_PURPOSE.into(),
        tenant: "primary_pharmacy".into(),
        source_sha256: as_hex(&source_sha256),
        approval_sha256: as_hex(&approval_sha256),
        owner_evidence_sha256: as_hex(&owner_evidence_sha256),
        request_nonce_sha256: as_hex(&nonce_sha),
    };
    let bytes = serde_json::to_vec(&receipt).map_err(|_| DENIED)?;
    Ok((bytes, format!("{}.dpapi", as_hex(&nonce_sha))))
}

/// On Windows the protected receipts root must already exist, with an
/// independently installed protected DACL granting only current user+SYSTEM.
/// A duplicate request is always denied even if signed input is identical.
#[cfg(windows)]
pub(super) fn persist_signed_review(
    root: &Path,
    source_sha256: [u8; 32],
    approval_sha256: [u8; 32],
    owner_evidence_sha256: [u8; 32],
    nonce: [u8; 32],
) -> Result<PathBuf, &'static str> {
    let (plain, name) =
        receipt_bytes(source_sha256, approval_sha256, owner_evidence_sha256, nonce)?;
    let folder = root.join(STORE_NAME);
    no_alias(root, true)?;
    no_alias(&folder, true)?;
    assert_private(&folder)?;
    let ciphertext = dpapi(&plain, false)?;
    if ciphertext.len() > 8192 {
        return Err(DENIED);
    }
    let receipt = folder.join(name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt)
        .map_err(|_| DENIED)?;
    // Folder is already private before create_new. Protect this *empty*
    // receipt before writing to prevent a permissive inherited file ACL.
    protect(&receipt)?;
    assert_private(&receipt)?;
    single_link(&file)?;
    file.write_all(&ciphertext)
        .and_then(|_| file.sync_all())
        .map_err(|_| DENIED)?;
    assert_private(&receipt)?;
    drop(file);
    // Verify actual durable DPAPI envelope rather than believing write success.
    let readback = locked_input(&receipt)?;
    let mut stored = Vec::new();
    readback
        .take(8193)
        .read_to_end(&mut stored)
        .map_err(|_| DENIED)?;
    if stored != ciphertext || dpapi(&stored, true)? != plain {
        return Err(DENIED);
    }
    Ok(receipt)
}

#[cfg(not(windows))]
pub(super) fn persist_signed_review(
    _root: &Path,
    _source_sha256: [u8; 32],
    _approval_sha256: [u8; 32],
    _owner_evidence_sha256: [u8; 32],
    _nonce: [u8; 32],
) -> Result<PathBuf, &'static str> {
    Err(DENIED)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_is_explicitly_non_authorizing_and_one_nonce_has_one_path() {
        let (a, path) = receipt_bytes([69; 32], [12; 32], [34; 32], [56; 32]).unwrap();
        let parsed: CustodyReceipt = serde_json::from_slice(&a).unwrap();
        assert_eq!(parsed.purpose, RECEIPT_PURPOSE);
        assert_eq!(parsed.tenant, "primary_pharmacy");
        assert!(path.ends_with(".dpapi"));
        let (_, same) = receipt_bytes([69; 32], [13; 32], [34; 32], [56; 32]).unwrap();
        assert_eq!(
            path, same,
            "Changing approval bytes cannot reset nonce consumption"
        );
        assert!(receipt_bytes([69; 32], [12; 32], [0; 32], [56; 32]).is_err());
        let mut altered: serde_json::Value = serde_json::from_slice(&a).unwrap();
        altered["authorized"] = serde_json::json!(true);
        assert!(serde_json::from_value::<CustodyReceipt>(altered).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn protected_dpapi_receipt_denies_replay_acl_tamper_and_missing_store() {
        let parent = std::env::temp_dir().join(format!(
            "pharma-native-owner-custody-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&parent).unwrap();
        let private = parent.join(STORE_NAME);
        fs::create_dir(&private).unwrap();
        // A newly created unprotected parent must never be auto-enrolled.
        assert!(persist_signed_review(&parent, [69; 32], [12; 32], [34; 32], [56; 32]).is_err());
        protect(&private).unwrap();
        assert_private(&private).unwrap();
        let receipt =
            persist_signed_review(&parent, [69; 32], [12; 32], [34; 32], [56; 32]).unwrap();
        assert!(persist_signed_review(&parent, [69; 32], [12; 32], [34; 32], [56; 32]).is_err());
        let blob = fs::read(&receipt).unwrap();
        assert_ne!(
            blob[0], b'{',
            "No plaintext owner record or receipt on disk"
        );
        let mut corrupted = blob.clone();
        let mid = corrupted.len() / 2;
        corrupted[mid] ^= 1;
        assert!(
            dpapi(&corrupted, true).is_err(),
            "Tampered DPAPI bytes must fail"
        );
        // Test files are isolated under a new synthetic temp directory.
        fs::remove_file(&receipt).unwrap();
        fs::remove_dir(&private).unwrap();
        fs::remove_dir(&parent).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_cannot_issue_operational_receipt() {
        assert!(
            persist_signed_review(Path::new("/tmp"), [69; 32], [12; 32], [34; 32], [56; 32])
                .is_err()
        );
    }
}
