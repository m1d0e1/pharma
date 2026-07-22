import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getLocalSession } from '@/lib/auth/local';
import { barcodeLookupAction, searchPatientsAction } from '@/app/actions-client/sales';

jest.mock('@/lib/db/tauri', () => ({
  dbGet: jest.fn(),
  dbSelect: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'id'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: {} }));
jest.mock('@/lib/env', () => ({ isTauri: false }));

beforeEach(() => {
  jest.clearAllMocks();
});

test('POS barcode scan selects sellable inventory and totals its batches', async () => {
  (getLocalSession as jest.Mock).mockResolvedValue({ id: 'admin' });
  (dbGet as jest.Mock).mockResolvedValue({
    id: 4463,
    trade_name: 'COLONA',
    official_price: 69,
    unit_price: 69,
    quantity: 0,
    inventory_id: 'valid-first',
    nearest_expiry: '2027-01-01',
    strips_per_box: 3,
    large_to_medium: 3,
  });
  (dbSelect as jest.Mock).mockResolvedValue([
    { inventory_id: 'valid-first', quantity: 2, expiry_date: '2027-01-01', local_selling_price: 69 },
    { inventory_id: 'valid-second', quantity: 5, expiry_date: '2027-06-01', local_selling_price: 69 },
  ]);

  const result = await barcodeLookupAction('6221234567890');

  expect(result.success).toBe(true);
  expect(result.data?.quantity).toBe(7);
  expect(result.data?.inventory_id).toBe('valid-first');
  expect((dbGet as jest.Mock).mock.calls[0][0]).toContain('i.quantity > 0');
  expect((dbGet as jest.Mock).mock.calls[0][0]).toContain('i.expiry_date >= ?');
});

test('POS patient search includes the current outstanding debit', async () => {
  (getLocalSession as jest.Mock).mockResolvedValue({ id: 'admin' });
  (dbSelect as jest.Mock).mockResolvedValue([{
    id: 'patient-1',
    full_name: 'Test Patient',
    phone: null,
    outstanding_balance: 125.5,
  }]);

  const result = await searchPatientsAction('Test');

  expect(result).toMatchObject({
    success: true,
    data: [{ id: 'patient-1', outstanding_balance: 125.5 }],
  });
  const query = (dbSelect as jest.Mock).mock.calls[0][0];
  expect(query).toContain("si.payment_method = 'credit'");
  expect(query).toContain("si.status = 'completed'");
  expect(query).toContain("WHEN pt.type = 'payment' THEN -ABS");
  expect(query).toContain("WHEN pt.type = 'adjustment' THEN CAST(pt.amount AS REAL)");
  expect(query).toContain("r.refund_method = 'patient_account'");
  expect(query).toContain("r.status = 'approved'");
});
