# Drawer cash and handover review — 2026-09-25

## Finding

The treasury card used the cumulative cash-account journal balance, while the user needed money remaining in the current shared drawer. In the code reviewed, treasury/internal handovers do **not** debit the cash account a second time: the mismatch was using a different balance, not proof of duplicate posting in a customer's database. A separate issue left the finance page stale after a handover in another window.

## Change

- The treasury card now uses the same calculation as handover: opening float + cash sales + cash receipts − cash disbursements − cash refunds − any legacy transfers not already represented in disbursements.
- This existing calculation was moved into a shared, read-only helper; the current shift and its figures are read in one SQLite statement. No new accounting engine, polling, schema migration, or dependency was introduced (Ponytail's minimal-change approach).
- Only the pharmacy's open shared shift contributes. Closed/other-pharmacy shifts are excluded. No open shift returns zero without creating one. Multiple open shifts return an error rather than an arbitrary balance.
- Clicking the card shows the signed components of that same number, labelled as calculation components, not individual receipts.
- Ledger cash remains separate as `ledgerCashBalance`. The accounting-liquidity total remains ledger cash + registered bank balances; it does not add handover totals or POS balances again.
- Local handover events, cross-window shift notifications, and window focus refresh the finance page and open details. A failed summary hides stale amounts and offers retry.

## Expected behavior

| Situation | Current drawer |
| --- | --- |
| Opening 100, cash sale 100 | 200 |
| Then move 150 out to the main safe, bank, or another POS | 50 |
| Instead hand custody to the next user, retaining cash in the common drawer (`next_shift`) | 200, not 350 |
| New cash sale 10 after external handover | 60 |
| Counted cash is 205 instead of expected 200, then transfer 150 out | 55; difference recorded once |
| Refund an old receipt in a new shift | Deduct from the shift that actually pays the refund |

`treasury` in the handover destination still means the **separate main safe**, outside this drawer. Use `next_shift` when cash stays in the common drawer. Bank/POS destination balances retain their existing behavior. Handover audit records, actor IDs, closed-shift records, and automatic shared-shift rotation are preserved.

## Verification

- Real JavaScript action flows against isolated SQLite: checkout → handover → new-shift checkout → another handover, for all four destinations; shortages/overages; refund after rotation; cash receipts/expenses; legacy transfers; no-open-shift and pharmacy isolation; multiple-open-shift rejection; signed breakdown reconciliation.
- React UI tests: ledger liquidity versus drawer amount, local/storage/focus refresh, detail refresh, failed-load warning and retry, permissions, and existing finance controls.
- Full Jest suite: **225 suites passed, 1 skipped; 1,714 tests passed, 2 skipped, 0 failed**. The skipped catalog-recovery tests require private recovery artifacts not supplied to this run. Result: `scratch/drawer-final-jest.json` and `scratch/drawer-final-jest.log`.
- TypeScript (`tsc --noEmit --incremental false`), ESLint on all changed source/test files, and `git diff --check` passed. Focused new drawer/action and finance UI suites: 32 tests passed.

## Boundaries

The live number is **expected cash from recorded activity**, not a sensor measurement. Actual physical cash is confirmed by the count entered at handover. Unrecorded cash withdrawals, incorrect starting floats, or old corrupt transactions require reconciliation; this change does not guess or rewrite them. Negative computed cash remains visible rather than being silently clamped to zero.

No customer database was modified. No release build, installer, push, or packaged Windows/multi-window manual run was performed. Native checkout code was not changed; this pass executes the JavaScript action/SQLite integration and React paths, not native Tauri IPC end-to-end.
