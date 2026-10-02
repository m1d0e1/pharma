/** @jest-environment node */

import { createFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let sourceDraft: any = null;
let permissionOverrides: Record<string, boolean> = {};
let transactionCalls = 0;
let executedSql: string[] = [];

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async (sql: string) => {
    if (/SELECT id, pharmacy_id, status FROM sales_invoices WHERE id = \?/i.test(sql)) return sourceDraft;
    return null;
  }),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 })),
  dbTransaction: jest.fn(async (callback: any) => {
    transactionCalls += 1;
    const tx = createFunctionTransactionDb({
      select: () => [],
      get: (sql: string) => {
        if (/SELECT id, pharmacy_id, status FROM sales_invoices WHERE id = \?/i.test(sql)) return sourceDraft;
        return null;
      },
      execute: (sql: string) => {
        executedSql.push(sql);
        return { rowsAffected: 1 };
      },
    });
    return callback(tx);
  }),
  generateId: jest.fn(() => 'new-sale'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'pharmacist', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn((_user: any, key: string) => permissionOverrides[key] ?? true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), enrich: jest.fn((rows: any[]) => rows) },
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(async () => null),
  ensurePermanentShiftForUser: jest.fn(async () => ({ id: 'shift-1' })),
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

jest.unmock('@/app/actions-client/sales');
import { processCheckoutAction } from '@/app/actions-client/sales';

const request = {
  items: [{
    drug_id: 1,
    inventory_id: null,
    quantity_sold: 1,
    unit_price: 10,
    item_discount_percent: 0,
    selected_unit: 'large',
    is_negative: false,
  }],
  payment_method: 'cash',
  status: 'completed',
  source_draft_id: 'source-1',
};

describe('processCheckoutAction source draft boundary', () => {
  beforeEach(() => {
    sourceDraft = { id: 'source-1', pharmacy_id: 'ph-1', status: 'draft' };
    permissionOverrides = {};
    transactionCalls = 0;
    executedSql = [];
    const shifts = jest.requireMock('@/app/actions-client/shifts') as {
      ensurePermanentShiftForUser: jest.Mock;
    };
    shifts.ensurePermanentShiftForUser.mockClear();
  });

  it('rejects source-draft completion without suspended-invoice visibility before replacement writes', async () => {
    permissionOverrides.show_suspended_invoices = false;

    expect(await processCheckoutAction(request)).toEqual({
      success: false,
      error: 'غير مصرح باستكمال الفواتير المعلقة',
    });
    const shifts = jest.requireMock('@/app/actions-client/shifts') as {
      ensurePermanentShiftForUser: jest.Mock;
    };
    expect(shifts.ensurePermanentShiftForUser).not.toHaveBeenCalled();
    expect(transactionCalls).toBe(0);
    expect(executedSql).toEqual([]);
  });

  it.each([
    [null, 'الفاتورة المعلقة المحددة غير موجودة'],
    [{ id: 'source-1', pharmacy_id: 'ph-2', status: 'draft' }, 'الفاتورة المعلقة تتبع صيدلية أخرى'],
    [{ id: 'source-1', pharmacy_id: 'ph-1', status: 'completed' }, 'الفاتورة المحددة لم تعد فاتورة معلقة'],
  ] as const)('rejects an invalid source draft without replacing it', async (draftRow, error) => {
    sourceDraft = draftRow;

    expect(await processCheckoutAction(request)).toEqual({ success: false, error });
    const shifts = jest.requireMock('@/app/actions-client/shifts') as {
      ensurePermanentShiftForUser: jest.Mock;
    };
    expect(shifts.ensurePermanentShiftForUser).not.toHaveBeenCalled();
    expect(transactionCalls).toBe(0);
    expect(executedSql).toEqual([]);
  });
});
