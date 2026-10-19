/** @jest-environment node */

const invoke = jest.fn();
const select = jest.fn();
const getLocalSession = jest.fn();
const hasUserPermissionSync = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => invoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => select(...args),
  dbGet: jest.fn(), dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: (...args: any[]) => getLocalSession(...args),
  hasUserPermissionSync: (...args: any[]) => hasUserPermissionSync(...args),
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

import { getSalesInvoicesByDateAction } from '../returns';

describe('date-scoped sales invoices for returns native IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invoke.mockResolvedValue([
      { id: 'invoice-a', patient_id: null, total_amount: 20,
        created_at: '2026-10-10 10:00:00', status: 'delivered',
        user_name: 'Cashier', patient_name: null, payment_method: 'cash' },
    ]);
  });

  it('passes only the date to one fixed command and preserves the response projection', async () => {
    const result = await getSalesInvoicesByDateAction('2026-10-10');
    expect(result).toEqual({ success: true, data: [
      { id: 'invoice-a', patient_id: null, total_amount: 20,
        created_at: '2026-10-10 10:00:00', status: 'delivered',
        user_name: 'Cashier', patient_name: null, payment_method: 'cash' },
    ] });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('list_returnable_sales_invoices_by_date', {
      date: '2026-10-10',
    });
    expect(select).not.toHaveBeenCalled();
    expect(getLocalSession).not.toHaveBeenCalled();
    expect(hasUserPermissionSync).not.toHaveBeenCalled();
  });

  it('does not pass forged actor/pharmacy/role claims or a crafted invoice identifier', async () => {
    const hostile = "2026-10-10' OR 1=1 --";
    invoke.mockRejectedValueOnce(new Error('Invalid return invoice calendar date'));
    expect(await getSalesInvoicesByDateAction(hostile)).toEqual({
      success: false, error: 'Invalid return invoice calendar date',
    });
    expect(invoke).toHaveBeenCalledWith('list_returnable_sales_invoices_by_date', { date: hostile });
    expect(invoke.mock.calls[0][1]).toEqual({ date: hostile });
    expect(getLocalSession).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('propagates native session/permission denials and leaves database reads in Rust', async () => {
    for (const message of [
      'Login required before changing pharmacy records',
      'Authenticated user is not authorized to view returnable invoices',
      'Return invoice identifier is invalid',
    ]) {
      invoke.mockRejectedValueOnce(new Error(message));
      expect(await getSalesInvoicesByDateAction('2026-10-10')).toEqual({
        success: false, error: message,
      });
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(select).not.toHaveBeenCalled();
    expect(getLocalSession).not.toHaveBeenCalled();
  });
});
