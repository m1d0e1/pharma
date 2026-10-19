import { searchRecentReturnInvoicesAction } from '@/app/actions-client/returns';
import { invoke } from '@tauri-apps/api/core';
import { dbSelect } from '@/lib/db/tauri';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbGet: jest.fn(), dbExecute: jest.fn(),
  dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(), hasUserPermissionSync: jest.fn(),
}));

describe('strict native return invoice search', () => {
  beforeEach(() => jest.clearAllMocks());

  it('finds native-owned invoices by an ID prefix without renderer SQL', async () => {
    (invoke as jest.Mock).mockResolvedValue([{
      id: '3726c3df-c9cf-4e32-835a-848d045e69aa', total_amount: 300,
      patient_name: null, user_name: null, payment_method: 'cash',
      created_at: '2026-10-17 09:30:00',
    }]);
    await expect(searchRecentReturnInvoicesAction(' 3726c3df ')).resolves.toMatchObject({
      success: true,
      data: [expect.objectContaining({ id: '3726c3df-c9cf-4e32-835a-848d045e69aa' })],
    });
    expect(invoke).toHaveBeenCalledWith('search_returnable_sales_invoices_native', {
      searchTerm: '3726c3df', days: null,
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('routes bounded optional date window without renderer SQL', async () => {
    (invoke as jest.Mock).mockResolvedValue([]);
    await expect(searchRecentReturnInvoicesAction('Panadol', 7)).resolves.toMatchObject({
      success: true, data: [],
    });
    expect(invoke).toHaveBeenCalledWith('search_returnable_sales_invoices_native', {
      searchTerm: 'Panadol', days: 7,
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('fails closed on native denial rather than disguising it as an empty list', async () => {
    (invoke as jest.Mock).mockRejectedValue(new Error('Return source has unverified 043 provenance'));
    await expect(searchRecentReturnInvoicesAction('3726c3df')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('unverified 043'),
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });
});
