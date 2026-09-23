# Inventory valuation and financial terminology review

Scope: current working tree, including existing unreleased changes. No release build,
push, or customer-database modification. Independent reviews were delegated;
findings were checked against application code and executed tests before integration.

## Confirmed issues corrected

1. **Incomplete inventory totals:** `getInventoryListAction` silently returned at
   most 1,000 positive-quantity lots, although the table calculated totals and paged
   over that returned array. Removed that cap. Search and pharmacy filters remain.
2. **Ambiguous inventory value:** the headline was quantity multiplied by lot selling
   price, not purchase cost. It now says `قيمة المخزون بسعر البيع`, shows
   `التكلفة المسجلة` separately, and warns about positive-stock lots with zero/missing
   cost. No historical cost is guessed from selling price.
3. **POS cash counted twice:** the supported POS handover action increases the POS
   operational balance without taking that cash out of the cash-account ledger.
   The liquidity card used to add both. It now adds cash-account balance plus
   recorded bank balances, without adding POS balances again. No ledger/history
   rewrite or new transfer journal was introduced.
4. **Treasury/drawer terminology:** financial summary, dashboard shift widget,
   handover screens, shift history and shift report now distinguish cash-account
   balance, shift sales, expected drawer cash, counted drawer cash, and money handed
   over. The valid transfer destination `الخزينة الرئيسية` is unchanged.

## What the numbers mean

| Display | Meaning |
| --- | --- |
| قيمة المخزون بسعر البيع | Sum of positive lot quantity × that lot's large-unit selling price |
| التكلفة المسجلة | Sum of the same quantities × recorded lot cost |
| رصيد النقدية الدفتري | Debit minus credit entries in the configured cash account, within pharmacy scope |
| مبيعات الوردية (كل طرق الدفع) | Completed/accepted shift sales across payment methods; not drawer cash or profit |
| النقدية المتوقعة بدرج الوردية | Opening float + eligible cash sales − cash refunds + net shift cash movements |
| تسليمات الورديات | Recorded cash transfers, not new sales revenue |

Inventory totals cover all matching returned lots, not only the displayed page;
they include expired positive stock. Quantities are large-unit equivalents, including
fractions. These operational sums are not a certified inventory valuation or physical
cash count. Shift sales are not described as net profit or net sales after returns.

## Executed regression coverage

Final verification: full Jest suite **1,669 passed, 2 skipped** (219 passed suites,
1 skipped); Rust **50 passed**; TypeScript, ESLint and `git diff --check` passed.
Two tests retained old UI wording and were updated to the new precise labels;
the full Jest rerun passed after those changes.

- Real SQLite inventory action: 1,001 matching lots, fractional quantity, different
  cost/selling prices, search isolation and exclusion of another pharmacy's stock.
- Rendered inventory table: multi-page totals, filtered totals, empty result,
  recorded cost versus selling value, and zero-cost warning.
- Real SQLite handover actions: recorded cash 100, POS transfer 60 leaves cash ledger
  100 and POS balance 60; bank transfer 60 leaves cash ledger 40 and bank balance 60.
- Rendered finance summary: total stays 120 for cash/bank balances 100/20 or 40/80,
  and adding an operational POS balance of 60 does not increase it to 180.
- Rendered shift report/dashboard: drawer and sales labels remain distinct; existing
  shift selection, request-race and handover tests also run.
- Native SQLite startup test: inserted journals/expenses without explicit pharmacy
  IDs receive the actor's branch and retain that branch and amounts after staff move.

## Findings deliberately not turned into accounting changes

- Startup triggers already assign pharmacy scope to journals and expenses. Missing
  explicit IDs in inserts are not by themselves a confirmed branch-reporting bug.
- An opening float may already be recorded cash. Automatically posting it again
  would risk double counting; drawer opening cash and ledger balance need not match.
- Direct Add Inventory can create zero-cost stock. The UI now flags it, but existing
  costs remain unchanged. Use cost-bearing purchase/opening-balance workflows and
  reconcile source documents before correcting historical zero-cost lots.

## Limits and next checks

- Inventory still uses client pagination. Removing truncation favors correctness;
  for very large lot counts, measure load time before introducing SQL pagination
  with separate filtered aggregates.
- Bank balances are recorded operational balances, not live bank reconciliation.
  POS balances manually entered outside ledger postings are not independent assets
  to add blindly to the cash account.
- Tests use fixtures and component rendering, not a customer's live database or a
  packaged desktop UI. Windows x86/x64/Windows 7 installation tests were not run.
- No broad claim that every historical price, cost, stock balance, or accounting
  record is correct: that requires reconciliation with actual source documents.
