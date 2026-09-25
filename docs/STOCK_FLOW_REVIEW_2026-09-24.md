# Inventory, POS, purchase and return review — 24 September 2026

## Scope and verdict

Reviewed the stock and money paths across inventory, POS, purchases, sales returns, purchase returns, shortages and negative-sale settlement. Used the corresponding sections of `TAURI_TEST_PLAN.md` as a baseline and added scenarios found in the current code.

This review found real defects, not just opportunities to refactor. The changes are intentionally local: existing transaction boundaries, invoice IDs and browser events are reused. No dependencies, background polling, release build, publication or customer-database repair were added.

**Do not interpret passing automated tests as proof of every possible workflow, operating system or installed customer database.** Historical mixed purchase batches still require reconciliation; the new guard prevents ambiguous edits/returns rather than guessing their ownership.

## Confirmed defects and corrections

### 1. Different purchases could share one stock batch

The batch lookup used the supplier's displayed invoice number, drug and expiry. Two different invoices with the same displayed number could therefore share stock, cost and unit-conversion data.

Reproduction: purchase two boxes at 100 and two at 200, using the same supplier invoice number. The old code produced four boxes at an average cost of 150. Returning one box from the first invoice refunded/credited inventory by 100, but reduced physical carrying value by 150.

New purchase batches use the complete internal invoice ID. The regression verifies distinct stock links and conversion snapshots, and compares total stock carrying value before/after the return with the accounting credit. Editing/deleting one invoice must leave the other invoice's stock, supplier balance and journal intact.

Existing exclusive linked batches retain their inventory IDs. An edit can normalize their batch label to the new invoice-ID format. Exclusive legacy unlinked lines can still be recovered by the native path's legacy lookup. Historical batches shared by multiple invoices are rejected for ambiguous edit/delete/return operations; they are not silently split or relabelled as separate stock.

### 2. Purchase accounting references were not unique

Native reversals matched descriptions derived from supplier invoice numbers. The fallback edit used a broad `LIKE` expression. Those operations could affect another invoice's journal.

New journal/cash references contain the full internal invoice ID. Reversal prefers that exact reference, and ambiguous legacy references require reconciliation.

### 3. Return quantity tolerance could manufacture stock

Native sales/purchase return caps allowed an extra 0.005 units. A return of 1.004 against a sale/purchase of 1 could increase stock or refund more goods than were transacted.

Quantity comparisons now use a small floating-point tolerance of 0.000001, separate from currency tolerances. Purchase returns also no longer erase a positive stock remainder merely because it is below 0.0001. Tests cover exact partial returns, a fractional excess, repeat submissions and rollback.

### 4. Checkout accepted invalid native adjustments

The native checkout did not independently reject negative or non-finite invoice fees/discounts. A negative fee could offset the entire sale. Backend validation now rejects these inputs before stock or receipts are written; the frontend validation is not treated as the authority.

### 5. Sales-return writes and delivery refunds needed safeguards

The SQL fallback performed several return writes without a surrounding transaction. A late journal failure could leave stock and return records partially updated. Validation, remaining-quantity checks, stock, refund and accounting writes now share a transaction in the server fallback. Injected journal failures verify rollback.

Uncollected delivery invoices are refused for return until collection is settled: the original sale is still a receivable, so an ordinary cash refund would not correctly reverse it. Collected delivery returns remain covered by existing tests. A separate cancel/uncollected-delivery-return workflow was not invented.

Browser-only purchase and sales-return mutations now fail with a clear desktop-app instruction because their SQL bridge does not provide an atomic multi-statement transaction. Native desktop transactions and the server-side SQLite fallback are distinct from this unsupported browser path.

### 6. Stock displays did not all receive committed changes

Inventory, low-stock lists, the shortage notebook and POS search could stay stale while only selected alert widgets refreshed. Successful stock-changing actions now publish a common refresh signal after the write succeeds. Drafts and failed operations do not publish stock-change success.

Mounted views listen to the existing local event, a same-origin cross-window storage signal, and window focus. The POS refresh keeps the cart and search query. No new polling was added; the alert header's pre-existing timer remains. This is local-window synchronization, not synchronization between different computers/databases.

The unused unsafe duplicate negative-stock settlement function was removed. The supported selected-batch settlement action also publishes the stock refresh.

### 7. Purchase fallback costing diverged from native costing

The fallback allocated line tax to stock, but header tax/discounts/expenses did not consistently reach each lot's carrying cost. Creation, draft completion and supported completed edits now allocate the paid total consistently. Bonus boxes share the paid cost rather than creating additional cost.

Fallback edits with ambiguous repeated-drug lines, shared/unlinked historical lots, consumed stock, or payment-method changes are refused rather than applying the old unsafe drug-only matching logic. The native desktop edit path remains the supported route for those operations, subject to its own stock/history guards. Accounting failures now fail the operation instead of being swallowed.

Fallback purchase returns also previously trusted the caller's refund price, removed only paid stock rather than proportional bonus stock, and omitted their inventory journal. They now derive the refund from saved invoice data, deduct the matching bonus proportion, and write a balanced journal inside the same transaction. Tests deliberately submit a false price of 999 and compare the actual refund, stock carrying-value reduction and inventory credit. A unit-alias regression checks that `strip` is normalized consistently during both validation and deduction.

## Calculation rules checked

| Flow | Required relationship |
| --- | --- |
| Purchase | Received boxes = paid quantity + bonus quantity. |
| Purchase valuation | Line base = quantity × stored net purchase price × line-tax factor × invoice-tax factor. Allocate the final invoice amount proportionally across line bases, then divide by received boxes. Do not apply the stored line discount twice. |
| POS | Stock deduction uses the selected unit and the saved batch conversion; receipt revenue and stock cost are separate amounts. |
| Sales return | Remaining quantity is checked against the original sale and prior finalized returns; stock restores the original batch/conversion, not current master-drug packaging. |
| Purchase return | Refund uses saved purchase pricing/conversions. Paid units and their proportional bonus stock must leave the linked batch consistently. |
| Inventory display | Retail stock value and recorded purchase-cost value are different measures; neither is the cash drawer balance or shift revenue. |

## Executed coverage

- Native Rust/SQLite transactions: purchase lifecycle, taxes/discounts/bonus, separate expiry lots, same-number invoices, conversion snapshots, checkout, partial/repeated sales and purchase returns, wrong pharmacy/permissions, negative-sale settlement, legacy lot recovery and rollback.
- SQLite-backed JavaScript action tests: inventory/shortages, POS→sales return, patient ledgers, purchase reports, shift/handover effects, fresh/update fixtures, allocated purchase cost, injected accounting failure and unsupported-browser guards.
- Rendered component tests: mounted inventory refresh, POS search refresh without losing the cart/query, existing POS/purchase/return workflows and controls in the full Jest suite.
- Mocked IPC action tests: stock refresh after successful native commands, no notification after failed commands or draft checkout/purchase.
- Event tests: local dispatch, matching/irrelevant storage keys, window focus, blocked local storage and listener cleanup.

## Final verification results

| Check | Result |
| --- | --- |
| Full Jest suite, final code | **1,701 passed, 2 skipped; 224 suites passed, 1 skipped; 0 failures** |
| Full native Rust suite | **56 passed; 0 failed/ignored** |
| TypeScript (`tsc --noEmit --pretty false --incremental false`) | Passed |
| ESLint on changed production paths and the final regression tests | Passed |
| `git diff --check` | Passed |

The two skipped tests belong to `catalog-merge-artifact.regression.ts`: they require an explicitly supplied private repaired database and report through `PHARMA_RECOVERY_TEST_DB`. They were not silently counted as passing.

Reproducible commands:

```powershell
npx jest --runInBand --silent
cargo test --manifest-path src-tauri/Cargo.toml --quiet
npx tsc --noEmit --pretty false --incremental false
git diff --check
```

Local verification outputs: `scratch/stock-flow-final-jest.json`, `scratch/stock-flow-final-jest.log`, and `scratch/stock-flow-cargo.log`. The test suite compiles Rust test code, not a release installer.

## Limits and next checks

1. No release binaries/installers were built or pushed. No actual Windows 7/x86 or cross-machine runtime claim is made.
2. Rendered Jest tests and mocked IPC are not a packaged Tauri end-to-end test. Two real application windows, scanner/printer hardware, suspend/resume and abrupt power loss were not exercised here.
3. Existing customer databases were not opened or rewritten. Already mixed historical lots need backup-first reconciliation of quantity, cost, conversion and invoice ownership.
4. POS cart prices/quantities remain the user's current order snapshot; the refresh updates search availability, not the order's negotiated prices. Native checkout must still validate live stock at commit.
5. Manual opening/imported stock with no purchase cost cannot have an inferred trustworthy acquisition valuation; the existing missing-cost warning remains meaningful.
6. These tests do not constitute an exhaustive audit of every unrelated module, route, OS or business rule in the application.
7. The late-failure rollback checks cover the purchase and return workflows described above, not every manual inventory/edit/import failure point or every shared transaction-helper concurrency path.

Next release gate: use a disposable copy of a representative customer database in two actual Tauri windows, perform purchase → mixed-unit sale → both return types → handover, and verify the stock links, quantities, journal totals and refreshed screens before producing installers.
