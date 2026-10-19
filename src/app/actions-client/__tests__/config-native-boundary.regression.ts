jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => undefined) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => null),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1 })),
  dbTransaction: jest.fn(),
}));

let user: any = { id: 'manager-a', role: 'manager', pharmacy_id: 'ph-a', permissions: { can_view_settings: true } };
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => user),
  hasUserPermissionSync: jest.fn((value: any, key: string) => value?.role === 'owner' || value?.permissions?.[key] === true),
}));

import { invoke } from '@tauri-apps/api/core';
import { dbExecute } from '@/lib/db/tauri';
import { updateConfigAction } from '@/app/actions-client/config';

const mockInvoke = jest.mocked(invoke);
const mockDbExecute = jest.mocked(dbExecute);

describe('Tauri config mutation boundary', () => {
  beforeEach(() => {
    user = { id: 'manager-a', role: 'manager', pharmacy_id: 'ph-a', permissions: { can_view_settings: true } };
    jest.clearAllMocks();
  });

  it('routes config writes through the typed native command', async () => {
    expect(await updateConfigAction('pharmacy_name', 'Pharmacy A')).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('update_config_value', {
      userId: 'manager-a',
      key: 'pharmacy_name',
      value: 'Pharmacy A',
    });
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('stops before native mutation when settings permission is denied', async () => {
    user = { id: 'admin-a', role: 'admin', pharmacy_id: 'ph-a', permissions: { can_view_settings: false } };
    expect(await updateConfigAction('unrelated_global_setting', 'enabled')).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
