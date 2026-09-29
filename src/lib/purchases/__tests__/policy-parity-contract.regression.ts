import { readFileSync } from 'fs';
import path from 'path';

import { buildPurchaseAccountingPlan } from '@/lib/purchases/accounting-policy';
import {
  assertCompletedPurchaseExpiryPolicy,
  assertNoDuplicatePurchaseLots,
  assertPurchaseItemsPolicy,
  assertPurchaseLifecyclePolicy,
  calculatePurchaseAllocation,
  normalizePurchaseDateToYMD,
} from '@/lib/purchases/policy';

type ContractItem = {
  id: number;
  quantity: number;
  cost_price: number;
  selling_price: number | null;
  bonus_quantity: number;
  tax_percent: number;
  discount_percent: number;
  strips_per_box: number;
  expiry_date: string | null;
};

type Contract = {
  lifecycle: Array<{
    name: string;
    status: string | null;
    payment_method: string | null;
    check_number: string | null;
    expected_ok: boolean;
  }>;
  dates: Array<{ name: string; input: string | null; expected: string | null }>;
  expiry: Array<{
    name: string;
    today: string;
    expiry_date: string | null;
    expected_ok: boolean;
  }>;
  lots: Array<{ name: string; items: ContractItem[]; expected_ok: boolean }>;
  items: Array<{ name: string; status: string; items: ContractItem[]; expected_ok: boolean }>;
  allocation: Array<{
    name: string;
    items: ContractItem[];
    header: {
      tax_percent: number;
      expenses: number;
      discount_value: number;
      discount_percent: number;
    };
    expected_total: number;
    expected_unit_costs: number[];
  }>;
  accounting: Array<{
    name: string;
    payment_method: string;
    total_amount: number;
    expected: {
      settlement_account: 'payable' | 'cash';
      supplier_balance_delta: number;
      supplier_transactions: Array<{ type: 'invoice' | 'payment'; amount: number }>;
      cash_movement: null | { type: 'disbursement'; amount: number };
    };
  }>;
};

const contract = JSON.parse(readFileSync(
  path.join(process.cwd(), 'contracts', 'purchase-policy-vectors.json'),
  'utf8',
)) as Contract;

function outcome(run: () => void) {
  try {
    run();
    return true;
  } catch {
    return false;
  }
}

describe('shared purchase-policy parity contract', () => {
  it.each(contract.lifecycle)('$name', vector => {
    expect(outcome(() => assertPurchaseLifecyclePolicy({
      status: vector.status ?? undefined,
      payment_method: vector.payment_method ?? undefined,
      check_number: vector.check_number ?? undefined,
    }))).toBe(vector.expected_ok);
  });

  it.each(contract.dates)('$name', vector => {
    expect(normalizePurchaseDateToYMD(vector.input)).toBe(vector.expected);
  });

  it.each(contract.expiry)('$name', vector => {
    expect(outcome(() => assertCompletedPurchaseExpiryPolicy([
      { id: 1, expiry_date: vector.expiry_date },
    ], vector.today))).toBe(vector.expected_ok);
  });

  it.each(contract.lots)('$name', vector => {
    expect(outcome(() => assertNoDuplicatePurchaseLots(vector.items))).toBe(vector.expected_ok);
  });

  it.each(contract.items)('$name', vector => {
    expect(outcome(() => assertPurchaseItemsPolicy(vector.items, vector.status))).toBe(vector.expected_ok);
  });

  it.each(contract.allocation)('$name', vector => {
    const result = calculatePurchaseAllocation(vector.items, vector.header);
    expect(result.finalTotal).toBeCloseTo(vector.expected_total, 8);
    expect(result.netUnitCosts).toHaveLength(vector.expected_unit_costs.length);
    result.netUnitCosts.forEach((cost, index) => {
      expect(cost).toBeCloseTo(vector.expected_unit_costs[index], 8);
    });
  });

  it.each(contract.accounting)('$name', vector => {
    const plan = buildPurchaseAccountingPlan(vector.payment_method, vector.total_amount);
    expect({
      settlement_account: plan.settlementAccount,
      supplier_balance_delta: plan.supplierBalanceDelta,
      supplier_transactions: plan.supplierTransactions,
      cash_movement: plan.cashMovement,
    }).toEqual(vector.expected);
  });
});
