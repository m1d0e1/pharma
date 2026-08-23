# Tauri application test execution report

**Baseline:** `docs/TAURI_TEST_PLAN.md`  
**Execution date:** 2026-08-23
**Application:** Pharmacy Local Enforcer 0.2.58
**Host:** Windows 11 Pro x64, kernel 10.0.26200; WebView2 151.0.4129.86  
**Toolchains:** Node 25.6.0/npm 11.8.0; Rust 1.77.2 for both Windows x64 and i686 release baselines

## Current continuation result (v0.2.58)

This continuation supersedes the dated test counts in the retained v0.2.54 evidence below.

| Layer | Executed result |
|---|---|
| Frontend regressions | 64/64 Jest suites passed: 678 passed, 1 skipped. Coverage passed at 19.71% statements, 16.88% branches, 15.89% functions, and 20.05% lines. |
| Frontend production checks | TypeScript and ESLint passed. The Tauri static build compiled and generated all 71 pages. |
| Rust x64 | Rust 1.77.2 `cargo test`: 28/28 passed. Stable Clippy with warnings denied and formatting checks passed. |
| Rust i686 | Rust 1.77.2 `cargo test --target i686-pc-windows-msvc`: 28/28 passed under WoW64. Stable i686 Clippy with warnings denied passed. |
| Seed and persistence | `integrity_check=ok`, zero foreign-key failures, 25,092 master drugs, 191,272 interactions, and the expected pharmacy-scoped shortage columns/index. The source, x64, and i686 release seeds have matching SHA-256 `B798711D753970964007C6D288457E3DF9C0448BB33B9EEC407113F8C3FDBC67`. |
| Real x64 application | A fresh isolated Tauri profile passed login, schema compatibility, bcrypt positive/negative cases, guarded-SQL and binary-writer rejection, invalid checkout rejection, and the packaged purchase → checkout → full customer return business flow. Stock, supplier balance, audit actions, and balanced journals were verified in SQLite. |
| Real i686 application | A fresh isolated profile passed the same packaged IPC/business flow. It also opened the x64-created database and passed the same behavior, proving cross-architecture serialization and persistence parity on the host. |
| Upgrade regression | The i686 application upgraded a preserved database whose migration ledger stopped at 11. It repaired the migration-1 checksum, recorded migration 12, retained all seed/business data, and finished with integrity OK, zero foreign-key failures, and balanced journals. |
| Architecture artifacts | Current raw production executables are PE `0x8664` x64 (20,980,736 bytes; SHA-256 `E33864315B87939641D83C9035347D4048A1C27C39E808FD7BBB78B1A5D7119F`) and PE `0x014c` i686 (16,783,872 bytes; SHA-256 `104628AC495170A8F663568C8CD479D0BDC426FBD857D8D237C92D9053C60C35`). No application-bundled wrong-architecture DLL was found. |

### Defects fixed and covered

- Fixed fresh-install migration 12 failing when migration 1 already supplied the new shortage columns. Migration 12 is now an idempotent ledger marker, while startup compatibility adds missing fields/indexes for older databases and repairs known checksums.
- Shift ownership now gates checkout, handover, wallet/notices/expenses/supplier/delivery cash movements, and debit-detail reporting. Delivery cash is attributed when collected, not when the invoice is created; zero-cash handover remains valid.
- System time is stored consistently in UTC and rendered once in local time. Customer debit calculations include sale returns and financial notices, and user notes appear in supplies/notices.
- Reorder alerts, low stock, and the shortage notebook are pharmacy-scoped and inventory-backed; draft/expired/foreign stock is excluded, notes persist, and selling the last valid unit adds the drug automatically.
- Patient credit limits are editable, patient deletion is covered, and purchase returns search by barcode or drug name while preserving the original invoice-item identity.

### Release boundary

- Both architectures behave the same in the executed Windows 11/WoW64 paths. A clean Windows 10 machine and Windows 7 x64/x86 machines were not available, so identical behavior on every Windows build is not proven.
- The executables import Universal CRT API sets. Windows 7 therefore needs its UCRT prerequisite, and it also needs a fixed compatible WebView2 109 runtime. The current `embedBootstrapper` configuration does not itself pin WebView2 to 109.
- Current 0.2.58 installers could not be rebundled locally because the environment blocked the WebView2 bootstrapper download. Existing 0.2.54 installers are historical and must not be released as current artifacts. The tagged GitHub workflow must produce and verify the x64/x86 installers; clean-VM upgrade/uninstall, fixed-runtime, signing, and updater tests remain release gates.
- Broad route rendering and regression coverage passed, but measured source coverage remains about 20%; unautomated control combinations and external cloud/update/WhatsApp dependencies remain coverage gaps. Consequently, x64/i686 core application builds are verified on this host, but neither architecture is yet safe to advertise as compatible with every Windows version, especially Windows 7.

---

## Retained v0.2.54 execution evidence (2026-08-18)

## 1. Executive result

Both x64 and i686 builds compile, start as real packaged Tauri applications on the test host, render the complete authenticated route set, communicate with the Rust/SQLite plugins, and can open the same migrated database across architecture changes. After remediation, both packaged architectures completed purchase → checkout → customer return with balanced accounting, reconciled stock and atomic audit rows.

The two business/security defects and the large-inventory DOM defect found in the first run are fixed and have packaged regressions on both architectures. The overall release gate still does **not** pass because the signed dual-architecture workflow has not produced a public release, Windows 7 itself was unavailable, and material UI/action coverage remains unexecuted.

Release verdict:

| Target | Verdict | Reason |
|---|---|---|
| Windows 10/11 x64 | **Release candidate only** | Shared Rust 1.77.2 baseline and reproduced defects pass; signed artifact/update recovery and incomplete UI/action coverage remain |
| Windows 10/11 x86 under WoW64 | **Release candidate only** | Packaged business parity passes; signed public x86 artifact/update entry still needs a tagged CI run |
| Windows 7 SP1 x86 | **Not safe for release** | Structurally compatible build produced, but no Windows 7 VM execution; UCRT/WebView2 prerequisites and signed installer must be proven on the target OS |
| Windows 7 SP1 x64 | **Not safe for release** | The x64 build now uses the same Rust 1.77.2 OS baseline and clean import set as x86, but no Windows 7 VM execution has occurred |

## 2. What was actually executed

### Frontend and static production build

- `npm run test:coverage -- --runInBand`: **60/60 suites passed**, **665 passed**, **1 skipped**.
- Coverage: **16.04% statements**, **13.72% branches**, **12.63% functions**, **16.23% lines**.
- `npx tsc --noEmit`: passed.
- `npm run lint`: passed with **0 errors and 24 React hook dependency warnings**.
- `npm run build:tauri`: passed; **71 generated pages / 67 application routes**.
- `node scripts/seed-db.js --dry-run`: parsed 25,115 master-drug and 191,541 interaction source rows.
- `npm run seed:db`: passed; published 25,092 master drugs and 191,272 interactions.

The action surface contains 219 exported functions in 27 modules. A direct-name scan found only 46 exports mentioned in test source; 173 are not directly named. This is a heuristic—indirect coverage can exist—but it agrees with the measured low coverage and prevents an “all actions tested” claim.

| Action module | Directly named / exports |
|---|---:|
| audit, auth, cogs, db | 0/2, 0/6, 0/2, 0/2 |
| config, delivery, expenses | 1/2, 0/3, 0/4 |
| finance, handover, interactions | 8/22, 2/4, 1/3 |
| inventory, labels, loyalty | 6/17, 0/2, 0/3 |
| master-drugs, patients | 5/58, 6/12 |
| purchase, purchases, reports | 0/3, 11/25, 0/4 |
| returns, sales-reports, sales | 1/7, 0/2, 4/7 |
| settings, settlement, shifts | 0/2, 0/5, 0/8 |
| shortages, sync, users | 0/2, 0/1, 1/11 |

### Rust/backend execution

- x64 `cargo test --all-targets`: **28/28 passed**.
- i686 `cargo test --all-targets --target i686-pc-windows-msvc` under Rust 1.77.2: **28/28 passed**, with the 32-bit test executable run through WoW64.
- `cargo fmt --check`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- Exercised backend cases include seed copy/recovery/Unicode paths, migration repair, bcrypt, checkout, negative stock, accounting, pharmacy scope, purchase lifecycle, customer returns, purchase returns, cumulative-return and concurrency checks.

### Real packaged application execution

A native-dependency-free CDP harness was added at `scripts/tauri-cdp-test.js`. It drove production WebView2 renderers and Tauri IPC; it did not substitute a browser-only Next.js server for the desktop app.

Executed on both x64 and i686 packaged executables:

- Two cold/warm launches per architecture; each remained alive for at least 15 seconds.
- Real login page rendered.
- Valid `admin/admin` login passed through frontend state → auth action → Tauri SQL/bcrypt IPC → SQLite → session storage → dashboard.
- Wrong-password response passed.
- Schema-compatibility IPC passed.
- Bcrypt true/false IPC passed.
- Guarded SQL rejected `SELECT`.
- Binary-file writer rejected a non-XLSX payload.
- Malformed checkout was rejected.
- All **63 authenticated static routes** rendered eventual nonfatal content on both architectures without a renderer runtime exception.
- `/purchases/edit-returns` and `/purchases/general-returns` intentionally redirected to `/purchases/returns`.
- `/purchases/general-returns/new` rendered its current “coming soon” placeholder, so that advertised path is not implemented as a working feature.

The route sweep proves packaging, routing, module loading and first-render data queries. It does **not** prove every control within those pages.

### Packaged critical business flow

On both x64 and i686 packaged executables, direct Tauri IPC and the real migrated SQLite database executed:

1. Normalize/create one open shift and supplier fixture.
2. `save_purchase_invoice_critical`: committed total **22.589** and created inventory.
3. `process_checkout_critical`: committed sale total **15**.
4. `create_return_critical`: committed customer return total **15**.
5. Duplicate cumulative return: rejected.
6. Wrong-pharmacy checkout: rejected.
7. Final stock: reconciled to **2**.
8. Supplier cash history: 2 rows, net 0, balance 0.
9. Purchase cash movement: 1 row, 22.589.
10. Unbalanced journal count: **0**.
11. Audit actions: exactly the required `COMPLETE_PURCHASE`, `COMPLETE_SALE`, and `CREATE_RETURN` events were present.

This proves packaged IPC → Rust command → transaction/business rules → SQLite → returned result. The purchase/POS/return page controls were separately rendered and their frontend logic has Jest coverage, but this run did not drive those complete transactions exclusively by clicking all UI controls; therefore the full user-action chain remains partial.

### Persistence and cross-architecture behavior

- x64 created the isolated application database and applied all 9 migrations.
- i686 then opened and reused that exact database successfully.
- Both architectures restarted successfully against persisted state.
- Final database checks: `integrity_check=ok`, 0 foreign-key violations, 9 successful migrations, one admin, master/FTS row parity, and no unintended original business data.

### Production installers and native binaries

| Artifact | Result | Size | SHA-256 |
|---|---|---:|---|
| x64 NSIS `Pharmacy Local Enforcer_0.2.54_x64-setup.exe` | Rust 1.77.2, embedded WebView bootstrapper | 15,560,392 | `5513EF67102D6CC443B7CD854861E6E92962A89FA11BA14A9B4A37F93CE0D906` |
| x86 NSIS `Pharmacy Local Enforcer_0.2.54_x86-setup.exe` | Rust 1.77.2, embedded WebView bootstrapper | 14,950,957 | `537B5CA180B99AFECD71F2FC87FB0CA4239495D2A7006397F2F56CABCAF43D06` |

PE/import inspection:

- x64 application: PE machine `0x8664`, Windows GUI subsystem 6.00.
- i686 application: PE machine `0x014c`, Windows GUI subsystem 6.00.
- NSIS installers: expected 32-bit NSIS stub (`0x014c`, subsystem 4.00).
- The rebuilt Rust 1.77.2 x64 executable no longer imports `bcryptprimitives.dll` or `api-ms-win-core-synch-l1-2-0.dll`; the release import check also rejects dynamic `VCRUNTIME*.dll` and `MSVCP*.dll` dependencies.
- Both executables import Universal CRT API sets, so Windows 7 requires the applicable UCRT update (normally KB2999226).
- Both installer paths embed the WebView2 bootstrapper and require at least WebView2 `109.0.1518.140`. A target-machine run is still necessary to prove WebView2 109 installation/use on Windows 7.
- No wrong-architecture bundled DLL or executable was found.
- Local builds are Authenticode `NotSigned`, as expected without release secrets. The edited release workflow requires and verifies certificate signing, but that workflow has not been executed for the uncommitted x86 changes.

The production `installMode: "both"` silent installer requested elevation and was cancelled by the host UAC boundary, so that exact admin/per-user choice flow was not completed. An otherwise-equivalent isolated `currentUser` i686 installer was built and executed:

- Silent `/S` install passed.
- Installed executable and seed database matched the package.
- Desktop and Start Menu shortcuts were created.
- Installed payload launched twice and migrated the database.
- Silent uninstall returned 0 and removed files/shortcuts.
- Application data was retained, matching the current retention behavior.
- The uninstall registry entry could not be observed in this environment and remains unverified.

### Live updater/release channel

The public 0.2.54 release endpoint was queried on 2026-08-18:

- Manifest version and GitHub tag agree: `0.2.54` / `v0.2.54`.
- All published manifest records contain download URLs and Tauri updater signatures.
- The manifest contains only `windows-x86_64`, `windows-x86_64-nsis`, and `windows-x86_64-msi`.
- The release has five assets, all manifest/x64 installer/MSI/signature files.
- **No i686 manifest record or x86 installer is currently published.**

The working tree now uses `tauri-action@v1` for both sequential jobs and fails the release unless the final manifest contains complete `windows-x86_64-nsis` and `windows-i686-nsis` entries. Those changes are not in the current public release. The updater download/install/relaunch, invalid-signature, interrupted-download, rollback and UAC recovery cases were not safely executed.

## 3. Baseline traceability result

Status meanings: **Pass** = the planned critical behavior was executed sufficiently for this environment; **Partial** = meaningful executable evidence exists but the whole options/UI matrix was not executed; **Fail** = a reproduced defect violates the plan; **Blocked** = required environment/dependency was unavailable.

| ID/group | Result | Executed evidence / gap |
|---|---|---|
| LIF-01 startup/seed | Pass on host; Win7 blocked | Real x64/i686 first launch, copy, restart, Unicode Rust cases |
| LIF-02 migrations | Pass on host | 9 migrations, fresh/repaired/idempotent Rust and packaged DB checks |
| DB-01 read bridge | Pass | Real packaged SQL reads, singleton schema initialization, route queries |
| DB-02 writes/transactions | Partial | Guarded verbs and critical commits/rollbacks passed; two-window locking/shutdown not run |
| AUTH-01 login/session | Pass on host | Valid/wrong-password/restart and nullable-actor nonexistent-user audit pass on both packages |
| AUTH-02 roles/permissions | Partial | Route guards and wrong-pharmacy IPC passed; every role/key/live permission change not run |
| SYNC-01 cloud sync | Blocked | No authenticated staging Supabase account or deterministic cloud fixture |
| DASH-01 dashboard/news/status | Partial | Both architectures rendered/query-loaded; KPI reconciliation and all failure/polling cases not run |
| POS-01 search/cart/drafts | Partial | Tests, FTS data and page render; full barcode/unit/draft/rapid-key UI matrix not driven |
| POS-02 checkout | Partial | x64/i686 packaged critical checkout and audit pass; every payment/patient/discount UI path not run |
| SAL-01 invoice/receipt/share | Partial | Routes/tests rendered; physical print, WhatsApp and popup variants not run |
| SAL-02 delivery/COGS/settlement | Partial | Existing automated logic and route render; complete closeout/idempotency UI flows not run |
| RET-01 customer returns | Partial | Packaged x64 return, duplicate rejection and i686 tests passed; full UI/refund matrix not run |
| INV-01 CRUD/import/export | Partial | Seed/FTS/routes/tests; real XLSX/file-dialog/permission matrix not completed |
| INV-02 alerts/movements | Partial | Routes and current automated cases; time-driven polling/dismiss combinations not completed |
| INV-03 opening/restock/shortage | Partial | Routes/tests; full draft/complete/print flow not completed |
| MST-01 master data | Partial | 25,092 seeded rows, FTS parity, routes/tests; all 58 exports/CRUD relations not completed |
| PUR-01 supplier/order | Partial | Supplier fixture/history invariants and routes/tests; every CRUD/status path not completed |
| PUR-02 purchase invoice | Partial | Packaged final invoice + accounting passed; draft/edit/delete and all units/taxes UI paths not completed |
| PUR-03 supplier return | Partial | x64/i686 Rust concurrency/business tests; packaged UI flow not completed |
| PAT-01 patient/loyalty | Partial | Routes/tests; every clinical, wallet, points and statement path not completed |
| FIN-01 accounts/journals/cash | Partial | Packaged balanced journals/cash invariants; full hierarchy/payment-instrument UI matrix not completed |
| FIN-02 trial/expenses/snapshot | Partial | Existing automated logic and routes; print/filter/delete matrix not completed |
| SHF-01 shift/handover | Partial | One-open shift used and tests passed; UI forced-close/concurrent cashier matrix not completed |
| REP-01 reports | Partial | All report routes rendered; source reconciliation/time-zone/large-print matrix not completed |
| STF-01 staff/permissions | Partial | Routes/tests; full user/job/salary/escalation flow not completed |
| AUD-01 audit | Partial | Atomic purchase/checkout/return rows pass on both packages; full action/failure/retention matrix remains |
| SET-01 settings/labels/maintenance | Partial | Routes rendered; every persistence/cloud divergence/backup/template path not completed |
| EVT-01 native/browser events | Partial | Navigation and renderer event stability passed; payload/order/window-recreate matrix not completed |
| WIN-01 windows | Blocked | No automated multi-window/DPI VM harness; only main-window launch/close/restart executed |
| NET-01 external services | Partial | Live GitHub manifest and news-render path exercised; Supabase/DNS/timeout/CSP matrix not completed |
| SEC-01 IPC/files/capabilities | Partial | Direct guarded SQL, malformed checkout, wrong pharmacy and binary-file rejection passed; full fuzz/path matrix not run |
| INS-01 install/uninstall | Partial | Isolated x86 current-user lifecycle passed; production `both` UAC, x64 install, Win7 install blocked |
| UPD-01 update/relaunch | **Fail/blocked** | Live channel lacks x86; actual signed update/install/recovery was not run |
| PERF-01 performance | Partial | Delete-items is paged and mounts 111 total controls on x64/i686; repeat/leak/low-tier budgets not run |
| LOC-01 locale/DPI/a11y | Partial | Arabic/RTL rendered, Unicode backend cases passed; Win7/DPI/keyboard/screen-reader matrix not completed |

## 4. Reproduced defects and root causes

### Fixed P0 — nonexistent-user login was converted into an unexpected database error

**Reproduction:** submit a username that is not in `users` through the real packaged login form on either architecture.

**Observed:** the missing-user branch attempts to insert `activity_log.user_id = 'unknown'`; `activity_log.user_id` has a foreign key to `users`. SQLite rejects the insert with code 787. The user sees an unexpected-error path instead of “user not found,” and no failed-login audit record is retained.

**Root:** `src/lib/auth/local.ts` records an impossible sentinel foreign key before returning the intended authentication result.

**Fix/verification:** the audit uses the schema-valid nullable actor. A Jest regression plus real packaged x64 and i686 login now return the intended missing-user message and retain the failed attempt without FK error 787.

### Fixed P0 — purchase and checkout critical paths bypassed application audit logging

**Reproduction:** execute packaged `save_purchase_invoice_critical`, `process_checkout_critical`, and `create_return_critical`, then query `activity_log`.

**Observed:** only `CREATE_RETURN` is recorded. The purchase and checkout commits have no corresponding success audit rows.

**Root:** the Tauri branches return after invoking the critical Rust commands, before the non-Tauri `logActivity` code. A sales audit helper exists but is not connected to the critical packaged branch.

**Affected:** financial traceability, stock change attribution, incident review and the audit screen.

**Fix/verification:** completed purchase and checkout now insert `COMPLETE_PURCHASE`/`EDIT_COMPLETED_PURCHASE` and `COMPLETE_SALE` inside the same Rust transaction. Rust regressions and packaged x64/i686 purchase → checkout → return flows prove all three success events and rollback coupling.

### P0 release — no x86 artifact/update entry exists in the live release

**Reproduction:** inspect the 0.2.54 GitHub assets and `latest.json`.

**Observed:** x64 only. An installed x86 application cannot obtain an architecture-correct update from the current channel.

**Root:** i686 build/publish support exists only in working-tree workflow changes and has not produced a public release. The two-job manifest merge behavior must also be verified so the second job does not overwrite the first manifest.

**Regression/release test:** after a tagged dry run, validate that one final `latest.json` contains both `windows-x86_64-*` and the correct i686 key, that every URL resolves, and that both signatures validate with the configured public key.

### Fixed P1 — delete-items route eagerly rendered the full production catalogue

**Reproduction:** open `/stores/delete-items` with the seeded catalogue.

**Observed:** approximately 2,265,868 body characters and 25,101 interactive controls are rendered. The route remained alive on the current x64 host, but this is a significant startup, accessibility and 32-bit address-space risk.

**Root:** the complete ~25k-row catalogue is mounted without paging or virtualization.

**Fix/verification:** native client-side pagination mounts at most 100 item rows while preserving search/filter/page access. The component regression passes and both packaged architectures now render 111 total controls including the application shell, down from about 25,101.

### P2 — frontend quality findings

- Login inputs now provide `autocomplete="username"` and `autocomplete="current-password"`.
- Lint emits 24 exhaustive-dependency warnings. No error was produced, but affected polling/fetching components need stale-closure and cleanup review.
- The general-purchase-return “new” route is a visible placeholder rather than a completed action.

## 5. Native and Windows 7 risks

Both x64 and i686 executables now use Rust 1.77.2 and Windows 7-compatible PE/import baselines; i686 additionally forces a static CRT. This is necessary but not sufficient evidence for Windows 7 compatibility.

Required target-machine gates:

1. Clean Windows 7 SP1 x86 and x64 VMs with no developer tools, plus clean Windows 10 and 11 VMs for parity.
2. Apply/verify Universal CRT prerequisite, then test absent/present/broken WebView2 Runtime states.
3. Install the Authenticode-signed i686 NSIS artifact through normal UI and `/S` modes.
4. Confirm WebView2 109 starts and the app does not auto-upgrade to an incompatible runtime.
5. Run login, purchase, checkout, return, inventory import/export, printing, restart, update and uninstall flows.
6. Inspect loaded modules at runtime to prove that every native DLL is i686 and comes from the installer/system, not the development machine.
7. Exercise standard-user/admin, non-ASCII/long paths, low RAM, 100–200% DPI and offline behavior.

Until those gates pass, “Windows 7 compatible” remains an implementation target, not a verified release property.

## 6. Tests not executed and why

- Windows 7 x86 VM and real 32-bit hardware: unavailable in this environment.
- x64 clean-machine installer lifecycle: production `both` installer hit UAC; no disposable elevated VM was available.
- Production signed artifacts: signing secrets are unavailable locally; the live release predates the x86 workflow.
- Full updater install/relaunch/rollback/signature-tamper matrix: would mutate the installed app and needs a signed disposable release channel/VM.
- Authenticated Supabase sync, staff deactivation and partial cloud failures: no staging account/fixtures were provided.
- Physical receipt/label printers, barcode scanner, WhatsApp handler and external-app integration: hardware/handlers unavailable.
- Multi-window concurrency, mixed-DPI monitors and focus/menu ordering: no desktop automation/VM matrix was available.
- Eight-hour soak, 100-repeat workload and low-tier performance budgets: time/hardware unavailable; the large-DOM issue already fails the intended risk gate.
- Every click/field/option across 67 routes: no existing desktop E2E suite models that surface, and the measured unit coverage is too low to substitute for it.

## 7. Remaining coverage needed before release

1. Add page-object desktop E2E coverage for the 12 baseline workflows, including all payment, unit, return, permission and failure variants.
2. Raise action/business coverage, prioritizing the 173 exports not directly named by tests and the graph hotspots (`db/tauri.ts`, POS, purchase return/invoice, staff, inventory and finance clients).
3. Publish a signed release candidate with both architectures and test the merged updater manifest.
4. Run the complete clean-VM matrix: Windows 11/10 x64 and x86/WoW64 plus Windows 7 SP1 x86.
5. Add low-memory i686 repeat/leak performance tests for the paged full-catalogue screen.
6. Complete authenticated cloud, hardware, printing, multi-window, DPI, accessibility and update recovery testing.

## 8. Test-data cleanup

All four isolated `com.pharma.system.codexsmoke` / `com.pharma.system.codexinstaller` AppData trees and their temporary installed files/shortcuts were permanently removed after the run. Production `com.pharma.system` data was not touched. The normal production application identifiers were rebuilt into both loose target executables after testing.
