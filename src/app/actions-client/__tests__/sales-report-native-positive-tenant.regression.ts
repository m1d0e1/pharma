/** @jest-environment node */
const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
let actor: any = { id: 'reporter-a', pharmacy_id: 'tenant-a', role: 'pharmacist', permissions: { rep_can_view_sales: true } };

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbExecute: jest.fn(), dbGet: jest.fn(), dbTransaction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => actor,
  hasUserPermissionSync: (user: any, key: string) => !!user?.permissions?.[key],
}));

import { getInvoiceDetailsAction, getSalesReportsAction } from '@/app/actions-client/sales-reports';

const owned = (id: string, extra: any = {}) => ({
  id, pharmacy_id: 'tenant-a', user_id: 'staff-a', patient_id: 'patient-a',
  created_at: '2026-10-12 10:00:00', status: 'completed', payment_method: 'cash',
  total_amount: 75, discount_amount: 5, ...extra,
});

describe('sales report typed native nonempty tenant read (no generic SQL)', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockDbSelect.mockReset().mockImplementation(() => { throw new Error('PRIVATE SQL IS FORBIDDEN'); });
    actor = { id: 'reporter-a', pharmacy_id: 'tenant-a', role: 'pharmacist', permissions: { rep_can_view_sales: true } };
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns only verified typed current-tenant invoices and applies all report filters', async () => {
    mockInvoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped' || args.queryId !== 'sales.invoices') throw Error('untrusted command');
      return args.offset === 0 ? [
        owned('A-12'), owned('A-13', { payment_method: 'visa' }),
        owned('A-draft', { status: 'draft' }), owned('A-14', { patient_id: null }),
      ] : [];
    });
    const result = await getSalesReportsAction({
      startDate: '2026-10-12', endDate: '2026-10-12', userId: 'staff-a',
      patientId: 'patient-a', paymentMethod: 'cash', invoiceNumber: 'A-12',
      pharmacyId: 'tenant-b',
    });
    expect(result).toMatchObject({ success: true, data: [{
      id: 'A-12', pharmacy_id: 'tenant-a', total_amount: 75, discount_amount: 5,
    }] });
    expect((result as any).data).toHaveLength(1);
    expect((result as any).data[0].refunded_amount).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'sales.invoices', recordId: null, search: null,
      drugId: null, limit: 200, offset: 0,
    });
    expect(mockInvoke.mock.calls[0][1]).not.toHaveProperty('pharmacyId');
    expect(mockInvoke.mock.calls[0][1]).not.toHaveProperty('sql');
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('paginates fully and sorts newest invoice first without return-affecting fake zeroes', async () => {
    const first = Array.from({ length: 200 }, (_, i) =>
      owned('A-' + String(i).padStart(3, '0'), { created_at: '2026-10-11 10:00:00' }));
    mockInvoke.mockImplementation(async (_command: string, args: any) =>
      args.offset === 0 ? first : [owned('A-latest', { created_at: '2026-10-13 12:00:00' })]);
    const result = await getSalesReportsAction({});
    expect(result.success).toBe(true);
    expect((result as any).data).toHaveLength(201);
    expect((result as any).data[0].id).toBe('A-latest');
    expect(mockInvoke.mock.calls.map(([, args]: any) => args.offset)).toEqual([0, 200]);
  });

  it('fails closed on a foreign, null-owner, legacy or malformed native response and never falls back', async () => {
    for (const bad of [
      owned('foreign-private', { pharmacy_id: 'tenant-b' }),
      owned('legacy-private', { pharmacy_id: null }),
      owned('default-private', { pharmacy_id: 'local_default' }),
      { id: 'incomplete', pharmacy_id: 'tenant-a' },
    ]) {
      mockInvoke.mockReset().mockResolvedValueOnce([owned('A-good'), bad]);
      const result = await getSalesReportsAction({});
      expect(result).toEqual({ success: false, error: 'فشل جلب تقرير المبيعات' });
      expect(mockDbSelect).not.toHaveBeenCalled();
    }
  });

  it('rejects legacy local_default or lost reporting permission before native reads', async () => {
    actor.pharmacy_id = 'local_default';
    expect((await getSalesReportsAction({})).success).toBe(false);
    expect((await getInvoiceDetailsAction('invoice-a')).success).toBe(false);
    actor.pharmacy_id = 'tenant-a';
    actor.permissions.rep_can_view_sales = false;
    expect(await getSalesReportsAction({})).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('native permission rejection is an error state, not empty success or renderer SQL fallback', async () => {
    mockInvoke.mockRejectedValue(new Error('native reporter permission revoked'));
    const result = await getSalesReportsAction({});
    expect(result).toEqual({ success: false, error: 'فشل جلب تقرير المبيعات' });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('does not fabricate a receipt using unenriched native sale items', async () => {
    const result = await getInvoiceDetailsAction('A-12');
    expect(result.success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
