jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => undefined) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => null),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1 })),
  dbTransaction: jest.fn(),
}));

let user: any = { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a' };
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => user),
  getLocalSession: jest.fn(async () => user),
  hasUserPermissionSync: jest.fn(() => true),
}));

import { invoke } from '@tauri-apps/api/core';
import { dbExecute } from '@/lib/db/tauri';
import { clearAuditLogsAction } from '@/app/actions-client/audit';

const mockInvoke = jest.mocked(invoke);
const mockDbExecute = jest.mocked(dbExecute);

describe('Tauri audit mutation boundary', () => {
  beforeEach(() => {
    user = { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a' };
    jest.clearAllMocks();
  });

  it('clears through the scoped native command instead of renderer DELETE', async () => {
    expect(await clearAuditLogsAction()).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('clear_audit_logs', { userId: 'owner-a' });
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('does not invoke clear for a non-owner session', async () => {
    user = { id: 'admin-a', role: 'admin', pharmacy_id: 'ph-a' };
    expect(await clearAuditLogsAction()).toMatchObject({ success: false });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
