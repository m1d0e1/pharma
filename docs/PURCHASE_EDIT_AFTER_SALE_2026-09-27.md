# Purchase edits after sales — 2026-09-27

## Implemented behavior

Completed purchase invoices can now be edited after linked stock has been sold, without reversing their original accounting or rewriting historical sales costs. The existing permission checks and atomic database transactions remain in place. No migration, new dependency, release build, or push is included.

Allowed in the protected edit path:

- Correct received quantity without reducing stock below zero.
- Change future inventory/POS selling price, notes, and supplier invoice display number.
- Record additional received quantity at the unchanged allocated unit cost.

Example: receive 10 boxes, sell 4, then correct receipt quantity to 8. The batch remains the same, available quantity becomes 4, historical sales costs remain unchanged, and only the value of 2 boxes is reversed through a new adjustment.

## Safeguards

- Original invoice-line and inventory-batch IDs remain stable.
- Supplier, payment method, date, cheque details, drug identity, expiry, unit conversion, barcode, bonuses, and valuation inputs cannot change after consumption.
- Every line's allocated unit cost must remain unchanged and match the current linked batch. Quantity changes involving bonuses or fixed charges are rejected if they would change that cost.
- Lines cannot be added, removed, duplicated, or replaced on a protected invoice.
- Shared, missing, or inconsistent batch links require reconciliation rather than guessed corrections. Existing purchase-return restrictions remain.
- Original journals and supplier/cash records are retained. Corrections append a balanced delta journal and supplier adjustment. Cash corrections post only to the current common shift, leaving closed shifts untouched.
- Saving the same correction again does not duplicate its financial adjustment.
- Adjusted invoices cannot be deleted through the original reversal path; use the purchase-return workflow instead.
- An audit records the acting user, amounts, quantity/price changes, notes, and display-number changes. A late database error rolls back the entire operation.
- The UI warns and asks for confirmation: cash differences must represent actual money paid or refunded. Cancel and rejected saves preserve the form.

## Verification

- Rust transaction tests: **57 passed**, including real checkout followed by cash/credit purchase edits, exhausted stock, repeated corrections, invalid cost/unit/date/payment changes, balanced journals, closed-shift preservation, and injected-failure rollback.
- Focused React and SQLite action tests: **33 passed**, including reordered lines, omitted/invalid selling prices, bonuses, cash/credit deltas, cancellation, rejected-save preservation, and successful retry.
- TypeScript no-emit check and ESLint on changed TypeScript files: passed.
- Full Jest regression suite: **225 suites passed; 1,721 tests passed; 2 tests skipped** (one skipped suite). The initial run exposed two mocked deletion-flow failures from a redundant frontend check; removing that check retained the authoritative transactional Rust guard, and the full rerun passed.

## Boundaries

Native desktop UI/IPC interaction, Windows architecture packaging, and release installers were not executed. The React tests exercise the UI with mocked actions; SQLite and Rust tests exercise the transaction implementations separately. Existing expiry/archived-drug validation still applies to historical invoices. This is not a general historical cost-revaluation tool.

The UI and fallback implementation were delegated to lower-cost agents, then reviewed and tested by the orchestrator. An additional final-review agent hit its usage limit; final verification was performed by the orchestrator.

## Review follow-up — 2026-09-28

Four review findings were addressed without a release build or push:

- **Import queue deadlock:** both inventory and master-drug imports use the explicit transaction handle. Read-only schema PRAGMAs run before the transaction because the native transactional read guard accepts SELECT only. Regression adapters reject escaped data operations and transactional PRAGMAs. A smoke run using the real TypeScript queue/import code with simulated IPC and in-memory SQLite completed both imports (two commits, correct stock).
- **Unsafe automatic barcode repair:** repair now requires placeholder-only names, zero stock, no sales/purchase history, and no competing owner of the replacement barcode in either catalog or lots. Real custom drugs, stocked items, and ambiguous records are left unchanged. The startup message correctly names the default local branch rather than the current branch.
- **Reserved accounting codes:** deeper inspection corrected the initial recommendation to allow arbitrary core mappings. The application deliberately reserves core codes in its settings, Rust posting, and startup repair. Renaming those codes is now blocked, preventing subsequent posting failures. Custom entity mappings and custom account-code edits remain supported; tests verify both, followed by a cash posting.
- **Future selling-price edits:** changing the selling price in a completed invoice no longer recalculates its historical cost/discount. The UI regression changes the actual field and verifies the submitted values. New/draft purchase pricing retains its existing behavior.

Import implementation was delegated to Terra/medium, the narrow UI fix to Luna/low; the orchestrator handled the data-safety/accounting decisions and reviewed both contributions. Other concurrent workspace edits were preserved. Packaged desktop GUI and architecture-specific installation tests remain outside this verification.

Final combined-workspace verification on September 28: **231 Jest suites passed, 1,845 tests passed, 2 tests skipped; 63 Rust tests passed.** TypeScript no-emit, ESLint on the scoped fix files, and `git diff --check` passed. This supersedes the earlier counts above, which describe the smaller September 27 snapshot.
