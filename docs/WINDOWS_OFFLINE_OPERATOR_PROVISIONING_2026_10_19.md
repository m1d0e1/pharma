# PHARMA v0.2.110 — Windows private commercial offline operator

This is the local first-commercial-customer issuance workflow, **not** a
historical-source ownership grant or a code-signed Windows production installer.
No ordinary pharmacy customer or accountant must generate Ed25519 keys.

## Operator identity created in the current Windows profile

The new Windows-only offline issuer stores its signing seed and operator
credential as DPAPI CurrentUser-encrypted blobs in separate owner/SYSTEM-only
local custody directories, outside both the repository and the installed
pharmacy profile. The independent SQLite license state is ACL protected.
The original historic owner DPAPI key is **not read, copied, or reused**.

Public verification key (safe to embed in a reviewed release build):

    c2Tyc5dqkbs2xB4Zh-t1mUwmq8sF_2YG-1HNT3hZpRM

This key is distinct from the educational Azure signer and the published QA
test signer. Neither the actual private Ed25519 seed nor the operator token
belongs in GitHub, GitHub Actions secrets, app code, logs, or customer license
files. Do **not** initialize this authority again: refusing existing identity
resets protects previously issued licenses.

The issuer was independently reopened and verified with:

    python -B -m scripts.licensing.windows_private_operator status

The owner/SYSTEM private DPAPI credentials and the SQLite licensing ledger were
also independently copied to a separate locally protected recovery folder by:

    python -B -m scripts.licensing.windows_private_issuer_backup --backup-parent D:\PhD\Tools

The SHA-256, decrypted issuer public identity, and SQLite RAM integrity were
verified. The backup is **not portable to a different Windows account** because
the stored seed remains DPAPI CurrentUser sealed, and the second local disk is
not an independently secured off-device escrow. Genuine offline commercial
operation must have externally verified portable credential escrow and current
license-ledger backups after issuance and renewal. Never delete this identity
because a build or enrollment fails.

## Current refusal and manual issuance

There are no real customer licenses issued by this new private authority. The
operator command refuses issuance unless
PHARMA_COMMERCIAL_ISSUANCE_APPROVED=true is explicitly enabled for a separately
authorized issuance session. New customers provide **only** the exact
64-character fingerprint displayed by a genuinely signed PHARMA client,
and receive only the signed JSON activation envelope. No Azure server is
required; renewal/reassignment must preserve the original issuer ledger.

Once commercial release acceptance, private key recovery, code signing and
customer device identity validation are complete, the developer can run:

    python -B -m scripts.licensing.windows_private_operator issue-offline

with the strict license request JSON on standard input. Do not place passwords,
operator tokens, source database files, financial records or recovery keys
in the request. Commercial grant signing is not historical owner authentication,
legacy financial cutover or permission to overwrite a v29 customer database.

## Release prerequisites still NOT established

- Trusted commercial Windows Authenticode code-signing certificate and its
  protected signing service; independent Tauri updater signing identity.
- Portable/off-device commercial signer and authority-ledger restoration.
- Actual TPM-v2 acceptance and signed installer on supported real Windows hardware.
- Independent source-bound owner/import evidence, accountant consent receipts,
  verified old/new accounting separation, positive real-data GUI acceptance,
  and physical interruption/installer rollback certification.
- Explicit production release authorization and CI environment approval.

The Windows commercial release variables after review are:

    PHARMA_LICENSE_OFFLINE_ONLY=1
    PHARMA_LICENSE_DEVICE_MODE=tpm-v2
    PHARMA_LICENSE_VERIFY_KEY_B64=c2Tyc5dqkbs2xB4Zh-t1mUwmq8sF_2YG-1HNT3hZpRM
    PHARMA_LICENSE_AUTHORITY_URL=(unset)

Do not set PHARMA_SECURITY_RELEASE_APPROVED=true yet. In particular do not
confuse the private issuer's successful creation with a signed Windows
installer, a validated historical import, or financial approval records.
