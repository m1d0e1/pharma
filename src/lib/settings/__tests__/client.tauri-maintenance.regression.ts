jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => undefined) }));
jest.mock('@/lib/env', () => ({ isTauri: true }));

jest.mock('@/lib/db/tauri', () => ({
  dbExecute: jest.fn(async () => ({ rowsAffected: 1 })),
  dbSelect: jest.fn(async () => []),
  dbTransaction: jest.fn(),
}));

let user: any = { id: 'owner-1', role: 'owner', permissions: {} };
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => user),
  hasUserPermissionSync: jest.fn(() => true),
}));

import { runDatabaseMaintenanceClient, updatePharmacyClient } from '@/lib/settings/client';
import { invoke } from '@tauri-apps/api/core';
import { dbExecute, dbTransaction } from '@/lib/db/tauri';

const mockInvoke = jest.mocked(invoke);
const mockDbExecute = jest.mocked(dbExecute);
const mockDbTransaction = jest.mocked(dbTransaction);

describe('Tauri database maintenance native boundary', () => {
  beforeEach(() => {
    user = { id: 'owner-1', role: 'owner', permissions: {} };
    jest.clearAllMocks();
  });

  it('uses the owner-checked native command instead of renderer SQL', async () => {
    expect((await runDatabaseMaintenanceClient()).success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('run_database_maintenance', { userId: 'owner-1' });
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('does not invoke native maintenance for a non-owner session', async () => {
    user = { id: 'admin-1', role: 'admin', permissions: { can_view_settings: true } };
    expect(await runDatabaseMaintenanceClient()).toEqual({
      success: false,
      error: 'غير مصرح - للمالك فقط',
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('uses the typed native pharmacy-settings command without renderer SQL', async () => {
    user = { id: 'manager-1', role: 'manager', pharmacy_id: 'ph-a', permissions: { can_view_settings: true } };
    expect(await updatePharmacyClient({ name: 'Pharmacy A', phone: 111, owner_name: null })).toEqual({ success: true });

    expect(mockInvoke).toHaveBeenCalledWith('update_pharmacy_settings', {
      userId: 'manager-1',
      payload: expect.objectContaining({
        name: 'Pharmacy A',
        phone: '111',
        owner_name: '',
      }),
    });
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
  });
});
