# PHARMA v0.2.110 — manual offline activation (first customers)

## Scope and release status

PHARMA now implements an **owner-operated, manually issued, device-bound
offline-term license**. Customers do not create Ed25519 keys or use Azure.
They show the **64-character fingerprint from PHARMA's own activation screen**,
receive a signed JSON license file from the commercial license operator, import
the file, restart and choose a strong owner password **on a new empty pharmacy
profile**. The signed grant is valid until its explicitly signed expiration
date; it does not require daily online renewal.

This source change is **not itself a signed installer or authorization to
overwrite the installed historical pharmacy database**. The protected genuine
original-history source requires separate provenance, finance, ownership,
GUI and release acceptance. An offline license grants application use, **not
ownership of another pharmacy's archived data**.

## Operator prerequisites

- A reviewed, separately managed **commercial** Ed25519 private signing key,
  **not** the public educational Azure or published QA test signer. The
  private seed stays in a protected operator-only secret manager or isolated
  terminal, never in source control, the app binary, customer chat or CI.
- A distinct persistent commercial licensing database and operator secret,
  private to the issuer, with encrypted and independently verified backups.
- An authorized local commercial operator environment containing the
  pre-provisioned private paths and credentials accepted by
  `scripts/licensing/commercial.py`. This utility refuses to initialize a new
  private identity automatically and refuses publicly known test keys.
- Explicit operator issuance approval:
  `PHARMA_COMMERCIAL_ISSUANCE_APPROVED=true`. Do not turn this on in the
  publicly served educational Azure staging service. The private operator
  command does **not** expose an issuing HTTP endpoint.
- A reviewed Windows commercial release with the issuer's **public** key
  compiled in, signed installers, the required hardware-backed TPM-v2
  verification and tested restore/update paths. A developer/debug build is
  not a commercial signed release.

## 1. First manual offline license

1. Have the customer open **تفعيل ترخيص فارما**. Ask for **بصمة هذا الجهاز**
   (64 lowercase hexadecimal characters). Do not collect patient data,
   database files, passwords, TPM private keys or an invented fingerprint.
2. In the operator's **already provisioned private** commercial environment,
   issue an offline term directly, without online activation:

   ```sh
   # PRIVATE OPERATOR TERMINAL ONLY. Never use CI/Azure RunCommand for grant output.
   # This is a request example; replace the placeholder with the fingerprint
   # displayed by the customer's genuine PHARMA app.
   umask 077
   fingerprint='<64-character-lowercase-device-fingerprint>'
   expiry="$(date -u -d '+90 days' +%s)"
   printf '{"machine_fingerprint":"%s","expires_at_utc":%s,"actor_id":"owner-operator"}\n' \
     "$fingerprint" "$expiry" |
     python -m scripts.licensing.commercial operator issue-offline
   ```

   The response contains `result.license_id`,
   `result.activation_serial`, `result.expires_at_utc`, and the **signed
   two-field** `result.activation` envelope:

   ```json
   {"payload_b64":"<signed-payload>","signature_b64":"<signature>"}
   ```

   **Deliver only this signed envelope as a private `.json` file**, using
   an approved customer channel, and separately record the license ID and
   expiration in your issuer records. Never deliver the private signer seed
   or operator credential. A device-binding mismatch fails locally.

3. On the customer Windows PC, click **استيراد ملف الترخيص الموقّع (JSON)**,
   select the received license JSON and click **تفعيل الترخيص**. Existing
   copy/paste of the signed JSON is also supported. The native code verifies
   the exact Ed25519 signature, compiled-in issuer public key, current TPM
   device fingerprint, expiry, monotonic serial and protected clock anchor.
4. Restart PHARMA when requested. On a **new empty profile only**, set and
   confirm a new strong owner password. Leave the **رمز تفعيل الترخيص**
   (online activation code) field **empty**. No Azure request or customer
   crypto ceremony is needed. Log in as `admin` with that chosen password.

   **For online-issued licenses**, the existing DPAPI-bound code re-entry is
   still required. Offline bootstrap is not accepted for an existing profile
   containing previous staff, patient, inventory, supplier, invoice, stock,
   cash, journal or other original business history.

## 2. Manual renewal

Use the owner-only `extend` command with the exact **current** issuer
license ID, activation serial, prior expiry and new expiry. An authorized
extension increments the serial and returns a fresh signed
`result.activation`. Send that **envelope only** to the same device; the
customer imports it using the existing license management screen. Renewal
does not modify business records and does not require repeating owner
enrollment. The issuer refuses stale serials, stale expiry, revoked grants,
duplicate ID issuance and attempts to shorten a term.

If the device changes, use an audited operator reassignment and deliver the
revocation tombstone to the old device if possible. A disconnected old PC
cannot be remotely revoked immediately; an offline-term license may remain
usable until its signed expiry. Consider a 30/90-day term while the business
is small, or 6/12 months for a paid plan if that offline risk is acceptable.

## 3. Build a truly offline-only commercial client

The release build now supports an **explicit** offline-only mode:

```text
PHARMA_LICENSE_OFFLINE_ONLY=1
PHARMA_LICENSE_DEVICE_MODE=tpm-v2
PHARMA_LICENSE_VERIFY_KEY_B64=<approved-32-byte-commercial-public-key-in-base64url>
PHARMA_LICENSE_AUTHORITY_URL=<unset-or-empty>
```

If offline-only is `1`, the release build **refuses a nonempty online
authority URL**. If offline-only is not enabled, the pre-existing strict
reviewed HTTPS authority-URL requirement remains. The Ed25519 issuer
private key must **never** be a build variable. Configure corresponding
GitHub Actions repository variables for the signed release workflow, but
**do not enable `PHARMA_SECURITY_RELEASE_APPROVED`** without the normal
signing, installer, real-TPM and business/financial release approvals.

Neither mode turns off license verification. Ordinary pharmacy customers
only receive a simple JSON grant; the developer/issuer retains all signing
complexity.

## 4. Validation and boundaries

- `python -B -m unittest scripts.licensing.test_authority scripts.licensing.test_commercial -q`
- `npm test -- --runInBand src/tests/owner-enrollment-native.regression.test.tsx`
- `cargo test --offline -j 1 --bin pharma manual_offline_owner_setup`

Before shipping, perform a **real signed Windows offline-mode binary** test
on a new eligible TPM machine: signed file import, full process restart,
owner enrollment, local login, offline expiry and renewal, wrong-machine
denial, duplicate/old-serial rejection, data preservation when expired,
and backup/rollback. Synthetic unit tests are not that acceptance.

**Absolutely no automatic offline adoption of original PHARMA historical
records**: the protected SQLx69 historic copy's own nonempty audit and
business history still fail the independent preexisting-profile/finance
guards. Those controls are unrelated to commercial customer license
activation and remain in force.
