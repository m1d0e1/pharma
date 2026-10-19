# Pharma commercial-release security gate — 2026-10-11 continuation

**Decision: DO NOT RELEASE.** This is a source-hardening increment in an
already-uncommitted Windows worktree, not a deployed license service, a complete
native multi-pharmacy authorization migration or a tested commercial installer.
Leave `PHARMA_SECURITY_RELEASE_APPROVED` unset/false; do not label x86 builds
Windows 7-compatible. The original customer database must remain untouched.

## Changes and security boundaries verified in synthetic tests

- Generic renderer SQL reads of protected business tables are denied in the
  Cargo **release profile**, independent of `debug_assertions`; `build.rs`
  advertises the internal `pharma_security_release` cfg. Generic renderer SQL
  **writes are also denied** in that profile. An SQL write-target allowlist
  cannot alone prevent `INSERT ... SELECT`/subqueries from reading protected
  tables, and several historical tables lack tenant IDs. This is a safety gate,
  **not completed application functionality**: existing screens still call the
  legacy SQL APIs and would be blocked by this policy in a release installer.
- `db_read_scoped` includes native `inventory.enriched` with immutable SQL,
  explicit projection, native actor/pharmacy binding, per-role inventory view
  permission, optional bounded name/barcode or drug-ID filters, 200-row pages,
  4-second query deadline and 2-MiB per-page output limit. The native
  inventory-list action uses this query ID instead of renderer SQL; the web
  development branch retains the old implementation. Synthetic tenant A/B,
  unauthorized role, invalid filter and pagination tests are included. Its
  frontend page loop *rejects* >50,000-offset results rather than returning a
  falsely truncated inventory. Whole-catalog (191K-drug) exports need separate
  streaming/keyset native APIs and performance testing.
- `sales.dashboard_stats` is now a native actor-bound aggregate read, with a
  `rep_can_view_sales` permission check, branch predicate derived from the
  active SQLite user/session and no caller-provided SQL or pharmacy ID. Its
  existing frontend summary consumes the typed result on Tauri while web
  development retains the original queries; native regression covers two
  branches, owner/denied/inactive actors and legacy local rows. Other sales
  functions **still require their own migrations**.
- The HTTPS issuer's saturated TLS accept-loop now closes excess peers
  without a synchronous `SSLSocket.sendall`/handshake in the single accept
  thread. The regression creates a disposable local TLS certificate, fills the
  handler slot, connects a nonhandshaking peer and then validates a healthy
  client can connect after capacity returns. It does not validate public
  ingress rate limiting, DDoS resilience or hosting infrastructure.
- The issuer stores signed per-device revocation receipts for operator revokes
  and transfers in its authority SQLite DB. A former/revoked machine proving
  possession of its activation code receives its prior *signed*,
  machine-specific revoked grant on its next online renewal, with nonce replay
  prevention. The desktop's signature/machine/serial install checks handle the
  revocation. This does **not** instantly revoke offline 24-hour leases.
- Native licence state files now use size-bounded reads for signed JSON,
  DPAPI-protected clock anchors and stored bearer credentials. Auto-renewed
  licences only unlock the React UI if the native database startup completed;
  renewing an initially unlicensed startup instead requires a restart.
- Activation and renewal now share a native process-wide request gate. An
  in-flight request for the same credential is coalesced, a simultaneous
  different credential is rejected, and successful verified requests impose a
  five-minute monotonic cooldown. The gate only stores a SHA-256 credential
  digest, not the plaintext code. A cached result always re-reads actual
  signed native license status and matches its license ID before returning
  success. The watcher uses the same path; this is a **client-side protection**
  and does not replace operator/API gateway per-source or per-license quotas.
- `test.yml`'s 32-bit x86 installer build now supplies the TPM mode and HTTPS
  endpoint required by `build.rs`, and no longer claims Windows 7 runtime
  compatibility. `release.yml` likewise names its TPM-required x86 artifact
  truthfully. A PE subsystem version compatible with older loaders is **not**
  evidence that the TPM-required licensing tier can run on Windows 7.

## Tested in this continuation (not production acceptance)

- Windows local Rust debug suite: **174 passed, 1 deliberately ignored** after
  request-coalescing and sales-scope tests, and native debug build passed after
  the bounded licensing-state change.
- Local Python authority/service/security tests: **29 passed**, including
  mocked/disposable TLS tests and signed revocation delivery.
- Two targeted frontend Jest suites: **24 passed**, including the new
  startup-ready gate and scoped inventory invoke contract. The full Jest run
  completed with **275 suites passed, 2,317 tests passed, 0 failed and 2
  pending** (run started before the final sales-scoped source edit).
- TypeScript `npx tsc --noEmit`: passed on the later source tree; the static
  Tauri frontend build passed and restored `src/middleware.ts`.
- The native MSRV pinned to Rust 1.77.2 remains **unverified**: an attempted
  offline 1.77.2 `cargo check` could not resolve an uncached `h2` crate used by
  `reqwest`, while installed Rust 1.95 built and tested successfully. CI on
  the pinned toolchain is still required before release.
- No real production issuer, TPM provisioning, signing keys, CDN, DNS, CA
  certificate, user activation, release installer, customer data mutation or
  full manual GUI smoke is claimed in these results. Any later test results
  must be documented separately rather than retroactively implying acceptance.

## Required to remove the release block

1. Migrate **every** protected native SQL read and write, including POS,
   patients, supplier/purchase/payments, accounting, reports, history, returns,
   exports and handovers, to native-owned operations with mandatory actor ID,
   DB-derived tenant scope, row/column permissions and bounded paging. Re-run
   release-mode GUI functional parity and adversarial multi-pharmacy tests.
2. Define patient ownership for existing records. Baseline `patients` has no
   `pharmacy_id`, and historical records may have ambiguous assignment.
   Review orphaned/multi-branch patients with the pharmacy operator before a
   migration. Never infer a private patient's branch from an unrelated record
   or assign all historic rows to the current user.
3. Deploy an operator-approved HTTPS origin with real certificate/rotation,
   isolated Ed25519 issuer signing key and backups, audited MFA-controlled
   operator transfers/revocations, source and account throttles, monitoring,
   DR and recovery. Verify the actual desktop signed lease renewal and signed
   tombstone over public TLS on multiple real Windows TPM devices.
4. Qualify signed x86/x64 release installers, updater/Authenticode chain,
   offline expiration/clock recovery, policy migration, restore, large catalog
   performance, full static frontend/backend/test suites, dependency advisories
   and each authorized staff role. Run non-destructive QA using synthetic or
   explicitly approved test data, not customer business records.
5. Obtain independent operator security approval only **after** those gates,
   then enable the controlled publishing interlock.

## Windows 7 reminder

The user has asked to be reminded *later* that the TPM-required commercial
license tier **does not support Windows 7**; a distinct explicitly reviewed
security/support policy would be necessary for any Windows 7 product. No
reminder date or time was provided and **no scheduled reminder exists**.

## Continued verification and native migration (later 2026-10-11)

**Release decision remains DO NOT RELEASE.** The earlier test counts above
describe the earlier source snapshot. The subsequently resumed work completed
additional synthetic security and frontend checks; it did not deploy or ship.

- Native `inventory.movements` and `inventory.opening_balances` now have a
  dedicated immutable-SQL Tauri command in `commands/inventory_history.rs`.
  A live native session identifies the actor; the SQLite user row supplies
  pharmacy scope and either `preview_item_movements` or
  `can_view_opening_balances` permission. The movement log user-name join is
  pharmacy-restricted and unknown/foreign-linked staff IDs are redacted.
  The corresponding Tauri paths in `actions-client/inventory.ts` page through
  200-row native reads and never retry arbitrary SQL if denied. Web-only
  development retains its original query. Native synthetic multi-pharmacy,
  inactive/unauthorized role, legacy local_default and negative-input tests
  passed; the new Jest action routing tests passed 3/3. Reads exceeding the
  bounded 50,000-offset window FAIL EXPLICITLY; large audit export requires
  proper streaming and must not be silently truncated. **Opening-balance
  creation is now migrated** to `add_opening_balance_critical`: its one native
  BEGIN IMMEDIATE transaction derives actor and branch from SQLite, validates
  drug/unit/expiry/prices, inserts a scoped stock lot, posts the original
  debit/credit ledger entries and audit event, and executes the previously
  JS-owned shortage-recovery threshold (including 30-day unit-converted sales)
  before committing. A failed downstream journal/recovery step rolls back the
  stock too. Synthetic Rust role/branch/account/rollback scenarios (3/3),
  new JS native/web parity (5/5) and existing inventory tests passed.
  **Other stock adjustments and full release-mode inventory parity remain
  unverified or unmigrated.**
- Native purchase invoice listing now uses `purchases.invoices_list` on the
  Rust `db_read_scoped` boundary, with native `can_view_purchases` permission,
  database-derived pharmacy identity, stable `[created_at,id]` keyset pages,
  the original invoice/supplier/drug columns, and foreign-pharmacy user-name
  redaction. Synthetic two-pharmacy, 200+-invoice pagination and renderer
  deny/no-arbitrary-SQL fallback tests passed locally. Two further typed
  native query IDs now power draft invoice listing and invoice detail reads:
  `purchases.drafts_list` returns the original six projected columns while
  privately keyset-paging via a raw timestamp, and `purchases.invoice_get`
  binds a record ID/actor tenant and returns the original invoice fields or
  null (including on cross-pharmacy lookup). Native `can_view_purchases`,
  bounded reads, UTC normalization and explicit >100K-page overflow errors
  apply; web branch stays unchanged. Additional Rust 6/6 and frontend 11/11
  synthetic tests covered multi-branch, role denial, null timestamps,
  pagination and web parity. **Other purchase workflows remain unmigrated.**
- Shared native `ensure_exclusive_purchase_inventory` now rejects historic
  inventory lot references whose actual branch differs from the persisted
  purchase invoice branch before deleting, editing, or returning stock.
  Added regression proving a deleted purchase cannot debit another pharmacy's
  inventory and that rollback retains the invoice and quantity.
- Python HTTPS authority now has defense-in-depth source-IP admission control:
  30-request burst/60-second refill, at most 1,024 process-local peer entries,
  120-second stale cleanup, HTTP 429 `Retry-After`, trusted TCP peer identity
  rather than spoofable forwarded headers, and bounded threaded admission.
  Expanded loopback HTTPS signed grant/reassign/revoke, replay prevention and
  disconnected-client tests. A fresh full Python run completed **36/36**
  passing. This is not a substitute for gateway/cluster source quotas,
  certificate monitoring, hosted TLS, or operator authentication.
- Root `.gitignore` now exempts `scripts/licensing/test_authority.py` and
  `test_release_boundary.py` from the blanket `test_*` exclusion. The new
  `licensing-authority` CI job runs the entire synthetic Python security
  suite. The CI x64 PE baseline wording no longer implies Windows 7 support.
  The files are still uncommitted; CI hasn't run on a pushed commit.
- Recovered Rust 1.77.2 toolchain now successfully completed `cargo check
  --locked --bin pharma` on Windows rather than being blocked by `h2` cache.
  Earlier complete Rust debug suite: **179 passed, 1 ignored**. Later Rust
  suite after opening-stock and scoped settings additions: **184 passed, one
  deliberately ignored TPM hardware test**. A newer full Jest run completed
  **280 suites passed, 2,337 tests passed, 0 failures, 1 skipped suite and 2
  skipped tests**. It began before the final purchase detail/draft additions
  from the subsequent worker, so those need focused verification. TypeScript
  checking and the optimized Tauri static frontend build passed. The pinned
  Rust 1.77.2 release-profile `cargo check --locked --release --bin pharma`
  also passed with an ephemeral QA PUBLIC key and `.invalid` HTTPS endpoint;
  no real issuer/private key was used. Signed-installer and GUI runtime QA are
  separate gates, not implied by compiler success.

**Unresolved blockers remain severe:** hundreds of renderer SQL reads/writes
are rejected by the secure release policy; typed native writes need an actor,
role, tenant and foreign-row audit; historical patient branch ownership needs
a reviewed business decision; no production HTTPS authority/signing service,
real trusted TLS certificate, operating backups, physical TPM QA, signed
installer/updater chain, release-mode GUI parity, 191K catalog performance,
or independent release acceptance exists. Keep
`PHARMA_SECURITY_RELEASE_APPROVED` disabled. Do not mutate the customer DB or
interpret local green tests as commercial acceptance.

### Independent native mutation audit and targeted fail-closed fixes

A subsequent independent read-only audit of *typed* Tauri mutation commands
confirmed that a typed IPC name alone is not an authorization boundary. The
following corrective work was made in code and synthetic fixtures, without
touching the customer database:

- `commands/inventory_repair.rs`: legacy placeholder/NULL stock reassignment
  now requires an active **local_default owner**, and fails before mutation if
  the database contains any other pharmacy's users or inventory. Its next
  guard also inspects seven more historical tenant-bearing business tables,
  rejecting foreign branch records or populated histories without a tenant
  column rather than assuming ownership. An existing
  multi-pharmacy file requires reviewed provenance/ownership rather than
  automatically moving anonymous rows into one tenant. Synthetic cross-tenant
  and cashier denial verifies no row was changed.
- `commands/drug_replacement.rs`: global master-drug reconciliation and
  barcode correction now perform a same-transaction tenant check, rejecting
  operations when users, inventory, sales or purchases from another pharmacy
  exist. A synthetic test verifies that a branch administrator cannot rewrite
  another pharmacy's stock or historic sale ID. The current operation updates
  numerous historical foreign keys globally; properly supporting a
  multi-pharmacy catalog merge needs separate global-operator authority,
  reviewed data provenance, atomic plans and audit/rollback QA. The current
  single-tenant behavior remains available. Group merge and barcode correction
  now run the same read-only scope preflight **before** creating a full backup,
  and recheck inside their write transactions. Separate cross-tenant synthetic
  tests verify foreign history and rollback/denial; no rejected multi-branch
  request should create a needless full backup.
- `commands/settings.rs`: the renderer-facing native settings command is now
  allowlisted to the 14 known pharmacy identity keys, tenant-prefixed for
  non-default branches. **No** active settings user, including a delegated
  `local_default` actor, can arbitrarily rewrite other global config or
  schema/repair markers through that command. Unmigrated non-identity
  configuration needs a separate native authorization model and protected
  read API before full UI parity.
  An additional native `read_pharmacy_settings_scoped` command now exposes only
  the same 14 tenant-specific identity keys to a session whose active database
  role has `can_view_settings`. Both the desktop settings client and approved
  `getConfigAction` identity reads route through this command, not arbitrary
  SQL; unapproved config reads fail closed. Its native dual-branch/missing-user
  regression and three frontend routing/denial tests passed. Other global
  configuration reads still need case-by-case migration.
- `commands/sync.rs`: the public-cloud watermark IPC now validates a bounded
  UTC timestamp with SQLite clock comparison and refuses malformed or
  far-future values such as 2099 that would suppress incremental catalog
  updates. It additionally requires an active native role with
  `can_manage_inventory` (owner implicit), so ordinary cashiers cannot move
  the watermark. **A deeper integrity gap remains:** the renderer still
  presents the timestamp and even an inventory manager can move a permitted
  watermark to a plausible time. Move completion accounting into a verified
  native sync job rather than treating a frontend timestamp as proof of
  completed remote updates.

**The audit also found a permission-policy decision:** purchase create/edit,
delete and returns use the historically overloaded `can_view_purchases` key
for writes. This is a capability authorization, but its label and meaning do
not distinguish read from financial mutation. Splitting permissions requires
an explicitly reviewed legacy-role migration before commercial release.

After the extended native changes (including native settings reads, protected
sync watermark role checks, purchase drafts/details and opening balance
transactions), a full local Rust debug suite completed **188 passed,
one ignored**. The new targeted frontend suites completed **19 passed,
zero failed** and TypeScript `--noEmit` succeeded. On the pinned
Rust 1.77.2 compiler, `cargo check --locked --release --bin pharma` **passed**
with a disposable public Ed25519 test key and an example `.invalid` HTTPS
origin strictly local to the build-check process. This checks compilation of
the strict Cargo release profile; it is **not** evidence that a production
service exists or that release GUI/business paths work. No installer was
produced by this check, and no real private signing key was used.

### Final resumed verification and further release blockers

**Release stays BLOCKED.** On the subsequently reconciled tree, the pinned
`cargo +1.77.2 test --locked --bin pharma` suite completed **189 passed,
zero failed, one deliberately ignored TPM hardware test**. Python local
authority/security tests completed **36 passed**. The optimized Tauri Next.js
15.5.27 frontend build succeeded (70 static pages) and restored
`src/middleware.ts`; subsequent `npx tsc --noEmit --pretty false` succeeded.
The initial concurrently launched `tsc` raced with the export's deliberate
temporary middleware move, so its missing-file error was **not** retained as
a product compilation failure; the correctly sequenced TypeScript rerun passed.
No packaged or signed installer, live GUI workflow or actual TPM hardware
acceptance was performed in this verification.
After the staff-directory and native permission additions, the pinned
`cargo +1.77.2 check --locked --release --bin pharma -q` **also passed again**
with a one-time-generated disposable QA Ed25519 public key and a non-routable
`https://qa-pharma.invalid` configuration scoped to that compilation process;
no production signing key or real license authority was involved.

**Native staff directory:** `getStaffAction()` for Tauri now calls fixed native
`list_staff_directory` with no caller-provided user/pharmacy/SQL. The session's
active DB user determines pharmacy; the seven original staff/job fields are
returned for active employees in that pharmacy and password hashes are never
projected. Web-only SQL behavior is preserved. Rust auth tests passed **13/13**
and three focused staff Jest suites passed **27/27**. Other owner/staff
mutations and reports still require their own release-mode authorization and
functional parity tests.

**Node dependency advisories:** `npm audit --omit=dev --audit-level=high` was
rechecked against the current lockfile. A bounded, compatible lockfile-only
update reduced findings from **24 (7 high, 15 moderate, 2 low)** to **18
(2 high, 14 moderate, 2 low)**. It fixed vulnerable dependency resolutions for
`brace-expansion`, `browserslist`, `fast-uri`, `nanoid`, and `source-map-js`.
The remaining high findings are **`next/node_modules/postcss`** and direct
**`xlsx`**. The latter has no available npm audit fix, and a 191K-record
clinical/inventory import/export replacement needs tested behavioral parity.
Next 16 is a major change that was not applied speculatively. The updated
`package-lock.json` passed `npm ci --dry-run --ignore-scripts` and static
frontend checks. **No actual dependency reinstall was done:** the current
`node_modules` may still contain the older resolved transitive packages, so
the built frontend does not establish patched installed-package runtime QA.
The Rust `cargo-audit` subcommand is not installed; a comprehensive Rust
advisory audit remains unperformed. Neither npm's nor Rust's advisory gate is
ready for unrestricted release.

**HIGH: universal default owner credentials on first licensed install.** The
`scripts/seed-db.js` build path requires a `users` row named `admin`; both
`src-tauri/migrations/001_initial.sql` and `src-tauri/src/schema.rs` contain
the same published bcrypt hash for the known password `admin`. The licensed
startup copies this seed to an absent/empty app-data DB, while the schema's
empty-user recovery path can recreate it. Login immediately enters the
dashboard, and the quick-start's voluntary password-change instruction is
not mandatory onboarding. This means anyone with local access to a newly
licensed machine could log in as owner using the published default; the
license does **not** protect against local account takeover. A secure
commercial product must provide licensed, one-time, unique owner enrollment,
refuse business IPC until enrollment is complete, and preserve existing user
accounts during upgrades. Do **not** blindly edit already-applied SQL migration
checksums, reset a customer DB, or silently distribute a shared replacement
password. The release job also needs a read-only check of the isolated seed
artifact and native recovery path before signing either architecture.

**Fail-closed release preflight installed (2026-10-11):**
`scripts/check-commercial-release-seed.js` now reads only the fixed build seed
`src-tauri/pharma_local.db` in SQLite read-only/query-only mode and denies
missing, corrupt or symlinked seed files, any preconfigured account password
hash, and embedded bcrypt literals in the native bootstrap migration/schema.
It refuses a caller-supplied DB path. The script was validated by **9 passing
synthetic in-memory SQLite Jest tests**. A read-only run against the current
designated bundled seed **correctly exited nonzero** with the configured-owner
password-hash error. There was no mutation of that artifact or any customer DB.

Both x64 and x86 jobs in `.github/workflows/release.yml` now execute the
preflight **immediately after their isolated seed generation, before signing**
and execute `npm audit --omit=dev --audit-level=high` as an additional hard
failure gate. Because the Tauri action can rebuild or reseed after the initial
step, the x64 final before-build override runs the preflight after reseeding,
and the x86 final before-build override rechecks its previously seeded file.
The existing `PHARMA_SECURITY_RELEASE_APPROVED` and draft/signature gates were
preserved. With today's seed and two high npm advisories, **both release jobs
are intentionally unable to publish a commercial installer**. Removing these
build interlocks or setting a release variable is not a substitute for fixing
the bootstrap model and dependency vulnerabilities. No GitHub Actions release
run, code-signing job or installer publication was executed.

### Final integrated local test snapshot

After **all** source, workflow, seed-preflight and lockfile edits above, the
full local frontend Jest run completed with **283 passing suites, 2,362
passing tests, zero failures**, one skipped suite and two skipped tests.
The full native Rust test command using the pinned 1.77.2 compiler completed
**189 passed, zero failed, one ignored**; the ignored case requires real TPM
hardware. The complete synthetic Python licensing suite completed **36 passed,
zero failed**. TypeScript `npx tsc --noEmit --pretty false` and full ESLint
error checking (`npm run lint -- --quiet`) both exited 0. Both release and
test workflow YAML files parsed successfully. The optimized Tauri static
frontend build exported 70 pages, and the Rust 1.77.2 release-profile check
passed using disposable test-only verification configuration. No credentials,
customer records, or production authority were used.

The read-only **actual seed preflight intentionally FAILED** (blocked a
configured password hash), and the current **npm audit intentionally FAILED**
with two high-severity dependencies. These are release-safety successes,
not shipping acceptance. A real commercial run will remain stopped until
secure on-device owner enrollment and reviewed dependency remediations exist.
The source changes, new test files, release workflow and this report are
still in an **uncommitted, partly untracked working tree**; no remote CI run,
merge, release, license deployment, installer signing, hardware acceptance or
customer database write is claimed.

## Additional integrated implementation: first-owner enrollment and native reporting/POS

**Release decision stays DO NOT RELEASE.** This source increment is uncommitted.
The customer pharmacy DB, live licensing authority and release signing keys
were not accessed or changed.

### First-owner bootstrap and historical migration

- Native auth now offers owner_enrollment_status and enroll_initial_owner,
  gated by a valid signed license, completed native startup, no active local
  login, and re-entry of the original 43-character activation code checked
  against the locally DPAPI-sealed online renewal credential. The code is
  never returned over IPC. Strong password policy and BCrypt are applied.
  BEGIN IMMEDIATE and a second in-transaction ownership check serialize
  concurrent windows/processes; a losing attempt, replay or audit failure
  rejects or rolls back. Known seeded admin/admin login is blocked until
  operator-proven enrollment; a previously changed owner password is preserved.
- The applied migration 001 remains byte-for-byte intact for historic SQLx
  checksum compatibility. New forward migration
  032_remove_public_owner_bootstrap_credential.sql neutralizes only the exact
  legacy default owner's known BCrypt credential. The native empty-users
  fallback now provisions an uninitialized, NULL-password owner, not a shared
  password. The release preflight requires SQL 032 to be registered, the
  runtime enrollment gate to exist, and the bundled artifact to contain no
  usable account hash. Additional unknown static hashes fail the gate.
- A fresh **isolated synthetic seed**, NOT the customer database, was generated
  in scratch/owner-enrollment-release-synthetic-20261011. It retained 25,404
  catalog drugs and 191,272 interaction rows. Read-only commercial preflight
  passed; the only owner row had password_hash NULL. The old bundled seed
  artifact was not overwritten by this test. Native synthetic enrollment tests
  verify same-device/license proof, concurrency, replay, audit rollback, and
  preserving already-initialized owners. Existing offline/manual signed-license
  customers without a stored online activation code need a separately
  approved operator enrollment/recovery mechanism before commercial support.

### Migrated native financial, patient and POS reads

- Fixed native db_read_scoped query IDs now cover reports.trend,
  reports.sales_history, reports.top_drugs, reports.categories,
  reports.total_units and reports.kpis. Each query derives actor/tenant from
  the active native SQLite session and checks rep_can_view_sales, with
  bounded 1–366 day windows, 200-row paging and explicit overflow rejection.
  KPIs include branch sales, COGS, liquidity, delivery cash, inventory
  shrinkage and low-stock alerts. The existing web-only SQL branch remains.
- patients.report_picker projects only ID and names for patients already
  referenced by qualifying completed invoices of this native branch; roles
  require reporting privilege or can_view_patients. It does NOT infer
  historical patient ownership, reveal medical details or authorize wallet,
  profile, delete or patient edits. Ambiguous cross-branch patients still
  require business ownership policy and non-destructive review.
- pos.barcode_candidates, pos.barcode_first and pos.barcode_batches now
  restrict barcode stock to the native actor's pharmacy and can_access_pos.
  They redact acquisition cost for staff without can_manage_inventory, check
  expiry, limit result pages and reject unexpected renderer filters. The
  frontend retains the POS lot/units/barcode-conflict response shapes. This
  is not a substitute for the remaining free-text POS search, checkout,
  patient, finance, returns, writes and large export migrations.

### Remaining dependency, licensing, hardware and operational gates

- Next.js remains 15.5.27, while internal PostCSS was safely resolved to
  8.5.29 without a major upgrade. The **one remaining HIGH production npm
  advisory is xlsx 0.18.5**, with no registry fix. A replacement needs
  comprehensive 191K-scale import/export, binary XLSX/multi-sheet and older
  Windows RAM/CPU parity testing. The release audit interlock intentionally
  remains red until that is resolved.
- Signed HTTPS activation, DPAPI auto-renew, revocation receipts, replay,
  TLS saturation and source rate limits are implemented locally; no real
  operator-approved production DNS/TLS certificate, private Ed25519 key custody,
  secret vault, backups/restore, monitoring, MFA-admin workflows or public
  ingress rate limits have been deployed or accepted. Physical distinct TPM
  computers, signed x86/x64 installer/updater, recovery, clock rollback and
  end-to-end release-profile GUI checks remain mandatory.
- Generic renderer SQL release-mode read/write denial and
  PHARMA_SECURITY_RELEASE_APPROVED publishing interlock remain active/closed.
  Windows 7 is **excluded** by TPM-required production licensing; the
  requested reminder is still unscheduled without a user-provided time.

### Final integrated verification, 2026-10-11

The implementation above was verified together on the live dirty worktree:

- **Pinned Rust 1.77.2 debug:** 201 tests, **200 passed**, zero failed,
  one deliberately ignored physical TPM test.
- **Pinned Rust 1.77.2 secure release profile:** with a freshly generated
  disposable Ed25519 **public** QA key, TPM-v2 mode and a non-routable
  `.invalid` HTTPS origin, **192 passed, zero failed, one ignored** (193
  tests). Legacy tests asserting debug-permissive arbitrary renderer SQL or
  MachineGuid-only production fingerprint were explicitly made development-
  only; a new release-only regression proves an active owner cannot use
  renderer-provided INSERT/UPDATE/DELETE/subquery writes in secure release.
  This does not weaken the native authorizer or prove GUI functional parity.
- **Complete Python HTTPS licensing test suite:** **36 passed**, zero failed,
  including signed revocation receipts and local TLS rate/capacity testing.
- **Complete Jest frontend suite:** **287 passing suites, 2,376 passing
  tests**, zero failures; one skipped suite and two skipped tests.
- **TypeScript, ESLint and static frontend:** `npx tsc --noEmit --pretty
  false` exited 0; `npm run lint -- --quiet` exited 0; `npm run
  build:tauri` compiled and exported all 70 static routes, restoring
  `src/middleware.ts`. `git diff --check` also passed.
- **Dependency audit:** 16 reported production vulnerabilities, comprising
  **1 HIGH (xlsx)**, 13 moderate and two low. The audit exits nonzero and
  correctly blocks release. No incompatible forced package major-upgrade or
  untested Excel library replacement was applied.
- **Migration acceptance:** synthetic seed generation successfully applied
  all 32 migrations and passed the fixed-path commercial preflight's
  equivalent read-only validation, with `password_hash=NULL`. Production
  pharmacy database and real operator license authority were not modified.

**Still blocking a commercial release:** the remaining xlsx high advisory and
dependency runtime parity, hundreds of untyped renderer SQL workflows still
denied in Cargo release, ambiguous historic patient ownership, full
role/tenant GUI and file-export acceptance, native offline enrollment/recovery
policy, true signed activation/renewal/transfer on distinct TPM-equipped
Windows 10/11 devices, trusted deployed HTTPS hostname/certificate/issuer key
custody/MFA/monitoring/backup/restore, signed x86/x64 installers and updater,
physical 191K-catalog memory/performance, and operator independent approval.
Publishing interlock remains unset/false; no commit, tag, deployment, signing
or customer SQLite changes occurred. Windows 7 reminder remains unscheduled.

## Follow-on native authorization and dependency hardening (2026-10-11)

This is an **additional, partial hardening increment**, not release approval.

- Desktop POS `searchDrugsAction` now obtains candidates and FEFO batches via
  `db_read_scoped` fixed IDs `pos.search_candidates` and the existing native
  `pos.barcode_batches`. Rust resolves active session/role/pharmacy from trusted
  storage. Search mode, term and pagination are bounded; SQL LIKE metacharacters
  are escaped. Barcode-lot matching, aggregate inventory, expiry checks, and
  acquisition-cost redaction are tenant-aware; no renderer-claimed tenant,
  arbitrary SQL or decrypted cache is used in the Tauri branch. The existing
  web branch remains for developer parity. Synthetic Rust tests assert cross-
  pharmacy stock and barcode exclusions, unauthorized/inactive users, disabled
  drugs, literal wildcard matching and query argument rejection. Frontend tests
  verify response-unit/batch shapes, native denial with no SQL fallback and
  no renderer-supplied tenant/actor. **Still requiring device acceptance:**
  Arabic-normalization search breadth, latency on lower-memory 25K-catalog
  devices and pagination behavior for broad search terms.
- `getShiftReportAction` is now backed by native `reports.shift_header`,
  `reports.shift_sales`, `reports.shift_returns` and `reports.shift_movements`
  with role `rep_can_view_shifts`. The shift ID is authorized from the native
  actor's pharmacy on each call, and the financial projections recheck tenant
  ownership in SQL. Sales/returns/cash movements also filter their own tenant;
  the original expected-cash, closing-count and handover formula remains in
  frontend. Synthetic A/B tests include foreign rows maliciously associated
  with a local shift, permission denial and invalid requests. These require
  runtime `schema::prepare_connection` compatibility scope columns for historic
  SQLite databases; `scripts/seed-db.js` alone does not represent a fully
  initialized native runtime. No customer DB was used to test this.
- `returns.getSalesInvoicesByDateAction` now invokes the dedicated native
  `list_returnable_sales_invoices_by_date` in desktop builds, passing a
  validated calendar date only. Native session + database actor resolve the
  `can_view_returns` privilege and pharmacy. Native fixed SQL preserves
  completed/approved/delivered status and finalized-return unit conversion,
  filters invoice/staff/stock/return links by branch, excludes foreign lot
  references, and bounds result size/time without silently truncating. Legacy
  invoice ID checks retain Arabic/slash/space identifiers while rejecting
  controls/SQL delimiters. The web development branch keeps its original SQL;
  signed Tauri does not fall back after native denial. Five Rust tests and
  frontend IPC regressions include synthetic A/B tenant, unauthorized/inactive
  actor, forged IDs, malformed dates, cross-branch lot, and upgrade schema.
- First-owner SQLx upgrade integration now uses the **same unchanged 001–032
  migration vector** as native licensed startup. New isolated synthetic tests
  cover the original migration-001 checksum/ledger, runtime compatibility,
  exact public bcrypt cleanup, edited owner/other-pharmacy owner preservation,
  restart and replay, NULL-owner bootstrap, and fail-closed handling of tampered
  SQLx migration checksums. An unexpected users-count SQL failure now
  propagates rather than being interpreted as zero users and initializing a
  new owner. The original historical migration 001 was not modified.
- Production SheetJS `xlsx@0.18.5` has been replaced with a pinned npm alias
  to `@e965/xlsx@0.20.3`, a **third-party community mirror**, not an official
  SheetJS release source. Vendor's documented authoritative distribution is
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and the mirror claims
  to republish the corresponding source from SheetJS. Synthetic XLSX/XLS
  multilingual and multi-sheet import/export parity tests are added. The full
  191,000-row, 15-column synthetic workbook was written/read and every one of
  2,865,000 cells compared exactly (PASS in roughly 75 seconds using an 8 GB
  Node heap); BIFF8 `.xls`, leading-zero barcodes and browser Blob/download
  were also covered. Independent provenance spot-check downloaded both the
  official SheetJS CDN 0.20.3 tarball and mirror archive, compared their 26
  file trees: 24 SHA-256-identical files, with differences solely in the
  mirror's README and package metadata. Installed JS entrypoints also matched
  the official tarball. This is evidence of content parity, **not publisher
  authentication**. The npm
  production audit currently returns **0 HIGH, 0 CRITICAL**, 13 moderate, 2
  low. The broader development-dependency audit still reports 3 critical,
  12 high, 16 moderate and 2 low; these need triage under the project's
  development/build threat model rather than being hidden by the production-
  only check. This removes the prior known `xlsx@0.18.5` production audit blocker but **does not
  constitute independent supply-chain provenance, integrity/patch verification
  or older Windows RAM acceptance**. Obtain operator/vendor approval and a
  reproducible trusted source/binary verification before commercial signing.

Evidence from the final integrated follow-on checkpoint: pinned Rust 1.77.2
debug **210 passed / 1 ignored** out of 211, pinned strict secure-release
Cargo **202 passed / 1 ignored** out of 203, both with zero failures,
the secure build using disposable random Ed25519 QA public
key, TPM-v2 test mode and a non-routable `.invalid` authority; complete Python
HTTPS licensing **36/36**; targeted POS and shift Jest **5/5**; TypeScript and
ESLint passed when run independently of Next's temporary `.next/types` cleanup;
npm production audit has zero high/critical. The new complete Jest run passed
**292 suites / 2,389 tests**, with one suite and three tests skipped, after
POS/shift/returns and spreadsheet tests were added. The 191K Excel stress is
separately gated, not run on every Jest invocation; an extra real XLSX
prototype-key regression also passed, though it is not a complete exploit
resistance proof. `npm run build:tauri` passed the optimized static frontend
build, generated all 70 pages and exported the bundle with middleware restored;
this is **not** a signed native installer. The complete pinned Rust retest
includes the final returns integration and the strict generic SQL release
denial test.
No real release-profile GUI or hardware acceptance is claimed by these
automated checks. Release approval remains disabled.

**Still blocking release:** remaining untyped renderer business SQL and native
write workflows (notably patient identity/balances, checkout adjuncts, returns,
purchases, stock and accounting), absent approved legacy patient ownership
policy, offline/manual license owner recovery, installed authority DNS/TLS,
key custody, operator MFA, monitoring/backup/restore, hardware TPM and
cross-device tests, signed installer/updater and performance/functional UI
acceptance on real Windows 10/11 devices. TPM-required production explicitly
excludes Windows 7. Its user-requested reminder remains **unscheduled**.

## Subsequent integrated hardening increment: native checkout, purchase lifecycle, shift and finance (2026-10-11)

**Not a release acceptance statement.** This section records another actual
implementation increment following the above 2,389-test baseline. A complete
product security migration and production-device acceptance remain open.

- Checkout Tauri IPC now accepts a strict `NativeCheckoutRequest` without
  `user_id` or `pharmacy_id`; extra/forged actor, role, tenant and SQL keys
  fail native deserialization. `process_checkout_critical` locks the trusted
  native session, reads the active database user's current pharmacy **inside
  `BEGIN IMMEDIATE`**, then dispatches existing checked sale/stock/loyalty/
  accounting logic. Desktop `processCheckoutAction` no longer makes generic
  renderer SQL reads for price authorization and suspended-invoice preflight:
  both validations were already performed by native Rust inside that sale
  transaction. Web-only behavior is unchanged. Synthetic test asserts actor
  reassignment/deactivation handling, cross-pharmacy identity derivation and
  hostile IPC field rejection; Jest asserts zero generic renderer SQL reads,
  no claimed identity/tenant and no fallback on native denial. Patient credit,
  wallet and loyalty operations still need an approved legacy patient-ownership
  policy before broad secure-release usability is accepted.
- Desktop purchase draft replacement, completed-edit and deletion paths no
  longer pre-read private purchase invoices through generic renderer SQL. The
  native transaction already checks status/ownership and linked stock; stale
  row preflights were independently unsafe/racy and unusable under strict
  release. Existing web-only reads remain. **Additionally in secure-release
  cfg only**, saving an existing purchase invoice without a checked original
  lifecycle status is denied instead of permitting a direct-IPC edit that
  bypasses the UI's concurrency token. Existing status comparisons and their
  stock/accounting rollback occur under the database writer transaction.
- Added native shared-shift ensure/open/close plus owner-only emergency
  force-close commands with live session/DB pharmacy and role permissions,
  serialized `BEGIN IMMEDIATE` and atomic cash/treasury/journal/activity-log
  reconciliation. Added fixed native current/shared selected-shift reads.
  Synthetic tests cover competing first opens, replay, cross-pharmacy/inactive
  roles, stale shifts, financial ledger symmetry and rollback. The matching
  desktop JS sends no purported actor or pharmacy. Renderer-scoped transaction
  injection is deliberately rejected instead of allowing unsafe mixed
  transaction writes. **Unmigrated** shift history/stats/receipts remain
  blocked in secure release. The finance cash movement/journal/journal-entry
  reads use fixed native SQL with active database actor/role/tenant and
  paginated bounded projections. Native A/B, revoked role, pagination,
  financial conversion and forged ID tests pass. Non-Tauri web/test paths keep
  their original SQL; Tauri never falls back after native authorization denial.
  Generic SQL is **not** reopened to make remaining GUI features work.
  Critically, cash movement/patient payment and other finance **writes**
  still use renderer transaction SQL and must be moved together to coherent
  native posting commands to avoid breaking journals/shift atomicity. Legacy
  patient ownership, treasury detail, purchase returns and additional shift
  views remain outside acceptance.

Final integrated checkpoint for this development increment: Rust 1.77.2
debug **222 passed / 1 ignored** (223 tests); strict secure-release Rust
**215 passed / 1 ignored** (216 tests) with disposable test key and `.invalid`
authority, neither a physical TPM/installer test. Python licensing **36/36**;
production dependency audit **0 HIGH / 0 CRITICAL** (13 moderate, 2 low);
synthetic reference seed read-only preflight PASS with NULL initial owner and
191,272 drug interaction records. The first full Jest run detected actual
finance browser-fixture regressions in historic installation tests; the
non-Tauri finance branch was restored without introducing a Tauri fallback.
Those original historic tests then passed **37/37** in focused retest and a
complete fresh Jest rerun passed **295 suites / 2,406 tests** (one suite and
three tests skipped), without weakening the upgrade assertions. The static
`npm run build:tauri` frontend build passed with 70 routes and middleware
restoration; `npx tsc --noEmit` and `npm run lint -- --quiet` both passed
after that build. `git diff --check` exit 0 and npm production audit exit 0
at final check. An existing packaged CDP business-flow script was updated to
use the new native checkout request shape and explicitly verify forged actor
and tenant keys are rejected; it passed static `node --check`, **not** a real
WebView2 release-profile run. These checks do not establish native signed-
installer GUI parity.

Release variable `PHARMA_SECURITY_RELEASE_APPROVED` remains unset/false;
publisher identity/provenance for the spreadsheet mirror still requires
operator approval. No customer pharmacy DB, private issuer key, public DNS/TLS
authority, real signing certificate, signed installer, firmware TPM acceptance
or Windows 10/11 native GUI release-profile acceptance is provided by this
increment. TPM-required commercial profile excludes Windows 7. Reminder time
is still unspecified and no reminder was scheduled.

## Continuation: purchase-native ownership, atomic cash movement and shift reporting (2026-10-11)

This is a **development hardening record, not commercial launch approval**.
The original worktree was reconciled (226 pre-existing status entries) and
preserved; commercial release workflow still requires the separate
`PHARMA_SECURITY_RELEASE_APPROVED == 'true'` operator setting. No customer
database, signing key, production server, physical TPM, deployment, or release
binary was used.

- Purchase save/delete desktop IPC now rejects actor/pharmacy/role/SQL fields
  via native DTOs. Rust obtains actor ID from `LocalSessionState` and obtains
  its fresh active pharmacy from SQLite **inside the writer transaction**;
  the existing purchase-role/permission, invoice-pharmacy and lifecycle checks
  still operate in that transaction. The renderer no longer does generic
  catalog SQL prechecks for new/completed purchase expiry/conversion. Native
  policy now explicitly rejects inferred single-container medication being
  saved with a fabricated non-one conversion factor; explicitly configured
  multipacks remain valid. Synthetic tests cover malicious IPC fields,
  inactive staff, live branch reassignment, bottle/drop/cream/spray inference,
  legacy configured multipacks and rollback of invalid medicine invoices.
- Native `create_cash_movement_native` now implements **standalone** desktop
  cash receipt/disbursement journal posting with a fixed DTO, real session
  actor, live role permissions and tenant, serial `BEGIN IMMEDIATE`, unique
  shift selection/creation, configured/expense/targeted account resolution,
  tenant-scoped movement and journal records, and balanced debit/credit.
  Failing account, transaction triggers, invalid input or unauthorized role
  rolls back the entire shift/movement/journal operation. Cross-tenant stale
  selected shift IDs cannot nominate a foreign drawer. Desktop IPC never
  falls back to generic SQL on failure. **Parent transactions** (expense
  posting and paper/bank workflows) that pass an injected renderer-owned DB
  intentionally fail closed and require end-to-end native atomic migrations;
  do not call them operationally complete.
- Shift history, current shift statistics and shift receipts are now backed
  by fixed read-only native projections with active DB tenant/permission
  checks, per-request row/byte/deadline limits and bounded history paging.
  History joins and sales/returns/cash aggregates are tenant filtered;
  receipt staff/patient display derives from verified sale/shift tenant
  ownership. Native close-shift discrepancy journal rows now store the
  authenticated pharmacy snapshot, so tenant-scoped finance reads can
  retrieve them. The old non-Tauri web SQL remains for compatibility and
  Tauri errors never trigger it.

Integrated continuation checkpoint: pinned **Rust 1.77.2 debug 235 passed,
1 ignored** (236 tests); pinned **secure-release Rust 228 passed, 1 ignored**
(229 tests, using a one-run disposable Ed25519 verification key and an
`.invalid` placeholder licensing hostname, never production credentials).
The first Rust debug run exposed a synthetic minimal-schema fixture requiring
the drug unit-name columns, and a Windows two-connection test file cleanup
race; both were corrected without weakening the security assertions, then
the full pinned suite passed. Python licensing **36/36**, full static
`npm run build:tauri` frontend export **70 routes**, TypeScript and ESLint
PASS, `git diff --check` PASS, packaged CDP JavaScript syntax PASS,
production npm audit **0 HIGH / 0 CRITICAL** (13 moderate, 2 low).
After native shift reporting was enabled, one legacy Jest test still expected
three unsupported commands; its assertions were updated to require precisely
the three native calls and no generic SQL. A POS all-patients shortcut test
failed under the simultaneous production build's CPU load but passed in a
dedicated retest. The two previously failing suites passed **30/30** in
focused rerun. The independent final full Jest execution after the static
build completed then PASSED **297 suites / 2,415 tests**, with one suite
and three tests skipped (298 total suites / 2,418 total tests). The stale
shift test and POS shortcut both passed. Final `npx tsc --noEmit` and
`npm run lint -- --quiet` passed with `src/middleware.ts` restored.
These checks remain synthetic/source-level evidence and do
not substitute for actual signed installer/physical GUI acceptance.

Remaining release blockers include secure native migration of patient
payments, medical/patient branch ownership, expense/paper transaction writes,
remaining stock/import/report data paths, review of the unofficial Excel
mirror publisher, operator-controlled production licensing/signing keys,
real physical Windows 10/11 TPM/downgrade/revocation trials, signed installer
and updater, and end-to-end GUI business and accessibility/print acceptance.
Windows 7 remains excluded from TPM-required release; no reminder scheduled.

## Native patient-debt settlement, expense and paper posting (2026-10-11 continuation)

**Release approval still forbidden.** This increment started with exactly
231 dirty/untracked/deleted Git status entries, `git diff --check` clean,
the existing `PHARMA_SECURITY_RELEASE_APPROVED` CI interlock intact, and prior
235 debug / 228 secure-release Rust, 2,415 Jest, 36 Python and zero HIGH
production audit as *reported historical* verification. No customer DB,
production issuer, signer, physical TPM, installer or archived migration was
modified. All additional migrations are forward-only.

### Implemented security and functional boundaries

- **Patient payment is no longer a renderer SQL transaction.** Fixed
  `post_patient_payment_native` accepts `patientId`, amount, method, date,
  optional shift/notes, and an anti-replay request ID; never renderer actor,
  role, tenant or account. It obtains active staff, pharmacy and both
  `can_view_patients`/`acc_can_process_cash_flow` from native session and live
  SQLite within a serialized `BEGIN IMMEDIATE`. It posts the cash movement
  (cash only), ledger debit/credit, audit log, patient transaction and
  provenance record as one transaction with rollback on any failure.
  Forward migration **033** creates `patient_payment_scope` solely for newly
  trusted transactions: historical patient and payment records are **not**
  assigned branch ownership. Settlement is allowed only when all of the
  patient's credit-invoice debt can be proven to arise in that single current
  pharmacy. It refuses other-branch sales, opening balance, unscoped historic
  transactions, financial notices, cross-branch account refunds and patients
  lacking qualifying credit invoices. This is a narrow **debt settlement
  exception**, not a general patient-ownership policy; profile search/edit,
  cross-branch patient statements and ambiguous records remain fail-closed.
  Replays with the same request ID are rejected. Cross-role/disabled staff,
  reassignment, cross-tenant debt, overdraft, malformed IPC and credit-entry
  trigger failures have isolated Rust and Jest negative tests.
- **Parent expense is one native transaction.** `create_expense_native`
  validates the same business fields but no JS identity/pharmacy/account IDs;
  resolves configured expense subcategory, cash drawer and current shift,
  inserts the expense row, tenant-scoped cash movement, balanced ledger,
  activity log, and replay metadata together. Migration **034** adds
  `expense_posting_requests`; no historical expenses are reclassified.
  Missing accounts, duplicate nonce, unauthorized/deactivated staff,
  foreign preferred shifts, non-finite amounts and forced ledger failures
  deny/roll back everything. The previous nested renderer transaction and
  detached cash posting are no longer used in Tauri; web-only behavior is
  retained. Existing expense deletion remains intentionally blocked when
  posted, pending an approved reversal workflow.
  The expense-history UI now uses `list_expenses_native` for Tauri, with live
  `can_view_expenses` authorization, branch-scoped staff join, validated date
  and category filters, and explicit refusal above 200 results rather than
  quietly returning a misleading partial ledger. The older web query is kept
  on the web-only path; Tauri never falls back to renderer SQL after denial.
- **Commercial-paper status change is native and atomic.** The
  `update_paper_status_native` command reads pharmacy-owned paper state,
  verifies live securities/cash permissions, updates status, then posts
  branch-owned shift cash and balanced ledger *inside the same transaction*.
  Already-cashed replay does not double post; cashed-to-pending/bounced
  requires explicit reversal. A historic cash movement against a paper still
  marked pending is detected and requires manual reconciliation rather than
  a second debit/credit. Foreign/inactive actor, malformed fields, concurrent
  state and synthetic trigger failures have tests. **Paper creation, deletion
  and broader treasury workflows are not fully native yet** and remain
  commercial release blockers.
- **Issuer HTTP parser hardening:** the HTTPS activation endpoint now rejects
  repeated JSON keys (including nested) and Python-specific NaN/Infinity
  before dispatching activation to the persistent signed authority. A new
  licensing regression checks normal JSON and these ambiguous malicious
  bodies. No real public server, certificate, signing seed or operator MFA
  has been deployed by this change.
- **Spreadsheet dependency:** installed graph confirms `next@15.5.27`,
  patched `postcss@8.5.29`, and alias `xlsx@npm:@e965/xlsx@0.20.3` with its
  existing import/export parity tests for Arabic, barcode leading zeros,
  multi-sheet inventory, BIFF8 `.xls`, browser export and prototype-pollution
  adversarial input. Publisher identity and supply-chain provenance remain
  unapproved by the customer/operator. The optional **191,000-row stress**
  test is not a physical low-RAM Windows acceptance, even if run synthetically.
  The third-party mirror explicitly describes its own automated npm publisher
  (`https://www.npmjs.com/package/@e965/xlsx`). SheetJS's official install
  instructions instead designate `https://cdn.sheetjs.com/` and the pinned
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` as authoritative.
  Supply-chain acceptance should compare the installed mirror's tarball/code
  integrity to an operator-reviewed official release, verify license and
  reproducibility, and decide whether to use a pinned, separately reviewed
  offline vendored official tarball. No automatic package substitution was
  made; an npm audit without HIGH findings does not authenticate a publisher.

### Verification and outstanding acceptance

The first full pinned Rust debug run with migrations 033/034 exposed five
*older fixture assertions* hardcoding 32 as the last migration. Those now
require 34 sequential migrations and the two new descriptions while retaining
SQLx checksum, upgraded-owner, rollback and cross-pharmacy checks. After
fixing the assertions and expanding finance tests, complete **pinned Rust
1.77.2 debug passed 248 tests, 1 ignored** (249 total). The complete strict
`cfg(pharma_security_release)` Rust test build passed **241 tests, 1 ignored**
(242 total) with a disposable ephemeral verification key and intentionally
unroutable `.invalid` HTTPS origin; **not physical TPM or issuer acceptance**.

The final full Jest run, completed **separately from static Next building**,
passed **301 suites and 2,427 tests** (one suite and three tests skipped;
302 suites and 2,430 tests total). It includes historic same-machine upgrade,
unauthorized finance writes, all newly implemented patient/expense/paper
native IPC and migration tests, inventory/POS/return parity and GUI component
regressions. Python licensing **37/37** passed. The Next 15.5.27
`npm run build:tauri` **passed 70 routes**, then restored `src/middleware.ts`.
TypeScript, lint and final `git diff --check` completed successfully.
Production `npm audit --omit=dev --audit-level=high` still reports **0 HIGH,
0 CRITICAL** (13 moderate, 2 low); this does not constitute dependency
publisher validation. No signed Tauri/WebView2 installer was built.

Isolated seed created **only** at
`scratch/native-finance-20261011-qa/pharma_local.db` with 25,404 master drugs
and 191,272 interaction records. A **read-only** `better-sqlite3` connection
verified both new tables exist and are empty, the initial owner password hash
is `NULL`, `PRAGMA quick_check` is `ok`, and
`scripts/check-commercial-release-seed.js` preflight returns `true`. This is
not the bundled release DB nor any customer's `%APPDATA%` file. The worktree
contains pre-existing unrelated changes plus the new untracked source,
migrations and tests; these are deliberately preserved, not committed.

The strict generic SQL authorizer and release publishing interlock remain
unchanged. Further native migrations remain for patient records/ambiguous
balances, paper creation/deletion/reversals, financial notices, pharmacy POS,
stock and reporting/export paths. External production operator obligations
remain: trusted HTTPS DNS/certs, Ed25519 private/public issuer lifecycle,
issuer database backup/replay DR, admin authorization and MFA, hardware-bound
physical TPM trials on Windows 10/11, GUI release-mode workflows, low-spec
Excel import/export, signer and installer/updater chain acceptance.
TPM-required commercial release explicitly excludes Windows 7; the
requested Windows 7 reminder remains unscheduled without a supplied time.

## Further native paper and issuer hardening — 2026-10-11

**Decision remains DO NOT RELEASE.** This continuation was reconciled against
239 existing dirty/untracked worktree entries, 34 migrations and the prior
248/241 pinned Rust, 2,427 Jest and 37 Python test baseline. Nothing was
staged, committed, installed or published. The release workflow retains its
`PHARMA_SECURITY_RELEASE_APPROVED == 'true'` interlock, and the approval
environment value remained blank. Strict generic renderer SQL protections,
historical migrations 001–034 and unowned patient histories were not changed.

### Paper creation, deletion and bounded history become native on desktop

- New fixed `create_paper_native`, `delete_paper_native` and
  `list_papers_native` commands are registered in `main.rs`. Their
  `deny_unknown_fields` typed IPC takes business intent only; no renderer
  role, actor, pharmacy, account or arbitrary SQL is accepted.
- The native actor comes from `LocalSessionState` and the live SQLite user
  role, active status, permissions and tenant via `active_generic_actor`.
  The historical `acc_can_view_securities` permission is labeled
  *view and manage securities* in the staff permission catalog. Native
  create/delete resolve it from database state in `BEGIN IMMEDIATE`, and
  reject cross-pharmacy bank IDs inside the same transaction.
- Creation inserts the branch-owned pending paper, unique creation request
  nonce, and native tenant-tagged activity audit atomically. Forward-only
  migration `035_commercial_paper_replay.sql` retains unique nonces even
  after an unposted paper is deleted; no historic paper is backfilled or
  assigned inferred ownership. Duplicate IPC requests cannot silently
  recreate a deleted paper.
- Deletion is limited to the current authenticated branch and unposted
  pending/bounced/cancelled paper. A posted/unknown status or *any* historical
  cash movement linked by `source_type='commercial_paper'` and matching
  target ID blocks deletion for documented reversal/manual reconciliation.
  Audit insertion failure rolls back the deletion; no journal or shift
  is detached from its parent.
- Native history reads return fixed, branch-scoped columns in 100-row pages,
  ordered deterministically by due date and ID, refusing page numbers beyond
  499. The desktop action retrieves all pages up to 50,000 records and
  explicitly errors on overflow or incomplete native acknowledgements.
  It never silently truncates or falls back to generic SQL after denial.
  The original web-only database branch is unchanged. This offset-paged
  full-history action is *not* a streaming export or stable multi-page
  snapshot under simultaneous insert/update activity; large histories need
  keyset/snapshot-aware export before release.
- Rust synthetic tests cover live role deactivation/reassignment, missing
  actor, foreign paper/bank, unowned legacy bank, forged JSON claims, numeric
  and date invalidity, 208-row history pagination, duplicated request nonce,
  simultaneous two-connection replay, creation/deletion audit-trigger rollback,
  historical half-posted paper and subsequent cash/ledger status parity.
  Desktop Jest tests assert typed payloads, batch pages, error propagation,
  acknowledgment validation and no renderer SQL/session fallback. The
  035 migration regression verifies request and paper uniqueness without
  mutating historical patient or expense rows.

### Issuer and shift-history improvements

- `scripts/licensing/authority.py` no longer returns an untrusted stored
  `revocation_receipts.signed_envelope_json` verbatim. The issuer now
  validates bounded strict JSON, canonical signed tombstone identity, revoked
  grant semantics, Ed25519 signature matching against the current issuer,
  persisted machine/license/serial/timing state, and row consistency
  *before* nonce consumption. A previous legitimately signed, non-revoked
  activation substituted into revocation state now fails closed.
  `server.py` maps corrupt authority state/SQLite availability errors to
  sanitized HTTP 503 without leaking private database details. Tests cover
  stale signed-grant substitution, wrong-device/serial/timestamp payloads,
  oversized, duplicate and malformed JSON, transaction failure, issuer
  restart/repair and replay rejection over a disposable loopback HTTPS
  service. This still does not qualify production issuer key custody,
  public TLS ingress, MFA or recovery operations.
- The shift-history client now renders an explicit **load more** path rather
  than concealing records beyond the initial 100. The native already
  authorized paged history is consumed directly; the web branch now provides
  equivalent bounded page metadata. Client tests exercise page accumulation,
  duplicate IDs, denial/retry, stale filter and parent refresh races, and
  the explicit page-budget boundary. This is functional pagination, **not**
  signed installer GUI acceptance.

### Verified additional checks and remaining blockers

- Pinned Rust 1.77.2 debug: **253 passed, 0 failed, 1 ignored** (manual TPM).
- Pinned Rust 1.77.2 strict secure-release: **246 passed, 0 failed, 1 ignored**,
  using a disposable Ed25519 public verification key and `.invalid` HTTPS URL,
  not a production key or working production HTTPS endpoint.
- Python licensing discovery: **40 passed, 0 failed**; signed receipt
  substitution, storage-corruption recovery and HTTP error tests included.
- TypeScript `--noEmit`, ESLint `--quiet`, paper-focused Jest and
  forward-migration Jest passed. The complete Jest and static build results
  are recorded in the subsequent final-validation note once available.
- A **new, disposable** seeded database exists only at
  `scratch/native-paper-20261011-qa/pharma_local.db`. Read-only commercial
  preflight passed with the new 035 table present and empty, the first-owner
  password hash `NULL`, 25,404 master drugs, 191,272 interactions and
  SQLite `quick_check = ok`. This is neither the bundled release database
  nor any customer's database.
- Installed dependencies still identify `next@15.5.27`,
  `postcss@8.5.29`, `xlsx@npm:@e965/xlsx@0.20.3`. Production audit remains
  **0 HIGH/CRITICAL, 13 moderate and 2 low**, not third-party publisher
  authentication. No dependency replacement or advisory suppression occurred.

**Outstanding native business migrations:** globally unowned patients and
patient profile/notice operations, financial notices, manual journals,
bank/card/POS administration, additional purchases, inventory, returns,
accounting, reporting and large snapshot/streaming exports; expense history
still rejects over 200 matching records pending pagination/reversal design.
Further tests must cover physical checkout/FEFO, ledger and long-print parity.
**External approval gates:** actual issuer deployment/DR with operator MFA,
trusted HTTPS DNS/certificates, real TPM/clock/downgrade/restart/revocation QA
on Windows 10/11, real signed installer/update-chain and full GUI workflows,
unapproved mirror provenance and low-memory Excel import/export stress.
Never imply these are satisfied by green synthetic tests. Windows 7 remains
excluded from the TPM-required release, and its reminder remains unscheduled.

### Final integration results for this further continuation

After implementing the full increment and without running the static Next
builder concurrently with the frontend test suite, the **complete**
`npx jest --runInBand --silent --modulePathIgnorePatterns=.next` run passed
**303 suites / 2,436 tests, 0 failures** (one suite and three individual
tests skipped). Its run includes the new shift-history pagination component
tests, commercial-paper native IPC and forward migration 035 tests, the prior
finance/payments/returns/inventory/checkout regression suite and SheetJS
import/export parity tests. The **separate** `npm run build:tauri` passed
Next 15.5.27 compilation, type checking and **70/70 static routes**, then
restored `src/middleware.ts`. `npm ls` reconfirmed the installed SheetJS
alias and patched Next/PostCSS dependencies. None of these results substitutes
for physical signed-installer, WebView2/TPM or production issuer acceptance.

## Native financial-notice, manual-journal and expense-history continuation

**Decision remains DO NOT RELEASE.** The resumed agent reconciled **242**
pre-existing tracked/untracked worktree entries, 35 registered migrations,
middleware presence and the unset `PHARMA_SECURITY_RELEASE_APPROVED`
publishing condition before editing. No customer database, production key,
installer or unrelated untracked content was touched. No prior migration
001–035 was rewritten.

### New fixed native business operations and boundary tests

- `financial_notices_native.rs` adds
  `create_financial_notice_native` and `list_financial_notices_native`.
  A trusted `LocalSessionState` session identifies the actor. Live
  `users` role, permission `acc_can_view_notifications`, active status
  and pharmacy are re-read inside `BEGIN IMMEDIATE` for posting. CamelCase
  typed DTOs reject unknown renderer-selected role, user, pharmacy, account,
  SQL or journal claims. Inputs are bounded and amount is exactly two decimal
  places (validated with integer cents), with valid calendar date.
- **Forward migration 036**, `036_financial_notice_provenance.sql`, introduces
  `financial_notice_native_scope` for unique creation nonces, pharmacy IDs
  and optional explicitly linked patient adjustment transactions. Historical
  notices and patient transactions are not backfilled, retagged or inferred.
  In a single transaction, the command posts the notice, optional signed
  patient adjustment, replay/scope record, branch-owned daily journal,
  equal debit and credit entries, and tenant audit. Journal failure rolls
  everything back. A repeat request cannot produce a second notice.
- **Customer notice safety:** Patients do not have a trustworthy historical
  `pharmacy_id`. Native customer adjustment requires zero unassigned
  opening balance, at least one completed credit invoice belonging to the
  current authenticated pharmacy, no foreign-branch invoices/approved
  account returns, and **no** unscoped/foreign historical patient transactions
  or notices. Existing native payments and notice adjustments must have
  matching explicit provenance. A synthetic test exposed a SQL three-valued
  `NULL` trap in the legacy-transaction join; both the notice and patient
  payment guards now use non-null comparison semantics. The existing native
  patient settlement calculation recognizes only explicitly tagged signed
  notice adjustments. It continues to reject untagged legacy activity.
- **Supplier notice safety:** Suppliers and `suppliers.balance` are global
  records without reliable branch ownership. New native supplier-balance
  notices are **denied**, not guessed or posted against an unrelated branch.
  This is an intentional functional gap pending operator-reviewed provenance.
  Pharmacy-only adjustments preserve the existing paired account entry
  behavior, including their pre-existing distinction from a cash movement.
- **Notice history:** Fixed native 100-row pages use a trusted tenant tag and
  current permission, with same-tenant staff joins. History refuses to hide
  legacy notices lacking explicit trusted provenance rather than silently
  presenting an incomplete branch-specific balance. The frontend desktop
  path retrieves bounded pages and does not revert to renderer SQL on error.
  Legacy notice history needs a reviewed provenance workflow before complete
  desktop functional parity.
- `manual_journals_native.rs` adds
  `create_manual_journal_native` and registers it in Tauri. It uses
  `acc_can_make_daily_entries` from the active SQLite user and derives
  pharmacy only from the trusted session/DB. The original choice of account
  IDs is treated as **business intent** and checked against existing
  postable leaf accounts, never as an authorization source. The DTO refuses
  arbitrary SQL, selected user/role/tenant or parent record ID. Amounts
  cross IPC as strict two-decimal strings and are accumulated in checked
  integer cents, with 2–100 lines, balanced debit and credit totals, valid
  date, and bounded descriptions/notes. An atomic `BEGIN IMMEDIATE`
  commits tenant-tagged journal, all lines and tenant-tagged audit together.
  Canonical UUID-v4 request IDs derive a deterministic journal PK and
  durable audit nonce witness, denying sequential/concurrent retries even
  if a journal has been manually removed. This is *not* a tamper-proof
  immutable audit log; a hardened append-only posting nonce table and
  controlled journal reversal workflow remain prospective improvements.
- Native expense history has real 200-row paging instead of the old
  200-record hard refusal. It validates filters, tenant, active actor and
  `can_view_expenses` on every page, returns explicit scoped page/actor/
  pharmacy metadata and deterministic ordering. The client checks continuity
  across calls, duplicate IDs and complete page acknowledgements. It reads
  up to 10,000 records and fails explicitly if more exist; the web branch
  now also avoids a silent 200-row cutoff. Offset paging across concurrent
  writes does not provide a durable multi-page financial snapshot; a
  keyset/cursor or snapshot export remains to qualify.

### Adversarial and functional checks

Synthetic tests exercise two pharmacies, disabled actors, revoked/reassigned
roles, unauthorized actor and bank/account selectors, duplicate and concurrent
nonce requests, invalid decimal amounts/dates, audit/journal SQL trigger
failure rollback, foreign/unscoped patient histories, first-party scoped
patient-payment parity, posted voucher total and tenant segregation, and
expense history overflow and user/branch continuity. The native manual
journal two-writer test initially encountered a Windows *temporary SQLite
file cleanup* race after all journal/ledger assertions succeeded. Cleanup
was made best-effort after pool closure, following existing finance tests;
transaction logic and security checks were not weakened.

Pinned Rust 1.77.2 debug final verification: **272 passed, 0 failed,
1 ignored manual hardware TPM** (273 total). Python licensing discovery:
**40 passed**. TypeScript and focused native IPC regressions passed.
The npm production dependency audit remained **0 HIGH, 0 CRITICAL;
13 moderate, 2 low**. Other complete-suite results follow separately below
after their respective final commands complete; previous test totals must
not be treated as current if the worktree changes again.

The complete pinned Rust 1.77.2 **strict secure-release** binary test suite
also completed: **265 passed, 0 failed, 1 deliberately ignored** (266 total),
using an ephemeral public Ed25519 verification key and a test-only
`.invalid` HTTPS address. This validates strict-profile compilation and
synthetic checks, not production signing, physical TPM or public TLS.
`npm run lint -- --quiet` exited 0. The 40-test licensing suite passed.

Fresh disposable dataset:
`scratch/native-notice-voucher-20261011-qa/pharma_local.db`, created by
`node scripts/seed-db.js --dest ...`. Read-only
`scripts/check-commercial-release-seed.js` validation returned `true`;
the 036 financial-notice provenance table exists and is empty, the payment
provenance table remains empty, the first owner has `password_hash = NULL`,
there are **25,404** master drugs and **191,272** interaction records, and
`PRAGMA quick_check` returned `ok`. No customer or bundled database was
opened for these checks. The scratch preflight was read-only and
`query_only`-protected.

**Remaining blockers:** This is not a full native migration of all pharmacy
finance, procurement, POS, patient, returns, inventory, trial-balance and
export routes. Legacy unowned patients and suppliers need an explicit
operator-approved decision; other notice and transaction types must remain
fail-closed. A standalone manual voucher must not be conflated with cash
drawer movement settlement. Physical signed Windows 10/11 installer and
WebView2 UI acceptance, genuine TPM and issuer revocation/renewal tests,
production HTTPS signing/operator recovery, Excel mirror provenance and
low-RAM spreadsheet stress remain external gates. Windows 7 is excluded
from this TPM-required tier, and its reminder remains unscheduled pending
a user-provided time. The commercial publishing interlock stays disabled.

### Final integrated frontend evidence and release lockout

The final full frontend run
`npx jest --runInBand --silent --modulePathIgnorePatterns=.next`
passed **306 suites / 2,452 tests**, 0 failures (1 skipped suite and
3 skipped tests). This includes the new 036 migration/provenance tests,
financial notice and manual voucher native IPC, >200-expense history,
existing finance, purchasing, returns, POS, inventory, patient, SheetJS and
UI regression coverage. The later, separate
`npm run build:tauri` passed Next **15.5.27** optimized compilation, type
checking and **70/70** static routes, then restored `src/middleware.ts`.
The `--localstorage-file` Node warning did not fail the static build.
Independent `npx tsc --noEmit --pretty false`, ESLint, the dependency
audit, `git diff --check` and JavaScript syntax checks passed.

Full Rust debug **272 passed, 1 ignored**, strict secure-release
**265 passed, 1 ignored**, Python issuer/licensing **40 passed**;
none of the ignored/skipped manual and GUI/hardware acceptance cases
were silently enabled or represented as completed. Final synthetic seed
preflight remains read-only and successful. `PHARMA_SECURITY_RELEASE_APPROVED`
is still unset and the workflow checks it explicitly. These checks establish
an integrated source-hardening increment, **not commercial readiness**.

## Native bank, card-terminal and POS-device definition migration — 2026-10-11

**Release decision remains DO NOT RELEASE.** This continuation reconciled the
live repository at 248 dirty/untracked entries and 36 registered migrations,
with the approval interlock unset, before editing. Previous native financial
notices, patient settlement, manual journal posting, expense paging and issuer
controls were preserved. There was no customer database, production issuer
key, installer publishing, remote operator credential or unrelated-path
cleanup. All earlier migration sources 001–036 are unchanged.

### Fixed native definitions and historical transaction safety

- New `banks_native.rs`, `cards_native.rs` and
  `pos_devices_native.rs` register 12 fixed Tauri commands: create, update,
  delete and tenant-scoped read for each financial-directory type. The desktop
  `finance.ts` actions use only those commands; web development retains its
  distinct existing database-backed branch. No native failure falls back to
  generic renderer-selected SQL.
- All native writes authenticate through `LocalSessionState`; inside one
  `BEGIN IMMEDIATE` transaction they re-evaluate live SQLite active-user,
  role, permission and pharmacy state. No renderer-selected identity, tenant,
  role, account/journal IDs or SQL is accepted. Native bank writes require
  `acc_can_view_bank_accounts`, card writes
  `acc_can_collect_credit_cards`, and POS definition writes
  `acc_can_view_pos`; the existing read-only permission alternatives are
  preserved. These historical permission names combine viewing and management
  in some modules; separate create/edit permissions remain a policy-review
  item and were **not** invented by accepting frontend role claims.
- New bank/card creation supports the existing signed opening-balance
  semantics but commits the branch-owned directory row, correctly oriented
  debit/credit journal entries, posting nonce and tenant-tagged audit **in one
  locked transaction**. Missing, nonposting or identical ledger accounts,
  malformed decimal amounts and injected journal failures roll everything
  back. Card opening values cross native IPC as exact signed two-decimal
  strings; banks validate finite two-decimal values. Bank/card metadata update
  DTOs *do not contain mutable balances*. A nonzero balance cannot be
  overwritten through a disguised management request.
- Bank deletion requires an **exactly zero** finite balance, no linked cards
  or papers across *any* tenant, no known linked cash movements or opening
  journals, and no ambiguous bank-clearing posting in that pharmacy. Historic
  custom account mappings are not deleted speculatively. This is more
  conservative than the legacy renderer workflow because global bank-clearing
  ledger rows cannot prove a particular bank was unused. Card deletion
  requires exactly zero funds, no own opening journal or known sale/terminal
  reference, and successful atomic audit. Historic sales do not always store a
  card terminal ID; an explicitly approved reconciliation/retirement workflow
  remains necessary for genuinely ambiguous old data.
- POS directory creation initializes a **zero** balance irrespective of
  any caller's suggested `current_balance`; metadata updates never change
  it. Disabling a device with a nonzero or corrupt balance is rejected.
  Deletion checks current balance and explicitly linked historical cash
  movements. Because old `user_drawer` handovers never recorded a POS ID,
  *any* ambiguous drawer handover in the same branch also blocks deletion
  (but not a foreign-branch handover); a zero-balance device should be
  deactivated instead pending manual provenance review. Only otherwise-safe
  deletion removes the device and its direct category
  mapping inside one audited transaction. Existing checkout/shift handover
  lifecycle postings are *not* made secure merely because the directory
  CRUD is native: further transactional handover/POS migrations remain.
- New append-only migration
  `037_finance_device_create_requests.sql` stores globally unique
  request nonces, type (`bank`, `card`, `pos`), new integer record ID and
  native pharmacy. A nonce is retained even after a safely deletable
  definition disappears: retrying creation cannot produce a second device
  or duplicate opening journal. No legacy bank/card/POS ID or balance is
  changed/backfilled and historical SQLx migration checksums remain intact.
- Bank and card history reads return fixed, tenant-authenticated, 100-row
  pages with trusted `actorId`, `pharmacyId`, exact page and `hasMore`;
  the client refuses inconsistent acknowledgements, duplicate IDs,
  foreign branches, actor/pharmacy changes between pages and >50,000
  entries rather than silently truncating. POS device reads currently reject
  >1,000 rows explicitly. Offset pages under concurrent inserts or renames
  are *not* a stable snapshot; database-held keyset/cursor-based exports
  are still needed at scale.

### Synthetic adversarial coverage and bounded verification

The new Rust module tests cover live role revocation/disablement/reassignment,
forged extra DTO keys, foreign-bank IDs, cross-pharmacy records, negative and
positive opening balances and ledger orientation, zero-balance metadata
changes, incomplete/nonposting account configurations, duplicate creation
nonces across connections and after row deletion, journal/audit trigger
rollback, historical association deletion denial, and deterministic page
scoping. Corresponding new Jest IPC regression suites verify all desktop
actions omit renderer role/pharmacy/SQL, omit update balance claims, format
signed card cents and never fall back to generic SQL.

- Pinned Rust **1.77.2 debug**: **296 passed, 0 failed, 1 ignored** (physical
  TPM manual test); strict secure release under disposable Ed25519 public key
  and `.invalid` HTTPS URL: **289 passed, 0 failed, 1 ignored**.
- Python licensing discovery **40 passed**. TypeScript check passed. New
  bank/card/POS frontend and forward-migration Jest suites passed.
- Production `npm audit --omit=dev --audit-level=high` returned **zero
  HIGH, zero CRITICAL**, with 13 moderate and 2 low findings unchanged.
  No blanket audit suppression or dependency substitution was made; the
  unofficial `xlsx@npm:@e965/xlsx@0.20.3` package still needs independent
  publisher, licensing and hash/provenance approval.
- A newly seeded disposable database exists at
  `scratch/native-finance-devices-20261011-qa/pharma_local.db`. Its
  read-only commercial preflight returned `true`, migration-037 nonce
  table exists and is empty, initial owner password hash is `NULL`,
  25,404 master drugs and 191,272 interactions are present, and
  `PRAGMA quick_check` returned `ok`. It is **not** a customer or bundled
  installer database.

This is a coherent finance-directory security increment, **not** complete
commercial release readiness. Remaining high-risk workflows include bank/POS
handover posting and terminal identity reconciliation, shared historical
supplier/patient ownership, further POS/checkout, inventory, purchasing and
return mutation paths, native general finance/report/export snapshots, and
controlled financial reversals. External gates still require actual operator
HTTPS issuer and key custody, TPM/revocation/reboot/downgrade acceptance on
physical Windows 10/11, signed installer/update-chain and installed GUI
acceptance, as well as Excel provenance and low-RAM import/export stress.
Windows 7 remains excluded from the TPM-required tier; its reminder stays
unscheduled without a supplied time. The
`PHARMA_SECURITY_RELEASE_APPROVED == 'true'` CI guard remains present and
unapproved, and installers remain unpublished.

## Native handover transaction and tenant-scoped cash read continuation — 2026-10-11

**DO NOT RELEASE.** The resumed session reconciled the unchanged 37-migration
tree and existing finance/issuer work instead of restarting. A previously
unretrieved strict Rust 1.77.2 release run is now confirmed from its retained
session: **290 passed, 0 failed, 1 ignored** for the immediately prior
finance-device increment, using a disposable verification key and `.invalid`
authority URL. This is not physical TPM or issuer deployment proof.

### New native implementation

- `src-tauri/src/commands/handover_native.rs` defines
  `process_handover_native` for a normal shared-shift drawer handover.
  The renderer sends only a requested shift, counted cash, transfer amount,
  destination type and ID, receiving staff username and entered password,
  bounded notes and a request identifier. The native authenticated session
  supplies the actor, and live SQLite provides the actor's current role,
  `acc_can_view_handover` permission, active status, pharmacy, shift and
  receiver. Password validation uses the pre-existing native bcrypt verifier
  **inside the locked transaction**, including its disallowance of the
  historical universal bootstrap password.
- A single SQLite `BEGIN IMMEDIATE` covers checking that exactly one
  shared shift remains open for the trusted pharmacy, cash-sales/approved
  cash-refund and cash-movement reconciliation, the handover/discrepancy
  cash movements, validated owned bank/POS destination balance changes,
  configured postable-leaf-account balanced journal entries, closing the
  original shift, opening the replacement shared shift, and tenant-tagged
  audit. All are rolled back together on failure; stale or duplicate
  handover requests cannot close the same shift twice. Configured
  `bank:<id>` leaf posting mapping is honored only after destination
  tenant ownership is checked. The bank balance update handles legitimate
  negative opening balances rather than silently refusing them.
- Explicit denial covers other tenants' shifts, inactive/downgraded actors,
  wrong/foreign receiving credentials, foreign or inactive POS destinations,
  missing/group accounts, ambiguous multiple-open-shift state, unresolved
  prior transfers, invalid amounts, and failed journal/audit operations.
  Synthetic tests include concurrent writers racing for the same open
  shift, rollback, and signed bank/account mapping parity.
- **Managed staff close/deactivation is not migrated.** On desktop,
  `processHandoverAction` refuses `closeOnly`, `managedUserId`,
  `deactivateManagedUser` and authorizer-password modes before any SQL or
  native posting. That distinct workflow needs native owner credential
  reauthentication, last-owner safety and atomic staff/shift settlement.
  It is a clearly recorded functional release blocker, not a silent
  fallback to renderer transaction execution.
- `handover_reads_native.rs` adds
  `get_handover_details_native` and
  `get_shift_credit_sales_native`. Both use live native session/database
  actor and `acc_can_view_handover`, fixed tenant-scoped SQL, and one
  SQLite snapshot for all financial components of a requested shift.
  Handover expected cash honors previous transfer/cash-movement adjustment
  semantics. Strict numeric storage and finite-value validation rejects
  corrupt/nonfinite/overflow rows; SQLite aggregate zeros are explicitly
  cast to REAL so valid zero-transaction shifts decode correctly.
- The credit-sales read checks the current/selected *open* shift and its
  pharmacy, rejects results above 1,000 rather than silently truncating,
  and returns invoice totals without joining the historically unowned
  global `patients` table. Patient ID/name/phone are intentionally
  redacted. Desktop `handover.ts` now uses only the new typed native
  commands for posting, snapshot and credit-sales reads, validates
  acknowledgements, and never falls back to renderer SQL on denial.
  Existing separate web-mode behavior remains intact.
- No new SQL migration was necessary for this increment; migrations
  001–037 and their historical checksums were preserved.

### Synthetic and release checks

In-module handover tests cover multi-branch and multi-role authorization,
disabled and reassigned users, credential errors, negative bank balances,
custom leaf accounts, denied linked or inactive destinations, replay,
two-connection concurrency, every part of atomic rollback, old historic
cash/provenance ambiguity, source-row tenant isolation, patient privacy
redaction, and explicit credit-invoice limit failures. A new desktop Jest
suite checks the native-only handover intent/receipt/read contract, denial
of unsupported staff closures, incomplete data, and generic SQL fallback
prevention.

The focused combined native handover tests passed **21/21**, native desktop
Jest tests **6/6**, and TypeScript passed. Pinned Rust 1.77.2 complete debug
passed **316 tests, 0 failures, 1 ignored manual TPM**. Complete Python
licensing suite passed **40 tests**; production npm dependency audit remained
**0 HIGH, 0 CRITICAL, 13 moderate, 2 low**. The full final Jest rerun
passed **309 suites / 2,472 tests, 0 failures**, with 1 skipped suite and
3 skipped tests. Current strict Rust release results are recorded below;
the static frontend build is verified separately on completion.

Remaining major gates include native managed-staff closure; broader
financial handover/treasury history consistency; ownership of historical
patient and supplier records; residual renderer-owned POS, inventory,
returns, purchases and export operations; controlled ledger reversals;
long-history cursor/snapshot pagination; and genuine operator issuer/TLS,
key custody, physical TPM, signed installer/update-chain, GUI acceptance
and Excel provenance/low-RAM stress. Windows 7 stays excluded from this
TPM tier and its reminder remains unscheduled without a user-supplied
time. `PHARMA_SECURITY_RELEASE_APPROVED` stays unset and installers
remain unpublished.

### Pinned Rust and credential-boundary verification update

The full final source increment was built and exercised under pinned
Rust **1.77.2 debug: 316 passed, 0 failed, 1 intentionally ignored** and
strict secure-release with ephemeral Ed25519 public key and nonproduction
`.invalid` authority reference: **309 passed, 0 failed, 1 intentionally
ignored**. The ignored physical TPM case remains unaccepted. The complete
Python issuer/licensing discovery suite passed **40** tests, TypeScript
`--noEmit` and ESLint `--quiet` passed, and production dependency audit
remained **0 high / 0 critical, 13 moderate / 2 low**.

The first new complete Jest attempt found two assertions in
`native-credential-boundary.regression.ts` still requiring the old
`verify_handover_credentials` detached preflight, which would not
guarantee that the receiver remained authorized when the shift was
committed. These expectations were repaired to require a single
`process_handover_native` IPC containing receiver input for native
transaction-scoped verification, and to require managed-user close to be
denied without *any* IPC/renderer SQL. Their focused rerun passed **9/9**
tests. The complete subsequent Jest rerun passed **309 suites and 2,472
tests**, with no failures (one skipped suite and three skipped tests).
No production authorization was loosened to satisfy the old assertions.

The existing disposable 037-migration seed passed the read-only commercial
preflight again (`true`), `PRAGMA quick_check=ok`, 25,404 drugs,
191,272 interactions, empty finance-device nonce table and initial owner
`password_hash=NULL`. No real customer file was used.

### Final static-build and repository hygiene result

After the green full Jest rerun, `npm run build:tauri` completed exit 0:
Next.js **15.5.27** optimized compilation, type/lint check and **70/70**
static routes, with `src/middleware.ts` restored at the end. The Node
`--localstorage-file` warning did not fail the build. The complete handover
increment ends with **316 pinned Rust debug passed / 1 manual ignored**,
**309 pinned strict release passed / 1 manual ignored**, **40 Python
licensing passed**, and **309 Jest suites / 2,472 tests passed**
(one suite and three tests skipped), TypeScript and ESLint success,
and **zero HIGH/CRITICAL** production dependency audit entries. The fresh
source-level test count is not evidence of a signed installer or physical
TPM/operator acceptance.

Final hygiene: `git diff --check` exit 0, JavaScript syntax check exit 0,
middleware present, exactly **37 registered migrations** (no new migration
for handover), **257** dirty/untracked worktree entries preserved without
staging or deleting unrelated files, and the release workflow still contains
`if: ${{ vars.PHARMA_SECURITY_RELEASE_APPROVED == 'true' }}`, with the
environment value unset. Installed packages remain Next 15.5.27,
PostCSS 8.5.29 and `xlsx@npm:@e965/xlsx@0.20.3`. The Excel mirror's
publisher provenance remains unapproved, and no dependency was silently
replaced. **Commercial-release approval stays OFF, installers unpublished.**

## 2026-10-11 continuation: fixed owner-managed staff closure and handover bootstrap

**Release decision remains DO NOT RELEASE.** This is another bounded native
security and functional increment, not completion of all commercial gates.
Before editing, the connected Windows tree contained 257 dirty/deleted/untracked
entries and 37 registered migrations. Existing untracked implementation and
historical migration bytes were preserved. The approval environment value was
unset and the CI publication interlock remained active.

### Fixed native staff deactivation and closure

- NEW `src-tauri/src/commands/managed_staff_native.rs`, registered in
  `commands/mod.rs` and `main.rs`, defines two strongly typed serde camelCase
  commands with `deny_unknown_fields`: `deactivate_staff_native` (user intent)
  and `close_staff_shift_and_deactivate_native` (user, selected shift, counted
  cash, owner password, optional notes and canonical UUID-v4 request ID).
  Neither accepts a renderer actor, role, pharmacy or account selector.
- Both use `LocalSessionState`, current active database actor/owner role and
  explicit pharmacy-owned target staff within `BEGIN IMMEDIATE` writer
  transactions. Owner password reauthentication for financial closure happens
  **inside the same transaction** using the existing native bcrypt verifier;
  there is no detached credential preflight. Self-deactivation, last active
  pharmacy owner deactivation, stale and reassigned users are rejected.
- Ordinary deactivation audits its action atomically when no associated open
  shift requires reconciliation. If there is exactly one owned target open
  shift, it returns an explicit `OPEN_SHIFT` with the native cash snapshot and
  makes no mutation; multiple, unowned, cross-pharmacy or legacy username-
  aliased shifts fail closed rather than being assigned invented ownership.
- Managed closure requires the sole open shift to be explicitly scoped to
  the target's current pharmacy and owned by the selected active target. It
  rejects ambiguous linked invoices/refunds/movements, unresolved previous
  transfers, invalid or overflowing amounts and reused/stale requests. Cash
  reconciliation uses the same category rules as normal handovers: starting
  float plus completed cash sales, minus completed cash refunds, plus signed
  cash movement net excluding main-safe movements. The counted drawer is
  transferred to the pharmacy treasury; **no successor shift opens**.
- When a variance exists, its cash adjustment and balanced cash-drawer vs.
  cash-difference journal are posted in the very same writer transaction as
  the final shift status, treasury cash movement, staff disable and tenant
  audit. Injection failures roll back all parts, rather than recording a
  posted journal for a still-active employee or partially closed shift.
  Existing historic shift and business rows are never purged.
- Desktop `deleteUserAction` and `closeUserShiftAndDeactivateAction` now invoke
  these fixed commands exclusively; they do not use renderer-selected SQL or
  frontend session claims for authorization, and do not fall back to the old
  handover mutation when native denies. Native acknowledgement IDs, amount,
  variance and status are checked. Web-mode behavior was retained separately.

### Handover startup permission and tests

- `ensure_handover_shift_native` now uses trusted native authorization, the
  **live `acc_can_view_handover` permission** and SQLite writer serialization.
  It explicitly rejects multiple current shifts and unowned/incorrectly
  scoped legacy shifts. Desktop `getOpenShiftHandoverAction` invokes that
  command rather than `getLocalSession` and renderer SQL. A new native test
  checks permission removal, POS-only permission denial and disabled actors;
  desktop regression checks that native denials never fall back to SQL.
- The new managed-staff module's **12 focused pinned Rust tests passed**, with
  synthetic owner/password/tenant/last-owner denials, two-connection races,
  malformed payloads and history, positive and negative cash differences and
  injected audit/user/journal failures. The permission bootstrap native test
  passed independently. The newly added managed-staff frontend regression
  covers forged actor and tenant fields, malformed acknowledgement, denial
  without fallback and existing web behavior.
- Fresh **pinned Rust 1.77.2 debug full suite: 329 passed, 0 failed, one
  intentionally ignored physical TPM test**. Fresh **complete Jest: 310
  suites passed / 2,507 tests passed**, with one suite and three tests skipped;
  these skipped items were not executed. Complete Python licensing discovery
  **40 passed**. TypeScript `--noEmit --incremental false` and ESLint `--quiet`
  both passed; focused native handover bootstrap Jest **7/7 passed**.

### Newly detected shipping-seed blocker (not bypassed)

The separate read-only `node scripts/check-commercial-release-seed.js`
**FAILED CLOSED** against the currently present ignored local
`src-tauri/pharma_local.db`: it contains **one nonempty configured user
password hash**. Read-only SQLite queries confirmed exactly one user, one
configured hash, 25,404 catalog drugs, 191,272 interactions and
`PRAGMA quick_check=ok`. The file predates this increment and is not a
verified disposable release seed; it was **neither modified nor replaced**.
The hash itself was not read into a report or disclosed. This local artifact
must not be packaged. A fresh, explicitly disposable seed built from the
current migrations, with no usable credential, must pass the existing guard
before any release attempt; the check must never be suppressed, and an
unverified local database must not be overwritten as a shortcut.

Installed dependencies remain Next 15.5.27, PostCSS 8.5.29 override and
`xlsx@npm:@e965/xlsx@0.20.3`. Fresh `npm audit --omit=dev` reports
**0 high, 0 critical, 13 moderate and 2 low**; the audit exits nonzero from
these still-open advisories. Publisher provenance and long/low-RAM Excel
import/export acceptance are not approved.

**Still blocking approval:** residual renderer-owned high-value POS,
purchasing, stock, return/refund, bank/treasury, patient/supplier provenance,
reports/exports and reversal operations; historical reconciliation and
large-history pagination; independently accepted production license issuer,
TLS/DNS, key custody and operator controls; physical TPM; installed GUI,
signed installer/update acceptance; spreadsheet supply-chain review; and
the currently unsafe local shipping-seed artifact. Windows 7 is excluded
from this TPM tier; its reminder remains unscheduled without a time.
`PHARMA_SECURITY_RELEASE_APPROVED` remains unset, no release artifact was
published and no customer pharmacy database was touched.

### Final pinned secure-profile and frontend export verification for this increment

The complete additional verification finished after the implementation:
`rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --release --locked
--offline` with **a new ephemeral Ed25519 public verification key**, a
nonproduction `.invalid` HTTPS licensing origin and `tpm-v2` release profile
passed **322 tests, zero failures and one ignored manual physical TPM
scenario**. This is a strict software security-profile test, not deployed
licensing or TPM acceptance. The debug profile passed 329/0/1 ignored, and
both front-end validation and complete Python licensing passed as recorded
above. `npm run build:tauri` finished **exit zero, all 70/70 static routes
generated/exported** and restored `src/middleware.ts`; no Tauri installer
was built or published. The previously detected configured password in the
existing seed remains a real standalone commercial preflight failure. The
successful static frontend export must not be conflated with a green seed
preflight or production installer acceptance.

To isolate the seed-generator code from the stale local artifact, an entirely
new disposable destination was created under `scratch/` using
`node scripts/seed-db.js --dest scratch/release-seed-synthetic-20261011`.
The forward-migration generator completed successfully with 25,404 master
drugs and 191,272 interactions. The exact existing `validate` function from
`scripts/check-commercial-release-seed.js`, invoked read-only against this
separate generated database with the current migration/native source inputs,
returned **`ISOLATED_SEED_PREFLIGHT=true`**. The disposable scratch directory
was then safely removed after verifying that it contained only those generated
database/SQLite sidecar files. The preexisting `src-tauri/pharma_local.db`
was not opened for writes or overwritten. This demonstrates that the current
isolated seed process can produce an accepted seed, but does **not** make the
currently present local shipping target safe or authorize packaging it; the
default-path preflight against that target remains **BLOCKED**.

## 2026-10-11 continuation: native inventory lot creation and zero/delete

**Commercial release remains BLOCKED.** This increment follows, without
restarting, the completed owner-managed shift closure and native handover
work. Initial reconciliation found **259 modified/deleted/untracked worktree
entries**, **37 registered forward migrations**, no staged changes,
`src/middleware.ts` present and `PHARMA_SECURITY_RELEASE_APPROVED` unset.
Untracked source was treated as existing implementation, not disposable
files; existing historical migrations 001–037 were kept intact.

### Implemented inventory lifecycle security boundary

- NEW `src-tauri/src/commands/inventory_lots_native.rs` implements the fixed
  commands `create_inventory_lot_native` and `delete_inventory_lot_native`.
  Registered in `commands/mod.rs` and `main.rs`; both use the authenticated
  `LocalSessionState` actor, live `active_generic_actor` pharmacy/active state,
  `can_manage_inventory` permission and SQLx `BEGIN IMMEDIATE` locking. Typed
  camelCase `deny_unknown_fields` payloads reject actor, pharmacy, SQL and
  ledger-account forgery. No generic SQL fallback exists in desktop actions.
- NEW **forward-only** migration
  `038_inventory_lot_create_requests.sql` defines a durable globally unique
  creation nonce receipt, containing native inventory ID, drug, pharmacy and
  actor. This witness survives physical removal of an unreferenced empty lot,
  so an old client retry cannot create a duplicate stock record. The migration
  does not rewrite existing inventory, sales, return or adjustment records;
  startup registration and prior full-chain synthetic Rust expectations were
  advanced from 37 to 38. An independent Jest in-memory forward-migration
  regression verifies history preservation and nonce immutability after
  physical deletion.
- `create_inventory_lot_native` validates the selected live master drug,
  enabled/sellable status, expiry calendar, current large/medium/small unit
  ratios, 4-decimal fractional large-unit stock quantities, bounded 2-decimal
  selling price (including legitimate free-priced lots), and barcode ownership
  across the **entire shared catalog and all active branch stock**. The
  renderer's existing `unit` and `largeToMedium` fields are only assertions
  against current catalog values, not permission to change conversions. A
  mismatch fails instead of reinterpreting purchased/sold stock. Lot creation,
  durable nonce, pharmacy-tagged audit and existing native shortage recovery
  now commit or roll back together under the same writer transaction. No
  master-drug global barcode, official-price, unit ratio, or alternate tenant
  record is silently rewritten. Manual lot entry has no verified purchase
  cost, so cost_price stays zero; no inventory-value journal is invented.
- `delete_inventory_lot_native` requires the lot to have an explicit matching
  current pharmacy. It rejects negative, invalid, nonfinite and unsupported
  valuation, foreign/unowned or dangling sale, retail return, purchase,
  adjustment and historical supplier-return provenance. Positive stock is
  **zeroed rather than deleted**, with an adjustment, tenant audit and, where
  the existing trusted purchase cost produces exact currency cents, a balanced
  debit/credit journal **inside the same transaction**. Explicit invalid
  account mappings, missing/group/nonleaf accounts and trigger-induced
  journal/audit failures are rejected with rollback. The legacy COGS 4.1
  category remains a fallback only when no dedicated inventory-adjustment
  expense mapping exists; ledger-mapping policy still needs wider financial
  acceptance. Zero-quantity lots with any historical references or tagged
  journal remain preserved. Only an unreferenced empty lot can be removed.
- Desktop `addInventoryAction` and `deleteInventoryAction` now invoke these
  fixed native commands directly, discard frontend actor/pharmacy claims,
  validate creation/deletion identity and result shape, and notify stock UI
  only after native acknowledgement. The existing web-mode actions are
  preserved separately. The desktop add form's previously mandatory unit and
  conversion values are forwarded as live-catalog assertions rather than
  blocked wholesale. The `updateInventoryAction` and workbook bulk-import
  mutations **remain renderer-dependent release blockers**, not secretly
  considered migrated.

### Adversarial and integrated verification for inventory increment

- Worker synthetic native tests exercise expiry and FEFO order, fractional
  quantities, free-price parity, catalog immutability, foreign barcode owner,
  disabled/downgraded/reassigned actor, malformed IPC, missing native nonce,
  nonce replay even after deletion, history retention, wrong-tenant delete,
  balance-preserving quantity zeroing, journal sign/cost, malformed monetary
  history, invalid configured account, failed shortage recovery/journal/audit,
  and two-connection races on creation/deletion. The focused worker pinned
  Rust run passed 16 native tests before the final added zero-price parity
  test; the complete pinned debug suite below exercises the final source.
- Fresh complete **pinned Rust 1.77.2 debug: 346 passed, zero failed, one
  intentionally ignored manual TPM**. Fresh complete **Jest: 312 suites
  passed / 2,553 tests passed**, with one skipped suite and three skipped
  tests. Targeted inventory frontend and forward-migration suites passed
  **46** tests; the additional frontend worker bundle passed **97** tests
  across three relevant suites. TypeScript `--noEmit --incremental false`
  and ESLint `--quiet` both passed. Fresh Python issuer/licensing discovery
  remains **40 passed**. The npm production audit remains **0 high, 0
  critical, 13 moderate, two low** and exits nonzero due to these advisories.
- The unchanged existing `src-tauri/pharma_local.db` still **fails the
  shipping-seed preflight** because its sole owner account retains one usable
  password hash; this release guard was not disabled or worked around. The
  earlier independently generated disposable seed passed the exact validator
  and was safely removed, but the current local shipping target is **NOT
  approved**. No production/customer DB was modified or replaced.

**Still blocking commercial approval:** remaining desktop inventory quantity
updates and workbook import, stale/mixed-tenant stock history and supplier
ownership reconciliation, wider POS/returns/purchases/finance native domain
coverage, audited reversal/posting policies and large-history exports;
physical Windows TPM; genuine operator HTTPS licensing issuer and signing
key custody; signed installer/update and installed GUI acceptance; spreadsheet
publisher provenance and low-memory import stress; and the unsafe currently
present local seed artifact. Windows 7 remains outside the TPM-required tier
and its reminder stays unscheduled without a specified time. All release
approval flags remain OFF and no installer was published.

### Inventory adversarial post-integration corrections

An additional source review found a genuine orphan-barcode collision
boundary: historical positive-stock inventory with `drug_id=NULL` must block
another drug from claiming its barcode. The native global collision query now
checks `(drug_id IS NULL OR drug_id<>?)` instead of the weaker `drug_id<>?`;
an explicit synthetic cross-branch unattributed-barcode denial test was added.
The valued zeroing account resolver was also tightened: the canonical
inventory asset must actually be classified as an **asset**, and the expense
offset as an **expense**, each a postable leaf. An adversarial configured
wrong-type asset test was added. The new native zero-price parity case permits
legitimate no-charge stock without fabricating cost. No customer history was
modified. A complete **post-correction** pinned Rust 1.77.2 debug rerun
passed **346/0/1 manual TPM ignored**. A final secure-release Rust rerun was
run with ephemeral nonproduction verification inputs; it passed **339 tests,
zero failures and one ignored physical TPM scenario**, using an ephemeral
Ed25519 public verification key and a nonproduction `.invalid` HTTPS
authority. These synthetic debug/strict profiles are not real device/operator
acceptance. At that point there were **263** preserved dirty/untracked entries,
**38** forward migrations, no staged files, a clean diff and release approval
unset. The default shipping-seed credential preflight stayed BLOCKED.

### Inventory reviewer follow-up: fractional units and lost-ACK recovery

Independent adversarial source review identified three concrete functional
risks, addressed by a further bounded correction:

1. The stock-entry modal represents one strip from a 12-strip box as `1/12`,
   which has no four-decimal representation. The native quantity predicate
   now preserves bounded finite SQLite REAL fractions without inventing
   rounded stock. A synthetic native one-strip test verifies original
   fractional quantity and safe duplicate acknowledgement.
2. The modal can infer a displayed large-unit label when `master_drugs.large_unit`
   is NULL. It now only submits an inferred label after confirming no local
   unit edit, passes `unit:null` and `expectNullLargeUnit:true` to native, and
   Rust revalidates that the authoritative catalog column is STILL blank
   under `BEGIN IMMEDIATE`. Explicit persisted units remain exact assertions;
   stale catalog changes are rejected without silently converting inventory.
3. An IPC response may be lost after a successful native commit. The desktop
   add modal now holds a generated canonical UUIDv4 request nonce per stable
   form-payload fingerprint, reusing it on an uncertain identical retry and
   rotating only on changed intent/confirmed success. The **new unshipped 038
   migration**, which has never been distributed to customer installations,
   now additionally stores a SHA-256 digest of the original typed creation
   request bound to trusted actor and pharmacy. Rust returns the **original
   lot ID** when an identical live authorized actor retries the identical
   committed request; it does NOT insert a second lot, movement, audit or
   shortage update. Changed intent, different user/branch or missing/deleted
   original lot fails closed. Two-connection synthetic tests verify a single
   creation with equivalent successful acknowledgements. Historical migrations
   **001–037 were not edited or rechecksummed**.

The retry witness currently persists in the mounted modal only. Unmount,
process crash or restart can still lose the *client-side* pending request ID;
an approved persisted pending-operation journal and recovery UX are needed
for cross-session guarantee. The migration's permanent nonce witness and
transactional server guard remain useful even without that client feature.

**Fresh follow-up verification:** all **19 focused Rust inventory tests
passed**; complete Rust 1.77.2 debug **348 passed, 0 failed, 1 ignored
manual TPM**; strict secure-release Rust **341 passed, 0 failed, 1 ignored**
with an ephemeral key and `.invalid` HTTPS authority; Python licensing
**40 passed**; TypeScript and ESLint passed; static Tauri Next.js export
**70/70 routes passed** with middleware restored. Production dependency audit
still reports 0 HIGH/CRITICAL, 13 moderate and 2 low. The initial full Jest
attempt overlapping the frontend export had one middleware import suite
failure **because the build temporarily moved `src/middleware.ts`**; 311
other suites passed. The subsequent **sequential full Jest rerun**, after
the static export finished and `src/middleware.ts` was verified restored,
**exited 0: 312 suites passed, 1 skipped, 0 failed; 2,571 tests passed,
3 skipped, 0 failed; zero snapshots**. The previously affected middleware
suite passed. Do not run the static Tauri export concurrently with Jest.
The existing bundled seed still fails the read-only credential preflight,
intentionally. No customer database, installer, published release or approval
setting was touched. The commercial-release program remains unfinished.

## 2026-10-11 continuation: native inventory edits, adjustments, bounded import and durable recovery

This section describes a **new bounded security increment after** the verified
312-suite / 2,571-test inventory create/delete baseline above. Prior historical
test results remain attached to their original increments rather than being
silently rewritten.

### Desktop inventory mutation and unit/catalog integrity

- The desktop `updateInventoryAction` now invokes fixed
  `update_inventory_lot_native`, not a renderer SQL transaction. Rust derives
  the actor from the authenticated native local session and resolves the active
  user's current pharmacy and `can_manage_inventory` under `BEGIN IMMEDIATE`.
  The DTO denies unknown fields, requires the originally loaded quantity and
  local selling price for optimistic concurrency, and rejects stale lot
  modifications. Historical sales/returns/purchase and financial provenance
  constrain updates. The shared master drug's official price and unit ratios
  are never mutated by a lot edit; submitted conversion/unit fields are
  assertions against the live catalog only.
- The related desktop `createStockAdjustmentAction` now invokes the fixed
  `adjust_inventory_lot_native`, passing only lot ID, original quantity, new
  quantity and adjustment reason. Rust reads the actual selling price, cost
  basis, account mappings and tenant from SQLite; no renderer actor, cost,
  accounting account or tenant claim is accepted. Both native update and
  adjustment preserve fractional quantities, verify existing adjustments
  and ownership, write `stock_adjustments` and scoped audit, post balanced
  valued journals against appropriate postable account classifications,
  resolve recovered shortages on increases, and roll back their entire
  transactions on error. The web branches retain their prior behavior.
- The desktop `importInventoryWorkbookAction` now invokes fixed
  `import_inventory_lots_native` for **1–200 new lots of already existing
  authoritative catalog drugs**, rather than letting the workbook write SQL,
  use supplied lot IDs, mutate global catalog ownership or overwrite historical
  inventory. Typed rows are bounded; service/retired drugs, missing expiry,
  stale unit ratios, other-drug barcodes across every pharmacy, invalid
  amounts and unauthenticated or cross-pharmacy actors are denied. Native
  generated lot IDs have `cost_price=0` when no verified purchase cost exists.
  One `BEGIN IMMEDIATE` commits all lots, pharmacy audit, batch receipt and
  shortage changes or none. A typed SHA-256 batch-content receipt binds live
  actor and pharmacy; an identical workbook retry, even under a fresh nonce
  after app restart, resolves the original lot IDs without a duplicate stock
  posting. Missing/reassigned original lots or changed use of the same nonce
  fail closed. The native UI no longer calls the old SQL-driven cache reload.
  Existing web import behavior is retained.
- This deliberately **does not implement a full historical workbook restore**:
  desktop source sheets carrying shared `master_drugs` writes, historical
  inventory IDs, branch identifiers, unverifiable cost, ledger or catalogue
  prices are rejected. Full provenance-verified spreadsheet reconciliation,
  large-file streaming/stress and a separately accepted global master-catalog
  reconciliation workflow remain commercial-release blockers. Native bulk
  imports are not an escape hatch for shared catalog edits.

### Cross-session single-lot creation recovery: forward migration 039

- Added **new forward-only migration 039**
  `039_inventory_create_acknowledgements.sql`, after unaltered 001–038.
  It introduces a durable acknowledgement table separate from immutable 038
  creation receipts, and a content-hashed import receipt table. Native startup
  and migration-chain tests now expect 39 versions. No historical migration
  checksum, customer database or configured bundled seed was changed.
- A successfully committed `create_inventory_lot_native` is NOT treated as
  operator-acknowledged until an **explicit post-verification user action**
  calls the fixed native `acknowledge_inventory_create_native` command.
  The native action binds the original receipt, original stock lot and active
  authorized actor in the **same pharmacy**, and commits an audited
  acknowledgement atomically. An automatic ACK immediately after the native
  creation call is intentionally **prohibited**: the automatic ACK's own
  successful commit might lose its IPC response, clearing the pending gate
  despite an uncertain UI result after a crash. Repeat explicit operator
  acknowledgement is idempotent. The native writer checks this table under
  the creation transaction lock: a *different new nonce* is denied while
  **any actor's** earlier committed creation in the pharmacy remains
  unacknowledged. Changing staff accounts therefore cannot bypass recovery;
  another active inventory manager in that same pharmacy can view the pending
  original and explicitly reconcile it, with their native identity audited.
  The original same-nonce, same-typed-intent replay still returns the original lot ID
  without stock changes. Bulk import also refuses to bypass an unresolved
  single-lot creation.
- On desktop modal remount or app restart, the UI calls
  `list_unacknowledged_inventory_creates_native`, refuses new additions
  while recovery is unresolved, and displays the committed lot identity,
  original creator, drug, quantity and date for explicit operator verification.
  Even when the initial native creation response arrived normally, the
  success toast instructs the user to review the persisted receipt at the
  next entry before adding more stock; creation never automatically clears
  its own durable recovery guard. The operator
  may acknowledge the *existing* lot via native authorization without
  adding another lot. Failures and unavailable/moved originals require
  separate reconciliation instead of silent re-creation. A lost native
  acknowledgement reply can be retried with the original nonce. Native
  pending operations are kept in the licensed SQLite database rather than
  volatile renderer local storage.
- This is recovery by **explicit verified operator acknowledgement**, not
  automatic guessing after an unobserved crash. A malicious or mistaken
  operator acknowledgement and physically missing/corrupt historical lots
  still require workflow audit and financial/stock acceptance. An unacknowledged
  receipt intentionally blocks fresh writes instead of inferring success.

### Activation trust-boundary correction

The online native activation client previously installed a correctly signed
authority response before checking that its signed `license_id` matched the
requested credential. A mismatched signed response could therefore modify
the durable lease/clock anchor even though the IPC returned failure. Online
activation now calls `LicenseGuard::install_online` with the *expected license
ID*, verifies the signed claims and expected ID under the native guard mutex
**before protected-state writes**, and applies the rule to revocation
tombstones as well. The focused native regression covers correct and
wrong-license signed grants and revocation. This is not evidence of real
production issuer custody, deployment or physical TPM acceptance.

### Verification and remaining commercial gate

- Pinned Rust 1.77.2 **post-branch-wide-gate full debug: 368 passed,
  zero failed, one ignored** physical/manual TPM scenario. Pinned strict
  **synthetic secure-release: 361 passed, zero failed, one manual TPM ignored**
  using an ephemeral Ed25519 verification key and nonproduction `.invalid`
  HTTPS authority. These include the 29 focused native inventory
  lifecycle/adjustment cases, 5 bounded native import cases, 4 recovery
  tests, 39-migration startup chain, same-pharmacy operator reconciliation
  and signed online activation-ID regression. Neither suite exercises a
  production issuer, deployed signed installer or provisioned physical TPM.
- Python licensing issuer: **40 passed**. Focused affected frontend,
  migration and recovery Jest: **5 suites / 93 tests passed** after adapting
  a legacy test to the new native-only import ACK contract.
- An initial post-change full Jest run reported **312 suites passed, 1 failed,
  1 skipped; 2,580 passed and 1 failed, 3 skipped tests**. Its sole failed
  expectation assumed the old renderer import could accept an empty workbook.
  After updating that regression to the fixed native contract, **two
  sequential complete Jest reruns exited 0: 313 suites passed, 1 skipped;
  2,581 tests passed, 3 skipped, zero failures, zero snapshots**. The final
  rerun also covered the stricter pharmacy-wide crash recovery and explicit
  (non-automatic) acknowledgement semantics. The separate
  `npx tsc --noEmit --incremental false` and `npx eslint . --quiet`
  commands exited 0. The Tauri frontend static build exited 0 and exported
  **70/70 routes**, restoring `src/middleware.ts`. Jest and the static
  export were kept sequential to prevent the previous middleware move race.
- The production dependency audit still exits 1 with **15 advisories**
  (13 moderate, two low; zero reported high/critical), not resolved by a
  forced dependency upgrade. Commercial seed preflight still correctly
  **BLOCKS** the untouched `src-tauri/pharma_local.db` because it contains
  a configured password hash. There is no commercial approval or publisher
  claim based on synthetic tests.
- A further **final Tauri static export against the completed explicit-ACK
  frontend source** exited 0 with 70/70 routes after the final Jest run; its
  build script restored `src/middleware.ts`. Final worktree hygiene:
  **269 modified/untracked entries preserved** (264 present before this new
  bounded increment), **39** forward SQL migrations, **zero staged files**,
  `git diff --check` exit 0, middleware present, approval environment variable
  unset, and the unchanged workflow still requires
  `vars.PHARMA_SECURITY_RELEASE_APPROVED == 'true'`. No customer database,
  seed, historical migration or release artifact was overwritten. No commit,
  installer publication, production key provisioning or release approval
  was performed.

**Still blocking all commercial release:** credential-bearing shipping seed;
production dependency and supply-chain acceptance; physical TPM and real
device tests; actual production HTTPS issuer/signing-key custody; installer,
update signing and installed GUI verification; global historical inventory
and accounting reconciliation, inventory-adjustment ledger policy acceptance,
full historical workbook provenance and large-import stress; remaining
renderer-controlled inventory reads/exports and wider POS/returns/purchasing/
finance domain coverage. Existing Windows 7 tier limitation and unscheduled
reminder remain unchanged. Release workflow approval must stay OFF.

## 2026-10-12 continuation: native inventory Excel export, bounded workbook intake, cross-session replay tests

This is a **new bounded implementation increment**, not a re-verification of
the 2026-10-11 inventory mutation/recovery increment above. The incoming
repository still had 269 dirty/untracked entries, migration 039 was latest,
the release workflow approval variable was unset, and middleware was present.
No prior dirty/untracked files, migration 001–039, customer database, bundled
seed, or release approval was deleted or rewritten.

### Fixed native export ownership and deliberate disclosure limit

- The inventory-table Excel export no longer performs `SELECT i.*`,
  `SELECT md.*` or passes the displayed `pharmacyId` to renderer SQL in
  the desktop application. The UI calls **no-argument**
  `export_inventory_snapshot_native`, with a fixed Rust projection and
  authoritative current native local session, database-owned live actor
  pharmacy and `can_view_inventory` or `can_manage_inventory` permission.
  Permissions, branch assignment and both source tables are examined inside
  one `BEGIN IMMEDIATE` snapshot transaction. Unowned NULL-pharmacy lots
  are deliberately excluded even for the default branch; foreign lots and
  orphaned/malformed master records cannot enter the export.
- The native snapshot returns only inventory IDs, drug IDs, owned pharmacy,
  quantities, local selling prices, expiry, barcode, batch metadata and
  verified unit factors, plus a **restricted shared-master catalog sheet**
  for drugs actually present in that pharmacy's stock. Supplier information,
  acquisition cost, private notes/clinical fields, tax/discount configuration
  and official global catalog prices are **not** included. No master-catalog
  write occurs. Barcode resolution is limited to the same lot, its
  authoritative master or a stable same-drug/same-pharmacy candidate.
- Export is deterministic and explicitly capped at **10,000 lots** under a
  single transaction, returning a fail-closed overflow error rather than
  silently truncating data. It supports the legacy inventory layout without
  a per-lot `medium_to_small` column. This is an operational inventory
  **snapshot**, NOT a full-fidelity, financially authorized archive or a
  reverse-importable disaster-recovery image. Separately authorized full
  backup, large export pagination/streaming and financial provenance
  acceptance remain pending.
- The existing workbook writer `write_binary_file` additionally checks a
  **32 MiB** byte limit and ZIP local-header prefix `PK\x03\x04`. These
  basic guards are not proof of a fully parsed or malware-safe XLSX file.
  The existing dialog save destination/overwrite trust boundary still needs
  dedicated native operator-policy review before commercial approval.

### Desktop import parser and replay hardening

- Native desktop workbook selection is XLSX-only and rejects files above
  **2 MiB** *before* the SheetJS parser. The worksheet address range is
  checked against **200 new-lot rows / 40 columns** before conversion.
  The desktop UI rejects an included `master_drugs` worksheet rather than
  submitting shared catalog changes, and rejects absent/malformed sheets.
  Duplicate same-tick imports are guarded in the UI, reader errors/aborts
  fail closed and file inputs reset after completion. The browser/web path
  retains its existing workbook behavior.
- Two additional file-backed Rust tests exercise separate SQLx connections
  and reopen/restart-like retry: same nonce or identical content under a new
  nonce yields one durable stock post and one original receipt; moved lots
  block replay. Competing distinct batches under a reused nonce allow one
  commit and reject the conflict; failures in later batch rows roll back
  stock, receipt, audit and shortage changes. The previous pharmacy-wide
  unresolved single-create guard was already correct and intentionally
  **not reimplemented**. The initial new tests exposed only Windows temp-file
  sharing on cleanup; explicitly closing the connection and waiting briefly
  for file-handle release made the **seven focused import tests pass**.

### Verified tests for this increment

- Pinned Rust 1.77.2 debug full native suite:
  **376 passed, zero failed, one intentionally ignored manual physical TPM
  test**. This includes the six native export tests, seven bounded native
  import tests, the 39-migration startup chain and prior licensing coverage.
- Pinned synthetic secure-release Rust profile with a new ephemeral
  Ed25519 verifier and `.invalid` HTTPS issuer endpoint:
  **369 passed, zero failed, one intentionally ignored physical TPM test**.
  These are synthetic config/compiler and regression outcomes, not a
  production key, endpoint, actual hardware acceptance or installer release.
- Python issuer/licensing tests:
  **40 passed**. Focused frontend inventory export/import UI:
  **2 suites, 11 tests passed**. TypeScript and targeted ESLint were already
  green before the final complete JavaScript/lint/build sequence.

**Commercial release remains BLOCKED** by the credential-bearing unchanged
bundled seed, 15 tracked dependency advisories pending approved remediation,
production HTTPS issuer and secure signing-key custody, real TPM provisioning/
device acceptance, signed installer and upgrade smoke tests, full authoritative
historic inventory/accounting and catalog reconciliation, financially privileged
backup/export and restore policy, extremely large workbook stress testing and
other outstanding native domain read/write trust boundaries. No seeded
credentials were forged, no production operator signoff was inferred, and
the release workflow approval flag must remain unset.

### Final sequential verification and hygiene, 2026-10-12

- After the last native export performance change, the complete pinned Rust
  1.77.2 debug run exited **0: 376 passed, 0 failed, 1 ignored** (manual
  physical TPM). The complete pinned optimized synthetic secure-release
  profile exited **0: 369 passed, 0 failed, 1 ignored**, with an ephemeral
  verification key and deliberately nonproduction `.invalid` HTTPS origin.
  The seven native import tests and six native export tests were also run as
  focused groups and passed. The Python licensing issuer suite exited **0:
  40 passed**.
- `npx tsc --noEmit --incremental false` and `npx eslint . --quiet` each
  exited **0**, then the **sequential full Jest rerun** exited **0:
  314 suites passed, 1 skipped; 2,585 tests passed, 3 skipped; no failures
  or snapshots**. This includes the new four-test native export and workbook
  denial UI suite, plus the intact web inventory tests.
- Only **after full Jest completed**, `npm run build:tauri` exited **0**:
  Next.js compiled, typechecked and statically generated **70/70 routes**;
  its script restored `src/middleware.ts`. No installer was published.
  The read-only credential-bearing seed preflight still exited **1
  (BLOCKED)** because the original bundled database has a configured
  password hash; it was not cleared, replaced or bypassed. Read-only
  production `npm audit --omit=dev --json` still lists **15 advisories:
  13 moderate, 2 low, zero high/critical**; no forced update was performed.
- Final hygiene: **271 dirty/untracked entries** versus **269** on entry
  to this increment; **zero staged files**, 39 total forward migrations,
  `git diff --check` exit **0**, middleware present and release approval
  environment variable unset. Original dirty release workflow, historical
  migration 038, bundled seed and any customer database were preserved.
  The original release workflow still requires explicit
  `PHARMA_SECURITY_RELEASE_APPROVED == 'true'` before publication.
  There was **no** physical TPM run, live production issuer signing,
  operator acceptance, release signoff or published installer.

## 2026-10-12 continuation: owner-custodied backup, native workbook destinations, cross-process licensing replay

**Worktree reconciliation:** The connected Windows workspace recovered after
the prior chat/bridge interruption. On entry it had **274 dirty/untracked
entries, zero staged**, migration **039 still latest (39 SQL migrations)**,
`src/middleware.ts` present and `PHARMA_SECURITY_RELEASE_APPROVED` unset. The
prior inventory CRUD, durable nonce/ack recovery, fixed native inventory
import/export, and previous 376/369 Rust and 2,585 Jest results remained as
documented above; this increment did not reconstruct or rewrite them. The
interrupted workers' partial `database_backup.rs` and `licensing.rs` patches
were inspected and integrated, not duplicated. No historic migration or
bundled/customer DB was modified, and no release artifacts were published.

### Full-system backup trust and historical financial integrity

- `export_database_backup` retains its IPC shape but now authenticates its
  claimed user with the live native session and checks a **current active
  owner role plus freshly bcrypt-verified owner password**. An ordinary branch
  `admin` must not export a database containing every pharmacy's patients,
  suppliers, stock costs and accounting history. The distinct trusted internal
  `require_backup_admin` helper used by catalog repair remains unchanged;
  frontend maintenance hides complete backup from branch admins.
- Backup snapshot uses SQLite `VACUUM INTO` (including committed WAL), a
  unique per-run UUID subdirectory and `.partial` filename, `create_new` for
  manifest, a **1 GiB** size guard, path-component symlink/Windows reparse
  detection, `PRAGMA integrity_check(100)` and `foreign_key_check`, read-only
  backup re-open and revalidation, SHA-256 streamed in 64 KiB blocks, flushed
  output and final unique paths. The adjacent JSON manifest records snapshot
  checksum/length, UUID, creation time, source-path digest and authenticated
  owner (for full export). The data and manifest are marked read-only after
  publication; incomplete private output has best-effort cleanup.
- For schemas with accounts/journals, backup validates each journal entry's
  account/journal references, debit/credit direction, bounded finite numeric
  amount and balanced debit/credit totals (tolerance 0.005). Missing accounting
  table siblings are rejected. The **external** owner-authenticated full export
  also requires modern `users` and `inventory` provenance. **Trusted internal**
  pre-migration catalog-repair backups may capture partial historical schemas,
  but still undergo applicable financial/SQLite checks; this distinction
  restored a known genuine `schema::tests::restores_csv_metadata_by_name...`
  compatibility test without weakening external full export.
- Windows backup regression initially found `Access is denied. (os error 5)`
  when syncing an isolated `.partial` through a read-only file handle.
  `FlushFileBuffers` now uses a writable handle before sealing the archive
  read-only. The three focused native backup tests subsequently passed,
  including WAL snapshots, distinct no-overwrite history, live owner/admin
  denial, unbalanced/orphaned journal rejection, and manifest hash equality.
- **Not an independently signed, tamper-proof, multi-tenant approved restore
  package.** The manifest is a local checksum/provenance aid, not a production
  signature or an authoritative historical opening-balance reconciliation.
  The legacy `src/lib/db/client.ts::restore()` which previously replaced the
  live DB without authentication, source lineage, WAL and financial validation
  now explicitly refuses operation. Online destructive restoration is **not
  implemented** pending accepted offline signed/authorized recovery, tenant
  history checks, restart/rollback/replay policy and operator rehearsal.

### Fixed desktop catalog and inventory Excel output trust boundaries

- Removed the desktop-exposed arbitrary-path `write_binary_file` registration.
  Both desktop `InventoryTable` and `ItemsManagementClient` now use a native
  `save_workbook_export_native(kind,data)` command; the OS Save dialog is in
  Rust, not a renderer-supplied path. It checks an authenticated native session,
  current database actor/role/permissions before and after the dialog,
  recognizes only `inventory` or `catalog`, validates `.xlsx` ZIP header and
  <=32 MiB data, excludes app-data destination, refuses existing paths, and
  opens with exclusive `create_new`. If writing/sync fails, its exclusively
  created incomplete file is removed best effort. The browser/web branch
  retains its prior non-native export route.
- New fixed `export_master_catalog_native` is actor-authorized in an immediate
  SQLite snapshot with `can_manage_inventory`, explicitly projected global
  `master_drugs` fields, deterministic order and a 10,000-row fail-closed
  limit. Neither a renderer-supplied SQL statement nor a pharmacy-specific
  master catalog is authorized. The two native catalog tests confirmed live
  revoked/inactive permission denial, secret-field exclusion and rollback on
  invalid official prices. The native file writer refuses an already existing
  file or the live app database directory in a separate Rust test.
- The bounded **desktop new-lot XLSX import** now also parses ZIP directory
  metadata **before SheetJS decompression**, rejecting ZIP64/multi-disk,
  malformed local-vs-central headers, duplicate/unsafe entry names,
  encrypted/unsupported entries, >128 entries, declared total expanded >16
  MiB, per-entry >8 MiB, or >4 MiB declared worksheet XML. Four realistic
  and forged-archive tests passed. Existing 2 MiB compressed intake, 200
  stock rows/40 columns and no shared-master catalog import remain intact.
  **The declared sizes are untrusted**; this is useful preflight defense,
  NOT a proven hard-memory bound against malicious DEFLATE output. A streaming
  ZIP/XLSX decompressor with enforced actual expanded-byte budget and
  low-memory physical stress evidence remains necessary for gold-standard
  acceptance.

### Native signed license replay window

- `LicenseGuard` previously used an in-process mutex only. Two concurrent
  Windows application instances could both read the same DPAPI monotonic
  anchor and later let an older legitimately signed grant race a newer signed
  revocation. A Windows `OpenOptionsExt::share_mode(0)` lock on the native
  license-state file now serializes state reads, verification, clock/serial
  anchor advances and installs across processes. Contending attempts fail
  closed rather than proceeding on stale local state. A new Windows Rust test
  confirms two independent guard objects cannot overlap access and that the
  lock is reusable after release; existing signed Ed25519 anchor/revocation
  tests are retained. This does not prevent a privileged local actor rolling
  back **both** sealed files, solve untrusted offline clocks, or deliver
  immediate revocation without a network connection.

### Evidence and acceptance boundary

- Fixed compile regressions discovered by the first focused Cargo invocation:
  three attempts to move actor values out of the native session RwLock guard,
  and a Windows file-lock `Result<File,&str>`/`Result<File,String>` mismatch.
- Pinned Rust 1.77.2 **full debug** after final backend changes:
  **382 passed, zero failed, one deliberately ignored physical TPM test**.
  The first full run failed only the old pre-migration catalog-repair backup
  test; the revised strict-external/trusted-internal backup provenance checks
  passed that isolated test and then the complete suite.
- Pinned Rust **optimized synthetic secure-release** with an ephemeral Ed25519
  verifier and deliberately nonproduction `https://licensing.example.invalid`
  issuer: **375 passed, zero failed, one deliberately ignored physical TPM**.
  No real production issuance, TPM or signed installed binary accepted.
- Python issuer/licensing suite **40 passed**; TypeScript checked successfully;
  targeted ESLint passed; native/catalog/owner/lock focused tests passed;
  targeted frontend **5 Jest suites, 48 tests passed** (inventory and catalog
  export, backup screen, restore denial and ZIP archive preflight).

- **Final full Jest, deliberately completed before the Tauri static build:**
  `npx jest --runInBand --silent` exited **0**, with **316 suites passed,
  1 skipped; 2,591 tests passed, 3 skipped, zero failures**. This was run
  after finishing the archive validator, desktop catalog UI and owner-only
  backup UI. `npx tsc --noEmit --incremental false`, `npx eslint . --quiet`
  and Python issuer tests separately exited **0**.
- The read-only commercial seed preflight deliberately exited **1 (BLOCKED)**
  because the **unchanged** bundled shipping database contains a configured
  password hash. Read-only `npm audit --omit=dev --json` still reports
  **15 production advisories: 13 moderate, 2 low, zero high/critical**.
  The seed, dependencies and release approval were not modified.
- **Only after full Jest exited**, `npm run build:tauri` finished with
  **exit 0**, Next.js **15.5.27** compiled/checked and statically rendered
  **70/70 routes**; the build script explicitly restored
  `src/middleware.ts`. No installer signing, packing or publication followed.
- **Final repository hygiene:** **278 dirty/untracked entries** versus
  **274 on entry**, **zero staged**, `git diff --check` exit **0**, exactly
  **39 forward SQL migrations**, latest
  `039_inventory_create_acknowledgements.sql`, original bundled seed still
  present, middleware restored and `PHARMA_SECURITY_RELEASE_APPROVED`
  **unset**. Existing historical migration 038/039 and dirty/untracked files
  were preserved; no customer database opened for mutation, no signing keys
  provisioned and no release approval changed.

**Commercial release remains BLOCKED**, notwithstanding the bounded native
improvements. Open acceptance includes unchanged credential-bearing bundled
seed/preflight, production supply-chain advisories, real physical TPM/device
provisioning and Windows 7 tier limitations, production issuer HTTPS and key
custody, signed installers/updates plus installed GUI tests, authoritative
historical stock/financial ledger reconciliation across pharmacies, financial
audit/backup custody and offline restore/operator policy, actual bounded
memory ZIP expansion stress, and additional POS/purchasing/returns/finance
renderer SQL/read authorization coverage. `PHARMA_SECURITY_RELEASE_APPROVED`
must remain unset and release workflow signoff OFF.

## 2026-10-12 continuation: native return custody, bounded real ZIP inflation, owner-only lineage diagnostics

### Reconciliation before changing source

- Reconnected after the prior Windows workspace tunnel interruption. HEAD was
  `a9411cce`; **280 dirty/untracked entries, zero staged entries**, 39 existing
  SQL migrations, the original bundled `src-tauri/pharma_local.db`, restored
  `src/middleware.ts`, and unset `PHARMA_SECURITY_RELEASE_APPROVED`. No relevant
  Cargo/Jest/build task was still running on entry.
- Confirmed the previous return/settlement and unused backup changes had been
  saved despite failed tool history; **did not reapply** them. Prior ownership,
  inventory, licensing, native workbook saving and migrations 038-039 remain.
  Also confirmed that secure-release purchase edit status omission and
  completed-to-draft checks were already present and did not redo them.
- The prior ZIP validator still checked *declared* expansion only; the
  previously proposed financial audit module did not yet exist. Those were
  genuine unfinished tasks, not previously completed source.

### Completed security changes for this bounded increment

- `critical.rs`: desktop `create_return_critical` and
  `settle_negative_sale_item_critical` now deserialize deny-unknown-fields
  native intent DTOs **without** a renderer-controlled user/pharmacy/SQL/role.
  They resolve the actor from `LocalSessionState.authorize_session` and the
  current active user's pharmacy **after BEGIN IMMEDIATE**, then pass those
  trusted values to the existing permission-, provenance-, tenant- and
  ledger-checking transaction implementations. The existing internal return
  transaction types were preserved for historical test fixtures. A separate
  strictly bounded validator refuses oversized return batches (>200 rows),
  invalid quantities, IDs and excessively long text before opening the writer;
  negative settlement intent enforces a positive sale-item ID and bounded lot
  identity. `returns.ts` and `settlement.ts` no longer send renderer claims.
  Tests reject forged identities and prove live pharmacy reassignment rather
  than the stale UI tenant determines the transaction scope.
- `src/lib/db/client.ts`: the unused arbitrary-path Node `backup(path)`
  helper now throws without opening the live database, complementing the
  previous arbitrary-path `restore(path)` denial. The supported full-system
  snapshot remains the native owner/password-checked backup and sealed
  manifest path; this is **not** an offline restore implementation. No
  production consumer was found for the removed legacy behavior.
- `src/lib/inventory/xlsx-zip-preflight.ts` and the native
  `InventoryTable.tsx` branch: the asynchronous desktop preflight now measures
  **actual streamed expanded bytes** before calling SheetJS; the compressed
  input remains <=2 MiB, <=128 entries, with observed <=8 MiB per member,
  <=4 MiB per worksheet and <=16 MiB cumulative. It checks exact member
  structure/offsets, rejects overlapping, extra or duplicate entries and
  ZIP64/encryption/unsupported flags, validates local/central headers and
  descriptors, streams raw-DEFLATE in 16-KiB compressed chunks, and verifies
  actual expanded size and CRC32. An embedded runtime without native
  `DecompressionStream('deflate-raw')` **fails closed**. Existing browser/web
  import and native 200-row new-lot semantics are unchanged. This bounds
  observed inflation before SheetJS, **not** the decoder's native internal
  memory or the downstream XML parser's worst-case heap/CPU footprint;
  installed WebView2 and constrained-RAM stress acceptance remain open.
- New `src-tauri/src/commands/financial_lineage_audit_native.rs` is registered
  as `audit_financial_lineage_native` (zero renderer arguments). It opens the
  *fixed live database* read-only, obtains a consistent BEGIN/ROLLBACK
  snapshot, rechecks an active native owner role, and evaluates fixed
  bounded SQL without changing any business rows. It reports cross-tenant and
  mismatched-drug links from sales/purchase invoice items to lots, missing
  source invoices or lots, orphan account/journal references, malformed
  entries, unbalanced/missing journal lines, unknown lot adjustment scope,
  purchase journal text claims, and NULL provenance. It returns at most 200
  findings and rejects overflow; each scanned table is bounded at 1 million
  rows. Purchase description matches and historical 8-character sales labels
  are **not trusted immutable references**. Results distinguish direct
  explicit conflicts from review-required/ambiguous data; even
  `limited_no_findings` **does not certify historic COGS or journal lineage**.
  It exposes no tenant-agnostic data to non-owner users, and it never rewrites
  historical stock, account balances or tenant identities.

### Verification evidence for this continuation

- Native focused tests: return/negative-stock spoofing, reassignment and
  bounded request regression **1 passed**; new owner-only financial-lineage
  adversarial tests **6 passed**, including non-owner/inactive revocation,
  cross-pharmacy sources, journal discrepancies, legacy ambiguous labels,
  and >200 finding fail-closed behavior. Both groups compiled with pinned
  Windows Rust 1.77.2 and locked/offline dependencies.
- ZIP preflight focused Jest **11/11 passed**, including an actual ~9 MiB
  inflated member falsely declaring 1 byte, >4 MiB worksheet, >16 MiB total,
  corrupted CRC/headers/descriptors, hidden/duplicate entries, and missing
  raw-DEFLATE runtime. Additional existing frontend boundary Jest **4 suites,
  13 tests passed**. TypeScript and full ESLint each exited **0**.
- Full pinned Rust debug **389 passed, zero failed, 1 intentionally ignored
  physical-TPM test**. Full pinned synthetic optimized secure-release Rust
  **382 passed, zero failed, 1 intentionally ignored physical-TPM test**, with
  an ephemeral test Ed25519 public verifier and the deliberately nonproduction
  `https://licensing.example.invalid` origin; **not** production acceptance.
- Python issuer/licensing **40 tests passed**. Read-only bundled-seed
  preflight **blocked as intended** (exit 1, configured password hash present
  in the unchanged bundled DB). Read-only production npm audit still reports
  **15 advisories: 13 moderate, 2 low, zero high/critical**; no forced
  dependency remediation was performed.

### Unresolved commercial acceptance after this increment

This owner-only audit is a bounded diagnostic, not signed, immutable provenance
or reconciliation of all purchase/sale/return/COGS journal amounts. Historical
NULL lots/pharmacies, unlinked sales journal prefixes, operator valuation
policy and privileged missing source keys still require review and possibly
future-only schema/migration design. Offline authenticated restore with restart,
rollback and custody remains unavailable by design. Production release is also
blocked on the original credential-bearing seed, dependency signoff, hardware
TPM/security-clock/rollback and offline revocation realities, production issuer
and signing-key custody, signed installer/updater tests, low-memory WebView2
validation, remaining native privileged domain coverage and formal operator
acceptance. **Do not enable `PHARMA_SECURITY_RELEASE_APPROVED` or publish.**

### Final complete frontend verification and repository hygiene for this increment

- Full `npx jest --runInBand --silent` ran **after the final desktop XLSX and
  native IPC edits** and exited **0**: **316 suites passed, 1 skipped; 2,599
  tests passed, 3 skipped; 0 failures**. This includes the actual-inflation
  bomb and desktop native return/settlement payload tests. TypeScript
  `npx tsc --noEmit --incremental false` and `npx eslint . --quiet` both
  independently exited **0** after integration.
- **Only after full Jest completed**, `npm run build:tauri` exited **0**:
  Next.js 15.5.27 compiled, checked and generated **70/70 routes**;
  `scripts/build-tauri.js` restored `src/middleware.ts` and the explicit
  post-build check reported `MIDDLEWARE_PRESENT=True`. No installer/signing or
  upload was attempted.
- Final read-only hygiene: **281 dirty/untracked entries**, compared with
  **280 on entry** (one additional untracked financial audit source), **zero
  staged**, `git diff --check` exited **0**, all **39 historical SQL migration
  files remain** (latest 039), original bundled SQLite seed still present,
  middleware present, and `PHARMA_SECURITY_RELEASE_APPROVED` unset. No
  migrations 038/039 or historical checksums were edited, no customer
  database was intentionally mutated, and commercial release remains
  **BLOCKED** for the recorded external/operator acceptance requirements.

## 2026-10-12 continuation: non-destructive recovery verification and historical return-source audit

### Live reconciliation and scope

- Reconciled the shared live Windows source before any work: HEAD `a9411cce`,
  **281 dirty/untracked entries**, **zero staged**, **39 existing SQL migrations**
  (through 039), `src/middleware.ts` present, unchanged bundled
  `src-tauri/pharma_local.db` present, commercial approval flag **unset**, and
  no running Cargo/Jest/Tauri builds. Earlier native return/settlement, ZIP
  actual-inflation and financial audit changes were present and remained
  verified. Their previous acceptance work was **not** duplicated.

### New native read-only backup recovery preview

- Added `verify_database_backup_recovery_preview` in
  `src-tauri/src/database_backup.rs` and registered it in `main.rs`.
  The desktop IPC accepts **only** `{backupId,password}`, not a renderer
  path/SQL/user/role/tenant claim. Its actor is from the native authenticated
  session, and a fresh password is checked against a **currently active owner**
  in the live DB. It accepts a canonical lowercase RFC4122 UUIDv4 and resolves
  only the application's native `backups/{UUID}/pharma_local.db` and
  adjacent `backup_manifest.json`.
- The preview rejects symlinks/Windows reparse paths, incomplete directories,
  extra members/SQLite sidecars, oversized or unexpected manifest JSON,
  malformed source names, conflicting snapshot identity/location, corrupt
  SHA-256/length, bad source hash, invalid timestamps and incomplete modern
  schema. It performs the existing SQLite integrity/FK/accounting checks,
  **full `PRAGMA integrity_check`**, then rehashes the snapshot and checks the
  original bounded manifest again for concurrent modifications. On success
  it returns `verified_read_only_preview` plus bounded metadata and explicit
  warning: **"Verification only; not authorization to restore. SHA256 is not a
  signature."** The implementation never opens any candidate for writing,
  copies or replaces a database, authorizes online restore, or changes a
  license state or customer record. An attacker controlling both snapshot and
  unsigned manifest is **not** authenticated by this integrity check.
- In `DbMaintenance.tsx`, only an owner can enter a backup UUID, re-enter a
  password and invoke this native read-only preview; it rechecks the frontend
  session and prevents duplicate concurrent maintenance/backup/verification.
  It can auto-fill the UUID from the immediately created native backup path
  but passes **only UUID and password** to the native verifier. It never
  displays a verification success if the native status or UUID mismatches.
  Corrected the existing backup guidance: preserve both SQLite snapshot and
  `backup_manifest.json` together, not the DB alone, and share sensitive data
  only through an approved secure channel.

### New historical return-source diagnostic coverage

- Expanded existing zero-argument owner-only
  `audit_financial_lineage_native` with six additional bounded fixed SQLite
  projections for sales return header→original invoice pharmacy, sales return
  line→original sale item/invoice/drug/lot, purchase/supplier return
  header→purchase invoice/supplier, and purchase return line→original purchase
  item/invoice/drug/lot, plus **provable finalized sales and purchase
  over-returns** using original historical unit-conversion snapshots.
- Explicit FK contradictions and source tenant/drug/lot differences are
  reported. Legacy NULL sources, absent reliable conversion factors, nonstandard
  or unknown units, nonfinalized returns, and ambiguous prior batch edits
  are **not fabricated into proof**; they are separately review-required or
  omitted from quantity proof as appropriate. Supplier returns compare paid
  source units, **not bonus stock**. All results remain read-only under a
  consistent owner-authorized snapshot; limits remain 1 million rows/table,
  at most 200 findings, fail-closed on overflow. The diagnostic cannot certify
  historic total COGS/ledger ownership or mutate history.

### Independent recovery operator acceptance specification

- Added `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md`, explicitly **not**
  an online restore playbook. It defines production signer/source identity,
  two-person authorization, offline process exclusivity, license-anchor
  isolation, staging and atomic rollback/crash receipts, financial/source
  reconciliation and isolated installed-app rehearsal requirements. No manual
  live database overwrite instructions or false production acceptance.

### Verification obtained so far this increment

- Pinned Rust 1.77.2: **5 portable recovery-preview adversarial tests passed**
  and **13 owner-only financial lineage tests passed**. The recovery tests
  reject wrong actors/passwords, fake IDs/manifests, corrupt SQLite even with
  rehashed manifests, changed accounting history, missing/extra members and
  validate unchanged source/snapshot. On Windows the extra symlink-specific
  test conditionally exercises host support; on Unix an extra symlink test is
  separately gated. The 13 lineage tests cover role/reassignment, missing
  source and cross-pharmacy/drug/lot cases, return FK contradictions, ambiguous
  units and provable overreturns, bounded overflow and no record mutation.
- Updated Settings Jest **12 tests passed**, with native-only backup UUID
  routing, no renderer path/user claim, owner authorization revocation and
  no false success on unexpected preview status. TypeScript and ESLint
  **both exited 0**.
- Full pinned Rust **debug: 402 passed, 0 failed, 1 intentionally ignored
  manual physical-TPM test**. Full pinned Rust **synthetic optimized
  secure-release: 395 passed, 0 failed, 1 intentionally ignored physical-TPM
  test**. Secure release used an ephemeral Ed25519 verifier and deliberately
  nonproduction `.invalid` HTTPS licensing origin, **not** any production
  signer, issuer or TPM installed-app acceptance.

**Release remains BLOCKED.** Preview does not implement offline restore,
cryptographic owner-signed backup origin, tenant/site identity commitment,
immutable financial source lineage, or crash-safe atomic rollback. Prior
credential-bearing bundled seed gate, 15 previously observed moderate/low
dependency advisories, installed OS/TPM/licensing issuer, hardware and actual
signed installer/updater, low-memory and multi-process recovery rehearsals,
all historical financial acceptance and operator release approval remain
unmet. `PHARMA_SECURITY_RELEASE_APPROVED` must stay unset.

### Final sequential integration verification and release disposition, 2026-10-12

- Full `npx jest --runInBand --silent` exited **0** after the last native
  backup-preview and audit integration/UI edits: **316 suites passed, 1
  skipped; 2,602 tests passed, 3 skipped; zero failures**. Owner Settings
  verification tests are included; focused Settings Jest **12/12 passed**.
  TypeScript (`npx tsc --noEmit --incremental false`) and full ESLint
  (`npx eslint . --quiet`) separately exited **0**.
- The build that temporarily removes middleware ran **strictly after** full
  Jest had finished. `npm run build:tauri` exited **0** with Next.js **15.5.27**
  compiling and generating **70/70 routes**, then explicitly printed
  `Restoring middleware to src/middleware.ts...` and
  `MIDDLEWARE_PRESENT=True`. This is a static export test, **not** a signed
  or installed Tauri binary acceptance.
- The unchanged credential-bearing bundled seed read-only commercial preflight
  again exited **1 (BLOCKED)**: `Bundled seed contains a configured user
  password hash`. `npm audit --omit=dev --json` still shows **15 production
  advisories (13 moderate, 2 low, 0 high, 0 critical)**. No seed or package
  rewrite, dependency force-upgrade or commercial gate bypass was attempted.
- Retained earlier **40/40 passing Python issuer/licensing** test evidence;
  no Python issuer source changed in this bounded native/Settings continuation,
  so those previously verified suites were not rerun unnecessarily.

**Commercial release is BLOCKED**. Recovery-preview integrity checks are
substantial safeguards but no customer database restoration was performed or
approved. Real source signatures, stable tenant/site provenance, tested
offline atomic recovery with restart/crash rollback, full historic financial
acceptance, operator custody/signoff, physical TPM and installed signed
binary/update tests still require independent evidence. No approval flag or
installer publication is authorized by this green verification sequence.

## 2026-10-12 continuation: pinned recovery file identity, catalog column confidentiality and forensic stock claims

### Live source reconciliation

- Current HEAD remained `a9411cce`, with **282 dirty/untracked entries** and
  **zero staged changes** at entry. There were **39 unchanged forward-only
  migrations**, original bundled SQLite seed and `src/middleware.ts` present,
  `PHARMA_SECURITY_RELEASE_APPROVED` unset, and no active Cargo/Jest/build
  processes. Previous fully passing inventory/finance/recovery/licensing work
  was preserved. Neither commercial seed nor customer database was modified.
- The secure-release SQLite read authorizer already rejected renderer-chosen
  tenant/private tables and generic renderer SQL writes were already
  disabled; **that completed boundary was not repeated**. One remaining
  observable exception was that `master_drugs` was allowlisted by *table name*
  alone despite its unrestricted `notes` field and possible future private
  columns. The global master catalog is correctly shared, but this is not a
  blanket right to read unapproved metadata.

### Native secure-release read-column hardening

- `src-tauri/src/commands/guarded_read.rs`: for arbitrary renderer-selected
  master-catalog SQL in secure releases, the native SQLite authorizer now
  permits **only enumerated public master-drug columns**. Known free-text
  `notes` and any new unrecognized future column are replaced **inside the
  SQLite VM** with `NULL` using `SQLITE_IGNORE`; they cannot be recovered by
  aliases, subqueries, CTEs, WHERE predicates or aggregates. This deliberately
  retains the row shape and public catalog fields for legacy `SELECT *`
  consumers instead of breaking global catalog views. A view referencing
  protected catalog columns is denied outright. All preexisting customer,
  finance and staff table restrictions remain; trusted fixed native query
  modules retain their separately authenticated access. Non-secure browser
  and existing QA SQL paths are unchanged.
- Focused native guarded-reader tests **6/6 passed**, including public
  `SELECT *`, NULL-masking of `notes` and a future private column, masked
  predicates/aggregates and alias/CTE/secondary-view adversarial reads.
  An additional `#[cfg(pharma_security_release)]` test uses the **real
  `fetch_limited` dispatch** to prove secure-release masking and tenant
  rejection, while a later trusted native query still reads as authorized.

### Recovery-preview file identity and alias custody

- In `src-tauri/src/database_backup.rs`, `verify_recovery_preview_on_source`
  now opens and retains handles to both published snapshot members throughout
  hashing, manifest verification and full read-only SQLite/accounting checks.
  Windows `OpenOptionsExt::share_mode(FILE_SHARE_READ)` denies concurrent
  writes and deletes while a preview is underway. Win32
  `GetFileInformationByHandle` provides volume/file-index and link count;
  Unix uses file metadata device/inode/link count. A snapshot/manifest with
  **any hard-link alias**, or the same file identity for both, fails closed.
  Native file identities are checked again after SQL inspection, in addition
  to the existing second SHA-256 and exact manifest re-read. Unsupported
  identity introspection fails closed. No renderer path, write, restore,
  privilege change or license mutation was introduced.
- Focused native database-backup tests **11/11 passed**. New tests prove that
  an external hard link to either published file is rejected, removing the
  alias does not alter the live DB/backup and permits a later valid preview,
  and held Windows handles refuse a concurrent writer or rename. Windows
  readonly fixture cleanup was corrected after a focused test found its
  intentional hard-link alias could not be deleted while the readonly
  attribute remained set. **No actual customer file was used.**
- The Windows sharing guard applies to the pinned file handles. On Unix,
  identity rechecks narrow but cannot prove total resistance to an ABA
  rename/replacement by a privileged attacker; an unsigned manifest also
  remains non-authenticating. This is a safer *read-only verification preview*,
  **not** a trusted production offline restore or a signature-based proof.

### Historical stock and accounting diagnostic expansion

- `src-tauri/src/commands/financial_lineage_audit_native.rs`: added five
  fixed native owner-only read-only forensic SQL queries, retaining live owner
  authorization and one consistent read transaction, the 1-million-row
  per-table bound and global 200-finding fail-closed limit. They report
  invalid/non-numeric/negative/excessive **inventory stock quantity or cost**,
  invalid or unknown historical **stock adjustment quantities**, native lot
  journal ID/lot-reference text claims, purchase-return journal source/amount
  claims, and supplier invoice/return source links and duplicate posted
  return-reference claims (without falsely flagging legitimate repeated
  invoice edits). NULL tenant/uncertain historic source and all journal/free-
  text-only matches remain **review-required**, never claimed as immutable
  foreign-key proof. Source stock values, COGS and journals are never edited.
- The former diagnostic's **13 tests** were preserved; **6 new adversarial
  tests** cover stock/cost corruption, omitted historic quantities, lot/journal
  tenant ambiguity, supplier and purchase-return source claims, duplicate
  references and 201-finding rollback. One initial test wrongly expected
  *no finding* for a NULL-pharmacy lot; the older correct
  `adjustment_lot_scope_unknown` review finding was retained and that test
  assertion was repaired. Final focused native lineage result: **19 passed,
  zero failed**. No source schema or migration was modified.

### Final native integration evidence and still-blocked acceptance

- Pinned `1.77.2-x86_64-pc-windows-msvc` full locked/offline Rust **debug:
  410 passed, 0 failed, 1 intentionally ignored real physical-TPM manual
  test**. The pinned optimized **synthetic secure-release** profile (ephemeral
  Ed25519 verification key and deliberately nonproduction `.invalid` HTTPS
  licensing origin) passed **404, 0 failed, 1 intentionally ignored TPM**,
  including the new secure-release catalog-column integration test. This is
  *not* production issuer, physical TPM or installed signed binary evidence.
- This bounded increment changed **only Rust source plus this release gate**;
  no frontend, TypeScript, Python issuer, dependencies or build script changed.
  The immediately preceding verified integration (Python licensing 40 passed,
  TypeScript/ESLint exit 0, full Jest 316 suites/2,602 tests passed with
  skips, static Tauri 70/70 and restored middleware) is intentionally not
  rerun without relevant source changes. The unchanged credential-bearing
  commercial seed remains **blocked** by mandatory preflight, and prior
  production dependency advisories remain subject to review.

**Commercial release remains BLOCKED.** Unsigned backup manifests, genuine
authenticated offline recovery/rollback and crash rehearsal, all historic
financial source-to-ledger acceptance, production activation issuer/keys,
device/TPM testing, seed custodian remediation, installed signed installer and
operator release approval still require real external evidence. No online
database restore, artificial signing key, released installer or approval
flag is authorized by these passing tests.

Final hygiene after the Rust-only incremental verification: **282**
dirty/untracked repository entries (unchanged from entry), **0 staged**,
`git diff --check` **exit 0**, **39** migration files through 039. The
already-untracked migration files 030–039 were preserved, not rewritten or
re-staged; original `src-tauri/pharma_local.db` remains present and has no Git
status change, `src/middleware.ts` is present, and
`PHARMA_SECURITY_RELEASE_APPROVED` is empty/unset. No Cargo/Jest/Tauri build
process was left running. **Release status: BLOCKED.**

## 2026-10-12 continuation: isolated rehearsal receipts, tenant/migration controls and financial-source reconciliation

### Reconciled live state before edits

- Exact live `git` HEAD was `a9411cce`; **282** pre-existing dirty/untracked entries,
  **0 staged**, **39** migrations through immutable 039, `git diff --check`
  exit **0** (Git only reported existing LF/CRLF conversion notices). The
  original credential-bearing `src-tauri/pharma_local.db` and middleware were
  present, `PHARMA_SECURITY_RELEASE_APPROVED` unset, and no active build/test
  processes were detected. Read authoritative previous 410/404 Rust results,
  Python40, TypeScript/lint, Jest2602, static70/70 and the recovery acceptance
  playbook; confirmed source already contained catalog field masking,
  Windows hard-link protection, owner backup preview, inventory import/create
  receipts and historical return diagnostics. **None was reimplemented.**
- An earlier guarded-purchase optional expected-status weakness was already
  restricted for existing invoices in synthetic secure release by the live
  Rust source; it was not reopened. Existing guarded transactions already
  bound window and native actor and cleaned up on window-close/page reload,
  but a renderer that never closed its window could still hold `BEGIN IMMEDIATE`
  indefinitely. That concrete independent residual was selected below.

### New fixed owner-only journal/source reconciliation

- New `src-tauri/src/commands/financial_source_reconciliation_native.rs`,
  registered in `commands/mod.rs` and `main.rs`, exposes only
  `reconcile_financial_sources_native` with **zero renderer SQL/actor/pharmacy
  inputs**. It uses the live `LocalSessionState` session and current active
  database **owner** role, opens the fixed app database read-only and executes
  a single consistent `BEGIN`/`ROLLBACK` snapshot. It scans no more than
  1 million rows per fixed domain and returns at most **200** classified
  findings, with no partial report on overflow. No historical row, catalog
  record or account is mutated.
- Its 11 fixed bounded queries cover orphan/invalid journal entries and
  account references, debit-credit reconciliation and amounts against
  applicable native journal headers, purchase initial/edit full-ID **text
  claims**, purchase-return journal amount and scope claims, native lot
  journal `[lot_id=...]` descriptions, stored sale/purchase return header and
  original-item invoice links, sales/purchase line-to-lot tenant disagreement,
  supplier-return references/duplicate claims, and opaque legacy sales
  8-character journal prefixes. Findings distinguish
  `explicit_contradiction`, `source_claim_conflict`, and
  `unverifiable_history`. Text descriptions, mutable account mappings and
  the absence of immutable journal->source keys **cannot certify** historical
  COGS or actual invoice/posting ownership. NULL tenant is **never assumed**
  to belong to the current branch.
- New owner Settings control displays bounded counts and up to 20 findings;
  it invokes this **fixed native command** without any SQL, path, user, or
  tenant claim and never suggests that zero findings is historical acceptance.
  Native reconciliation **9/9 focused adversarial Rust tests passed**:
  role revocation, cross-tenant stored relationships, missing/duplicate journal
  text claims, debit/credit contradictions, return and supplier links,
  legacy NULL ambiguity and >200 finding transaction rollback. No new schema
  migration or historic journal rewriting was performed.

### Native guarded writer timeout and automatic rollback

- `critical.rs` adds a **120-second maximum** lifetime to renderer-managed
  generic `DbTransactions` only (not RAII native checkout/purchase/return
  atomic commands). `ensure_live` rejects expired registration/commit, with
  expiration checked **before** further role SQL at finish; every failure
  attempts rollback and closes the held connection. `main.rs` starts a
  licensed-postmigration internal **15-second** native watchdog that calls
  `rollback_expired`, releasing orphaned SQLite writer locks even if the
  renderer hangs without a page-close event. Rollback-only abort remains
  available on logout/license expiry, and window/actor checks are preserved.
  The new adversarial native test passed: expired registration is denied,
  a stale commit cannot persist uncommitted money, and the watchdog cleanup
  frees the writer lock for a separate SQLite connection. It also passed
  in the complete debug/synthetic suites.

### Non-destructive authenticated staged recovery rehearsal

- New `database_backup::stage_database_recovery_rehearsal_native`, registered
  in the Tauri invoke handler, accepts only canonical UUIDv4 `backupId`,
  UUIDv4 `requestId`, and fresh owner `password`. Its actor is the **native
  authenticated session** with current database-owner password validation,
  including a second check before a successful receipt. No renderer path,
  SQL, role, tenant or source DB identity is trusted.
- Only a previously verified, bounded, SHA256-checked native backup can be
  copied into a **new isolated** app-data
  `recovery-rehearsals/{requestId}` directory. Existing hard-link/reparse
  and pinned Windows read-share protection is retained. Each attempt begins
  with a synced `attempt_started.json`; snapshot bytes are streamed into a
  `create_new` `.partial`, bounded to 1 GiB and SHA256-matched to the
  reverified snapshot. After sync, it publishes only into that isolated
  folder, reopens the clone read-only and checks full SQLite integrity,
  foreign keys, balanced journals, exact live-site SQLx migration
  versions/checksums, and a bounded **explicit** tenant universe across users,
  lots and available financial source tables. A NULL/blank pharmacy or a
  source/target tenant set mismatch fails closed, rather than fabricating
  legacy ownership. It then seals the clone read-only and records a separate
  synced `rehearsal_verified.json` receipt.
- Same `requestId` **always fails** on replay, including a half-written
  attempt after interruption; the original partial/started witness is not
  silently cleaned or overwritten. Maximum 16 attempt directories prevent
  unlimited local retention of sensitive multi-tenant data. No attempt ever
  writes, renames, copies over, or replaces `pharma_local.db` live; there is
  **no destructive restore command** or license rollback. Settings now shows
  a separate owner-only rehearsal button, explicit nonce to preserve across
  uncertain IPC replies, signed-origin caveat and no-restoration status.
- **7 focused native tests passed**: successful isolated clone with original
  source/backup unchanged, forged owner/credential/UUID denial, damaged
  source, SQLx migration downgrade, changed tenant despite rehashed *unsigned*
  manifest, same-ID concurrency with one winner, replay after restart, and
  simulated partial interruption evidence. Two additional Settings tests
  cover only-UUID/password payload, owner recheck, interrupted/replay denial
  and no claimed successful restore. These are synthetic tests, **not** real
  power-loss or signed-installed offline recovery acceptance.
- `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` now describes the isolated
  staging workflow, custody of sensitive attempt directories, explicit
  no-auto-retry policy and what a real two-person offline recovery must still
  demonstrate.

### Verification for this integrated increment

- Full pinned Windows Rust `1.77.2-x86_64-pc-windows-msvc` debug:
  **427 passed, 0 failed, 1 intentionally ignored manual physical-TPM test**.
- Full pinned optimized **synthetic secure-release** with ephemeral QA Ed25519
  verifier and deliberately invalid nonproduction HTTPS issuer:
  **421 passed, 0 failed, 1 intentionally ignored real TPM test**.
- Python issuer/licensing **40/40 passed**. TypeScript `npx tsc --noEmit
  --incremental false` and `npx eslint . --quiet` each exited **0** after the
  new owner Settings integration. Focused Settings Jest **16/16 passed**.
- The unchanged original bundled seed commercial preflight again exited **1
  (BLOCKED)**: `Bundled seed contains a configured user password hash`.
  Read-only production `npm audit --omit=dev --json` still reports **15
  advisories (13 moderate, 2 low, 0 high/critical)**. No dependency force
  update, seed rewrite, release override or installer publication occurred.

**This is not a production offline recovery or a signed immutable stock-to-ledger
chain.** The staged clone is not executed in a separate installed application;
it does not simulate a real sudden OS crash or atomic switch/rollback.
Backup source manifests remain unsigned; tenant-set and SQLx migration
agreement are useful checks but are not cryptographic site identity. Historic
sales journals have partial text references, COGS mappings are mutable, and
legacy NULL tenant/accounting ambiguities still require independent forensic
review and financial/operator signoff. The commercial seed, production issuer,
TPM hardware, key custody, signed installer/updater tests and formal operator
approval remain outstanding. **Commercial release remains BLOCKED.**

### Final integrated frontend verification and repository hygiene (this continuation)

- Full `npx jest --runInBand --silent` **completed before** the Tauri static
  export and exited **0**: **316 suites passed, 1 skipped; 2,606 tests passed,
  3 skipped; 0 failures**. This includes 16 focused Settings tests for the
  owner-only preview, no-overwrite/nonce rehearsal and source reconciliation.
  TypeScript and ESLint each separately exited **0** after the final UI edits.
- `npm run build:tauri` started **only after all Jest suites finished**,
  exited **0**, compiled Next.js **15.5.27**, generated **70/70 routes** and
  printed `Restoring middleware to src/middleware.ts...` followed by
  `MIDDLEWARE_PRESENT=True`. This is static frontend export verification, not
  a signed/installed Tauri application or operator end-to-end rehearsal.
- Final read-only hygiene: `git diff --check` **exit 0**; **285** tracked/untracked
  repository status entries (initially 282; no deletion/reset/clean of any
  pre-existing changes), **0 staged**, **39 unchanged SQL migrations through
  039**, original `src-tauri/pharma_local.db` present and with no Git status
  change, middleware present, commercial approval flag empty/unset, and **no
  active Cargo/Rust/Jest/Tauri build processes**. More detailed changes were
  limited to native Rust, the owner Settings UI/tests, and this/new recovery
  acceptance documentation; no real customer database was intentionally
  opened or modified in these adversarial synthetic fixtures.

**Remaining hard requirements:** The trusted real-world signer/site-identity
chain is not implemented; migration/tenant and SHA256 equality of an unsigned
backup is not cryptographic provenance. A full independent offline restore
supervisor with atomic rollback, hardware-crash and 2-process interruption
testing, device license binding/anchor continuity and two-person operator
approval remains absent. The new reconciliation is bounded and classifies
old text references as evidence for human review, not an accepted immutable
source-to-COGS history. Physical TPM, commercial issuer/key custody,
credential-bearing bundled seed remediation, unresolved 15 dependency
advisories, signed installer/updater testing and formal history/accounting
operator acceptance are outstanding. No approval switch or installer
publication. **RELEASE BLOCKED.**

## 2026-10-12 continuation: forward-only native stock-to-ledger provenance and pinned rehearsal manifest

**Disposition: commercial release remains BLOCKED.** This is a bounded, implemented security improvement, not acceptance of the original complete commercial release. At the start of this continuation the shared Windows workspace still had HEAD `a9411cce`, 285 dirty/untracked entries, 0 staged changes, 39 preexisting SQL migration files through 039, original credential-bearing `src-tauri/pharma_local.db` unchanged in Git, middleware present, commercial approval unset, and no active build/test process. The earlier owner-only financial reconciliation, native recovery rehearsal and transaction expiry watchdog were present; none were reimplemented.

### New structural source-to-journal receipt for native stock movements

- New **forward-only** `040_stock_ledger_provenance.sql` creates `native_stock_ledger_provenance` for **new** native inventory lot quantity edits, fixed stock adjustments and positive-quantity zeroing. No existing migration 001–039 is modified; no legacy adjustment or journal is backfilled, deleted or assigned guessed scope. Native startup registers 040 after the original 39.
- The native-only, non-IPC helper `commands/stock_ledger_provenance.rs::record_adjustment_provenance` independently checks the stored stock adjustment, original and new quantity, actual lot owner, live actor tenant/activity, exact bounded cent-denominated unit cost and valuation, and, when valuation is nonzero, the real journal ID, owner/pharmacy, amount, exactly two balanced entries, and leaf account types/directions. Zero-cost adjustment records expressly bind a NULL journal rather than fabricate a zero-value posting.
- `commands/inventory_lots_native.rs` captures the real inserted `stock_adjustments.id`, inserts any balanced journal/entries, and records the structural source receipt **inside the existing authenticated, tenant-scoped `BEGIN IMMEDIATE` native transaction before audit and COMMIT**. Any mismatch, failed receipt or failed audit rolls the posting and stock change back together. The renderer cannot forge the actor, tenant, adjustment ID, journal or SQL via this helper. The existing native quantity-edit concurrency/staleness checks and inventory permissions remain.
- The 040 sidecar has unique adjustment and journal claims, and SQLite guards on first insertion check the source, actor, tenant, quantity/cost and posting. Append-only triggers prohibit changes or deletions of provenance-linked adjustments, journal headers, entries and receipts, and extra entries against a linked journal. They leave unrelated historical journal/adjustment rows untouched. These controls provide **ordinary SQL structural immutability after posting**, **not** a cryptographic signed chain against a privileged filesystem/database attacker.
- This increment deliberately **does not** cover immutable historical purchases, edits/reversals, sales/COGS, sales returns, purchase returns, opening inventory valuation, supplier settlements, patient balances or full historical journal ownership. Existing random/short textual legacy journal references cannot be retrospectively authenticated. Independent tenant-aware historical accounting investigation, closing/reversal policy and operator signoff remain release blockers.

### Recovery-staging manifest handoff race closed, without enabling restore

- A read-only review found that owner preview validates pinned snapshot and manifest, then releases handles; isolated rehearsal independently repins. The staged snapshot bytes were hash-checked but the *newly pinned manifest bytes* were copied without matching their content to the earlier preview. A local writer with backup-directory write access could race a metadata substitution, causing an inconsistent forensic staging receipt.
- `database_backup.rs` now strictly parses and revalidates the **newly pinned manifest bytes** against UUID, actual fixed source name/path hash, size, snapshot digest, format and timestamp, then compares preview source name, owner/creator and timestamp **before staging the manifest or claiming success**. The additional synthetic rehearsal test rejects substitutions of creator, timestamp, UUID, name, size, SHA, format and unknown fields, as well as malformed bytes, with original source and backup unchanged. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` was amended.
- This is a snapshot/manifest **consistency** fix, not a signing key or authenticated origin. No live database was restored, moved or overwritten. Real independently signed offline manifests, operator dual approval, quiesced separate supervisor, durable crash/rollback drills and license-anchor continuity are **not accepted**.

### Focused and full verification, including corrected regressions

- Pinned Rust 1.77.2 new provenance helper: **8 passed, 0 failed**. Native inventory lot suite initially **12 failed** because historical whole-number SQLite storage reports `INTEGER` and the helper decoded source quantities strictly as `f64`; fixed by `CAST(... AS REAL)` while keeping original SQLite `typeof` data-trust checks. Re-run: **30 passed, 0 failed**. Includes new linked-row edit/delete/extra-entry and duplicate-claim tests, native concurrent writer tests, zero-cost stock and sabotaged provenance receipt rollback.
- Recovery rehearsal focused tests: **8 passed, 0 failed**, including new manifest substitution coverage. Synthetic actual registered full-migration startup focused test: **1 passed**. First full pinned Rust debug run had **433 passed, 4 failed, 1 ignored**, exclusively due to old explicit expected migration count 39; updated the synthetic migration count checks in `schema.rs`, `shifts_native.rs` and `returns_scoped.rs` for the forward 040 migration. Final **full pinned Rust debug: 437 passed, 0 failed, 1 ignored** (physical TPM remains manual).
- First synthetic Rust release command was refused by the strict build-time public-key validator when the disposable public key used ordinary Base64 rather than required unpadded 43-character URL-safe Base64; one subsequent shell quoting error prevented generating the disposable key. Neither failure warranted or caused weakening the validator. With a correctly encoded **fresh ephemeral QA Ed25519 public verification key**, `PHARMA_LICENSE_DEVICE_MODE=tpm-v2`, and deliberately non-routable `https://licensing.example.invalid`, final **full pinned synthetic secure-release Rust: 431 passed, 0 failed, 1 ignored**. This is not real issuer, physical TPM or signed installer validation.
- Python licensing **40 passed**. TypeScript `npx tsc --noEmit --incremental false` **exit 0**; `npx eslint . --quiet` **exit 0**. Full `npx jest --runInBand --silent` **316 suites passed, 1 skipped; 2,606 tests passed, 3 skipped; 0 failed**. `npm run build:tauri` ran **only after full Jest exited**, completed **exit 0**, and restored `src/middleware.ts` (`MIDDLEWARE_PRESENT=True`). Static export is not installed/signed GUI acceptance.
- Read-only commercial seed preflight still **exits 1 / BLOCKED**: `Bundled seed contains a configured user password hash`. Bundled `src-tauri/pharma_local.db` has not been silently rewritten or replaced. Read-only `npm audit --omit=dev --json` remains **15 production advisories: 13 moderate, 2 low, 0 high, 0 critical**; no force upgrade or advisory override.

**Remaining original commercial acceptance requirements are NOT met:** source-authenticated full historical accounting and COGS/valuation reconciliation across purchases/sales/returns, production trust signer/site/device and TPM, signed installer/updater and physical GUI QA, genuine offline supervisor recovery with authenticated manifests and crash-safe restore/rollback, customer/operator/finance signoffs, credential-free commercial build seed and reviewed dependency advisories. No production signing or issuer material was invented; no installer published; no customer database was tested or altered; `PHARMA_SECURITY_RELEASE_APPROVED` stays unset. **COMMERCIAL RELEASE BLOCKED.**

### Final repository and static export hygiene for this continuation

- Verified the Tauri static Next.js build generated **70/70 static pages**, exported **2/2**, exited **0**, and explicitly restored `src/middleware.ts` after Jest had exited. This remains frontend-only build validation.
- Final HEAD `a9411cce`; **287 dirty/untracked Git entries** (285 before this increment, two newly introduced untracked provenance files); **0 staged**, and `git diff --check` **exit 0**. No reset, clean, checkout, stage or commit was performed. **40 migrations** are present through 040, with all preexisting 001–039 files preserved, including previously untracked migration 039. The bundled credential-bearing seed remains present and without Git status change; middleware present; approval flag empty/unset; no active matching Cargo, Rust, Jest, Tauri build or lint process. New 040 migration and helper remain untracked in this preserved working tree.
- Final operator status: **RELEASE BLOCKED**. The previously completed bounded plan and this new code increment are not commercial signoff. No original customer or production data was overwritten.

## 2026-10-12 further integrated increment: sealed native supplier purchase returns, 040 reconciliation, recovery final pin

**Release disposition: BLOCKED; no approval to install or restore.** Resumption checked the *live* repository: HEAD `a9411cce`, **287** pre-existing tracked/untracked changes, zero staged, 40 migration files through 040, original credential-bearing bundled seed present/unchanged in Git, middleware present, approval env empty, no active builds and `git diff --check` exit 0. Migration 040's live startup registration, native `record_adjustment_provenance` stock-edit/zero-stock atomic linkage and existing preview-to-rehearsal manifest revalidation were verified present, not recreated. The prior full debug 437 and QA release 431 results were used as baseline, not passed off as fresh verification.

### New forward-only 041 purchase-return journal and stock-line source receipts

- New `src-tauri/migrations/041_purchase_return_posting_provenance.sql` is registered as startup migration **041** after 040. **Original 001–040 migration bytes and SQLx checksums are preserved.** It creates `native_purchase_return_provenance` keyed by a **real native return ID**, globally unique canonical UUIDv4 `request_id` stored once, originating purchase-invoice ID, explicit pharmacy, active native actor, supplier, UUID journal ID, refund method, exact total cents and bounded line count. Each `native_purchase_return_line_provenance` binds the inserted return item ID, original purchase invoice line, actual lot, returned-unit quantity, native computed stock deduction and refund-value snapshot. Deferred FK + parent `INSERT` guards require all lines in the native transaction; uniqueness prevents the same original native request nonce being claimed twice. This is not a cryptographic signature.
- The SQLite guards validate actual source/parent/supplier/actor/pharmacy, line-to-original-invoice and lot tenant references, posted aggregate amount and exactly two balanced original-account-code debit/credit entries. Native `purchase_returns.rs` now adds explicit `daily_journals.pharmacy_id`, requires **stored non-NULL native actor and purchase-invoice pharmacy** instead of claiming that a legacy NULL means the current renderer branch, bounds lines to 200, and rejects non-cent, nonfinite or excessive totals. Source, stock, supplier/cash movement, journal, all return-line witnesses, sealed parent receipt and audit execute in a single existing `BEGIN IMMEDIATE` transaction. On any SQL failure the complete operation rolls back; a failed deferred `COMMIT` also explicitly attempts `ROLLBACK` rather than retaining a writer transaction.
- Triggers prevent later update/deletion of **provenance-linked** purchase returns, purchase-return items, journal headers, journal entries and proof rows, and prevent adding extra lines; no legacy returns or invoices were rewritten/backfilled. Purchase invoice edit/delete rules already reject finalized returns. **Multiple legitimate partial returns using distinct new request IDs remain possible**, subject to native invoice remainder/cost/stock checks.
- Tauri command now requires a top-level canonical UUIDv4 `requestId`; the desktop purchase-return action sends it separately from the typed business payload. The return form keeps its request ID across a rejected, uncertain or interrupted IPC reply instead of automatically creating an unrelated second financial post; the browser-only existing workflow was not changed. A repeat of an already receipted nonce fails even where invoice quantities would otherwise allow a second legitimate partial return. Renderer supply of user/pharmacy still undergoes native session and live-user checks; no claimed actor, journal ID or arbitrary SQL is permitted in the sidecar.
- The new structure proves **new completed native purchase-return source-to-journal/stock claims** only, at the moment of posting. It does not certify historical NULL-tenant purchases, sale/COGS reversals, long-period inventory costs, supplier settlement completeness, customer historical accounting, account reassignment after posting, or cryptographic provenance; those require further code and independent review. No destructive history rewrite is performed.

### Fixed native owner reconciliation includes migration 040

- `commands/financial_source_reconciliation_native.rs` now joins actual 040 sidecar adjustment IDs to source quantity, current tenant/actor, optional journal header and entries, and account type with strict fixed/bounded SQL. It returns `stockProvenance` counters (`recorded`, `structurallyVerified`, `reviewRequired`, `unattributedAdjustments`) and issue classifications that distinguish immutable-source contradictions from **mutable-current** inventory/actor/account ambiguity. Its checks do not use renderer-supplied SQL. Legitimate 040 journals are not reclassified by fallible legacy `[lot_id=]` description parsing. A zero-cost proven adjustment correctly has no invented zero-value journal. `DbMaintenance.tsx` validates bounded report counters and presents their limited scope to the owner without a historical COGS certification claim.
- **17 focused Rust reconciliation tests passed** (9 existing plus 8 additional cases including forged/orphan protected-source records, tenant/account/amount contradictions, mutable records, uniqueness, 200/201 overflow and snapshot release). Historical unlinked adjustments remain `unattributed`, not proven fraud, and the new 041 sidecar is **not yet included in the owner report's 040-specific counters**; further source-category reconciliation is needed.

### Staging source identity checked through receipt publication

- The prior pinned-manifest content race was already closed. An independent live review found another path race: published backup or manifest identities could change between copy-time file pin and success-receipt publication during staged migration/tenant/owner validation. `database_backup.rs` now re-resolves and pins both published UUID-folder members, verifies exact paths and file identities against the originals **at the final success receipt**, and retains these handles through receipt publication on Windows. No online restore or live replacement is enabled. A synthetic adversarial test republished byte-identical files with *new native identities* and verified rejection with the original live database untouched.
- `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` documents the extra final identity pin and remaining unsigned-origin, retention, independent operator and crash-safe offline restore requirements. These are not satisfied by SHA-256 or Windows file identity.

### Native/issuer/security verification of this increment

- New purchase-return code: **9 focused Rust purchase-return tests passed**, including existing conversion/cost/remainder/concurrency, new tamper, source-line/journal immutable triggers, sabotaged provenance insert atomic rollback and single-use UUID replay checks. The additional native replay test deliberately retries the same UUID after a valid partial return while stock remains, demonstrating the unique-claim rejection without new stock movement. Invalid UUIDs are rejected before posting.
- Fixed 040 owner reconciliation: **17/17 focused Rust passed**. Full pinned Rust 1.77.2 debug **446 passed / 0 failed / 1 ignored** (real physical-TPM test manual). Full pinned *synthetic* secure-release Rust with fresh ephemeral QA Ed25519 verifier, TPM-mode simulation and `.invalid` issuer **440 passed / 0 failed / 1 ignored**. Neither mode qualifies actual physical TPM, issuer custody or signed installation.
- Python licensing **40 passed**. TypeScript and ESLint commands each exited **0**. Owner maintenance plus purchase-return frontend focused Jest **26/26 passed**, including the native top-level `requestId` payload and UI single-flight behavior. All tests use synthetic state, not customer databases.

**Still outstanding and blocking:** verified source-to-ledger provenance for native sales/COGS, sales returns, purchases and edits/reversals, opening values, full inventory valuation, bank/settlement and patient balances; historical immutable source lineage/cost and independent finance acceptance; fully authenticated production issuer/TPM/installation key custody, signed installer and hardware GUI QA; signed backup identities, two-person offline supervisor, actual atomic restore and crash/disk-full rollback; operator approvals, credential-bearing commercial seed remediation, production dependency advisory review. No credentials were invented, no dependency upgrades forced, no approved installer published and `PHARMA_SECURITY_RELEASE_APPROVED` stays unset. **COMMERCIAL RELEASE BLOCKED.**

### Completed frontend and final repository hygiene (further increment)

- After the new purchase-return nonce contract, Settings stock proof presentation and native tests: **full Jest 316 passing suites, 1 skipped; 2,606 passing tests, 3 skipped, 0 failed**. The specific Settings/purchase-return frontend tests completed **26/26 passed**. `npx tsc --noEmit --incremental false` and `npx eslint . --quiet` both exited **0**.
- Only **after** Jest exited, `npm run build:tauri` exited **0** with Next.js **70/70 static pages generated**, exporting successfully. It logged `Restoring middleware to src/middleware.ts...`; explicit `MIDDLEWARE_PRESENT=True` was independently rechecked. This is static export, not real signed installed app acceptance.
- Final non-destructive repository check: HEAD **`a9411cce`**, **290 Git dirty/untracked entries** (287 at start; three additional status entries from this scope; **none cleaned, reset, staged or committed**), **0 staged**, `git diff --check` **exit 0**, **41 migrations** through new 041, old 001–039 retained byte-for-byte and 040 retained unchanged, original credential-bearing `src-tauri/pharma_local.db` present with **no Git status change**, middleware present, release approval flag empty/unset, and no active Cargo/Jest/Tauri-build processes.
- `node scripts/check-commercial-release-seed.js` again exited **1 (blocked as intended)**: `Bundled seed contains a configured user password hash`. No seed modification, credential bypass or installer publication. The previously reported read-only production audit **15 advisories (13 moderate, 2 low, 0 high/critical)** remains an unresolved baseline; no dependency versions were changed or audit-clean result asserted in this continuation.

The connected plan's completed steps describe this **bounded** implementation phase only. Historic financial acceptance, real signed/TPM deployment, authenticated offline recovery with crash-safe rollback, and operator signoff are **not accomplished**. **COMMERCIAL RELEASE BLOCKED.**

## 2026-10-12 further continuation: native purchase event ledger, preserved corrections and backup export authorization

**Commercial release remains BLOCKED.** The resumption reconciled live `a9411cce`: 290 original dirty/untracked Git entries, none staged, 41 migrations through 041, original credential-bearing bundled `src-tauri/pharma_local.db` present/unchanged in Git, `src/middleware.ts` present, `PHARMA_SECURITY_RELEASE_APPROVED` unset, no active builds, and `git diff --check` exit 0. Prior 040 stock adjustments, 041 native purchase returns, owner 040 reporting, complete manifest validation and final rehearsal published-source identity pins were inspected and retained. The previous 446/debug, 440/synthetic release, Python 40, Jest 2606 and static 70/70 are correctly treated as *earlier evidence*, not repeated-current test claims.

### Migration 042: append-only purchase journal events for new native postings

- New **forward-only** `042_purchase_posting_events.sql` follows 041 in `main.rs` (and updated migration-list tests). Original 001–041 files were not rewritten. `native_purchase_posting_events` captures an immutable event ID, original purchase invoice identity, explicit pharmacy, active actor and supplier, event kind (`initial`, `edit_delta`, `reverse`), unique actual journal ID, payment method, signed amount in cents, prior/new monetary totals, and a bounded JSON snapshot of the stored original purchase item IDs, original linked stock lots, drugs, quantities, bonus quantities, unit costs, tax and discount at this event. SQL guards ensure a live same-tenant actor/source, completed purchase state, exact two-sided journal lines (inventory asset vs payable/cash), header amount/actor/pharmacy and coherent signed old/new amount. Linked journals, entries and event rows cannot subsequently be updated, deleted or appended to through ordinary SQL. This is **structural, not signed or cryptographically immutable**, and does not prove pre-042 history.
- `commands/purchase_posting_provenance.rs` is an internal fixed native SQL writer, not renderer IPC. It verifies current tenant/actor, source amount, actual line/lot/drug relationship, finite bounded quantity/cost, tax/discount and source count (1–200), then writes the receipt **in the existing native purchase transaction before commit**. Any failed receipt rejects the whole stock/financial operation. Native `apply_purchase_accounting` now writes explicit `daily_journals.pharmacy_id` and returns the actual journal ID to this writer.
- Native completed purchase creation records an `initial` receipt after the invoice lines, stock and balanced journal have posted. The already-established **consumed-stock edit** path retains original consumed-lot costs and posts only an incremental amount; nonzero monetary changes now record `edit_delta` receipts against the new journal after updating the source invoice total. Full completed-invoice replacement or deletion of a **receipted** posting no longer deletes its protected original journals: it creates an equal/opposite balanced `reverse` journal and immutable reversal event, then performs legitimate stock/supplier/cash adjustments and, if editing, posts the replacement invoice as a new `initial` event. Earlier event snapshots survive deletion/re-creation of mutable invoice rows; they are deliberately **not** retroactive FKs to the replaced record.
- Old completed invoices with no 042 receipt continue under conservative legacy protections, including ambiguity/collision checks. When a former purchase invoice line has a NULL stock-lot identity at reversal, its new reversal witness explicitly preserves **`inventoryId:null`, `originalLotVerifiable:false`**; it does not fabricate an original lot. New positive postings require real explicit lot ownership and current non-NULL actor/pharmacy scope. A prior test's NULL actor source was updated to expect fail-closed new posting and subsequent success only with an explicitly assigned actor branch. No customer database has been silently normalized or altered.
- Migration 042 does not provide a guaranteed *request-level* exactly-once nonce for purchase creation if a renderer invents a different invoice ID on retry. Unique journal receipt IDs prevent duplicate claims of **the same journal**, not every possible new-source replay. It also does not receipt zero-monetary-delta stock edits; the mutable purchase source and global account catalog are not all frozen, and privileged DB/file adversaries are outside the protection of ordinary SQL triggers. Full COGS, sales, sale returns, purchase return historical ambiguity, current valuation, supplier/patient balance provenance, financial period close and independent operator acceptance are still incomplete. **No complete stock-ledger/COGS provenance acceptance is claimed.**

### Fixed owner historical reconciliation includes new 042 events

- `financial_source_reconciliation_native.rs` has a further owner-only bounded, parameter-free SQL projection for 042 receipts, checking stored event arithmetic/snapshot shape, actual linked journal existence, immutable owner/pharmacy and posted amount, balanced debit/credit entries, and differentiating **explicit protected source/journal contradictions** from **unverifiable current** invoice deletion/replacement or actor-branch change. New 042 table scan has the same one-million-row precondition and shared 200-finding fail-closed limit; SQLite read-only snapshot is closed on both successful and rejected reports. No renderer-selected SQL, tenant or claimed actor.
- Adversarial read-only synthetic test verifies healthy 042 journal, detects forged stored journal total as `explicit_contradiction`, and treats later deleted mutable invoice identity as `unverifiable_history` rather than presumed fraud. The earlier 040 stock counters retain their original limited meaning. This report still does **not** cryptographically certify any cost/financial history.

### Native backup export authorization race fixed; recovery stays staging-only

- Actual `database_backup.rs` had checked owner/password before potentially lengthy creation of a cross-pharmacy SQLite backup but returned the final archive path without checking whether owner privilege/password had been revoked mid-copy. The export now calls `release_owner_backup_path` to recheck **current live owner status, role and bcrypt password after archive creation and before returning its absolute location**. The synthetic `completed_backup_path_is_denied_after_owner_revocation_or_password_rotation` test disables/demotes the original owner and rotates the credential after producing an isolated backup; stale authorizations cannot receive its path, while new correct credentials work and the existing archive hash remains unchanged. No archive deletion, customer DB modification or online destructive restore is introduced. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` now documents the custody limit: local filesystem users may independently observe archive locations; this is not a signed backup or offline supervisor.

### Verification and release gates (this continuation)

- After repairing fixture/expectation regressions (historical tests expected destructive journal deletion or synthetic NULL actor certification) the **focused Rust purchase suite passed 54/54**; existing purchase-return paths also passed in that suite. New native provenance tamper tests reject journal update/entry deletion/cross-tenant or duplicate journal claims; full transaction tests confirm legitimate replacements and reversals preserve journal history. **Focused owner reconciler 18/18**; **backup export post-copy owner revocation/password rotation 1/1**.
- Full pinned Rust 1.77.2 **debug 448 passed, zero failed, one ignored**. Synthetic secure-release `--release` with **fresh ephemeral non-production Ed25519 verification key**, `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` and `https://licensing.example.invalid`: **442 passed, zero failed, one ignored**. The intentionally ignored real physical TPM acceptance is still not evidence of hardware signoff.
- Python licensing suite rerun **40 passed**. No frontend, TypeScript, package, CSS, Next.js or IPC signature source was changed in this continuation; the earlier verified **TypeScript/ESLint exit 0, Jest 316 suites/2,606 tests passed (prior skips), and Tauri static 70/70** remain valid unchanged-source checkpoints, not newly rerun test outcomes. As no Jest/build rerun was necessary, middleware was never moved this continuation.
- Commercial bundled seed preflight rerun **BLOCKED** with configured user password hash (exit 1 deliberately); approval still unset. Prior read-only production dependency audit's **15 advisories, 13 moderate and 2 low** remains an unresolved baseline; no dependency upgrade or audit-clean claim. No production issuer, production signer, installed signed executable, hardware TPM result, customer accounting acceptance or offline live rollback evidence was invented.

**Unfinished independent code priorities:** native immutable sales and COGS + reversal posting receipts, native sale returns, zero-delta purchase stock corrections and request-level purchase-create replay; bounded 041 source receipts in owner reconciliation; full historical inventory valuation, account/period closure and supplier/patient balancing. **Unmet operational acceptance:** genuine cryptographically signed backup and crash-safe two-person offline restore/rollback, production issuer/key custody and TPM-bound activation, installed signed application acceptance, credential-free seed, dependency remediation review, independent finance signoff and operator approval. Preserve all staged data/evidence. **COMMERCIAL RELEASE BLOCKED.**

### Final workspace preservation check

HEAD `a9411cce`; **292 dirty/untracked** status entries (290 pre-existing, two new untracked purchase-provenance source/migration files); **0 staged**. There are **42** numbered SQL migration files through 042; 001–041 were preserved with no deliberate edits. `src-tauri/pharma_local.db` is present with no Git-status change, `src/middleware.ts` present, approval variable empty, `git diff --check` **exit 0**, and no matching Rust/Cargo/Jest/Tauri-build processes. Neither `git clean` nor reset, stage, commit, customer-DB restore, dependency upgrade, installer publish nor approval override was performed. The connected plan retains pending major financial/recovery/production signoff requirements rather than falsely declaring overall gold-standard completion. **RELEASE BLOCKED.**

## 2026-10-12 continuation: native sale/COGS/return source receipts and online issuer-replay prevention

**Commercial release remains BLOCKED.** The live workspace was checked rather than reset: initial HEAD `a9411cce`, 296 dirty/untracked entries, 0 staged, 43 migrations through the partially prepared 043, original credential-bearing bundled seed unchanged, middleware present, `PHARMA_SECURITY_RELEASE_APPROVED` empty and no matching active test/build process. Changes from the interrupted predecessor's tool history were inspected and retained. Migration 040 stock posting, 041 purchase returns, 042 purchase events/reversals, pinned backup manifest/source identity validation and authenticated isolated staging were not reimplemented. Final live hygiene below.

### Forward-only 043: source-to-journal sales and COGS, return reversals, negative settlements

- `src-tauri/migrations/043_native_sales_cogs_provenance.sql` is appended to the *native licensed startup migration registration* in `main.rs`. Files 001–042 were not edited or reissued. The new `native_sale_cogs_provenance` and `native_sale_return_cogs_provenance` tables use immutable, unique source IDs, canonical UUIDv4 single-use request IDs, authenticated current actor and explicit pharmacy, actual journal IDs, posted revenue/refund and COGS in bounded integer micro-units, counted and bounded JSON source-line snapshots, and business payment/refund method. Both have source/scope/current-actor/journal balancing/account-side checks at receipt insertion, uniqueness constraints, and SQL triggers against changing or deleting protected financial sources, source lines, journals or journal entries. The original sale/return source and journal must be committed with the receipt in the same SQLite writer transaction; insertion failure rolls back money, stock and receipts together. New receipts are **structural SQLite evidence**, not cryptographic signatures or immunity to privileged file modification.
- New `src-tauri/src/commands/sales_cogs_provenance.rs` is an **internal native fixed-query writer**, not renderer-available SQL. It reads the stored native sale/return lines in the current transaction, validates 1–200 rows, finite nonnegative monetary/quantity/cost bounds, explicit inventory lot/drug/pharmacy equality and legacy negative-without-lot constraints, then seals the actual journal and source-line snapshots. It never uses a renderer-claimed actor or pharmacy.
- `critical.rs` now records the sale/COGS receipt directly after a completed native checkout's balanced revenue and inventory/COGS journal; both sale and return accounting journals persist explicit pharmacy ownership. Approved native sales returns create their own one-time receipt referring to the actual return ID, original sale ID, original sale item witnesses, refund and stock/COGS reversal journal. Native current permissions and transaction-owned tenant authorization are still checked under `BEGIN IMMEDIATE`. Zero COGS is represented explicitly when stock was not supplied, not invented as an earlier historical cost.
- A native negative-stock sale may legitimately be settled *later*, once a physical lot is available. `native_sale_negative_settlement_provenance` records that one allowed line mutation separately with original sale and sale-item identity, actual lot, actor/pharmacy, later cost/stock quantity and a distinct linked COGS journal. A restrictive trigger permits only that source line's negative-to-stock change when the settlement receipt is created atomically; the receipt and its journal/entries cannot be overwritten or duplicated. Existing legacy unreceipted negative settlements continue their earlier checked workflow without a fabricated 043 history.
- After code review, new 043 guards were also tightened to prevent changing a receipted completed sale to a draft or reclassifying an approved/posted refund as pending. Existing approved-to-completed refund finalization is permitted without changing money/source identity. Sealed negative-stock settlement cannot change original item ID, sales quantity, price, unit, or unit conversion. These constraints were synthetic-tested and do **not** rewrite earlier data.
- `process_checkout_critical` and `create_return_critical` accept a separate canonical UUIDv4 `requestId` (no claimed user/pharmacy/path/SQL). The browser actions retain their non-Tauri branch; desktop actions and the POS/return UIs pass this new ID and preserve it after ambiguous native failures, rejecting a second post with the same ID instead of silently double-debiting stock, wallet, patient balance or journal. Successful operations clear the UI nonce. An uncertain success may therefore require owner reconciliation/manual lookup rather than blindly issuing a fresh second ID. This is fail-closed, not a guarantee of transparent retry success.

### Fixed authenticated historical reconciliation expanded to 043

- The existing zero-parameter authenticated owner native reconciler now has fixed bounded scans for new sale/COGS, sales-return/COGS, and negative-stock settlement receipts. It cross-checks current source and original sale ownership, journal actor/pharmacy, money and balanced entry totals, source line counts, missing source/lot/journal references and status contradictions. Classification distinguishes stored-provenance `explicit_contradiction` from current-actor/lot historical `unverifiable_history`. Full report has the existing one-million-row per-table bound and 200-finding fail-closed cap, uses one read-only SQLite snapshot and does not change financial history. Synthetic adversarial report testing covers a healthy sale/return, forged linked journal tenant, tampered return journal total and reclassification to a pending return.
- A linked receipt and structurally balanced journal **do not certify historical COGS**, temporal inventory valuation, mutable cost/account catalog history, complete lot movements, discount/tax allocation, purchase-create replay, period close, unsupported historical return references or missing/NULL-tenant legacy state. The new receipt sources are not issuer-signed and the app has no independent acceptance of customer finance history. Continue human/operator reconciliation; do not backfill legacy source claims as authentic facts.

### Production-boundary hardening and safe recovery decision

- In `licensing.rs`, a newly found **online signed-response replay** condition was closed. The previous protected serial high watermark rejected strictly *older* signed activations but allowed an equal-generation active lease to masquerade as a new successful online renewal. The native online installation path now requires an *increased* issuer-signed activation serial for an active grant when an existing anchor is present. Manual/offline re-import of an authentic equal-generation lease and repeated signed revocation tombstones remain accepted under their existing guards. Synthetic signed Ed25519 tests cover equal serial rejection, true increment acceptance, mismatched license identity and non-grant tombstones. This does not prove a production issuer, real TPM or rollback-proof offline clocks.
- No new live-database restore command was added. Existing native backup identity-pinning, post-export owner/password recheck, isolated non-destructive rehearsal, durable request receipts, replay/partial attempt denial and tenant/migration checks remain intact. **Staging is not an authenticated operator-approved offline restore or crash-safe rollback.** No staged evidence was cleared. Real signed backup origin, site identity/key custody, encrypted sensitive snapshot retention and a separate offline supervisor remain acceptance blockers. The offline recovery acceptance document's semantics were **not changed** this increment.
- Concrete 043 integration encountered real synthetic regressions: older minimal checkout fixtures had NULL lot ownership or no tenant journal column; return fixtures needed the new receipt schema and typed REAL conversions; a legacy test updating a sale status lacked the `users` attribution column referenced by the new guard. Those **test-only fixtures were repaired** and reverified without weakening production tenant/current-actor checks. Full test-module imports for new replay tests were also repaired. A Jest expectation for the newly required return `request_id` was updated. These failures are not recorded as persistent regressions.

### Final verification, exact observed outcomes

- Rust debug, pinned `1.77.2-x86_64-pc-windows-msvc`, `cargo test --locked --offline -q`: **451 passed, 0 failed, 1 ignored** (real TPM manual/hardware test). Newly included owner reconciler **19 focused tests pass**; checkout **5 focused tests pass**; targeted status/return regression passed. Earlier 043 focused sales/returns, negative-stock settlement and replay tests were integrated into the full suite.
- Rust synthetic secure-release `cargo test --locked --offline --release -q`, freshly generated **ephemeral QA Ed25519 public verifier**, `tpm-v2` synthetic mode and `https://licensing.example.invalid`: **445 passed, 0 failed, 1 ignored**. This is **not production issuer/TPM/installer acceptance**.
- Python `scripts/licensing` unittest discovery: **40 tests pass**. TypeScript `npx tsc --noEmit --incremental false`: exit **0**. `npx eslint . --quiet`: exit **0**.
- Focused native-boundary/UI Jest **5 suites/34 tests passed**. The first full Jest run found **one genuine stale test expectation** (new return request ID), with 315 passing suites; after the expectation fix, focused return UI **15/15 tests passed** and the final full `npx jest --runInBand --silent` passed **316 suites/2,606 tests**, with the original 1 suite and 3 tests skipped.
- `npm run build:tauri` executed **only after full Jest ended**; static Next/Tauri frontend build exited **0** and restored `src/middleware.ts` successfully. **No installer was built, signed or published.**
- Commercial-seed preflight `node scripts/check-commercial-release-seed.js`: **exit 1 BLOCKED**, because the original bundled DB still contains a configured user password hash. Previous read-only production dependency audit still recorded **15 advisories (13 moderate, 2 low)**; the audit was not rerun or represented as remediated because npm dependencies were unchanged.
- Final live hygiene: HEAD `a9411cce`; **297** dirty/untracked entries (**14 deletions, 144 modifications, 139 untracked**), all retained; **0 staged**; **43** SQL migrations through 043; no tracked changes reported for original tracked migration files; `src-tauri/pharma_local.db` present and no Git-status change; middleware present; `PHARMA_SECURITY_RELEASE_APPROVED` empty; `git diff --check` exit **0**; no matching active test/build processes. The additional dirty status relative to the 296-start checkpoint was **not** cleaned, reset, staged or discarded.

### Still-open original acceptance criteria

**Independent code gaps:** first-class purchase-create request nonce, immutable zero-monetary stock edits, historically complete inventory valuation/COGS and supplier/patient balance, period closure and reversal semantics, authenticated native delivery-collection delta (legacy browser workflow is separate; no desktop issuer-signed delivery acceptance is claimed), robust cross-process crash/restart drills and deep migration compatibility on real legacy installations. Fully provenance-sealed journals are not proof of externally signed history, and no automatic financial repair was executed.

**External/operational gates:** actual production issuer/keys and serial lifecycle, physical TPM enrollment and rollback tests, signed installed Windows app/updater, cryptographically authenticated and independently approved offline backup/restore supervisor with hard-crash rollback, bundled seed credential remediation by a custodian, dependency review, historical customer accounting acceptance and operator/two-person signoff. `PHARMA_SECURITY_RELEASE_APPROVED` remains **UNSET**. **COMMERCIAL RELEASE BLOCKED.**

## 2026-10-12 continuation: purchase replay custody, delivery collection and zero-delta stock witnesses (044–046)

**Disposition: COMMERCIAL RELEASE BLOCKED.** This is a further bounded, verified code increment, not gold-standard release acceptance. At entry, live HEAD was `a9411cce`, 297 dirty/untracked entries with 0 staged, 43 migrations through 043, unmodified credential-bearing original bundled seed and native middleware present; approval environment variable was unset. Existing work was inspected instead of reapplied, reset or cleaned. All 001–043 migration files were preserved as-is and only forward-only 044, 045, 046 were added. No data restoration, installer generation, signing, migration rewrite or commercial approval was authorized.

### Native 044: durable purchase creation and ambiguous IPC retry boundary

- Added `044_purchase_create_request_receipts.sql`: unique, immutable native creation `request_id` (canonical UUIDv4 at the Rust ingress), one-time `invoice_id`, authenticated actor, tenant, supplier, initial source status/amount/line count and actual native 042 initial journal identity for a completed purchase. Trigger validates current source ownership, line cardinality and exact cents; receipt survives later legitimate source edits/deletion, without backfilling old invoices.
- `save_purchase_invoice_critical` requires a separate native requestId for a new invoice and inserts the receipt **inside the same `BEGIN IMMEDIATE` business transaction** as purchase, stock, supplier accounting and any initial journal; replay rejects and rolls back rather than fabricating a new invoice. Edits to an existing draft/completed invoice retain their distinct existing native lifecycle checks. Renderer supplies neither authoritative actor nor pharmacy.
- The new purchase UI keeps its UUID across rejected/uncertain native responses until a confirmed successful create or an explicit reset; the frontend action forwards it without changing the browser-side lifecycle. This is replay-resistant duplicate prevention, **not proof that a disconnected client always discovers an ambiguously committed invoice**. No recoverable canonical result on nonce replay is yet implemented.

### Native 045: delivery receivable transfer without rewriting original 043 sale

- Added `045_native_delivery_collection.sql`, the fixed `collect_delivery_native` command, and a native fixed `list_pending_deliveries_native` command; desktop `delivery.ts` now uses authenticated native session and tenant boundary. `can_view_delivery` is already the existing catalog's view/manage grant. The legitimate browser delivery workflow remains separate.
- A new canonical UUIDv4 request posts one isolated immutable collection receipt, an actual tenant/actor-tagged, balanced cash-debit/receivable-credit and optional fee-revenue journal, a tenant/open-shift cash movement, and the completed→delivered source status change in **one immediate transaction**. Existing 043 original sale amount, source posting and COGS journal are not rewritten. Original sale **must actually be 043-receipted as a delivery receivable**, with balanced canonical source accounts; older cash-posted or legacy undocumented delivery collections intentionally fail closed for review. The new native queue is a fixed, permission-checked, 200-row-bounded tenant sale read rather than renderer-supplied SQL on protected sales/patient tables.
- Unique sale/receipt/nonce and 045 mutation guards reject forged tenant/journal/shift/movement/fee, duplicate collection, journal rebalancing, deleting proof, modifying already receipted cash and arbitrary sale reclassification. Native frontend retains the request nonce on ambiguous retry and clears on verified success; the database guarantees unique sale collection across independent clients.
- Critical integration check: 043 source reconciliation previously classified every legitimate delivered sale as an explicit contradiction. The owner projection now permits a delivered 043 source **only when a matching tenant-bound 045 receipt exists**; it additionally evaluates the separate delivery journal, entries, collection movement, source linkage and current-actor/shift uncertainty. No broad permission for arbitrary source status rewrites was introduced.

### Native 046: non-monetary consumed purchase stock-edit receipts

- Added `046_purchase_zero_delta_stock_events.sql` and a native writer called from `edit_consumed_purchase` when actual received quantities change but the computed purchase journal delta is exactly zero. No fictitious zero journal is created. The immutable per-line JSON witness stores actual purchase line ID, lot ID, drug, old/new received quantities, old/new available stock, cost/selling snapshots, authenticated current actor, tenant, supplier and amount; the original 042 initial journal is linked when available, otherwise recorded as historically unknown rather than invented. The receipt insert is in the existing purchase edit transaction and aborts all stock changes if the structural checks fail.
- Fixed owner-only reconciliation now includes 044 creation requests, 045 collection and 046 zero-delta events in bounded consistent scans. It distinguishes malformed snapshots and contradicting actual 042/045 ledger references from legitimate mutable current actor, invoice, source or shift state, missing historical original journal and pre-receipt legacy records. All these are **SQLite structural witnesses**, not cryptographically authenticated source signatures, cost certificate, complete historical valuation or independently verified financial books.

### Verification and bounded release safety

- New isolated native adversarial tests exercise 044 nonce/invoice replay after source deletion, duplicate and foreign tenant, forged initial journal/amount; 046 fake lot/tenant/cost delta, no-change and receipt tampering; 045 balanced fee/receivable transfer, hard status/amount/journal/cash immutability, double-collection, denied user, foreign tenant, closed shift, noncanonical mapping, old cash-classified source and tenant-scoped pending queue; and 044–046 owner reconciliation including tampered journal/fee, deleted delivered receipt and legacy uncertainty.
- The **first** complete pinned Rust debug run had **456 passed, 3 failed, 1 ignored**. Its three failures were outdated test-only registered-migration expectations of 43 in `schema.rs`, not failures of new posting or migrations. After updating those checks to 46 and exercising fixed native queue behavior, the **final pinned Rust 1.77.2 debug: 460 passed, 0 failed, 1 intentionally ignored** (manual physical TPM). Fixed focused native delivery: **4 passed**; fixed reconciler and purchase tests passed.
- Fresh synthetic optimized **secure-release** Rust with a newly generated disposable Ed25519 public verifier, `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` (simulation), and non-routable `https://licensing.example.invalid`: **454 passed, 0 failed, 1 intentionally ignored**. This cannot establish real physical TPM, issuer key custody, purchased installation, clock/restore recovery on hardware or production activation.
- Python licensing discovery: **40 passed**. TypeScript `npx tsc --noEmit --incremental false`: exit **0**. ESLint `npx eslint . --quiet`: exit **0**. Focused purchase/delivery Jest initially identified two test-only expectations incorrectly added to the unrelated completed-purchase edit IPC; after correction, **3 focused suites/14 tests passed**. The full Jest and static export results, when final, are recorded in the follow-on subsection.
- Commercial bundled-seed read-only preflight still **exits 1, BLOCKED** because `src-tauri/pharma_local.db` includes an already configured password hash. The earlier 15 dependency advisories are a previously recorded baseline, **not freshly audited or remediated** in this code increment.

**Remaining independent blockers:** native 044/046 address only future specified paths, not complete historical purchase/stock valuation, ambiguous legacy cost and COGS or every supplier, patient, cash, closed-period, reversal and negative inventory balance scenario. 045 fails closed for old delivery invoices that cannot establish original 043 receivable; operator remediation is not automated. Offline rehearsal remains isolated, non-destructive and not a signed, custodied, operator-approved crash-safe live restore/rollback. No actual issuer, physical TPM acceptance, code-signed installed application, dependency/seed remediation, historical books approval or operator signoff is available. Original commercial release stays **BLOCKED**, and `PHARMA_SECURITY_RELEASE_APPROVED` must remain unset.

## 2026-10-12 continuation: exact-cent delivery receivables, bounded 045 queue and authenticated ambiguous-commit resolution

**Disposition: COMMERCIAL RELEASE BLOCKED.** This continuation resumed by reading the live workspace, rather than reconstructing or rewriting changes from a compacted tool history. HEAD was `a9411cce`, **302 dirty/untracked / 0 staged**, and **46 forward-only migrations** through 046 were already present, including purchase-create 044, delivery 045 and zero-delta stock-edit 046. The earlier gate's 043 and 044–046 work was retained. The original credential-bearing `src-tauri/pharma_local.db`, all original migrations and customer databases were left untouched. No Git reset, clean, stage, commit, destructive recovery, issuer-signing credential, installer publication or release approval occurred.

### New integrated implementation and explicit constraints

- **Prospective native delivery settlement precision:** `src-tauri/src/commands/critical.rs` now checks the fully computed completed checkout total when `payment_method='delivery'` before writing the sale, stock or journal. Amounts must be representable in exact currency cents and no greater than the native 045 collection limit; fractional-cent totals such as **69.005** are rejected instead of minting a sealed 043 receivable that the 045 collector cannot subsequently convert to cash. Other payment methods and draft lifecycle are not globally repriced. A new synthetic checkout regression asserts error plus unchanged invoice count, journal count and stock before a valid delivery still posts. **Existing already-sealed 043 deliveries with incompatible historical sub-cent totals remain uncollectible via 045 and require individually authenticated operator review and a separately designed forward-only accounting correction; original 043 evidence must not be rewritten or silently rounded.**
- **Native tenant-bound delivery queue without a >200-item denial of service:** `src-tauri/src/commands/delivery_collection_native.rs` replaces the old 201-row fail-closed threshold with a fixed **100-row** descending `(created_at, id)` keyset page, explicit `hasMore` / `nextCursor` and bounded cursor validation. Native actor/permission/tenant and immutable 043 receipt linkage remain mandatory. `src/app/actions-client/delivery.ts` transports the cursor only on desktop while preserving its independent browser queries. `src/components/sales/DeliveryManagementClient.tsx` offers load-more, accurate incomplete-queue messaging, retryable later-page errors, duplicate suppression and stale-response cancellation. It does not claim that the visible 100 entries are the full tenant backlog.
- **Authenticated read-only resolution of a lost native collection acknowledgement:** added and registered `confirm_delivery_collection_native`. A timeout or missing successful IPC response triggers a separate fixed SQL read, **not a second mutation within the action**. Confirmation requires a currently authorized native actor in the current pharmacy, the same canonical request UUID, sale, exact delivery fee, 043 original receivable amount, a delivered source, the immutable 045 collection receipt, actual original/collection journal and balanced canonical collection entries, and matching tenant/actor/shift cash movement. An unrelated operator, sale, fee, nonce, cross-pharmacy record or incomplete journal cannot be treated as collection success. The existing database writer still rejects duplicate nonce/sale attempts; a persistent uncertain outcome retains the same nonce. Structural SQLite witnesses do not confer external cryptographic provenance against privileged file mutation.
- The new delivery source and JS/UI tests exercise **206 source deliveries** through pages `100 / 100 / 6`; 201-row frontend pagination `100 / 100 / 1`; cursor tampering, foreign actors and pharmacies, different fees, sale IDs and nonces, missing receipt, wrong-side acknowledgement, closed historical shift, error/retry and stale page responses. The browser financial workflow was not silently changed to Tauri-only. No new SQL migration was needed, and no recovery or destructive restore semantics changed; `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` was intentionally left alone.

### Exact verification and failed-run history

- Focused pinned 1.77.2 Rust checkout regression: **1 passed**; focused native delivery suite: **6 passed**. Full pinned Rust debug `cargo test --locked --offline -q`: **462 passed, 0 failed, 1 intentionally ignored**. Afterwards, installed stable `rustfmt` formatted the native delivery source without a semantic change (the pinned 1.77.2 toolchain has no rustfmt component); the subsequent optimized synthetic release compiled the formatted source. The ignored manual physical-TPM acceptance test was not executed.
- Full pinned optimized **synthetic secure-release** Rust with a freshly generated disposable Ed25519 **public verifier**, nonproduction `tpm-v2` simulation mode and `https://licensing.example.invalid`: **456 passed, 0 failed, 1 intentionally ignored**. These tests are not real TPM, custody, online production issuer, signed installer or hardware recovery acceptance.
- Python licensing `python -m unittest discover -s scripts/licensing -p 'test_*.py' -v`: **40 passed**. TypeScript `npx tsc --noEmit --incremental false`: exit **0**. ESLint `npx eslint . --quiet`: exit **0**. Focused delivery Jest initially: **5 suites / 26 tests passed**; after adding the 201-row frontend page regression, the dedicated delivery UI file passed **11 tests** in isolation.
- The first comprehensive Jest run at the default **5-second per-test timeout** ended with **315 suites passing, 2 test timeouts, 1 skipped** (2,616 individual tests passed, 2 timed out, 3 skipped). The two timeouts were 201-delivery-page rendering and an unrelated existing 201-patient refresh. **Both complete files passed independently at the default timeout**; the second full `npx jest --runInBand --silent --testTimeout=20000` run then exited **0**: **317 suites passed, 1 skipped; 2,618 tests passed, 3 skipped**. The first timeout result is not misrepresented as a passing run.
- Only after Jest stopped, `npm run build:tauri` exited **0**, exported **70/70** static pages, and its temporary middleware move was undone (`src/middleware.ts` exists). This builds frontend assets; it is **not** a signed installed desktop binary. `git diff --check` returned **0** with known harmless CRLF/LF warnings. The original seed read-only commercial preflight continues to exit **1, BLOCKED**: configured user password hash. No advisory upgrade was attempted; previously reported dependency advisories are not newly audited in this increment.
- Final live hygiene after static build and documentation: HEAD **`a9411cce`**, **305 dirty/untracked** (14 tracked deletions, 147 tracked modifications, 144 untracked), **0 staged**, **46 migrations**, original `src-tauri/pharma_local.db` present with no Git-status change, middleware restored, approval variable empty/unset, **zero matching active Pharma Cargo/Jest/static-build processes**, and full `git diff --check` exit **0**. These entries were intentionally preserved without reset, cleanup, staging or committing.

**Remaining independent blockers (unchanged):** complete historical valuation/COGS and end-to-end supplier, patient, cash, negative-stock and reversal accounting certification; recovery of legacy/incompatible delivery postings; a genuinely custodied, independently authenticated, quiesced and crash-safe offline live restore/rollback with operator acceptance; real production licensing issuer/key governance and physical TPM/clock/activation acceptance; code-signed installed Windows release; commercial seed credential remediation and dependency advisory resolution; independent accounting and operator approval. No production certificate has been issued. **COMMERCIAL RELEASE BLOCKED; never set `PHARMA_SECURITY_RELEASE_APPROVED` based on these synthetic checks.**

## 2026-10-12 second continuation — purchase create acknowledgement, isolated staged-copy custody and competing delivery collectors

**Disposition: COMMERCIAL RELEASE BLOCKED.** Reconciled live worktree and the prior session's 044–046/045 implementation, native/JS delivery confirmations, operator documentation and prior passing checks *before editing*. Live start was HEAD `a9411cce`, **305 dirty/untracked** (14 tracked deletes, 147 modified, 144 untracked), **0 staged**, 46 original/forward migrations, original untouched `src-tauri/pharma_local.db` (58,687,488 bytes), middleware present, no running test/build processes and `PHARMA_SECURITY_RELEASE_APPROVED` unset. The 46 existing migration contents have a sorted per-file SHA-256 aggregate `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; the original seed SHA-256 is `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. These were captured as *baseline* protection checks, not cryptographic origin signatures. The previous 462/456 Rust and 2,618 Jest results were prior-turn evidence, **not** imputed to the new code.

### Atomic purchase creation: resolve an uncertain response without re-posting

- New fixed native `confirm_purchase_creation_native` command in `purchase_creation_confirmation_native.rs` with `commands/mod.rs` and `main.rs` registration. The current authenticated session actor, live active user, **actual** `can_view_purchases` permission and stored tenant establish ownership; the renderer supplies no actor/branch/SQL. A canonical UUIDv4 and bounded expected supplier, initial status, original line count and exact source cents only constrain a **read-only** lookup. The native query joins immutable `native_purchase_create_requests` (044) to a still-existing, unchanged current invoice and, for a completed purchase, the original immutable 042 purchase-posting event, exact native journal tenant/actor, balanced inventory debit versus payable/cash credit, original monetary and line snapshots and real owned lots. Missing/modified/deleted/reassigned cross-tenant, tampered accounting and changed purchase contents fail closed. A committed writer receipt is neither reinserted nor used to bypass the database unique nonce. Current permission can be explicitly revoked even from a non-owner; a legitimate pharmacist with the required purchase grant is not forced to become owner to confirm its own write.
- The 044 receipt never stored an immutable *full draft cart*. Accordingly, an ambiguous **nonempty draft** cannot be certified only from its supplier/status/count: native confirmation returns **no acknowledgement** instead of guessing that a same-count edited draft is the original. A zero-line unchanged draft can be confirmed. The new fixed native acknowledgement is for *future native 044 creations*, not historical invoices, invoices legitimately edited since creation, or reconstruction of unknown cost/COGS.
- The existing desktop `createPurchaseInvoiceAction` attempts the authenticated fixed confirmation before creating on a retry/reload, and again after a writer IPC failure. It checks the returned nonce, status, supplier, cents, line count and invoice identifier against caller expectations, never invokes the financial writer **twice inside one action**, and preserves the original IPC error when the proof cannot be established. The browser's separate workflow was retained.
- The purchase creation form now persists a scoped canonical nonce **together with the exact original form fingerprint** in sessionStorage *before* invoking the writer. Reloading the same form reuses the same nonce and can resolve an ambiguous commit; changing the form cannot silently acknowledge another invoice, allocate a second identity for an uncertain first write, or erase the pending identity using New/Cancel. After authenticated success only, the pending identity and autosaved draft are cleared. If the original request is indeterminate and contains nonempty draft lines, the operator must retain the evidence for reconciliation; automatic abandonment or a new nonce is deliberately disallowed. SessionStorage is not independent, durable cryptographic custody and can be cleared by the operating system or user, so it is not an absolute cross-process idempotency guarantee.

### Recovery rehearsal: staged clone cannot masquerade as a different source at receipt time

- `src-tauri/src/database_backup.rs` now checks all three expected attempt members (`attempt_started.json`, copied `backup_manifest.json`, staged `pharma_local.db`) and refuses unexpected files, notably `-wal`/`-shm` sidecars that SQLite could otherwise interpret without altering the copied DB's prior hash. Native file identities, staged SHA-256 and exact manifest/start bytes are pinned and compared before *and* after the asynchronous migration/tenant/SQLite integrity checks, and once more at final create-new success-receipt publication, retaining compatible Windows native read handles. The staged SQLx SQLite connections use `.immutable(true)` to ignore sidecar changes, whereas source live backup verification stays WAL-aware. A forged/missing/substituted clone or edited attempt evidence cannot silently become a verified rehearsal via these checked paths. No historical backup bytes or existing rehearsal attempt are erased on rejection; the original live application DB is not replaced, renamed or updated.
- Added synthetic staged-custody tests for injected `-wal`/`-shm`, changed clone bytes, changed staged manifest/start receipt, and byte-identical new-file identity; all require rejection and no verified receipt or source mutation. These are *local structural and filesystem* witnesses, **not** a signed provenance chain, physical power-loss rehearsal, two-person release approval, post-receipt anti-tamper policy or crash-safe live rollback/switch procedure. Detailed updated acceptance limits are in `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md`. **Destructive restoration remains disabled.**

### Genuine two-connection delivery posting race

- Added a real two-connection synthetic SQLite test to `delivery_collection_native.rs`: two independent native collectors use separate UUIDv4 nonces against a shared tenant sale simultaneously under the existing `BEGIN IMMEDIATE` writer, asserting **exactly one** 045 receipt, delivery cash movement and balanced journal, delivered status and original invoice amount unchanged. The application writer and 045 migration were not re-created or weakened. An initial Windows-only *test-fixture* attempt to generate the temporary disk DB from an in-memory `VACUUM INTO` did not publish its expected file, producing one focused test failure (`unable to open database file`); replaced that synthetic setup with direct creation in a unique temporary file and the named concurrency test then passed. No customer database or earlier migration was used as test input.

### Synthetic verification of this increment (not production acceptance)

- Focused pinned 1.77.2 native purchase confirmation **3/3 passed**; complete `database_backup::tests` **22/22 passed**; two-independent-connection delivery race **1/1 passed after the fixture correction**. Full pinned debug Rust `cargo test --locked --offline -q`: **467 passed, 0 failed, 1 intentionally ignored** (manual real hardware TPM).
- Full pinned optimized **synthetic secure-release Rust** using a fresh disposable 43-character base64url Ed25519 **public verifier**, `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` simulated mode and nonroutable `https://licensing.example.invalid`: **461 passed, 0 failed, 1 intentionally ignored**. The real production issuer, physical TPM, signed installed installer, trusted time and recovery acceptance have **not** been tested.
- Python licensing discovery `python -m unittest discover -s scripts/licensing -p 'test_*.py'`: **40 passed**. `npx tsc --noEmit --incremental false` and `npx eslint . --quiet`: exit **0**. Focused native 044 acknowledgement frontend: **10/10 Jest tests passed**; reload/persistent nonce and original-form preservation: **3/3 Jest tests passed**. Rust `rustfmt --check` on new/extended native files and scoped `git diff --check`: exit **0**. The broader full Jest and static Tauri export outcomes are documented in the final follow-up checkpoint below rather than assumed from earlier runs.

### Commercial gate remains closed

No existing migration 001–046 was modified; no migration 047, seed replacement, customer DB write, staging/commit/reset/cleanup, native destructor, license issuer/signing secret, release approval or installer publication was performed. New 044 read-only acknowledgement does not certify historical costs, full draft contents, closed periods or every supplier/return/reversal flow. Recovery staging remains an isolated **copy verification** with unsigned custody, not a production restore. Independent historical COGS/valuation and business ledger acceptance, legacy fractional-cent delivery and source repair, authenticated offline quiescence/replacement/rollback, production issuer/real physical TPM, signed installation, commercial credential-bearing seed remediation, dependency advisory disposition and operator/finance signoff **all remain outstanding**. Commercial release is **BLOCKED**, and `PHARMA_SECURITY_RELEASE_APPROVED` must stay unset.

### 2026-10-12 final resumed verification, static export and custody checkpoint

After a tool-history interruption, the next session first re-read the live source and **recovered the finished Jest process result** rather than restarting the suite blindly. The prior in-progress second *full* `npx jest --runInBand --silent --testTimeout=20000` run had actually completed with exit **0**: **319 suites passed, one suite skipped; 2,631 tests passed, three skipped, no failures** (237.229 s). The first full Jest attempt in the preceding session had exposed **one** regression in `inventory-notifications.regression.ts`: its generic native mock returned a *sale-shaped* object without a purchase invoice `id`, which the newly strict purchase writer correctly rejects. The test double was corrected to model `confirm_purchase_creation_native` separately and return an actual purchase creation `id` only for `save_purchase_invoice_critical`, while preserving a real failed-write/no-notification case. That file passed 6/6 focused, and the second full suite passed the corrected case plus the new 044 nonce-reload and acknowledgement tests. No production financial writer was loosened for the old mock.

Only **after** full Jest had exited was `npm run build:tauri` invoked (Next.js 15.5.27 static desktop export). The command exited **0**, compiled successfully, generated **70/70** static pages, exported **2/2**, and reported `Restoring middleware to src/middleware.ts...`. Post-build independent filesystem inspection confirms `src/middleware.ts` present; **no** `middleware_temp.ts`, `actions_temp` or `api_temp` remains. There was one nonfatal Node `--localstorage-file` warning during static generation; no build failure or release acceptance claim. This export **does not** build, sign, publish or test an installed Windows installer. Jest and the static Tauri build **never overlapped**.

Final post-build integrity: Git HEAD unchanged `a9411cce`; **308** dirty/untracked entries (14 pre-existing tracked deletes, 147 modified, 147 untracked; baseline 305 entries preserved, only new scoped untracked sources/tests added), **0 staged**, **0** relevant active test/build processes; `git diff --check` **exit 0** (Git emitted nonfatal existing CRLF conversion warnings). Exactly **46 migrations**, with the same per-file SHA-256 aggregate `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945` and no modified historical migrations. Original `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA-256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3` (identical to pre-work baseline); no customer database was opened for this verification. The new native confirmation command remains registered. No unrelated Git clean/reset/stage/commit or destructive restore occurred.

The actual commercial-seed preflight was run explicitly and **correctly BLOCKED (exit 1)** because the bundled seed still contains a configured user password hash. Python licensing 40/40, pinned debug Rust 467 passed/one hardware-acceptance ignored, disposable-key optimized synthetic secure-release Rust 461 passed/one ignored, TypeScript, ESLint, scoped Rust formatting and source diffs remain the earlier completed passing evidence; none was equated with installed/production acceptance. No production Ed25519 issuer, real license verification key, physical TPM validation, signed installer, authenticated offline switch/rollback or financial operator signoff was supplied. **`PHARMA_SECURITY_RELEASE_APPROVED` remains unset; COMMERCIAL RELEASE BLOCKED; the original gold-standard objective remains OPEN.**

## 2026-10-12 further continuation — forward-only 047 original native draft custody and lifecycle guard

**Disposition: COMMERCIAL RELEASE BLOCKED; original gold-standard objective remains OPEN.** Before editing, the live connected workspace was rechecked at `a9411cce`: 308 dirty/untracked entries, 0 staged, 46 migrations, the original 58,687,488-byte seed, restored `src/middleware.ts`, no related build/test processes, and `PHARMA_SECURITY_RELEASE_APPROVED` unset. The original 001–046 per-file SHA-256 aggregate using upper-case file digests is `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; original bundled seed SHA-256 is `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. The prior 044–046, 045 collection, purchase nonce/reload, licensing and offline staging work was present and was **not reconstructed**.

### Prospective draft original request and persisted content

- New forward-only `047_purchase_draft_create_witnesses.sql` adds `native_purchase_draft_create_witnesses`, keyed one-to-one to the existing immutable 044 request nonce. It stores the authenticated creator and pharmacy, invoice ID, SHA-256 of the **typed native original draft request**, and an independent SHA-256 of a fixed SQL projection of the **persisted draft header and ordered line identities/content**. Unique nonce and invoice IDs, source/044 ownership and status checks, lowercase hex constraints and no-update/no-delete triggers protect the **structural SQLite receipt**. No old 044 rows are backfilled, and no 001–046 SQL or SQLx checksum was changed.
- The trusted `save_purchase_invoice_critical` path computes the original typed request digest from the actual native DTO, not a renderer-claimed hash. It writes both the existing 044 replay receipt and the new 047 source digest after the invoice and lines are written **inside the same native writer transaction**. Receipt failure aborts invoice/stock/accounting changes. Current-session actor, live purchase permission and real pharmacy remain authoritative. Original draft metadata (dates, supplier, notes, payment/check data, discounts, tax) and source line identity, drug, units, quantities, expiry, costs, selling prices, bonus, conversions, barcode and lot linkage are included in the source projection. A legitimate subsequent edit leaves the original receipt intact but cannot be mistaken for the unchanged original draft.
- `confirm_purchase_creation_native` now accepts an optional **full expected typed draft request**; the Rust command derives the expected request digest itself, verifies it against the 047 original request receipt, independently recomputes the persisted source digest, and checks the existing 044 actor/tenant/source status/count/amount constraints and absence of later financial events. These checks, live actor and permission are performed under **one SQLite read snapshot**, preventing a source edit between receipt and digest queries from mixing inconsistent committed states. Wrong nonce, content, permissions or pharmacy fail closed. Old nonempty 044-only drafts remain **unverifiable** rather than being certified by line count. Existing completed purchase acknowledgement continues using 042 journal/lot validation and does **not** become a full original-cart fingerprint for historical completed purchases.
- Desktop `createPurchaseInvoiceAction` passes the **same normalized native payload** to the new read-only draft verification and its one allowed writer attempt. The existing scoped sessionStorage nonce/form fingerprint, ambiguous-read-before/write/read-after logic, and Cancel/New fail-closed behavior are retained. Browser/web purchase workflow remains independent; no client-provided hash is treated as trusted financial evidence.
- The optimistic creation path's check that a missing `expected_existing_status` cannot edit an already-existing invoice ID was previously guarded by `#[cfg(pharma_security_release)]`. It now executes in **every native build configuration**. Explicit `completed` -> `draft` downgrade rejection and transactional source status checks remain in place.
- Fixed owner-only native reconciliation now counts/scans 047 as a separately identified source and distinguishes malformed/orphaned original witness linkage (**explicit contradiction**) from a currently missing or reclassified edited source (**unverifiable history**). Its SQL-only projection does **not** recalculate arbitrary mutable full source hashes or certify historical costs. The authenticated purchase acknowledgement performs the stronger current-content equality check when the original native draft can be safely recovered.

### Synthetic adversarial and first-failure evidence

- Native read-only confirmation synthetic cases validate a legitimate matching nonempty draft, reject altered same-count quantity, cost, drug, notes, missing expected typed request, foreign actor/tenant, source deletion/reassignment and attempted witness update/delete. Focused `purchase_creation_confirmation_native::tests`: **5 passed** after implementing a consistent read snapshot. Existing completed purchase/zero-line legacy behavior also passes.
- New transaction-level native test creates a real draft through the native checked writer, records 044 and 047 in one SQL transaction, verifies the one-to-one receipt, then attempts a different draft with the same nonce and confirms **rollback without a second source**. Focused **1 passed**. The first attempt used an invalid empty-cart *test fixture*, causing the purchase validator to reject the test input (`Purchase items are required`); the fixture was changed to a valid line, with no relaxation of the production validator.
- New owner-only 047 reconciliation test distinguishes invalid original digest or missing 044 linkage from mutable source absence. Focused **1 passed**. Its first minimal projection-only synthetic fixture lacked `purchase_invoices.status`/`user_id`; the test-only fixture was expanded to match actual schema and passed. A first Rust compilation also correctly caught an owned `pharmacy` value reused after a SQL bind (`E0382`); the SQL bind was made borrowed and the focused native suite passed. These first failures were **not production posting or release acceptance successes**.
- Frontend focused purchase acknowledgement and persisted nonce reload/cancel: **2 suites, 15 tests passed**, including new complete native draft expected payload and rejected-witness paths; targeted ESLint passed. Full pinned Rust **debug: 472 passed, 0 failed, 1 intentionally ignored physical-TPM manual test**; scoped stable rustfmt check passed. Pinned optimized **synthetic secure-release Rust: 465 passed, 0 failed, 1 ignored**, using a fresh disposable Ed25519 public verifier, nonproduction `tpm-v2` simulation and `https://licensing.example.invalid`. Python licensing **40 passed**; TypeScript `npx tsc --noEmit --incremental false` and full ESLint `npx eslint . --quiet`: **exit 0**. No production issuer key was created or claimed.

### Unchanged independent gates

Prospective local SHA-256 values plus SQLite triggers are **not cryptographic origin authentication** against a privileged database editor or an independently custodied signature. SessionStorage can still disappear, old 044 nonempty drafts cannot be retrospectively attested, and the original completed request does not yet have full-cart custody. No general source-to-ledger historical financial or COGS/valuation certification follows from this work; old fractional-cent deliveries, supplier/patient/cash/period/reversal acceptance remain open. The original credential-bearing seed, real TPM, production issuer, signed installed Windows application, authenticated crash-safe offline restore and rollback, dependency advisory disposition, two-person/accounting/operator approval remain unresolved. **No destructive restore, installer publication or commercial approval was performed.**

### Final verified suite, build and live custody checkpoint

- After the new 047 owner projection and test fixture correction, final **pinned Rust 1.77.2 debug** ran **473 tests: 472 passed, 0 failed, 1 deliberately ignored physical TPM manual acceptance**. Installed stable `rustfmt --check` on changed native source exited 0; pinned 1.77.2 Rust itself was used for tests. **Optimized ephemeral synthetic security-release** with freshly generated disposable Ed25519 verifier, simulated `tpm-v2`, and `.invalid` issuer URL ran **466 tests: 465 passed, 0 failed, 1 ignored**. These are code/tests, not real issuer or installed hardware certification.
- Python licensing unittest discovery **40 passed**; `npx tsc --noEmit --incremental false` **exit 0**; `npx eslint . --quiet` **exit 0**. Focused new purchase frontend 2 suites/15 tests passed. Final complete `npx jest --runInBand --silent --testTimeout=20000` **exit 0: 319 suites passed, 1 skipped; 2,633 tests passed, 3 skipped, 0 failed**, completed in 200.845 seconds. The pre-existing skipped suite and three skipped tests were not counted as passes.
- Only **after Jest exited**, `npm run build:tauri` **exit 0**, Next.js **15.5.27** compiled successfully, generated **70/70** static pages and exported **2/2**. The script explicitly restored `src/middleware.ts`; post-build inspection found no `middleware_temp.ts`, `actions_temp` or `api_temp`. The build emitted the already-known nonfatal `--localstorage-file` Node warning. **No Windows installer was constructed, signed, installed, tested or published.**
- Final live repo checkpoint: HEAD `a9411cce`; **309** dirty/untracked paths (**14 tracked deletions, 147 tracked modifications, 148 untracked**), **0 staged**. The prior 308 entries were left intact and new migration 047 is the only new status path. Exactly **47 migrations** now registered: original 001–046 aggregated SHA-256 **`38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`** (unchanged), original bundled `src-tauri/pharma_local.db` SHA-256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`** and size **58,687,488 bytes** (unchanged). `git diff --check` **exit 0**, middleware restored, zero matching active Cargo/Jest/Next test/build processes and approval environment variable empty. No Git reset, clean, stage, commit or seed/customer DB mutation occurred.
- Explicit commercial seed preflight `node scripts/check-commercial-release-seed.js` **exit 1, BLOCKED**, because the bundled original seed still contains a configured user password hash. **This guard must remain enforced; do not bypass it** to build an installer. Offline recovery acceptance document remains unchanged because this increment did not change backup/recovery behavior.

**Disposition: `PHARMA_SECURITY_RELEASE_APPROVED` UNSET; COMMERCIAL RELEASE BLOCKED.** Original independent acceptance remains open: historical inventory valuation/COGS and supplier/patient/cash/closed-period/return books; handling of old incompatible delivery receivables; signed/custodied non-destructive recovery and independently approved crash-safe offline live switch/rollback; production Ed25519 issuer/activation authority and physical TPM/device replay evidence; signed installed Windows binary; commercial seed credential remediation, dependency advisories, accounting/operator/two-person signoff. Migration 047 seals new *draft* original-request and current-source witnesses but cannot certify legacy original requests, historical financial correctness, signed custody or production acceptance.

## 2026-10-12 further integrated finance/activation continuation — 048 and signed revocation high-watermark

**COMMERCIAL RELEASE BLOCKED.** The live starting state was rechecked before editing: Git HEAD `a9411cce`, 309 dirty/untracked, zero staged; the previous 47 migrations through `047_purchase_draft_create_witnesses.sql`, purchase nonce/acknowledgement, native 045 delivery collection, reconciler, recovery staged-copy custody and all prior code remain present. Original 001–046 migration aggregate remained `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; existing 001–047 aggregate remained `0677713c651cc48e50acfe466392b81b919b85fe32e0d4d4436d7d827f62ff0f`. Original bundled seed SHA-256 remained `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3` (58,687,488 bytes). Middleware present; approval unset; zero relevant active builds at entry.

### Native negative-stock sale/COGS settlement — shared writer fix, no migration

- The existing `settle_negative_sale_item_tx` could reduce current COGS by a mutable, approved `return_items` row even when the sale had an immutable 043 receipt but the supposed return had **no 043 reversal receipt**. A forged or tenant-inconsistent accepted return could therefore reduce/erase the later COGS/stock settlement without a verified original refund/reversal. In the existing `BEGIN IMMEDIATE` authenticated inventory-management writer, protected 043 sale settlements now verify original sale tenant and the precise negative sale item against the immutable original 043 line snapshot. Every counted approved/completed return against that line must link to a tenant-matching 043 sales-return/COGS reversal; otherwise the settlement fails before mutating sale lines, stock or journal. Source amount and quantity have native upper bounds; sums of returned quantities greater than the original sold quantity fail closed rather than silently clamping away financial cost.
- The same native writer now requires explicit current sale and inventory **pharmacy ownership** and finalized status; missing/NULL `sales_invoices.pharmacy_id` or NULL lot pharmacy is no longer silently treated as `local_default` when consuming stock to create a COGS journal. Unreceipted historical legacy sales remain **unverifiable**, and their missing ownership/status is not retroactively invented. This is not complete historical COGS certification and does not resolve legacy cost/lot recovery. Shared master-drug catalog ownership is unchanged; browser workflow untouched.
- The adversarial Rust test constructs a **real synthetic 043 original sale/journal receipt**, adds a forged unreceipted approved return, asserts settlement rejection, deletes only that synthetic attempted return, and then validates legitimate single-use stock/COGS posting, rollback and owner/tenant/lot restrictions. First focused compilation caught test-only missing `sqlx::Executor` method scope and was corrected using the existing `sqlx::query(...).execute(&mut conn)` pattern. First fixture runs exposed missing test-only invoice header fields, then a mismatched positional `INSERT INTO sales_invoices` after the columns were added; corrected **only** the synthetic fixture. Final focused settlement test **1 passed**, no loosened production validator.

### Forward-only migration 048 — supplier purchase-return and cash-to-receipt evidence

- Added `src-tauri/migrations/048_purchase_return_supplier_cash_provenance.sql`, registered after 047 without editing historical 001–047 SQL or SQLx checksums. Existing 041 protected original purchase-return source/lines/journal, but left `supplier_transactions` mutable/deletable and cash refund movement without an immutable source ID. New prospective SQL insert guards require exact 041 supplier return amount/cardinality, correct signed cash payment offset, and for cash refund exactly one matching `cash_movements` receipt with `source_type='purchase_return'`, `target_name=return ID`, authenticated actor, actual pharmacy, shift ownership and amount. Post-seal SQL triggers reject UPDATE/DELETE/extra inserts against linked supplier and cash posting rows. No fake historical supplier/cash ownership is backfilled.
- Native `purchase_returns.rs` creates the new cash source/tenant link **inside its existing atomic authenticated return/stock/supplier/journal/041 receipt transaction**, using the same trusted return ID and original authenticated actor/pharmacy. Synthetic tests sabotage supplier/cash rows to ensure rollback; verify no duplicate/extra transaction and post-seal mutation; and exercise upgrade of prior 041 receipts, leaving formerly unlinked cash as **historically unverifiable**. `purchase_returns::tests`: **9 passed, zero failed** in final worker-run focused pinned Rust test. The owner-only pre-existing fixed supplier-return claim report remains a limited structural/historical report; SQLite triggers are not independently signed financial custody or proof of closed books.

### Activation high-watermark revocation replay correction

- In `src-tauri/src/licensing.rs`, an authentic signed revocation with serial N could previously leave only the highest serial N in the protected local anchor; an older authentic **active** grant at the *same* serial N could be manually reimported and reacquire access. Native `LocalAnchor` now serde-defaults and persists `revoked_at_highest_serial`, rejects same-generation nonrevoked claims after an accepted tombstone, clears that flag only for a genuinely later verified active generation, and checks a still-installed issuer-signed tombstone when importing with an older-format anchor. This does not manufacture production signing credentials, trusted time, hardware measurements or online issuer acceptance.
- The new synthetic Ed25519 regression `signed_same_generation_grant_cannot_undo_persisted_revocation` exercises real signed grant/tombstone equality, renewed higher serial and pre-upgrade anchor decoding. Focused test first ran 1/1; final full pinned Rust suites incorporate the completed implementation. Backward-compatibility limit: if a prior-version anchor had no tombstone flag **and its signed tombstone was removed before the upgraded application could inspect it**, the missing revocation cannot be reconstructed from that old anchor. Full local-state rollback/clock and physical TPM acceptance remain open.

### Verification and unresolved acceptance

- Changed native Rust code formatted with installed stable rustfmt; final pinned Rust 1.77.2 **debug 474 passed, zero failed, one intentionally ignored manual physical TPM test**. Fresh disposable Ed25519 verifier and `.invalid` authority synthetic secure-release optimized Rust: **467 passed, zero failed, one ignored**. Python licensing discovery **40 passed**; TypeScript and full ESLint both exit 0. The existing unused `STOCK_LOSS_JOURNAL` diagnostic warning remains nonfatal. Frontend full regression and separate Tauri static export outcomes are recorded in the final following checkpoint, not inferred early.
- No existing SQL migration checksum, customer database, seed, recovery evidence, staged file, unrelated untracked work, dependency version or release artifact was deleted/rewritten. **No destructive restore or production issuer/hardware test** was introduced; `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` is unchanged because backup/recovery semantics were not modified in this increment.
- **Outstanding:** independent old/legacy source-to-COGS/valuation certification, supplier/patient/closed-period/return/reversal books, uncollectible legacy delivery compensation, cryptographically authenticated financial and backup custody, independently approved offline quiescence and crash-safe switching/rollback, signed installed app, production issuer and physical TPM, seed credential remediation, dependency risk disposition and accounting/operator/two-person approvals. `PHARMA_SECURITY_RELEASE_APPROVED` must remain **unset** and release **BLOCKED**.

### Final 2026-10-12 serial verification and custody checkpoint

After the bounded source changes were complete, a single full pinned Rust 1.77.2 debug run exited **0: 474 passed, zero failed, one ignored physical TPM test**. Disposable-key optimized synthetic secure-release Rust exited **0: 467 passed, zero failed, one ignored**. Python licensing unittest discovery ran **40 passed, zero failed**. `npx tsc --noEmit --incremental false`, `npx eslint . --quiet`, changed native rustfmt verification and `git diff --check` each exited **0**. Full frontend `npx jest --runInBand --silent --testTimeout=20000` ran **319 suites passed, 1 suite skipped; 2,633 tests passed, 3 tests skipped, zero failed**, exit **0** in 206.78 seconds. Skips are not acceptance evidence. The first scoped Rust compiler/fixture failures and corrections are recorded above; final native and browser suites were not weakened to pass those fixtures.

Only after Jest exited, `npm run build:tauri` ran and exited **0**. Next.js 15.5.27 compiled successfully, generated **70/70** static pages, exported **2/2**, and explicitly restored `src/middleware.ts`. Independent inspection confirms middleware is present, and `middleware_temp.ts`, `actions_temp`, `api_temp` are absent. One familiar nonfatal Node `--localstorage-file` warning was emitted. No installer, signature, installed GUI acceptance or publication was performed; Jest and the build did not overlap.

Final live workspace: HEAD `a9411cce`, **310 dirty/untracked** entries (14 tracked deletes, 147 tracked modifications, 149 untracked), **zero staged**, **zero** matching Cargo/Jest/Tauri static-build processes, `PHARMA_SECURITY_RELEASE_APPROVED` **empty/unset**, and `git diff --check` exit **0** (nonfatal Git line-ending notices remain possible). The previous 309 dirty entries were preserved; exactly one new migration 048 was added. **48** SQL migrations are registered. The original 001–046 SHA-256 aggregate remains `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; original 001–047 aggregate remains `0677713c651cc48e50acfe466392b81b919b85fe32e0d4d4436d7d827f62ff0f`. Original bundled seed remains **58,687,488 bytes**, SHA-256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. No older migration or SQLx checksum, customer DB, original seed, prior recovery evidence, release artifacts or unrelated tracked/untracked work was reset, cleaned, staged, committed or deleted.

The real commercial seed gate `node scripts/check-commercial-release-seed.js` was run and **correctly BLOCKED**, exit **1**, because the original bundled database still contains a configured user password hash. Do not bypass this. Existing isolated backup staging and non-destructive recovery remain as previously recorded, **not** an authenticated crash-safe production restore. No production Ed25519 issuer, real physical TPM test, installed Windows code-signature, books certification, owner/operator two-person acceptance or dependency-risk signoff was supplied. **Commercial release remains BLOCKED and original gold-standard project remains OPEN; PHARMA_SECURITY_RELEASE_APPROVED must remain unset.**

## 2026-10-12 later continuation — independent 041/048 return financial reconciliation and indexed custody

**Original commercial objective OPEN; commercial release BLOCKED.** Before editing, live HEAD was `a9411cce`, 310 dirty/untracked paths, zero staged, no related build/test processes, 48 migrations through 048, middleware present, approval unset. Actual 047 draft source witnesses, 048 prospective supplier/cash triggers, native negative-stock/COGS source check, production-guarded purchase lifecycle and signed-activation revocation high-watermark fixes were already present. Previous full Rust debug **474/0/1 ignored**, disposable-verifier release **467/0/1 ignored**, Python licensing 40, TypeScript, ESLint, Jest **319 suites / 2,633 tests**, and Tauri static build **70/70 pages, 2/2 exports** were recovered from the existing gate and **not needlessly rerun before code changes**. Existing original migration and seed digests matched the preceding custody record.

### Source-grounded gap, minimal integrated fix

- The fixed native owner-only financial reconciliation scanned `supplier_transactions` looking for inconsistent return claims, but a **completely deleted/missing** supplier return claim has no row to scan. It did **not** independently start from each immutable 041 `native_purchase_return_provenance` receipt and recheck the original return's identity, refund/tenant/cents, original two-entry balanced journal, or the exact supplier refund/payment and prospective 048 source-linked cash movement. Thus migration 048's structurally protected supplier/cash claims could not be independently reviewed by the fixed native operator report if a legacy/pre-migration supplier claim was already absent or damaged.
- Reused `financial_source_reconciliation_native.rs`'s **existing single read-only SQLite transaction, live native session owner gate, fixed SQL, bounded amounts/identities and 200-finding fail-closed limit**. Added one bounded per-041-receipt structural projection. It checks original invoice/return linkage and pharmacy, actor-bound journal ID/tenant/total, exact one debit and credit equal to the sealed amount, correct supplier return/payment row count and amounts, and the 048 cash movement's original source key, actor, tenant and amount. Added supplier/receipt/cash scan row caps. No renderer-provided SQL or identities.
- The report explicitly distinguishes **source/journal/cash contradictions**, **missing/wrong supplier ledger claims**, and **unverifiable historical cash**. A 041 cash refund without a source-linked 048 movement may predate 048 and is **not** called proven tampering. Current mutable supplier balances, shift/account classification and historical inventory valuation are not certified. Existing SQL triggers and the writer still govern actual transaction atomicity and authorization; this change does not write or rewrite historical financial data.
- Prior 048 triggers and the new source-first diagnostic both look up `supplier_transactions.reference_id` and `cash_movements(source_type,target_name)`. No matching general-purpose reference indexes existed; repeated scans could cost disproportionately on large customer databases. A **minimal forward-only migration 049**, `049_purchase_return_reference_indexes.sql`, adds exactly these two native SQLite indexes. Registered version 49 in startup and updated migration count tests. No tables, historical source/stock/journal/receipts, protected 001–048 migration SQL or SQLx checksums changed. Source-grounded synthetic `EXPLAIN QUERY PLAN` assertions verify each real indexed lookup. Migration 049 was included in the retained native purchase-return migration fixtures; the pre-048 legacy-cash upgrade test still preserves unknown historical links.

### Adversarial verification and first failures

- New `owner_detects_missing_supplier_rows_and_distinguishes_legacy_cash_from_forgery` builds synthetic 041 original return, original journal and 048 supplier/cash claims. It checks current owner authorization, detects **completely missing** supplier refund despite no surviving claim, wrong cash tenant, missing historical cash link as **unverifiable**, incorrect supplier payment amount, forged return supplier, wrong journal pharmacy, and both indexed lookup plans. This is structural SQL/custody evidence, **not** an external signature.
- First focused full reconciliation tests: **20 passed, 3 failed**, because the old **synthetic fixture only** had positional five-column `INSERT INTO purchase_returns VALUES` after the projection fixture gained its required `refund_method` column. Replaced those three test inserts with explicit original five column names. No production table or validation was relaxed. Focused reconciliation suite subsequently **23 passed, 0 failed** both before and after the 049 index integration.
- Final pinned `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --manifest-path src-tauri/Cargo.toml --locked --offline -q`: **475 passed, 0 failed, 1 ignored physical TPM manual test**, exit **0**. Fresh disposable Ed25519 public verifier, synthetic `tpm-v2` and `.invalid` authority optimized pinned Rust release: **468 passed, 0 failed, 1 ignored**, exit **0**. Changed native source checked with stable rustfmt. The preexisting unused `STOCK_LOSS_JOURNAL` test constant warning remains nonfatal. This is synthetic acceptance only; no actual TPM/issuer/device validation.
- No Python licensing, TypeScript, ESLint, frontend Jest or static Tauri export input changed. Their prior passing runs remain documented above and were **not rerun**. In particular no Jest or static build was started, so no middleware rename sequence took place. Offline backup/rehearsal code was not altered, and `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` remains unchanged.

**Unresolved production gates remain unchanged:** historical supplier/COGS/valuation and patient/cash/period/reversal certification; incompatible old delivery receivable compensation; signed external financial and backup custody; independent owner/finance/operator approval; production issuer, physical TPM and signed installed Windows binary; dependency advisory disposition; original configured-password bundled seed remediation; quiesced, independently approved, crash-safe offline live database switch and rollback. No destructive restore, production key, installer publication or release approval was attempted. **`PHARMA_SECURITY_RELEASE_APPROVED` remains unset and commercial release BLOCKED.**

### Final live post-049 custody and release preflight

Last verified HEAD `a9411cce`; **311 dirty/untracked** (14 pre-existing tracked deletions, 147 tracked modifications, 150 untracked) from prior 310 without removing any prior changes; **0 staged**; **49 migrations**, latest forward-only 049. Original 001–046 per-file SHA-256 aggregate unchanged `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; 001–047 aggregate unchanged `0677713c651cc48e50acfe466392b81b919b85fe32e0d4d4436d7d827f62ff0f`; 001–048 aggregate unchanged `7b69fbfddc7c4b588f42be29836a1d5f8d2c93f9f842d55677cbb4cfe832e500`. The original bundled `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA-256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, and was never opened for mutation. `git diff --check` **exit 0**; `src/middleware.ts` present, no `middleware_temp.ts`, `actions_temp`, or `api_temp`; zero matching Cargo/Jest/static-build processes; approval environment variable **empty/unset**. Real `node scripts/check-commercial-release-seed.js` **exit 1, BLOCKED** because the bundled seed still contains a configured user password hash. This safeguard is intentionally preserved. **The original gold-standard commercial project stays OPEN and release BLOCKED.**

## 2026-10-12 later integrated continuation — protected negative-stock conversion, exact purchase-return depletion, independent COGS amount and preview WAL custody

**Original commercial objective OPEN; COMMERCIAL RELEASE BLOCKED.** Reconciled the actual live repository before editing: HEAD `a9411cce`, 311 dirty/untracked, 0 staged, 49 SQL migrations through 049, no outstanding Cargo/Jest/Next builds, restored `src/middleware.ts`, commercial approval variable unset, original bundled seed intact. Prior 047 draft nonce/request and source witnesses, 048 supplier/cash provenance, 049 indices, 043 sale COGS and negative-stock receipts, fixed native actor/tenant boundaries, and 049 source-first owner reconciliation were already present and **not reimplemented**. Recovered prior focused reconciliation 23/23, pinned Rust debug 475/0/1 hardware ignored, disposable-key optimized Rust 468/0/1 ignored and previous unchanged browser/Python/build evidence. The first hash script accidentally used a literal backslash-n separator; corrected **LF-separated** per-file uppercase SHA-256 aggregation matched original 001–046, 001–047 and 001–048 baselines. No protected migration, DB or SQLx checksum was changed.

### Exact native stock/COGS and purchase-return financial corrections

- **043 protected negative-sale settlement:** the native writer formerly copied the replacement lot's current `large_to_medium`/`medium_to_small` conversions into the **original sealed sale line**. A legitimate replacement lot with different packaging then tripped migration 043's immutable historical conversion trigger, aborting settlement and stranding legitimate stock/COGS accounting. The shared `settle_negative_sale_item_tx` now preserves the original historic sale conversion on 043-receipted lines while using the selected tenant-owned lot's current conversion for actual inventory deduction and corresponding COGS journal. Unreceipted legacy paths retain their existing conversion behavior and are not retrospectively certified. Existing auth, current permission, tenant, original negative line, stock, journal, receipt uniqueness and transaction rollback remain intact. Synthetic test uses original sale conversion 10×2 and actual selected lot 5×4, verifies successful one-time correct quantity/COGS journal and that the original conversion remains 10×2. **Focused native settlement 1 passed, zero failed**.
- **Native purchase-return exact depletion:** source review found preflight and atomic stock `UPDATE` accepted an inventory shortage up to `0.000001` stock unit then silently clamped the resulting negative quantity to zero. At 0.9999995 available, 1 unit return and 100,000,000 monetary unit cost, the transaction could credit the **full** 100,000,000 inventory/refund despite having less physical stock to return. One adversarial synthetic test reproduced the bug **before correction**: focused session 10498 exited **1**, because `unwrap_err()` received a successful full refund. The existing purchase-return writer now requires exact `available >= stock_quantity` both at preflight and conditional SQL `UPDATE`, and uses exact subtraction with **no silent clamp**. An insufficient lot therefore rolls back the entire source/stock/supplier/refund/journal/041/048 receipt transaction; the adversarial test checks no source, journal or supplier balance mutation and unchanged lot. Final scoped purchase-return test session 35848 **10 passed, 0 failed**, exit 0; no new migration or unrelated source edit was required.
- **Owner-only 043 settlement journal accounting:** existing fixed native `SALE_NEGATIVE_SETTLEMENT_STRUCTURE` checked receipt journal header, row count and balanced debits/credits but not **each** debit/credit against the original sealed COGS micros. Two balanced entries of 3 could incorrectly pass a receipt/header of 5. Added exact one debit and one credit at the sealed amount in the same read-only owner query. Synthetic test changes both journal lines from 5 to 3: status is now **explicit_contradiction**, while an original valid witness remains clean. Live owner gate and snapshot rollback still apply. Focused fixed financial reconciliation suite **24 passed, zero failed**. Structural balance/account observations are **not** historical signed account valuation certification.

### Recovery preview WAL substitution boundary

- The prior backup **preview** rejected SQLite WAL/SHM sidecars when scanning the directory, but then opened the snapshot using ordinary SQLx `read_only(true)`. A local actor creating a WAL **after the directory scan** could cause SQLite to validate the WAL's different logical financial state while the unsigned manifest SHA-256 and independent file hash still attested only the main DB bytes. Reused the rehearsal's immutable SQLite snapshot connection options for preview; live source/owner/password validation remains WAL-aware, and previews remain read-only. Adversarial synthetic test `preview_immutable_reader_rejects_wal_only_financial_repair` puts an unbalanced original journal (75) in the main file and a correcting 100 value only in WAL. Ordinary read-only inspection accepts the WAL repair; the exact immutable preview reader sees 75 and rejects it. Preview never mutates, installs, replaces or deletes live databases. Recovery worker focused test **1 passed**, full backup/recovery module **23 passed**, licensing module **19 passed**. Updated `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` with this narrow semantic improvement and remaining limits. This is **not** cryptographic backup origin custody or crash-safe live restoration acceptance.

### Validation, boundaries and pending commercial acceptance

- After all these changed native sources were present, pinned Rust 1.77.2 **debug 478 passed, zero failed, one intentionally ignored manual TPM test**, exit **0**. Existing harmless dead-code warning for `STOCK_LOSS_JOURNAL` remains. Optimized fresh disposable-key `tpm-v2`/nonproduction `.invalid` synthetic secure-release outcome follows in the final verification subsection. No production Ed25519 issuer/device/TPM certificate or signed installer was invented or accepted. The changed source was tested with real SQLx transaction and synthetic financial schema rather than customer databases. Source and tests reused the existing writers, native SQLite constraints and fixed owner queries; no extra scaffolding, dependencies or migrations.
- Original source-to-ledger finance acceptance remains incomplete: legacy cost/lot provenance, historical supplier/patient/cash balances and periods, old fractional-cent delivery receivables, global account reclassification, and independently signed immutable financial custody need separate acceptance. Preview's hash and SQLite sidecar handling do not stop every privileged/local-file mutation or prove actual issuer identity, secure offline switching, crash-safe rollback or two-person operator approval. **Destructive live recovery remains disabled; original credential-bearing seed preflight must remain BLOCKED; PHARMA_SECURITY_RELEASE_APPROVED must stay unset.**

### Final consolidated synthetic verification and custody checkpoint

- After completing all changed native sources, pinned `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --manifest-path src-tauri/Cargo.toml --locked --offline -q` finished **exit 0: 478 passed, 0 failed, 1 manual physical TPM test intentionally ignored**. Fresh disposable Ed25519 public verifier with synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` and `PHARMA_LICENSE_AUTHORITY_URL=https://licensing.example.invalid`, pinned optimized Rust `--release -q`: **exit 0: 471 passed, 0 failed, 1 ignored**. Real TPM/issuer/key custody are still untested. The changed 043 settlement focused test **1 passed**, owner-only reconciliation focused **24 passed**, purchase-return focused **10 passed**, recovery `database_backup::tests` **23 passed**, licensing Rust focused **19 passed**. Initial purchase-return precision test **failed as intended** before its writer fix (session 10498) and then passed; there were no final failed Rust tests.
- Existing Python licensing **40 passed**, TypeScript, ESLint, frontend Jest **319 suites/2,633 tests passed**, and Tauri static export **70/70 pages; 2/2 exports** were already completed with unchanged Python/web source inputs. Those unrelated full suites/builds were deliberately **not rerun** merely for native Rust changes. No Jest/Tauri-build overlap occurred in this increment. `src/middleware.ts` remained present; `middleware_temp.ts`, `actions_temp`, and `api_temp` absent. No installer/signature was produced.
- Final live HEAD `a9411cce`, **311 dirty/untracked** (14 tracked deletions, 147 tracked modifications, 150 untracked), **0 staged**, **49 original migrations still present with no new migration**, zero matching active Cargo/Jest/Tauri static builds, `PHARMA_SECURITY_RELEASE_APPROVED` **unset**, and `git diff --check` **exit 0**. Protected sorted per-file upper-case SHA-256 LF aggregation: 001–046 `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; 001–047 `0677713c651cc48e50acfe466392b81b919b85fe32e0d4d4436d7d827f62ff0f`; 001–048 `7b69fbfddc7c4b588f42be29836a1d5f8d2c93f9f842d55677cbb4cfe832e500`; 001–049 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`. Original `src-tauri/pharma_local.db`: **58,687,488 bytes**, SHA-256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. No git reset/clean/stage/commit, existing migration or checksum rewrite, customer DB change, backup deletion, destructive live restore, dependency upgrade or installer publication.
- The real commercial seed check `node scripts/check-commercial-release-seed.js` still **exits 1, BLOCKED** with the configured password hash in the original bundled seed. It has not been bypassed. This bounded source/test increment does **not** complete independently certified historical accounting/COGS/valuation, issuer/TPM and signed installed device acceptance, credential remediation, dependency risk disposition, quiesced crash-safe externally approved offline replacement/rollback, or independent finance/operator approvals. **Commercial release remains BLOCKED and the original gold-standard objective OPEN.**

## 2026-10-12 next continuation — exact native POS/negative-settlement stock accounting and live-site rehearsal custody

**Commercial release BLOCKED; original gold-standard objective OPEN.** Entry inspection confirmed actual live HEAD `a9411cce`, **311 dirty/untracked (14 deletions, 147 modifications, 150 untracked), zero staged**, migrations 001–049 installed in source, original seed untouched, middleware present and no active test/build processes. Existing 047 original draft witnesses, 048 return supplier/cash custody, 049 lookup indexes, 043 sales COGS/returns, native idempotency and owner reconciliation were present. Previous pinned debug Rust **478 passed/1 ignored** and synthetic optimized Rust **471 passed/1 ignored** were recovered, not rerun until real source edits. Applied the installed `/skills/ponytail/SKILL.md` root-cause/SQLite-first workflow without speculative abstractions or a new migration.

### Confirmed financial defect and repair — completed native POS checkout

- Source: `src-tauri/src/commands/critical.rs::process_checkout_tx_with_request`, the common authenticated, tenant-owned `BEGIN IMMEDIATE` native checkout writer. A stock-capacity allowance `+0.000001` let a cart request **1** large unit against **0.9999995** on-hand, the loop stopped with a positive but sub-tolerance remainder, and `UPDATE inventory` silently clamped nearly negative quantities to zero. The system could post full requested sale revenue and journal/043 COGS while storing a sale item for **less** than the charged quantity. A high-cost synthetic lot makes the monetary risk concrete. This is not harmless display rounding.
- Added a synthetic adversarial regression **before editing the writer** in `checkout_handles_batch_fallback_and_wallet_accounting`. Pinned Rust test **exit 1**: `unwrap_err()` received a successful `CheckoutResult` for the short-stock paid sale (session 37751). Repaired the root once: completed nonnegative checkout requires complete actual batch capacity; source loop does not silently ignore positive remainders; the atomic inventory mutation requires exact available quantity and subtracts exact stock without a clamp. It retains the existing current-actor permissions, pharmacy/lot/expiry selection, trusted accounts, balanced journal, receipt nonce, and all-or-nothing transaction.
- Expanded that same test to prove the **authorized** negative-stock option legitimately records the fractional shortage as a separate negative line instead of discarding it; original sold quantities sum to the complete requested unit and transaction rollback restores test inventory. Following fix, focused test `checkout_handles_batch_fallback_and_wallet_accounting` **passed 1/1** (session 46074), and expanded explicit-negative regression **passed 1/1** (session 79609). Existing browser forms and shared master catalog unchanged.

### Confirmed financial defect and repair — delayed negative-sale stock/COGS settlement

- Source: the same file's `settle_negative_sale_item_tx`, which already verifies actor, live inventory permission, tenant, finalized original sale, 043 exact negative source snapshot and tenant-bound receipted returns. It still accepted a lot shortage under `+0.000001` and clamped `quantity-? < 0.000001` to zero, permitting overstated stock consumption/COGS. In the real 043 synthetic witness fixture, the sale needed **0.2** large unit but the selected tenant-owned lot had **0.1999995** at **1,000,000,000** cost/unit.
- Added the adversarial case **before the production correction**. Focused Rust **exit 1** because `unwrap_err()` instead received an incorrect successful native receipt/COGS for **200,000,000** (session 64646). Replaced the preflight and conditional `UPDATE` tolerance with exact `stock >= deduction` and exact subtraction. On a short lot, the entire source/stock/COGS journal/immutable receipt write is rejected and rolled back. Focused settlement `negative_stock_settlement_is_scoped_guarded_and_accounted_once` then **passed 1/1** (session 54786). Prior 043 protected original sale conversion stays unchanged as corrected in the previous increment.

### Non-destructive offline rehearsal — final live context check

- `src-tauri/src/database_backup.rs::stage_recovery_rehearsal_on_source` compared the staged copy with the initial **live** migration lineage and pharmacy/tenant fingerprints, then published `rehearsal_verified.json` even if another native process altered live tenants or migration history during the long copy/integrity run. Added a minimal `require_unchanged_rehearsal_site` late validation of **current** live migration checksums and tenant set immediately before successful receipt publication, preserving the original staged/source identity pins and no-overwrite/started-receipt interruption custody.
- New synthetic `rehearsal_receipt_rejects_live_tenant_or_migration_change_after_initial_match` verifies a staged copy initially matches, then separately changes live tenant ownership and migration history without changing backup bytes. Both deny a successful current-site receipt. Focused new test **1 passed**, full `database_backup::tests` **24 passed** (worker evidence), and `git diff --check` passed. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` was updated for this limited read-only rehearsal semantics. It is **not** an exclusive live lock, signed backup authenticity, quiesced switch or crash-safe restore; a mutation immediately after the final check still needs independent operations acceptance. No destructive live restore enabled.

### Test strategy and acceptance limits

- Final changed-source Rust debug pinned 1.77.2 **479 tests passed, zero failed, one intentionally ignored physical TPM test**, exit **0** (session 98519). Disposable-verifier synthetic optimized secure-release suite is recorded in the final following checkpoint; do **not** treat synthetic `tpm-v2`/nonroutable authority or ignored physical TPM as production authorization.
- Native Rust sources and offline acceptance document changed; **Python licensing, TS/ESLint, Jest and Tauri frontend static-build inputs did not**. Their previously recorded licensing Python 40, TypeScript/ESLint, Jest 319 suites/2,633 tests and static export 70/70/2/2 passes were retained rather than gratuitously rerunning unchanged suites. No middleware rename/build activity was invoked this increment. `database_backup.rs` contains three pre-existing rustfmt style differences outside these new edits; the scoped recovery code and focused checks compiled and passed. No SQL migrations 001–049, SQLx checksum, original database/customer file, installed artifact, signed recovery evidence or dependency was altered.

**Still blocked externally:** certified historical COGS, valuation, supplier/patient/cash/closed periods/returns, legacy fractional delivery receivables, independent signed finance and backup custody, physical TPM/production Ed25519 issuer/activation and signed installed Windows application, commercial seed credential remediation, dependency risk disposition, authenticated quiesced crash-safe offline replacement/rollback and independent finance/operator/two-person signoff. `PHARMA_SECURITY_RELEASE_APPROVED` remains unset, and the overall project remains **OPEN**.

### Final post-checkout-fix pinned verification and custody

- Final pinned Rust 1.77.2 **debug 479 passed / 0 failed / 1 ignored** (exit 0, session 98519); fresh disposable Ed25519 public verifier, synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` and `PHARMA_LICENSE_AUTHORITY_URL=https://licensing.example.invalid` **optimized release 472 passed / 0 failed / 1 ignored** (exit 0, session 72757). This does not provide issuer, physical TPM, installed hardware or signed-app acceptance. The unrelated pre-existing `STOCK_LOSS_JOURNAL` unused-constant warning remains nonfatal. All affected focused checks were successful after both pre-fix failures; Python and frontend inputs remain unchanged.
- Final workspace **HEAD `a9411cce`; 311 dirty/untracked (14 tracked deletions, 147 tracked modifications, 150 untracked), zero staged, 49 migrations** and no matching active Cargo/Jest/static-build process; `src/middleware.ts` present, no temporary build paths; `PHARMA_SECURITY_RELEASE_APPROVED` blank/unset; `git diff --check` exit 0. Pre-existing work and recovery evidence preserved, no Git reset, clean, staging or commit. Original 001–046 aggregate `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`, 001–047 `0677713c651cc48e50acfe466392b81b919b85fe32e0d4d4436d7d827f62ff0f`, 001–048 `7b69fbfddc7c4b588f42be29836a1d5f8d2c93f9f842d55677cbb4cfe832e500` and 001–049 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c` remain unchanged (sorted per-file uppercase digest / LF aggregate). Original bundled `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`.
- Unmodified real commercial seed preflight `node scripts/check-commercial-release-seed.js`: **exit 1 / BLOCKED**, due to a configured user password hash in the original bundled seed. This gate must not be bypassed. Original commercial acceptance remains **OPEN / BLOCKED**; no destructive live restore, fabricated issuer credentials, dependency upgrades, signed installer or release approval was performed.

## 2026-10-12 continuing financial provenance and recovery-preview authorization increment

**Original commercial release OPEN/BLOCKED.** At entry HEAD `a9411cce`, 311 dirty/untracked, zero staged, no matching active Rust/Jest/Tauri build, 49 forward-only migrations through 049, `src/middleware.ts` restored, `PHARMA_SECURITY_RELEASE_APPROVED` unset. Original 001–049 migration hashes and the protected seed matched the prior checkpoint. Historical 040 stock, 041 purchase return, 042 purchase, 043 sale/return/COGS, 044–047 delivery/purchase/draft and 048 supplier/cash protections and 049 indexes were present. Previous native pinned 479-debug/472-synthetic-release and unchanged browser/Python suite successes were recovered rather than repeated without source changes. Installed `/skills/ponytail/SKILL.md` full policy was used for source investigation and minimal root-cause edits.

### Negative-sale return arithmetic and independent receipt audit

- `src-tauri/src/commands/critical.rs::settle_negative_sale_item_tx` previously accepted a finalized historical return quantity up to **0.000001 beyond the original sale** and used `.clamp(0,original_quantity)`. That hid over-returned financial source instead of rejecting it, permitting zero-stock/zero-COGS settlement despite contradictory signed-off quantities. A synthetic historical approved return was changed from 4 to **4.0000005** against exactly 4 sold. **Before fix** pinned focused Rust test exited **1**: expected error but obtained `NegativeStockSettlementResult` with zero deducted quantity and zero COGS (session 70296). The common authenticated, tenant-owned native writer now rejects **any** total returned quantity exceeding original sold quantity and computes the exact nonnegative net without tolerance/clamp. No approved/legacy return, historical journal or immutable source receipt was rewritten; the adversarial mutation was confined to an in-memory test. **After fix** settlement focused test exited **0: 1 passed** (session 33205).
- The fixed live-owner-only read-only `SALE_NEGATIVE_SETTLEMENT_STRUCTURE` projection previously checked current sale line, current inventory lot, matching journal entries and actor/tenant, but not independent cost conservation from immutable 043 settlement receipt `stock_quantity × unit_cost` versus `cogs_micros`, original 043 sale-receipt existence, exact sale tenant or stock-lot drug. One bounded SQL projection now checks those structural relationships and emits `sale_settlement_cost_conservation_conflict` or `sale_settlement_source_conflict`; the previous journal and mutable-current-lot classifications remain. This is **structural local ledger evidence, not a signed origin or historical valuation certification**.
- Added synthetic owner-only tests for a receipt whose sealed stock quantity no longer agrees with its COGS amount and for an original sale moved to a foreign tenant; restored both synthetic rows before the existing balanced-but-wrong-journal test. The first 24-test reconciliation run finished **23 passed/1 failed** because the new test inserted a **partial artificial original sale receipt** without its real original journal. An unrelated fixed diagnostic then returned an SQLite integer `SUM(0)` for a missing journal where the report expected REAL. The test fixture—not production accounting—was corrected to supply a full consistent original sale header, journal, debit/credit accounts and 043 receipt. Final focused native reconciler suite **24 passed/0 failed**, exit **0** (session 54413); no production classifier was weakened. The original negative-settlement fixture and existing 043 SQL migration were preserved.

### Non-destructive backup preview — current owner at release

- `src-tauri/src/database_backup.rs::verify_recovery_preview_on_source` validated owner login/password **before** potentially long SHA256/SQLite integrity and manifest checks. A second local application could revoke the actor, change role, or rotate the password while verification ran, yet the first process returned backup verification metadata to the stale owner. The existing read-only source checks now repeat **live owner/password authorization** immediately before preview metadata is returned. A scoped synthetic `recovery_preview_refuses_success_after_owner_is_disabled_during_verification` asserts the late authorization fails after disabling the owner while preserving the backup bytes. Native recovery-preview focused test **1 passed**, complete backup test module **25 passed** (worker verified), and `git diff --check` passed. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` records the semantic change.
- This late check narrows but cannot eliminate revocation immediately **after** the response. Preview only verifies a read-only file; no live database is restored/replaced, and unsigned SHA256 manifest is **not cryptographically authenticated provenance**. Independent operator/finance authorization, filesystem custody, quiesced crash-safe offline switching and rollback remain mandatory and unavailable.

### Remaining acceptance boundaries

Original commercial licensing and gold-standard release are still **BLOCKED**: independently certified historical stock/COGS/valuation, supplier/return/patient/cash/closed-period and legacy delivery receivables, future signed financial custody, production issuer and physical TPM, authenticated installed signed binary, configured-password bundled-seed remediation, dependency advisories, independent operator/finance/two-person approvals and crash-safe authenticated offline recovery. `PHARMA_SECURITY_RELEASE_APPROVED` stays **unset**; no customer DB, existing migration 001–049, SQLx checksum, signed installer or staged recovery evidence may be modified.

### Finalized purchase-return source-line and supplier-refund replay boundary

- Source: the already authenticated native `src-tauri/src/commands/purchase_returns.rs` return writer counts earlier approved/completed purchase returns by known `purchase_invoice_item_id`, or legacy `inventory_id` plus `drug_id`. A prior **finalized return with neither invoice-line ID nor usable original lot/drug linkage** was silently dropped from that lookup; a second request against the same original purchase invoice could certify another full supplier refund, stock deduction, cash movement and balanced 041/048 journal even though the earlier financial claim's original source was unknown.
- Reused native SQL, no new migration: a **bounded existence check before any financial mutation** now rejects an invoice with finalized historical return headers missing lines or finalized return lines which cannot be traced to an actual invoice item by either recognized relation. The return remains available for independent operator reconciliation; no legacy return is falsely attributed, backfilled or erased. The original live current actor, pharmacy, purchase permission, supplier, exact stock writer, 041/048 receipt triggers, journal/rollback and nonce protections are unchanged.
- One in-memory adversarial `finalized_return_without_original_lineage_blocks_new_supplier_refund` supplies an ordinary completed purchase, a historical approved/completed refund of **100** with unlinked line and no lot ID, then requests another 100 refund; asserts rejection before source, supplier balance or journal changes. **Before the code correction**, focused session 76450 exited **1** because the supposedly rejected duplicate returned a successful `PurchaseReturnResult`. **After correction**, focused `purchase_returns::tests` session 45366 exited **0**, **11 passed/0 failed**. Scoped rustfmt and `git diff --check` also exited 0. This is controlled forward-only **refusal to certify ambiguous history**, not accounting repair or independently signed evidence.

### Final consolidated verification, custody and release disposition

- With all changed native financial and recovery code integrated, pinned Rust 1.77.2 `cargo test --locked --offline -q` **exit 0: 481 passed, 0 failed, 1 manual physical TPM test ignored** (session 4146). Fresh disposable Ed25519 verifier public key, nonproduction `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` and `PHARMA_LICENSE_AUTHORITY_URL=https://licensing.example.invalid`, optimized pinned Rust `--release -q` **exit 0: 474 passed, 0 failed, 1 ignored** (session 49729). Focused negative-stock settlement **1 passed**; owner reconciliation **24 passed**; purchase-return **11 passed**; backup/recovery **25 passed**. The early adversarial native settlement and purchase-return test failures and corrected synthetic owner test fixture are documented above. Pre-existing unused `STOCK_LOSS_JOURNAL` warning remains nonfatal. These synthetic results do **not** constitute physical TPM, issuer, Windows installed binary or audited books acceptance.
- Python licensing (prior **40 passed**), TypeScript/ESLint, Jest (prior **319 suites and 2,633 tests passed**) and Tauri static export (**70/70 pages, 2/2 exports**) have unchanged source inputs and were **not rerun solely for native Rust edits**. No overlapping Jest/static build; `src/middleware.ts` is present and `middleware_temp.ts`, `actions_temp` and `api_temp` are absent.
- Final actual HEAD `a9411cce`, **311 dirty/untracked** (14 tracked deletions, 147 tracked modifications, 150 untracked), **zero staged**, **49 pre-existing migrations** (nothing added or modified), **zero** active matching Cargo/Jest/static build processes, release approval **unset**, and `git diff --check` **exit 0**. Original 001–046 SHA aggregate `38b7f7bf77751d320668ec0d8ae730b1e0f3b885742f34cf7055c4ebb7e48945`; through 047 `0677713c651cc48e50acfe466392b81b919b85fe32e0d4d4436d7d827f62ff0f`; through 048 `7b69fbfddc7c4b588f42be29836a1d5f8d2c93f9f842d55677cbb4cfe832e500`; through 049 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, all unchanged. Original `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. No reset, clean, staging, commit, migration/SQLx checksum rewrite, original/customer DB change, recovery evidence destruction or installer publication.
- Real `node scripts/check-commercial-release-seed.js` **exit 1 BLOCKED** due to the original configured password hash. It was **not bypassed**. No external trust, physical TPM acceptance, real production issuer/keys, historical signed finance records or crash-safe exclusive live restoration were established. `PHARMA_SECURITY_RELEASE_APPROVED` **remains unset, commercial release BLOCKED, original Pharma gold-standard project OPEN.**

## 2026-10-12 further source-conservation and recovery custody continuation

**Original gold-standard commercial acceptance OPEN; commercial release BLOCKED.** Reconciled actual live HEAD `a9411cce`, 311 preserved dirty/untracked paths (147 modifications, 14 tracked deletions, 150 untracked), zero staged, 49 migrations, original seed custody, no initial Cargo/Jest/build, restored middleware and unset release flag. Read and followed `/skills/ponytail/SKILL.md` **full**. No existing migrations, SQLx checksums, original/customer databases, signed artifacts or staged recovery evidence were rewritten. The following fixes address new synthetic, source-proven failures; they do **not** certify historical books or independently authenticate a source issuer.

### Original 043 negative-stock sale lineage vs mutable current inventory

- `financial_source_reconciliation_native.rs::SALE_NEGATIVE_SETTLEMENT_STRUCTURE`: the owner-only fixed read snapshot formerly accepted a balanced 043 negative-settlement receipt whose original sale receipt existed but contained **no matching original negative sale line**. Conversely, missing/reclassified **current** inventory returned `sale_settlement_source_conflict` (an explicit original contradiction) before the intended `sale_settlement_current_lot_unverifiable` branch. The same bounded SQL now checks original 043 receipt pharmacy and the immutable original line's ID, negative flag, null original lot, drug and zero original cost, while treating deleted or changed present-day lots as **unverifiable history**. Current lots and local unsigned JSON/SHA witnesses are not signed historical issuer evidence. No rows modified.
- Synthetic `negative_settlement_owner_report_rejects_balanced_wrong_amount_entries` first failed as expected **exit 1**, session `82315`, because a replaced original 043 line escaped detection. The corrected source projection passed focused **1/1**, exit 0, session `73987`; combined adversarial assertions distinguish sealed-line substitution, deleted/mismatched mutable lots, COGS stock×cost mismatch, cross-tenant source and balanced wrong journal. Full owner reconciliation tests **24/24**, exit 0, session `9512`. Stable rustfmt check passed; pinned 1.77.2 rustfmt was not installed, so no toolchain/dependency upgrade was performed.

### Supplier return book-value conservation before atomic posting

- `purchase_returns.rs` native writer already authenticates actor/tenant, validates original invoice/source and stock quantity, and writes purchase return/stock/supplier/cash/trusted journal plus 041/048 immutable evidence in one SQLite transaction. It did **not** compare carrying value of the *actual linked lot stock removed* with the inventory journal credit at original invoice refund value. Synthetic approved source: one purchased unit refunded **100**, live exclusive lot quantity one at carrying cost **25**. Old writer would remove 25 of inventory book value while posting a balanced **100** inventory credit and full supplier refund. The writer now reads the stored linked lot cost, rejects invalid cost, aggregates `returned_stock_quantity × carrying_cost`, and requires that value to equal the supplier refund/inventory credit **to cents** before any financial mutation. Legitimate consistent returns remain available; independently revalued or ambiguous legacy stock must be reconciled before a two-entry native supplier reversal, not silently treated as a variance-free return. No historical cost was fabricated.
- `rejects_purchase_refund_when_linked_stock_cost_disagrees_with_journal_credit`: pre-fix targeted **exit 1**, session `46286`, because `unwrap_err` got a successful 100 refund. Initial green attempt session `80886` **exit 1** solely from test fixture decoding SQLite INTEGER as REAL; corrected synthetic `CAST`, not the writer guard. Final targeted **1/1**, exit 0, session `66767`, proves no source, supplier balance, inventory or journal mutation when rejected and an ordinary 100-carrying-value refund succeeds. Complete purchase-return module **12/12**, exit 0, session `81298`; rustfmt and diff checks passed.

### Durable start-marker identity across interrupted isolated recovery rehearsal

- `database_backup.rs` previously re-opened `attempt_started.json` during a custody check and compared its identity to **another identity first observed in the same check**: replacing the durable original marker with a byte-identical new file could inherit old interrupted-attempt evidence. `create_new_synced` now returns the created, synced file handle; the rehearsal captures its **creation-time native file identity** and requires that identity at both staging/pre-SQLite and final pre-receipt rechecks, alongside pinned database/manifest identities, member allowlist, absence of WAL/SHM, bytes and SHA-256. Destructive live restore remains disabled. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` was updated for this semantic change and residual privileged file races.
- Synthetic `rehearsal_rejects_byte_identical_replacement_of_started_receipt`: **RED exit 1**, 0/1, because original validator accepted the substituted same-byte marker; after fix **GREEN exit 0**, 1/1. Complete native `database_backup::tests` **26/26**, exit 0, with source/manifest/staged custody and interruption tests. No original backup, protected customer data or preexisting staged receipts were overwritten.

### Integrated synthetic test, custody and release disposition

- With all three edited native areas integrated, pinned **Rust 1.77.2 debug** `cargo test --locked --offline -q` **exit 0, 483 passed, 0 failed, 1 manual physical TPM test ignored**, session `19346`. Pinned **optimized synthetic secure-release** `cargo test --locked --offline --release -q` **exit 0, 476 passed, 0 failed, 1 ignored**, session `87589`. The verifier came from a newly generated disposable Ed25519 key pair with **public** raw key passed in memory only, synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2`, and deliberately invalid/nonproduction `https://licensing.example.invalid`; environment variables were cleared afterward. One earlier Node `-e` key-helper command failed **exit 1** from shell quoting before Cargo launched (session `21393`); corrected stdin-based key generation succeeded (session `71257`). The suites provide neither physical TPM/clock acceptance nor issuer/codesigning credentials or a tested installed binary. Only the pre-existing unused `STOCK_LOSS_JOURNAL` warning appeared.
- Previously verified **unchanged-source** Python licensing 40 tests, TypeScript/ESLint exit 0, Jest 319 passed/1 skipped suites and 2,633 passed/3 skipped tests, and frontend Tauri static export 70/70 pages with 2/2 exports were **not rerun** for these native-only changes. No Jest/build overlap; no signed installer claim.
- Final live custody: HEAD `a9411cce`, **311 dirty/untracked** (147 modified, 14 deleted, 150 untracked), **zero staged**, zero matching test/build processes, restored `src/middleware.ts` and absent `middleware_temp.ts`, `actions_temp`, `api_temp`; `PHARMA_SECURITY_RELEASE_APPROVED` and temporary synthetic verifier/mode/authority environment variables all **unset**; `git diff --check` **exit 0**. All **49** original migrations retain sorted uppercase-per-file SHA256 / LF aggregate `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`. Original seed `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`; real commercial seed preflight again **exit 1 / BLOCKED** because it contains a configured password hash, without bypass.
- **Remaining mandatory external blockers:** independently certified immutable historical finance/stock/COGS/valuation, supplier, cash, patient, closed periods/reversals and fractional-cent legacy delivery receivables; authenticated production issuer/activation/revocation/real TPM; signed installed Windows application and device acceptance; commercial seed custodial remediation; dependency-risk disposition; genuinely signed backup provenance and quiesced crash-safe rollback-capable recovery supervisor; independent finance/operator/two-person authorization and physical interruption tests. A local hash is only structural evidence. **No destructive restore, production secrets, commercial installer publication or approval was undertaken. PHARMA_SECURITY_RELEASE_APPROVED stays unset; ORIGINAL COMMERCIAL RELEASE OPEN/BLOCKED.**

## 2026-10-12 continued original-sale journal integrity, historical refund lineage and snapshot-export custody

**The original gold-standard Pharma commercial objective remains OPEN / BLOCKED.** Reconciled actual HEAD `a9411cce` and installed `/skills/ponytail/SKILL.md` full before new edits: 311 preserved dirty/untracked entries (147 modified, 14 tracked deleted, 150 untracked), 0 staged, 49 migrations, original seed digest/size, middleware present, release approval unset and no active Rust/Jest/build. Previously complete debug 483/0/1 hardware-ignored and synthetic optimized release 476/0/1 were retained as **earlier** results, not asserted as new verification. The work below is new, source-first and tested on isolated synthetic databases. No historical source/journal/customer/seed records, migrations 001–049, SQLx checksums, production signed artifacts, or original backup/recovery evidence were changed.

### Source-linked 043 negative-sale settlement must have a real journal header amount

- `src-tauri/src/commands/financial_source_reconciliation_native.rs::SALE_NEGATIVE_SETTLEMENT_STRUCTURE` already checked source-typed sale-line witness, stock × cost ≈ immutable COGS micros and balanced journal lines. But `ABS(journal_total*1000000-cogs_micros)>2` is SQL NULL when the linked daily-journal header amount is NULL, allowing a COGS journal with **no numeric total** to escape the owner's read-only report despite its two balanced entries. This is a directly contradictory original journal header, not uncertainty about a mutable present-day lot. Added the minimal `typeof(b.journal_total) NOT IN ('integer','real')` branch to the existing fixed bounded SQL projection before the comparison; no new IPC, migration or account mapping logic.
- New synthetic check in `negative_settlement_owner_report_rejects_balanced_wrong_amount_entries` retains an otherwise consistent 043 settlement receipt and its two exact entries, sets the settlement daily-journal total to NULL, demands `sale_settlement_journal_conflict`, then restores the header before subsequent original-line, tenant, cost and balanced-wrong-amount tests. **RED** pinned 1.77.2 focused session `40974`: **exit 0 for PowerShell wrapper, Cargo/test exit 101** (`OWNER_RED_EXIT 101`), test **0 passed/1 failed** because no conflict was reported. **GREEN** complete owner reconciliation `commands::financial_source_reconciliation_native::tests`: session `78531`, **24 passed, 0 failed, exit 0**. Stable rustfmt check and diff check exit 0. The older synthetic original receipt/mutable lot distinctions remain intact.

### Finalized purchase return with contradictory historical line/lot/drug is not a fresh refund opportunity

- `src-tauri/src/commands/purchase_returns.rs` already refused finalized returns with entirely absent original linkage, but historical source anti-join considered any existing `purchase_invoice_item_id` on the same invoice sufficient even if `purchase_return_items.inventory_id` and `drug_id` belonged to a *different* invoice item. Subsequent previous-return lookup for the actual lot then missed this paid earlier refund. A two-line synthetic completed purchase has item A (id 100, lot A, drug 42), B (id 101, lot B, drug 43); a prior completed supplier refund of 100 references item **B** but stores lot/drug **A**, with stock remaining. A new refund for A previously succeeded, risking duplicated supplier money and an apparently balanced 041/048 journal. Historical facts remain contradictory and cannot be guessed.
- Minimal native anti-join change requires `pi.id`, `pi.inventory_id` and `pi.drug_id` all match for a non-NULL historical invoice-line ID. The legacy fallback for NULL original-line IDs still accepts legitimate source-matched lot/drug; unresolved contradictory finalized history blocks *new* posting before supplier balance, cash, stock, source, journal or immutable receipt writes. Synthetic `finalized_return_linked_to_wrong_purchase_lot_cannot_be_refunded_twice` asserts atomic refusal with original balance/stock and journal unchanged, then corrects the **test-only** old line claim to A and verifies existing over-return control denies replay. **RED** pinned session `61168`, exit 1, expected `unwrap_err` received a successful second 100 refund. **GREEN** focused session `64285`, exit 0, 1/1; complete `purchase_returns::tests` session `11954`, **13 passed, 0 failed, exit 0**. Scoped rustfmt and diff checks exited 0. No historical customer return repaired, no migration.

### Fresh exported archive must validate hashed MAIN SQLite bytes, not a late WAL overlay

- `src-tauri/src/database_backup.rs::create_backup_with_lineage` correctly reads the **live source** WAL-aware before `VACUUM INTO`, but its isolated freshly created `pharma_local.db.partial` export was checked with SQLite ordinary `read_only(true)` before SHA-256/manifest calculation. A concurrent local write could place an unbalanced journal (75) in the main exported file and a balanced repair (100) **only** in an added WAL. Read-only SQLite accepted the overlay while the manifest hashed the invalid main snapshot. Existing preview and isolated rehearsal used immutable reads, but this separate *creation* path did not.
- Extracted the existing post-copy check into the minimal `validate_created_backup_snapshot` helper without initially changing behavior, then wrote `created_backup_snapshot_rejects_wal_only_financial_repair`. A synthetic copy of a verified export is altered to have an invalid main journal, WAL-corrected view; ordinary read-only inspection accepts it, but the production exported-main check must deny it. **RED** focused exit 1, 0/1, because the existing validator accepted the WAL-only repair (assertion `Export must inspect the same main database bytes that its manifest hashes`). The fix reuses existing `immutable_snapshot_options(path)` only for the isolated **post-VACUUM** `.partial` validation; the **live source reader remains WAL-aware** for genuine committed transactions. **GREEN** same focused test exit 0, 1/1, and complete `database_backup::tests` **27 passed, 0 failed, exit 0**. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` adds the distinct export threat/fix, without enabling destructive restore. An unsigned manifest remains unauthenticated origin; privileged post-publication tampering is not solved.

### Integrated verification, custody and still-blocked commercial release

- With all three native changes integrated and the exclusive Cargo test slot returned, pinned **Rust 1.77.2 debug** `cargo test --locked --offline -q` finished **exit 0, 485 passed / 0 failed / 1 ignored** (session `46884`); freshly generated disposable Ed25519 **public** verifier, synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2`, nonproduction `PHARMA_LICENSE_AUTHORITY_URL=https://licensing.example.invalid`, pinned optimized `cargo test --locked --offline --release -q` finished **exit 0, 478 passed / 0 failed / 1 ignored** (session `18392`). The public verifier was generated in memory and cleared with its temporary environment variables; no QA private signing key or credential was introduced. The ignored case is physical TPM/operator acceptance, not evidence of hardware success. Existing unused `STOCK_LOSS_JOURNAL` warning remains nonfatal.
- Frontend, TypeScript, ESLint, full Jest, prior Python licensing and Tauri static export source inputs were unchanged, so prior valid Python 40, Jest 319 suites/2,633 tests, TS/lint exit 0 and export 70/70 pages, 2/2 were deliberately **not rerun**. No Jest/build collision, and static export is not a signed installed Windows binary.
- Final custody: HEAD `a9411cce`; 311 dirty/untracked (147 modified, 14 deleted, 150 untracked), **zero staged**, zero active matching builds; `src/middleware.ts` present and temporary frontend build paths absent; approval and temporary verifier/mode/authority environment variables all **unset**; `git diff --check` **exit 0**. Original **49** migration SQL files preserve aggregate sorted uppercase-per-file-SHA256/LF hash `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`. Original `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. Real unmodified `node scripts/check-commercial-release-seed.js` **exit 1 / BLOCKED** due to configured bundled password hash; it was not bypassed.
- **Remaining external acceptance:** independent certification of historical stock/COGS/valuation, purchases/returns/supplier and cash/patient balances, original source/journal/closed periods and old fractional-cent delivery receivables; production issuer/licensing, physical TPM and installed signed Windows binaries, commercial seed custodial remediation and dependencies; cryptographically authenticated backup ownership, independent quiescent offline supervisor with crash-safe live restoration/rollback and two-person finance/operator acceptance. No signed release, customer data overwrite, destructive restore or approval. Local SHA256 is a structural witness only. **`PHARMA_SECURITY_RELEASE_APPROVED` REMAINS UNSET; COMMERCIAL RELEASE IS BLOCKED; ORIGINAL PROJECT REMAINS OPEN.**

## 2026-10-12 further 043 return witness, supplier refund conservation and cash-tenant recovery continuation

**Original commercial license/security/recovery objective remains OPEN; actual release remains BLOCKED.** Live baseline before this continuation: HEAD `a9411cce`, 311 preserved dirty/untracked paths (147 modifications, 14 tracked deletions, 150 untracked), zero staged, 49 old migrations, protected seed unchanged, middleware restored, `PHARMA_SECURITY_RELEASE_APPROVED` unset, no active Cargo/Jest/build and `git diff --check` exit 0. Read `/skills/ponytail/SKILL.md` FULL. Previously completed native 485 debug / 478 synthetic optimized passes were not substituted for new verification. All tests below use isolated synthetic databases; original seed, customer records, signed artifacts, migration 001–049 files and SQLx checksums remain untouched.

### 043 immutable return original-sale line attribution

- `src-tauri/src/commands/financial_source_reconciliation_native.rs::SALE_RETURN_COGS_STRUCTURE` formerly verified `native_sale_return_cogs_provenance.line_snapshot` was a JSON array of the right length and every current return item referenced a row of the original sale, but never verified that *each receipt witness* identified **that actual return row and original sale item**. A source-linked, otherwise balanced return with witness `lineId=44, originalSaleItemId=999, originalSaleId=sale-a` could evade owner diagnostics although the real immutable return row had `sale_item_id=33`. The owner-only bounded query now uses `json_each` over guarded valid JSON to require a matching witness for each actual return row's `lineId`, `originalSaleItemId` and `originalSaleId`. Legitimate return source lineage remains readable; malformed or unrelated witness reports `return_receipt_lines_changed` as an explicit contradiction, without rewriting old sources or implying signatures.
- Extended synthetic `sale_and_return_043_reports_detect_journal_tenant_money_and_source_contradictions` with a correctly identified receipt, adversarial substitution of its original line ID and subsequent fixture restoration. Initial attempted test command session `42647` **failed compilation (exit 101)** due only to incorrectly escaped Rust test fixture JSON; changed that fixture to an explicit Rust raw SQL literal, no production query weakening. Correct RED pinned Rust session `6402` **Cargo exit 101**, 0/1 passed, expected source conflict missing (0 findings). After minimal query repair, entire owner projection module session `83750` **24 passed / 0 failed, exit 0**; stable rustfmt check and `git diff --check` exit 0.

### Finalized purchase refund header vs individual line total conservation

- `src-tauri/src/commands/purchase_returns.rs` already rejects contradictory old invoice-line/lot/drug relationships and ensures current carrying inventory value matches a new supplier refund. But a previously finalized old return could have a **supplier refund and parent return header of 100** while the same return's linked child line sum was **50**. The new purchase return writer used the **old line sum** in its previous-refund allowance and then posted another 50 against an original invoice for 100: **150 total supplier refunds**, even though inventory 0.5 × 100 and new 041/048 entries balanced. This is an old-source amount contradiction, not a license to fabricate a variance or repair historical rows.
- Extended the existing finalized-history preflight to reject nonnumeric parent refund totals or a difference exceeding **0.005** between the historical parent `purchase_returns.total_amount` and SUM of its recorded `purchase_return_items.total_price`, **before** new stock/supplier/journal/source writes. Existing original line/lot/drug requirement, nullable-ID legacy lookup, fractional quantities and present-stock book-value check remain. Adversarial `historical_refund_header_must_match_lines_before_new_supplier_credit` asserts zero further money/stock/returns/journal mutation against an old over-refunded parent; correcting the **synthetic fixture only** to prior paid 50 permits a legitimate remaining fractional 50 refund. Pinned **RED** session `25483`, exit 1 (a second 50 refund returned success); an initial fix attempt session `62539` exited 1 because of a SQL grouping typo, corrected; pinned **GREEN** targeted session `21771` exit 0, 1/1, and full purchase-return module session `35187` **14 passed / 0 failed, exit 0**. Rustfmt and scoped diff checks exit 0. No customer financial rows repaired.

### Isolated recovery tenant comparison must include cash movement financial history

- `src-tauri/src/database_backup.rs::tenant_fingerprint` compared distinct tenant scopes in users/inventory/sales invoices/purchase invoices/returns, but omitted persisted **`cash_movements.pharmacy_id`**. A local, **unsigned** backup could alter only the tenant of a cash movement to `foreign-pharmacy`, update its own manifest hash, and still pass migration and five-table site equality and publish `verified_isolated_copy_only`. This falsely certified the isolated copy's financial tenant universe while cash attribution disagreed. The existing fixed-name, bounded tenant fingerprint now includes the production `cash_movements` table; absent legacy optional tables use the existing safe table-existence branch. Both preview and staged rehearsal compare the same extended tenant universe; original live cash history remains untouched.
- New `rehearsal_rejects_foreign_cash_movements_hidden_from_core_tenant_tables` creates a real isolated synthetic source and owner backup, injects foreign cash tenant **only in the clone**, rehashes the deliberately unauthenticated manifest, demands fail-closed/no successful rehearsal receipt/unchanged live source and safely cleans test artifacts. Prime ran **RED** targeted session `4028`: old validator returned successful `RecoveryRehearsalResult {status: \"verified_isolated_copy_only\"}`; test failed as expected (Cargo `RECOVERY_CASH_RED_EXIT 101`, despite PowerShell wrapper exit 0). After the minimal one-table addition, pinned full `database_backup::tests` session `91964` **28 passed / 0 failed, exit 0**. `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` documents this precise semantic refinement and residual unauthenticated backups. No destructive restore, signing, replacement or rollback was enabled.

### Integrated synthetic evidence, custody and original commercial blockers

- All three edited native paths integrated: pinned **Rust 1.77.2 debug** `cargo test --locked --offline -q` session `45554` **exit 0: 487 passed, 0 failed, 1 ignored**, and pinned **optimized synthetic secure-release** `cargo test --locked --offline --release -q` session `19456` **exit 0: 480 passed, 0 failed, 1 ignored**. Optimized run used a fresh disposable Ed25519 **public** verifier generated entirely in memory, synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` and deliberately invalid production endpoint `https://licensing.example.invalid`; temporary verifier/authority/mode variables were cleared. The ignored manual physical TPM case remains required. Existing unused `STOCK_LOSS_JOURNAL` warning persists and was not silenced. Earlier unchanged-source Python licensing **40 passed**, TS/ESLint exit0, Jest **319 suites/2,633 tests passed**, frontend static export **70/70 pages, 2/2 exports** were not rerun for native-only changes; no signed installer or physical hardware accepted.
- Final actual HEAD `a9411cce`, **311 preserved dirty/untracked** paths (147 modifications, 14 tracked deletions, 150 untracked), **zero staged**, 0 matching active builds, middleware present with temporary paths absent, release approval plus QA verifier/device/authority environment variables **unset**, and `git diff --check` **exit 0**. Original **49** migration files retain aggregate sorted uppercase-per-file-SHA256 / LF hash `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`. Original `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. Real unmodified commercial seed preflight **exit 1 / BLOCKED** because of bundled configured user password hash; it was not bypassed. No reset, clean, staging, commit, historical source mutation, migration/SQLx checksum rewrite, original/customer DB mutation, signed artifact publication or destructive restore.
- **Independent hard blockers remain:** independently certified historical supplier/return/cash/COGS/stock/patient/closed-period accounting and old fractional-cent delivery receivables; real production issuer, activation/revocation, TPM and trusted device clock; signed installed Windows app and real device acceptance; commercial seed sanitization and dependency disposition; authenticated backup provenance, quiesced crash-safe offline restore/rollback supervisor with physical interruption and independent two-person finance/operator approvals. A local receipt hash or isolated rehearsal is not cryptographic historical origin or operational release acceptance. **`PHARMA_SECURITY_RELEASE_APPROVED` REMAINS UNSET; ORIGINAL GOLD-STANDARD COMMERCIAL PROJECT OPEN; RELEASE BLOCKED.**

## 2026-10-12 integrated native return valuation, source refund conservation, supplier cash lineage and offline license clock

**Commercial release remains BLOCKED; the original gold-standard objective stays OPEN.** This is an independent follow-on implementation, not a rerun of the prior 119-call increment or an assertion that local hashes certify historical books. Read `/skills/ponytail/SKILL.md` full and repo `AGENTS.md`. Reconciled live HEAD `a9411cce`; 311 preserved dirty/untracked files (147 tracked modifications, 14 deletions, 150 untracked), zero staged, no active test/build; middleware restored; QA and release-approval variables unset. Protected 49 migrations and original seed matched prior custody identities. Verified previous fixes are present in the live source: 043 return witness original-line relation, finalized supplier-return parent/line totals, actual carrying cost and wrong-line provenance, and isolated recovery tenant cash-movement fingerprint. Independently replayed retained **prior** core test session outputs: owner `83750` **24/24**, backup `91964` **28/28**, debug `45554` **487/0/1 ignored**, and synthetic optimized `19456` **480/0/1 ignored**, all exit0. Earlier purchase-return `35187` **14/14** is documented and the existing source/test are present, but its retained session was unavailable for independent tool replay; that distinction is not collapsed into fresh evidence.

### Actual same-transaction sales-return stock valuation vs historical COGS reversal

- Native sales return `src-tauri/src/commands/critical.rs::create_return_tx_with_request` derives the reversal debit from the **original sale line cost** and the verified returned quantity. Its common `ensure_return_inventory` helper previously reused the historical inventory ID whenever drug and tenant matched, **without checking the current mutable lot's carrying cost**. After a legitimate lot revaluation from 40 to 25, returning 0.2 large units could add only 5 of current inventory book value into that lot while posting **8 inventory debit / COGS credit**, silently overstating that lot's value. An existing 043 receipt would certify the balanced journal without proving the stock lot remained cost-consistent.
- Root repair in the **one shared return-stock destination helper**, still within the same native `BEGIN IMMEDIATE` source/stock/journal/receipt transaction: read the current tenant-owned linked lot cost, reject invalid/nonfinite/negative carrying cost, and reuse it **only if its returned-quantity carrying value rounds to the same cents as the historical COGS reversal**. Otherwise create a distinct `RET-` tenant-owned lot at the historical sale unit cost, as the existing missing-lot fallback already does. Original revalued lot and historical sale receipt remain unchanged; the new return receipt references the real created return lot and the journal debit matches actual returned carrying value. Genuine returns at unchanged/cent-equivalent costs still restock their original lot; fractional returns remain usable.
- New in-place synthetic adversarial regression in `sales_return_restores_original_batch_and_tracks_remaining`: sale cost 40, currently revalued lot cost 25, return 0.2 and journal COGS reversal 8. Initial test attempt session `77897` compiled **exit 101** due only to test fixture using `ReturnResult.id` instead of actual `return_id`; corrected fixture, not production code. **RED** pinned session `14192` Cargo exit101: previous writer chose the revalued old lot, defeating the separate-valuation assertion. **GREEN** targeted session `82649` exit0, 1/1; entire `critical::tests` session `61810` **54/54**, exit0. The regression also now explicitly verifies new lot quantity 0.2, historical per-large cost 40, old lot unchanged at quantity0, and its posted inventory journal debit is exactly 0.2 × 40; it rolls back the isolated test attempt before existing regression scenarios.

### Owner's independently inspectable sealed 043 sales-return line-money contradictions

- `src-tauri/src/commands/financial_source_reconciliation_native.rs::SALE_RETURN_COGS_STRUCTURE` already validated native return parent amount, linked original sale item, line count, actor/tenant, and balanced journal, but did not check **each actual return line's persisted refund** against the immutable `line_snapshot.value`, nor the aggregate actual return-line refund against the sealed `refund_micros`. A locally altered return item from 5 to 3 could escape owner reporting while the 043 return receipt and journal still said 5. A dishonest local replacement of the witness value to 3 must also not make the unchanged 5 parent/journal acceptable.
- Bounded owner-only SQLite projection now compares every real `return_items.total_price` (numeric, nonnegative) against the matching receipt witness `value` within cent tolerance and compares actual summed source-line refund against `refund_micros` (≤0.005 currency units tolerance). Violations report `return_receipt_lines_changed` **explicit original source/witness contradiction**; no mutation, historical backfill, migration or signature claim. Synthetic fixture was extended with the authentic value5 witness; adversarial check changes source to3 while parent/journal remain5 and separately changes the unsigned local witness to3 too. **RED** pinned session `1135` Cargo exit101, 0/1, old projection missed the source amount contradiction. Initial GREEN module session `36118` **22 passed/2 failed**, exit101, solely because a legacy fixture used positional three-column `INSERT INTO return_items VALUES` after adding the synthetic money column and a later test restored a witness lacking `value`; both fixture errors corrected without weakening production SQL. Full owner module session `72426` **24 passed/0 failed**, exit0; final collusive-amount assertion also passes in the integrated native suites. Current lots remain mutable observations, not signed historical source facts.

### Native supplier cash-return history before another financial payout

- `src-tauri/src/commands/purchase_returns.rs` already fail-closed on wrong original invoice-line/lot/drug, inconsistent old finalized parent/child refund totals, and current stock carrying value. **Separate historical gap:** prior finalized **cash** supplier return may have parent/child refund50 with actual stored supplier `return=+50` but `payment=-100`, plus an old pre-048 unlinked cash receipt100. The new return calculation sees only 50 prior refund against original100 and could post another native cash refund50. Thus source totals and *new* 048 receipt pass while actual old+new cash payments total150 for original value100.
- Extended the existing atomic **pre-post finalized-history** predicate, without rewriting old rows: where historical supplier-transaction references exist, require known cash/credit method, exactly one same-supplier `return` at parent amount and for cash exactly one same-supplier `payment` of the opposite amount; deny extra, missing, cross-supplier and wrong-amount shapes at cent precision. Preserve older historical return rows with **no available supplier ledger** as explicitly uncertified history rather than inventing past proof. New isolated `historic_cash_supplier_payment_must_match_refund_before_another_receipt` proves no source, stock, supplier, cash or journal mutation when old cash is inconsistent; test-only correction of the prior payment/cash receipt to50 permits a valid remaining fractional cash return50. **RED** pinned session `82128` exit1 because former writer posted a second 50; **GREEN** pinned targeted `31668` 1/1 exit0; full purchase-return tests `36689` **15 passed/0 failed**, exit0; worker verified rustfmt and diff check. Previous legacy cash missing-source cases are not falsely called audited historical cash.

### Signed offline lease expiration must not bypass persistent clock ratchet

- Native `src-tauri/src/licensing.rs::LicenseGuard::verify_at` was called by both per-IPC `check_license/enforce` and native `status` and originally called `verify_envelope` with a short-circuit on `now>=lease_until_utc` **before** reading/updating its DPAPI-sealed maximum observed clock. With genuine Ed25519-signed grant ending UTC3000, prior highest seen2800 and a check at UTC3100, the license was correctly denied **but did not remember observing expiry**. Manually rolling the system clock back to UTC2900 could regain the still-signed lease despite having already observed UTC3100.
- Minimal shared validation split: `signed_grant_for_clock_anchor` authenticates pinned Ed25519 claims, exact machine binding, nonrevocation, issued-time bound and consistent signed lease/expiry intervals **without granting access**; `verify_at` validates the protected anchor and durably advances `highest_seen_utc` while holding its existing synchronization and native-process lock; **then** `require_unexpired_lease` denies the expired or lease-ended grant. Public `verify_envelope` preserves original signed grant/access policy for normal install and online renewal. Forged/malformed, revoked, future-issued or inconsistent claims do not write clock evidence; expired genuine claims cannot access protected IPC. No issuer protocol, private signing key, TPM binding, hardware acceptance or security-release flag was changed.
- Synthetic signed Ed25519 `expired_authenticated_lease_must_ratchet_clock_before_rollback`: at UTC3100, valid signed but expired lease must still permit protected *clock accounting* and must then reject replay at UTC2900; invalid/revoked signed claims cannot ratchet. **RED** targeted Cargo exit1, 0/1 (original helper stopped with the expected expired error **before** clock accounting); **GREEN** same targeted exit0 1/1; complete native `licensing` suite exit0, **30 passed/0 failed/1 manual physical TPM case ignored**. This narrows observed rollback only: if expiry is never observed, local state is removed/rolled back outside custody, or rollback stays within the configured 120s tolerance, external issuer and physical device trust are still needed.

### Fresh integrated validation, unchanged-source dispositions and continued original release BLOCK

- After combining **all four modified native source files**, scoped `rustup run stable rustfmt --edition 2021 --check` across `critical.rs`, `financial_source_reconciliation_native.rs`, `purchase_returns.rs`, `licensing.rs` and `git diff --check` both exited **0**. Pinned **Rust 1.77.2 complete debug** `cargo test --locked --offline -q`: session `73282`, **489 passed / 0 failed / 1 ignored**, exit0. Fresh disposable Ed25519 **public** verifier only, synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2`, intentionally nonproduction `PHARMA_LICENSE_AUTHORITY_URL=https://licensing.example.invalid`, pinned `cargo test --locked --offline --release -q`: session `63199`, **482 passed / 0 failed / 1 ignored**, exit0. Synthetic QA private key never written as project key/credential; temporary process environment was cleared; the ignored physical TPM case was not run or accepted. Only pre-existing unused test constant `STOCK_LOSS_JOURNAL` warning surfaced.
- Earlier unchanged-source Python licensing **40 passed**, TypeScript and ESLint exited0, Jest **319 suites/2,633 tests passed**, and Tauri static frontend export **70/70 pages, 2/2 exports** are retained as **prior** results and were not redundantly rerun because no relevant Python/frontend/browser files changed in this implementation. No Jest/static-build overlap and no signed installed Windows application was claimed. The earlier offline recovery tenant/custody source, its 28-test backup module and `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` remained unchanged in this increment; live restore stays disabled.
- **Mandatory external acceptance remains unmet**: independent signed/proven historical source books, inventory valuation, negative sale/return COGS, supplier/cash/patient balances, journal reversals/closed periods and legacy fractional-cent delivery receivables; real issuer/activation/revocation, physical TPM and clock/device acceptance; code-signed installed Windows application; safe custodial sanitization of the original commercial seed; dependency risk disposition; signed backup provenance, offline quiescence and demonstrably crash-safe replacement/rollback supervisor; independent finance, custodian and two-person operator approvals. Local 043/048 SQLite receipts and SHA-256 are only structurally inspectable evidence, not externally signed origin or historical certification. **DO NOT SET `PHARMA_SECURITY_RELEASE_APPROVED`. ORIGINAL PROJECT OPEN; COMMERCIAL RELEASE BLOCKED.**

## 2026-10-13 native patient-payment mappings, historical sales-return refunds and mirrored financial-notice sources

**Original licensing/security/financial-integrity/recovery commercial project remains OPEN and release remains BLOCKED.** Started by independently checking the actual live workspace before changing source: `HEAD a9411cce`; 311 user-preserved dirty/untracked paths (147 modified, 14 deleted, 150 untracked); 0 staged; 49 protected migrations with sorted per-file uppercase SHA256 aggregate `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`; unchanged `src-tauri/pharma_local.db` (58,687,488 bytes, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`); middleware present, no active build, and no release or QA verifier environment variables. Re-read full Ponytail skill and project `AGENTS.md`. Verified prior native source fixes and authoritative prior full debug **489/0/1** / synthetic optimized **482/0/1** records. Earlier 119-call session records were not presented as new independent proofs. No historical migration, checksum, real original database, issuer/TPM credential, customer record or signed installer was modified.

### Authenticated native patient payment: canonical financial accounts and fractional cents

- `src-tauri/src/commands/patient_payments_native.rs::account` previously returned any non-group account configured under `trial_balance_settings.category`, ignoring the canonical cash, bank clearing or accounts-receivable account **code**. Under the genuine session/current active DB actor, tenant and `BEGIN IMMEDIATE` guard, a misleading configuration could still produce a balanced but **semantically false** journal (e.g. cash drawer debit with bank clearing credit instead of receivables credit) and a matching cash receipt. Native `validate` also accepted payment values such as 10.001, allowing noncent receivable/cash journal amounts. Renderer-supplied account IDs remain disallowed.
- Minimal shared native payment-account lookup now resolves only one canonical non-group `accounts.code` whose ID is compatible with the configured category; absent category mapping preserves canonical fallback, but a mismatched or ambiguous mapping fails closed before any posting. Typed patient payment rejects nonfinite, out-of-range, zero and **subcent** values (cent precision). Authenticated current actor, tenant/permission, source debt, original patient ownership, exact nonce, shift, source/ledger/cash and atomic rollback paths remain unchanged.
- Synthetic `patient_settlement_rejects_redirected_accounts_and_fractional_cents` changes the receivable mapping to the bank account, verifies zero payment/receipt/cash/journal entries, restores **test-only** mapping, denies 10.001, then successfully posts exactly 10.00. **RED** pinned Rust1.77.2 focused session `34755`, Cargo exit101: old writer succeeded with redirected account. **GREEN** complete native payment module `62888` exit0 **6/6**. Scoped source formatting and diff checks were corrected to exit0.

### Historical finalized sales-return header/line refund conservation

- In `src-tauri/src/commands/critical.rs::create_return_tx_with_request`, the existing prior-quantity check used `return_items.quantity_returned`, while the invoice refund cap trusted `returns.total_refund` independently. Old finalized sale with original cash100, historical approved 0.5-line refunded80 but parent total20 allowed a second 0.5 return to pay another50: **actual old/new source line refunds 130 on original100**. Neither original sale-item relation nor previously fixed historic/current COGS carrying-value check catches different historical money columns.
- Shared native return writer now validates **all finalized previous returns of the invoice before the next source/stock/refund/journal/043 receipt mutation**: each must have source lines; historical parent and child refunds must be real/integer, nonnegative, and parent must equal the sum of linked line totals within 0.005. Unreconciled old books require independent review; no automatic backfill or historical rewrite. Correct partial historical refund80 still permits a genuine remaining fraction refund capped at20. Existing tenant, actor, 043 immutable witness/COGS, loyalty, cash/bank/wallet, replay and atomic `BEGIN IMMEDIATE` paths preserved.
- Synthetic `sales_return_rejects_finalized_header_understating_historical_line_refunds` proves the unauthorized second payout and no future writes after detection. **RED** session `40770` expected exit1 (old writer returned successful50); **GREEN** focused session `13207` exit0 1/1; full `critical::tests` session `43853` **55 passed/0 failed**, exit0; rustfmt/diff checks exit0.

### Financial notices must preserve source/mirror consistency across BOTH financial writers

- `src-tauri/src/commands/financial_notices_native.rs::account` repeated the incorrect configured-category-to-arbitrary-account lookup. Independently, `verify_patient` and native patient debt settlement treated matching `financial_notice_native_scope.pharmacy_id` as proof that `patient_transactions` adjustment still matched its underlying financial notice. A genuine scoped customer credit of **-12.50** could have its mutable patient mirror altered to **+900** without changing the source, letting a new native notice or cash settlement count invented patient debt.
- Minimal native notice account lookup now requires one canonical code-compatible account, same fail-closed behavior as payment writer. A shared, read-only `verify_native_notice_mirrors` checks the existing actual `financial_notices`, `financial_notice_native_scope` and `patient_transactions` source relationship for patient identity, pharmacy, actor, type, date and sign-adjusted exact amount. Both `financial_notices_native::verify_patient` and `patient_payments_native::post` call the **same** helper inside their existing atomic transaction before trusting native-scoped adjustments. A forged patient mirror or foreign account mapping cannot acquire a new receipt/journal by using the sibling writer. This is a structural local source contradiction check, **not** cryptographically signed historical provenance.
- Preserved legitimate preexisting V1 notice history: its genuinely posted journals used unrelated random UUIDs and cannot be inferred or rewritten; an initial proposed requirement for `notice.id=journal.id` was correctly **rejected** rather than breaking those valid records. The independent notice source/adjustment reference already exists and can be verified without schema changes. Test fixtures were expanded **only synthetically** to include existing production notice actor/date/amount/pharmacy fields. Two synthetic native-notice adversarial tests (`altered_native_notice_mirror_cannot_authorize_more_patient_debt`, `configured_notice_accounts_cannot_redirect_canonical_posting`) were **RED** in the unmodified writer: focused notice-module test **4 passed/2 failed**, expected exit1 (notice accepted +900 forged mirror and wrong canonical mapping). **GREEN** integrated `financial_notices_native::tests` session `30738` **6 passed/0 failed** and `patient_payments_native::tests` same session **6 passed/0 failed**, exit0; patient module now includes cross-writer altered scoped notice mirror denial and legitimate old source continuation. Both changed account lookups plus shared reconciliation protect preexisting original source rows without altering them.

### Integrated verification, custody and outstanding acceptance

- All three native Rust files `critical.rs`, `financial_notices_native.rs` and `patient_payments_native.rs` passed stable rustfmt --check and `git diff --check` exit0 (session `60317`). Complete pinned **Rust 1.77.2 debug** `cargo test --locked --offline -q` session `20824`: **493 passed / 0 failed / 1 ignored**, exit0. Fresh **disposable** Ed25519 public verifier generated in memory, synthetic `PHARMA_LICENSE_DEVICE_MODE=tpm-v2` and deliberately invalid `PHARMA_LICENSE_AUTHORITY_URL=https://licensing.example.invalid` optimized native `cargo test --locked --offline --release -q` session `39114`: **486 passed / 0 failed / 1 ignored**, exit0. Temporary QA verifier/device/authority environment cleared; manual genuine TPM test still ignored. Existing nonfatal unused `STOCK_LOSS_JOURNAL` warning persists. Neither synthetic run certifies real issuer, physical TPM nor a signed/installed Windows app.
- Unchanged Python licensing (prior **40 passed**), browser TypeScript/ESLint (prior exit0), frontend Jest (prior **319 suites and 2633 tests passed**) and `build:tauri` static export (prior **70/70 pages, 2/2 exports**) remain correctly classified as **prior unchanged-source evidence**, not falsely rerun this session: all edits were Rust and authoritative documentation. No Jest/build overlap. Offline backup/preview/rehearsal code is unchanged this increment; `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` remains authoritative and destructive restoration disabled.
- **Release blockers still require actual independent evidence:** historical stock/COGS/journal and closed-period financial certifications, original supplier/cash/patient/returns books and legacy fractional-cent delivery receivables; production issuer, secure device clock/physical TPM, activation and revocation, signed installed Windows app; original bundled commercial seed custodial remediation, dependency risk disposition; independently authenticated backup provenance and operator-controlled quiesced crash-safe recovery/rollback, plus finance/custodian/two-person approvals. All fixes here reject demonstrable contradictions, they do not certify missing or mutable old evidence. **`PHARMA_SECURITY_RELEASE_APPROVED` MUST REMAIN UNSET; THE ORIGINAL PROJECT IS OPEN AND COMMERCIAL RELEASE REMAINS BLOCKED.**


## 2026-10-13 continued patient receivable refund conservation and authenticated schema-maintenance IPC

**Commercial status: OPEN / BLOCKED.** This was a distinct source-first continuation on actual HEAD `a9411cce` after reading the full Ponytail skill, project AGENTS and prior authoritative gate, with 311 preexisting dirty/untracked entries and no staged work. All edits preserved existing user changes, original 49 migration SQL/checksums, source history and original protected seed; no destructive restore, credentials, signed installer or approval.

### Finalized patient-account refund parent/line consistency across native debt writers

- Real path: `post_patient_payment_native` authorizes a live session, active actor, tenant and permissions, enters `BEGIN IMMEDIATE`, then computes receivables using finalized `returns.total_refund`. The customer `create_financial_notice_native` writer similarly verifies patient provenance without checking persisted refund header against its actual line amounts. An approved tenant-owned patient-account refund with header **15** and `return_items.total_price` **80** against a credit sale **100** was trusted by patient settlement, permitting another **80** cash collection even though actual source lines leave only **20**; the notice writer admitted a new adjustment on the contradictory financial history. This is a demonstrable persisted parent/child contradiction, not a claim of historically certified source authenticity.
- Two new disposable in-memory tests `patient_settlement_rejects_historical_refund_header_understating_lines` and `customer_notice_rejects_historical_refund_header_understating_lines` showed actual old behavior: **RED** pinned Rust session `98591`, **0 passed / 2 failed**, exit **101**; both writers returned success when rejection was expected.
- Minimal shared native helper `financial_notices_native::verify_patient_account_return_amounts` checks only same-tenant finalized **patient_account** refunds for the targeted patient, requires numeric/nonnegative/bounded header and item money, at least one line, and parent=sum(lines) within half-cent. Called from both native writers inside their existing authenticated immediate transactions before any new cash, journal, notice, source or scope write. Genuine synthetic repair to 15-line value restores legitimate posting; no guesswork/backfill of customer history. **GREEN** session `5740`: new cases **2/2**, patient-payment module **7/7**, financial-notice module **7/7**, each exit0. Historical V1 notice journal UUID compatibility and previously fixed mirror checks remain intact.

### Unauthenticated renderer-callable compatibility repair removed

- Source audit traced `src-tauri/src/main.rs` registered `schema::ensure_schema_compatibility` in Tauri IPC under a license-only gate. Its command wrapper in `src-tauri/src/schema.rs` accepted **only AppHandle** (no login/role/tenant authorization), opened the writable local database and committed `ensure_compatibility`. The fixed maintenance SQL includes account insertion, `trial_balance_settings.account_id` reassignment and duplicate deletion, and inventory/purchase compatibility modifications. An active licensed but logged-out or unauthorized renderer could trigger a privileged repair; this is a bounded fixed repair, **not** arbitrary SQL. Source audit found no production frontend caller; startup already calls `ensure_compatibility` inside its trusted migration transaction.
- New runnable Rust registration-boundary regression `schema::tests::startup_schema_repair_must_not_be_renderer_callable`: pre-fix **RED** session `19815`, test failed exit **101** because the unauthorized Tauri registration existed. Root fix removed the renderer handler registration and obsolete `#[tauri::command]` wrapper, leaving original startup internal schema repair untouched. **GREEN** session `38698`, **1/1**, exit0. This is a source/registration test plus verified actual call-path review, **not** a claim that an installed Windows Tauri IPC exploit was run against customer data.

### Integrated tests, formatting, custodial verification and residual acceptance

- Complete changed-source pinned **Rust 1.77.2 debug** `cargo test --locked --offline -q`, session `54325`: **496 passed / 0 failed / 1 ignored**, exit0. Synthetic optimized native secure-release with freshly generated disposable **public Ed25519 verifier**, `tpm-v2` mode and deliberately invalid authority `https://licensing.example.invalid`, session `53252`: **489 passed / 0 failed / 1 ignored**, exit0; all temporary QA process environment cleared. Initial optimized setup session `33394` failed before tests (exit101) because the disposable public key was standard padded Base64 rather than required **43-character unpadded Base64URL**; corrected QA inputs were rerun successfully, not concealed as source defects. One physical TPM manual acceptance test remains ignored.
- Rust formatting for changed native sources, main and schema with `skip_children=true` to avoid rewriting unrelated child modules: exit0 session `27747`; `git diff --check` exit0. Prior unrelated Python licensing **40**, TS/ESLint exit0, Jest **319 suites / 2633 tests**, and static Tauri export **70 pages / 2 exports** are **retained old unchanged-input evidence**, not falsely represented as rerun. No frontend/Python inputs or backup/recovery behavior changed.
- Recomputed final custody in session `61534`: HEAD `a9411cce`; **311 dirty/untracked** (147 modified, 14 deleted, 150 untracked), **zero staged**, **49** old migrations aggregate SHA256 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`; protected original `src-tauri/pharma_local.db` **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. Zero active matching builds; `src/middleware.ts` present and temporary frontend paths absent; release approval and verifier/mode/authority variables unset; `git diff --check` exit0. Real unchanged `node scripts/check-commercial-release-seed.js` **exit1 / BLOCKED** because bundled seed still contains a configured user password hash. No seed mutation/preflight bypass.
- **Still blocked pending independent external acceptance:** original financial, stock/COGS, journal/reversals/closed period, supplier/cash/patient and historical legacy fractional-cent delivery certification; origin-authenticated source evidence; production issuer and online activation/revocation, physical TPM/clock/device, signed installed Windows binary; custodial commercial seed remediation and dependency risk disposition; independently signed backup provenance, quiesced interruption-tested crash-safe offline restoration/rollback and two-person finance/custodian/operator approvals. Local structural checks/unsigned receipts are not signed origin. Destructive live restore stays disabled. **PHARMA_SECURITY_RELEASE_APPROVED MUST REMAIN UNSET. ORIGINAL GOLD-STANDARD COMMERCIAL PROJECT OPEN / BLOCKED.**


## 2026-10-13 scoped patient cash conservation and cross-writer native receivables continuation

**Original Pharma commercial status: OPEN / BLOCKED.** Read full Ponytail and AGENTS rules, checked actual HEAD `a9411cce`, 311 existing dirty/untracked files/zero staged, original 49 protected migrations and original seed unchanged. No original patient, cash, journal, seed, recovery, license or customer data rewritten. All RED and GREEN tests operate only on synthetic in-memory SQLite.

### Demonstrable prior native patient-payment source contradiction

- Actual native code: `patient_payments_native::post` authenticates session actor and tenant and uses `BEGIN IMMEDIATE` but used a raw `SUM(patient_transactions.amount)` joined to `patient_payment_scope` as authoritative paid receivable. Migration 033 tags pharmacy and request but does not store the original cash or journal UUID. Native first cash payment 20 actually creates a separate tagged cash receipt20 and balanced journal20; changing only the later patient transaction mirror from20 to **-900**, or the still-positive cent-exact **1**, leaves source cash and journal20 while manufacturing further apparent debt. In a credit sale100 with approved patient-account return15 the legitimate remaining debt after cash20 is65, yet the old writer accepted further collection80, returning false remaining905 (negative mirror) or4 (positive mirror). `financial_notices_native::verify_patient` also admitted a new notice on a corrupt scoped payment.
- Three real synthetic **RED-before** regressions: `altered_prior_scoped_payment_cannot_create_new_receivables`, pinned session `10563` **0/1**, exit101, unauthorized next payment succeeded. `understated_positive_prior_cash_payment_cannot_reopen_debt` and `customer_notice_rejects_corrupt_prior_scoped_patient_payment`, session `70213`, each **0/1**, exit101, old native writers improperly succeeded. These are actual old-source behavior failures, not fixture compile issues.
- Root fix: one shared `patient_payments_native::verify_scoped_patient_payments` called from **both** authenticated `patient_payments_native::post` and `financial_notices_native::verify_patient` inside their native immediate transactions before any writes. Rejects scoped payment nonnumeric/nonpositive/out-of-bound/subcent amount, wrong type or method and missing actor/date. Validates reserved `cash_movements.source_type='patient_payment'` rows and reconciles cash payment source count and amount by patient, pharmacy, actor and posting date. Repeated legitimate equal receipts remain accepted; missing, overstated or understated cash mirrors deny without partial cash, notice, scope or journal writes. Healthy synthetic source restoration to20 allows legitimate follow-on payment60 and notice. **GREEN** session `57680`: patient module **9/9** and notice module **8/8**, both exit0. Stable targeted rustfmt and git diff checks **exit0**, session `17057`.
- Assurance boundary: source-consistent native V1 cash does **not** prove signed historical origin, independent receipt authentication, a guaranteed one-to-one link, or collusive tamper resistance. Pre-existing native bank journal UUIDs are independent and 033 stores no per-payment journal reference; exact original bank journal authenticity remains unverifiable without new forward-only evidence and independent certification. No imaginary relationship, signed receipt or historical backfill was invented. Legacy unscoped patient records remain blocked.

### Independently source-traced unresolved receipted credit sale ownership

- Read-only worker traced a further distinct **unfixed and not RED-tested** vulnerability: native 043/045 receipted sales UPDATE guards seal sale ID, tenant, user, amount, payment method and status, but not `sales_invoices.patient_id`. A post-receipt edit to the patient on a credit invoice can reassign receivable ownership without altering original amount/journal; native settlement groups current `sales_invoices.total_amount` by mutable patient. Future work should synthetic RED-test and add a narrowly scoped new **forward-only** migration 050 preventing patient reassignment for 043-receipted CREDIT sales while preserving legitimate other histories. Do not modify historical migrations 001–049. Older unreceipted credit totals lack guaranteed reconstructible source fees and signed journal lineage, so a guessed gross line sum is not certification.

### Integrated Rust evidence, protected custody and mandatory blockers

- Pinned complete Rust 1.77.2 debug test suite session `41603`: **499 passed / 0 failed / 1 ignored**, exit0. Disposable public Ed25519 Base64URL 43-character verifier with `tpm-v2` synthetic mode and deliberately invalid authority `https://licensing.example.invalid`, optimized Rust1.77.2 native secure-release session `59310`: **492 passed / 0 failed / 1 ignored**, exit0; temporary QA environment cleared. One ignored physical TPM case remains manual/unaccepted. Prior unchanged-source Python licensing40, TypeScript/ESLint exit0, Jest319 suites/2633 tests, and Tauri static export70 pages/2 exports are retained **prior**, not freshly rerun, because no Python/frontend inputs were changed.
- Final independent live custody session `12620`: HEAD `a9411cce`, **311 dirty/untracked (147 modified/14 deleted/150 untracked), 0 staged**; sorted 49 protected migrations aggregate SHA-256 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, original protected seed 58,687,488 bytes SHA-256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`; no active Cargo/Jest/build, middleware present, temporary frontend paths absent, `git diff --check` exit0; release approval and verifier/device/authority variables unset. Actual commercial seed preflight still **exit1/BLOCKED** due to configured bundled user password hash; no bypass or seed change.
- Remaining independent blockers: certified original patient/cash/supplier/books, original negative-stock/COGS/returns, journal/reversals/closed periods and legacy fractional-cent delivery receivables; signed original provenance, production issuer/device/TPM/activation/revocation and signed installed Windows binary, custodial seed remediation, dependency risk disposition, signed backup provenance and independently authorized quiesced crash-safe restore and rollback with physical interruption testing and two-person operator/finance approval. **Original gold-standard project OPEN. Commercial release BLOCKED. PHARMA_SECURITY_RELEASE_APPROVED unset; destructive live restore disabled.**

## 2026-10-13 forward-only receipted credit patient ownership and no-inferred-tenant patient finance

**Original gold-standard commercial project OPEN / BLOCKED.** Reconciled live source, full Ponytail and `AGENTS.md`, latest gate (including subsequent 499-debug/492-optimized suite and completed 033 native patient cash reconciliation), HEAD `a9411cce`, 311 baseline dirty/untracked and 0 staged. Prior canonical financial account, return header/line and patient mirror fixes were retained, not repeated. All new RED/GREEN exercises use disposable synthetic SQLite; no customer, original bundled seed, original migration 001–049 or legacy financial journal was rewritten.

### Credit invoice patient relationship after 043 immutable receipt

- Source trace: real `043_native_sales_cogs_provenance.sql` seals completed sale ID, actor, pharmacy, payment, money, lines and journal, and 045 supersedes its status guard for delivery. Neither guards `sales_invoices.patient_id`. `patient_payments_native::post` and `financial_notices_native::verify_patient` infer outstanding receivable ownership from the current `sales_invoices.patient_id`; a future `UPDATE sales_invoices SET patient_id='patient-b'` against an already receipted completed credit sale owned by `patient-a` changed the collection target while preserving the original journal and sale receipt. The source records alone cannot recover any already-tampered historic patient ID.
- A previously prepared synthetic test in `schema.rs` had an incomplete 045 fixture (`cash_movements` absent); its initial session `67804` exit101 was a **fixture failure, not security RED**. After adding only the missing in-memory table, genuine **RED-before** pinned Rust session `27583` exit101: the real 043+045 triggers accepted the changed patient ID and failed the expected denial. Implemented **new, forward-only migration 050** `050_receipted_credit_patient_ownership.sql`, registered in native startup. Its `BEFORE UPDATE OF patient_id` guard applies only when a matching original 043 **credit** receipt exists and the value actually changes; identical-value updates and unreceipted historic sales remain possible. The test applies the exact 050 SQL after 043/045 and verifies tamper rejection and valid continuations. GREEN targeted session `21227` 1/1 exit0. Updated existing migrator test registration count to 50, without changing migration SQL 001–049. The trigger preserves current prospective integrity, **not certified patient identity at original historical issuance**.

### Ownerless NULL/blank historical tenant cannot become `local_default` patient debt

- Independent read-only native trace discovered that `patient_payments_native::post` and `financial_notices_native::verify_patient` treated `COALESCE(NULLIF(TRIM(sales_invoices.pharmacy_id),''),'local_default')` as equivalent to positive ownership of a legacy NULL/blank-tenant credit sale. With a genuinely authenticated `local_default` cashier or owner, a global patient with opening balance zero and a completed old NULL-tenant credit invoice for 100 was accepted for a new cash payment or financial notice, producing new branch-tagged cash/journal or adjustment despite **absent historic source tenant**. Finalized `patient_account` returns likewise must not infer branch ownership from NULL/blank return headers.
- New isolated adversarial tests `unowned_legacy_credit_and_return_cannot_be_collected_as_local_default` and `customer_notice_cannot_infer_local_default_ownership_from_unscoped_credit` use actual native writers, permissions, `BEGIN IMMEDIATE`, main-schema in-memory fixtures and positive explicitly owned `local_default` controls. **RED-before** pinned Rust session `11824`: **0 passed / 2 failed**, exit101, both old writers returned successful postings on unowned invoice sources. Root fix checks actual persisted `pharmacy_id` for source invoices and finalized account-refund headers: SQL `pharmacy_id IS NOT ?` counts NULL/blank/foreign records as ambiguous, while qualifying credit and refund sums require literal `pharmacy_id=?`. No migration/backfill of old financial tenant history, and no new ownership assigned by actor, cash shift, global patient identifier or other inferred convention. **GREEN** session `18259`: new tests **2/2**, patient-payment module **10/10**, financial-notice module **9/9**, all exit0; their legitimate explicitly tenant-owned controls passed and impossible historic source paths committed no cash, notice or journal.

### Native verification, synthetic-only assurance, protected custody and release block

- First complete pinned Rust 1.77.2 debug run after 050 (session `81290`) had **498 passed / 2 failed / 1 ignored**, exit101: two older test-only assertions still expected 49 migration entries (`returns_scoped` and `shifts_native`). Both updated to the registered 50 without business changes. Final complete pinned **debug** session `97448`: **502 passed / 0 failed / 1 ignored**, exit0. Freshly generated disposable 43-character Base64URL Ed25519 **public-only** verifier, fake `tpm-v2` QA device mode and intentionally nonexistent `https://licensing.example.invalid` authority: complete pinned Rust1.77.2 **optimized synthetic secure-release** session `48120`: **495 passed / 0 failed / 1 ignored**, exit0. Temporary verifier/device/authority process environment cleared in `finally`; ignored manual physical TPM test remains genuinely unexecuted. No production issuer, physical TPM, signed/installed Windows application or certified historical books were exercised.
- Scoped stable `rustfmt --check` on changed Rust source, `git diff --check` both exit0 (session `98701`); no Python licensing, TypeScript, ESLint, Jest or static Tauri inputs changed. Existing Python40, TypeScript/ESLint exit0, Jest319 suites/2633 tests and `build:tauri` 70 pages/2 exports remain **prior unchanged-input** evidence, not new tests. Offline recovery source and acceptance report untouched; destructive live restore remains disabled.
- Final custody session `84778`: HEAD `a9411cce`, **312 dirty/untracked = prior 311 plus new migration 050**, **0 staged**; now **50** migrations, *original protected 49* retain sorted uppercase-per-file SHA-256 aggregate `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`; new 050 SHA-256 `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`. Original protected `src-tauri/pharma_local.db` is still **58,687,488 bytes** SHA-256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`; middleware present, temp frontend paths absent, no active matching builds, QA/release approval variables unset, `git diff --check` exit0. Actual unchanged commercial seed check **exit1 / BLOCKED** (configured user password hash); no preflight bypass, seed rewrite or installer publication.
- External acceptance remains pending: independently authenticated/certified original patient and delivery fractional-cent receivables, cash/supplier/source/COGS/stock, journals, closed periods and reversals; real production issuer, online activation/revocation, device/clock and physical TPM; signed installed Windows binary; custodial commercial seed remediation and dependency risk disposition; independently authenticated backup provenance and operator-approved quiesced crash-safe offline restore/rollback interruption evidence with required finance/custodian/two-person signoff. A local future-update trigger, SQLite receipts, structural source consistency and synthetic optimized QA are **not** signed historical origin or commercial approval. **PHARMA_SECURITY_RELEASE_APPROVED MUST REMAIN UNSET. ORIGINAL PROJECT OPEN / COMMERCIAL RELEASE BLOCKED.**

### Independent post-integration review: legacy inferred pharmacy is STILL unresolved

- A separate read-only source audit after the above passing suites identified a **material remaining tenant-origin gap** in the pre-existing compatibility upgrade: `schema.rs::snapshot_branch_local_pharmacy_scope` and later `ensure_compatibility` may rewrite old `sales_invoices.pharmacy_id` or `returns.pharmacy_id` from NULL/empty to an inferred user pharmacy or `local_default`. Consequently the new native *literal stored tenant* checks deny a currently NULL/empty source, but **cannot distinguish an originally unowned legacy invoice that was already assigned an inferred string on a prior startup**. Original older credit sources without a 043 receipt also lack independent patient-identity sealing. The current two synthetic RED/GREEN tenant tests do not exercise this full legacy compatibility upgrade sequence. Never describe their success as proof of historical original ownership.
- **Follow-up work required, not claimed completed:** adversarial disposable upgrade-from-NULL tests through real startup compatibility into both native financial writers; forward-only durable provenance that preserves the actual pre-repair unknown state, with fail-closed treatment or independent custodial review of already-normalized old sources. Earlier upgrade writes cannot be reverse-engineered or certified from the current stored pharmacy string; no guessed backfill or customer database rewrite is authorized. No extra code was changed after the final 502/495 suites to conceal this residual. This stays an **explicit financial tenant-origin blocker** on top of the external commercial acceptance dependencies. **Commercial release remains BLOCKED.**

## 2026-10-13 continued patient credit original-source custody, startup normalization and owner review

**Commercial release OPEN / BLOCKED.** Re-read complete Ponytail skill and Pharma `AGENTS.md`, then reconciled live HEAD `a9411cce`, 312 existing dirty/untracked paths (147 modified, 14 deleted, 151 untracked), zero staged and no Cargo/Jest/build process. Read prior 050 source and authoritative gate; replayed retained pinned full debug session `97448` **502 passed / 0 failed / 1 ignored** and synthetic optimized session `48120` **495 passed / 0 failed / 1 ignored**, both exit0; no unchanged-source redundant run. Original 001–049 migration aggregate, 050 SHA, protected original seed hash and blocked commercial seed preflight initially matched the recorded checkpoint. No original data, historical migration or SQLx checksum was changed; 050 remained unchanged.

### Actual threat and genuine RED in both authenticated writers

- Trusted `schema.rs::prepare_connection` calls `ensure_compatibility`; `snapshot_branch_local_pharmacy_scope` assigns historical `sales_invoices.pharmacy_id` and `returns.pharmacy_id` when NULL/empty from current user, current invoice, or default `local_default`, and later compatibility statements repeat normalization. Even the previous writer fix demanding literal `pharmacy_id=?` therefore accepted an **already normalized but originally tenantless** completed credit invoice as monetary debt. Native patient cash and financial notices counted an invoice header as sufficient without the native 043 origin/COGS receipt. A logged-in `local_default` cashier or owner with current permissions could collect 40 on an old credit100 or issue an adjustment and journal, even though original tenant and patient ownership had never been independently proven. That is source-origin ambiguity, not proof of fraudulent original history.
- New disposable regressions `compatibility_normalized_legacy_credit_cannot_create_patient_cash_or_journal` and `normalized_legacy_credit_cannot_authorize_customer_notice` model an initial NULL source subsequently normalized by the same logic as the compatibility writer. **RED-before** focused pinned Rust session `14448`: **0 passed / 2 failed**, exit101; both real native financial writers returned `Ok` and posted against the forged origin rather than rejecting. No customer/seed data was touched.

### Shared fail-closed source relationship and allowed prospective credit history

- One shared native `financial_notices_native::verify_proven_patient_credit_sources` now runs from both `patient_payments_native::post` and `financial_notices_native::verify_patient` inside their pre-existing authenticated active-actor, live permission/tenant, single-use-request and `BEGIN IMMEDIATE` financial transaction. Every currently qualifying patient **credit invoice** must have an original 043 `native_sale_cogs_provenance` linked by sale ID with matching literal pharmacy, credit method and integer micro-unit amount; an absent/mismatched/non-numeric source rejects the entire operation **before** writing a new patient transaction, cash movement, shift, notice, journal, entries, scope, activity or receipt. Finalized **patient_account** returns additionally require `native_sale_return_cogs_provenance` linking refund ID, original sale ID, pharmacy, refund method and exact micro-unit refund. Existing parent/header/line checks remain the separate guard for actual currently persisted contradictory source values. Existing 043 insertion/immutability protection and owner-only 043 journal/line auditing are retained, not replaced by a new synthetic historical link. The helper does **not** claim signed origin, cryptographically certified patient_id (043 did not snapshot it), or independently verified pre-050 assignments.
- Older genuinely historic credit invoices/returns **without** 043 receipts are not rewritten, deleted, treated as fraudulent or falsely attributed to a pharmacy. They remain available for independent custodian/finance review, but are **not automatically monetizable** by these two native writers, even if compatibility previously gave them a non-NULL pharmacy. Future approval of an independently authenticated historical source would require its own forward-only attestation process and real external evidence; none was forged. Valid synthetic native 043-backed same-branch credit/refund histories still settle and issue notices normally; previous canonical accounts, cash conservation, typed cents, cross-tenant protection, role deactivation, rollback, nonce and concurrent-retry tests remain green.
- A separate disposable `schema::tests::real_legacy_scope_snapshot_cannot_certify_inferred_patient_credit_or_return` executes the **actual** `snapshot_branch_local_pharmacy_scope` helper on NULL invoice and return ownership, observes both normalized to `local_default`, and proves shared native money preflight still denies the unreceipted credit. This is the real compatibility subroutine on isolated SQL, **not** a claim to have run a full customer upgrade or independently authenticated original ownership. `patient_payments_native::tests::original_credit_and_return_receipt_contradictions_block_new_patient_money` alters only test invoice gross versus receipt, removes only test return witness, verifies no payment/cash/shift/journal/entries/source writes, then repairs the synthetic witness to show legitimate settlement. `patient_payments_native` suite **12/12**, `financial_notices_native` **10/10**, focused real normalization helper **1/1**, each exit0.

### Owner-only legacy source visibility without guessed journal linkage

- Before this change, `SALE_COGS_STRUCTURE` reconciled *FROM* original 043 receipts, so patient credit invoices **without** a receipt could be completely absent from findings; counts of vague legacy journal descriptions did not establish missing credit-source custody. Added fixed read-only `LEGACY_PATIENT_CREDIT_SOURCES` query anchored on actual finalized patient-linked credit `sales_invoices` without a matching native 043 **credit** receipt. It projects literal stored tenant, patient identity and source amount (only when numeric), never invents a journal UUID or equates a compatibility-filled local_default with original provenance. New owner-only finding `legacy_patient_credit_unreceipted` is explicitly classified **`unverifiable_history`**, not `explicit_contradiction`. Existing owner authorization, read-only snapshot, bounded scan and 200-finding fail-closed report limit remain; no migration or source mutation. Synthetic owner regression verifies NULL and normalized local_default credit sources are reported, while cash, draft and native-043-covered credits are not; a non-owner is denied. Its first experimental variant deliberately inserted an incomplete synthetic 043 receipt and then attempted a full journal reconciliation: session `17788` failed at a type-decoding fixture artifact after other module runs, **not** as a live financial posting defect. Test was corrected to validate that isolated receipt-coverage query separately without presenting the incomplete journal as valid. Focused GREEN owner regression session `97462` **1/1** exit0.

### Complete changed-source verification, limitations and continued commercial block

- Stable scoped rustfmt on the four touched Rust sources (`schema.rs`, patient payments, financial notices, owner reconciliation) plus `git diff --check` both exit0. Full pinned Rust1.77.2 **debug** `cargo test --locked --offline -q` session `84587`: **507 passed / 0 failed / 1 ignored**, exit0. Fresh ephemeral synthetic **public** Ed25519 Base64URL verifier, QA-only `tpm-v2` and deliberately nonexistent `https://licensing.example.invalid` issuer optimized `cargo test --locked --offline --release -q` session `5521`: **500 passed / 0 failed / 1 ignored**, exit0. Disposable verifier/device/authority environment cleared in `finally`; the one manually ignored genuine physical TPM case remains unexecuted and unapproved. No real production issuer, signed installed Windows binary or deployed activation/revocation hardware test was performed.
- Existing Python licensing **40 passed**, TypeScript/ESLint successful, Jest **319 suites / 2633 tests**, and `build:tauri` **70 static pages / 2 exports** are **historical unchanged-input evidence**, not rerun: no Python, JS or frontend sources changed. No recovery behavior changed; `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` remains untouched, live destructive restore stays disabled. Original existing 001–049 SQL and 050 remain protected; no key, external signing authority or real original database is modified.
- **Not solved:** original pre-050 patient ID reassignment cannot be reconstructed from 043 (it did not seal patient ID), and an unsigned SQLite 043 receipt with local SHA-256 is a structural witness, never independently signed historical provenance. Legacy pre-043 credit ownership and historical patient balances remain uncertified; accounts/tenant/actor may have been amended before this verification. Direct privileged SQLite tampering or missing authentic source journal linkage is not fully certified by this helper; the owner-only journal auditor remains a separate limited structural check, not proof of original source issuer. A credit-history finding overflow beyond 200 intentionally fails rather than returning misleading partial reconciliation. Original fractional-cent delivery receivables, journal reversal and closed-period source books, original supplier/cash/COGS/stock, issuer and revocation/clock/TPM, signed installed application, dependency disposition, commercial seed remediation, authenticated backup origin, independently tested quiesced crash-safe recovery/rollback and two-person finance/custodian/operator approvals remain outstanding. **ORIGINAL PROJECT OPEN / COMMERCIAL RELEASE BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` MUST REMAIN UNSET.**

## 2026-10-13 continued native patient-cash scope, shared notice preflight and owner review

**Original gold-standard project OPEN / BLOCKED.** Re-read the complete 120-line Ponytail skill and Pharma `AGENTS.md`; reconciled HEAD `a9411cce`, baseline **312 dirty/untracked / zero staged / zero active builds**, current plan and authoritative gate. Retained sessions `84587` pinned debug **507 passed / 0 failed / 1 ignored**, and `5521` synthetic optimized **500 passed / 0 failed / 1 ignored**, were replayed and checked rather than rerun unchanged. Original migrations 001–049, new 050 and protected seed custody hashes matched baseline. Real commercial seed preflight remained exit1/BLOCKED.

### Actual money-source mismatch and synthetic RED-before

- Traced production command registration, license/session gating, `LocalSessionState` authenticated actor, `patient_payments_native::post` active role/permissions, tenant and `BEGIN IMMEDIATE`, `financial_notices_native::verify_patient`, shared `verify_scoped_patient_payments`, native V1 033/036 records, cash writer and immutable 043 credit source, `delivery_collection_native` real journal proof and owner reconciliation. The previous shared native payment-cash verifier queried `cash_movements` with `COALESCE(NULLIF(TRIM(cm.pharmacy_id),''),'local_default')=?`. This made an **original explicitly scoped** native cash receipt, subsequently changed to `pharmacy_id=NULL`, indistinguishable from an owned `local_default` cash movement. The native writer could then issue an **additional bank payment** against the same patient credit despite the persisted cash custody now contradicting the original scope. The same shared helper authorizes native customer notices. No source, original seed, journal or ledger history was rewritten to construct this attack; it used isolated disposable SQLite.
- `patient_payments_native::tests::native_cash_receipt_losing_its_tenant_cannot_be_reused_as_local_default` posts legitimate scoped native cash20 on original provable credit100, changes only the synthetic cash movement tenant to NULL and attempts another bank40. **Genuine RED-before** pinned session `59515`: **0 passed / 1 failed**, exit101, because the old native writer returned `Ok(PatientPaymentReceipt remaining_balance=40)` rather than deny. This is not a fixture compile error. Test verifies unchanged payment/scope/cash/journal/entries/shift counts on denial and genuine valid bank continuation after repairing only the disposable synthetic receipt. This asserts current persisted contradiction, **not cryptographic original custody**.

### Small shared root fix and read-only source visibility

- In `patient_payments_native::verify_scoped_patient_payments`, both the reserved cash movement validity filter and actor/date amount-and-count reconciliation require **literal persisted `cm.pharmacy_id=?`**, never NULL/blank-to-default coalescing. For a natively scoped cash payment a missing or changed cash receipt now fails source conservation before any further patient or notice source, cash movement, shift, journal, adjustment or immutable scope posting. The original positive native writer always persists its actual pharmacy, and no existing history is backfilled or assigned a guessed pharmacy. This helper is already called from **both** native patient payments and native financial notices under their existing live actors, permissions, `BEGIN IMMEDIATE`, request replay checks and transactional rollback; no parallel divergent trust logic was introduced.
- New `financial_notices_native::tests::customer_notice_cannot_rely_on_orphaned_local_default_cash_receipt` independently inserts a typed, scoped prior patient payment, a reserved cash receipt with **NULL** tenant and a valid native 043-backed local credit source. A fresh authenticated owner notice must be rejected **before** any new notice, journal, entries or activity; a synthetically repaired, explicitly scoped cash receipt permits the valid notice. The tests retain unauthorized, foreign tenant, malformed amounts, original 043 source, V1 mirror, canonical account, duplicate nonce and concurrent rollback protection.
- Owner-only `financial_source_reconciliation_native` now includes the fixed, bounded read-only `NATIVE_PATIENT_CASH_UNKNOWN_TENANT` query. It scans **reserved native** `cash_movements.source_type='patient_payment'` with NULL/blank current scope, retaining actual `target_name`, amount only when numeric and **no invented journal UUID or pharmacy**. It emits `native_patient_cash_tenant_unknown`, classification **`unverifiable_history`**. An old V1 cash/payment pair has no durable cash-movement UUID or independent authenticated original source linkage; the current NULL/blank value cannot establish its historic custodian or prove fraud. The owner-only report retains active owner authorization, read-only snapshot, row cap, maximum 200 findings and fail-closed overflow. Synthetic fixture verifies NULL and blank are reported, while an explicit `local_default` movement and unrelated source type are not; admin is denied. The initially added owner test failed with the strict decoder on a blank scope (session `68309`: **25 passed / 1 failed**, exit101). Root projection corrected to `NULLIF(TRIM(cm.pharmacy_id),'')` so unknown remains unknown, not a fabricated ID. Focused owner GREEN session `1984`: **26 passed / 0 failed**, exit0.

### Exact verification, release custody and residual independent barriers

- Pinned Rust1.77.2 focused patient-payment module session `37422`: **13/13**, notice module **11/11**, both exit0. Owner reconciliation module **26/26** session `1984` exit0; scoped stable Rust formatter and `git diff --check` session `25029` both exit0. Full pinned **debug** native suite session `2816`: **510 passed / 0 failed / 1 ignored**, exit0. Ephemeral synthetic optimized secure-release uses a newly generated **disposable public Ed25519** Base64URL verifier, QA `tpm-v2` and deliberately invalid `https://licensing.example.invalid` authority, not production issuer or physical TPM. Full pinned Rust1.77.2 optimized session `70605`: **503 passed / 0 failed / 1 ignored**, exit0; QA environment explicitly cleared in `finally`. The one ignored genuine physical TPM acceptance remains unrun. Previous Python licensing 40, TypeScript/ESLint exit0, Jest319 suites/2633 tests and Tauri static70/2 exports are **prior unchanged-input** evidence, not rerun: no Python/frontend source changed. Offline backup and recovery behavior and acceptance document unchanged; destructive live restore remains disabled.
- Original native V1 patient payment scope still does **not** store a uniquely linked payment journal or cash movement ID; grouping by actor/date/tenant checks current consistency but does not certify old source-to-journal origin or collusive database changes. Previous 043 credit source, current financial journal and delivery source/fee checks, issuer clock protections, owner-only reconciliation and protected migrations remain in place. No migration 051, historical rewrite or guessed V1 journal mapping was introduced. Original pre-050 patient ownership, uncertified fractional-cent delivery receivables, closed books, supplier/cash/COGS/stock, returns, revocations, production issuer, physical TPM, signed installed Windows binary, independent commercial seed remediation, dependency-risk disposition, authenticated backup origin, quiesced interrupted restore/rollback and finance/custodian/two-person signoffs remain pending. An unsigned SQLite receipt and local SHA are structural checks, not signed historical origin. **Original project OPEN; commercial release BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` unset.**

## 2026-10-13 further forward-only 051 patient finance, fractional credit conservation and issuer extension

**Original gold-standard objective remains OPEN / commercial release BLOCKED.** This is a subsequent implementation after the above 050/V1 work, not a revision of its historical evidence. Re-read full Ponytail skill and Pharma `AGENTS.md`; reconciled unchanged HEAD `a9411cce`, baseline 312 dirty/untracked, 0 staged, no active builds, and recovered retained native Rust1.77.2 debug session `2816` **510 passed/0 failed/1 ignored** and optimized synthetic session `70605` **503 passed/0 failed/1 ignored**. Verified the authoritative gate, trusted native license/session and generic SQL release checks, delivery 043/045 postings, recovery acceptance, current source/notice/cash provenance and issuer authority paths before any new edits. Protected 001–049 files, 050 and original seed remained untouched.

### Reproduced independent financial RED failures

- **Fractional receivable overcollection**: `patient_payments_native::post` formerly used `request.amount > outstanding + 0.005`. A genuine 043-format source credit **99.996** with legitimate approved patient-account refund **15.000** owed only **84.996**; a cent-exact payment **85.00** was *accepted*, causing a **0.004** cash/receivable overcollection and displaying zero remainder. Disposable adversarial `fractional_microunit_credit_does_not_allow_overcollection_by_half_cent_tolerance`, pinned RED session `88953`, **0 passed/1 failed**, exit101 with actual `Ok(PatientPaymentReceipt remaining_balance=0.0)`. Replaced half-cent grace with a collectible-cent **floor** using only sub-micro float-sum tolerance; now 85.00 is rejected before any cash, shift, patient transaction, scope or journal write, while 84.99 posts and retains the honest **0.006** residual. This does not round, forgive or rewrite old source balances. Focused module GREEN 14/14 exit0.
- **Unlinked V1 bank journal**: migration 033 stored patient, tenant, nonce but **not** the independent random original bank journal UUID; bank payment balance relied on mutable `patient_transactions.amount`, while prior cash-only group reconciliation did not inspect bank source/journal. An existing genuine bank20 can be recorded in an independent balanced journal, while a mutable historic V1 mirror asserts bank1; this makes new bank80 apparently collectible even when true bank20 + bank80 exceeds the source receivable. It also allows a new customer notice to rely on the invented balance. Owner-only journal balance reports see only balanced entries, not the missing source FK. Actual native **RED** session `91398`: **0 passed/2 failed**, exit101, both native patient payment and notice writers returned `Ok` from adversarial in-memory V1 bank history. No old journal ID is inferred from actor, date, text, amount or random UUID.
- **Unlinked V1 customer notice**: migration 036 originally paired a notice and patient adjustment, **not** the notice journal. A currently matching old notice and adjustment without **any original journal** can add a positive 60 to the patient receivable, authorizing further cash, or can permit further notices, even with 043-backed credit sales. Native RED session `31110`: **both focused tests failed as expected**, exit101 each; `post` accepted bank80 and `post_with_lock` posted an additional customer notice. A 036 notice scope plus mutable adjustment is not evidence of an original A/R posting.

### Forward-only 051 original source-to-journal structural witnesses

- Added only new forward SQL migration `051_patient_financial_journal_receipts.sql` (SHA-256 **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`**), registered as native SQLx **version 51**, `patient_financial_journal_receipts`. The **original 49 migrations' aggregate SHA** remains `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`; existing forward migration 050 SHA remains `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`. No historical SQL, SQLx checksum, source/customer DB, historical journal or pharmacy provenance is changed. Real disposable SQLx startup from migration 001 through 051, with compatibility preparation, **passed 1/1**, retained original 001 checksum, and started with zero fabricated V1 receipt rows.
- `native_patient_financial_journal_receipts` records each **new** native patient payment or financial notice source ID, issuer actor, literal tenant, original journal UUID, cents and money kind. Both authenticated native writers insert their receipt **after posting the real canonical two-line balanced journal**, inside their existing **single `BEGIN IMMEDIATE` transaction**. Real SQLite insert guards match actual source/posted tenant, actor, amount, date, method, original journal header, exact journal debit and credit monetary entries and canonical account codes (`1.1.1` cash, `1.1.4` bank, `1.1.2` A/R, `4.2` customer adjustments). An invalid account/source/journal aborts the entire posting. Native DB triggers forbid update/delete of receipted payment/notice source, scope, journal header or entries, and prevent appending a third journal line; witnesses themselves cannot be edited/deleted. Existing old V1 rows are not sealed retroactively or reclassified as criminal.
- The existing **shared** preflight now requires a matching 051 source/actor/tenant/cents witness for a prior V1-style **bank** payment before it can authorize a **new** patient payment or customer notice. Similarly, shared native-notice verification requires a genuine 051 witness for each prior customer notice that affects the patient account. Historical 033 bank or 036 customer notice lacking an originally issued 051 witness is **not deleted, backfilled, ignored in old statements, or silently reassigned**, but automatic further monetization is held for independent finance review. Both branches retain their 043 original credit sale/refund provenance, live role/tenant/permissions, nonce, transaction and canonical account checks. Separate immutable 051 positive and adverse tests cover replayed request IDs, tampering with source amounts and actor scope, journal total/entries or receipt, legitimate continued same-tenant receipt/notice posting, and complete rollback/no new source or ledger on rejection. The synthetic originally valid V1 notice fixture was updated to provide the real 051 journal/receipt rather than pretending a scope plus adjustment certified history.
- Owner-only, read-only, bounded financial-source reconciliation adds fixed `LEGACY_PATIENT_MONEY_JOURNAL_LINKS`: missing original V1 bank/notice UUID relationships are `unverifiable_history` with **NULL journal**, never guessed. For **new** 051 receipts, `NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE` independently compares current source+tenant+actor+date+amount and the stored journal/entry counts/sides/amounts. Actual current source/journal contradictions are `explicit_contradiction`, while mutable **current** canonical account-code classification is `unverifiable_history` rather than fraud. Owner-only synthetic regression includes both old V1 histories, an intact 051 bank witness, a synthetic external source amount edit, a journal header edit and a rejected non-owner. The report maintains the 1,000,000-row per-table scan cap, maximum **200** findings and no partial output on overflow. These are **structural local SQLite witnesses, not remotely signed proof of original historic source custody**.

### Authorized issuer renewal of an installed paid license

- Independently inspected previously documented missing trial/paid term-continuity path. The operator-only **offline issuer CLI** now accepts `extend` from **JSON on stdin** with `license_id`, `expected_serial`, `expected_expires_at_utc`, later `expires_at_utc`, `actor_id` and `operator_token`. `Authority.extend_term` uses the existing operator credential check, durable issuer clock/high-water and `BEGIN IMMEDIATE` SQLite transaction, compares both serial and old expiry, rejects revoked licenses and invalid time changes. It retains the **same license ID and machine**, and for an active installation returns a **new signed Ed25519 lease with incremented activation serial** (even if the old paid term has expired), rather than weakening native anchor continuity or issuing a different license ID. An unbound available license can be extended without changing its activation code or inventing a device grant. The public customer **HTTPS** endpoint exposes no new operator method; no production issuer seed, token, TLS certificate, physical TPM or authority database was provisioned.
- Two new synthetic `test_authority` tests initially **RED** because `extend` returned `invalid_command` (session `33658`, 0/2, exit1), then **GREEN 2/2** (session `10049`, exit0), verifying higher serial and same machine, expired term rollover, stale request/old envelope replay rejection, unauthorized token, non-extension, revoked refusal, cross-thread atomic CAS (only one succeeds), and unbound preactivation extension. Full licensing Python suite session `80130`: **42 passed/0 failed**, exit0; Python syntax compilation exit0. **Not solved by another local file**: if both the signed-license file and DPAPI anchor are erased before reinstallation, original device revocation/monotonic state cannot be proven offline without separately trusted issuer/hardware/external recovery custody. Existing revocation checks remain fail-closed while their anchors survive; production state/key and genuine device replay tests remain external acceptance blockers.

### Final changed-source verification and remaining certification

- Pinned Rust1.77.2 debug suite **after all final Rust edits** session `77260`: **519 passed/0 failed/1 ignored**, exit0; disposable Ed25519 public verifier, QA `tpm-v2` and deliberately invalid `https://licensing.example.invalid` issuer optimized Rust1.77.2 suite session `21589`: **512 passed/0 failed/1 ignored**, exit0, with QA environment cleared in `finally`. Real TPM manual test remains ignored/unapproved. Focused payment **17/17**, notices **14/14**, owner **27/27**, actual native startup 001–051 **1/1**, all exit0; stable rustfmt and `git diff --check` exit0. Previous TypeScript/ESLint and Jest **319 suites/2,633 tests** and `build:tauri` **70 static pages/2 exports** are *historical unchanged-source* evidence, not rerun; no JS, TS or frontend source changed. Python licensing rerun as above due issuer changes.
- Final protected custody: original `src-tauri/pharma_local.db` **58,687,488 bytes**, SHA-256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**; HEAD `a9411cce`, **313** user-owned dirty/untracked paths (preexisting 312 plus only new 051), **0 staged**, 51 total migrations including protected original49+050+new051, `src/middleware.ts` present, temporary middleware/actions/API paths absent, **0 active builds**, QA and `PHARMA_SECURITY_RELEASE_APPROVED` environment variables unset. Real commercial `scripts/check-commercial-release-seed.js` still **exit1/BLOCKED** because the original bundled seed contains a configured password hash; no bypass or seed/customer data modification.
- Offline recovery logic **unchanged** and `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` deliberately untouched. Deployment **remains unapproved** pending independently authenticated backup origin, site/tenant custody and migration history, quiesced OS-exclusive staged crash-safe restore with interruption/rollback testing and two-person operators. Historically valid V1 bank/notice journals remain without source UUID and require independent finance certification; pre-050 patient identity, fractional-cent legacy **delivery**, old purchase/supplier returns/cash, stock valuation and closed-period journals still lack fully authenticated provenance. Production issuer/device TPM monotonic state, signed installed Windows app, authorized seed remediation, dependency risk disposition, finance/custodian/owner/operator written acceptance and installation/revocation/timing QA are external conditions. **Original gold-standard project OPEN; commercial release BLOCKED; never set `PHARMA_SECURITY_RELEASE_APPROVED`.**

## 2026-10-13 actual Chrome GUI and isolated original seed examination (test-data permission)

**OPEN/BLOCKED throughout; no commercial approval.** The operator expressly authorized using the GUI and the bundled seed **as testing data**. Re-read the full Ponytail skill, `AGENTS.md`, current gate and recovery acceptance before touching source. Reconciled HEAD `a9411cce`, 313 starting dirty/untracked paths, zero staged, 51 existing migrations, and the existing user process/window list. The open window titled `Pharma` was **Notion**, not the licensed Tauri desktop application; no actual Pharma app or Next dev listener existed on the normal ports. A debug executable exists under `src-tauri/target/debug`, but was deliberately **not** launched against the real app-data database or treated as a signed installed release.

### Original seed and true limits of this data

- Original bundled `src-tauri/pharma_local.db` opened **read-only**: SQLite `PRAGMA quick_check` returned `ok`. Its content has **1 user, 0 patients, 0 sales invoices, 0 returns and 0 daily journals**, and no `_sqlx_migrations` table. The original size is **58,687,488 bytes**, SHA-256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**. This is a genuine bootstrap/test seed, **not** a real historical pharmacy accounting dataset; it cannot attest fractional-cent deliveries, source-to-journal conservation, closed books or tenant ownership in old customer histories.
- Created a byte-for-byte verified **disposable copy** under the OS temporary directory and ran a standalone Next.js 15.5.27 GUI at `127.0.0.1:3107` with `PHARMA_DB_PATH` explicitly pointed to this copy, `NEXT_PUBLIC_TAURI=0` and no native API/license impersonation. The source database was never opened for writing. The Chrome browser was inspected via actual DOM, console, actions and HTTP-response CSP. This tests the **browser development renderer and middleware**, **not** the authenticated production Tauri IPC, issuer, physical TPM or installed Windows binary.
- After closing the isolated GUI, removed **only one** configured password hash in the **disposable copied DB**, with no backfill or finance edits. The already-existing exported `validate()` commercial seed verifier, supplied the real original 001/032/native schema/main/auth sources, returned **PASS** on this sanitized **candidate**. This demonstrates that an authorized, reviewed clean seed is technically possible. The shipping checker was **never modified, redirected or bypassed**; on the protected **original** it still exits **1/BLOCKED** with `Bundled seed contains a configured user password hash`. The disposable temporary copy was subsequently safely deleted after verifying its unique temp path; no test credential, duplicate DB, GUI listener or browser tab was left behind. No real owner credential was exposed, inferred or changed.

### Real GUI RED, root fix and regression results

- Real Chrome initially rendered `/login` but **failed to hydrate** in ordinary browser development: the middleware CSP served `script-src 'self' 'unsafe-inline'` without `'unsafe-eval'`; Next's `react-refresh-utils` threw an `EvalError` and a submitted HTML login form navigated to **`/login?`** instead of running its React handler. Inspection traced it to the CSP branch in `src/middleware.ts` using `NEXT_PUBLIC_TAURI === '1'` rather than the actual **development mode**. The same branch allowed `'unsafe-eval'` for a Tauri flag **even outside development**. This is a concrete GUI trust-boundary and testability defect, not an assertion that production authentication was bypassed.
- Adversarial regression **RED-before** focused Jest session `51223`: **2 passed / 2 failed**, exit1, reproducing ordinary web-development hydration header rejection and unsafe eval under a Tauri flag outside development. Applied the smallest shared root fix: CSP `'unsafe-eval'` now only when `process.env.NODE_ENV === 'development'`. This does **not** change Tauri session authorization, anonymous redirects, permissions, secure-release issuer requirements, or production script policy. The existing Next compiled test runtime inlines `NODE_ENV='test'`; after an intermediate readonly-TypeScript-env test error and a fixture attempting runtime override, the test now exercises the **non-development** policy directly, and the genuine live Chrome HTTP header independently verifies development. It does **not** claim a Jest-mocked environment is proof of installed production CSP.
- With the real GUI relaunched/reloaded, browser response CSP explicitly included `script-src 'self' 'unsafe-inline' 'unsafe-eval'` under the development server; controlled UI input no longer produced the original `/login?` fallback. The anonymous `/accounts` route redirected to the actual `/login` surface with no authenticated session. The browser build's `loginLocal` calls `/api/auth/login` outside Tauri, but that API route is intentionally not present in the hardened native/static Tauri source; therefore **no successful authenticated native GUI transaction was or could be certified** by this preview, and no dummy endpoint or localStorage token was introduced to fake one. The controlled GUI run and its unique browser tab/server were stopped after observations.
- Final relevant TypeScript `tsc --noEmit --pretty false` **exit0**, focused ESLint on middleware and regression **exit0**, focused middleware/role/auth **3 suites / 18 tests passed**, exit0. Then completed **full** Jest after the last frontend test adjustment: session `76642`, **319 passed suites / 1 skipped (320 total), 2,635 passed tests / 3 skipped (2,638 total), exit0**. Two extra passing tests relative to the prior 2,633-test baseline. No Rust, Python, database logic, JavaScript backend routes or recovery code changed this round, so the existing pinned Rust1.77.2 **519 debug** and **512 synthetic optimized** passes, Python licensing **42**, and previous static Tauri 70-page/2-export build are **retained unchanged-input** evidence, not rerun. `npm run build:tauri` was not invoked because the change is in middleware **excluded by the static-export script**, and that script temporarily renames middleware; this avoids unnecessary risk to the user-owned dirty tree.

### Final custody and release boundary

- Final HEAD **`a9411cce`**, **314 dirty/untracked paths** (initial 313 plus the newly touched existing tracked middleware test/source state), **0 staged**; original migrations **001–049** unchanged with aggregate SHA `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, existing 050 SHA `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`, existing 051 SHA `40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`. Original seed SHA and size unchanged; `src/middleware.ts` restored/present, `middleware_temp.ts`, `actions_temp`, `api_temp` absent; 3107 GUI server closed, no approval or synthetic license QA environment variables, `git diff --check` exit0. The real commercial seed preflight still exit1/BLOCKED. No source/customer data or recovery evidence was destroyed; only the purpose-built disposable temp clone was discarded. No hardware signing credential, production issuer, independent historical finance review, signed installed Windows validation, authentic quiesced crash-safe recovery rehearsal or finance/operator two-person signoff can be substituted with this browser/seed check. **Original Pharma gold-standard release OPEN / BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` remains unset.**

## 2026-10-13 follow-on delivery fractional-cent review and subcent general-ledger conservation

**Gold-standard objective OPEN; commercial release BLOCKED.** Re-read full Ponytail, `AGENTS.md`, current gate; reconciled HEAD `a9411cce`, 314 preexisting dirty/untracked paths, 0 staged, original seed SHA `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, 050 and 051 checksums, and safe temporary build paths. Read original 043 and 045 financial guards, native authenticated actor/tenant collection, source reconciliation and owner maintenance GUI. No original migration, customer database, bundled seed, prior journal or original provenance witness was changed.

### Real synthetic RED-before failures

- **Noncollectible fractional 043 delivery offered as cash action**: real 043/045 in-memory SQLite fixture with tenant A, owner A, original balanced A/R journal **20.004**, 043 immutable sale witness `sale_micros=20004000` and completed delivery. The native `collect_with_lock` already correctly rejected the non-cent source, but `pending_delivery_page` returned it as a pending cash action. Focused `fractional_delivery_is_not_presented_as_collectible_cash` test **RED exit101**, queue included `sale-fraction` and `sale-a` rather than only `sale-a`. A cashier must not be encouraged to round the historical receivable, yet hiding the record without another review path would be unsafe.
- **Owner journal half-cent audit blind spot**: `JOURNAL_TOTALS` used `ABS(debits-credits)>0.005` and the same half-cent tolerance between native purchase journal header and debit totals. A **20.000** journal header with debit **20.000** and credit **19.996** escaped general imbalance review, as did a purchase-marked header **20.004** versus actual balanced debit **20.000**. Genuine `owner_detects_subcent_ledger_imbalance_and_native_header_disagreement` native test **RED exit101**: `journal_unbalanced` not emitted.
- **Uncertifiable legacy fractional delivery invisible to owner**: a completed old delivery sale **20.004** with NULL historic pharmacy, no original 043 witness or linked journal was not classified for manual reconciliation. Genuine `owner_flags_fractional_delivery_receivable_without_guessing_an_original_journal` native test **RED exit101**, expected one review finding but got zero. No journal UUID/tenant can be inferred from an old sale header or current actor.

### Minimal native implementation (no migration)

- In `delivery_collection_native::pending_delivery_page` the fixed, actor-scoped SQL now admits only 043 delivery witnesses whose original `sale_micros` is a whole number of cents and matches the stored total within floating representation noise. The 045 cash writer/transaction remains unchanged and independently rejects fractional sale sources. Existing proper cent-exact delivery collection, shift, journal, receipt, replay/tenant and ambiguous-success protections remain active; there is no rounding of principal, forgiveness or legacy mutation.
- Owner-only `financial_source_reconciliation_native` adds a bounded, read-only **`delivery_fractional_review`** scan for uncollected completed `payment_method=delivery` sources whose numeric stored amount is not cent-exact. Finding `delivery_fractional_amount_needs_review` is **`unverifiable_history`**, with `source_amount` and original sale ID but **NULL journal_pharmacy_id**, and unknown/blank source pharmacy preserved as NULL. Neither 043 presence nor current mutable branch supplies a signed historical journal; this is an operational review requirement, not an accusation of fraud or a reconstructed balance. The new query is inside the existing live authenticated owner-only read snapshot, 1,000,000 per-table scan cap, LIMIT201, 200-finding all-or-error boundary and response decoder whitelist.
- Generic journal `JOURNAL_TOTALS` detects debit/credit or recognized native header-to-debit discrepancy above **0.000001 monetary units**, rather than forgiving 0.005; the tiny float tolerance avoids treating binary representation alone as lost cents. This is an independent journal *structural* discrepancy, not cryptographically authenticated historical provenance. No legacy sale, delivery, journal or financial claim is automatically corrected.

### RED/GREEN and independent limits

- Initial three focused RED commands **all exited 101** (real native failures), then module GREEN: `commands::delivery_collection_native::tests` **8/8**, `commands::financial_source_reconciliation_native::tests` **29/29**, exits0. Installed `rustfmt` 1.9.0 formatted only these two Rust source files and its `--check` exited0; optional pinned 1.77.2 `rustfmt` component was not available, and no toolchain/dependency upgrade was requested.
- Full exclusive pinned **Rust 1.77.2 debug** native suite: **522 passed / 0 failed / 1 ignored**, exit0, retained background session `49553`; the ignored physical TPM test remains unperformed. Full pinned optimized `--release` suite with newly generated ephemeral **public-only Ed25519 verifier**, synthetic `tpm-v2` setting and `.invalid` licensing URL: **515 passed / 0 failed / 1 ignored**, exit0, session `24647`. QA env removed in `finally` and confirmed `SYNTHETIC_QA_ENV_CLEARED=True`. These tests do not certify production issuer, TPM or installer. Python licensing42 and frontend Jest319 suites/2635 tests are retained **unchanged-input** evidence, not rerun; no Python/TypeScript/backup behavior changed. Offline recovery acceptance file stays untouched.
- Original protected bundled seed is NOT a historical finance corpus (0 patient/sale/return/journal rows). Genuine historical fractional delivery settlement, original receivable ownership, third-party journal custody and authorized operator reconciliation still require independent finance evidence. Production issuance/TPM monotonic state, signed installed Windows, original bundled seed credential remediation authorization, dependency-risk review, authenticated quiesced recovery/rollback and finance/operator two-person release approvals remain unresolved. Commercial `check-commercial-release-seed` must continue to run on the original and continue blocking. **No `PHARMA_SECURITY_RELEASE_APPROVED`; original commercial release BLOCKED.**

### Final custody after verification

- Final independent command state: HEAD `a9411cce`, **314** existing dirty/untracked paths, **0** staged; exactly **51** SQL migration files; protected original seed **58,687,488 bytes**, SHA-256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**; forward migration 050 SHA **`9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`** and 051 SHA **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`**, matching retained custody. The 49 historical 001–049 SQL files were left untouched; the previously recorded aggregate SHA **`17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`** remains baseline evidence, not newly reproduced with its original manifest-hashing algorithm in this round. Actual `scripts/middleware_temp.ts`, `scripts/actions_temp`, `scripts/api_temp` absent, approval/QA env count **0**, active Cargo/Rustc/Jest **0**, `git diff --check` exit0.
- Original seed SQLite **read-only** `quick_check=ok`, one configured user and zero sales; real fixed-path commercial seed preflight **exit1**, `Bundled seed contains a configured user password hash` — expected release block. No original seed cleansing, credential alteration, customer-data migration, historical financial backfill, live restore, licensing approval or installer publication performed. **Commercial release remains BLOCKED.**


## 2026-10-13 live production activation commissioning preflight (independent prerequisites unavailable)

**Commercial release remains OPEN / BLOCKED.** User asked to complete production HTTPS issuer, TPM/device and signed installed Windows acceptance. Re-read full Ponytail and AGENTS rules, live licensing issuer/desktop/CI/security source and authoritative gate, and preserved protected original business assets. This is a **read-only production readiness assessment plus an operator runbook**, not a deployment or issuer/certificate provisioning. See `docs/PRODUCTION_ACTIVATION_ACCEPTANCE_2026_10_13.md` for the precise sequence, commands, independent evidence and approvals required.

- Working HEAD `a9411cce`, 314 user-owned dirty/untracked paths initially, 0 staged. Original protected migrations 001–049 sorted SHA aggregate `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`; full current schema has 51 migrations, protected original seed 58,687,488 bytes SHA `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, middleware present and temporary file paths absent, `git diff --check` exit0. No changes to code, customer/seed DB, original 001–049/050/051 SQL, license activation anchor or installed app, no unsafe reset/clean or TPM key creation.
- Actual local operator environment **has no process-scoped** issuer signing seed, authority database path, operator token, reviewed verification public key, HTTPS authority origin, Authenticode PFX, or updater signing key configured. This is not a claim those secrets do not exist in some separately managed operator vault/CI. `gh` CLI is not available, so no GitHub environment or distant deployed issuer was queried or configured. Release approval remains unset.
- Hardware query: `Get-Tpm` returned `Administrator privilege is required to execute this command`; `Win32_Tpm` CIM returned `Access denied`. Thus physical TPM present/ready/owned status **was not measured**. The intentionally ignored key-persisting TPM proof test must not run in an unspecified local or customer Windows profile. No installed on-device TPM-v2 issuer challenge/replay/second-physical-machine pass is claimed.
- Existing local x64 NSIS installer `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Pharmacy Local Enforcer_0.2.109_x64-setup.exe` (16,552,320 bytes, last written 2026-10-08 18:25:12 UTC) has `Get-AuthenticodeSignature.Status=NotSigned`, **no signer and no timestamp**. No Windows CurrentUser/LocalMachine signing certificate appeared in accessible code-signing stores. This binary cannot be treated as the requested signed production build or installed validated app. The real `.github/workflows/release.yml` still guards release with a GitHub approval variable, fails closed on certificate, production seed, dependency advisories and signed updater presence; no workflow run or publisher authorization was exercised.
- Actual protected original `node scripts/check-commercial-release-seed.js` still **exit1/BLOCKED** (`Bundled seed contains a configured user password hash`); did not bypass, alter original or substitute clean disposable copy. Nonproduction Python issuer suite newly rerun **42 passed / 0 failed**, session `92679`, exit0. Prior unchanged native Rust licensing debug **30/0/1 ignored**, synthetic optimized **29/0/1 ignored** and React activation UI **9/9** remain valid **prior** QA evidence, not this run's physical acceptance. Synthetic loopback Ed25519 signer and revocation tests cannot establish external TLS/DNS, production issuer private-key custody, signer code integrity or physical-device security.
- New production npm audit `npm audit --omit=dev --audit-level=high --json` metadata: **0 critical, 0 high, 13 moderate, 2 low** advisories. The low/moderate findings still require current reachability and owner disposition; no dependency changes here. Do not conflate an advisory count with independent security sign-off.
- Added only `docs/PRODUCTION_ACTIVATION_ACCEPTANCE_2026_10_13.md`, a concrete commissioning/GO-NO-GO runbook for real production issuer, CA/TLS ingress, reviewed public-key pin, authorized customer expiry and first delivery, real TPM two-device and cross-user tests, Authenticode timestamped x64/x86 installer and updater verification, seed remediation, dependency review and finance/custodian/two-person approvals. Example hostnames are explicitly placeholders; no secrets or activation code are written or printed. **Original finance/recovery/installation/licensing external acceptance remains pending; do not set `PHARMA_SECURITY_RELEASE_APPROVED` or distribute unsigned installer.**

## 2026-10-13 native recovery journal custody and delivery A/R audit corrections

**Original gold-standard project OPEN; commercial release BLOCKED.** Resumed after GUI/CSP and 051 work with full Ponytail/AGENTS review and live Git/source custody. The fixed original seed and migrations 001–051 were never modified; synthetic records below belong only to disposable native tests. The native actor, permission, delivery 043/045 journal and recovery rehearsal paths were inspected. An independent concurrent workspace increment added further gate sections during this work; earlier sections are retained verbatim.

### Actual RED-before attacks and narrow shared fixes

- **Foreign financial journal accepted by staged recovery:** `database_backup::tenant_fingerprint` compared only users, inventory, sales, purchases, returns and cash tenant universes. A disposable SQLite backup retaining a valid balanced journal, but with its `daily_journals.pharmacy_id` changed to a foreign site and its **unsigned** backup manifest size/SHA recomputed, passed the real `stage_recovery_rehearsal_on_source` and published `verified_isolated_copy_only`. Pinned Rust1.77.2 focused **RED** session `42975`: **0 passed / 1 failed**, with actual `Ok(RecoveryRehearsalResult)`. The existing bounded fail-closed tenant-universe verifier now also scans `daily_journals`; the synthetic fixture includes the realistic persisted pharmacy column. Same case **GREEN 1/1**, session `36300`, and the full backup module **29/29**, session `22737`. No live restore, migration, source/backup custody signature, history rewriting or site-ID substitution was introduced. NULL journal tenants now fail the rehearsal's consistency check rather than acquiring a guessed owner. Updated `docs/OFFLINE_RECOVERY_ACCEPTANCE_2026_10_12.md` because rehearsal behavior genuinely changed.
- **Balanced original delivery debit not A/R:** `financial_source_reconciliation_native::SALE_COGS_STRUCTURE` checked original 043 journal total, debit-credit balance, sales revenue and stock/COGS lines but omitted the funding debit's canonical account. An original $10 delivery journal whose actual A/R debit was changed to cash retained matching totals and receipts yet caused no owner finding, even though `delivery_collection_native::posting_and_sale` explicitly demands A/R `1.1.2`. New synthetic RED assertion in the genuine owner-only delivered-045 fixture failed **0/1** (session `75784`: expected one `sale_receipt_funding_account_unverifiable`, found zero). The fixed report now verifies one current A/R **asset debit** for positive original 043 delivery sale micros and emits this finding as **`unverifiable_history`**, not fraud: current account codes/types are mutable and cannot authenticate the original chart of accounts. Restoring the proper A/R debit eliminates the finding. The fixture's valid A/R account type was corrected from unrealistic `expense` to `asset` (intermediate module 28/29), after which the complete owner module passed **29/29** (session `84672`). The owner report remains authenticated, read-only, bounded and tenant-scoped per its existing native owner controls. No journal, cash, patient balance or historical receipt was backfilled or edited.

### Final changed-source checks and trust limitations

- Final complete **pinned Rust1.77.2 debug** native suite after both changes: **523 passed / 0 failed / 1 ignored**, session `9861`, exit0. Final **synthetic optimized secure-release** suite: **516 passed / 0 failed / 1 ignored**, session `93377`, exit0. The latter used a newly generated disposable Ed25519 **public-only** verifier, synthetic `tpm-v2` and invalid `.invalid` issuer URL; temporary environment was cleared in `finally`. The ignored physical TPM acceptance is not fulfilled. Native backup and finance owner module suites each **29/29**. A pre-existing unused-constant compiler warning was observed but was not hidden or treated as a failure. No Python/frontend source changed in this increment, so prior licensing Python **42**, TypeScript/ESLint and Jest **319 suites / 2,635 tests** are retained previous evidence, not rerun. No Tauri static build or actual signed native install was performed.
- Tenant-universe equality of unsigned SQLite/JSON is **not independently authenticated provenance**, nor per-record original journal ownership. Old bank/notice V1 source-to-journal UUIDs, pre-050 patient custody and historical fractional delivery receivables remain uncertified; valid old records were not retroactively guessed or called fraudulent. No OS-exclusive out-of-process live restore/rollback supervisor or hard-crash rehearsal was enabled. Real production issuer signing and TPM monotonic/revocation assurance, installer signature and installed Windows acceptance, protected shipping seed authorization, moderate/low dependency advisory disposition, original historical finance/stock/COGS reconciliation, authentic backup origin and two-person finance/operator acceptance remain unmet. **`PHARMA_SECURITY_RELEASE_APPROVED` remains unset; release BLOCKED.**

### Final protected custody and release preflight

- Final live custody command session `17911`: Git HEAD **`a9411cce`**, **315** dirty/untracked paths (other previously present user and concurrent work preserved), **0 staged**, **51** SQL migration files. Original 001–049 sorted uppercase `filename:SHA256` newline aggregate verified **`17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`**; migration 050 SHA **`9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`**; migration 051 SHA **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`**. Original bundled seed retains **58,687,488 bytes**, SHA **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**. `src/middleware.ts` is present and `scripts/middleware_temp.ts`, `scripts/actions_temp` and `scripts/api_temp` absent. No Cargo/Rustc/Jest/native Pharma process, process-level `PHARMA_*` QA/approval environment variables or staged files remain. `git diff --check` **exit0**. Real unchanged `node scripts/check-commercial-release-seed.js` **exit1** session `30982`, explicitly **BLOCKED** for configured bundled user password hash. No seed/customer database, original migration, journal, license key/anchor or destructive restore was altered; release flag remains unset.

## 2026-10-13 fast background Chrome GUI and linked-module test coverage

**Test-only, release OPEN/BLOCKED.** On request for the fastest minimized broad GUI test, inspected the existing real native CDP harness, current auth, Ponytail/AGENTS, and 66 `src/app/**/page.tsx` routes. Reconciled HEAD `a9411cce`, 315 initial user-owned dirty/untracked paths, zero staged, original seed SHA `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. Created byte-identical disposable SQLite test seed under a unique OS temp folder; ran isolated Next15.5.27 dev on port 3117 with `PHARMA_DB_PATH` pointed **only** at that copy and used one background Chrome tab, never a new browser/profile or customer DB.

- **Actual Chrome DOM/input:** Arabic Pharma login heading, username/password, local-login and catalog-sync controls rendered, React input accepted wrong synthetic credentials, form submit returned to idle without authenticated session. Plain Next browser is not Tauri; its `loginLocal` needs `/api/auth/login`, which is not present in the native/static tree, so genuine authenticated native dashboard is not available via this preview. Captured a `localhost`/`127.0.0.1` development-origin CSP connect/manifest mismatch and unrelated extension-font/favicons. No insecure login endpoint, fake token, old password, issuer key or CSP exception was introduced.
- **Live route/auth sweep:** Generated all **66** current page paths across **23** first-segment categories; actually requested all against running Next middleware. Final disposable QA harness **66/66 expected responses**: login 200 with CSP and 65 redirects to `/login`, including intentional `/setup` redirect (confirmed from its page source); all protected routes resisted anonymous navigation. The initially naive disposable QA harness expected `/setup` 200 (65/66), was corrected **only in temp QA harness**; second run passed 66/66. This is routing and access-gate coverage, not 66 authenticated content renders or all module functions exercised.
- **Full current linked Jest run with coverage instrumentation** session `35938`, `jest --ci --maxWorkers=2 --silent --coverage` with coverage destination under isolated OS temp: **319 suites passed / 1 skipped**, **2,635 tests passed / 3 skipped**, exit0 in **166.981s**. Measured **lines 81.70% (18,264/22,353), statements 78.92% (20,107/25,477), functions 74.79% (3,532/4,722), branches 69.34% (14,829/21,385)**, 245 coverage-summary files. Frontend linked `tsc --noEmit --pretty false` exit0 (session `92166`). Jest covers POS/sales/returns, inventory, purchases/suppliers, finance/shifts/patients, staff/roles, reports, settings, native IPC boundaries, auth and UI linkages in mocked/jsdom tests. No Rust/Python source change; prior native/pinned and licensing results retained, not rerun.
- **Actual gaps:** 1,190 functions and 6,556 branch paths remain unexecuted by this measured Jest run. Specific low-function-coverage examples: `src/lib/auth/password.ts` 1/9, `src/app/actions-client/sales-reports.ts` 3/10, `src/app/actions-client/auth.ts` 6/19, `src/components/pos/DrugDetailsModal.tsx` 34/87. Existing `scripts/tauri-cdp-test.js` is obsolete for hardened secure release: assumes default `admin/admin` credentials and renderer SQL/mutations that current owner enrollment, native session and generic SQL release policy prohibit. No genuine activated/signed installed Windows desktop/physical TPM QA or authorized full module native purchase→sale→return flow was claimed. Never equate 66/66 anonymous route checks or jsdom mocks to complete commercial end-to-end functional certification.
- Own Chrome test tab and isolated Next dev process stopped; temp QA seed and coverage outputs are only for testing and will be safely removed after preserving this report. All external commercial blockers and original seed preflight remain. **Do not set `PHARMA_SECURITY_RELEASE_APPROVED`; release BLOCKED.**

## 2026-10-13 laptop-only local license issuer and actual Tauri QA activation

**QA IMPLEMENTED AND RUN LOCALLY; ORIGINAL COMMERCIAL RELEASE OPEN/BLOCKED.** On operator request, read Ponytail, AGENTS, real Python issuer/CLI, Tauri QA app identity, Rust license guard/owner onboarding, build contract and protected custody. Added only `scripts/licensing/local_qa.py`, `scripts/licensing/build-local-qa.ps1`, `scripts/licensing/test_local_qa.py`, and `docs/LOCAL_LICENSE_QA.md`, plus a single `.gitignore` exception for the new release-input QA regression. These are a QA-only **offline signed JSON** workflow, not production activation infrastructure or an exposed HTTP listener.

- Initialized isolated Windows-user **QA operator** under `%LOCALAPPDATA%\PharmaLicenseQAOperator` outside source and customer/production app data. The newly random Ed25519 signer seed, unrelated operator token and the generated one-time license/activation code are encrypted together in Windows **CurrentUser DPAPI** state `operator.dpapi`. The issuer's independent SQLite DB and replay/serial/audit tables remain in that directory; the QA tool refuses to rotate an existing signer or reset an existing license. No issuer private seed, operator code or activation bearer string was written into the source repository, app binary, scripts, or logs. The debug app embeds **only the QA public key**; in-process build-key environment is cleared afterward. This DPAPI QA storage is **not an HSM, approved operator escrow or production key custody**.
- Fresh focused regression initially failed at the test fixture for a missing required `now_utc` verifier argument (not a live bypass); after correcting the test, it passed **1/1** with actual Windows DPAPI encryption, issue/grant signature, monotonic renewal serial2, wrong-device refusal, old-serial replay refusal and init-rotation denial. Full Python issuer, HTTPS reference, release-boundary and new local QA suite then passed **43/43**, session `10152`, exit0. The new PowerShell script parsed with **zero** syntax errors.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/licensing/build-local-qa.ps1` built the separate `com.pharma.licenseqa` **debug** Tauri application from the existing static `out` frontend; pinned Rust1.77.2 build session `95452` exited0 after 2m22s, produced `src-tauri/target/debug/pharma.exe`, and did **not** execute `seed:db` or rebuild/modify the original frontend source. It is unsigned, development-key legacy **v1 fingerprint** QA, not a verified TPM-v2 production installer.
- Real Windows Desktop QA: launched the new **Pharma License QA** window; initial screen correctly displayed **Signed license is missing** and a fresh live 64-hex machine fingerprint. The isolated issuer generated a genuine Ed25519-signed, 7-day synthetic test-term/24-hour-lease JSON **for that precise displayed fingerprint** and persisted its private operator credential only in DPAPI. Pasted only the signed envelope into the live activation UI; native verification succeeded and explicitly required restart. Clicked real relaunch; the QA app then initialized its **separate** `%APPDATA%\com.pharma.licenseqa\pharma_local.db` (63,250,432-byte QA copy) and showed the first-owner enrollment form rather than remaining behind the license wall. From the live registered renewal panel installed the next valid offline signed grant without relaunch; the panel closed successfully, and independent issuer `status` shows **active serial2**. This is real Windows Tauri QA, **not** an installed commercial signature, real production HTTPS call or evidence of a second physical TPM.
- **Known intentional limit discovered from the real GUI:** Native `commands::auth::enroll_initial_owner` strictly requires a **DPAPI-stored online activation credential** tied to the signed license, not an offline JSON installation. The displayed first-owner form cannot legitimately complete under this offline-only workflow; no password/user hash was invented, SQLite mutated to bypass it, or login success claimed. To test first-owner onboarding, a separate approved localhost/remote **HTTPS** staging origin trusted by the desktop is needed. Do not silently install a CA into the user's Windows trust store, weaken reqwest certificate validation or bypass owner authentication; document this in `docs/LOCAL_LICENSE_QA.md`.
- Current verification after new QA work: original protected bundled seed still **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`; migration count remains **51**, no historical SQL changed. QA operator directory independently outside repo; `PHARMA_SECURITY_RELEASE_APPROVED` and temporary QA public-key/device/URL vars unset; `git diff --check` exit0, 0 staged. The developer-built QA process/profile is distinct from original `com.pharma.system`, no production customer DB or license state deliberately accessed for mutation. Remaining production issuer/DNS/CA/signing/two-device TPM/owner enrollment/customer expiry/authorized seed/finance/recovery/two-person acceptance **remain BLOCKED**.

### Separate debug-native GUI observed after the browser sweep

- During final custody check, an **independently launched** local debug `src-tauri/target/debug/pharma.exe` (PID 27464, observed with window title `Pharma License QA` around 18:49 local time) appeared. It was **not started or stopped by this GUI sweep**. Read-only Windows accessibility inspection, without focus or input, showed native Pharma owner first-enrollment screen with real activation-code/new-password/confirmation controls and license-renewal button. No genuine activation code, enrolled owner, actual signed installer or authenticated native business module session was supplied, so the original native module/full dynamic acceptance remains untested. This foreign/concurrent debug process was deliberately left untouched; its presence does not establish signed installed Windows acceptance or license issuance. The test-owned Chrome tab, port3117 server and uniquely verified temporary SQLite/coverage folder were all removed, with original seed SHA intact.

## 2026-10-13 follow-on coverage of previously unexecuted functions: report scope and server auth

**Gold-standard task still OPEN; commercial release BLOCKED.** Follow-on to the real browser 66/66 anonymous route sweep and prior full Jest baseline **3,532/4,722 functions (74.79%)**. Re-read Ponytail/AGENTS, actual `sales-reports.ts` consumer linkage (dashboard and SalesReportsClient), native `actions-client/auth.ts` (session/owner IPC), standalone bootstrap password policy and legacy JWT/session origins. No original seed/customer database, journal, migration or production credential was used as a mutable fixture; new SQL tests use **only** disposable `better-sqlite3(':memory:')`. Existing 001–051 migrations and protected original seed remain untouched.

### Actual independent RED-before and minimal fixes

- **Cross-tenant sales report via renderer override:** `getSalesReportsAction(filters)` formerly used `user.pharmacy_id || filters.pharmacyId || 'local_default'`. For a genuine session shape with NULL legacy pharmacy, renderer-controlled `filters.pharmacyId='foreign-pharmacy'` selected a foreign invoice from an actual in-memory SQLite query despite the active session lacking that tenant. New `report-pharmacy-scope.regression.ts` assertion expected only valid `local_default` legacy records and **RED session `3924`: one real failure / eight passing**; received `foreign-sale` instead of `local-sale`. Narrow root fix: ignore the renderer-provided pharmacy for authoritative scope and use `user.pharmacy_id || 'local_default'`, preserving legacy default rows without inventing historical tenant attribution. The same shared sales query now passes with exact original local-default isolation. Additional synthetic report/invoice-detail tests cover multiple date/user/patient/method/ID filters, bank/all/cash, excluded draft/foreign sources, denied sessions/permissions and database exceptions. Focused suite **11/11 GREEN** with coverage of sales-reports statements **84.48%**, branches **71.05%**, lines **87.03%**. The remaining `sales-reports.ts` function count is inflated by unused local generic database wrapper methods: never call dead wrappers merely to manufacture a 100% score.
- **Legacy standalone/server session expiry and metadata:** `session.ts` persisted new expiry in ISO UTC `YYYY-MM-DDTHH:MM:SS.sssZ`, but `getSession`, `getUserSessions`, `getActiveSessionCount`, `deleteExpiredSessions` compared raw string to SQLite `datetime('now')` with a space; same-day expired ISO rows remained active in read/count and were not deleted until a later day. Its fetched raw `ip_address`/`user_agent` did not satisfy `Session.ipAddress`/`userAgent`, so refresh silently discarded client metadata. Added real in-memory SQLite session lifecycle checks covering expired same-day, active creation/rotation, inactive-user revocation, all-user deletion and 30-day pruning including ISO rows. **RED session `36037`: 2 failed / 2 passed**; got an expired row and lost persisted IP. Fixed legacy reads/deletion/cleanup with `datetime(expires_at)`/`datetime(created_at)`, explicit camel-case SQL aliases and chronological access sort; synthetic scoped test GREEN **4/4**, session `6475`. The standalone legacy JWT/service/session helper is **not** the authoritative Tauri Rust `current_local_user` session; this fix does not certify native issuer/TPM or reinstate an unsafe generic web login.

### Remaining-function test expansion and final verification

- Added dedicated password helper/standalone bootstrap tests covering actual rejection for each missing character class and length, bcrypt cost12 hash/wrong candidate, random lengths and character classes, expiry thresholds and strength labels. An initial new test fixture mistakenly used an **8-character** candidate as a short password; it failed as it should and was corrected to a genuinely short sample (not a production defect). Added native renderer action tests for live-owner permission restrictions, no-session/wrong-role, nonleaking current-user profile, owner-only `list_local_staff_summaries` IPC, native errors/owner activation status and invalid proof. **Four focused suites 28/28 GREEN**, session `24376`. In the focused test run, previously neglected `src/lib/auth/password.ts` and `src/lib/auth/session.ts` now each exercised **100% of instrumented functions**, with session statements and lines also **100%**. UI auth action still contains unexecuted legacy generic SQL wrapper functions; mocked IPC tests are not live hardware or owner enrollment.
- Changed-source **TypeScript** `tsc --noEmit --pretty false` exit0 session `88672` and changed-file **ESLint** exit0 session `54230`. Complete frontend Jest with real coverage (session `54957`, `--ci --maxWorkers=2 --silent --coverage`): **322 passed suites / 1 skipped** (323 total), **2,657 passed tests / 3 skipped** (2,660 total), exit0, **185.23s**. Measured across the same **4,722** function population: **3,551 functions exercised / 1,171 unexecuted = 75.20%**, +**19** exercised functions / **0.41 percentage points** over previous 74.79%; statements **79.40%** (20,231/25,477), lines **82.19%** (18,374/22,353), branches **69.56%** (14,875/21,384). No test failure concealed. Because no Rust/issuer Python changed here, retained native Rust 523 debug/516 optimized and Python43 are **unchanged-source prior QA**, not repeated or new hardware certification.
- **Coverage ceiling and acceptance:** 1,171 frontend functions and 6,509 branch paths are **still unexecuted** by the current Jest instrumentation. Coverage is not an assertion that all GUI buttons were clicked or all functions reachable in the live secure build; the browser anonymous route sweep, jsdom/SQLite synthetic tests and the independently launched signed-*synthetic* local QA debug license do not replace authenticated owner enrollment, native purchase→sale→return end-to-end real IPC and signed installed production Windows/TPM acceptance. Other outstanding independent finance/legacy fractional delivery, original backup custody/OS-quiesced restore, operator/issuer/seed remediation/dependency approvals and two-person acceptance stay pending. No `PHARMA_SECURITY_RELEASE_APPROVED` was set. **Commercial release remains BLOCKED.**


## 2026-10-13 user-approved laptop localhost HTTPS activation QA
**QA HTTPS trust and issuer operational; owner enrollment pending credential entry in user-visible desktop; commercial release remains BLOCKED.** The operator explicitly authorized trusting a dedicated localhost QA certificate in Windows CurrentUser trust to continue previous local offline-license QA. Read full Ponytail, AGENTS, actual HTTPS issuer/response/transport Rust/owner enrollment guards and protected source custody. Existing QA signer and 7-day test license preserved; prior offline QA identity `com.pharma.licenseqa` and production `com.pharma.system` database were not intentionally mutated.

- Generated a **14-day**, 2048-bit RSA **self-signed leaf (NOT a CA)** with only localhost DNS/127.0.0.1 IP SAN, critical `ca=False`, no cert-signing capability, only TLS server-authentication EKU. Leaf/key live under isolated `%LOCALAPPDATA%\PharmaLicenseQAOperator\https-local`; imported the public leaf **only** into `Cert:\CurrentUser\Root` thumbprint **`B958096C1F1767E93DC5E01880137A24AA5AFDF1`**, expiry `2026-10-27T17:10:43+00:00`. No machine-wide CA or production cert was added. Private TLS leaf key remains local profile-owned; no test issuer private seed/operator token written to source/binary/log.
- Started the hidden existing `HTTPSActivationServer` on **127.0.0.1:18765** only, PID **35492**, public Host `localhost:18765`. Python Windows system-default HTTPS verification matched signer public key; public `GET /v1/status` and `POST /v1/issue` each **404**, hostile Host **403**. Python actual HTTPS POST `/v1/activate` returned correctly signed device lease, and identical nonce replay returned **409**; protected operator DB advanced to QA serial **3**. Real pinned Rust1.77.2 `reqwest 0.13.3` debug network probe `src-tauri/examples/qa_tls_probe.rs` completed **QA_NATIVE_REQWEST_TLS_VALIDATED localhost=true system_trust=true** (exit0), with default WebPKI/native system trust, redirect denial and no insecure cert bypass. The Python standalone smoke exited0.
- Added `scripts/licensing/setup-local-qa-https.ps1` (user-approved leaf trust), `start-local-qa-https.ps1` (hidden single-loopback service), `stop-local-qa-https.ps1 -Untrust` (exact PID/commandline/loopback identity and exact certificate thumb check before removal), new isolated `src-tauri/tauri.licensing-online-qa.conf.json` (Tauri app ID `com.pharma.licenseqaonline`), expanded local QA operator/DPAPI helper `local_qa.py`, online-mode QA build `build-local-qa.ps1 -Online`, QA TLS and owner-password regressions, native Rust TLS probe and user instructions in `docs/LOCAL_LICENSE_QA.md`. No production native TLS, identity, auth, SQL, migration, runtime or certificate policy was weakened.
- Online QA debug Tauri built **successfully**, pinned Rust1.77.2 session **80562**, no seed/regeneration or browser frontend output rebuild; launched actual `Pharma HTTPS License QA` window, confirmed native license-activation screen and expected same MachineGuid-based QA fingerprint; independent `com.pharma.licenseqaonline` app profile initially absent. The online license **has not yet been entered in the UI**: the locally DPAPI-stored 43-character activation bearer and 39-character randomly generated QA-only owner password were deliberately not disclosed in chat or persisted as plaintext. The native first-owner screen and authenticated login therefore have **not** yet been tested through GUI; the local user can run `python -m scripts.licensing.local_qa online-credential` and `... qa-owner-password` in the own local console, enter them via the normal native GUI, restart and enroll owner without bypassing any check. Do not claim signed installed commercial release or production TPM.
- New Python issuer suite **44/44 passed**, exit0; focused QA tests **2/2**, PowerShell four scripts parsed with zero syntax errors; Rust native trust probe successful. Original protected seed and 001–051 migrations left untouched, `git diff --check` exit0, release approval process env unset. Existing source branch remains dirty with preexisting user/concurrent work preserved; no reset/clean/stash, publication, DB workaround or new release signer. Server and approved user-scope trust stay present until the user runs the documented stop script; no localhost service reaches other hosts. **Commercial finance/seed/security/TPM/Windows signing/backup/two-person release prerequisites still BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` MUST remain unset.**


## 2026-10-13 local licensing operator desktop UI and genuine online QA owner login
**QA GUI IMPLEMENTED / ONLINE ACTIVATION + OWNER LOGIN PASSED; COMMERCIAL RELEASE STILL BLOCKED.** On user request, built a Windows-only operator GUI `scripts/licensing/operator_ui.py`, launched via `scripts/licensing/open-local-qa-ui.ps1`. Reused existing DPAPI-protected issuer and HTTPS server; did **not** add a web admin endpoint, weaken TLS/native IPC, expose signing seeds or operator credentials, or touch protected original data.
- Visible **Pharma License Authority — LOCAL QA** operator UI (Tkinter stdlib) shows `https://localhost:18765` online TLS/pubkey identity, Start/Stop local server (PID-checked existing scripts), active license/serial/expiry, issue-first-test grant by displayed fingerprint, and copy-only buttons for license ID, bearer activation code and QA owner password. Codes remain invisible on the dashboard and are cleared from Windows clipboard after 45 seconds if unchanged; the integration used temporary local clipboard operations, without printing secrets to chat/build output. Existing test signer/license persisted outside repository in `%LOCALAPPDATA%\PharmaLicenseQAOperator`, separate online desktop app identity `com.pharma.licenseqaonline`.
- In **actual Tauri GUI** `Pharma HTTPS License QA` started unlicensed, entered private QA license ID and activation code from protected local account using clipboard. First request was refused because license-ID field was not correctly populated; corrected **only** that UI value and retried, receiving **native signed license verified / restart required**, then clicked **إعادة تشغيل التطبيق**. Issuer serial advanced from **3 to 4** after correct online activation, with no replay/cooldown bypass. Native DPAPI `license-renewal.dpapi` exists, its encrypted bytes contain no plaintext code, and independent read-only Windows DPAPI decrypt verified exact expected licensed ID/device/code (only booleans printed). The resulting signed lease is in `%APPDATA%\com.pharma.licenseqaonline\licensing`; release environment keys not set.
- Following native relaunch and test DB initialization, entered same QA activation bearer as owner proof and the random 39-char DPAPI-sealed test owner password twice through **إعداد حساب المالك لأول مرة**; submitted via native `enroll_initial_owner` without SQL bypass, app navigated to native username/password login. Signed in as **admin**, received displayed **System Administrator**, then actually loaded **لوحة التحكم الرئيسية**, owner nav and dashboard data. Read-only QA SQLite check found original `admin` owner credential now a bcrypt hash, distinct from plaintext and stored **only** under the isolated QA app identity. No customer pharmacy account was configured or touched.
- Operator UI was refreshed/relaunched showing server Check HTTPS, Start/Stop, issuer status and credentials/actions on the actual Windows desktop. UI-only and CLI Python code compile, 44/44 Python licensing tests exit0 (including local DPAPI/TLS QA tests and operator-command status checks), original seed 58,687,488-byte SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, 51 migrations, `git diff --check` exit0, no staged changes, release flag still unset. Live QA issuer continues loopback only; dedicated public self-signed **non-CA** test TLS leaf remains CurrentUser Root until explicit `scripts/licensing/stop-local-qa-https.ps1 -Untrust`; expiry 2026-10-27, thumbprint `B958096C1F1767E93DC5E01880137A24AA5AFDF1`. Both QA windows remain interactive for user. This is not a signed production installer, TPM-v2 physical attestation, public issuer deployment or financial/seed/backup/two-person commercial release certification. **Commercial release remains BLOCKED; do not set `PHARMA_SECURITY_RELEASE_APPROVED`.**

## 2026-10-13 continued previously unexecuted drug-details GUI paths and 201-delivery stress verification

**Original project OPEN; commercial release BLOCKED.** Re-read Ponytail/AGENTS, current live gate and dirty repository; no seed, historical SQLx migration, customer data, journal, native licensing key/anchor or issuer record was modified. Starting HEAD `a9411cce`, 324 dirty/untracked paths, 0 staged. The separate approved localhost HTTPS QA issuer was listening only on `127.0.0.1:18765` with test-only trusted leaf, and its independent unsigned `Pharma HTTPS License QA` desktop was open at an unactivated native license screen with prefilled activation fields. Inspected native UI read-only; **did not press activate, read DPAPI bearer values, enroll an owner, restart or alter that independent process.** Genuine authenticated native POS and full Windows acceptance still pending.

### Actual test-first functional bugs and shared corrections

- `src/components/pos/DrugDetailsModal.tsx` — **stale alternative search**: overlapping real React calls of `searchMasterDrugsAction('Para')` and `('Ibup')` allowed delayed older `Para` results to replace the current `Ibup` choices, making an obsolete drug selectable despite a newer search. A subsequent 1-character query also previously permitted late results to repopulate choices. New synthetic deferred promises exposed the actual wrong result (**RED** session `36299`: first two new cases failed; 16 preexisting tests passed). Added `alternativeSearchRef` request generation, cleared stale choices on every input change and drug change, accepted results only for current request, and handled rejected lookup without an unhandled failure. Short/newer query and rejected-search sibling cases assert the visible choices and error behavior.
- **Cross-drug late mutation/write**, stronger than stale content: starting edit and save on drug 11, navigating to drug 22, then settling drug11's prior write allowed `loadDrugDetails(11,true)` to overwrite drug22's details/form despite the currently selected id remaining22; a later drug22 save could send mismatched drug11 fields. Real React deferred-save RED session `36299` failed exactly the latest-drug assertion. Independent history-navigation regression covers drug A→linked B→pending B conflict addition→back to A→late B completion→A edit/save. Root fix uses `selectedDrugIdRef` and guards the **shared** details-loader's start and completion against selected id mismatch, checks original id after async save before applying UI side effects, and resets the editing state on changing selected drug. No native financial write, SQL owner, actor or record was guessed or bypassed.
- **Unsaved master-data edit erased by related-item refresh**: while editing the current drug's notes, successful addition of a drug alternative triggered the same details loader's `setFormData(result.data)`, silently deleting unsaved form fields. Genuine React regression first failed (**RED** session `50610`: 3 failed / 16 passed across the three new defect cases). Added a `preserveDraft` mode to the shared details loader for the four existing alternative/interaction add/remove refresh siblings while retaining authoritative `drugData` reload; normal save continues to replace form from committed source. New tests exercise unsaved notes, back-navigation B→A, stale queries, stale save, failed search. **Final focused DrugDetailsModal suite 22/22 GREEN** session `77877`, exit0, modal-only instrumented coverage **50.00% functions**, **74.06% lines**, **70.85% statements**, **68.78% branches**. This is renderer state/async integrity, not an assertion that the backend lacks its separate native permission guards.

### Full verification, reproducible performance-test timeout and limits

- First full parallel Jest coverage session `72478`: **321 suites passed / 1 failed / 1 skipped**, 2,662 tests passed / 1 failed / 3 skipped, exit1, 192.312s. **The sole failing test was an unchanged 201-delivery React DOM pagination stress fixture** (`coverage-gap-delivery-management.regression.tsx`) exceeding the general **5-second Jest timeout**. Reproduced independently under coverage session `97046` (10 other tests passed, the same one timed out) **and without coverage** session `80786` (the isolated scenario still timed out). No delivery money, journal or pagination assertion failed. Limited the budget of exactly this 201-row stress test to **20 seconds**, explaining the DOM workload in the test; did not skip or weaken a single functional assertion, alter delivery code or claim desktop runtime performance approval. Isolated stressed delivery module with real coverage **11/11 GREEN**, session `99801`, exit0. Heavy-list installed WebView performance remains separately unaccepted.
- **Final full serial Jest + coverage** after both source and stress-test changes: session `29272`, command `jest --ci --runInBand --silent --coverage --coverageReporters=text-summary`, **322 suites passed / 1 skipped (323 total)**, **2,663 tests passed / 3 skipped (2,666 total)**, **0 failed**, **exit0**, **352.378s**. Instrumented **functions 75.39% (3,561/4,723), lines 82.34% (18,423/22,372), statements 79.55% (20,286/25,500), branches 69.63% (14,903/21,401)**. Compared with preceding 75.20% (3,551/4,722), +10 covered function entries across one more instrumented total; **1,162 functions remain unexecuted** in this Jest measure. JSX function metrics count callbacks and dormant wrapper methods; this is not a claim of full GUI/native e2e coverage.
- Changed-source TypeScript `tsc --noEmit --pretty false` **exit0** and ESLint for modal + test **exit0** (combined session `43054`). After the full Jest completed, `npm run build:tauri` succeeded (session `18542`), Next 15.5.27 optimized static build **70 pages/2 exports**, exit0. The build's own `finally` output explicitly restored `src/middleware.ts`; post-build path custody must also confirm the temporary script action/API/middleware paths are absent. The build produced an unsigned **frontend static export**, **not** an installed/signed native Windows installer and did not activate the independent online QA window. No Cargo or Python issuer suite rerun because this increment changed only frontend source/tests.
- **Independent release gate remains**: authenticated real installed native GUI login, production Ed25519 issuer and physical TPM-v2 trust, original pre050/V1 historical finance and fractional delivery certification, authentic tenant backup/OS-quiesced crash-safe restore, approved sanitized shipping seed, dependency-risk disposition and two-person finance/operator/security signoffs are still absent. Do not infer independently authenticated journal history from UI/in-memory regression tests. `PHARMA_SECURITY_RELEASE_APPROVED` remains unset; original commercial preflight must remain enforced. **Commercial release BLOCKED.**

### Final repository and protected-custody check

- Final live Core custody command: HEAD **`a9411cce`**, **325** user-owned dirty/untracked paths (no reset/clean/stash or unrelated staging), **0 staged**, **51** migration SQL files; original 001–049 checksum aggregate **`17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`**, 050 SHA **`9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`**, 051 SHA **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`**, all unchanged. Original protected `src-tauri/pharma_local.db` remains **58,687,488 bytes**, SHA **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**. Middleware at `src/middleware.ts` present; build's script-level `middleware_temp.ts`, `actions_temp` and `api_temp` all absent; generated `out/login.html` present. No Cargo/rustc/Jest worker, release approval or process-level PHARMA QA variable. `git diff --check` exit0; real unchanged commercial seed preflight **exit1/BLOCKED** (password-hash blocker is not remediated). Only new work: `DrugDetailsModal` logic, two focused test files and appended gate; original release **OPEN/BLOCKED**. Test-owner localhost QA issuer/window/user certificate remain as previously documented, not modified or cleaned by this increment.

## 2026-10-13 authenticated native module walk and subsequent background-only regression continuation

**AUTHENTICATED QA / LOCAL FIXTURE ONLY; COMMERCIAL RELEASE OPEN/BLOCKED.** Before the user requested strictly non-intrusive background execution, operated the *existing* `Pharma HTTPS License QA` Tauri debug window, already activated with the independent localhost HTTPS test issuer and signed in with a real `admin` test-owner session. Native dashboard reported **25,404** local master drugs. Genuine native POS `Panadol` search returned options; selecting a zero-stock `PANADOL EXTRA 24 F.C. TABS` displayed the out-of-stock choices and cancellation produced **no sale**. Native inventory displayed zero stocked items. Created a plainly synthetic **QA-only patient** and opened its profile and zero-balance statement; created a plainly synthetic **QA-only supplier** and observed zero balance. Reports analytics, sales-invoice report, purchase-invoice report, trial balance (15 zero-balance accounts, balanced on two layout modes), purchase return and supplier-filtered empty returns all loaded. Tested the purchase creation form with the test supplier, one catalog item, invoice `QA-PUR-20261013-001`, apparent date/expiry fields and EGP54 computed line; native final-save input was accepted by the UI but **NO purchase posting, inventory increment or financial journal could be verified**. The form was not forcibly cleared or retried with a new request nonce; reason for noncommit remains unconfirmed, not a proven backend failure. **Do not claim genuine purchase→inventory→ledger integration acceptance.** No customer or bundled seed data, protected migrations, license secret or release-signing state was changed.

**Upon user's request, foreground GUI actions STOPPED.** All subsequent work used non-interactive connected Core PowerShell subprocesses (`jest --runInBand`, `python -m unittest`, pinned `cargo test`, read-only `sqlite3`) without focusing, relaunching or opening any GUI; test issuance/operator windows were left alone. The original QA desktop remained running but was not activated again. No screenshot/clipboard/DPAPI credential or QA code read after the background-only request.

- Background frontend purchase/replay/return/supplier/order/UI suite: **12/12 suites; 149/149 tests; exit0**, session `45599`. Background additional POS, patient, supplier, inventory, delivery, native finance/journal, returns, tenant-scoped permission and shift regressions: **33/33 suites; 365/365 tests; exit0**, session `74808`. Combined **45 suites, 514 tests, zero failed**; these are synthetic/React/action regression runs, not 514 separate real GUI IPC journeys. No source changed. Python localhost issuer/operator licensing suite: **44/44 tests; exit0**, session `77166`. Pinned Rust **`rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q`**: **523 passed, 0 failed, 1 ignored; exit0**, session `3198` (existing unused-constant warning, ignored physical TPM path not accepted). All ran without a new visible console/installer or license private-key provisioning.
- Independent QA-only `%APPDATA%/com.pharma.licenseqaonline/pharma_local.db` connection explicitly opened **`mode=ro` plus `PRAGMA query_only=ON`**: `master_drugs=25404`, `patients=1`, `suppliers=1`, `users=1`, `shifts=1`, `inventory=0`, `purchase_invoices=0`, `purchase_invoice_items=0`, `purchase_returns=0`, `sales_invoices=0`, `sales_items=0`, `daily_journals=0`, `journal_entries=0`. `PRAGMA integrity_check = ok`, explicit `PRAGMA foreign_key_check` returned **0 violations**; foreign_keys flag was off on the independent Python diagnostic connection (SQLite default), so **do not infer Tauri runtime foreign-key enforcement**. No test DB file was rewritten via the audit. No actual purchase was confirmed; unresolved UI attempt cannot be used as finance acceptance.
- Protected custody verified after tests: HEAD `a9411cce`, 325 dirty/untracked paths retained, **0 staged**; 51 migration SQL files, original 001–049 manifest aggregate `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, 050 SHA `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`, 051 SHA `40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`, original shipping seed **58,687,488 bytes**, SHA `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3` all preserved. `src/middleware.ts` present; temporary script paths absent. No active Cargo/rustc/Jest, no process-scope PHARMA QA flags, no release approval. `git diff --check` **exit0**; unchanged real `scripts/check-commercial-release-seed.js` preflight **exit1 / BLOCKED**. No reset/clean/stash, signing key trust bypass, journal backfill or customer seed modification.

**Remaining expressly not completed:** genuine finalized purchase/sale/return/stock/ledger round-trips under native GUI with independently verifiable signed actor/source proof (background-only tools cannot silently drive desktop controls), unattended OS-quiesced crash-safe restore, historical V1/fractional-delivery finance proof, production issuer and physical TPM-v2 certification, signed installed Windows distribution, approved original seed remediation, dependency disposition and independent finance/operator/security approvals. QA self-signed localhost certificate is not a production CA. Keep `PHARMA_SECURITY_RELEASE_APPROVED` **unset**; commercial release **OPEN/BLOCKED**.

## 2026-10-13 background-only synthetic purchase-posting profile and custody continuation

**LOCAL HEADLESS QA ONLY; COMMERCIAL RELEASE OPEN/BLOCKED.** After the explicit no-popup request, all commands remained background Core PowerShell/Jest/Rust and read-only Python SQLite; no desktop app was activated, typed into, relaunched, or screen-captured. Live starting HEAD `a9411cce` and 325 preexisting dirty/untracked paths were preserved without cleanup, staging or protected original/QA financial mutations. The unresolved authenticated QA purchase's pending request identity was **not** inspected, cleared, replayed or replaced; no actual signed native GUI purchase completion may be claimed.

- Read-only isolated QA database connection used `mode=ro` and `PRAGMA query_only=ON`: `integrity_check=ok`, `foreign_key_check` zero violations, and still **zero** `purchase_invoices`, `purchase_invoice_items`, `inventory`, `daily_journals` and `journal_entries`. The selected QA Panadol 24-tablet catalog row was independently observed with `id=16793`, `has_expiry=1`, official price EGP54, `base_price=0`, empty barcode and `large_to_medium=0`. No diagnostic claim about native connection-level `PRAGMA foreign_keys` is made.
- Added `src/components/__tests__/purchase-creation-nonce-reload.regression.tsx` React regression: a **synthetic** Panadol-shaped line with no barcode, no base cost and absent master unit conversion selects a valid future expiry and makes the form submit the correct `createPurchaseInvoiceAction` payload (credit, supplier, EGP54 unit cost and single preserved UUIDv4 request identity). Focused Jest **4/4 tests GREEN**, session `17860`, exit0. This checks rendered form-state/action linkage with mocked action implementation; it does **not** establish that the ambiguous live form dispatched IPC.
- Added `src-tauri/src/commands/critical.rs` native synthetic in-memory/fresh-migration fixture `credit_purchase_with_catalog_missing_barcode_and_conversion_posts_stock_and_journal`: creates an authorized local owner and supplier; uses the same absent barcode/conversion, explicit credit payment, valid expiry, price54 and zero tax/discount; runs actual `save_purchase_invoice_tx_checked` under a SQLite transaction, records native purchase creation witness in that transaction, then checks the **committed** supplier payable EGP54, one stocked unit in the actor's pharmacy, and original native posting event linked to a balanced EGP54 journal. Two initial test-only fixture errors (inherited line tax/discount; integer stock column read as f64) were corrected; **no production writer modification was warranted**. Focused pinned Rust **1/1 GREEN**, session `86898`; full pinned Rust1.77.2 offline **524 passed, 0 failed, 1 ignored**, session `68697`, exit0, 34.16s. Existing unused `STOCK_LOSS_JOURNAL` warning persists; ignored TPM acceptance is still not certified.
- `tsc --noEmit --pretty false` **exit0** and changed-test ESLint **exit0**, session `26180`. Original 51 migration SQL files unchanged; 001–049 aggregate `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, 050 `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`, 051 `40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`. Original protected shipping seed 58,687,488 bytes and SHA `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3` unchanged; **0 staged**, `git diff --check` exit0. Real commercial seed preflight still **exit1/BLOCKED** because of configured original password hash; `PHARMA_SECURITY_RELEASE_APPROVED` remains unset.

**Bounded conclusion:** the reproduced *synthetic* catalog shape can traverse tested React/action and true Rust transaction/stock/payable/journal paths; the prior no-commit native GUI symptom remains **unattributed and unaccepted**, and no forced replay is safe. Overall Jest coverage baseline remains 75.39% functions with 1,162 unexecuted; this increment did not rerun full Jest instrumentation. Actual signed installed Windows/native GUI full purchase→sale→return→ledger acceptance, production issuer/physical TPM2 certification, historical financial proof, authorized shipping-seed remediation, independent OS-quiesced backup/rollback, dependency risk disposition and two-person signoffs are all **PENDING**. The commercial release gate remains **OPEN/BLOCKED**, not waived by local green tests.

## 2026-10-13 background-only purchase nonce recoverability and supplier-ledger source-collision repairs

**ACTUAL TEST-FIRST DEFECT REPRODUCTIONS AND FIXES; COMMERCIAL RELEASE STILL OPEN/BLOCKED.** Continued strictly through quiet headless Core PowerShell/Jest/Rust, synthetic tests, read-only QA SQLite, and read-only source audit. Never activated, clicked, stopped, relaunched, or inspected the foreground native QA app, private key, token, DPAPI or unresolved purchase session nonce; did not post any live test transaction.

1. **Native purchase first-attempt local validation deadlock:** In `PurchaseInvoiceClient.tsx` a newly persisted `pending-native-create-v1` nonce was left intact when `createPurchaseInvoiceAction` deterministically rejected before any native writer was called (e.g. duplicate drug/expiry lot caught by `assertNoDuplicatePurchaseLots`). A corrected invoice then failed the original-payload fingerprint check; even Cancel was guarded, despite the identity never having been used to write anything. Actual RED Jest session `75846`: new renderer case failed with leftover nonce; new action case failed because no no-write attribution was returned (one later test failure cascaded from unfinished mocked responses). **Repair:** Action marks only **confirmed pre-native-write** failures `native_write_not_attempted: true`, tracks native writer/verified native receipt as potentially committed, and never marks an attempted write safe. Renderer discards only an identity it **just created in this invocation**, and only when action explicitly confirms no write was attempted and the stored nonce still matches; an identity from an earlier uncertain attempt is **never cleared or rotated** even if a subsequent retry fails before its new writer call. Existing browser response shapes remain unchanged. New synthetic regressions cover deterministic validation, correctable fresh nonce, native writer ambiguity and previous unknown attempt + later denied prewrite. Focused Jest **18/18 GREEN**, session `1994`; broadened purchase, POS/payment/return/supplier/handover/UI **12 suites, 202/202 GREEN**, session `25400` (a browser-mode exact-response regression was surfaced and corrected between runs). These are synthetic/action-renderer checks, **not** live Tauri posting acceptance. The historical QA request identity was never touched.
2. **Cross-source/tenant supplier ledger deletion on purchase reversal:** Read-only independent audit identified `src-tauri/src/commands/critical.rs` `reverse_purchase_accounting` deleting **all** `supplier_transactions` whose `reference_id` equaled the invoice ID, even though the column has no source-type or pharmacy scope. A distinct historical purchase-return record, especially one without the later 041/048 return provenance guard, can share this text identity. Actual RED pinned Rust session `91830`: disposable, fully migrated and FK-enforced SQLite with local owner/supplier completed credit purchase `shared-ref` plus another pharmacy's genuine legacy completed purchase return `shared-ref` showed deleting the local purchase **erased the unrelated foreign supplier return ledger** (foreign row count 0 instead of 1). No original/QA DB was modified. **Repair:** Shared reverse operation now inspects **all** supplier ledger rows for this reference inside its existing native write transaction and fails closed on foreign supplier ID, unexpected source transaction type, mismatched signed amounts or count, including missing required rows for a receipted purchase. Native deletion is additionally restricted by both original supplier ID and purchase-only transaction types. On ambiguity the native caller rolls back stock, balances, journal and invoice; no foreign/history deletion is allowed and no invented historical provenance is claimed. Targeted GREEN session `44294` verifies failure on ambiguous source, rollback preserving both supplier ledgers and original local invoice. Full pinned Rust `1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q`, session `59041`: **525 passed, 0 failed, 1 ignored**, exit0 (existing unused `STOCK_LOSS_JOURNAL` warning).

**Verification and custody:** Final TypeScript `tsc --noEmit --pretty false` exit0 and ESLint on all four edited TypeScript source/test files exit0, session `27539`. Final genuine QA connection used `mode=ro` and `PRAGMA query_only=ON`: **zero** purchases, purchase lines/returns, stock, sales, journals/entries and supplier transactions; integrity `ok`; foreign-key check 0 violations. Final HEAD `a9411cce`, existing **325** dirty/untracked paths preserved, **0 staged**, `git diff --check` exit0, migration SQL file count 51. Original protected seed **58,687,488 bytes**, SHA256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**, unchanged. Previous complete 001–051 migration SHA manifest verification remains valid; no migrations edited. `PHARMA_SECURITY_RELEASE_APPROVED` unset; original shipping seed preflight still deliberately **BLOCKED** for configured password hash. No new browser, native console window, GUI focus or background scheduled automation. No claim of full frontend coverage, installed signed Windows GUI flow, independent physical TPM acceptance, original seed remediation or historical journal acceptance. Commercial release stays **OPEN/BLOCKED**, with independent issuer, finance, backup/restore, dependencies and two-person operator/security certification still **PENDING**.

## 2026-10-13 background-only purchase reversal cash and historical journal custody

**TWO MORE REPRODUCIBLE CROSS-TENANT FINANCE DEFECTS FIXED; COMMERCIAL RELEASE REMAINS OPEN/BLOCKED.** Continued in background-only Core without touching the authenticated native QA window, pending QA invoice identity, production/original SQLite, bundled migrations, issuer credentials, or a live finance writer. Re-read `/skills/ponytail/SKILL.md`, `AGENTS.md` and prior gate first. Starting HEAD `a9411cce`, 325 existing dirty/untracked paths, 0 staged.

- **Real RED: cross-tenant cash ledger deletion by note.** The shared native `reverse_purchase_accounting` previously executed `DELETE FROM cash_movements WHERE category='purchases' AND notes=?` across all pharmacies. A new fully migrated, disposable SQLite test created a cash purchase for `fresh-pharmacy` and another owner's independent, valid foreign shift/cash movement with the *same* human-readable purchase note. RED session `31279`: reversing the local purchase returned success but silently erased the foreign movement (expected 1 surviving foreign row, found 0). This did not touch the real QA/original DB. **Fix:** match candidate cash movements inside the same native transaction, check original purchase pharmacy against both shift owner and movement user, require the expected `disbursement`/original amount and uniquely attributable source across modern/legacy note candidates, reject foreign/duplicate/unverifiable matches, and delete only the verified movement ID. No missing cash source is silently manufactured: cash reversals with missing source fail closed. Regression updated to require rollback preserving both cash rows and the original invoice; focused GREEN session `16448`. An ambiguous source is an operator reconciliation task, not permission to erase.
- **Real RED: cross-tenant historical purchase journal deletion by text description.** This threat concerns *old, unreceipted* pre-042 purchases, not immutable 042 native receipts: a first fixture with a modern receipted purchase correctly passed without a product change and was not counted as RED. The corrected fully migrated synthetic fixture inserted an actual legacy completed purchase and balanced old local journal, plus a distinct foreign owner's balanced journal with the identical human-readable description and no invented purchase provenance. RED session `54576`: local completed purchase reversal removed the foreign journal (surviving foreign journal count 0 rather than 1). **Fix:** for unreceipted historical journal deletion only, inspect each matching journal's authoritative pharmacy and creator's current pharmacy and refuse multiple candidate source journals; keep previously receipted journals immutable as before. Ambiguity aborts the whole transaction, including stock, payable, supplier ledger and journal deletions. Updated focused GREEN session `76863` verifies no foreign or local original journal/invoice disappears upon rejection. This does **not** authenticate origin for surviving unknown old journals.

**Final background validation:** full pinned native Rust1.77.2 offline `cargo test --locked --offline -q`, session `78712`, **527 passed, 0 failed, 1 ignored** (528 total), exit0; the known unused `STOCK_LOSS_JOURNAL` warning remains, and the ignored physical TPM acceptance is not performed. Full serial frontend `jest --ci --runInBand --silent --coverage --coverageReporters=text-summary`, session `74542`, **322 suites passed / 1 skipped; 2,668 tests passed / 3 skipped; 0 failed**, exit0, 309.643s. Instrumented **functions 75.39% (3,561/4,723), 1,162 still unexecuted; statements 79.56%, branches 69.65%, lines 82.35%**. These synthetic Jest cases do not prove authenticated installed GUI IPC posting. Real QA-only Python licensing fixture `unittest discover -s scripts/licensing`: **44/44 GREEN**, session `54837`. TypeScript `tsc --noEmit` and ESLint on purchase source/tests: exit0, session `79386`. Unchanged genuine commercial shipping-seed preflight **exit1/BLOCKED**, reporting configured user password hash; no bypass or secret read.

**Independent custody reverified:** all **51** SQL migrations preserved, SHA256 of LF-joined sorted `filename:UPPERCASE_SHA256` 001–049 manifest **`17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`**; 050 **`9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`**; 051 **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`**. Original protected seed still **58,687,488 bytes**, SHA256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**. Independent QA SQLite `mode=ro` plus `query_only=ON`: **zero** purchase/return, inventory, sale, journal/entries and supplier financial rows, `integrity_check=ok`, `foreign_key_check=0`. HEAD `a9411cce`, existing 325 dirty/untracked paths, **0 staged**, `git diff --check` exit0, **0 remaining cargo/rustc/Jest test processes**, release approval environment unset. No GUI focus, new native app, real QA purchase replay, signer, disk snapshot/rollback or signed installer action.

**Still explicitly NOT certified:** genuine installed/signed Windows native purchase→sale→return→inventory/cash/journal roundtrips (the earlier GUI purchase remains unconfirmed), production Ed25519 issuer/physical TPM2 and activation/revocation, independent original historical patient/COGS/cash/supplier/legacy journal and fractional-cent delivery provenance, authorized sanitized commercial seed, production dependency disposition, OS-quiesced destructive backup/rollback with authorized physical interruption proof, and two-person finance/operator/security release signoffs. No automated test or local fix substitutes for these. **Original project remains OPEN; commercial release BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` MUST REMAIN UNSET.**

## 2026-10-13 independent five-axis code review and fresh cross-module verification

**Requested verification-before-completion and code-review-and-quality; scoped source review, no commercial approval.** Explicitly re-read both selected skills, `/skills/ponytail/SKILL.md`, `AGENTS.md`, existing regressions and prior RED logs before assessing the purchase-creation nonce/no-native-write marker and the transactional supplier, cash and historical-journal reversal fixes. Traced real native direct callers (`save_purchase_invoice_critical`, `delete_purchase_invoice_critical`, consumed/full invoice edit and purchase-return related delete guards), receipt append/reversal and original cash writer, as well as React form/storage and renderer action callers. Read the test **intent first**; do not mistake green mocked React actions for actual installed native IPC success. Prior actual RED runs for all four earlier defects remain recorded above; **this review did not temporarily remove production guards to fabricate a new RED**.

- **Correctness / behavioral compatibility:** Added one explicit positive native Rust regression `ordinary_cash_purchase_delete_reverses_only_its_own_stock_cash_and_supplier_ledger` to demonstrate that *without* any ambiguous competing source, a real completed synthetic cash purchase is created, has one cash movement, and can be deleted with its invoice, supplier invoice/payment rows and linked stock/cash reversed atomically. Focused pinned Rust **1/1 GREEN**; final full pinned Rust1.77.2 `cargo test --locked --offline -q`, session `50553` (also equivalent retained session `65075`), **528 passed, 0 failed, 1 ignored, exit0** (529 total). Existing multi-tenant collision tests and normal purchase credit/check delete, POS consumed-stock cost, inventory, supplier, purchase-return and finance test callers are covered by this full command. The one ignored physical TPM test remains unexecuted.
- **Full frontend cross-module gate:** Fresh serial `jest --ci --runInBand --silent --coverage --coverageReporters=text-summary`, session `34112`: **322 suites passed / 1 skipped; 2,668 tests passed / 3 skipped; 0 failed, exit0**. Coverage: **75.39% functions (3,561/4,723), 1,162 unexecuted; statements 79.56%, branches 69.65%, lines 82.35%**. Covered modules include POS, customer/patient finance, supplier, purchase+sales returns, inventory/stock lots, shift and staff permissions, delivery, reports and purchase recovery; the coverage measurement is **not** proof of unexecuted functions or native GUI release journeys. TypeScript `tsc --noEmit --pretty false` **exit0**, ESLint on all affected action/form/test files **exit0**, session `6039`.
- **Fresh build gate:** Checked that `api_temp`, `actions_temp` and `middleware_temp.ts` were absent before the build. Then `npm run build:tauri`, session `53407`, **exit0**, Next 15.5.27 compiled and exported **70 pages / 2 static exports**, with actual output `Restoring middleware to src/middleware.ts`. Post-build exact path check confirmed original `src/middleware.ts` and `src/app/actions-client` present and all three temporary paths absent; `out/login.html` present. This builds only **unsigned frontend static assets**, not a signed installed native Windows executable.
- **Licensing / release safety:** Python issuer unittest discover initial **44 passed, 0 failed**; when a separate simultaneous workspace change introduced new `scripts/licensing/test_staging.py` and `deploy/staging` inputs, reran fresh discovery session `27055` with **49 passed, 0 failed, exit0**. The original protected commercial shipping seed preflight was freshly run, session `56139`: **exit1/BLOCKED** for an already configured user password hash; no bypass or seed editing, and release approval remains unset.
- **Five-axis review findings:** **Security/correctness:** prior fixes use parameterized owner-validated native SQLite transactions and refuse shared-reference foreign or unverifiable supplier/cash/journal deletions; fresh cross-module tests found no regression in the executed paths. **Architecture:** nonce/no-native-write proof stays in the create action and UI; supplier/cash/journal source checks stay in shared native reversal, preserving atomic rollback and avoiding renderer-authored tenant claims. **Readability:** shared `critical.rs` is already ~13k lines, and historic source resolution remains complex; avoid speculative decomposition while carrying protected dirty work. **Performance (optional):** legacy movement lookup by `category, notes` and old journal descriptions is bounded to a few reference candidates per *write transaction* but lacks a source-key index; benchmark realistic history before approving new index/migration work. **Historical ownership (required independent release certification):** legacy NULL/default-tenant entries, transfers of a movement creator to another pharmacy, or absent provenance can require manual reconciliation; matching current IDs/descriptions is not an externally attested original journal source. No new dependencies or broad renames were introduced in this review. Known prior `STOCK_LOSS_JOURNAL` unused test constant warning remains; no unrequested cleanup.

**Custody / concurrency qualification:** A fresh independent 001–049 SHA manifest equals **`17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`**, and migration 050 **`9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`** / 051 **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`** unchanged, all **51** SQL files present. Original protected seed stays **58,687,488 bytes**, SHA256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**. Isolated QA SQLite connected explicitly `mode=ro`, `query_only=ON`: zero purchase/return, stock, sale, supplier transaction and journal rows; `integrity_check=ok`, `foreign_key_check=0`. Authenticated QA native GUI was not driven, focused, replayed or modified, and no private issuer/TPM/OS restore actions were performed. Starting HEAD `a9411cce`, 325 dirty/untracked paths, **0 staged**; after concurrent staging/licensing edits including `.gitignore` the dirty count rose to **327**. The two additional entries are *not attributable to the scoped purchase review/build without a frozen baseline*; do not reset, clean, claim isolation or silently delete unrelated files. `git diff --check` exit0, temporary build paths absent. The native QA request no-commit is still unresolved. **Review of these prior edits is locally verified within tested paths; entire 325+ path worktree is not independently merge-approved. Commercial release remains OPEN/BLOCKED.**

## 2026-10-13 background-only continuation: supplier reversal, 043 patient returns, 051 collection and reconciliation

**Chronology and scope:** The previous 528 native Rust passing tests / one ignored, 2,668 frontend Jest passing tests, 49 Python licensing passing tests, `tsc`/affected ESLint passing and successful unsigned 70-page Tauri static frontend export were separate valid prior verifications. The lower 523/524/528 and 44/49 interim counts reflected tests added in successive runs, not contradictions. This continuation changes **only** native Rust `critical.rs`, `patient_payments_native.rs`, `financial_notices_native.rs` and this release record; frontend, licensing and static export sources are unchanged for this increment, so unchanged frontend/Python/build suites were not reflexively rerun. The already dirty worktree was not staged, reset, cleaned, rebased, or committed.

**Genuine RED-before defect A — orphaned legacy payable on purchase reversal:** In a disposable compatible in-memory SQLite, a completed credit purchase with an invoice total of 10, supplier balance 0 and *no* corresponding supplier ledger invoice entry could be deleted; the shared reversal would then decrement an otherwise zero supplier payable, creating negative/unsubstantiated supplier balance. Focused `legacy_credit_purchase_missing_supplier_source_does_not_create_negative_payable_on_delete`: **RED exit 101**, then **GREEN 1/1 exit 0**. Minimal production correction in `reverse_purchase_accounting` now always requires precisely one correctly typed, same-supplier, amount-matched invoice ledger source and, for cash, precisely one matching payment source; earlier legacy-empty bypass removed. Successful ordinary cash purchase reversal and pre-existing same-reference foreign supplier/return, foreign cash and journal collision tests remain included in full native suite. Additional synthetic `missing_cash_supplier_payment_blocks_purchase_stock_and_journal_reversal_atomically` checks failure preserves invoice, original stock, cash movement and journals after deliberately removing one ledger leg. This is intentional fail-closed historic finance behavior; undocumented historic entries must be independently reconciled, not invented.

**Genuine RED-before defect B — native sales return poisoned subsequent patient money:** The real 043 native `apply_return_accounting` created `patient_transactions(type='refund')` with an unrelated new UUID even though the actual approved patient-account return had an immutable 043 `native_sale_return_cogs_provenance` record. Both native `patient_payments_native::post` and customer `financial_notices_native::verify_patient` classified that transaction as ambiguous historical money, blocking authentic remaining credit collection/notice. Focused `native_receipted_patient_account_refund_allows_collecting_remaining_credit_debt` **RED exit 101** (patient balance provenance ambiguous). Source writer now assigns its refund-history `id` equal to the native return ID within the original writer transaction; both patient money writers call one shared parameterized provenance predicate. It accepts that mirror only with actual 043 receipt, exact original sale patient and pharmacy, same return tenant, verified method, matching receipt amount, matching immutable **actor ID**, and no competing payment/notice scope. Genuine 043 native return and 051 payment source receipts are not rewritten. The positive native payment test and customer-notice test are GREEN; unbound refund history, wrong method, mismatched amount or actor remain blocked.

**Genuine RED-before defect C — forged refund-history actor:** An additional adversarial variant changed only `patient_transactions.user_id` while preserving correct 043 return ID, patient and amount; the interim predicate wrongly accepted it, enabling a new money operation. `unlinked_or_mutated_refund_history_never_authorizes_patient_money` **RED exit 101**, then the shared predicate required `pt.user_id=p.actor_id`. The **final pinned all-native suite ran after** this correction and the synthetic fixture projection updates, confirming GREEN. No table, migration, fixture seed, 043 sealed receipt, original database or issuer key was altered.

**End-to-end in the trusted Rust transaction layer:** Added `compatibility_native_purchase_credit_sale_return_payment_conserves_sources` that creates an owner, patient, supplier and drug only in ephemeral in-memory SQLite, processes an actual completed native purchase stock receipt and 042 purchase source; then a real 043 credit POS checkout of 2 units, real 043 patient-account partial sale return of 1 unit and 50, and real 051 native cash collection of 25. Verifies remaining inventory quantity 1, refund mirror equals native return ID and value, 043 receipt exists, 051 journal receipt exists, patient payment row amount 25 and **zero unbalanced journals**. Focused **1/1 GREEN, exit0**. The fixture is **not a signed installed application or a full 001–051 migrator**: it uses the prior `current_fresh_schema()` compatibility-normalized 001–020 + 041–047 harness with additional 033/036/048–051 finance tables. Attempts to replay 001–051 SQL via the simple `raw_sql` harness failed from compatibility ordering and duplicate DDL: **test-fixture errors, not independently proven startup bugs**; the fixture was explicitly scoped back to its tested runtime boundary. Existing native actual-startup migration checks remain separate.

**Fresh final verification:** After all fixes and adversarial cases, pinned `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q`, session `71478`: **535 total, 534 passed, 0 failed, 1 ignored, exit0**. The ignored physical TPM test was not run. New non-test native `rustup run 1.77.2-x86_64-pc-windows-msvc cargo check --locked --offline -q`, session `24993`: **exit0**; existing unused import/dead-code warnings in unrelated `manual_journals_native.rs`, `create_return_tx`, `process_checkout_tx` and purchase-return helper wrappers were reported, not silently rewritten. No 001–051 migrations or new dependencies were added. Native safety review considered correctness (source equality and rollback), architecture (shared authorization gate), security (tenant/actor/mirror provenance and parameterized queries), readability (one existing owning module), and performance (bounded patient-specific scan; no new untested index). This is **not** full acceptance of the entire historical dirty worktree.

**Independent gaps remain:** The earlier original GUI purchase-with-no-commit is still unresolved and its original nonce must **not** be replayed; headless SQLite tests are **not** a signed installed Windows GUI/IPC end-to-end proof. Older pre-fix 043 return mirrors have unrelated random UUIDs without a reversible immutable link; **do not** backfill guessed links or treat historic patient balances as certified. Original debt, historic receivables/COGS/supplier/cash/journals and fractional-cent source lineage require independent reconciliation. The original commercial seed's existing credentialed user hash remains a shipping-blocking preflight finding. Real licensing issuer signature, physical TPM2 binding/revocation, signed installer, OS-quiesced restore/rollback/disaster-recovery drill, production dependency risk and two-person finance/operator/security signoff are external, not certified by tests. Release remains **OPEN/BLOCKED**; `PHARMA_SECURITY_RELEASE_APPROVED` must remain **unset**.

**Final background-only custody proof for this increment:** Independent check session `18658` exited 0: **51** migration SQL files; frozen 001–049 manifest SHA256 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`; 050 SHA256 `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`; 051 SHA256 `40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`; protected original seed **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. QA database was accessed strictly through SQLite URI `mode=ro`, with `query_only=ON`; purchase invoices/lines/returns, inventory, POS sales/lines, sales returns, patient and supplier transactions, daily journals and entries **all zero rows**, `PRAGMA integrity_check=ok`, `PRAGMA foreign_key_check=0`. HEAD `a9411cce`, **329 dirty/untracked paths** (includes existing dirty work plus two previously untracked native source files changed here), **0 staged**; `git diff --check` exit0, all Tauri frontend build-temporary paths absent, **1** existing QA native app still running untouched, **0** Cargo/rustc processes, and `PHARMA_SECURITY_RELEASE_APPROVED` unset. Fresh commercial seed check `node scripts/check-commercial-release-seed.js`, session `78092`, **exit1/BLOCKED** with explicit `Bundled seed contains a configured user password hash` finding. No claim is made that every unexecuted/frontend-only workflow, native installed GUI, independent historical finance, physical TPM/issuer or actual disaster recovery has passed.

## 2026-10-13 background-only 051 patient notice mirror reconciliation

**Actual test-first RED and bounded fix:** The read-only, owner-gated `NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE` checked 051 notice amount/scope/actor and journal lines but did not check the patient adjustment mirror referenced by `financial_notice_native_scope.patient_transaction_id`. A disposable in-memory valid notice/debit of 12.50, exact 051 receipt and balanced journal had no findings; after changing the associated patient adjustment to 25.00, reconciliation still returned zero source findings. New `native_051_customer_notice_reconciliation_catches_broken_patient_adjustment_mirror` failed **RED, exit101**, session `18085` (0 passed/1 failed; expected 1 conflict, received 0). Minimal correction adds a source-linked mirror join and checks signed amount, patient, actor, date and adjustment type; pharmacy-wide notice mirror pointers also report a contradiction. Focused test then **GREEN 1/1 exit0**, session `83444`, including altered amount and patient identity with a clean positive source. This improves independent forensic detection of corruption; the synthetic projection deliberately lacks the unchanged original 051 no-update triggers and does not imply the real native writer emitted such corruption.

**Real native money writers linked to the exact reconciler query:** Existing native `post_with_lock` customer-notice and `post` bank patient-payment tests now execute the identical 051 source/journal query against the records actually committed by those writers in disposable migrated SQLite, and require zero findings; existing 051 sealed-source, replay and journal-tamper denials remain. Focused pinned Rust `cargo test --locked --offline -q 051`: session `50081`, **4 passed, 0 failed, exit0**. Full pinned Rust1.77.2 `cargo test --locked --offline -q`: session `70058`, **535 passed / 0 failed / 1 ignored (536 total), exit0**; separate non-test `cargo check --locked --offline -q` **exit0** in same session, with previous unrelated unused-import/dead-code warnings. The broader old frontend Jest **2,668 passed / 3 skipped**, Python licensing **49 passed**, and unsigned frontend static export exit0 remain prior unchanged evidence, not freshly rerun here. No new dependencies, SQL migration edits or foreground app actions.

**Five-axis review and limits:** Correctness/security: 051 customer notice receivables mirror must match its source in the owner-only read-only report; production permission and posting transaction boundaries are unchanged. Architecture/readability: one additional existing-scope/PK lookup in the canonical reconciliation CTE; performance: no per-row application N+1 scan. This is not proof of the historic ledger's authenticity, fraud attribution or approval of the 329-path dirty tree; unknown old V1 links remain for human finance review.

**Custody:** Core session `99292` exit0 verified unchanged **51** migrations, frozen 001-049 manifest SHA256 `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, 050 `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`, 051 `40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`, and protected original seed size **58,687,488**/SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. QA opened solely with SQLite `mode=ro` and `query_only=ON`: eleven purchase/sale/stock/returns/patient/supplier/journal tables all zero rows, `integrity_check=ok`, foreign-key violations 0. HEAD `a9411cce`, **329** dirty/untracked, **0 staged**, diff-check exit0, existing QA `pharma.exe` process 1 undisturbed, Cargo/rustc 0, release approval flag unset. Commercial original seed guard session `55451` deliberately **exit1/BLOCKED** due configured password hash (wrapper exit0 solely to capture expected preflight output). No historical data, original seed, migrations, GUI nonce or signing keys changed.

**Commercial release OPEN/BLOCKED:** Previously observed authenticated GUI purchase no-commit remains unresolved without forbidden nonce replay. Independent signed installed Windows GUI acceptance, physical TPM2/Ed25519 issuer and revocation, historic patient/supplier/journal/COGS/fractional-cent review, authorized seed remediation, dependency disposition, OS-quiesced disaster recovery and two-person security/finance/operator signatures are missing. Native tests do not replace those. `PHARMA_SECURITY_RELEASE_APPROVED` must stay unset.

## 2026-10-13 background-only 048 cash purchase-return -> finance source audit linkage

**Actual 048 writer, not hand-inserted receipt:** Extended pre-existing `purchase_returns.rs::cash_purchase_return_records_receipt_cash_movement` using the canonical `financial_source_reconciliation_native::PURCHASE_RETURN_RECEIPT_FINANCIAL` query after an actual `run_purchase_return_transaction` commits a cash refund in isolated migration-compatible SQLite. The original native writer creates a completed credit purchase, removes returned stock, records the two supplier financial legs, the cash receipt with its return ID, an immutable 041/048 purchase-return receipt and balanced journal. The added assertion verifies **zero 048 receipt supplier/cash/journal reconciliation findings** from those genuine posted source records, before existing attempts to mutate sealed return/ledger/entry records are rejected. No posting source, 048/049 SQL or data was changed. This positive check proves only the bounded underlying Rust financial transaction, not an authenticated installed Tauri GUI journey or external signed finance certification.

**New test verification:** Focused pinned Rust `cargo test --locked --offline -q cash_purchase_return_records_receipt_cash_movement`, session `64264`: **1 passed, 0 failed, exit0**. After both the earlier 051 source-mirror correction and this 048 integration assertion, fresh final full pinned Rust1.77.2 `cargo test --locked --offline -q`, session `89431`: **535 passed / 0 failed / 1 ignored (536 total), exit0**. Separate **non-test** pinned `cargo check --locked --offline -q` in the same session: **exit0**, with the previously recorded unused `Row` import and four dead-code wrapper warnings. The 048 source-to-journal test strengthened an existing test, so the total test count did not rise. Owner reconciliation still does not cryptographically certify historical reference-based supplier/cash transactions; tests previously demonstrate ambiguous/missing supplier records and cross-pharmacy cash collisions must not be misclassified or deleted. No new dependencies, migrations, GUI activity or original-database writes.

**Five-axis scope:** Correctness includes returned quantity/price, supplier refund balance, cash receipt and ledger conservation; negative sealed-ledger mutation and duplicate/replayed requests continue to be tested. Security relies on native actor/tenant validation and 041/048 immutable source proofs already in the writer; this additional assertion neither bypasses the GUI session boundary nor creates permission shortcuts. Architecture/readability reuses the existing audit SQL directly instead of duplicating accounting math; performance adds one test-time query only. Entire dirty repository is still **not** merge or production approved. Current release remains **OPEN/BLOCKED** until real installed signed Windows acceptance, physical TPM/issuer, historical original-book certification, authorized seed remediation, OS recovery, dependency signoff and two-person security/finance/operator approval; leave `PHARMA_SECURITY_RELEASE_APPROVED` unset.


## 2026-10-14 background-only 051 patient cash movement integrity and foreign-shift provenance

**Reconciled live predecessor:** HEAD `a9411cce` with 349 dirty/untracked paths at start, staged 0, diff-check exit0, one undisturbed QA native app and zero Cargo/rustc processes. The source gate already recorded later 2026-10-13 051 notice mirror and 048 native purchase-return reconciliation increments missing from the compacted handoff. Their latest recorded baseline was pinned Rust **535 passed, 0 failed, 1 ignored**. Earlier unchanged frontend Jest **2,668 pass / 3 skipped**, Python licensing **49 pass**, static unsigned frontend export exit0 are historical evidence, not rerun during this Rust-only continuation.

**Actual first RED (cash amount substitutions):** In disposable `sqlite::memory:` with the existing native 033/036/051 receipt SQL, two actual authenticated-actor-function `patient_payments_native::post` cash collections of **20 and 30** generated 051-immutable payment/journal sources and two separate cash movements. The cash movements themselves are not immutably linked or sealed by 051. After changing both cash movement amounts to **25** (preserving actor/date/pharmacy/count/aggregate total 50), the previous `verify_scoped_patient_payments` grouped only by actor/date and incorrectly accepted a subsequent bank payment. Test `offsetting_cash_movement_edits_cannot_hide_behind_matching_daily_totals` recorded **RED exit101**, session `91005` (0 pass/1 fail; unexpected `Ok(...remaining_balance:25)`). Minimal shared fix groups matching signed payment/cash rows by actor, date **and cent-denomination** (with count equality), rather than only net sum. Focused **GREEN 1/1 exit0**, session `10386`; genuine restored 20/30 receipts authorize the new bank payment. No new migration, dependency, journal rewrite or historic backfill.

**Actual second RED (foreign shift redirection):** A genuine 051 cash payment of **20** and its correct local shift was followed by changing *only* the unsealed `cash_movements.shift_id` to an existing **foreign-pharmacy** shift. Amount, actor, date and `cash_movements.pharmacy_id` remained unchanged; a subsequent bank collection was wrongly accepted. Test `foreign_shift_redirect_on_native_patient_cash_blocks_further_collection` recorded **RED exit101**, session `97613` (0 pass/1 fail; unexpected `Ok(...remaining_balance:55)`). Shared `verify_scoped_patient_payments` now rejects any patient-payment cash movement lacking a matching `shifts` row with the **same stored pharmacy_id**. This checks current shift ownership but deliberately does not require a past shift to still be open. Restoring the actual local shift permits legitimate collection. It does not guess historical NULL branch ownership.

**Downstream fixture correction and verification:** The initial full native run after both source fixes was **528 passed / 9 failed / 1 ignored, exit101**, session `48085`: all nine failures were reduced `financial_notices_native` SQLite test projections with no `shifts` table, not proof of missing production tables. Added the minimal synthetic `shifts` relation and `shift_id` column/values to that test fixture only; preserved its existing source and tenant cases. Focused notice **15 passed / 0 failed**, session `97382`, exit0. Focused real patient-payment suite **21 passed / 0 failed**, session `65143`, exit0. Fresh final pinned `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q` **537 passed / 0 failed / 1 ignored (538 total), exit0**, session `63895`. Separate *non-test* pinned `cargo check --locked --offline -q`, same session **exit0** with previous unrelated unused `Row` and four dead-wrapper warnings. The two new tests raised the total by two; no frontend/licensing code was touched here.

**Five-axis review / coverage limit:** Correctness tests both real native positive postings and two actual rejected synthetic cash-corruption paths before allowing a further payment; errors roll back all new patient money, and the same verifier is called by 051 patient payment and customer notice. Security checks source actor/date/pharmacy/amount multiset plus cash movement-to-shift pharmacy, using parameterized SQL, with no new authentication bypass. Architecture/readability change only the canonical verifier and lean notice test fixture, no duplicate production policy or dependency. Performance uses one existing per-patient SQL grouping and bounded `EXISTS` on shift identity, not an N+1 round trip. This is a **forward posting admission guard**, not full immutable cash-to-payment UUID lineage: historic multi-movement cash cannot be cryptographically matched to individual shifts, and independent ledger/report certification is still mandatory. The original GUI purchase no-commit and ambiguous nonce remain unresolved and untouched.

**Custody, release and external blockers:** QA custody accessed only by SQLite URI `mode=ro` with `PRAGMA query_only=ON`, fresh session `46237`, exit0: eleven purchase/stock/POS/return/patient/supplier/journal tables had **zero rows**, `integrity_check=ok`, `foreign_key_check=0`. Original database and 51 protected SQL migration hashes matched the prior manifest on initial live reconciliation; no protected file or Tauri GUI was written or driven. Commercial seed preflight remains intentionally blocked on the configured password hash. Release **OPEN/BLOCKED**, `PHARMA_SECURITY_RELEASE_APPROVED` **unset**. Do not claim signed installed Windows GUI validation, real physical TPM2/production Ed25519 issuer issuance and revocation, independent historic receivable/supplier/COGS/lot/fractional-cent accounting certification, authorized seed remediation, production dependency-risk disposition, OS-quiesced recovery/rollback or two-person finance/security/operator signatures. Nor is the entire dirty tree reviewed/merge approved.


**2026-10-14 final read-only process and seed check:** Live follow-up session `90763` recorded HEAD `a9411cce`, **349** dirty/untracked, **0 staged**, `git diff --check` exit0, approval environment unset; original seed **58,687,488 bytes**, SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, **51** migrations with exact preserved 001-049 manifest `17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`, 050 `9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`, 051 `40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`. Fresh `node scripts/check-commercial-release-seed.js` returned **exit1/BLOCKED** (`Bundled seed contains a configured user password hash`); the outer read-only status wrapper exited0 only to capture this expected result. Unlike initial process custody, the *final* read-only process census `74572` showed **zero** `pharma.exe` instances and **one cargo.exe plus one rustc.exe** with pinned toolchain paths. This is an external/concurrent process-state change since the initial snapshot (one QA app / zero Cargo); no QA window was accessed, stopped, restarted or relaunched and no concurrent build process was killed or taken over. Do **not** claim the QA application remained running through this final snapshot. The previously unresolved authenticated GUI purchase and nonce cannot be silently retested; release stays OPEN/BLOCKED with approval unset.

## 2026-10-14 isolated Windows native GUI acceptance increment (synthetic only, still NOT commercial approval)

**Live custody and executable identity:** After the handoff, re-read `AGENTS.md` and the three required skills; HEAD `a9411cce`, dirty/untracked **353**, staged **0**, `git -c core.safecrlf=false diff --check` **exit0**, 53 registered migrations (including concurrent 052/053), `PHARMA_SECURITY_RELEASE_APPROVED` **unset**. Protected original `src-tauri/pharma_local.db` remains **58,687,488 bytes** and SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. The actual running `pharma.exe` PID 17184 and window title `Pharma DISPOSABLE QA B (SYNTHETIC ONLY)` resolve to the separate disposable `%TEMP%\pharma-qa-disposable-20261014b-isolated\target\debug\pharma.exe`, identifier `com.pharma.disposable.qa20261014b`. Original authenticated QA app, original database, original purchase nonce, signing keys, and protected SQL were not operated on. All finance activity below is isolated synthetic owner `admin`, pharmacy `local_default`. The disposable database was read with SQLite `mode=ro` and `PRAGMA query_only=ON`; prepayment `PRAGMA integrity_check=ok`, `foreign_key_check=0`.

**Prior fresh-baseline evidence from the resumed predecessor, not repeated by this increment:** True native pharmacy notice cash shift mismatch RED **exit101** session `94328`: debit EGP 12.50 journaled to cash but produced no shift `cash_movements`; native `financial_notices_native.rs` minimally corrected within the existing immediate transaction to require exactly one owned open shift and insert a matching same-actor/tenant cash movement. Focused finance notices **17/17**, focused patient payments **21/21**, latest pinned full Rust **545 passed, 0 failed, 1 ignored** (546 total, exit0, session `71750`), non-test cargo check exit0. Full frontend Jest **2,669 passed, 3 skipped** (exit0, session `94555`), prior TS/ESLint and Next.js static export exit0. These are predecessor command outputs and must not be misrepresented as freshly rerun after future source edits. Native backup fixtures previously **29 passed**, synthetic Python issuer **49 passed**; not production disaster recovery or issuer certification.

**Actual source-linked native GUI purchase/POS/return chain from predecessor:** Throwaway in-memory-only synthetic Ed25519 issuer, native signed test grant and restart succeeded; migration startup applied all **53** SQL files. Separate synthetic owner logged in after negative password attempt. A real GUI EGP **350 credit purchase** (`QA-REAL-NATIVE-20261014-01`) committed one 042 purchase source, supplier payable EGP 350 and lot 10 boxes at EGP 35 cost, 2027-12-31 expiry. EGP **92 cash POS** of 2 boxes, EGP **46 cash sales return** of 1 and EGP **92 patient-credit POS** of 2 generated source-linked 043 sale/return COGS entries and journals. Stock evolved **10→8→9→7**. An initial cash-return request failed with frontend `طريقة الاسترداد غير مدعومة`; it created zero rows, and selecting bank then cash allowed a later successful submission. First-failure cause remains **unproven/unfixed**. This is real unsigned dev Tauri GUI acceptance on throwaway data, not production signed-installed validation.

**One formerly pending GUI EGP 25 cash collection, now verified:** Before input, disposable B showed zero `patient_transactions`, `patient_payment_scope`, `native_patient_financial_journal_receipts` and `cash_movements`; patient debt was EGP 92. Set amount to **25**, retained default cash and native date, entered identifying disposable-only notes and clicked submit **exactly once**. GUI showed successful registration and the collection in its table. Read-only SQLite verified patient transaction `8dc5b300-e5b2-4aca-9bd0-5e2aa2c5c155` (`payment/cash/25`), 051 payment scope pharmacy `local_default`, unique request `e076c4fb-d5eb-4cda-a2a5-27822228c70a`, 051 financial journal receipt `source_kind=payment`, `amount_cents=2500`, journal `df476094-2c61-4285-8d17-ae477cc0e18a`, balancing journal debit **25** and credit **25**. Cash movement `3f6bbd4a-7572-4ef3-b794-575ae061fc81` is `receipt/accounts_receivable/25`, `source_type=patient_payment`, owned actor `admin`, shift `qa-open-shift`, pharmacy `local_default`. Native patient statement displayed **67** outstanding, matching 92−25; no ambiguous retry or duplicate submission.

**Actual patient-account return and post-refund 051 continuity:** In native GUI selected credit sale `bac16c1b-a7d4-4a15-8f8a-14ebf652341f`, returned **1 box/EGP 46** with `refund_method=patient_account` once. DB returned `returns.id=63bb278c-3d49-4605-a313-2e06f70934fd`; the refund mirror in `patient_transactions` uses **this exact return ID**, type `refund`, amount **46**, method `patient_account`, not an unrelated UUID. GUI returns registry displayed this exact real credit invoice and amount. Patient statement debt moved from 67 to **21**. A subsequent single native **EGP 5 bank patient collection** (`0ec120a0-6995-42f3-a31d-e03b5b4a9f55`) succeeded; the DB confirmed `payment/bank/5`, after the trusted 043 refund mirror. Native statement showed **16**. This validates the real GUI-to-native path but does not replace the complete forensic 051 reconciliation and signed installation requirement.

**Actual customer financial notices and current balance:** The same patient profile submitted one **credit EGP 3** notice (`6957e995-0025-484d-8028-1e8079c4cdce`, DB `credit/customer/3`) and one **debit EGP 4** notice (`2d960024-85cc-4fa8-84e8-478fb9dfd60b`, DB `debit/customer/4`). Patient statement independently displayed **13** after the credit notice, then **17** after debit. Native dashboard activity showed both notice IDs/types/amounts and the preceding payment/return activity. Full standalone 051 notice mirror canonical-query execution against this disposable database is still pending.

**Real inventory/shift/read-model checks:** Dashboard after the cash sale/return, credit sale/return and patient cash payment displayed inventory **8 boxes**, matching 10−2+1−2+1. Expected cash drawer was **EGP 171**, matching opening 100 + cash sale 92 − cash sales return 46 + patient cash collection 25; bank EGP 5, patient-account return and patient notices do not alter physical drawer cash. A separate stale-read symptom was observed: patient directory/profile card remained **92** after EGP 25 collection and **21** after subsequent patient payments/notices until leaving/re-entering the patient route, while the independently fetched patient statement showed the correct current balance. On navigation, directory reflected EGP 21 before later notices. Parent patient list loads its snapshot once; modal `onSuccess` currently refreshes after some operations but not all finance successes. Treat this as **investigation pending**, not fixed or a ledger imbalance. During return setup, arrow keys while the refund combobox was focused changed selected invoice to the prior cash invoice; the intended patient credit invoice was explicitly reselected before posting. Global key handling needs a genuine frontend RED test before correction. Neither is certified fixed.

**Scope remaining and fail-closed gate:** Supplier payment/statement and purchase returns, actual pharmacy-level notice-to-shift parity, close/handover, source-report canonical finance reconciliation, unauthorized and foreign-tenant GUI denials, isolated restore/recovery drill, signed-install physical TPM2 issuer/revocation testing, historical finance source certification, credential-bearing bundled seed authorized remediation, dependency risk disposition and independent two-person operator/finance/security approval are still **open**. The shipping seed guard previously correctly returned **exit1/BLOCKED**. Do **not** infer installed/signed acceptance or prod issuer/TPM approval from disposable unsigned development executables or throwaway keys. Commercial release **OPEN/BLOCKED** and `PHARMA_SECURITY_RELEASE_APPROVED` must remain unset.

### 2026-10-14 continuation: genuine frontend RED/GREEN and additional disposable GUI finance flows

**Pharmacy cash notice GUI defect, reproduced and corrected:** An actual owner-authenticated B native GUI attempt to post pharmacy `debit/12.50` failed, and read-only SQLite confirmed **no** pharmacy notice committed. The form passed `target_id:''`, while native `financial_notices_native.rs::validate` intentionally rejects any `Some(target_id)` for a pharmacy target. Added a test to `financial-notice-native.regression.ts`: real existing action sent `targetId:""` instead of expected `null`, **RED exit1**, 1 failed/4 passed. One-line action adapter correction in `actions-client/finance.ts` maps absent/empty target to null with `data.target_id || null`, leaving an explicit nonempty forged pharmacy target for native rejection; no native validation relaxation. Focused **GREEN 5/5 exit0**.

**Patient-directory stale balance, RED/GREEN:** In the B GUI, after genuine EGP 25 and EGP 5 patient collections the canonical statement showed the updated receivable, while patient directory cards retained old state until route remount. `PatientProfileModal.tsx::handleAddPayment` refreshed only its own profile; parent `PatientListClient` expects `onSuccess` to refresh the private patient listing. Added a real rendered modal test requiring **no callback before asynchronous financial commit** and **one after success**. Initial combined Jest **RED exit1**, 39 passed/1 failed, specifically callback count zero after committed success. Minimal modal correction calls `onSuccess()` only after `res.success`, preserving duplicate-post lock, original on-error behavior and profile reload. After fresh Tauri static rebuild and reload, the B GUI made **one EGP 1 bank collection** against EGP 17 receivable and patient directory immediately displayed **EGP 16 without leaving the route**. This is a synthetic native GUI positive read-model refresh, not issuer/installer certification.

**Sales return global arrow/navigation, RED/GREEN:** During the earlier legitimate 043 patient return preparation, native refund selector ArrowDown unexpectedly reselected a different cash invoice; the intended patient credit invoice was manually restored before posting. `SalesReturnClient.tsx` had a `window` ArrowDown listener that checked only `document.activeElement`. Added a two-invoice rendered regression with refund select as event target and BODY as activeElement (native focus mismatch): old code switched `patient_account` to `cash`, **RED exit1** (1 failed, 15 skipped in filtered run). Minimal additional guard rejects keydown originating at actual input/select/combobox/contenteditable target. Retains existing navigation for non-form events. Test then included in focused GREEN.

**Focused frontend verification and static build:** Post-change Jest for `patient-profile-refund-ui`, `sales-return-ui`, `financial-notice-native`: **3 suites/45 tests passed, 0 failed, exit0**. `tsc --noEmit --pretty false` **exit0**. Selected ESLint for seven touched source/test files **exit0**. An initial `npm run build:tauri` after the frontend fixes compiled JS but was correctly **RED exit1** on `react-hooks/refs` in pre-existing `inventory/page.tsx:79` (render read of `hasLoadedRef.current`), unrelated to the payments; the blocker was not suppressed. Narrow production-readiness correction added React `hasLoaded` state set at the same successful-load point, keeping the ref for effect/catch paths and using state during render. Fresh `npm run build:tauri` then **exit0**, Next.js **15.5.27**, **70** generated static pages; this is a frontend static export, not a signed Tauri installer.

**Actual post-rebuild pharmacy notice and shift parity:** Reloaded only disposable B GUI, re-entered finance notices; one `debit/12.50` pharmacy notice posted successfully as `0015751c-d74d-43af-9e67-62a4e9f4d0b5`. Read-only SQLite confirmed native 051 receipt `notice/1250 cents`, actor `admin`, pharmacy `local_default`, matching journal `5f08ad7f-6f96-49d7-abd0-ed3369603750` with debit cash-drawer account 1 / credit account 9, **EGP 12.50 each**. Same-transaction `cash_movements` row is `receipt/financial_notice/12.50` with `source_type='financial_notice'`, `target_name` exactly notice ID, shift `qa-open-shift`, same tenant. Native dashboard expected shift drawer increased from **EGP 171** to **EGP 183.50** (opening 100 + cash POS 92 - cash return 46 + patient cash 25 + notice 12.50). SQLite `integrity_check=ok`. Distinguish this bounded integrated acceptance from the still-missing direct immutable cash UUID link in 051 source auditing.

**Actual supplier finance and 048 credit purchase return:** The supplier GUI showed the genuine synthetic **EGP 350** outstanding. One attempted payment failed with `Native shared shift creation cannot run inside a renderer SQL transaction`; after the ambiguous UI key interaction, strict read-only checks found supplier balance still **350**, supplier transactions still only the invoice **350**, cash movements unchanged and no new journal. No repeated payment was sent. Source tracing shows `actions-client/purchases.ts::addSupplierPaymentAction` still uses generic renderer `dbTransaction` and `requireOpenShiftId`, while the hardened native release denies protected generic SQL; this is a **material production workflow blocker**, not a successful supplier-payment acceptance. Separately, the GUI supplier dropdown in the purchase-return screen displayed zero invoices despite original invoice presence, while exact invoice-number search correctly found the `QA-REAL-NATIVE-20261014-01` credit purchase and full lot. Through this exact search, submitted one **EGP 35 credit purchase return** of one box. GUI register showed return prefix `c7e27303`; SQLite return `c7e27303-171b-4be5-af13-67cacd868ada`, original invoice `b923e803-fc9e-49d2-be12-398fac05d1f3`, supplier `1001`, actor `admin`. Native 048 return provenance binds that return, amount **3500 cents**, tenant `local_default`, original invoice, supplier, journal `e06e8604-3387-4d85-b8fb-497e02421475`; one line provenance exists. The journal has payable debit **35** and inventory credit **35**; supplier balance **350→315**, physical inventory **8→7**. This positive does not certify missing supplier partial-payment path or the supplier dropdown query failure.

**Independent review findings still OPEN:** 051 notices and patient payments have immutable source-to-journal receipts but no exact immutable source-to-cash-movement UUID witness; owner read-only 051 reconciliation can miss a removed/repointed pharmacy notice cash event even though shift expected cash changes. A successor provenance/immutable cash guard with native RED/GREEN and a canonical reconciliation check remains needed. Supplier partial-payment still requires native actor/tenant-owned atomic settlement and source audit. Original QA nonce, seed, protected historical SQL, production keys and genuine TPM credentials stay untouched. Commercial **OPEN/BLOCKED**, approval flag **unset**; mandatory signed installed Windows, physical TPM2/production issuer, historical finance certification, bundled seed remediation, OS-quiesced DR, dependency disposition and independent dual finance/security/operator signoff remain absent.

**Owner's actual native read-only reconciliation:** In the running authenticated disposable B Windows GUI, `الإعدادات` -> `فحص مرجعيات السجل المالي فقط` called the registered `reconcile_financial_sources_native` rather than a mock or direct renderer SQL. The actual result displayed **12 scanned journals**, **0 findings**, **0 unverifiable legacy journals** and **0 recorded stock adjustments**; status message corresponds to `limited_no_findings`. The GUI itself correctly warns this is **not** historical financial certification. This exact exercise followed the 048 purchase return and 051 pharmacy cash notice, rather than preceding those records. Separately, read-only SQLite grouped every posted journal's debit/credit entries and showed matching amounts. This result cannot detect the independently identified absent exact 051 cash UUID witness or certify historical commercial books.

**Synthetic logical backup snapshot, not OS rollback certification:** Using an explicit `mode=ro` and `PRAGMA query_only=ON` source connection only to disposable B, took one consistent SQLite `backup()` into a fresh uniquely named file under the owned user `%TEMP%` (1,187,840 bytes). Opened that separate snapshot read-only; table row counts matched the live disposable for 12 selected invoice, return, patient, supplier, cash, notice, native source and journal tables (**all matching**), `PRAGMA integrity_check=ok`, `PRAGMA foreign_key_check=0`. The original protected 58,687,488-byte repository database SHA256 was freshly checked again and remained `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`. Source application continued running and was not replaced or restored; do not mislabel this a quiesced destructive recovery, full native restore, or production DR signoff.

## 2026-10-14 additional 054 supplier settlement and isolated C acceptance — commercial OPEN/BLOCKED

**Scope and custody:** Prior worker implementation introduced forward-only `054_native_supplier_partial_payment.sql`, new `commands/supplier_payments_native.rs`, typed Tauri `post_supplier_payment_native`, exact linked supplier receipt/ledger/journal/cash triggers, reconciliation classification `NATIVE_SUPPLIER_PAYMENT_FINANCIAL`, and frontend Tauri integration. Its intentionally narrow eligibility permits one genuinely 042/044 receipted credit purchase without returns or ambiguous/mixed/historical supplier transactions; it **rejects** checks, purchase-return history and multiple invoices rather than guessing settlement allocation. The predecessor worker reported genuine frontend RED (2 failed tests before adapter correction), focused frontend **77/77 GREEN**, pinned Rust **548 passed, 0 failed, 1 ignored**, `cargo check --locked --offline` exit0 and TypeScript exit0. Those full suites are **worker reports**, not claimed as independently rerun during this note. The additional previous broad Jest after 054 exited **1** with 2,672 tests passed/3 skipped and a middleware suite missing `src/middleware.ts` while a simultaneous Next static export temporarily moved it; isolated middleware **4/4 GREEN** after restoration. A clean sequential full Jest re-run is still required; concurrent failure must not be called a product assertion defect or full GREEN. The previous 054 static Tauri frontend export exited0.

**Independent native Windows GUI C money evidence:** Actual window title `Pharma DISPOSABLE QA C (SYNTHETIC ONLY)` resolves to the distinct `%TEMP%\pharma-qa-disposable-20261014c-isolated\target\debug\pharma.exe`; its app identifier `com.pharma.disposable.qa20261014c` and `%APPDATA%\com.pharma.disposable.qa20261014c\pharma_local.db` are wholly disposable, derived by SQLite backup from synthetic A, not original QA. A throwaway C Ed25519 verification key and signed synthetic test grant were tested via the native GUI: an expired earlier lease failed closed (`Offline lease has expired`); wrongly padded synthetic Base64 public-key representation failed closed; a new ephemeral in-memory-signed grant with correct URL-safe unpadded public key was accepted, C restarted, owner logged in, and all **54 migrations** applied. This **does not** certify production issuer, physical TPM, installer signing, renewal/revocation or installed hardened release.

**Exact settlement/source conservation:** In that C native GUI, against the single synthetic EGP **350** credit purchase `b923e803-fc9e-49d2-be12-398fac05d1f3` and supplier 1001, a genuine **EGP 40 cash** payment posted immutable 054 receipt `8b0dc744-35ab-4d6e-801c-ed938ce3ae17`, request `3688216b-fcd0-4a44-ae37-71c2e0b09c35`, journal `3a1f8532-273f-4ff5-a0a1-ae18b97f142b`, exact cash movement `3fecf725-8f36-47c1-aa2a-08232b43b97f`; payable **350→310**. That cash movement is an owned EGP40 `disbursement/accounts_payable`, `source_type=supplier_payment`, shift `qa-open-shift`, with `target_name` exactly the receipt ID; journal debits payable and credits drawer 40. A separate genuine **EGP 15 bank** payment posted receipt `5ea2facc-2902-4e2a-b7f6-482ce5bea822`, journal `c65ad501-dbc0-4a67-b3bb-54fcf8576771`, payable **310→295**, debit payable/credit bank-clearing 15, and **NULL** cash movement ID as required. Supplier statement displayed initial purchase and both settlements; supplier card displayed **295**. One actual overpayment attempt of EGP **300** against balance **295** did not create an additional receipt, ledger or journal and left balance 295. These outcomes were inspected from actual SQLite, not a toast alone.

**Fresh resumed read-only checkpoint:** HEAD `a9411cce`, **357** Git modified/untracked entries, **0** staged, `git -c core.safecrlf=false diff --check` exit0, original protected seed SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, **54** migration SQL files, approval flag **unset**. C independently reports supplier 1001 balance **295**, exactly two native 054 receipts (cash 4000 cents with exact linked cash UUID; bank 1500 cents with NULL cash UUID), one supplier cash movement 40, `PRAGMA integrity_check=ok` and zero foreign-key failures. C's live GUI handover preview confirms starting drawer 100 − supplier cash 40 = **expected 60**, counted cash 60 and selected transfer amount 20; read-only SQLite **still showed shift `qa-open-shift` OPEN, transfer_amount 0, no handover cash movement or new shift after a GUI submit click**. This is a **not-yet-successful/ambiguous handover attempt**, with no money posting and no claim of closed shift. A clean disposable-only pre-handover backup exists at `%TEMP%\pharma-qa-c-prehandover-bd9ujl_g.sqlite`, never restored over running C. Further GUI receiver-input/event validation and actual native acceptance remain necessary.

**Remaining blocking gates:** The 054 writer is proven only for its bounded synthetic source case; the supplier listing/statement and purchase-return picker still use generic sensitive renderer SQL in paths prohibited by `pharma_security_release`, and 051 finance still lacks a sealed exact patient-cash UUID witness. Independently signed installed strict-release GUI, real TPM2/device/production Ed25519 issuer and revocation/renewal, independent historical stock/COGS/cash/supplier/patient books, authorized credential-bearing bundled seed remediation (guard still blocks), OS-quiesced destructive restore/rollback, live npm/Rust dependency risk review, complete permissions/tenant denial and two-person operator/finance/security certification remain absent. **No original authenticated QA database/nonce, customer records, issuer private keys or hardware secrets were operated on. PHARMA_SECURITY_RELEASE_APPROVED remains unset; commercial release remains OPEN/BLOCKED.**

**Later same-day owner read-only 054 GUI audit and release preflights:** Navigated through disposable C's owner Settings → native `فحص مرجعيات السجل المالي فقط` **after** EGP40 cash and EGP15 bank settlements; the actual authenticated native UI returned **3 journals scanned, 0 findings, 0 unverifiable historical journals, 0 recorded 040 stock adjustments** and explicitly described `limited_no_findings` as *not* independent historical financial validation. The cash shift remained open after the failed handover; C still had the two 054 receipts and no handover cash movement. Fresh `python -m unittest discover -s scripts/licensing -p 'test_*.py' -v` **49 passed/0 failed, exit0**, across the synthetic issuer and release boundary suite, without production secrets. Fresh shipping seed guard **exit1/BLOCKED**, same configured password-hash reason. `npm audit --offline --omit=dev --audit-level=high --json` **exit0**, cached production metadata **0 listed advisories across 1,137 packages**; live registry results, Rust advisory review and independent dependency disposition remain absent. This native GUI/release evidence cannot lift the OPEN/BLOCKED commercial gate.

### Prospective 055 exact native patient-cash UUID provenance — worker RED/GREEN, integration pending

After reconciling the live 54-migration worktree, an independent native Rust/SQLx test reproduced the structural hole in immutable **051 patient cash** receipt→cash provenance: an otherwise valid source receipt did not have a `cash_movement_id` column. Initial focused `prospective_patient_cash_has_exact_unique_sealed_movement_uuid` **RED**, 1 test failed with `no such column: r.cash_movement_id` before implementation. A new forward-only **055** `055_patient_cash_movement_witness.sql` preserves all existing 001–054 migration bytes and **does not fabricate or backfill historical links**. It adds a nullable, unique FK from new patient 051 source receipt to its exact cash movement, with prospective insert guard requiring matching source patient, actor, tenant, posting date, exact cents and live same-tenant shift; bank/noncash receipt witness must be NULL. The native patient-money writer preserves and records its generated cash UUID in the same immediate financial transaction. Bound cash entries cannot subsequently be updated/deleted or have the shift identity reassigned; owner read-only audit distinguishes explicitly contradictory bound sources from historical NULL/unverifiable ones. Legacy NULL provenance stays a review/finance blocker, not inferred evidence of correctness. Earlier offsetting denomination and foreign-shift regression guards are retained.

The implementing worker reports focused native **patient payments 24/24 GREEN**, owner finance reconciliation **31/31 GREEN**, complete registered 001–055 synthetic migration startup test GREEN, native credit-purchase→sale→patient return→cash-payment crossflow GREEN, and pinned `cargo check --bin pharma` exit0 with five pre-existing unrelated warnings. `git diff --check` exited0. This subsection records **worker-observed** scope checks pending prime's final full integrated Rust suite; it is **not** a signed GUI upgrade test, does not retrofit original QA/customer data, and does **not** solve pharmacy-notice-specific exact cash UUID witness or historical receipts. Commercial remains **OPEN/BLOCKED**, approval flag unset.

### Hardened authenticated purchasing reads and separately reproduced handover numeric failure

**Strict release read boundary (worker RED→GREEN):** New `commands/purchasing_reads_native.rs` fixed, bounded, actor/role/tenant-authenticated native projections are now dispatched through `db_read_scoped` from the Tauri purchase action adapters. They cover supplier directory/report/statement, completed purchasing reports, source invoice detail/lines/prior returns, and purchase-return search, supplier picker, register and details. The prior renderer-built generic SQL against `suppliers`, `purchase_invoices` and `purchase_invoice_items` is not used by those desktop actions; browser-only fallback remains. The hardened native release generic SQL authorizer **was not weakened**; an actual synthetic SQLite authorizer DENY fixture passed. A two-tenant synthetic native test passed for foreign invoice/lot/return exclusion, supplier-source mismatch, inactive/denied actors, report-only roles and fully returned invoice exclusion. Frontend transport **RED three assertion failures** before the typed change; then reported **69/69 Jest GREEN** across four suites and additional targeted **23/23 GREEN**, TypeScript and scoped ESLint exit0, rustfmt check exit0. Exact-source supplier credit allocations beyond bounded 054 remain unproven. Global legacy supplier identity/contact has no tenant column and remains shared by design; a mixed-tenant/ambiguous balance is returned as `NULL` and the UI visibly marks it **unverified** and disables payment rather than misrepresenting a zero payable. Strict reads reject unowned `local_default` invoice/return history. Historical provenance and complete release-profile installed GUI still require independent certification.

**Actual C handover failure investigation (worker native RED→GREEN):** C's expected 60 (starting100, zero cash sales/refunds, supplier disbursement40) exactly exercises an SQLx numeric decoding defect: `handover_native.rs::checked_sum` requested a REAL `Option<f64>` but three SQLite `COALESCE(SUM(...),0)` expressions returned INTEGER **0** for empty sales/refund aggregates. New exact-shape synthetic native `synthetic_c_treasury_handover_60_counted_20_transferred_to_admin` was **RED 1/1**, `error occurred while decoding column 0: mismatched types; Rust Option<f64> REAL not compatible with SQL INTEGER`. The narrow correction wraps each sum expression in `CAST(... AS REAL)` with unchanged tenant, authentication, cash-conservation and transaction checks. Same native synthetic test **GREEN**: old closed with actual60, EGP20 treasury transfer, new shared shift opening cash40, no variance journal. Native handover tests **11/11**, native read tests **9/9**. Separately `actions-client/handover.ts` swallowed Tauri `Err(String)` business denials as generic Arabic; focused Jest **RED 1 failing/7 passing**, then **GREEN 8/8** after whitelisting safe business denial messages and continuing to hide arbitrary SQLite/internal error strings. The old C GUI return was generic, so the source trace is a reproduced root-cause candidate, **not proof it was uniquely responsible** for C's historic failed submission. C remains **open and unposted** until a separately rebuilt disposable native GUI retest and read-only SQLite witness. No blind money retry, original QA mutation, protected migration edits or approval.

### 2026-10-14 later definitive integration, 055 upgrade, actual GUI handover and restart — supersedes earlier provisional C handover status

**Integrated sequential GREEN after fixture correction:** Prime independently ran pinned Windows Rust `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q`: **555 total; 554 passed, zero failed, one ignored, exit0**. Initial post-055 broad Rust had **544 passed/10 failed/1 ignored**, all ten failures confined to `financial_notices_native` test SQLite fixture applying 051 without 055, despite the production verifier requiring the new column. Genuine focused RED **7 passed/10 failed**; corrected only synthetic seed to install 055 and revised two legacy cash expectations to fail closed as *unverifiable historic UUID*, not inferred ownership. Focused notices then **17/17 GREEN**, and final full Rust above **exit0**. `cargo check --locked --offline -q` **exit0** with five existing unused/dead-code warnings. Final `tsc --noEmit --pretty false` **exit0**, selected purchasing/handover/frontend test ESLint **exit0**. First *nonconcurrent* broad Jest had **323 suites pass, one fail, one skipped; 2681 tests pass, one fail, three skipped**; sole failure was an older purchase-return fixture mocking the old reports action and omitting `supplier_id`. Test-only native-picker contract correction (the native typed supplier filter itself was correct) yielded isolated GREEN. Second complete Jest, **sequential and without concurrent static middleware move**, **324 suites pass, one skipped; 2682 tests pass, three skipped, zero failures, exit0**. Finally `npm run build:tauri` **exit0**, Next 15.5.27, compiled/static-exported **70/70 pages**, restored `src/middleware.ts`; these do not constitute signed release install.

**Actual built disposable C 55 migration and genuine native handover GREEN:** Stopped **only** independently identified C synthetic process, preserved both C-only databases/backups and B, rebuilt unique C test binary with its original throwaway Ed25519 public key and test app identifier. Native startup migrated C from **54 to 55** (confirmed `_sqlx_migrations=55` and exact 055 receipt witness column), retaining supplier **295** and the two immutable 054 receipts unmodified. Signed synthetic owner login succeeded. Original `qa-open-shift` preview: starting **100** − exact 054 supplier cash disbursement **40** = expected **60**. In the **real Tauri Windows GUI** entered counted **60**, treasury transfer **20**, explicitly selected synthetic admin receiver, entered the synthetic password without disclosure, and submitted **once** after read-only preflight verified shift still open and only one original cash movement/two 054 receipts. Genuine SQLite response, not toast alone: original `qa-open-shift` **closed**, `actual_cash=60`, `transfer_amount=20`, `transfer_target='treasury'`, `receiver_id='admin'`, `treasury_retained_cash=20`, `ending_cash=40`, `cash_difference=0`; new exact shared shift **`c74f61ab-affb-4cb4-8b39-7fd8fc0eca0f`** **OPEN** with `starting_cash=40`. New cash entry **`4498c639-7012-435b-9eca-f9e610c1be67`**, type `disbursement`, category `handover`, `source_type='user_drawer'`, target `admin`, amount **20**, original shift and tenant `local_default`; `HANDOVER` audit request **`63f92230-3e8f-4dc9-9f4a-6c7dc598e58b`** binds old→new shift, receiver, 60→20 and zero variance, plus `START_SHIFT` audit. No unexpected fourth GL journal for internal treasury transfer: purchase + two supplier payment journals remain three; 054 cash receipt exact UUID retained, bank receipt still NULL cash movement and supplier still **295**. SQLite `integrity_check=ok`, zero FK violations. Actual GUI shift report showed old closed with counted60/transfer20/zero variance and new open with 40. Subsequent C owner `reconcile_financial_sources_native` GUI audit: **3 journals, zero findings, zero unverifiable legacy journals**, status limited_no_findings; it is not independent books certification.

**Logical recovery and restarted license expiry/renewal evidence:** Independently preserved a C-only, post-handover **read-only-source SQLite `backup()`** at `%TEMP%\pharma-qa-c-posthandover-20261014-readonly-snapshot.sqlite`, SHA256 `752d4f96fecafe385d9f1df46ea323d6986ad26dda7da6cbbfff6e9043da97b8`, `integrity_check=ok`, two shifts with EGP40 new float and two 054 receipts. Following restart C's original test lease had expired; real native GUI failed closed with `Offline lease has expired; reconnect and renew` while read-only C SQLite still showed 55 migrations, closed old shift, open new float40, supplier295 and integrity/FK clean. A **new disposable-only** Ed25519 keypair was generated in memory (private key **never persisted**), signed serial **2** for unchanged synthetic license and fingerprint with a fresh two-hour lease, and embedded only the new throwaway public key in a recompiled distinct C debug binary. Startup correctly rejected the old public-key/signature mismatch, actual GUI imported the new signed grant and showed successful verification requiring restart. Following actual native restart, synthetic owner login succeeded and dashboard independently showed **EGP40 opening and expected cash**, with `HANDOVER` and `START_SHIFT` original receipt IDs preserved in native activity. This tests synthetic expiry and renewal/restart persistence only; production issuer, physical TPM, hardware identity attestation, production signed release and OS-quiesced destructive DR remain uncertified.

**Fresh original custody and unresolved release risks:** HEAD `a9411cce`, zero staged changes, original protected `src-tauri/pharma_local.db` SHA256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`** (58,687,488 bytes). Protected 001–049 aggregate hash **`17d4f110e15b380cfa24838f9f4830dc800957ccb28a54ec1b08653178081e2c`**, migration050 **`9bfef30ed72395d9bb7b4e97b61b0ca6505d4b2c478460b76690635d3cab8ba3`**, 051 **`40c5549974fc3e09e184b5a06f88b098f5ce1e01b468e76dae83102fbb771cee`**, 052 **`85d88d788ca19ffa1d040d2cc67fa48c257dcb8e8148a0cbe5fbe245cdff8fd7`**, 053 **`eed91006266e73398d37348fa677daead98cd346334c4fcfd24a132ddf273226`**, 054 **`4684ea6dd4788727e52f750000da2e105d4e44c1f6a5f53d325ba54dbcdceebf`**, new forward-only 055 **`0b53fb61649eb23143e50d3b837f7b28508b64a38514d00f69f33e41c89a849c`**. Strict 054 settlement remains one verified invoice/no return and supplier source history case, not commercial mixed-invoice settlement. User-authorized shipping seed remediation, independent historical accounting, OS-quiesced destructive rollback, certified installed signed Windows GUI and physical TPM2/production issuer, live dependency/Cargo advisories and two-person approvals are absent. `node scripts/check-commercial-release-seed.js` still **exit1/BLOCKED**, offline npm advisory metadata zero across **1,137** dependencies but `cargo-audit`/`cargo-deny` unavailable and live risk disposition absent. Do not infer commercial approval from synthetic/reports. **PHARMA_SECURITY_RELEASE_APPROVED stays unset; release gate OPEN/BLOCKED.**

**Five-axis post-GREEN review still exposes independently verifiable security gaps and no release signoff:** Native strict purchasing read projections enforce actor/session/tenant and reject `local_default`, but global `suppliers` directory lacking pharmacy identity can leak foreign-only supplier contact and raw balance; earlier native `purchases.invoices_list`/`drafts_list`/`invoice_get` retain legacy NULL-owner alias; browser SQL fallback is unscoped for suppliers. Owner reconciliation after genuine C has no findings *within its current checks*, not proof all provenance is witnessed. Separate isolated native SQLite reproductions of a 051 **pharmacy notice** cash movement amount change and a **054 supplier current balance** change both passed unnoticed by their former owner audit, without writing to C/customer databases. Prospective notice UUID audit and supplier balance discrepancy corrections are being worked as new RED→GREEN increments; historical NULL notice cash identity is not to be backfilled by inference. These audit/privacy gaps are material **HIGH release blockers**, not proof of an exploitable installed hardened-release write bypass. **Commercial stays OPEN/BLOCKED** pending those fixes, signed release/TPM/issuer/historical data/seed/DR/dependency certifications and independent approvals.

### 2026-10-14 live dependency risk discovery, not approved or automatically fixed

After earlier offline cached npm zero, a **real online** `npm audit --omit=dev --audit-level=high --json --fetch-retries=0 --fetch-timeout=12000` succeeded, querying npm public registry metadata for **1,137** dependencies. Unlike cached offline data, it reports **0 critical / 0 high / 13 moderate / 2 low, 15 total vulnerable package nodes**. Included direct `@sentry/nextjs@10.52.0` (moderate via Sentry/OpenTelemetry) and `csv-parse@6.2.1` (moderate; prototype-replacement via columns; fixed major `7.0.3` with compatibility regression necessary), transitive baggage memory allocation/telemetry DB username disclosure in OpenTelemetry, low `@babel/core` source map read and Windows esbuild dev-server issue. The range `@sentry/nextjs ^10.50.0` permits available patched `10.54.0` without major version change, but no production dependency update or risk signoff was asserted solely from the advisory query. Original package manifest and lockfile must not be casually changed without tested compatibility.

As `cargo-audit` and `cargo-deny` are not installed, additionally performed live **OSV querybatch** against **all 579 registry `Cargo.lock` package/version pairs**, split into six full successful batches with **zero request/cardinality failures**. OSV returned **24 package–advisory matches** (some duplicate GHSA/RUSTSEC aliases, some unmaintained notices, some platform-specific or potentially unused builds), **none withdrawn** according to successful detail lookups. Security-relevant records include `quinn-proto@0.11.14` **HIGH** remote memory-exhaustion advisory **GHSA-4w2j-m93h-cj5j / RUSTSEC-2026-0185** and other QUIC peer-controlled panics/buffer warnings, `rustls@0.23.43` TLS 1.3 handshake acceptance (**GHSA-2mjx-qc3c-rqvc / RUSTSEC-2026-0285**, moderate), `time@0.3.41` stack-exhaustion DoS, `quick-xml@0.38.4` duplicate-attribute CPU/namespace DoS, `h2@0.4.14` unbounded empty DATA frames, `rsa@0.9.10` timing side-channel and other `glib`, `rkyv`, `serde_with`, unmaintained `unic-*` and `proc-macro-error` advisories. Query evidence lives in disposable local `%TEMP%\pharma-rust-osv-audit-20261014.json` and detailed `%TEMP%\pharma-rust-osv-details-20261014.json`, and npm JSON under `%TEMP%`; no customer identifiers or credentials were sent. The scan **does not establish that every matched crate is linked/reachable on the Windows release target**, nor classify each exploitability, provide an audited patch, or replace an independent RustSec/cargo-audit and pinned-toolchain compatibility review. At least one HIGH remote DoS advisory warrants explicit release-team disposition. **Dependency risk gate remains OPEN/BLOCKED; no commercial approval.**

**Windows target-qualified dependency refinement (not independent disposition):** Executed pinned offline `cargo tree --locked --offline --target x86_64-pc-windows-msvc -i PACKAGE --depth 4`. The matched **HIGH `quinn-proto@0.11.14`** returned *nothing to print* for the Windows MSVC graph, as did Linux GTK `glib@0.18.5`; do **not** misstate the QUIC HIGH report as a proven Windows-linked executable flaw. OSV identifies the cumulative `quinn-proto` fix as **at least `0.11.18`** for the later October 2026 RustSec advisories (`0338`–`0342`), not merely the earlier `0.11.15` DoS fix. Conversely **`rustls@0.23.43` is Windows-linked** through pinned `reqwest@0.13.3` and Tauri updater; **`h2@0.4.14` is Windows-linked** through `hyper`/`reqwest`; **`time@0.3.41` is Windows-linked** through Tauri, SQLx and cookie. Their advisory exposure still needs real protocol/input reachability, patched version + Rust1.77.2 MSRV/build validation and operator signoff. This refines risk priority but does not lift the release gate.

### 2026-10-14 forward-only 056 notice cash source and further tenant/cash audit RED→GREEN

**Prospective 056 actual RED→GREEN, no historical inference:** A synthetic *native* EGP12.50 pharmacy cash debit notice with valid 051 receipt and balanced journal was followed by an `UPDATE` changing its shift `cash_movements.amount` to **99** after closing the shift. Before 056 the update succeeded and original owner audit returned **zero findings**, a genuine missing identity witness (not a fixture fault or proven signed-release write exploit). `prospective_notice_cash_movement_is_sealed_after_shift_closure` was **RED 1 failed/0 passed, exit101**. Added **forward-only** `056_financial_notice_cash_witness.sql`, new `native_financial_notice_cash_witnesses` (unique exact notice ID, journal UUID, cash movement UUID, shift, tenant, actor, amount cents), insert-time source→051 receipt→journal→cash→same-tenant open-shift validations, immutable witness/cash/update/delete/duplicate-append and shift identity guards. The native notice writer now inserts this witness **inside the same financial transaction**, retaining patient/notice source/JEs and shift cash atomic rollback on failure. `055` explicitly prohibits placing a notice cash UUID in its payment-only witness; the new table is separate rather than rewriting protected 055. Tests cover debit+credit sources, noncash customer notices, no extra unrelated movement, transactional witness failure rollback, post-close tamper denial. Native focus **GREEN 20/20** financial notices, post-close exact witness GREEN **1/1**. Registered all **56** migrations in native startup and synthetic migration-count fixtures; original 001–055 bytes preserved. Legacy pre056 pharmacy notice cash entries remain **unverifiable** (never auto-backfilled by matching amount/date), not silently called valid.

**Owner 056 audit exact source and 054 balance:** Added read-only owner 056 classification with exact witness/journal/shift cash contradiction detection and a separate *unverifiable historic* classification for older notice sources lacking exact cash UUID. Focused owner query **GREEN 1/1** after testing historic NULL, genuine witness and explicit cash conflict. Independently reproduced 054 source audit error on synthetic genuine 054 settlement: one receipted EGP20 partial payment reduced payable **100→80**, then supplier current global balance was altered to **500** while its immutable 054 receipt and journal remained consistent; former owner query returned **zero** findings. Focused `owner_flags_tampered_latest_054_supplier_balance` **RED exit101, 1 failed**, with expected one conflict and actually zero; narrow read-only audit SQL now compares current `suppliers.balance` with the minimum (latest, strictly decreasing) immutable 054 `balance_after_cents` **only** for a provable supplier history with exactly one purchase invoice, no returns and exact original invoice-plus-054 ledger coverage. It reports an explicit source disagreement on forged current balance without inventing attribution for mixed/historic/global supplier accounts. Same 054 audit focus **GREEN 1/1**. Final scoped worker validation: owner reconciliation **33/33 GREEN**, native supplier payments **3/3 GREEN**, 001–056 synthetic startup **1/1 GREEN**. No historical supplier backfill or destructive QA DB mutation.

**Additional native purchasing privacy RED→GREEN:** Five-axis source review identified `suppliers_list` exposing **global foreign-only** supplier contact/identity and raw global supplier balance, while older `purchases.invoices_list`, `drafts_list` and `invoice_get` still equated `NULL` invoice tenant with the default-local alias. New real synthetic two-tenant native SQLx tests were **RED** independently on all three relevant read paths (4 supplier rows instead of two owned; leaked ambiguous default invoice and draft). Fixed `purchasing_reads_native.rs` directory to require `EXISTS` purchase invoice explicitly belonging to the authenticated actor's pharmacy, project **NULL instead of unaudited global balance**, and only count explicitly attributed source rows. Existing native scoped invoice/draft/get reads now fail closed for `local_default` and require exact persisted invoice pharmacy equality, retaining pagination, permissions and source filters; no generic release SQL authorizer relaxation. Three native focused test commands **GREEN exit0, 1/1 each** with A/B tenant, inactive/denied actors, supplier-only role, foreign-only/NULL-owned vendor, legacy owner and explicit local_default staff. `rustfmt --check` and scoped `git diff --check` exit0. Important residual **workflow/design blockers**: global `suppliers` still has no tenant creation witness, so newly created/orphan suppliers may be hidden before their first attributable invoice; global vendor contact may be shared by multiple tenant invoices; all uncertified historical balances are NULL and GUI payment disabled; browser fallback uses global supplier SQL with renderer-controlled session and cannot be asserted safe for web multi-tenant deployment. Proper authorized prospective supplier ownership/finance lineage schema, web trust boundary remediation and release signoff are still required. This is a privacy fail-closed hardening, **not** complete commercial supplier finance.

**Integrated independent native result after both hardenings:** Prime reran `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q` on Windows with **560 registered tests: 559 passed, 0 failed, 1 ignored, exit0**. `cargo check --locked --offline -q` **exit0** with the same five previously reported unused/dead-code warnings. This is the authoritative post056 native broad result; old worker-only subset counts and the earlier 554 pass suite are superseded, not erased. New full frontend Jest/static export and actual disposable 056 GUI source acceptance are still pending at the time of this append. **Commercial release OPEN/BLOCKED; PHARMA_SECURITY_RELEASE_APPROVED unset.**

### 2026-10-14 final resumed post-056 full frontend and actual Windows GUI acceptance — commercial OPEN/BLOCKED

**All independently verified sequential code-quality gates:** After 056 and purchasing-read hardening, the prior full Rust **559 passed/zero failed/one ignored** and pinned `cargo check --locked --offline -q` **exit0** stand. The previously running *nonconcurrent* broad Jest was polled to completion: **324 suites passed, one skipped; 2,682 tests passed, three skipped, zero failed, `POST_056_BROAD_JEST_EXIT=0`**. Fresh `tsc --noEmit --pretty false` **exit0**. Scoped ESLint against finance/purchasing action adapters, native supplier UI, handover, native supplier test and purchase-return UI **exit0**. Only after Jest finished, `npm run build:tauri` compiled, linted and static-exported **70/70 pages**, restored `src/middleware.ts`, and returned **`POST_056_STATIC_TAURI_BUILD_EXIT=0`**. No simultaneous Next build/Jest race or inference of signed installer acceptance.

**Real isolated C schema upgrade, license/shift custody:** Stopped only the independently identified process with exact executable `%TEMP%\pharma-qa-disposable-20261014c-isolated\target\debug\pharma.exe`; B stayed alive. Existing disposable synthetic serial-2 signed lease had over one hour remaining, so reused only its ephemeral test **public** key to rebuild the distinct C **debug** Tauri binary with full new 056 source; no new issuer signing or hardware keys involved. Actual native startup successfully migrated disposable C **55→56**. Read-only C DB reported `_sqlx_migrations=56`, empty 056 witness table before posting, intact original 054 payable **EGP295**, old `qa-open-shift` closed and new `c74f61ab-affb-4cb4-8b39-7fd8fc0eca0f` open at **EGP40**, with `integrity_check=ok`, zero FK errors. Reauthenticated as synthetic owner through real C Windows UI, without displaying test password or changing the original authenticated QA window/database.

**056 real GUI pharmacy financial notice — frontend validation failure contained, then genuine GREEN:** In owner-authenticated C `الإدارة المالية والحسابات` → `الإشعارات والتسويات`, selected *pharmacy-level* and **debit EGP12.50**, date **2026-10-14**, synthetic notes, and cash-adjustment reason. Initial GUI submit attempts stayed on form, and independent read-only SQLite consistently showed **zero financial notices, zero 056 witnesses, unchanged three journals/two cash movements**; do not claim partial posting. Actual isolated C WebView DevTools (opened through native F12, **read-only DOM/console inspection**, no credential output) identified frontend Zod `reason` **too_small** validation from a blank reason in those attempted actions. After actual native select keyboard selection changed the reason to `تسوية عجز / زيادة نقدية` (read-only DOM confirmed date, amount and selected reason), **one subsequent GUI submit succeeded**; UI showed EGP12.50 debit pharmacy notice in register. The initial control-state mismatch was not proven as a product defect independently of automation and was not silently attributed to 056 or “fixed” by weakening validation.

**Exact immutable source/journal/cash witness from *actual C* SQLite:** Genuine notice **`8b378018-4fd4-4749-b165-63ef24d670b7`**, `target_type=pharmacy`, `type=debit`, actor `admin`, tenant `local_default`, **12.50**, date `2026-10-14`; native 051 `notice` receipt **1250 cents**, journal **`8e33cd8d-d8a9-48d1-bd19-aab9274edae8`**. New 056 witness binds that *same* notice ID and journal to *exact* cash movement **`9359a26b-1e7a-400e-a79e-93299cb5d515`**, **same new shared shift `c74f61ab-affb-4cb4-8b39-7fd8fc0eca0f`**, owner/tenant and **1250 cents**. Cash entry is one `receipt/financial_notice`, `source_type='financial_notice'`, `target_name` exact notice ID, EGP12.50; its journal has debit **cash drawer account1 / EGP12.50** and credit **adjustment account9 / EGP12.50**. Original supplier payments remain one cash40 and one bank15, supplier payable remains **295**; handover disbursement20 is unchanged. Journal count advanced only **3→4**. Actual C dashboard expected drawer advanced **EGP40→EGP52.50**. Genuine owner registered `reconcile_financial_sources_native` GUI command afterward scanned **four** journals, **zero findings, zero unverifiable legacy journals**, native status limited_no_findings; structural only, not independent historic finance certification. SQLite `integrity_check=ok`, zero FK violations.

**Process-restart persistence:** Stopped/restarted only independently identified disposable C executable after genuine notice; B still alive. Original serial-2 synthetic test lease continued to validate. After synthetic owner login, real restarted GUI again displayed the new shift **EGP40 opening / EGP52.50 expected drawer**. Separate read-only SQLite after restart showed exactly **one** 056 witness and **one** financial notice, `integrity_check=ok`, no evidence of a duplicated posting. Unrelated original QA app, ambiguous purchasing nonce, shipping seed and Ed25519 issuer/TPM credentials were not touched. The separate test-only logical post-handover backup remains preserved and was never restored over C. An additional cloned SQLite mutation/immutability drill was not completed here; rely on independently tested native 056 red→green tamper suite for that specific negative claim, not a fabricated GUI negative.

**Final custody and blocked release:** Worktree HEAD **`a9411cce`**, **365** dirty/untracked paths including other concurrent work, **zero staged**, `git -c core.safecrlf=false diff --check` **exit0**, **56** migration SQL files. Original immutable QA bundled DB still **58,687,488 bytes**, SHA256 **`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`**. New forward-only 056 SQL SHA256 **`eb885af5ccd26ab50afe7cb6a44348cc32f47a9b0de78c5f4f2d16f1fcfa7de0`**; protected earlier 001–055 checked previously as above, no destructive revisions. `PHARMA_SECURITY_RELEASE_APPROVED` remains **unset**. All green tests and unsigned synthetic C GUI runs are *not* a release decision. Independent signed installed Windows `pharma_security_release` full GUI acceptance, production Ed25519/physical TPM2 activation/renewal/revocation, authorized seed password-hash remediation (preflight still BLOCKED), historical stock/COGS/patient/supplier/cash/journal certification, OS-quiesced destructive restore drills, vetted npm/Rust dependency upgrades and signed independent two-person security/finance/operator approvals remain absent. Additionally new fail-closed purchasing directory hides unowned first-invoice suppliers and uncertified balances, and browser multi-tenant supplier fallback is not proven safe. Latest online npm **13 moderate/2 low** and Rust OSV **24 package/advisory matches** (with Windows linked rustls/h2/time, quinn-proto not Windows-linked by target tree) still require triage, patches and cross-platform/MSRV testing. **COMMERCIAL SECURITY/LICENSING RELEASE GATE = OPEN/BLOCKED; NO PRODUCTION APPROVAL.**


### 2026-10-14 post-057 source custody, frontend reliability and release boundary - OPEN/BLOCKED

**Custody before work:** Independently confirmed live HEAD a9411cce, original protected `src-tauri/pharma_local.db` 58,687,488 bytes with SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, and original 054/055/056 SQL migration SHA256 `4684ea6dd4788727e52f750000da2e105d4e44c1f6a5f53d325ba54dbcdceebf`, `0b53fb61649eb23143e50d3b837f7b28508b64a38514d00f69f33e41c89a849c`, `eb885af5ccd26ab50afe7cb6a44348cc32f47a9b0de78c5f4f2d16f1fcfa7de0`. Zero staged paths, no git reset/clean/stash/checkout/rebase. Protected original purchasing nonce and customer/QA money untouched.

**New 054 supplier cash shift-identity RED before correction:** Read-only SQLite backup from independently identified disposable C (still at migration 056) into only an in-memory database verified one genuine native 054 EGP40 supplier cash receipt on closed `qa-open-shift` plus one bank EGP15 receipt. On clone ONLY, `UPDATE shifts SET pharmacy_id='foreign_test_tenant' WHERE id='qa-open-shift'` succeeded despite immutable 054 receipt still claiming local_default. SQLite integrity_check remained ok; thus immutable cash UUID alone did not seal the referenced shift's tenant. An authentic native SQLx synthetic regression `receipted_supplier_cash_seals_shift_identity_after_closure` was added before product fix; focused Rust RED exit 101: 0 passed, 1 failed at exact cross-tenant shift UPDATE. No source DB mutated.

**Forward-only correction:** New immutable `057_supplier_cash_shift_identity_guard.sql` adds narrowly scoped no-rescope/no-delete triggers for shifts joined through an exact 054 receipt's cash UUID; it preserves allowed normal status closure, bank-only handling, original 054 cash/source/journal values, and existing protected migrations. Registered 057 in main.rs and updated full startup fixture expectations in schema.rs, returns_scoped.rs, shifts_native.rs, and supplier_payments_native fixture. 057 SQL SHA256 `8656397a4c2f956e031c5e8c7cd85412f95715c02f4c81a903609b866c0d5608`. Focused native GREEN 1/1 exit0. Applying 057 to a fresh in-memory logical copy of genuine C (not its running DB) rejected cross-tenant shift update, shift-ID substitution and deletion 3/3; C's two supplier receipts, one 056 notice witness and structural SQLite integrity remained intact. A separate C-derived 056 snapshot denied financial notice cash/witness/shift mutation after closure. Running C was not upgraded or resubmitted and remains at 56 migrations; actual installed signed 057 acceptance is NOT claimed.

**Post-057 Rust/quality:** First broad native Rust attempt reported 552 passed/8 failed/1 ignored, exit101, all eight because synthetic full-chain tests still asserted hard-coded migration count 56. Corrected these test-only assertions to 57 without loosening financial guards. Full rerun pinned `rustup run 1.77.2-x86_64-pc-windows-msvc cargo test --locked --offline -q`: 561 registered, **560 passed, 0 failed, 1 ignored, exit0**. Pinned `cargo check --locked --offline -q` exit0 with existing dead-code/unused warnings; TypeScript and changed supplier scoped ESLint both exit0. Post-UI-change `npm run build:tauri` compiled and generated **70/70 static pages, exit0**; `src/middleware.ts` restored after export.

**Native supplier UI source-boundary RED/GREEN:** Native purchasing supplier directory intentionally returns NULL for unaudited global balances, but SuppliersManagementClient previously hid all payment controls when balance NULL, including suppliers whose genuine 054 native writer can verify. Rendered test `supplier-unknown-balance-native.regression.tsx` RED exit1 (missing payment button). UI now permits entering an explicit manual amount on native Tauri only while labelling unknown debt as unverified; never fabricates zero global payable or a remaining-balance preview. Real native `post_supplier_payment_native` still owns actor, tenant, receipt source, exact-cent overpayment, nonce and rollback enforcement, and rejects unverifiable money. Browser/null fallback remains denied. A further rendered RED 1/10 in `coverage-gap-suppliers-ui.regression.tsx` proved the 'settled' supplier filter counter incorrectly included NULL/unknown balances; one-line correction excludes unknown balances, consistent with the filter and KPI. Four relevant supplier Jest suites GREEN **18/18, exit0** after both changes.

**Full frontend reliability distinction (no false GREEN):** Two complete post-057 monolithic `npx jest --ci --runInBand` runs each ended **2,678 passed, five failed, three skipped, exit1** among 326 suites, but failed DIFFERENT rendered UI suites (first: purchase invoice, barcode replacement, staff management, purchase order; second: liquidity display, POS hotkeys, indications, stores route), often after very long runtime/short async waits. All affected suites passed when independently rerun: first four suites 64/64 GREEN; second four suites 63/63 GREEN. Independent read-only Jest harness inspection found clearAllMocks afterEach without universal reset/restore of modules, timer state or mock implementations; execution contention or suite-state timing is plausible but NOT proven cause. Preserved both broad failures; no test skip or production logic loosening. Subsequently listed all **326 Jest files** and ran them sequentially in **eight fresh-process partitions** (41 files per group, last 39), no concurrent Next build, every group exit0: combined **325 suites passed, one skipped; 2,683 tests passed, three skipped, ZERO failed**. This demonstrates complete frontend coverage by partition, NOT stable monolithic execution. Final UI one-line count change was followed by focused supplier 18/18 GREEN, tsc/lint exit0 and fresh 70-page static export, but not a repeat of all partitions after that one-line change. Full-suite stability remains an explicit follow-up concern.

**Current disposable C evidence and safety:** Fresh read-only `%APPDATA%/com.pharma.disposable.qa20261014c/pharma_local.db` had migration max/count 56/56, one 056 cash witness, one notice, two 054 receipts, four journals, open new local_default shift starting EGP40, `integrity_check=ok`, foreign_key_check zero. Independently identified B and C test executables remained separate and running. No GUI money submission, original customer/QA write, destructive restore, hardcoded credential or actual issuer/TPM material used in this continuation. A logical in-memory SQLite copy is NOT OS-quiesced destructive disaster-recovery certification.

**Shipping seed and outstanding gate:** Fixed-path read-only `node scripts/check-commercial-release-seed.js` still returned its expected **BLOCKED exit1** because bundled shipping DB contains configured user password hash. Previous live npm remaining 13 moderate/2 low and Rust OSV 24 matches require current independent disposition. Conditional non-Tauri supplier browser fallback uses unscoped SQL for global contacts/ledger/payment and must never be enabled with a shared live database without native-equivalent tenant/actor authorization; current commercial Tauri path uses native commands, and the present web DB adapter is fail-closed, so no deployed browser exploit is asserted. Historical accounting, prospective source scope for orphan suppliers, release-profile supplier create/edit/delete, signed installed x86/x64 native GUI, TPM2 physical binding and real production Ed25519 issuer/revoke/renewal, authorized seed sanitization, provably quiesced signed-origin OS restore/rollback, dependency upgrades/disposition and independent security/finance/operator two-person signoffs are absent. NO signed commercial approval is manufactured.

**Final source custody before this append:** HEAD `a9411cce`, **367** pre-existing/new dirty and untracked paths, **zero staged**, **57 SQL migration files**, protected original QA database hash/size unchanged, 057 SHA as above, `git -c core.safecrlf=false diff --check` exit0, final middleware present, `PHARMA_SECURITY_RELEASE_APPROVED` blank/unset. **COMMERCIAL SECURITY/LICENSING RELEASE GATE = OPEN/BLOCKED; NO PRODUCTION APPROVAL.**


### 2026-10-14 migration 058-059 and focus-safe hybrid background QA - OPEN/BLOCKED

**Priority change / trust boundary:** Executed the requested reusable hybrid background QA against independently identified synthetic Tauri identifier `com.pharma.disposable.qa20261014bg`, never the original authenticated QA renderer or customer DB. First two ordinary hidden-window debug launches CHANGED the observed Windows foreground handle; those exact BG PIDs were stopped rather than falsely claiming no focus steal. Built a dedicated Win32 **nonactive desktop** launcher, own WebView2 profile and 127.0.0.1:9333 CDP port, loopback-only static frontend on 3118, verified CDP listener's Windows process-parent chain to exact disposable app binary, separately owned AppData SQLite and synthetic-only Ed25519 verifier. Actual private-desktop launches returned unchanged foreground HWND. No OS mouse/keyboard events or desktop switching were sent by the subsequent CDP scans. This does not certify imperceptible transient focus changes on every platform/hardware configuration.

**Synthetic GUI activation and migration:** Fresh synthetic Ed25519 key generated in memory only; test *public* verifier compiled in isolated BG binary, short synthetic lease installed by **actual native Tauri `license_install`** (`valid=true`) without actual production issuer material. Used authenticated synthetic `admin` login, distinct app identity, and genuinely restarted isolated BG executable. It migrated a disposable C-derived synthetic database from **56 to 58**, and a later newly compiled BG binary migrated it from **58 to 59**. Real post059 BG source read-only audit: `_sqlx_migrations=59/59`, `integrity_check=ok`, zero foreign keys, **two retained 054 genuine C-origin synthetic supplier payment receipts (cash EGP40, bank EGP15)**, one 056 pharmacy notice EGP12.50 with exact notice?051 receipt?journal?cash UUID and same shift/tenant/actor/amount; matching journal account codes verified (cash drawer 1.1.1, bank clearing 1.1.4, payable 2.1, notice adjustment 4.2). Explicitly **retained C-derived source evidence**, NOT newly posted BG GUI money. New BG GUI did not submit any new money or repeat historical nonces.

**058 authentic RED/GREEN:** Under SQLite `recursive_triggers=OFF`, genuine source-linked 054 cash receipt on a subsequently closed shift could be contradicted by `INSERT OR REPLACE` on its shift primary key, bypassing 057 DELETE/UPDATE triggers despite structural `integrity_check=ok` in a disposable clone. Focused synthetic Rust test `supplier_cash_shift_cannot_be_replaced_when_sqlite_recursive_triggers_are_off` RED exit101, then GREEN exit0 after new **forward-only `058_supplier_cash_shift_replace_guard.sql`** adds narrowly scoped BEFORE INSERT duplicate shift-ID guard. Tested in independently read-only backed-up BG SQLite **in-memory only**: shift tenant change, shift-ID substitution, DELETE and REPLACE all denied **4/4**, normal new shift insert/closure allowed on clone. 057 remains byte-for-byte preserved, SHA256 `8656397a4c2f956e031c5e8c7cd85412f95715c02f4c81a903609b866c0d5608`; 058 SHA256 `e3c075a4c29592499649842dae50507f57f30966cab74fac8ff688e352235f05`.

**059 authentic RED/GREEN:** Independent read-only audit noticed the 054 immutable supplier receipt's BEFORE UPDATE/DELETE did not necessarily stop SQLite `INSERT OR REPLACE` with `recursive_triggers=OFF` if a surplus unmatched supplier ledger row made the old 054 BEFORE INSERT count predicate pass. A disposable C-derived in-memory SQLite clone, containing a genuine bank EGP15 immutable receipt, was changed **only in memory** to append a fake unreceipted `supplier_transactions` row, then replace the bank receipt's before/after balances. SQL accepted the forged historical balance despite `integrity_check=ok`. Added genuine Rust `supplier_bank_receipt_cannot_be_replaced_after_unreceipted_ledger_noise` BEFORE product fix: focused **RED exit101**, one failed assertion at the accepted REPLACE. New **forward-only `059_supplier_payment_receipt_replace_guard.sql`** BEFORE INSERT trigger denies collisions against any preexisting 054 receipt's receipt ID/request ID/ledger ID/journal ID/cash UUID, without restricting new legitimate receipt inserts. Same Rust **GREEN 1/1 exit0** and genuine BG-derived RAM-copy attack DENIED while bank receipt EGP310?295 before/after cents lineage remained exact. This is prospective 054 integrity hardening, not remediation/certification of unknown historical supplier records. 059 SHA256 `d6aaf295f472f040d9bc5d6b9d1744f845c7338d202b152b38fe1f82530ccb19`. Protected migrations **001?058 unchanged** during 059 correction.

**Reusable runnable command and coverage semantics:** Added `npm run qa:background`, controlled `--headless-only` / `--native-only --native-port=9333` / `--native-routes=...` / `--inventory-only` modes, source control AST catalog, private Win32 desktop launcher, loopback exported-front-end server, guarded CDP inspector, read-only BG DB/source audit, self-tests and external evidence JSON/log/screenshot capture. Usage and limitations in `docs/QA_BACKGROUND_HYBRID_2026_10_14.md`. Unique output directories are created under real OS TEMP; custom directories disabled to prevent overwrite or symlink/reparse redirection. Launcher reviewed after worker found Python Windows `os.kill(pid,0)` would **terminate** the PID: replaced with read-only native `OpenProcess`+image identity probe, verified existing BG PID stays alive; pinned BG binary hash, canonical file/link alias checks and fail-closed manifest/executable/listener ancestry. Sensitive tab/switch controls are never globally clicked; exact source-reviewed accounts side-nav selection and read-only directory searches have distinct checks. Synthetic patient/vendor data may be retained in output artifacts, so evidence remains restricted to user's TEMP and MUST NOT be distributed as a sanitized commercial report. No native GUI focus-dependent acceptance was represented as background-certified.

**Headless frontend verification:** AST inventoried **1,269 JSX controls** across source files, including **256 sensitive source controls** excluded from indiscriminate input; exported **67 route HTML files**; inventory is **NOT exercised control coverage**. Reusable partitioned Jest enumerated all **326 configured suites** and ran eight separate fresh-process 41-file groups: **2,683 passed, three skipped, zero failed, every group exit0**; combined background run repeated this GREEN. Both prior monolithic 2,678 pass / 5 fail in different suites remain preserved *failed evidence*: segmented success does NOT prove stable monolithic runner. Native CDP first premature `document.readyState` sweep **63/63 protected routes erroneously failed** due early skeleton rendering and recurring React hydration warning #418; **retained RED harness evidence**, then corrected to wait for actual rendered main content and distinguish blocked/empty/error states. Corrected 058 native broad sample of 67 exported routes: **61 rendered, 4 intentionally not run, 1 intentional legacy-supplier `local_default` ownership denial, 1 intermittent blank/loading**. Combined segmented-Jest-plus-native 058 run: 60 rendered, four excluded, one correctly blocked supplier, two intermittent loading; native stage exited failure and was not called GREEN. Focused subsequent tests rendered formerly intermittent adjustment-reasons page, and in authenticated real WebView2 verified **15/15 source-reviewed accounting tab-selection UI states**, **three read-only directory search/filter changes plus restoration**. After 059, focused native routes `/accounts` and `/stores/adjustment-reasons` passed, supplier route remained intentionally blocked, with 15 finance tabs and one read-only filter verified; native stage returned **PARTIAL exit2**, no route failures. Owner GUI's native Rust `reconcile_financial_sources_native` read-only command actually returned `limited_no_findings`, **four scanned journals, zero findings, zero unverifiable legacy**. All runs retained React #418 hydration exceptions (three in final focused result) as warnings; recurring hydration/flaky route rendering is NOT certified resolved. None of 768 discovered runtime controls or 1,269 AST controls were counted successful just for appearing; button/form validation and destructive workflows still need independent behavioral coverage.

**Final code quality and custody:** After 059 broad pinned `cargo test --locked --offline -q` **563 registered, 562 passed, 0 failed, 1 ignored, exit0**. Pinned cargo check exit0 (existing warnings), TypeScript exit0, native-harness Node four self-tests 4/4, JavaScript syntax/Python syntax exit0, scoped QA harness ESLint exit0, and freshly rebuilt Next/Tauri static export **70/70 pages exit0**, `src/middleware.ts` restored. BG user-space native C-derived DB remains independently at 59 and was never overwritten/restored to original; all attacks executed only on RAM copies. The exact BG app and separate static server were then selectively stopped by fully checked PID/executable/command line, local CDP 9333 and static 3118 ports no longer listening, without touching other application sessions. Worktree HEAD a9411cce, **379** dirty/untracked paths before this record, **zero staged**, **59** migration SQL files, protected original QA `src-tauri/pharma_local.db` **58,687,488 bytes SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3` unchanged**, diff check exit0; release approval environment variable **unset**. No git destructive checkout/reset/clean/stash, original purchasing nonce retry, or original authenticated QA data writes.

**Commercial/security gap remains independent and unfilled:** Most control-level UI behavior (including permissions, negative form validation, actual new BG financial submits, Windows focus-required dialogs) is inventoried but NOT exhaustively exercised. Synthetic activated/debug, self-signed test lease and BG logical copies cannot replace strict **signed installed** `pharma_security_release` acceptance, physical TPM2/real production issuer activation/revoke/renew binding, verified historic receivable/payable/valuation/COGS/journal accounting, authorized credential-bearing shipping seed remediation, OS-quiesced destructive restore/rollback, live npm/Rust advisory remediation/disposition, source-ownership cleanup for local_default/supplier creation, or independent human security/finance/operator dual signoff. Prior shipping-seed guard remained intentionally BLOCKED; no new authorized sanitization or signed release took place. **COMMERCIAL SECURITY/LICENSING RELEASE GATE = OPEN/BLOCKED; PHARMA_SECURITY_RELEASE_APPROVED UNSET; NO PRODUCTION APPROVAL.**

### 2026-10-14 resumed connected behavioral QA and release-custody addendum — still OPEN/BLOCKED

Windows companion connectivity returned after several unavailable turns; independently read the repository and worker results **before** writing code. HEAD `a9411cce`, **386** dirty/untracked paths initially, zero staged, protected original database **58,687,488 bytes**, unchanged SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, 59 migration scripts and unchanged 057/058/059 hashes (`8656397a...`, `e3c075a4...`, `d6aaf295...`). Original financial records, sessions, issuer keys, migrations and ambiguous 042 purchasing nonce were **not touched**. The genuine previous BG synthetic EGP1 supplier bank receipt was **not resubmitted**.

Existing workers' two rendered UI suites were reviewed and reconciled with current product code: purchase-order `PurchaseOrderModal` now checks nonfinite/negative expected price before dispatch (the worker's genuine RED had exposed that earlier frontend omission); the typed `createPurchaseOrderAction` retains its own independent guard. The original two behavior suites freshly **11/11 GREEN**. Two newly added, independently named rendered behavior suites report **8 purchase-return/stock-adjustment** and **9 patient, finance, shift, backup and admin** passing Jest cases: source-identifying choices, refund method/quantity clamping, required validation, permission hiding, native-denial messaging and retry. They mock backend IPC and are not actual financial postings. Full fresh segmented Jest follow-up is a separate quality gate, not inferred from these focused results.

Native BG process preflight verified pinned executable, independent synthetic identifier `com.pharma.disposable.qa20261014bg`, separate AppData SQLite, temporary owner credential, and valid **test-only** signed lease. New Win32 **nonactive private-desktop** launch sampled foreground HWND unchanged; no OS mouse, keyboard, clipboard or focus switch. A 25-route genuine authenticated WebView2/CDP behavioral run ended **FAIL**, with **14 rendered routes, 10 unverified-loading, one intentional ownership-denied supplier route, 25 hydration #418 warnings**; it did **not** certify route availability or production UI. Of reviewed scenarios **16 verified**, **11 unsupported**, **12 blocked**. New conservative per-control runtime-to-action attribution yielded **208 controls: 10 uniquely verified, 7 blocked, 191 untested**; 1,269 source JSX controls are still not attributable to native behavior by source line. Reproducible reports: `%TEMP%/pharma-background-qa-3kszGg/native-report.json`, `native-behaviors.json`, `control-evidence.json`, and `native-sqlite*.log`. No generic sensitive click or new financial source submission was made.

Independent read-only BG SQLite audits both before and after WebView actions passed migration 59, `integrity_check=ok`, no FK errors, exact three 054 supplier receipts (including **the previous, not repeated EGP1**), notice source-to-journal-to-cash identity, and 058/059 REPLACE defenses on in-memory clones only. Authenticated native owner reconciliation scanned **five journals, zero findings, zero unverifiable legacy journals**, a deliberately limited synthetic result. Fresh pinned Rust native suite **562 passed, zero failed, one ignored**, `cargo check --locked --offline` exit0 with existing warnings; `tsc --noEmit` exit0; five QA harness self-tests and scoped lint exit0. These checks do not establish exhaustive actor/tenant UI behavior, historical books correctness or signed-release acceptance.

Open commercial controls remain the **signed installed strict `pharma_security_release` profile**, real TPM2/production Ed25519 issuer activation/renewal/revoke/device binding, independent historical receivables/payables/lots/COGS/cash/journal certification, shipping credential-seed remediation, OS-quiesced destructive DR/rollback, live comprehensive npm/Rust advisory disposition and independent dual operator/finance/security approvals. Failure/untested behavior stays visible. **Decision: OPEN/BLOCKED. `PHARMA_SECURITY_RELEASE_APPROVED` must remain unset.**

**Additional fresh development gates, not a release grant:** `npm run qa:background -- --headless-only` completed **330 Jest files in nine fresh-process partitions**, all exit0, **2,711 tests passed, three skipped** (`%TEMP%/pharma-background-qa-UpWz0T/report.json`). Pinned MSRV Rust full **562 passed/one ignored**, cargo check exit0, TypeScript exit0, QA harness **5/5** and scoped lint exit0, local licensing Python **49/49** pass. Cached offline npm production audit exit0/zero listed advisories, **not live** vulnerability acceptance; `cargo-audit` is not installed. The separately identified BG SQLite source also passed a **new non-destructive logical backup→separate restored-file preview**: seven table counts plus exact supplier receipt, journal and notice-cash UUID lists matched; `integrity_check=ok` and no foreign-key errors for source, backup and restored copy. Snapshot and restored SHA256 both `577dbc6cb40629deddb74d17d74e66d56a8680b764b5268bdb12b99b31ecdf7e`, files only inside `%TEMP%/pharma-background-qa-p5XLJa/`. No application DB replacement or OS-quiesced restore occurred; this does **not** lift the production DR blocker.

**Serialized GUI diagnostic and final frontend build:** Following the nine Jest partitions and full Rust tests, new `npm run build:tauri` **exit0**, Next 15.5.27 and **70/70** pages exported, middleware restored. A narrowly scoped **same synthetic private-desktop process** WebView2/CDP retry exercised `/pos`, `/stores/items`, `/accounts` and `/purchases/suppliers`: previously blank POS/items/accounts all rendered when the concurrently running high-load Jest/Rust suites were absent; supplier directory intentionally remained fail-closed because `local_default` supplier ownership cannot be certified. Four reviewed UI actions verified, **68 runtime control occurrences: six uniquely verified, seven blocked, 55 untested**, native owner audit **five journals/zero findings**, source SQLite integrity audits and the new integrated separate logical recovery preview all passed. Native route status correctly **PARTIAL/exit2**, NOT GREEN; **four React hydration #418** warnings persisted. Evidence `%TEMP%/pharma-background-qa-PHhH1X/`. Intermittent loading may be load-sensitive but is **unresolved**, and the per-control counts from overlapping runs must not be summed. Commercial release still **OPEN/BLOCKED**, approval unset.

**Final protected custody:** Read-only post-test source audit remained at schema 59, retained all three exact synthetic supplier receipts and unchanged EGP1 source, preserved the 056 cash witness, verified 058/059 immutable protections only in RAM, and reported SQLite integrity `ok`/zero FK errors. Original QA repository DB **58,687,488 bytes** and SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3` unchanged; migrations 057–059 SHA unchanged; Git HEAD `a9411cce`, **390** dirty/untracked entries and **zero staged**, diff check exit0; approval environment empty. Strictly identified private-desktop BG PID40720 was stopped, and CDP port9333 ceased listening. Static server port3118 was intentionally **not stopped**, as the restricted cleanup check could not conclusively prove ownership. No other foreground/QA app or customer process was targeted. The independent commercial release gate is **OPEN/BLOCKED**, not satisfied by these development checks.

### 2026-10-14 evening: licensing SSR/native hydration and duplicate-online-activation RED→GREEN, additional hybrid QA

**Existing checkpoint reconciled before changes:** Windows companion responded. HEAD a9411cce, 390 dirty/untracked, zero staged, original protected repository DB 58,687,488 bytes / SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, migration count 59 with unchanged 057–059 SHA256, `PHARMA_SECURITY_RELEASE_APPROVED` unset. Neither the ambiguous original purchase nonce nor the independently proven genuine BG synthetic EGP1 bank receipt was replayed. The old QA session, B/C app data, original records and real issuer secrets were untouched.

**Authentic missing-product-hydration RED before correction:** In a fresh genuine private-desktop BG WebView2/CDP native sweep, **all 12/12** previously intermittent routes now rendered, but **12/12** still produced one React #418 hydration warning (report `%TEMP%/pharma-background-qa-VXsGrB/`, native owner reconciliation five journals, zero findings; synthetic source SQLite before/after and logical recovery pass). Inspection identified a precise mismatch: static `LicenseBoundary` SSR `isTauri=false` returned protected page children while WebView2's initial client `isTauri=true` returned the signed-license activation UI. A new independently executable server-render→native-hydrate regression reproduced the exact React error and `<strong>` versus `<main>` first-render difference, **genuine RED Jest exit1**. A narrow fail-closed identical server/first-client license-loading placeholder resolves this component mismatch without loosening native signed-status checks. Original + new focused licensing suites **17/17 GREEN**, TypeScript and scoped lint exit0. New static Tauri export **70/70 pages exit0**, middleware restored. This does NOT prove every protected native page can now hydrate under a valid authenticated startup.

**Authentic double-submit licensing RED before correction:** Another new rendered test clicked online activation twice before React disabled the button; the unpatched component sent **two** simultaneous `license_activate_online` native IPC requests with the same synthetic code (the worker's focused Jest **6 pass/1 genuine failure**). Minimal synchronous `installing.current` checks at install/activateOnline/renewOnline entry now coalesce the event in the renderer rather than trusting a later rerender; the independently rerun **7/7 GREEN**, and combined three-suite **17/17 GREEN**, with no production issuer call. The native activation endpoint's own request gate remains authoritative; UI-only duplicate suppression is not license issuance/renewal certification.

**Signed synthetic lease expired before post-fix authenticated UI acceptance:** The pinned BG test-only signed lease expired normally; no new keypair/grant or issuer signing key was introduced. Actual rebuilt private-desktop `license_status` returned `valid=false`, `expired=true`, `startup_ready=false`, protected finance navigation did not render, and one WebView2 reload recorded **zero hydration exception #418** on the locked license UI (`%TEMP%/pharma-background-qa-Yg0PUN/`). The standalone expiry check had initially exited0; harness semantics were corrected to exit **2/PARTIAL** for expiry-only coverage, confirmed via `%TEMP%/pharma-background-qa-osH8N3/` (native SQLite and logical recovery pre/post PASS). A signed synthetic restart with valid future lease would be required to repeat the protected routes; this was deliberately not forged merely to refresh coverage. Full installed release/physical TPM/issuer remains **blocked independently**.

**Action-level QA evolution:** `npm run qa:background -- --headless-only --headless-filter=qa-background-` executes only named new QA Jest suites instead of needlessly re-running the previously verified 330 files, and emits `jest-part-XX.json` with individual Jest statuses plus `headless-actions.json`. Initial scoped run `%TEMP%/pharma-background-qa-oEgG2R/` covered **seven QA suites, 41/41 passed, one fresh partition** among **333** currently discovered Jest files, zero failed/skipped; six harness self-tests and scoped ESLint also passed. Action records expressly mark true financial/Tauri effects **NOT VERIFIED by mock-backed Jest**, while exact source JSX→native control mappings not established remain **untested**. Expanded scenarios include inventory lots/expiry/unit conversion, payments/returns, patient/shift management and online-license edge cases. The previous complete 2,711 Jest / 562 Rust passing reference and migration safety results remain preserved, not misrepresented as newly rerun after this frontend edit.

**Unresolved and fail-closed by design:** `purchasing_reads_native.rs` lines 65–71 explicitly reject native read access for `local_default` because legacy invoice/return rows lacking a proven pharmacy cannot be claimed tenant-owned. The supplier directory denial is a business-ownership reconciliation blocker, **not justification to broaden read scope**. Intermittent loading remains workload-sensitive and not definitively fixed; authenticated post-fix native hydration, most JSX controls, monolithic Jest stability, genuine new source-linked financial operations, strict signed installed build, TPM2 and production issuer, historical books, shipping seed, quiesced destructive recovery, live advisories and independent dual operator/security/finance approvals remain outstanding. **Commercial authorization OPEN/BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` UNSET.**

**Additional genuine 2026-10-14 permission RED→GREEN:** The initially forbidden financial-notices tab mounted `FinancialNoticeForm` before the async actor permission was resolved, causing a restricted actor's frontend to request patient/supplier selector data. Its new actual rendered Jest test was **RED 6 pass/1 fail** against the original `AccountsManagementClient`. A single guarded conditional now withholds that content until the existing visible-tab `hasConfiguredPermission` authorizes the chosen tab. This is a frontend prefetch-side mitigation, not a replacement for native actor/tenant constraints. Focused finance test **GREEN 7/7** after a delayed-form fixture explicitly selected its permitted patient, with four adjacent existing accounting/permission suites **79/79 GREEN**. Their initial 2 test failures were ambiguous heading-vs-nav text selectors, corrected narrowly in the existing regression only; no accounting calculation or authorization policy was weakened. Fresh later nine-file filtered QA run **53/53 GREEN**, per-test artifact `%TEMP%/pharma-background-qa-1c4ouP/headless-actions.json`; it proves rendered/mocked frontend actions, not new source-to-ledger persisted native transactions.

**Permanent one-off-money replay guard and final development build:** Background runner and its direct CDP entrypoint now fail immediately if supplied the previously used `--one-synthetic-bank` command option, avoiding inadvertent duplicate EGP1 supplier payments. New self-test verifies both rejections; all **seven** harness self-tests, scoped ESLint and TypeScript passed. A fresh read-only synthetic BG SQLite audit retained schema59, the three 054 receipts (including the existing bank EGP1), 056 notice/cash identity, 058/059 RAM-only tamper denials, `integrity_check=ok`, zero foreign keys. A sequential final frontend static `npm run build:tauri` **exit0** produced **70/70** pages, middleware restored. No new authenticated CDP test using these rebuilt assets occurred because the throwaway signed BG lease expired; the valid signed/native production release gate stays **OPEN/BLOCKED** and `PHARMA_SECURITY_RELEASE_APPROVED` remains unset.

**New network-backed dependency audit contrasts with offline cache:** Fresh
`npm audit --omit=dev --audit-level=high --json` against the present lockfile
returned **exit0 at the high-severity threshold**, but disclosed **15
advisories**, **13 moderate and two low**, no high/critical. Reported packages
include `@babel/core`, `@opentelemetry/*`, `@sentry/*`, `csv-parse`, and
`esbuild`. Earlier `npm audit --offline` zero findings reflected incomplete
cached audit metadata, **not no remaining vulnerabilities**. No dependency
was forcibly upgraded; each finding still needs reviewed exploitation-path,
runtime shipping, fix parity and compensating-controls disposition. Rust
`cargo-audit` and signed installed release validation remain absent.

**Action-level report integrity:** QA now records source location, handler/
label, declared module and required/disabled states per source JSX control,
plus a per-module count of untested controls. This is an unambiguous static
inventory for follow-up review, **not** evidence of successful authenticated
native execution. Fresh eight Node self-tests and scoped lint passed;
most controls still lack their exact native action witness, release OPEN/BLOCKED.

### Resumed end-to-end QA, custody and release decision — final October 14 checkpoint

**Release decision remains DO NOT RELEASE / OPEN/BLOCKED.** On renewed Windows
connectivity, the protected original QA SQLite remained 58,687,488 bytes,
SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`;
all 59 migration SQL files and 057–059 hashes remained unchanged, HEAD
`a9411cce`, zero staged, middleware restored, approval variable unset.
Neither the original ambiguous purchasing nonce nor the independent EGP1
synthetic native bank receipt was replayed. Private-desktop BG app stopped;
port9333 free and unrelated static port3118 deliberately left running.

**Fresh frontend evidence after modifications:** Nine partitioned Jest
processes passed **338 configured files / 2,750 tests**, three skipped,
zero failures; `%TEMP%/pharma-background-qa-nW0BgH/`. A separately added
settings/backup suite then passed **6/6**. Full set of **13** new QA-specific
rendered suites was independently run **73/73 passing**, including genuine
component UI behavior for POS lot/unit/credit/retries, source-specific
returns, cash/shift reconciliations, financial notices, report CSV and backup
identity/rollback/rehearsal errors (native/financial actions mocked), at
`%TEMP%/pharma-background-qa-MFTTD2/headless-actions.json`. Targeted ESLint,
TypeScript, and **14/14 harness self-tests** passed. Prior verified native
Rust **562 passing, one ignored**, synthetic licensing and 70-page Tauri
static build remain retained evidence, not represented as freshly repeated
or independent production installer acceptance.

**Security review corrected five verified evidence-integrity weaknesses:**
duplicated-href/tab false action attribution; false native-validation passes
for generic IPC/unknown-command errors; progression after mere browser
localStorage without signed-license-startup/live-owner-readonly authorization;
React #418 route status accepted despite hydration mismatch; and direct CDP
`--out` allowing arbitrary evidence overwrites. Current harness demands exact
per-action and source-native failure witnesses, fail-closed valid signed
license and native owner reconciliation, `unverified_hydration` classification,
plus newly minted TEMP output and short-lived runner-issued lease. The
historical one-off EGP1 entrypoint remains hard-disabled. No financial
product authorizer, immutable history or tenant boundary was relaxed.

**Retrospective, auditable native acceptance is explicitly NOT clean:**
Strict merge of three already captured private-desktop runs produced
`%TEMP%/pharma-background-merged-2L8Lma/merged-native-control-evidence.json`.
Across **67** exportable routes, only **28** have any authenticated historical
native route observation; **26** mounted content but each carried an
authentic pre-fix React #418 warning, one `local_default` supplier directory
denied unproven ownership, and purchase return creation never mounted.
Consequently **zero** routes have hydration-clean authenticated native proof,
and of **391 nonduplicated observed UI controls, zero are certified clean,
seven are blocked, 384 untested/unverified**. **1,269** code-inventoried JSX
controls across 23 module folders cannot be promoted to native acceptance
solely through route rendering or mocked Jest; the matrix preserves exact
source/evidence names and classifications. The updated licensing frontend
did show fail-closed on *expired* native synthetic startup with zero React
hydration warnings; an authenticated post-fix release-profile retest requires
a separately authorized valid test grant, not secret/issuer improvisation.

**Remaining independent production blockers:** Existing limited read-only
source-to-journal/cash/stock integrity and synthetic logical backup proofs
do not certify historical finance, source ownership, future POS/supplier/
patient/shift postings, idempotent cross-module restart, secure installed
binary signatures, issuer secret/key custody, physical TPM, tenant isolation
across an actual fleet, shipping seed hardening, destructive disaster
recovery or human dual-control approvals. Current network-backed production
npm audit contains **13 moderate / two low** advisories (no high/critical);
reviewed exploitability and Rust advisory audit remain outstanding. The
monolithic Jest workload stability is not repaired by partitioned success.
No independent release authority or business owner signed off.
**`PHARMA_SECURITY_RELEASE_APPROVED` MUST REMAIN UNSET.**

**Final evidence custody / blocked-native negative:** Direct CDP now needs
the parent runner's unpredictable fresh TEMP output lease as well as
canonical output directory identity. A native-only request was made while
the independently owned BG desktop was intentionally stopped; it correctly
returned **FAIL/exit1** with exact descendant-CDP listener ownership denial,
**zero routes, zero money submissions**, and before/after read-only synthetic
SQLite plus logical backup preview **PASS**. Evidence:
`%TEMP%/pharma-background-qa-ASwNZZ/`. This must not be described as
successful UI acceptance. The archived positive EGP1 BG helper itself now
rejects direct invocation before any request ID or CDP call, on top of both
previously disabled runner flags. The existing EGP1 receipt remains immutable
and unreplayed. Release gate **OPEN/BLOCKED**, approval flag unset.

**Final repository safety reconciliation:** HEAD `a9411cce`; **403**
modified/untracked paths preserved, zero staged, `git diff --check` exit0;
original protected DB 58,687,488 bytes and SHA256
`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`;
unchanged migration hashes 057–059, middleware restored, no BG native app or
CDP9333 listener. Existing static QA server PID34112 left untouched. Final
TypeScript, scoped ESLint and **15/15** harness self-tests passed. No customer
or issuer secret action, production approval, release tagging or signed
installer was performed. **OPEN/BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED`
UNSET.**

**Final independent-review fail-closed update:** Historical merger now
rejects missing or uninstrumented hydration diagnostics rather than treating
them as clean; route clean acceptance requires actual zero warnings and
explicit `no_mismatch_observed` instrumentation. Recomputed evidence
`%TEMP%/pharma-background-merged-zjY3M0/merged-native-control-evidence.json`
still establishes only **26 visible-but-hydration-unverified native mounts,
one supplier ownership denial, one loading purchase-return, zero clean
authenticated native routes, 7 blocked / 384 unverified controls** across
28 examined routes of 67. Direct CDP evidence is now atomically claimed
exclusively in its fresh TEMP output in addition to short-lived runner lease.
The separate expected no-listener execution after this hardening returned
exit1 with zero native actions and SQLite/isolated logical recovery checks
passing, `%TEMP%/pharma-background-qa-fViKcW/`. All **16/16** final QA
harness self-tests, targeted ESLint and TypeScript passed. Signed installed
acceptance, historical finance and production authorization remain
**OPEN/BLOCKED**, `PHARMA_SECURITY_RELEASE_APPROVED` unset.

### Later 2026-10-14 development-only security and QA addendum — still OPEN/BLOCKED

Fresh connected custody matched original protected repository DB size/SHA256,
all 59 migrations and hashes 057–059, HEAD a9411cce, no staged changes and
an empty release-approval variable; no native CDP private-desktop app was
running. The interrupted fail-closed hydration merger fix was independently
inspected and retested: missing/invalid diagnostics cannot count as clean;
historical merge `%TEMP%/pharma-background-merged-z6r3Qk/` confirms 67
exported/28 observed, **26 mounted with #418 warnings**, one blocked supplier,
one loading, **zero clean native-accepted routes**, seven blocked and 384
unverified runtime controls; 1,269 source JSX controls lack native-action
certification. Signed disposable BG lease expired; authenticated post-fix
Tauri workflows remain blocked. The documented old EGP1 supplier receipt and
ambiguous purchasing nonce were not retried.

Fresh monolithic headless Jest `--runInBand --no-cache` now completed
**338 suites passing, one skipped; 2,757 tests passing, three skipped**, exit0,
evidence `%TEMP%/pharma-monolithic-qa-2a6ea5f606c94a1ab23c95f070d6b94c/monolithic-jest.log`.
One successful run does not prove the previous intermittent instability is
fixed. Added patient collection/refund and purchasing-source/lot valuation
rendered test files (4+5 tests), with **15 QA suites / 82 tests passing** in
`%TEMP%/pharma-background-qa-sn9EYT/`; exact test names/status are in its
`headless-actions.json`. Native financial effects remain mocked and
unverified for those tests. TypeScript, targeted ESLint and Node harness
16/16 self-tests passed.

Live `npm audit --omit=dev --audit-level=high --json` remains **zero high or
critical, 13 moderate and two low**; `csv-parse` 6.2.1 direct requires a
suggested major upgrade for full advisory remediation, while Sentry/OTel
transitive dependency exposures still need shipping-context analysis.
A newly reproduced **authentic RED** showed unexpected `__proto__` CSV
header accepted by `importInteractionsFromCSV`, overwriting trusted imported
rows; exact three-column header validation before dynamic record creation
produced focused **GREEN**, with 16/16 adjacent import/DB seed tests passed.
This mitigation does not clear all advisories or authorize shipping seeds.
New read-only synthetic BG SQLite audit again passed schema59, original
three source payment identities, notice journal/cash linkage, integrity,
foreign-key checks and RAM-only immutable source tamper defenses without
posting any new financial transaction. Full finance/accounting, tenant,
issuer/TPM, signed installed release, destructive backup recovery and human
approval remain separately blocked. **Commercial OPEN/BLOCKED;
`PHARMA_SECURITY_RELEASE_APPROVED` UNSET.**

**Static frontend build after CSV guard:** `npm run build:tauri` exit0,
70/70 generated pages with restored middleware, after focused CSV source
validation GREEN. This is not an installed/strict signed release acceptance.

**Fresh complete frontend regression after all additions:**
`npm run qa:background -- --headless-only` **PASS exit0**, all **341**
configured Jest files in nine fresh partitions, **2,766 passed / three
skipped / zero failed** with individually enumerated assertion outcomes in
`%TEMP%/pharma-background-qa-xK3Bmq/headless-actions.json` and partition
JSON/logs. This includes all nine newly added patient/refund and
purchasing-source report cases and the CSV malicious-header RED→GREEN.
No corresponding new native financial source was posted or certified by
the mocked Jest run. Current commercial security gate remains
**OPEN/BLOCKED**; `PHARMA_SECURITY_RELEASE_APPROVED` stays unset.

**Final source custody:** HEAD `a9411cce`, **407** preserved modified/
untracked paths, zero staged and `git diff --check` exit0. Protected original
database exactly 58,687,488 bytes/SHA256
`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`,
59 migrations and unchanged hashes 057–059. Middleware restored,
`PHARMA_SECURITY_RELEASE_APPROVED` empty, BG native process/CDP9333 absent,
existing static server3118 left untouched. No original finance replay,
production issuer, real TPM, installed signature or human approval was
performed. Commercial release remains **OPEN/BLOCKED**.

### 2026-10-14 resumed hybrid regression — additional RED→GREEN, native lease expired, no commercial authorization

Fresh read-only custody again matched HEAD `a9411cce`, the 58,687,488-byte
protected original SQLite SHA256
`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`,
all 59 migration files and protected 057–059 hashes; pre-change worktree
407 dirty/untracked, zero staged, diff check exit0. No Pharma/CDP9333
listener was present and 3118/PID34112 was preserved. Native private
desktop preflight `--check` succeeded but **did not launch** an app.
The synthetic signed **startup lease** ended
`2026-10-14T19:40:32Z` and was already 5,398 seconds out of time
at an observed `2026-10-14T21:10:30Z`. A distinct later license
expiration does not authorize overriding the lease. No authenticated
post-hydration-correction protected-route or financial source posting
was attempted. No production issuer or TPM secret was accessed.

A separate native report *aggregate acceptance* helper could have
treated missing, invalid, negative or `NaN` hydration warning counts
as clean native acceptance. A new live helper test preserved genuine
RED (16 pass/one fail). A minimum exact-zero-integer check restored
GREEN **17/17** native QA harness self-tests. This is independent of
the earlier historical-route merger fix and must **not** reclassify
the 26 real prior #418 mounts as accepted. Exact run evidence and
control-level statuses are in the appended QA background document.

Four additional sales-return **rendered React** tests passed focused
Jest **4/4**, with exact refund-method, unit/quantity/discount,
owner-conditioned patient options, same-request retry and stale
invoice identity assertions. Native actions remain **mocked**:
no financial return, wallet refund, cash/bank transaction, stock
reversal or immutable journal identity was persisted or certified.

Independent `csv-parse` consumer review confirmed a second genuine
CSV data-retention failure: header-only or required-blank input
could delete trusted interaction rows, and valid UTF-8 BOM input was
rejected. Four failing in-memory RED scenarios became GREEN after
pre-transaction completeness validation and `bom:true`; focused
three-suite importer/DB regression **20/20**, and a canonical CSV
with 191,541 rows imported successfully into **RAM-only SQLite**.
The earlier exact column whitelist remains in place and preserves
the unexpected/`__proto__` header denial. Dependency
`csv-parse@6.2.1` remains advisory-affected; positional interaction
CSV validation in `scripts/seed-db.js`, the deferred
`src/lib/db/local.ts` boolean failure handling and other
Sentry/OpenTelemetry/seed consumers remain **unresolved**, not approved.

An attempted current synthetic SQLite audit was separately stopped by
the connector with `This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.`
The prior read-only schema59 audit is retained as historical,
not misreported as newly executed. Current official native
per-control outcomes therefore remain **0 clean accepted routes**,
**7 blocked / 384 unverified observed controls**, plus **1,269
source-level controls without native action witnesses**. Signed
installed release, independent issuer/TPM, historical financial owner
attribution, shipping seed remediation, OS-quiesced destructive DR,
live dependency/Rust advisory disposition, authorized genuine
source-to-ledger-to-journal-to-cash/stock posting and independent
finance/security/operator approval are all still outstanding.

**Decision: OPEN/BLOCKED. `PHARMA_SECURITY_RELEASE_APPROVED` remains unset.**

**Latest integration evidence (same day, after all new changes):**
full `npm run qa:background -- --headless-only` exit0, **342 files,
2,774 passed/three skipped/zero failed, nine passing partitions**;
`%TEMP%/pharma-background-qa-YE1QNo/report.json` and
`headless-actions.json` retain exact test-level provenance and
`native_side_effects_verified_by_Jest=0`. New sales-return tests
and importer regression cases were present in this complete ledger.
Static `npm run build:tauri` exit0, **70/70** pages and restored
middleware, log in
`%TEMP%/pharma-continuation-build-85ce2ab378374297ab90a13ab02d9667/build-tauri.log`.
Fresh standalone TypeScript, relevant ESLint and whitespace checks
exit0. New network npm audit remains **13 moderate, two low, zero
high/critical** (15 unresolved) in
`%TEMP%/pharma-dependency-continuation-a4b395bdb4c34b4687205bf6429b1cc8/npm-audit.json`;
Rust `cargo-audit` remains absent. None of this changes the
**OPEN/BLOCKED** release decision, and the approval variable is
**not** to be set.

**Final custody (freshly checked after build):** HEAD `a9411cce`,
408 dirty/untracked paths retained, zero staged,
`git diff --check` exit0, restored middleware, original DB exact
58,687,488 bytes/SHA256
`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`,
59 migration files and unchanged hashes 057–059,
`PHARMA_SECURITY_RELEASE_APPROVED` unset, no Pharma app or CDP9333,
and existing QA 3118/PID34112 undisturbed. No historical money
record or protected DB changed. Native authenticated action coverage,
commercial financial certification and all independent human
production signoffs remain outstanding. **OPEN/BLOCKED**.

### 2026-10-15 continued connected treasury and import security — development-only acceptance

Reconciled initial HEAD `a9411cce`, 408 dirty/untracked, zero staged,
original 58,687,488-byte SQLite and migration 057–059 hashes unchanged,
no Pharma/CDP9333 process, port3118 preserved, approval variable
unset. Signed synthetic startup lease expired more than ten hours
before the first fresh read; separate later license expiration does
not override the expired lease. Only private desktop `--check`
was exercised; no protected native GUI or financial posting
without a valid authorized test lease.

**Two independent cash-movement UI RED→GREEN protections:**
the rendered financial form previously opened before shift lookup
returned, incorrectly retaining `main_safe` when the native
result showed an active POS drawer (RED one failed/two passed).
Gating form mounting on completed loading preserved correct
`pos` + native shift source identity. Separately,
`getCurrentShiftAction` returning a failure while movement history
succeeded was silently treated as no active shift, permitting a
financial form without verified shift ownership (RED one failed/three
passed). The source now shows the exact error through the
existing retry UI and blocks the writer until a valid shift read
or an authoritative no-shift success. Four adjacent rendered
cash/finance suites then passed **21/21**. No mock writer assertion
establishes native SQL posting, actor authorization, ledger balance
or shift cash proof. Exact per-control expected/observed states,
IDs and RED/GREEN evidence paths are documented in the corresponding
QA background addendum.

**CSV seed interaction trust boundary:** Existing
`scripts/seed-db.js` used positional interaction columns without
asserting the expected header, permitting misassociation of safety
data on reordered/extra columns. New safe isolated VM
`--dry-run` Jest reproduced **three failing negative header tests**
before the minimal shared `assertColumns` guard, then passed
**22/22** selected importer/seed/preflight tests. The VM forbids
database construction or filesystem mutation; original DB and cloud
seeds were not touched. CLI importer false-result exit signaling
and deferred local.ts importer failure reporting remain distinct
open issues until separately validated. Direct `csv-parse@6.2.1`
and other security advisories remain open.

Fresh `python scripts/qa-background-sqlite.py` returned
`status:pass` against read-only disposable schema59 with exact
supplier ledger/journal/cash receipts, previous EGP1 payment,
financial notice journal mirror and 058/059 in-memory mutation
denials. This neither posted new money nor certifies commercial
historic records. Strict historical WebView2 result remains zero
clean routes, 26 content mounts with React #418,
seven blocked/384 unverified runtime controls and 1,269
source controls without exact native action witnesses.

All independently required signed installed release,
issuer/TPM, production keys, historic finance/owner attribution,
shipping seed credential remediation, OS-quiesced destructive
disaster recovery, complete dependency disposition and human
finance/security/operator approvals remain unverified or blocked.
**Commercial decision: OPEN/BLOCKED. Do not set
`PHARMA_SECURITY_RELEASE_APPROVED`.**

**2026-10-15 separate CLI importer status RED→GREEN:** An
isolated standalone importer test first obtained an incorrect
process exit0 after an absent CSV (RED one failed/one passed).
The CLI now sets exit1 on `false` import, unexpected rejection
or database-close failure and closes the fixture database on all
paths. Four dedicated VM-backed tests passed and an adjacent
importer/seed subset **16/16 passed**, using no real database.
This is only CLI error signaling, not production seeding
certification. Deferred `src/lib/db/local.ts` importer failure
handling and 15 npm dependency advisories remain open.
Commercial **OPEN/BLOCKED**, approval **UNSET**.

**2026-10-15 fresh all-frontend integration:** Full
`npm run qa:background -- --headless-only` **exit0**, nine
separate Jest partitions, **345 files; 2,787 passed/three skipped/zero
failed**, `%TEMP%/pharma-background-qa-Mi7Yny/`.
Per-test records contain the new four cash/shift,
five seed-header and four importer CLI checks. Jest native
effects verified = **zero**; signed native protected-route
acceptance continues blocked by expired synthetic startup lease.
Harness 17/17, TypeScript, targeted ESLint and diff checks exit0.
Live npm audit retains **15 low/moderate** advisories,
`%TEMP%/pharma-audit-20261015-326bcacee9ec4d0fa2d4f5017f849fd4/npm-audit.json`;
Rust cargo-audit still unavailable. These checks **do not
change commercial authorization**. **OPEN/BLOCKED;
`PHARMA_SECURITY_RELEASE_APPROVED` unset.**

**Fresh static build and final source custody:** `npm run
build:tauri` exit0, compiled, **70/70** static pages with restored
middleware (log
`%TEMP%/pharma-build-20261015-a99f8bc2613b445e92c254721830b10e/build-tauri.log`).
Git HEAD `a9411cce`; 413 dirty/untracked, zero staged,
diff check exit0. Protected original financial DB exactly
58,687,488 bytes/SHA256
`8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`,
59 migration files and protected 057–059 hashes unmodified,
middleware present, release approval unset, no Pharma
native process/CDP9333, QA server3118/PID34112 retained.
No real native money posting, original financial record mutation,
ambiguous nonce/EGP1 replay, installer signature, TPM/issuer
or destructive restore. Native clean-route/action, accounting
cross-module identities and independent production approvals
remain incomplete. **Decision: OPEN/BLOCKED.**

### 2026-10-15 additional exact synthetic purchase, hardened audit, Rust and recovery

An independently reviewed RO-only synthetic purchase auditor now verifies one original request and one event, exact purchase invoice EGP350, stock lot quantity10/cost35/unit/expiry2027-12-31, asset inventory debit and supplier payable credit of EGP350, receipt-linked existing supplier payments and EGP294 outstanding. Its theoretical EGP110 full sell-through price spread is **not** actual COGS or recognized profit: there are zero native synthetic sales invoices. On RAM clones, five originally missed account category/group, snapshot tax, current synthetic owner tenant/active mutations were preserved as genuine **RED** before hardening and seven Python unit tests later **GREEN**; strict pinned audit still PASS. Latest direct evidence `%TEMP%/pharma-final-purchase-audit-b69e075b4ae842199b878f8c174fd43f/`. Current actor state is not historical authorization proof; chart/supplier ledger tables do not independently encode tenant scope, and general historical owner provenance remains unverified.

**Fresh full frontend regression:** `npm run qa:background -- --headless-only` exit0, **348 files, nine fresh partitions, 2,797 passed/three skipped/zero failed**, zero native effects (`%TEMP%/pharma-background-qa-tRTnRj/`). New PurchaseReturnClient same-selected-invoice denied-detail retry RED→GREEN with additional exact two-lot source/refund and stale-search cases, whitespace-only admin job title rejected after genuine RED, and deferred CSV import false/rejection warning path corrected after genuine RED. All native writer effects in these Jest suites remain mocked.

**Rust/native and recovery:** Correct full-package `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=2` passed **562, zero failed, one ignored**; the ignored real TPM enrollment test is intentionally not run (`%TEMP%/pharma-rust-native-bin-20261015-24b9f8d2f4fa49289c13749b95ebddb2/cargo-test.log`). New isolated logical backup/restore preview saved *only disposable synthetic DB copies* and verified equal SHA256 `be8e7f59325000637d6679b3d0bd397e2667e44ab213327ac5ff9bd72600125d` and source counts. It is NOT OS-quiesced destructive DR or installed restart verification. QA harness 17/17, TypeScript/selected ESLint, native schema59 readonly audit and static frontend Tauri build 70/70 pages all passed; middleware restored. Fresh npm audit still **15 unresolved low/moderate** advisories and `cargo-audit` unavailable. Source QA doc contains full reproducible paths and per-control expected/observed classifications.

**Release remains OPEN/BLOCKED.** The signed synthetic startup lease is expired, so post-fix authenticated WebView2 native UI actions, genuine new sale/return/stock/credit/patient/journal/restart identities, signed installed release, real TPM/issuer, historical-finance and legacy supplier owner certification, shipping seed remediation, destructive recovery and human finance/security/operator approvals remain independently blocked or untested. Keep `PHARMA_SECURITY_RELEASE_APPROVED` **unset**.

**2026-10-15 user-screenshot safety finding and focused RED→GREEN:** Actual photo of the custom drug replacement dialog showed existing #25515 `vatika hair oil 180 bl grgir` (master barcode **6224007939147**, active batch barcode **6224007939161**, one unit, sale50) offered as replacement for newly added `vatica hair oil 45 bl grger` (same proposed master barcode **6224007939147**, sale15). Although UI warned not to merge different pack sizes, a genuine rendered Jest RED proved its destructive button became enabled after confirmation/password, and a genuine in-memory native Rust RED proved the original 180→45 `replace_tx` returned success and would rekey old stock to the 45 record. Fixed independent UI and Rust named-pack-number mismatch guards, preserving tenant/admin/password/backup and transaction rules. Screenshot and adjacent frontend **18/18 GREEN**, full Rust **565 passed/zero failed/one ignored**, TS/scoped ESLint and 70/70 static Tauri export PASS. Separate native in-memory barcode-correction test preserved the old 180 lot and historical sale while making verified old/new barcode aliases distinct; **no live pharmacy record was altered**. Physical barcode/volume verification is required before user action. This work is not a signed installed acceptance; synthetic lease still expired. Release **OPEN/BLOCKED**, `PHARMA_SECURITY_RELEASE_APPROVED` unset.

**2026-10-15 follow-on source-of-truth hardening:** Reproduced a second RED on *final editable destination names*: initially both products named 180 ml, but after editing the final product identity to 45 ml, the UI still enabled replacement (Jest one failed/four passed) and native in-memory Rust `replace_tx` returned `Ok(20)` where rejection was required. This would permit historical inventory/references to be relabeled after the original size check. A minimal dialog check of effective edited names and an independent Rust transaction guard before `apply_edits` now reject these mismatches. Focused UI **19/19 GREEN**; 30 native replacement module tests pass, including group rejection, legitimate same-size rename, authorization, and history-preserving barcode correction; TS and scoped ESLint exit0. No installed signed lease or original database operation was used. The release is still **OPEN/BLOCKED**, with original pharmacy accounting identity and independent production acceptance unverified.

**2026-10-15 verification continuation:** Fresh full Rust suite **568 passed / zero failed / one intentionally ignored**, scoped frontend background QA **109/109** pass, and `npm run build:tauri` **70/70** static pages with middleware restored, all exit0. Read-only custody reconfirmed original database size/SHA and migrations 057–059, HEAD `a9411cce`, staged0, approval unset and no Pharma/CDP process; no live product replacement was executed. Commercial gate stays **OPEN/BLOCKED** pending signed installed native WebView2 and independent approvals.

**Final broad headless continuation:** Full `npm run qa:background -- --headless-only` completed nine partitions **2,815 passed / three skipped / zero failed**, exit0, evidence `%TEMP%/pharma-background-qa-O00nvr`. Tests still do not certify a valid signed installed native window, live database postings, historical finance, issuer/TPM, actual restore, or independent human approvals. `PHARMA_SECURITY_RELEASE_APPROVED` remains unset; gate **OPEN/BLOCKED**.

### 2026-10-15 resumed signed synthetic renewal custody and expense idempotency

The interrupted background Jest run `%TEMP%/pharma-background-qa-4lSMwn/` was recovered from its existing process with exit0, **349 files/2,801 pass/three skip/zero fail**; zero native writer effects from Jest. A later enlarged current regression is independently tracked in the QA record and must not be counted before its own exit evidence. Original protected database and migrations057–059 hashes matched; no approved signed native process or CDP9333 exists.

The user authorized *legitimate* renewal of the BG startup lease; a read-only issuer search proved that the original signed BG lease serial4 expired `2026-10-14T19:40:32Z`, whereas the separate subscription end is `2026-10-21T17:40:32Z`. Ed25519 signature against its pinned public verifier passed. The only accessible sealed local QA operator uses a **different** Ed25519 public issuer and has **no** BG license record; no BG online DPAPI renewal credential/HTTPS authority exists in the pinned installation. Running this *other* QA operator's `renew` cannot extend the BG signer trust chain. **No signing, test-issuer substitution, forged grant, production secret, unsafe installation or expired-license bypass occurred.** Authenticated private desktop WebView2 route/action testing remains **blocked** until the original authorized BG issuer supplies a fresh higher-serial signed lease validated by native `license_status` and `startup_ready`. Actual production issuer custody/TPM remains independently blocked.

Three expense UI entry points now preserve source-intent request IDs across uncertain transport retries instead of minting a second native expense nonce on unchanged input: the main Expenses screen, cash treasury operating-expense form, and AccountsManagement operational-expense dialog. True failing UI and native-IPC action tests preceded minimal JS/TS corrections; **45/45 focused frontend suites passed** at `%TEMP%/pharma-expense-all-callers-green2-0d4ef1774690411db33174156b94de3e/green.log`; initial RED logs at `%TEMP%/pharma-expense-idempotency-red-6566f0ba07624201b32ebc29c0ae98b4/red.log` and `%TEMP%/pharma-expense-other-callers-red-19270af002f74ce6832a6dfa4c86f83c/red.log`. Six new supplier payment/statement rendered tests found and corrected pending-payment Cancel/Close prematurely unmounting a draft; mock-bank settlement source and request IDs, amounts, date, denial/retry and stale read cases passed. Exact controls/expected/observed/limitations are in the QA addendum. **Native Rust expense posting, source/tenant authorization and idempotency ledger were not modified or newly posted.** Genuine native cash/journal conservation under retry/restart remains untested, not certified.

Remaining independent release blockers: clean post-fix authenticated protected-route hydration, exhaustive native control witnesses, multi-source stock/cash/COGS/returns/patient/shift identities, supplier legacy ownership, physical TPM + original issuer renewal, signed installed distribution, historical finance certification, shipping seeds, unresolved npm/Rust advisories, destructive OS-quiesced DR, and human finance/security/operator approvals. **Release decision remains OPEN/BLOCKED. Leave `PHARMA_SECURITY_RELEASE_APPROVED` unset.**

### 2026-10-15 resumed execution: newly verified financial identity and independent failing release gates

Real displayed expense entrypoints now use a stable nonce for the same financial payload. Additional rendered negative/async regression found the accounting modal's late category-definition response used to reset **an in-flight EGP85.25 posting draft and request ID** (true RED), now fixed by reset-on-open/touched-draft checks. The standalone expense view likewise protects the original request identity against an in-flight edit→revert and against late category data. Worker adjacent suites 74/74, prime's previous expense suites45/45; new tests are mocked frontend actions and **do not** prove actual native post or recovered receipt after transport loss. RED `%TEMP%/pharma-expense-record-category-red-worker1-20261015.log`, focused GREEN `%TEMP%/pharma-expense-record-category-green-worker1-20261015.log`, adjacent `%TEMP%/pharma-expense-retry-adjacent-green-worker1-20261015.log`.

The native expense handler remains atomic and now has an **additional exact in-memory SQL regression** simulating a committed EGP17.50 source whose response is lost, then an identical nonce retry and a changed EGP999.50 retry. Both are denied without a second expense/cash/journal/nonce/event, while original tenant `a`, actor `expenses-a`, cash disbursement and exactly two balanced account entries EGP17.50 remain matched. This confirms **reject-on-duplicate**, not successful retrieval of a lost native receipt. Focused `%TEMP%/pharma-qa-native-expense-exact-20261015-8e0916beb4fc4231af8cbeaf0af1cc3b/rust-expense.log`; fresh full `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=2` **569 passed / zero failed / one intentionally ignored manual TPM** at `%TEMP%/pharma-native-full-20261015-4c9194abf5c14357b0d7fc12b639c853/cargo-full.log`. Original database/schema/migrations not used by this new Rust test. Failed native receipt reconciliation after uncertain acknowledgement, route unmount/restart nonce continuity and authorized on-disk tenant actor checks remain **unresolved**.

The overlapping Tauri-build/Jest failure at `%TEMP%/pharma-background-qa-ApGcYE` was retained and traced to temporary `src/middleware.ts` relocation during static export. Both `scripts/build-tauri.js` and `scripts/qa-background.js` now use an atomic shared per-workspace TEMP lock, fail closed on overlap and never auto-steal stale or replaced locks. Direct invocation tests assert build denial **before moving middleware** and QA denial **before running any partition**, plus exclusive owner/tamper safety: **21/21**, `%TEMP%/pharma-lock-and-harness-20261015-fcdaaf3579c24141b5f2448709979851/harness.log`. The lock is per Windows user/workspace, not cross-host coordination. Existing expired signed synthetic BG lease remains unchanged; no matching original issuer available for renewal.

The fresh logical recovery preview of exclusively disposable synthetic data passed (snapshot/restored hash equality and ten source identity groups) at `%TEMP%/pharma-background-qa-recovery-68041f95e7704255a41bacae72049c40/`, including schema59/purchase-to-stock/ledger reconciliation and seven RAM-only negative auditor tests. **No destructive production recovery, live restart or historical finance certification.**

**New hard commercial preflight refusal:** `node scripts/check-commercial-release-seed.js` on the protected bundled file, read-only, returned exit1 with `Bundled seed contains a configured user password hash`, evidence `%TEMP%/pharma-commercial-seed-check-8fc8e1caebf9411da320d064bb019a65/seed-gate.log`. This must not be silently cleared by modifying the protected customer source. Require a separately reviewed sterile release seed and independently authorized enrollment/fixture process before shipment. Npm production audit at `%TEMP%/pharma-security-20261015-79ab816c8dcc41c7b6327ab46994e54a/npm-production.json`: **13 moderate/two low** unresolved, zero high/critical; direct `@sentry/nextjs`, `csv-parse` and transitive telemetry risks need dependency decision/testing; `cargo audit` executable unavailable. No blind major updates.

Current signed startup private-desktop native route/action testing, production issuer/TPM, cross-pharmacy supplier/ledger historical ownership, cash/stock/COGS/returns from genuine new transactions, real disaster-recovery replacement, shipping seed, advisory closure, signed Windows installer and human security/finance/operator signoff all remain independently blocked or untested. No false signed-lease replacement and no original financial DB mutation. **Commercial gate OPEN/BLOCKED**, leave `PHARMA_SECURITY_RELEASE_APPROVED` unset.

**Additional current-source verification:** Protected, nonoverlapping `npm run qa:background -- --headless-only` completed exit0 with **351 files, nine partitions, 2,819 passed / three skipped / zero failed**, `%TEMP%/pharma-background-qa-tExyT0/`. QA/build exclusive lock was released and reports preserve native side effects as **unproven**. The previously failed overlapping run ApGcYE remains evidence of the pre-lock harness race. This Jest result does not close the commercial blockers above.

**Latest sequential export / code quality:** `npm run build:tauri` separately passed **70/70 pages** at `%TEMP%/pharma-final-build-sequential-20261015-b3a2b37960654a44b0d20915fa1793fc/build-tauri.log`; middleware/actions/API source restored, no remaining QA/build lock. Fresh TypeScript, scoped ESLint, harness **21/21** and whole diff check each exited 0, `%TEMP%/pharma-final-quality-20261015-9df6f1aee5174c0381cbc7ae1403ad2f/`. These source/build successes do NOT waive failing commercial seed preflight, expired original signed synthetic lease and unavailable original authorized issuer, 15 npm advisories, Rust advisory scanning, native end-to-end, disaster recovery, or human approvals. **OPEN/BLOCKED.**

**Further concurrent Vatika test work after that completed build is NOT released:** A new in-memory/JSDOM QuickAdd sequential barcode source test failed one true unrelated-INSERT-error-to-destructive-replacement negative at `%TEMP%/pharma-vatika-sequential-preflight-4868e69b08c04276b36a527526ceac4f/preflight.log`. A later adjacent three-suite run observed two failed expectations/21 passed in `%TEMP%/pharma-vatika-current-green-627d9652735e4f26bae7839222cb6d7d/focused.log`; those failures expected barcode text in a generic incompatibility alert and must not be assumed to prove defective native stock handling. Concurrent editor kept changing the related source/test while verified. The original 2,819-pass suite predates this new file/edits, so **no new current full green claim is authorized until a stable after-edit rerun**. No data or migration touched, commercial gate stays **OPEN/BLOCKED** and approval unset.

**Corrected two-ADD barcode investigation, 2026-10-15:** With real `addMasterDrugAction` backed by disposable in-memory SQLite and actual rendered quick-add form, separate 180 `6224007939161` and 45 `6224007939147` save as independent masters when both unclaimed. The add is denied when the new barcode is already claimed by the old master *or* any nonzero inventory lot, even though the two entered master barcodes differ; that ownership invariant is intentionally retained. Source UI error handling had a confirmed unrelated-permission-error→replacement fallback (authentic RED) and a misleading 180/45 auto-replacement offer (RED); both are now handled without initiating replacement. Distinct named pack-size collisions display persistent source-specific barcode ownership guidance, while same-size duplicates retain reviewed confirmation. Focused rendered/action tests **27/27 GREEN**, adjacent permission/barcode tests **41/41 GREEN**, TS and targeted ESLint exit0. Neither accessible original repository DB nor installed AppData DB contained screenshot record #25515 in readonly probes, leaving actual historical ownership provenance unverified. External QA/build workspace lock blocked a fresh broad run, so no installed native/commercial approval claim is made. No live mutation; release **OPEN/BLOCKED**, approval unset.

### October 15 successor checkpoint: recovered full Jest and isolated expense file-reopen proof

**Further rendered fail-closed tests before the new broad run:** QuickAddDrugModal formerly treated any barcode-worded error (including transient validation service outage) as a confirmed owner conflict, risking a destructive replacement offer. New rendered in-memory SQLite negatives confirmed RED, then narrowly allowed only the actual addMasterDrugAction ownership-denial string or a `master_drugs.barcode` SQLite UNIQUE collision, while preserving legitimate same-size review and separate 180/45 pack constraints. New focused **11/11 PASS** in `qa-vatika-sequential-add.regression.tsx`; no native catalog replacement was performed. Separately, a rendered stock-adjustment test reproduced blank cleared number input being converted to a financial **zero-stock** instruction; `AdjustmentsClient` now keeps blank as null and refuses dispatch, while deliberate numeric zero remains valid. Adjacent initial **7/7 PASS** in `coverage-gap-adjustments-ui` and `stock-adjustment-fraction` suites; native valuation/journal/lot provenance not established by mocked writer. Both new defects were confirmed in focused RED before the narrow source corrections, not inferred from source lint or static inventory.

**Latest native superseding concurrency evidence:** Two independent SQLite file connections concurrently posting the same nonce for EGP17.50 yielded exactly **one successful commit and one denial**, one owner/pharmacy-bound expense request, one cash movement, one balanced journal and one activity row; no duplicate money posting. Focused **PASS** at `%TEMP%/pharma-native-expense-concurrency-ada4c0ffc59146a7aefe1e6bb29d14eb/cargo-focused.log`. New complete native `cargo test --locked -- --test-threads=2`: **571 passed, zero failed, one ignored manual TPM**, `%TEMP%/pharma-native-full-post-concurrency-452486feb3cb4af99a59052f0c861ec5/cargo-all.log`. This supersedes the earlier 570 passing native suite only for its changed source snapshot; no original DB, signed WebView, authorization issuer or migration modified. Concurrency tests validate transaction exclusion, **not** recovery of an acknowledged original expense receipt, tenancy of legacy finance, or signed installed product acceptance.

**New mocked rendered business-acknowledgement separation:** Real SupplierManagementClient and DrawerHandoverClient originally converted post-success UI callback failures into misleading payment/handover posting failure messages. Independent component RED cases reproduced the errors; narrow changes preserve successful money/shift acknowledgement and give distinct refresh/close failure notices, while preventing duplicate handover submissions after success. Supplier adjacent **9/9**, shift handover adjacent **11/11** tests passed; full native source effects are explicitly **unproven by these Jest tests**. New frontend suites are `qa-purchase-return-supplier-payment-ack.regression.tsx` and `qa-shift-handover-commit-ack.regression.tsx`; tests use mocked actions and may not be promoted to native release approval.

After the file-backed test was introduced, a new complete `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=2` **exited 0 with 570 passed / zero failed / one ignored manual TPM test**; preserved `%TEMP%/pharma-native-full-postreopen-9f9bc20f50524788b60a885f611f5e11/cargo-all.log`. An existing unused Rust test constant emits a warning and does not constitute another product acceptance. This run has no signed installer, original issuer, TPM or customer database access.

Session `76518` belongs to the previous connector process (`EXEC_SESSION_OWNER_MISMATCH`), and was **not duplicated**. Independently, the **newest retained completed** `%TEMP%/pharma-background-qa-PPOAkv/report.json` and nine partition JSONs establish **352 configured Jest files / 2,824 passed / three skipped / zero failed**, all nine partitions exit0, 2,827 test records, with **zero authenticated native money effects proven by Jest**. The terminal session ID itself cannot be attributed to that report from this request. Report time window `2026-10-15T08:28:45.009Z` to `08:34:56.636Z`. The previous ApGcYE overlapping-build failure remains preserved. A green frontend suite does not authorize the other **1,269 unlinked source controls**, clean protected-route hydration or signed installed acceptance.

A new `finance_posting_native.rs` regression posts a real native EGP17.50 expense against a uniquely generated disposable file-backed SQLite connection, closes/reopens the database, rejects same-nonce ambiguous-response retry and foreign tenant attempted reuse, and verifies one source/nonce/actor/tenant, one disbursement, one journal, balanced 17.50 DR/CR and no extra activity. Focused **1/1 PASS**: `%TEMP%/pharma-native-reopen-20261015-6bde8192480a4aa2b66bbc1544758890/cargo-focused.log`. The ephemeral file is deleted only after its connection closes. This adds legitimate native SQL **connection-reopen persistence evidence**, not Tauri app-process restart, signed startup, authenticated desktop money effects or validated lost-response receipt recovery. The native duplicate response remains a refusal, and cannot be converted into a success without validating tenant/actor and original payload/source identity. No protected DB/schema/migration was changed.

Custody at the recovered snapshot: HEAD `a9411cce`, protected original repository DB 58,687,488 bytes with pinned SHA256 `8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3`, migrations 057–059 unchanged, middleware restored, static server port3118 preserved, approval variable unset. The original synthetic BG Ed25519 issuer is still unavailable for legitimate higher-serial renewal; using an unrelated available signer remains prohibited. Bundled credential-bearing release seed fails preflight; 15 npm production advisories, unavailable `cargo-audit`, native issuer/TPM, signed installer, unowned historic finance, actual receipt/COGS/refund transactional chains, destructive recovery and independent commercial/security/finance approvals remain blocked or untested. **Commercial release OPEN/BLOCKED; `PHARMA_SECURITY_RELEASE_APPROVED` unset.**

**Later full post-frontend-edit Jest report was FAIL and is retained:** `%TEMP%/pharma-background-qa-j7JmrY/` completed with **354 files, 2,833 passed, three skipped, four failed (nine partitions; partitions01/02 exit1)**. All failures occurred in older QuickAdd replacement suite fixtures whose mocked `addMasterDrugAction` returned generic barcode-worded errors. The tightened product UI correctly did not treat unrelated barcode text as verified collision and offered no destructive workflow, contrary to those legacy mocks' assumptions. Changed exactly three simulated error-message occurrences across `drug-replacement-ui.regression.tsx` and `qa-custom-vatika-size-mismatch.regression.tsx` to the actual action error `Barcode is already assigned to another drug`, without changing product classification or authorization. Four focused adjacent rendered suites then passed **33/33**, `%TEMP%/pharma-quickadd-contract-recheck-7bbeabcf91d741e2ac3eb6f0ac56f7e7/focused.log`, with both genuine owner/conflict and outage/non-owner negative scenarios covered. Subsequent full rerun and serial Tauri build are distinct pending evidence, not inferred as pass. The original failed report remains a genuine time-stamped failure. Commercial **OPEN/BLOCKED** unchanged.

**Second full 354-file run remained FAIL on a distinct timed UI assertion:** `%TEMP%/pharma-background-qa-1t2MiX` showed the first `finance-ui-options.regression.tsx` liquidity case at EGP0.00 while waiting for bank/treasury async data (exact expected EGP100 ledger + EGP20 bank = EGP120), with the other parameterized cases and remaining suites successful. The original unmodified 29-test suite independently passed **29/29** at `%TEMP%/pharma-finance-liquidity-focus-fac3b88abb104eda8f2a6f3a310a1418/focused.log`; this supports load-sensitive test observation timing and does not prove a product accounting corruption or absence of an async race. A narrow **test-only** `waitFor` timeout 1s→5s retains exact EGP120 invariant and no production code change; adjacent finance+treasury **34/34 PASS** at `%TEMP%/pharma-liquidity-async-window-postfix-f3ea31b395764eeb89873ea92cb1c344/focused.log`. The failed full run remains preserved; signed WebView2 financial display still unverified. Commercial gate **OPEN/BLOCKED**.

### October 15 verification after the 354-file frontend source corrections

The earlier failed report artifacts %TEMP%/pharma-background-qa-j7JmrY/ (four obsolete barcode mock-contract assertions) and %TEMP%/pharma-background-qa-1t2MiX/ (one asynchronous first-render finance total timing failure) remain preserved as genuine FAIL. Only relevant test fixtures/timing were updated: production drug collision gate, EGP120 treasury calculation, actor/tenant permissions and native ledgers were **not** weakened.

The subsequent full **PASS** %TEMP%/pharma-background-qa-r5BEje/report.json covered 354 files, 2,837 passed, three skipped, zero failed, nine partitions exit0 and 2,840 per-test records. It proves no live native money effects or authenticated control acceptance. A sequential npm run build:tauri completed exit0, 70/70 static pages and restored middleware (%TEMP%/pharma-build-after-354-20261015-7aca70c288114d1a91a237d1ff28b364/); independent TypeScript, targeted ESLint, 21/21 harness and diff check passed (%TEMP%/pharma-quality-final-b3d4ba774e9f48fca2374c951532cbb7/).

Read-only commercial preflight results remain blocked: configured password hash in bundled release seed (exit1), 15 npm production advisories (13 moderate, two low, exit1), cargo-audit tool absent (exit101); %TEMP%/pharma-release-gates-postbuild-cdb9ac4e8d3c459ba1cf3c6b2d2c4f91/. The authorized original BG startup lease serial4 expired 2026-10-14T19:40:32Z. Current local QA operator has different pinned Ed25519 issuer and no valid original higher-serial grant or DPAPI renewal credential; users permitting renewal does not supply original issuer authority. No alternative signer or expired lease bypass may be used. Signed installed WebView2, production issuer/TPM, historical tenant-owned patient/supplier finance, complete native stock/returns/COGS/cash identities, destructive disaster recovery, dependencies and independent human signoff stay independently blocked. **OPEN/BLOCKED**, approval variable unset.

### October 15 native 043 return provenance and lot-specific cash/credit POS acceptance boundary

**Native 043 source-owner mismatch fixed after authentic isolated RED:** Actual native `sales_cogs_provenance.rs::record_return` accepted a same-tenant return line with drug202/lot202 while referencing an original sold sale item for drug101. Native 043 triggers, actor/tenant/journal identities were individually valid, but original drug ownership was not. New in-memory Rust test failed before fix (RED session53731, forged return produced Ok(())); corrected `source_lines` now requires `return_items.drug_id == sales_items.drug_id` before recording the immutable receipt, while legitimate same-drug partial return stays accepted (focused GREEN 2/2, session10013). Historical migrations including 043/057-059 were not rewritten, and no customer transaction was replayed. Signed app acceptance and historical return ownership still blocked.

**Independent exact native POS receipt/COGS accounting proof:** `critical.rs::selected_pos_lots_keep_cash_credit_cogs_journal_and_receipt_ids_joined` executes in-memory native completed cash and credit sales selecting different lots of one drug with distinct costs. Cash: 2 x EGP30 revenue EGP60, 2 x EGP12 COGS EGP24. Credit: 3 x EGP30 revenue EGP90, 3 x EGP5 COGS EGP15. Assertions connect sale source actor/tenant/patient, selected stock lot, sale line, immutable 043 source snapshot and request UUID, balanced journal ID and exact cash drawer/credit receivable, revenue, inventory and COGS accounts. Foreign tenant lot remains untouched; focused GREEN 1/1. The distinct-cost sales are not signed native IPC or production-database proof.

Final expanded Rust `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=2` exit0: **573 passed, zero failed, one ignored manual TPM** (574 total), `%TEMP%/pharma-native-full-final-provenance-8f6d0778258c481283ff82b55c9434b7/cargo-all.log`. This supersedes previous 571-pass snapshot; no production signer, physical TPM or signed installer was accepted.

**Strict release gate still BLOCKED:** The 354-file frontend result passes 2,837/3 skipped but 1,269 JSX source controls have no direct signed native source-action witness; restored static export cannot substitute for protected native UI. Original QA BG lease serial4 expired Oct14 19:40:32Z and matching original Ed25519 issuer credentials/DPAPI renewal unavailable. `--check` private desktop fixture preflight PASS is NOT lease renewal or permission for CDP money tests. Hard gates still include commercial seed configured hash (exit1), 15 unresolved npm advisories, unavailable cargo-audit, signed installer and pinned issuer/TPM, source-owned supplier/patient historical finance, reverse-payment receipt recovery after uncertain IPC, OS-quiesced destructive disaster recovery, and independent approvals. No alternate issuer, EGP1 replay, original nonce replay, protected DB or migration changes. `PHARMA_SECURITY_RELEASE_APPROVED` unset; commercial decision **OPEN/BLOCKED**.

### October 15 follow-up: original-signer lease remains blocked, financial controls independently exercised

The newly explicit instruction to renew the **authorized BG synthetic startup lease** was checked without changing issuer trust. Original pinned synthetic startup lease serial4 expired 2026-10-14T19:40:32Z; the only accessible active local QA issuer currently has a DIFFERENT Ed25519 public key (read-only public-key comparison FALSE) and no original BG signing authorization, DPAPI online credential or fresh original-signed higher serial receipt. Private-desktop --check PASS confirms fixture provenance only, not startup acceptance. **NO renewal occurred; do not sign with an unrelated QA issuer, alter pinned verifier, bypass expiry or run protected native WebView2 auth tests**. The proper next dependency is an independently authorized fresh higher-serial lease signed by the original BG issuer and verified by native license_status + startup_ready; commercial TPM/production issuer are separate requirements.

Independent financial source tests progressed, not as substitutes for signed desktop. Native supplier payment allowed an ambiguous nonce retry with identical financial fields but CONTRADICTORY immutable note; actual disposable SQLite native test RED, then narrow receipt-to-ledger JOIN/note equality fix GREEN, preserving one receipt/balance/cash/journal, matching-note idempotency and actor/tenant checks. Patient-profile rendered cash submit RED could be hidden by pending Cancel and wrongly marked failed after a committed write if parent callback threw; guarded close/tab/hotkey while pending and post-commit refresh warning GREEN. Purchase-return rendered search RED exposed stale older source invoice actions after a new search rejected; current-source gating preserves legitimate accepted selection but hides unverified old controls, GREEN. These UI tests mock financial writers/readers; source checks and native in-memory posting do not establish signed IPC/TPM or recover a lost original receipt.

Current complete frontend report %TEMP%/pharma-background-qa-qujZXl/report.json **355 files, 2,841 passed, 3 skipped, 0 failures, nine exits0**, source-control native witnesses still 0 for 1,269 controls. Current complete Rust evidence %TEMP%/pharma-native-post-supplier-full-5a98d0f6829a4dd6890d2152286fa553/cargo-all.log **574 pass/0 fail/1 manual TPM ignored**. Serialized static Tauri Next export **70/70**, middleware restored, TypeScript/ESLint, harness21/21 and diff-check green (evidence under %TEMP%/pharma-build-post-financial-guards-318b88f821e64c67b7ccb86447e83ccb/ and %TEMP%/pharma-financial-guard-quality-43fa958a1fdf43db940e1d6840914ac3/). Protected original DB hash and migrations057-059 match their pinned prior SHA256, HEAD a9411cce, 416 dirty paths staged0; no original transaction replay, DB/migration mutation, approval flag or QA foreground switch.

Fresh read-only release gates: bundled password-hash seed BLOCKED exit1, npm production vulnerabilities 15 (13 moderate, 2 low) audit exit1, cargo-audit unavailable exit101, %TEMP%/pharma-financial-release-preflight-188d73a2beb243d4b85e7f4de145fcdf/. Still missing original authorized startup renewal, signed installed native protected route/control acceptance, physical TPM and production issuer, historic tenant-source financial provenance, destructive quiesced DR, approved seed/dependency remediation and independent finance/security/operator signoff. **COMMERCIAL GATE OPEN/BLOCKED; PHARMA_SECURITY_RELEASE_APPROVED UNSET.**
### 2026-10-15 original synthetic issuer custody clarification (user correction)

The operator who created the original BG disposable synthetic issuer was the ChatGPT-assisted QA setup itself, NOT a separate user/developer the user must locate. Historical native QA record in docs/LICENSING_SECURITY_RELEASE_GATE_2026_10_11.md explicitly says the BG Ed25519 PRIVATE signer was freshly generated IN MEMORY ONLY, and the public verifier compiled into the BG-specific test executable. The retained BG fixture stores signed envelope + PUBLIC key and signed archives but no matching original private signing seed or retained authority DB. The DPAPI-sealed local QA operator is a different issuer (public-key mismatch). Earlier generic instructions to "ask the original issuer/operator" incorrectly shifted responsibility to the user; the actual BG synthetic issuer custody was ephemeral by construction. Its original private signer cannot be recovered from a public key, signature, or old grant. No authenticated matching signing authority was found in the read-only searched fixture/current issuer; this is a bounded negative, not a claim no backup could exist anywhere.

**Safe resolution path, not a hidden renewal:** Leave the old BG app/lease/verifier/database intact and blocked. If original signing material cannot be recovered, provision a NEW independently identified disposable BG fixture with a persistently sealed TEST-only issuer, isolated database/WebView2 profile/desktop and appropriately pinned verifier, then issue and verify its initial grant through native startup before testing protected UI actions. This is a new test fixture, NOT a higher-serial renewal of the 2026-10-14 BG serial4 lease, NOT permission to re-pin the old binary, and NOT commercial/production issuer or signed installed acceptance. No new issuer/grant/binary was generated during this read-only investigation. Never request the user to supply the old ephemeral private key or treat a mismatched local authority as the original.

Approval remains unset, release OPEN/BLOCKED. Original protected financial DB/migrations and interactive session unchanged by this read-only inspection.

### 2026-10-15 independent renewable BG issuer and signed restart regression — verified

**New distinct synthetic fixture only, NOT the expired BG renewal:** Persistent Windows DPAPI-protected signer and monotonic issuer SQLite created for `com.pharma.disposable.qa20261015renewable`, with independent empty SQLite app data, compiled debug-only public verifier, separate pinned native executable and private Win32 desktop/CDP9334. Genuine native `license_install` accepted serial1 and, later, original new issuer's higher signed serial2. Startup `valid=true/startup_ready=true` on initial signed run. Subsequent reboot exposed authentic fresh-schema59 `NEW.medium_to_small` trigger failure; new native full59 regression RED with precise error; narrow `schema.rs` repair adds both missing sale-unit columns before performing updates, retaining immutable 043 sale guard. Same focused test GREEN, debug executable rebuilt independently, then 2 further signed native private-desktop restarts PASS with serial2, `valid=true/startup_ready=true` and unchanged foreground. Read-only DB: 59/59, both columns, original immutable trigger, integrity ok and zero FK errors.

New full Rust **575 passed/0 failed/1 ignored physical TPM**, licensing Python **51 passed**, executable/key pin and JS syntax checks PASS. Original protected DB, migrations057–059 and old expired BG executable hashes remain unchanged; 0 staged/approval unset. Full details, future safe renewal procedure and limits: `docs/RENEWABLE_SYNTHETIC_QA_2026_10_15.md`; logs in `%TEMP%/pharma-qa-renewable-20261015/`. This does NOT establish authenticated financial UI controls, online first-owner enrollment, production issuer/TPM, release signing or commercial release. **OPEN/BLOCKED.**
