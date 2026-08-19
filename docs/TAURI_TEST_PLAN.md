# Tauri application test plan

Status: repository-derived plan for v0.2.54. This document describes tests; it does not change production behavior.

## Review basis

The plan was built from the current implementation, including the uncommitted Windows-hardening changes present during review. The inspected surface comprised 67 `page.tsx` routes, 93 React components, 27 desktop action modules, 15 registered Tauri commands, nine Rust migrations, the bundled seed database, build/seeding scripts, capabilities, installer/updater configuration, 58 Jest suites, 28 Rust tests, and both GitHub workflows.

Current executable baseline:

- Jest: 58 suites passed; 663 tests passed and one skipped.
- Rust: 28 tests passed.
- Jest coverage: 15.92% statements, 13.58% branches, 12.50% functions, and 16.11% lines. The configured thresholds are all zero.
- Bundled seed: approximately 53 MiB, about 25,000 master drugs and 191,000 interactions. The root development database is separate and approximately 96 MiB.

## 1. Application architecture summary

The desktop product is a Tauri 2 shell around a statically exported Next.js 15/React 19 frontend. `next.config.js` aliases imports from `@/app/actions` to `src/app/actions-client` for Tauri builds. Consequently, most application behavior is TypeScript issuing SQLite reads through `tauri-plugin-sql` and writes through `db_execute_guarded`; only the money/stock-critical workflows have dedicated Rust commands.

The principal layers are:

1. **Desktop lifecycle:** `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, and `src-tauri/capabilities/default.json`. One configured main window can create additional dashboard windows. Native menus emit window-scoped navigation/action events. There is no tray, single-instance plugin, autostart, notification plugin, clipboard plugin, window-state persistence, service, or background process.
2. **Persistence:** `src-tauri/migrations/001_initial.sql` through `009_rebuild_master_drugs_fts.sql`, `src-tauri/src/schema.rs`, and the bundled `src-tauri/pharma_local.db`. SQLite WAL, foreign keys, and a 5-second busy timeout are used by Rust connections. First launch copies the seed into Tauri app data.
3. **Database bridge:** `src/lib/db/tauri.ts` selects through the SQL plugin and serializes TypeScript transactions through `db_transaction_begin`, `db_execute_guarded`, and `db_transaction_finish`. Web/test mode instead uses `better-sqlite3`, so both adapters must be tested independently.
4. **Critical Rust workflows:** `src-tauri/src/commands/critical.rs` handles checkout, purchase create/update/delete, sales return, negative-stock settlement, and guarded SQL. `purchase_returns.rs` handles supplier returns under `BEGIN IMMEDIATE`. `auth.rs` supplies bcrypt.
5. **Frontend state:** component state, `secureCache` for master-drug metadata, persisted Zustand POS state (`pharma_pos_draft_v1`), session/local preferences in `localStorage`, and SQLite for business state.
6. **Cloud boundary:** Supabase authentication/profile sync, incremental drug/interaction/staff sync, public news JSON, GitHub update metadata, WhatsApp links, and the external calculator link. Normal sales and inventory operation are local after synchronization.
7. **Distribution:** Windows x64 MSI and NSIS, WebView2 download bootstrapper, signed updater artifacts, and a release workflow on `windows-2022`. `scripts/build-tauri.js` temporarily moves server-only routes/middleware and copies desktop actions before static export. `scripts/seed-db.js` rebuilds and validates the seed.

## 2. Complete feature inventory

### Routes and user-visible modules

| Area | Implemented routes and behavior |
|---|---|
| Entry and access | `/login` local login plus first cloud sync; `/setup` redirects to login; `/subscription` is currently a simulated activation with a skip path; `/unauthorized`; not-found page; `AuthGuard`, `PermissionGuard`, and timed `AccessDenied` redirect. |
| Dashboard | `/`; sales KPIs/trends/top items; expiry, dead-stock, reorder and header alerts; news bar; shift and subscription status; cloud drug/interaction sync; theme; online/sync state; update action. |
| Point of sale | `/pos`; drug/name/barcode search, patient search, cart, unit and batch selection, negative stock, quantity/price/line discount, invoice discount/fees, cash/credit/check/visa/delivery/wallet payment, drafts, interaction and stock warnings, checkout, receipt/auto-print, quick drug details, shortages, customer return launcher, drawer handover, external calculator. |
| Sales | `/sales`, `/receipts`, `/sales/delivery`, `/sales/cogs`, `/sales/settlement`, `/returns`, `/returns/new`, `/reports/sales`; invoice search/detail/print/WhatsApp, delivery closeout and representative cash, COGS edits, negative-stock reconciliation, returns and patient-account refunds. |
| Inventory | `/inventory`, `/inventory/low-stock`, `/inventory/item-movements`, `/inventory/opening-balances`, `/inventory/opening-balances/new`, `/inventory/settlement`, `/restock`; batch CRUD, XLSX import/export, expiry/barcode/conversion/prices, low stock, movements, opening stock, negative stock, reorder quantities, alerts. |
| Master data | `/stores`, `/stores/items`, `/stores/categories`, `/stores/nature`, `/stores/usage`, `/stores/units`, `/stores/indications`, `/stores/drug-indications`, `/stores/manufacturers`, `/stores/scientific-groups`, `/stores/alternatives`, `/stores/adjustments`, `/stores/adjustment-reasons`, `/stores/shortages`, `/stores/delete-items`, `/interactions`; bilingual CRUD, FTS search, drug relationships, adjustment reasons, shortages and safe unused-item deletion. |
| Purchases | `/purchases`, `/purchases/new`, `/purchases/reports`, `/reports/purchases`, `/purchase-orders`, `/purchases/suppliers`, `/purchases/returns`, `/purchases/returns/new`; supplier CRUD/payment/history, invoice draft/final/edit/delete, units/bonus/tax/discount/expenses/checks, batch creation, barcode printing, orders, supplier returns and accounting. `/purchases/edit-returns` and `/purchases/general-returns` redirect; `/purchases/general-returns/new` is a nonfunctional coming-soon page. |
| Patients | `/patients`; create/edit/delete, search, profiles, allergies, conditions, credit limits, opening balance, wallet, loyalty, financial notices/payments, purchase history, statement and WhatsApp-linked receipts. |
| Finance | `/accounts`, `/accounts/cash-transactions`, `/finance/accounts`, `/finance/banks`, `/finance/cards`, `/finance/pos-management`, `/finance/handover`, `/accounts/settings/trial-balance`, `/reports/trial-balance`, `/expenses`; account tree, banks/cards/POS, journals, cash movements, notices, expenses, snapshots, trial-balance mappings/report, drawer handover. |
| Shifts | `/shifts`, `/shifts/report`; open/start, current statistics, close/end, discrepancy, forced close, handover linkage and reports. |
| Staff and audit | `/staff`, `/staff/manage`, `/staff/roles`, `/audit`; analytics, user CRUD, activation, roles, detailed permissions, employment/demographic fields, password reset, job/salary CRUD, audit filters and purge. |
| Settings | `/settings`; pharmacy/legal/owner/manager details, cloud sync, database maintenance, label templates/designer, local users, subscription card. Some label-designer buttons are visual-only and must be classified as disabled/not implemented rather than accepted as working. |
| Desktop chrome | Sidebar and React menu filtered by role/permissions; native menu; print/logout/about/shortcuts/update actions; Ctrl+P/I/O/D/N, F1, POS Ctrl+S/Insert/F2/F9, and purchase F2/F4/F9/F10; multiple windows. |

### Desktop action-module inventory

Every exported action below needs at least a contract test against the current migrations; mutation groups also need rollback/permission tests.

| Module | Exported behavior |
|---|---|
| `auth.ts` | `loginLocalAction`, `loginCloudAction`, `getCurrentUserAction`, `getLocalSessionAction`, `logoutLocalAction`, `getLocalUsersAction`. |
| `sales.ts` | `searchDrugsAction`, `searchPatientsAction`, `barcodeLookupAction`, `fetchDraftsAction`, `processCheckoutAction`, `getSalesDashboardStatsAction`, `getRelevanceScore`. |
| `returns.ts` | `getSalesInvoicesByDateAction`, `createReturnAction`, `getReturnsAction`, `searchInvoicesForReturnAction`, `searchRecentReturnInvoicesAction`, `getInvoiceForReturnAction`, `createGeneralReturnAction`. |
| `inventory.ts` | inventory CRUD; interaction/clinical checks; low-stock and alerts; negative-stock settlement; detail/list/movements/opening balances/restock/adjustments; unused-drug listing and deletion. |
| `master-drugs.ts` | master-drug CRUD/search; units, categories, alternatives, indications, scientific groups, natures, usage methods, adjustment reasons and manufacturers; bilingual update/delete; drug-indication/alternative/interaction links; opening balances; shortages; stock adjustment; relevance score. |
| `purchases.ts` | supplier CRUD/payment/transactions; invoice list/create/item/complete/detail/edit/delete/drafts; pending-invoice check; drug purchase history; orders; reports; purchase returns/details; inventory quantity. |
| `purchase.ts` | order create/list/status, a second implementation that must remain behaviorally equivalent to the corresponding `purchases.ts` functions. |
| `finance.ts` | financial notices and patient payments; cash movements; POS, expense definitions, banks, papers, cards and accounts; account CRUD; journals/details; seed test data; daily snapshot; trial-balance settings/save/report; patient statements; notices and activity logs. |
| `expenses.ts` | add/list/delete/summary. |
| `handover.ts` | handover details/process/open handover/shift credit sales. |
| `delivery.ts` | pending deliveries, close delivery, representative cash statement. |
| `cogs.ts` | sold-item lookup and cost update. |
| `settlement.ts` | negative-stock invoices, bulk settlement, unsettled sales, batches, individual settlement. |
| `patients.ts` | patient CRUD/search/profile; allergy/condition add/delete; statement, wallet, list, receipt detail. |
| `loyalty.ts` | award, redeem, and balance/history. |
| `shifts.ts` | open/close/list/current/current stats/start/end/force-close. The duplicated open/start and close/end contracts need equivalence tests. |
| `users.ts` | permissions, staff user CRUD/list, jobs CRUD, password reset, management data and performance. |
| `audit.ts` | list and clear audit logs. |
| `reports.ts` | shift report, dashboard KPIs, sales trend, reports dashboard. |
| `sales-reports.ts` | filtered sales reports and invoice detail. |
| `interactions.ts` | interaction check/list/add. |
| `shortages.ts` | add and smart shortage list. |
| `config.ts` | config read/write. |
| `settings.ts` | pharmacy update and database maintenance. |
| `labels.ts` | template list/save/default behavior. |
| `sync.ts` | authenticated incremental cloud sync. |
| `db.ts` | web-only select/execute bridge; it is not the desktop write boundary. |

### Registered Tauri commands

| Command | Caller | Required command-level tests |
|---|---|---|
| `bcrypt_hash` | `lib/auth/local.ts` | Unicode, empty, long bcrypt boundary, cost, nondeterministic salts, native error propagation. |
| `bcrypt_compare` | same | correct/wrong password, malformed hash, Unicode and bcrypt maximum-length behavior. |
| `db_execute_guarded` | `lib/db/tauri.ts` | each allowed verb; blocked SELECT/PRAGMA/DROP/ATTACH/extension/multiple statements; parameter types; unknown/closed transaction; locked DB; row count/insert ID. |
| `db_transaction_begin` | transaction bridge | unique IDs, `BEGIN IMMEDIATE`, two concurrent callers, 5-second timeout, shutdown with an open transaction. |
| `db_transaction_finish` | transaction bridge | commit, rollback, repeat finish, unknown ID, SQL failure, connection removal. |
| `process_checkout_critical` | `actions-client/sales.ts` | all payment/unit/batch paths, empty cart, patient requirements, stock and permission invariants, rollback at every write stage, double submit. |
| `save_purchase_invoice_critical` | `actions-client/purchases.ts` | draft/final/update, numeric-string deserialization, dates, supplier/user/pharmacy permission, stock/accounting, duplicate invoice, rollback. |
| `delete_purchase_invoice_critical` | purchase reports/actions | draft/completed; retain/remove inventory; finalized return blocks deletion; accounting reversal; wrong user/pharmacy; repeat delete. |
| `create_return_critical` | `actions-client/returns.ts` | full/partial/multi-unit, cash/patient account, over-return/duplicate line/wrong invoice, original batch restoration, accounting and rollback. |
| `settle_negative_sale_item_critical` | `actions-client/settlement.ts` | valid lot, wrong pharmacy/user/item, insufficient lot, repeated/concurrent settlement, COGS journal idempotency. |
| `create_purchase_return_critical` | `actions-client/purchases.ts` | cash/credit, units, tax/discount allocation, supplier/user/pharmacy validation, over/duplicate/concurrent return, inventory and accounting rollback. |
| `ensure_schema_compatibility` | DB initialization | blank/current/untracked seed, v0.2.14, v0.2.39, unknown checksum, failed DDL, lock, idempotent rerun. |
| `open_new_window` | Ctrl+N/native menu | unique label, route, size/minimum, menu attachment, failure, multiple windows, event isolation. |
| `log_frontend_error` | initializer/layout/auth guard | Unicode/long payload, high rate, no secret/session leakage. |
| `write_binary_file` | inventory XLSX export | valid XLSX, wrong extension/content, zero-byte, missing/read-only/locked/deep/Unicode path, symlink overwrite, disk full and cancellation. |

### Events, plugins, and managed state

- Native `menu-navigate` must be tested for every route in `handle_menu_event`, focused-window delivery, duplicate listeners, listener cleanup, fast repeated events, and a destroyed/recreated secondary window.
- Native `menu-action` payloads are `print`, `logout`, `update`, `shortcuts`, and `about`. Verify one receiver per focused window and no cross-window action.
- Browser events are `news-bar-state-changed` and `news-bar-toggle`; verify local-storage synchronization and listener cleanup.
- Plugins actually initialized: SQL, dialog, updater, process, and shell. Dialog is used by export/update; process only by updater relaunch; shell capability exists but no plugin API call was found. Test that unused shell power is not accidentally reachable.
- Rust-managed state is only `DbTransactions`. Frontend shared state is `secureCache`, persisted POS Zustand state, session/local settings, and the module-global transaction queue/active transaction ID.

## 3. Existing test coverage

Strong existing coverage:

- Rust unit/integration tests cover bcrypt, guarded SQL tokens, numeric deserialization, checkout totals/units/wallet, purchase stock/accounting/delete/return lifecycles, negative-stock idempotency, concurrent supplier return serialization, seed copy, XLSX validation, and legacy v0.2.14/v0.2.39 schema repair.
- Jest SQL suites cover substantial inventory, sales, purchases, returns, finance, patients, shifts, permissions, import, and accounting math.
- Regression suites execute selected production action functions for deletion, supplier rules, purchases, handover, patient statements, import, Tauri payloads, and receipt display.
- Configuration tests inspect Tauri size, CSP, updater, SQL and resources; menu-route tests compare route maps.

Partial or misleading coverage:

- Many files named `e2e`, `integration`, or `exhaustive` construct bespoke in-memory `better-sqlite3` schemas and execute test-authored SQL. They validate rules but not the packaged app, plugin IPC, real route components, or current migration parity.
- `tauri-db.test.ts` normally sees Jest/server mode and mocks adapters; it does not drive a real WebView or Rust command boundary.
- UI coverage is concentrated in one button, barcode focus, receipt auto-print, and one report display regression. Most forms, dialogs, loading/error/empty states and permission redirects are unrendered.
- Tauri config tests assert static JSON, not effective capabilities or signed update installation.

Completely untested categories:

- Packaged desktop launch and first-run seed extraction.
- MSI/NSIS install, uninstall, reinstall, shortcuts, WebView2 bootstrap and standard-user behavior.
- Signed updater, relaunch, interrupted update and clean-install parity.
- Native menus, additional windows, focused-window event routing and real printing/dialogs.
- Full Supabase sync, news/GitHub/WhatsApp network failures, CSP behavior in the packaged WebView.
- DPI, multiple monitors, accessibility, localization, slow hardware and long-running resource behavior.

## 4. Testing gaps and testability findings

1. **P0 — no packaged smoke test.** A green CI run can still ship an app that cannot launch, find its seed, load WebView2, migrate, or invoke Rust.
2. **P0 — two database execution models.** Tests heavily exercise `better-sqlite3`, while production desktop reads through the SQL plugin and writes through Rust/sqlx. Contract parity is not enforced.
3. **P0 — permission enforcement is distributed.** Menus, pages, actions and a subset of Rust workflows each interpret roles/JSON permissions. A hidden link test is insufficient; direct action and direct IPC calls must be denied.
4. **P0 — transaction bridge concurrency.** `activeTauriTransactionId` is module-global and nested work joins the active transaction. The global queue protects top-level calls, but multiple windows and unexpected callbacks need real-runtime tests.
5. **P0 — install/update lifecycle is manual.** The seed, user database, migration ledger, signed bundle and updater have no automated lifecycle fixture.
6. **P1 — broad UI gap.** Coverage confirms most routes/components have no rendered tests, including primary POS, purchase, staff, finance and settings forms.
7. **P1 — startup degrades silently.** `secureCache.load()` catches its own error, and date-normalization writes are ignored. Test the resulting user experience and diagnostic output.
8. **P1 — cloud sync is multi-stage without one enclosing transaction.** Inject failure after profile, drug, interaction and staff stages and verify sync metadata never advances past unapplied data.
9. **P1 — build mutates source paths temporarily.** Kill `build-tauri.js` at each move/copy point and verify cleanup/restoration.
10. **P1 — subscription is demonstrative.** Any ID of length five is accepted and activation can be skipped. Tests must document this as current behavior; it must not be used as a security acceptance gate.
11. **P2 — misleading UI claims.** `AccessDenied` says the attempt was logged but contains no audit write. About/version fallbacks include stale hard-coded versions. Add assertions so claims cannot drift from behavior.
12. **P2 — duplicated APIs/routes.** `purchase.ts` versus `purchases.ts`, shift open/start and close/end, duplicate return routes, and three menu implementations need equivalence tests or future consolidation.

## 5. Module-by-module testing plan

For every row, automated tests must cover success, boundary/empty/invalid input, backend error, loading/disabled state, cancellation where offered, repeat action, stale/unexpected response, authorization, and persistence after restart. The scenarios column adds implementation-specific cases.

| Module | Purpose and files | Implementation-aware scenarios | Automation | Manual |
|---|---|---|---|---|
| Startup/cache | `main.rs`, `schema.rs`, `AppInitializer.tsx`, `secure_cache.ts` | missing/zero/partial/corrupt/read-only/locked seed; stale `.installing`; unknown migration checksum; cache query failure/retry; 25k drugs; date conversion; simultaneous windows | Rust temp-file tests; Tauri launch integration | first launch on HDD, antivirus lock, crash during copy |
| Authentication/access | `login`, `AuthGuard`, `PermissionGuard`, `auth/local.ts` | first password creation; wrong/inactive/deleted user; corrupt session JSON; role/permission changes while open; logout with open shift; direct protected URL/action/IPC | Jest components/actions + packaged smoke | Windows credential entry, Arabic keyboard, focus/order |
| Cloud sync | `sync/client.ts`, login/settings sync buttons | unauthenticated; missing pharmacy; pagination at 999/1000/1001; duplicate IDs; incremental timestamps; partial drug/interaction/staff failure; user deactivation; retry/offline | mocked Supabase contract + temp SQLite integration | real staging tenant and proxy/firewall |
| Dashboard/status | dashboard page/widgets, news, alerts, theme/network/sync | empty/partial/large KPI data; malformed news; dismiss/restore; five-minute polling cleanup; offline/online; dark mode persistence | component tests with fake timers | chart rendering/DPI and network transition |
| POS | `pos/page.tsx`, `usePOSStore`, sales/actions, critical checkout | barcode/name/Arabic search; same drug/multiple batches; units; expired/other pharmacy; no stock warning; discounts/fees; every payment; patient limits/wallet/points; drafts; rapid/double checkout; interaction gate; receipt | calculation/action/Rust tests + component workflow + packaged critical E2E | scanner hardware, printer, slow HDD, keyboard-only cashier |
| Sales/receipts | sales, receipts, delivery, COGS, settlement | filters/details; print/WhatsApp without phone; delivery payment/representative; valid/invalid COGS; batch settlement/idempotency | action integration + components | printer drivers, WhatsApp external launch |
| Customer returns | `returns.ts`, `SalesReturnClient`, Rust return command | invoice/date search; full/partial/multi-unit; previously returned quantity; cash vs patient account; wrong patient/pharmacy; concurrent returns; accounting/stock rollback | Rust and action integration + component | real receipt-led flow |
| Inventory | inventory actions/pages/modals | CRUD and reasons; conversion/prices; duplicate/displaced barcode; XLSX variants; batch/expiry; low/zero/negative; alerts/dismissals; movements; deletion constraints; cache coherence | current-migration SQLite actions + components; command file tests | large workbook, locked files, network/removable drive |
| Master data | `master-drugs.ts`, stores pages | bilingual CRUD/search; FTS trigger consistency; relationships and duplicates; stop-dealing/service flags; hierarchy; referenced deletion; bulk name migration | integration against migration DB + representative components | Arabic IME, large lists/context menu |
| Opening/restock/shortages | opening pages, restock clients, shortages | draft/complete; duplicate items; price mapping; smart suggestions; status lifecycle; partial restock; print | action integration + components | printed shortage sheet |
| Purchases | purchase pages/actions/Rust | supplier and permissions; draft/final/edit; batch identity; units/bonus/taxes/discount/expenses; cash/credit/check; barcode print; order status; delete with/without inventory; concurrent submit | Rust critical tests, action integration, main component workflow | barcode labels and high-volume invoice entry |
| Supplier returns | `PurchaseReturnClient`, `purchase_returns.rs` | invoice ownership; paid-unit conversion; cash/credit; over/duplicate/concurrent return; missing lot/supplier/user/account; journal balance | Rust temp-DB + component | user workflow and print |
| Patients/loyalty | patient actions/modals | CRUD and linked-delete block; clinical profile ownership; wallet/credit/notice/payment/points; statement after returns; limits; duplicate phone/name | action integration + components | Arabic names/phones and long history UX |
| Finance | finance actions/clients | account hierarchy; balanced/unbalanced journals; bank/card/POS; cash categories; papers; notices; snapshots; filters; trial mapping combinations; cross-module journals | current-schema action integration + selected components | printed statements/reports; accountant review |
| Expenses | expense actions/client | definition, amount/date/category, delete permission, summary/filter, cash/journal impact | action + component | receipt comparison |
| Shifts/handover | shifts/handover actions and modals | only one open shift; expected/actual/discrepancy; credit sales; forced close; handover target/bank/password; concurrent close/checkout | action integration + component + POS E2E | real cashier handoff |
| Reports | reports actions/components | inclusive dates/time zone; filters; empty/large data; totals reconcile to source; drilldown; print; rounding/locale | query/action + rendered table/chart tests | print layout at each paper/DPI setting |
| Staff/jobs/permissions | users actions/pages | CRUD, username uniqueness, password, active flag, job salary bounds, role escalation, every permission key in all encodings, changed permission without restart | table-driven action/route/menu tests + components | admin usability review |
| Audit | audit action/logger/page | all critical mutations, failed login/access, filtering/count/stats, retention and clear permissions; sensitive-data redaction | integration + component | diagnostic usefulness review |
| Settings | settings page/components | every pharmacy field; local/cloud partial failure; config reload; DB maintenance; labels/default; sync; local users; visual-only controls | components/actions | printer label calibration and maintenance backup |
| Desktop menu/windows | Rust menu, layout, TopMenuBar, SidebarNav | route parity; role filtering; action payloads; shortcut conflicts; open/minimize/maximize/restore/resize/focus/close; multiwindow event isolation | route-contract tests + packaged WebDriver | multi-monitor and OS menu behavior |
| Updater | dashboard layout and Tauri updater | current/newer/older/malformed metadata; valid/invalid signature; cancel; timeout; download/install/relaunch failures | mock endpoint + signed test artifacts | UAC, restart, antivirus and network interruption |
| Installer/build | configs/scripts/workflows | clean/upgrade/reinstall/uninstall; standard/admin; WebView; seed contents; build interruption; artifact/signature/version consistency | PowerShell VM scripts + seed/build checks | shortcuts, Programs & Features, dialogs |

## 6. End-to-end workflow tests

Use immutable database snapshots before and after each workflow and assert `PRAGMA integrity_check`, `foreign_key_check`, journal balance, stock, balances and audit rows.

1. **E2E-P0-01 Fresh cashier:** install as standard user → first launch → seed/migrations → local admin login → open shift → barcode sale with two units/batches → interaction warning → cash checkout → print → close shift → restart and verify persistence.
2. **E2E-P0-02 Credit patient:** create patient/limit → credit sale → statement/receivable → partial patient-account return → wallet/debt/stock/journal reconciliation.
3. **E2E-P0-03 Purchase lifecycle:** supplier → draft purchase → reopen → final with bonus/tax/discount and two batches → barcode print → edit completed invoice → supplier return → delete rules → reports/trial balance.
4. **E2E-P0-04 Negative stock:** permit no-stock sale → settle against correct pharmacy batch → confirm one COGS posting → repeat/concurrent settlement rejected.
5. **E2E-P0-05 Upgrade:** populated legacy install → direct latest updater → schema compatibility → login → perform sale, purchase and return → compare schema/resources/version with clean latest.
6. **E2E-P1-06 Inventory administration:** import XLSX with Unicode names/displaced barcode → edit conversion/expiry/prices → adjustment → low-stock/shortage/restock → export and reopen workbook.
7. **E2E-P1-07 Shift handover:** two staff accounts → cashier open and transact → hand over to treasury/bank/employee → close with discrepancy → reports and audit.
8. **E2E-P1-08 Permissions:** owner creates pharmacist with selected permissions → verify all three menus, direct routes and actions → change permissions while second window is open → verify immediate enforcement.
9. **E2E-P1-09 Cloud/offline:** first sync with >1000 updates → lose network between stages → retry → offline restart and full local transaction → reconnect/incremental sync without duplicate rows.
10. **E2E-P1-10 Multiwindow:** main plus two secondary windows → independent navigation/search → concurrent reads and serialized writes → native menu affects only focused window → close/reopen without stale listeners.
11. **E2E-P2-11 Reinstall:** install/use/uninstall/reinstall → document retained app data and successful migration; separately remove app data for true clean install.
12. **E2E-P2-12 Long session:** eight-hour simulated cashier session, 100 modal cycles, 100 searches, 100 draft operations, network transitions and sleep/resume; no listener/timer/memory growth.

## 7. Configuration and option matrix

### Stored settings

| Store | Values to test | Required combinations |
|---|---|---|
| SQLite `config` | `pharmacy_name`, `pharmacy_phone`, `pharmacy_address`, `pharmacy_id`, `subscription_status` plus missing/unknown keys | local update succeeds/cloud fails; cloud succeeds/local fails; receipt/dashboard reload after restart |
| Pharmacy form | Arabic/English name, phone, address, commercial registry, tax card, owner name/address/phone/mobile, manager name/address/phone/mobile | empty optional fields, required Arabic name, Unicode, long values, local/cloud divergence |
| `localStorage` | `pharma_session_user`, `pharma_pos_draft_v1`, legacy `cart`, `theme`, `news_bar_enabled`, `news_dismissed_id`, `pharma_dismissed_alerts`, shift-key variants, `syncStatus`, subscription values | missing, malformed JSON, stale user/shift, quota denied, clear-on-logout, restart, two windows |
| POS draft | cart, patient, payment method, discount and notes | each payment with/without patient; draft restore versus current nonempty cart; stale inventory/batch after restart |
| Label templates | name, width, height, content JSON, default | invalid dimensions/JSON, competing defaults, printer calibration |
| Trial balance | cash drawer, payable, receivable, sales, inventory and COGS account mappings | missing/duplicate/wrong account type; all six categories; remap after transactions |

### Permissions

Table-drive every permission through boolean object, JSON object, stringified JSON, legacy array, malformed value, owner/admin bypass and pharmacist denial.

- Sales: `max_invoice_discount_percent`, `can_change_price_sale`, `can_exceed_max_sale_limit`, `can_view_stock_sale`, `can_sell_no_stock`, `can_give_total_discount`, `show_sales_report_invoice`, `show_suspended_invoices`, `can_change_price_return`, `preview_last_n_invoices`, `show_sale_price_return`, `can_sell_credit`, `show_contract_discounts`, `can_make_exchanges`, `can_change_contract_discounts`, `max_exchange_discount_percent`.
- Drafts: `suspended_can_add_item`, `suspended_can_delete`, `suspended_can_discount_item`, `suspended_can_modify_discount`, `suspended_can_pay_credit`, `suspended_can_change_delivery`, `suspended_can_save_invoice`.
- Purchases/inventory: `can_change_price_purchase`, `can_purchase_above_master_price`, `can_purchase_from_individuals`, `can_manage_inventory`, `show_stock_periodic_inventory`, `preview_item_movements`, `show_cost_price`, `can_modify_unit_conversion`, `can_view_low_stock`, `can_view_opening_balances`, `can_view_settlement`, `can_view_stores`, `can_view_restock`.
- Finance/reports: `can_change_pos_device`, `can_settle_multiple_lines`, `can_select_pos_financial`, `show_own_financial_only`, `preview_drawer_details`, `hide_total_points_balance`, `rep_can_view_sales`, `rep_can_view_purchases`, `rep_can_view_inventory`, `rep_can_view_financial`, `rep_can_view_activity`, `acc_can_view_general`, `acc_can_view_pos`, `acc_can_view_bank_accounts`, `acc_can_define_expenses`, `acc_can_process_cash_flow`, `acc_can_view_securities`, `acc_can_make_daily_entries`, `acc_can_view_notifications`, `acc_can_collect_credit_cards`, `acc_can_view_reports`, `show_total_sales_report`.
- Page/admin: `can_view_patients`, `can_view_delivery`, `can_view_cogs`, `can_view_receipts`, `can_view_returns`, `can_view_purchases`, `can_view_shifts`, `can_view_audit`, `can_view_settings`, `acc_can_view_handover`, `can_view_expenses`, `can_view_staff_manage`, `can_view_staff_roles`.

Use pairwise combinations within each group, then these high-risk cross-group combinations: view page but deny mutation; hide cost but allow inventory; allow credit but deny patient access; allow return but deny price change; allow reports but own-only finance; allow no-stock sale but deny settlement; allow purchase view but deny price change.

## 8. Installer testing plan

Test both NSIS per-user/per-machine choices and MSI on clean snapshots.

1. Verify publisher/product/version/architecture, install directory, Start menu/Desktop entries, Programs & Features entry, WebView2 bootstrap, main executable, icons, `pharma_local.db` resource and no developer files.
2. Launch as standard user from paths containing spaces, Arabic, French accents and a deep path. Confirm app data—not install/current directory—receives the writable DB.
3. First launch with missing WebView2 online, missing WebView2 offline, denied app-data creation, read-only/locked seed, disk full, antivirus delay and interrupted seed copy.
4. Verify the seed contains only the default admin plus reference data, no business data, current migration ledger, valid FTS, foreign keys and integrity.
5. Reinstall over same version, uninstall with running app, uninstall/reinstall with retained app data, and true clean reinstall after explicit app-data removal. Record the intended retention policy.
6. Kill `build-tauri.js` after each temporary rename/copy and assert source paths are restored. Build from a clean checkout twice and compare version/resource manifests and seeded logical content.

## 9. Update testing plan

### Version matrix

| Source | Direct to v0.2.54 | Sequential path | Data fixture |
|---|---|---|---|
| No prior install | clean baseline | n/a | empty app data |
| v0.1.9 | required | 0.1.9 → available intermediate → latest | repository installers plus populated copy |
| v0.2.14 | required | 0.2.14 → 0.2.39 → latest | schema fixture already represented in Rust tests |
| v0.2.39 | required | v0.2.39 → latest | schema fixture already represented in Rust tests |
| previous release | required | previous → current | real release artifact |
| current/same version | no install offered | n/a | current DB |
| newer/downgrade | must not silently downgrade | unsupported | copy protected before attempt |

For each path compare clean versus upgraded: executable/resource hashes, schema/tables/indexes/triggers/migration ledger, config defaults, permission defaults, feature routes, reference-data policy, user/business rows, audit, settings, cache regeneration and reported version.

Failure injection: DNS/offline, HTTP 404/500, timeout, truncated download, invalid JSON/platform key/version, invalid/missing signature, insufficient disk, UAC denial, locked executable/database, process kill during download/install, reboot during install, relaunch failure and antivirus quarantine. The old app and database must remain launchable or the failure must give a recoverable manual path.

## 10. Windows compatibility matrix

| OS/runtime | User/install | Required coverage |
|---|---|---|
| Windows 10 22H2 x64 | standard user, NSIS per-user | minimum practical target; fresh/update, WebView present/missing, HDD/4 GB, Arabic path, 100/150% DPI |
| Windows 10 22H2 x64 | administrator, MSI/per-machine | UAC, another standard user, install repair/uninstall |
| Oldest supported Windows 11 x64 build | standard and admin | fresh/update, current WebView, sleep/resume, session switch |
| Current Windows 11 x64 build | standard and admin | primary release environment, multi-monitor and mixed DPI |
| Windows 11 ARM64 | x64 emulation exploratory only | explicitly report unsupported/native limitations; do not call it supported without an ARM64 artifact |
| Windows 7 SP1 x86/x64 | legacy acceptance | signed x86/x64 NSIS install, WebView2 109, shared critical flows, restart/update/uninstall |
| Windows 8/8.1 and older | negative compatibility check | unsupported; installer must fail clearly or documentation must mark unsupported |

Across supported rows test 100/125/150/175/200% scaling; 1366×768, 1920×1080, 2560×1440 and 3840×2160; mixed-DPI monitors, disconnect/reconnect, primary-monitor change, RTL Arabic and English/French locale, comma decimal locale, DST/time-zone changes, sleep/resume, shutdown with open work and user switching.

## 11. Hardware compatibility matrix

| Tier | Representative profile | Workloads |
|---|---|---|
| Low | older 2–4 core x64 CPU, 4 GB RAM, HDD, integrated GPU | cold launch/cache, 25k-drug search, 500-line inventory/purchase, sync, print, update, two windows, rapid input and DB-lock timing |
| Mid | mainstream 4–8 core, 8–16 GB, SATA/NVMe SSD, integrated GPU | full regression and normal performance baseline |
| High | 8+ cores, 16–32 GB, NVMe, dedicated GPU | large-data/long-session tests; confirm behavior does not depend on excessive parallel speed |
| Peripheral | USB barcode scanner, thermal/A4/label printers | scan focus, rapid scans, receipt/report/barcode layout, offline printer/retry |

## 12. Performance testing plan

Record cold/warm launch, login, initial cache load, search p50/p95, checkout transaction, purchase finalization, report generation, import/export, sync, update, idle CPU/RAM and database growth. Use the production seed and a synthetic database with 100k invoices/500k lines.

Provisional release budgets, to be ratified after the first controlled baseline:

- Low tier: cold launch to usable login within 10 seconds; authenticated dashboard/cache within 15 seconds; search p95 under 500 ms; checkout/purchase commit under 3 seconds; ordinary report under 5 seconds.
- Mid tier: cold launch under 5 seconds; search p95 under 250 ms; critical commit under 1.5 seconds.
- Idle after five minutes: average CPU below 2%; no sustained disk writes; renderer plus backend working set below 500 MiB on the production seed.
- Repeating a modal/search/draft 100 times or running eight hours must not grow working set by more than 20% after GC/stabilization, duplicate listeners, or increase poll frequency.

Capture query plans for FTS/search, inventory alerts, reports and statements. Assert sync pagination and memory remain bounded; do not load the 191k interactions table wholesale.

## 13. Security testing plan

1. **IPC trust boundary:** invoke all 15 commands directly with malformed/oversized JSON, alternate numeric types, missing fields and unauthorized identities. Critical commands must derive/validate user, pharmacy and source records rather than trust hidden UI.
2. **SQL boundary:** fuzz first tokens, comments, mixed case, Unicode whitespace, semicolons and blocked keywords inside comments/identifiers. Verify `db_execute_guarded` cannot read through write result tricks, attach DBs, change pragmas, load extensions, drop schema or escape the app DB.
3. **Capabilities:** verify effective generated capability grants. Challenge `windows: ["*"]`, `sql:default`, window creation, process, updater, dialog and unused `shell:allow-open`; remove permissions later only after call-site tests prove unused.
4. **CSP/navigation:** packaged WebView must allow only required Supabase/GitHub endpoints, prevent frames/forms, block unexpected external navigation and handle calculator/WhatsApp safely. Test the differing middleware CSP versus Tauri CSP.
5. **Files:** path traversal, device paths, UNC, symlink/reparse points, extension/content mismatch, existing/locked file and oversized export for `write_binary_file` and XLSX import.
6. **Authentication/secrets:** session tampering, inactive/deleted users, role escalation, first-password race, bcrypt boundaries, logout, logs/toasts/errors without password/token/Supabase key leakage.
7. **Updater:** signature/public-key enforcement, rollback prevention, HTTPS endpoints, platform selection and metadata/version spoofing.
8. **Data isolation:** wrong-pharmacy IDs across sales, stock, patients, suppliers, reports, shifts and returns; direct action calls must not cross tenant boundaries.

## 14. Failure-injection plan

| Failure | Injection point | Expected result |
|---|---|---|
| SQLite locked >5 seconds | second process/connection holds `BEGIN IMMEDIATE` | bounded error, no partial write, retry possible |
| Disk full/read-only | app data, seed copy, WAL, XLSX destination | explicit error; prior DB/export preserved |
| Process kill | seed copy, migration, checkout, purchase, sync, updater | atomic database state; recoverable next launch |
| Corrupt DB/ledger/FTS | copied fixtures | no silent reset; diagnostic and backup/recovery path |
| Network/DNS/TLS/HTTP failure | Supabase, news, GitHub, WhatsApp | local core remains usable; bounded loading; retry |
| Partial cloud pages | after each 1000/100/200 batch | metadata matches committed data; no duplication on retry |
| WebView/plugin unavailable | startup and each dynamic import | clear startup/action error, no infinite spinner |
| Printer/scanner failure | print popup and keyboard stream | transaction remains committed once; user can reprint/rescan |
| Clock/locale anomaly | DST, future/past clock, comma decimal, Arabic date | correct date filters/expiry/journals; no parse corruption |
| Memory pressure | low-tier VM while sync/reporting | no crash/data loss; operation reports failure or completes boundedly |

## 15. Automated testing strategy

Reuse existing tools first.

| Cadence | Required jobs |
|---|---|
| Every commit | full Jest, Rust tests, TypeScript no-emit, migration/seed logical validation, config/menu contract; enforce nonzero coverage floor starting at current baseline so it cannot regress |
| Pull request | above plus current-migration action contracts, rendered P0/P1 components, static Tauri build, clean seed reproducibility, security boundary tests |
| Nightly | packaged Tauri WebDriver smoke on Windows 10/11, concurrency/DB lock, full cloud-mock sync, long-session/resource tests, accessibility scan |
| Before release | signed MSI/NSIS build; clean/install/update VM matrix; printer/scanner manual subset; signature/version/resource parity; backup/restore and failure recovery |
| After publication | download public artifacts on a clean VM, verify hashes/signatures/latest.json, install, launch, update check, one cash sale/restart/uninstall smoke |

Minimal infrastructure order: add Rust tests and Jest/component tests first; add one Windows packaging PowerShell harness; only then add one Tauri WebDriver runner for workflows that cannot be proven below the UI. Do not duplicate business assertions in fragile UI scripts.

For that final layer, use the official [Tauri WebDriver approach](https://v2.tauri.app/develop/tests/webdriver/): WebdriverIO with the Tauri service is the current recommended path, while direct `tauri-driver` is supported on Windows. Start with the external Windows driver so test-only WebDriver plugins do not enter the production binary. Tauri's mock runtime remains suitable for command/window unit tests but does not execute the native WebView, so it cannot replace the packaged smoke.

## 16. Manual testing checklist

Only these require a person or real system:

- MSI/NSIS dialogs, UAC, shortcuts, Programs & Features and WebView2 installation.
- Thermal/A4/label print quality, barcode readability, scanner focus/timing and offline printer recovery.
- Native menu conventions, multiple windows, mixed-DPI monitors, focus, minimize/maximize/restore and visible error messages.
- Arabic/French/IME input, keyboard-only workflow, screen-reader names, contrast, clipping and toast/dialog comprehension.
- Antivirus/firewall/proxy behavior, network shares/removable drives and domain/redirected Windows profiles.
- Update prompts, cancellation, UAC/relaunch, reboot/interruption recovery.
- Eight-hour cashier exploratory session on low-end hardware.

## 17. Release acceptance checklist

A release is safe only if:

1. All P0/P1 automated suites and Rust/TypeScript/build jobs pass with no retries hiding failures.
2. Both installers are signed, version-aligned, contain the validated seed and launch on clean Windows 10/11 standard-user VMs.
3. Direct and sequential upgrade fixtures pass integrity, migration, core sale/purchase/return and clean-versus-upgraded parity checks.
4. Updater metadata, architecture key, URL and signature install the exact released binary; invalid signatures are rejected.
5. No P0/P1 permission, cross-pharmacy, accounting, stock or rollback defect is open.
6. Performance budgets pass on low and mid tiers, or a measured exception is approved and documented.
7. Manual printer/scanner/DPI/UAC checks pass for changed surfaces.
8. Rollback/recovery instructions and a database backup are available before migration/update testing.
9. Known unsupported targets and the retained-data uninstall policy are documented.

## 18. Traceability matrix

Status values: **A** existing meaningful automation, **P** partial/adapter-only automation, **M** manual only, **N** no current coverage.

| ID | Feature → implementation | Expected behavior and explicit tests | Type/status | Priority |
|---|---|---|---|---|
| LIF-01 | startup/seed → `main.rs` | atomic first copy, stale partial recovery, permissions, Unicode path, missing/corrupt seed | Rust A + VM N | P0 |
| LIF-02 | migrations → `schema.rs`, migrations 1–9 | blank/current/v0.2.14/v0.2.39/untracked/unknown checksum; idempotence and rollback | Rust A; install N | P0 |
| DB-01 | read bridge → `db/tauri.ts`, SQL plugin | parameter parity, plugin load singleton/retry, schema initialization | Jest P + Tauri N | P0 |
| DB-02 | write/transaction bridge → guarded commands | verb security, nested/global queue, two windows, lock/commit/rollback/shutdown | Rust P + Tauri N | P0 |
| AUTH-01 | login/session/bcrypt | first password, invalid/inactive/deleted, corrupt storage, restart/logout | Jest/Rust A; UI N | P0 |
| AUTH-02 | roles/permissions → guards/menus/actions | every key/encoding; owner/admin; direct route/action/IPC; live changes | Jest P + E2E N | P0 |
| SYNC-01 | cloud sync | auth/profile, pagination, incremental data, partial failure/retry, staff deactivate | N | P1 |
| DASH-01 | dashboard/widgets/news/status | KPI reconciliation; empty/error; dismiss/poll cleanup; offline/theme | P | P1 |
| POS-01 | search/barcode/cart/drafts | FTS/barcode, unit/batch, cache coherence, persistence, rapid keys | A/P | P0 |
| POS-02 | critical checkout | all payments, discounts/fees, patient/wallet/points, stock/journals/audit, rollback/double click | Rust A; UI N | P0 |
| SAL-01 | invoice/receipt/print/WhatsApp | filters/detail, totals, no phone, repeat print, popup blocked | P + manual | P1 |
| SAL-02 | delivery/COGS/settlement | closeout, representative cash, cost validation, settlement idempotency | P | P1 |
| RET-01 | customer returns | original invoice/batch, unit math, cumulative limit, refund/accounting, concurrency | Rust A; UI N | P0 |
| INV-01 | inventory CRUD/import/export | batches, reasons, XLSX/file matrix, cache, permissions, rollback | A/P + manual | P0 |
| INV-02 | alerts/low stock/movements | expiry/low/dead/reorder, dismissal, filters and polling | P | P1 |
| INV-03 | opening/restock/shortage | draft/complete, prices, status, suggestions and print | P | P1 |
| MST-01 | drug and bilingual master data | CRUD/FTS/triggers/relationships/duplicates/referenced delete | A/P | P1 |
| PUR-01 | supplier/order | CRUD/history/payment, linked delete, order statuses and duplicate APIs | A/P | P1 |
| PUR-02 | purchase invoice | draft/final/edit/delete, units/batches/tax/discount/accounting/rollback | Rust/Jest A; UI N | P0 |
| PUR-03 | supplier return | validation, conversion, concurrent over-return, stock/journal/supplier balance | Rust A; UI N | P0 |
| PAT-01 | patient/clinical/loyalty | CRUD, linked delete, allergies/conditions, wallet/points/notices/statement | A/P | P1 |
| FIN-01 | accounts/journals/cash | hierarchy, balance, categories, papers/banks/cards/POS, permissions | SQL A; production actions P | P0 |
| FIN-02 | trial balance/expenses/snapshot | mappings, balanced totals, date filters, delete and print | A/P | P0 |
| SHF-01 | shift/handover | one-open rule, cash expected/actual, discrepancy, forced close, concurrent checkout | A/P; UI N | P0 |
| REP-01 | dashboards/reports | source reconciliation, filters/time zone, empty/large, drilldown/print | P | P1 |
| STF-01 | users/jobs/permissions | CRUD, activation/password, salary/demographics, escalation and audit | P | P0 |
| AUD-01 | audit | every critical success/failure, filters/retention/clear, redaction | P | P1 |
| SET-01 | pharmacy/config/labels/maintenance | all fields, cloud/local divergence, reload, invalid templates, backup | N/P | P1 |
| EVT-01 | native/browser events | payload, target, focus, duplicate/order/listener cleanup/window recreate | N | P1 |
| WIN-01 | main/secondary windows | create/min/max/resize/move/focus/close/reopen/mixed DPI | M | P1 |
| NET-01 | Supabase/news/GitHub/external links | offline/DNS/timeout/invalid response/CSP/URL handling | N | P1 |
| SEC-01 | IPC/capabilities/CSP/files | fuzz direct calls, cross-pharmacy, SQL/path/navigation/update signing | P/N | P0 |
| INS-01 | seed/build/install/uninstall | deterministic build, clean/repair/reinstall, WebView, standard/admin/path | N | P0 |
| UPD-01 | updater/relaunch | version matrix, signature, interruption, UAC, parity and recovery | N | P0 |
| PERF-01 | startup/search/transactions/reports | low-tier budgets, 100-repeat and eight-hour leak runs | N | P1 |
| LOC-01 | RTL/locale/time/DPI/accessibility | Arabic/accents/CJK paths, decimal/date/time zone, 100–200%, keyboard | M | P1 |

## 19. Risk-based priority

1. **P0:** packaged startup/seed/migrations; checkout/purchases/returns/negative stock; transaction concurrency; accounting/stock invariants; authorization and pharmacy isolation; installer/updater signing/recovery.
2. **P1:** cloud sync consistency; inventory import/export; shifts/handover; patients; reports; native events/windows; settings; network degradation; low-end performance and localization.
3. **P2:** dashboard cosmetics, duplicated navigation, stale version text, coming-soon route behavior and secondary print layouts.
4. **P3:** visual-only label tools and rare cosmetic animation differences, unless promoted when functionality is implemented.

## 20. Recommended implementation order

1. Add a release-gating packaged launch smoke: clean app data, launch, wait for login, assert DB/integrity/version, exit.
2. Make one reusable current-migration SQLite fixture and convert high-risk action tests that currently use hand-written schemas.
3. Finish direct Rust command tests for rollback, permission/pharmacy validation, locks and transaction cleanup.
4. Add table-driven permission tests across menu/page/action/command and the full key list.
5. Render the five critical UI workflows: login, POS checkout, purchase invoice, customer return and shift close/handover.
6. Automate seed/build validation and Windows clean installer smoke with PowerShell.
7. Add signed updater fixtures and the v0.1.9/v0.2.14/v0.2.39/previous-release migration matrix.
8. Add cloud-sync pagination/failure tests and network fallbacks.
9. Add finance/patient/inventory/staff component coverage and enforce a gradually rising coverage floor.
10. Add nightly packaged multiwindow, concurrency, performance and accessibility runs; keep printer/scanner/mixed-DPI validation manual.

This order deliberately avoids a broad UI-automation framework until lower-layer contracts and one packaged smoke expose the real gaps.

## Appendix A. Exported desktop-action contract checklist

This is the function-level checklist used to prevent a grouped feature row from hiding an untested action. Each name must be covered directly or explicitly marked as a tested alias of another function.

- `audit.ts`: `clearAuditLogsAction`, `getAuditLogsAction`.
- `auth.ts`: `loginLocalAction`, `loginCloudAction`, `getCurrentUserAction`, `getLocalSessionAction`, `logoutLocalAction`, `getLocalUsersAction`.
- `cogs.ts`: `getSoldItemsForCogsAdjustmentAction`, `updateSoldItemCostAction`.
- `config.ts`: `getConfigAction`, `updateConfigAction`.
- `db.ts`: `serverDbSelect`, `serverDbExecute` (web fallback only; assert they are absent from the packaged desktop trust path).
- `delivery.ts`: `getPendingDeliveriesAction`, `closeDeliveryInvoiceAction`, `getRepresentativeCashStatementAction`.
- `expenses.ts`: `addExpenseAction`, `getExpensesAction`, `deleteExpenseAction`, `getExpenseSummaryAction`.
- `finance.ts`: `addFinancialNoticeAction`, `addPatientPaymentAction`, `createCashMovementAction`, `getCashMovementsAction`, `getPointsOfSaleAction`, `getExpenseDefinitionsAction`, `getBanksAction`, `getPapersAction`, `getCardsAction`, `getAccountsAction`, `addAccountAction`, `updateAccountAction`, `getJournalsAction`, `getJournalDetailsAction`, `seedFinanceTestDataAction`, `generateDailySnapshotAction`, `getTrialBalanceSettingsAction`, `saveTrialBalanceSettingAction`, `getPatientStatementAction`, `getTrialBalanceAction`, `getFinancialNoticesAction`, `getActivityLogsAction`.
- `handover.ts`: `getHandoverDetailsAction`, `processHandoverAction`, `getOpenShiftHandoverAction`, `getShiftCreditSalesAction`.
- `interactions.ts`: `checkDrugInteractions`, `getInteractionsAction`, `addInteractionAction`.
- `inventory.ts`: `addInventoryAction`, `updateInventoryAction`, `deleteInventoryAction`, `checkInteractionsAction`, `checkClinicalSafetyAction`, `getLowStockAction`, `settleNegativeStockAction`, `getInventoryAlertsAction`, `getDrugDetailsFullAction`, `getInventoryListAction`, `getMovementsAction`, `getOpeningBalancesAction`, `addOpeningBalanceAction`, `getRestockItemsAction`, `getAdjustmentsAction`, `getUnusedDrugsAction`, `deleteDrugAction`.
- `labels.ts`: `getLabelTemplatesAction`, `saveLabelTemplateAction`.
- `loyalty.ts`: `awardLoyaltyPointsAction`, `redeemLoyaltyPointsAction`, `getPatientLoyaltyAction`.
- `master-drugs.ts`: `getMasterDrugAction`, `addMasterDrugAction`, `searchInventoryAction`, `updateMasterDrugAction`, `searchMasterDrugsAction`, `getUnitsAction`, `addUnitAction`, `updateUnitAction`, `deleteUnitAction`, `addProductCategoryAction`, `updateProductCategoryAction`, `deleteProductCategoryAction`, `getProductCategoriesAction`, `addAlternativeAction`, `getAlternativesAction`, `addIndicationAction`, `updateIndicationAction`, `deleteIndicationAction`, `getIndicationsAction`, `getScientificGroupsAction`, `addScientificGroupAction`, `updateScientificGroupAction`, `deleteScientificGroupAction`, `getItemNaturesAction`, `addItemNatureAction`, `updateItemNatureAction`, `deleteItemNatureAction`, `getUsageMethodsAction`, `addUsageMethodAction`, `updateUsageMethodAction`, `deleteUsageMethodAction`, `getAdjustmentReasonsAction`, `addAdjustmentReasonAction`, `updateAdjustmentReasonAction`, `deleteAdjustmentReasonAction`, `updateGenericBilingualAction`, `deleteGenericBilingualAction`, `getDrugsByIndicationAction`, `addDrugIndicationAction`, `deleteDrugIndicationAction`, `getUnusedItemsAction`, `deleteMasterDrugAction`, `migrateNamesToEnglishAction`, `getManufacturersAction`, `addManufacturerAction`, `getOpeningBalancesAction`, `createOpeningBalanceAction`, `addOpeningBalanceItemAction`, `completeOpeningBalanceAction`, `getShortagesAction`, `addShortageAction`, `updateShortageStatusAction`, `createStockAdjustmentAction`, `addDrugAlternativeAction`, `removeDrugAlternativeAction`, `addDrugInteractionAction`, `removeDrugInteractionAction`, `getRelevanceScore`.
- `patients.ts`: `addPatientAction`, `searchPatientsAction`, `getPatientProfileAction`, `addPatientAllergyAction`, `addPatientConditionAction`, `deletePatientAllergyAction`, `updatePatientAction`, `getPatientStatementAction`, `updatePatientWalletAction`, `getPatientsAction`, `deletePatientAction`, `getReceiptDetailsAction`.
- `purchase.ts`: `createPurchaseOrderAction`, `getPurchaseOrdersAction`, `updatePurchaseOrderStatusAction`.
- `purchases.ts`: `getSuppliersAction`, `getSupplierTransactionsAction`, `addSupplierPaymentAction`, `addSupplierAction`, `updateSupplierAction`, `deleteSupplierAction`, `getPurchaseInvoicesAction`, `checkSupplierPendingInvoiceAction`, `createPurchaseInvoiceAction`, `addPurchaseInvoiceItemAction`, `completePurchaseInvoiceAction`, `getDrugPurchaseHistoryAction`, `createPurchaseOrderAction`, `getPurchaseOrdersAction`, `updatePurchaseOrderStatusAction`, `getPurchasesReportsAction`, `getPurchaseInvoiceDetailsAction`, `createPurchaseReturnAction`, `getPurchaseReturnsAction`, `deletePurchaseInvoiceAction`, `getDrugInventoryQuantityAction`, `getPurchaseReturnDetailsAction`, `getPurchaseInvoiceAction`, `getDraftPurchaseInvoicesAction`, `updateCompletedPurchaseInvoiceAction`.
- `reports.ts`: `getShiftReportAction`, `getDashboardKPIsAction`, `getSalesTrendAction`, `getReportsDataAction`.
- `returns.ts`: `getSalesInvoicesByDateAction`, `createReturnAction`, `getReturnsAction`, `searchInvoicesForReturnAction`, `searchRecentReturnInvoicesAction`, `getInvoiceForReturnAction`, `createGeneralReturnAction`.
- `sales-reports.ts`: `getSalesReportsAction`, `getInvoiceDetailsAction`.
- `sales.ts`: `searchDrugsAction`, `searchPatientsAction`, `barcodeLookupAction`, `fetchDraftsAction`, `processCheckoutAction`, `getSalesDashboardStatsAction`, `getRelevanceScore`.
- `settings.ts`: `updatePharmacyAction`, `runDatabaseMaintenanceAction`.
- `settlement.ts`: `getNegativeStockInvoicesAction`, `settleNegativeStockAction`, `getUnsettledSalesAction`, `getDrugBatchesAction`, `settleSaleItemAction`.
- `shifts.ts`: `openShiftAction`, `closeShiftAction`, `getShiftsAction`, `getCurrentShiftAction`, `getCurrentShiftStatsAction`, `startShiftAction`, `endShiftAction`, `forceCloseAllShiftsAction`.
- `shortages.ts`: `addToShortagesAction`, `getSmartShortagesAction`.
- `sync.ts`: `syncFromCloudAction`.
- `users.ts`: `updateUserPermissionsAction`, `addUserAction`, `deleteUserAction`, `updateUserAction`, `getStaffAction`, `getJobsAction`, `addJobAction`, `deleteJobAction`, `resetUserPasswordAction`, `getStaffManagementDataAction`, `getStaffPerformanceAction`.

## Appendix B. Shared-library coverage map

| Library | Tauri relevance | Required coverage |
|---|---|---|
| `lib/db/tauri.ts` | primary packaged adapter | real SQL-plugin reads, guarded writes, initialization retry, transaction serialization and window concurrency |
| `lib/db/client.ts`, `local.ts`, `migrations.ts`, `schema.ts` | web/test adapter and schema utilities | parity with Rust migrations; avoid counting adapter-only results as Tauri E2E |
| `lib/auth/local.ts`, `permissions.ts`, `roles.ts` | packaged auth/authorization | session, bcrypt IPC, every permission encoding, live database refresh |
| `lib/auth/service.ts`, `session.ts`, `jwt.ts`, `password.ts`, `middleware.ts` | mainly web/server path | retain unit tests, but exclude from desktop release confidence unless imported into the static bundle |
| `lib/cache/secure_cache.ts`, `cache/manager.ts` | packaged search/enrichment | load/reload/update, failure retry, bounded memory, stale-cache avoidance |
| `lib/pos/cart.ts`, `checkout.ts`, `checkout-calculation.ts`, `billing.ts` | checkout calculations/helpers | units, totals, validation and parity with Rust final totals |
| `lib/inventory/import.ts`, `alerts.ts`, `service.ts` | import/analysis and legacy service logic | XLSX/file matrix, alert boundaries, and parity with action SQL |
| `lib/purchases/invoice-form.ts`, `return-units.ts` | purchase UI calculations | calendar/date, discounts, conversion and Rust parity |
| `lib/utils/printing.ts` | packaged receipt/WhatsApp printing | escaping, Arabic text, totals, blocked popup, repeated print and printer manual checks |
| `lib/sync/client.ts`, `universal.ts` | packaged cloud sync | client branch selection, pagination, partial failures, retry and offline behavior |
| `lib/settings/client.ts` | packaged pharmacy settings | cloud/local success combinations and config persistence |
| `lib/audit/logger.ts` | audit helper | event coverage, filtering, retention, redaction and transaction relationship |
| `lib/security/csrf.ts`, `rate-limit.ts`, `errors/*` | web/server-only in current static build | unit-test web mode; verify build excludes reliance on these controls for desktop IPC |
| `lib/reports/service.ts`, `shifts/service.ts`, `users/service.ts` | legacy/shared services | contract parity or mark unused; tests must identify whether production actions call them |
| `store/usePOSStore.ts`, `hooks/useBarcodeScanner.ts`, `use-debounce.ts` | packaged UI state/input | persistence/migration, focused window, scan timing, cleanup and debounce cancellation |
