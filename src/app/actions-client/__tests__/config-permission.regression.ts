/** @jest-environment node */

let mockSession: any;
const values = new Map<string, string>();
const dbExecute = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes('INSERT INTO config')) {
    values.set(String(params[0]), String(params[1]));
  }
  return { rowsAffected: 1, lastInsertId: 1 };
});

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => null),
  dbExecute: (sql: string, params: unknown[] = []) => dbExecute(sql, params),
  dbTransaction: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  isOwnerOrAdmin: jest.fn((user: any) => user?.role === 'owner' || user?.role === 'admin'),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

import { updateConfigAction } from '@/app/actions-client/config';
import { runDatabaseMaintenanceAction } from '@/app/actions-client/settings';

describe('config mutation permission boundary', () => {
  beforeEach(() => {
    mockSession = { id: 'owner-1', role: 'owner', permissions: {} };
    values.clear();
    jest.clearAllMocks();
  });

  it('honors an explicit settings denial for admins before writing config', async () => {
    mockSession = { id: 'admin-1', role: 'admin', permissions: { can_view_settings: false } };

    expect(await updateConfigAction('subscription_status', 'activated')).toEqual({ success: false, error: 'غير مصرح' });
    expect(values.has('subscription_status')).toBe(false);
  });

  it('lets a delegated staff user mutate config when can_view_settings is explicitly granted', async () => {
    mockSession = { id: 'manager-1', role: 'manager', permissions: { can_view_settings: true } };

    expect(await updateConfigAction('subscription_status', 'activated')).toEqual({ success: true });
    expect(values.get('subscription_status')).toBe('activated');
  });

  it('keeps legacy database maintenance owner-only even when settings access is granted', async () => {
    mockSession = { id: 'admin-1', role: 'admin', permissions: { can_view_settings: true } };

    expect(await runDatabaseMaintenanceAction()).toEqual({ success: false, error: 'غير مصرح - للمالك فقط' });
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
