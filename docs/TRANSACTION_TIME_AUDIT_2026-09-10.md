# Transaction time audit — 10 September 2026

## Verdict

**Not fully solid. Do not certify local-day financial reporting as correct yet.** The foundation—SQLite UTC creation timestamps and conversion to the device's local display time—is sound for normal new records. Several consumers bypass that contract. Confirmed defects affect day/month totals, return receipt selection, customer statements and date validation. These tests do not demonstrate lost inventory or changed lifetime balances; they demonstrate wrong reporting periods, misleading displayed times and acceptance of invalid accounting dates.

Reviewed source revision: `8b45d2ec`. Host: Windows, Romance Standard Time; audit ran with system offset `+02:00`. Baseline: `docs/TAURI_TEST_PLAN.md`, extended to current timestamp paths. No production database was opened or modified, and no system clock/timezone was changed. Only audit scripts, audit tests and this report were added. No application edits, release build or push.

## Execution and results

| Execution | Result | What it establishes |
|---|---|---|
| Existing timestamp, purchase/handover and fresh/upgrade action suites | 41 passed | Existing workflow and timestamp contracts remain green; not a full timezone certification |
| Existing receipt-printing suite | 3 passed | Receipt HTML/share rendering contracts |
| POS checkout, shift receipt and purchase UI suites | 12 passed | Rendered interactions with mocked action boundaries |
| New timestamp matrix | 177 checks: 123 passed, 54 failed | Actual normalizer, JavaScript date behavior and selected real SQL predicates |
| New cash/notice/journal action audit | 9 tests: 2 passed, 7 failed | Real action code with isolated SQLite; invalid dates are accepted |
| TypeScript `--noEmit` | Passed | Audit code type-checks; no emitted application build |

The 54 matrix failures are repetitions across scenarios, **not 54 independent bugs**: 35 alias-time failures, 8 UTC-vs-local business-day failures, 7 date-only rendering failures, and 4 SQL reporting/selection failures.

Matrix timezones: UTC, Africa/Cairo, Europe/Paris, America/New_York, Asia/Kathmandu and Pacific/Kiritimati. Dates include ordinary midnight, month/year rollover, leap day, and both sides of New York daylight-saving transitions. Explicit offsets, milliseconds and normalization twice were checked. These are modern Node timezone simulations, not six OS installations. For the return SQL test only, the SQLite `localtime` modifier was replaced with `+03:00` to simulate Cairo deterministically; the application's OR predicate was retained.

## Confirmed findings

### 1. High: daily/monthly financial totals use inconsistent day boundaries

Storage uses UTC `CURRENT_TIMESTAMP`, but queries use `date(created_at)` without local conversion, compare it to local today, or use UTC month prefixes.

Executed example: sale of 100 at `2026-08-31 21:30:00` UTC, corresponding to September 1 at 00:30 with offset +03:00. The actual finance daily-sales query returned **0** for September 1 instead of **100**. A 20 cash return at 00:45 likewise returned **0**. The actual monthly revenue query returned **0** for September instead of **100**.

Affected paths identified:

- [Sales dashboard](D:/PhD/Tools/pharma/src/app/actions-client/sales.ts:879): raw UTC date compared with local today/yesterday.
- [Finance daily totals](D:/PhD/Tools/pharma/src/app/actions-client/finance.ts:1087): `date(created_at) = selectedDate` for sales and returns.
- [Dashboard KPIs](D:/PhD/Tools/pharma/src/app/actions-client/reports.ts:262): UTC today and UTC midnight bounds rather than a local business day.
- [Sales/returns trend](D:/PhD/Tools/pharma/src/app/actions-client/reports.ts:202): raw UTC grouping against local-date calendar rows.
- [Monthly expenses/profit](D:/PhD/Tools/pharma/src/app/actions-client/expenses.ts:170): UTC default month and `created_at LIKE month%` for revenue/returns/COGS, combined with date-only expenses.
- [Inventory consumption](D:/PhD/Tools/pharma/src/app/actions-client/inventory.ts:876): raw timestamp year/month grouping.

Impact: the same event can appear on the receipt's local day but another day/month in reports. This is a period allocation error; it is not proof that the transaction itself disappeared.

### 2. High: invalid accounting dates are accepted and committed

Executed the actual actions against isolated SQLite:

- `createCashMovementAction`: accepted `''`, `not-a-date` and `2026-02-30`. Each returned success and committed one cash movement and one journal.
- `addFinancialNoticeAction`: accepted `not-a-date` and `2026-02-30`.
- `createManualJournalAction`: accepted the same two invalid dates.

Valid/backdated dates `2024-02-29` and `2026-09-01` passed; business date was preserved separately from current UTC creation time. Backdating is not inherently a defect.

Sources: [cash schema](D:/PhD/Tools/pharma/src/app/actions-client/finance.ts:267), [notice schema](D:/PhD/Tools/pharma/src/app/actions-client/finance.ts:86), [manual journal](D:/PhD/Tools/pharma/src/app/actions-client/finance.ts:1634). Patient payment also uses `z.string()` for its date; that path was reviewed, not separately invalid-date executed. Expense entry only checks nonempty date before calling the cash action.

Impact: dated reports may omit malformed entries; invalid calendar dates can be treated differently by different parsers. Browser date inputs do not replace validation at the action/database boundary.

### 3. High: UTC timestamps lose their timezone in statement aliases

[The adapter](D:/PhD/Tools/pharma/src/lib/db/tauri.ts:21) normalizes columns ending `_at`, `_time`, `_on`, plus selected shift names. It deliberately leaves ordinary business-date fields alone.

[Patient statements](D:/PhD/Tools/pharma/src/app/actions-client/patients.ts:445) alias UTC `created_at` to `date`. That name bypasses normalization. [The UI](D:/PhD/Tools/pharma/src/components/patients/CustomerStatementModal.tsx:194) then uses `new Date(mov.date)`, which treats an unzoned date-time as local.

Executed example: `2026-08-31 21:30:00` under Cairo parses as `18:30Z`, not the actual `21:30Z`. Normal receipt `created_at` and statement `date` therefore represent different instants. 35 non-UTC matrix cases failed. Re-sorting these mixed dates can also misorder a payment and sale in the running statement.

Related aliases requiring review: patient item history, COGS `invoice_date`, return original-invoice `invoice_date`, and settlement aliases. Not every alias consumer was rendered end-to-end. Do not blindly append `Z` to all fields named `date`: many genuinely contain local business dates or handover local date-times.

### 4. Medium: return receipt picker lists the same receipt on two dates

[Return picker](D:/PhD/Tools/pharma/src/app/actions-client/returns.ts:80) uses:

```sql
date(i.created_at) = ? OR date(i.created_at, 'localtime') = ?
```

Executed with the midnight fixture: the one receipt matched **August 31 and September 1**, rather than just its September 1 local day. This duplicates date-list membership, not database receipts. The OR may accommodate ambiguous legacy data, but it is not a correct local-date filter for known UTC records.

### 5. Medium: business-date defaults differ between modules and runtime paths

`new Date().toISOString().slice(0,10)` produces the UTC date, not necessarily the system's local date. The matrix reproduced eight wrong-local-date cases, including month/year edges.

Identified consumers include web/fallback purchase create/update/accounting, patient opening-balance journals, inventory adjustment journals, several finance forms and manual-journal fallbacks. In contrast, native purchase default dates use SQLite `DATE('now','localtime')`, and several other forms use `format(new Date(),'yyyy-MM-dd')`.

Sources: [purchase defaults](D:/PhD/Tools/pharma/src/app/actions-client/purchases.ts:625), [native default](D:/PhD/Tools/pharma/src-tauri/src/commands/critical.rs:854), [patient opening journal](D:/PhD/Tools/pharma/src/app/actions-client/patients.ts:157), [inventory adjustment](D:/PhD/Tools/pharma/src/app/actions-client/inventory.ts:253), [finance forms](D:/PhD/Tools/pharma/src/components/finance/AccountsManagementClient.tsx:2421).

This establishes a source-level runtime parity problem plus an executed date-expression failure, not an executed two-build installation comparison.

### 6. Medium: date-only values can display as the previous day

`new Date('YYYY-MM-DD')` represents UTC midnight. Formatting it in a timezone west of UTC can show the previous calendar day. Seven New York matrix cases reproduced this.

Date-only notice/payment/statement fields use this pattern in [patient UI](D:/PhD/Tools/pharma/src/components/patients/CustomerStatementModal.tsx:246) and finance display helpers. Cairo/Paris often mask this bug. True business dates should be parsed/rendered as calendar dates, not instants.

### 7. Medium, inspection finding: initial POS receipt time is regenerated after save

[POS completion](D:/PhD/Tools/pharma/src/app/(dashboard)/pos/page.tsx:736) constructs the print/share invoice with `created_at: new Date().toISOString()` after checkout returns. It does not use the stored receipt timestamp. The native checkout response contains sale ID, total and points, not `created_at`.

Normal delay may be small, but a slow save, midnight crossing, or clock adjustment can make the first receipt differ from its later database-backed reprint. The code path was traced; a deliberately delayed live Tauri save/print was not executed. Fix by returning/reloading the persisted invoice timestamp, not by substituting local strings into storage.

## Coverage by module

| Group | Checked flow and result | Limits |
|---|---|---|
| POS cash/credit and receipts | Existing checkout/UI tests; UTC storage, normalization and print helpers; local-date failures above | No new desktop binary or physical printer |
| Drafts and purchases | Existing direct/draft/fresh/upgrade workflows pass; explicit invoice date is distinct from creation time | Native date validation inspected; not recompiled/executed this turn |
| Sales returns | Existing quantity/refund workflows pass; UTC creation schema; receipt-date predicate fails | No live multi-window return run |
| Purchase returns | Native/JS insert paths use database creation time; existing workflow regressions cover behavior | Timezone boundary of full native return command not executed |
| Shifts/handover | UTC start/end normalization, receipts linked by shift ID; existing multi-user/rollover tests pass | Cross-window clock-change/concurrency not exercised live |
| Cash/treasury | Real action preserves valid business date and UTC creation instant; malformed dates fail contract tests | Some legacy date fallbacks remain ambiguous |
| Expenses/profit | Existing accounting regressions; monthly revenue SQL fails local-month boundary | Full rendered month-filter combinations not exhausted |
| Customer payments/notices/wallet | Existing accounting tests; actual notice invalid-date failures; statement alias matrix fails | Every patient form option not independently executed |
| Supplier payments, banks/cards/checks | Date fields, defaults and ledger paths reviewed; shared cash behavior tested | All settlement/due-date options not executed |
| Manual journals | Actual valid cash journals and malformed manual-journal action tests | Every account configuration not exercised |
| Audit log | UTC creation schema and UTC-derived today/seven-day boundaries reviewed | Local-business-day audit counters not independently executed |
| Inventory transactions/expiry | Existing stock regressions; UTC update fields and date-only expiry logic reviewed | All expiry/import formats and restore migrations not exhausted |
| Fresh install/update/import | Existing fresh/upgraded fixture suites pass; schema defaults reviewed | No customer backup/history timezone provenance examined |

## What is solid

- SQLite's current UTC timestamp matched the host's current instant within two seconds in the test. A stored UTC hour differing from the Windows local hour is not itself corruption.
- Normalization of standard SQLite UTC timestamp columns is idempotent; explicit offsets and milliseconds preserve the instant.
- UTC records remain distinct during a repeated daylight-saving hour.
- Existing shift ID associations do not depend on calendar-day filtering, which avoids confusing midnight with a shift boundary.
- Valid/backdated cash business dates are kept separately from creation time.

## Remaining risks / not certified

No live Windows 7/10/11 or x86/x64 matrix, legacy WebView2, physical printing, native Rust command execution, external synchronization, restart/restore timezone changes, real daylight-saving transition, manual system-clock adjustment, or multi-computer clock skew was exercised this turn. Legacy unzoned local timestamps cannot safely be distinguished from unzoned UTC by their string shape alone. No app-specific stored timezone/offset contract was found in the inspected transaction paths. If the OS clock is wrong, UTC storage still records the wrong real-world instant. UTC avoids timezone ambiguity; it does not make a bad clock accurate.

The passing existing suites are not proof of all timestamp behavior: several mock the database bridge and return raw rows without the real normalization step. The separate audit executes the real normalizer and selected SQL precisely to cover that gap. The matrices are not a complete end-to-end certification of every option in every module.

## Recommended next implementation order

1. Define one contract: UTC for event timestamps; local calendar values for business/expiry dates; retain acting user and shift IDs. Decide whether reporting follows device timezone or a configured pharmacy timezone.
2. Fix daily/monthly query boundaries and date-only defaults together. Prefer half-open UTC ranges derived from the chosen local period (`start <= instant < nextStart`), including DST-safe local boundaries.
3. Preserve timestamp semantics through aliases; normalize instants explicitly, not solely by column-name suffix. Keep genuine business dates separate.
4. Enforce real calendar-date validation for cash, notices, journals, payments and other dated actions in frontend and native boundaries. Preserve intentional backdating.
5. Use the persisted receipt timestamp for initial print/share, history and reprint. Remove dual-day return matching for known UTC records.
6. Re-run the failing audit checks, then perform a disposable-database Tauri run on both architectures and target Windows versions. Handle historical repairs only with backups and evidence of original timezone; never bulk-add/subtract an offset blindly.

## Reproduction

From the repository root:

```powershell
node scripts/audit-transaction-time.cjs --summary
npx jest --runInBand --silent --testMatch '**/*.audit.ts' --runTestsByPath src/app/actions-client/__tests__/transaction-time.audit.ts
```

Both intentionally exit nonzero while the documented defects remain. Omit `--summary` for every matrix result. These runners use disposable in-memory databases and do not modify application data.
