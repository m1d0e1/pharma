# PHARMA commercial onboarding: no manual owner signing required

The developer's 2026-10-19 first-owner Ed25519 certificate is a **new current
self-declaration**. Its signature authenticates the declaration bytes and
the named historical source fingerprints; it does not prove historical
ownership independently or authorize a production database migration.

**Commercial UX decision (2026-10-19):** Ordinary pharmacies do **not** need
to generate or manage Ed25519 signing keys, sign special upgrade tickets,
handle source hashes, or complete a cryptographic ownership ceremony.
The signed-owner tooling developed for the original developer's historical
database is an *optional, specialist-assisted legacy restoration/migration
prototype*, not a mandatory retail customer workflow.

## Simple customer experience

1. Install and activate the signed commercial PHARMA application using the
   established license procedure.
2. On a **new, empty** pharmacy installation, securely enroll the first owner
   with an activation proof and their own strong password. This is ordinary
   application-account setup, **not** Ed25519 owner-signing enrollment.
3. Start entering stock, suppliers, patients and financial transactions using
   PHARMA's normal role-based permissions. Native financial receipts, original
   record identities and tenant-scoped writes still apply.
4. For a move to a new computer or upgrade of an existing historical database,
   use a guided backup/restore/import path once its independent recovery and
   financial-reconciliation acceptance is implemented and tested. Regular
   customers need not see signing keys or SHA-256 hashes.

## Separate three trust domains

1. **Software licensing** proves an entitlement to use PHARMA. A license
   issuer's signature and software update signing key are PHARMA's keys.
2. **Pharmacy ownership for exceptional historical imports:** a support-assisted
   customer-specific proof may sign narrowly scoped administrative approvals,
   where justified by an explicitly reviewed risk policy. This is **optional**
   and hidden from routine onboarding, never a shared developer signing key.
3. **Staff identity and RBAC** govern sales, purchases, cash, and routine
   work. Owner-key possession must not bypass native tenant separation or
   financial accounting validation.

## Commercial implementation requirements for exceptional restoration

* Do **not** require ordinary pharmacy customers to enroll their own signing
  keys. For an exceptional historical transfer or disputed legacy source,
  require a proportionate support review and custody evidence; if a signing
  workflow is used, issue an independent per-customer protected key with
  appropriate recovery. The developer's private key never serves all customers.
* Bind authorization to exact source SHA-256, typed scope census SHA-256,
  source migration version, owner key, intended tenant, permitted action,
  nonce and expiry. Reject foreign pharmacy records, replayed signatures,
  wrong versions, changed source rows and unreviewed sources.
* Treat signatures as authorization **to attempt a controlled operation**,
  not proof that an incomplete or inconsistent historical financial ledger
  is valid. Enforce whole-business-graph reconciliation, independent backup,
  crash-safe promotion/rollback and real GUI acceptance separately.
* Only **if** exceptional owner-signed migrations are introduced commercially,
  keep a protected reviewed public-key registry; never trust a user-supplied
  self-signed manifest as production customer ownership. Record revocation,
  renewal, rotation and recovery with auditable approvals.
* Windows DPAPI CurrentUser protects this initial local private key, but its
  encrypted file is tied to the Windows user context. Before commercial use,
  implement documented secure device migration, recovery and support policies
  without exposing plaintext private keys or customer health records.
* The single-owner compiled-pin signer/validator is a developer-only,
  detached **copy-only** prototype. The Cargo feature
  `owner-maintenance-cli` is disabled by default; normal commercial builds do
  not expose either offline owner-signing maintenance CLI. Only a separate
  intentionally built and reviewed maintenance executable may expose them.
  If ever offered as a customer feature, it needs per-customer policy and
  recovery rather than compiling one operator's key into every executable.

**Keep these protections even without manual signatures:** verify database
integrity and migration provenance, independently scope old records and reject
foreign-pharmacy data, take recoverable backups before updates, prevent partial
promotions, and preserve exactly-once accounting receipts. Removing an onerous
customer ceremony must never silently relabel SQL `NULL`, `local_default`, or
other pharmacy data as the current tenant.

**Current status:** no production original-history promotion, financial
transaction enablement, independent historical owner proof or commercial
multi-pharmacy key registry has been granted by the developer's enrollment.
