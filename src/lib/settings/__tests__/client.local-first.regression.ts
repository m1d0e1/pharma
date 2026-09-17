jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1 })),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
}));

let mockUser: any = { id: 'owner', role: 'owner', permissions: {} };
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

import { dbExecute, dbTransaction } from '@/lib/db/tauri';
import { runDatabaseMaintenanceClient, updatePharmacyClient } from '@/lib/settings/client';

const mockDbExecute = jest.mocked(dbExecute);
const mockDbTransaction = jest.mocked(dbTransaction);

describe('settings local-first persistence', () => {
  beforeEach(() => {
    mockUser = { id: 'owner', role: 'owner', permissions: {} };
    jest.clearAllMocks();
  });

  it('commits all pharmacy fields locally without cloud authentication', async () => {
    const formData = Object.fromEntries([
      'name', 'name_en', 'phone', 'address', 'commercial_registry', 'tax_card',
      'owner_name', 'owner_address', 'owner_phone', 'owner_mobile',
      'manager_name', 'manager_address', 'manager_phone', 'manager_mobile',
    ].map(key => [key, `value-${key}`]));

    const result = await updatePharmacyClient(formData);

    expect(result).toEqual({ success: true });
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    expect(mockDbExecute).toHaveBeenCalledTimes(14);
    expect(mockDbExecute).toHaveBeenCalledWith(expect.any(String), ['pharmacy_name', 'value-name']);
    expect(mockDbExecute).toHaveBeenCalledWith(expect.any(String), ['pharmacy_manager_mobile', 'value-manager_mobile']);
  });

  it('rejects direct settings writes without the local settings permission', async () => {
    mockUser = { id: 'staff', role: 'pharmacist', permissions: { can_view_settings: false } };

    expect(await updatePharmacyClient({ name: 'blocked' })).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('keeps database maintenance owner-only', async () => {
    mockUser = { id: 'admin', role: 'admin', permissions: { can_view_settings: true } };
    expect(await runDatabaseMaintenanceClient()).toEqual({ success: false, error: 'غير مصرح - للمالك فقط' });
    expect(mockDbExecute).not.toHaveBeenCalled();

    mockUser = { id: 'owner', role: 'owner', permissions: {} };
    expect((await runDatabaseMaintenanceClient()).success).toBe(true);
    expect(mockDbExecute).toHaveBeenCalledWith('VACUUM');
    expect(mockDbExecute).toHaveBeenCalledWith('ANALYZE');
  });
});
