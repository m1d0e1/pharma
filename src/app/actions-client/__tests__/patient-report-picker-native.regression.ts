/** @jest-environment node */
let mockUser: any = { id: 'reporter-a', role: 'cashier',
  permissions: { rep_can_view_sales: true }, pharmacy_id: 'branch-a' };
const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockDbSelect(...args),
  dbGet: (...args: any[]) => mockDbGet(...args),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'synthetic-id'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockUser,
  hasUserPermissionSync: (user: any, key: string) => Boolean(user?.permissions?.[key]),
}));
jest.unmock('@/app/actions-client/patients');

import { getPatientsAction } from '@/app/actions-client/patients';

describe('invoice-linked native patient report selector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'reporter-a', role: 'cashier',
      permissions: { rep_can_view_sales: true }, pharmacy_id: 'branch-a' };
    mockInvoke.mockResolvedValue([{ id: 'linked-invoice-patient',
      full_name: 'Patient A', name_en: 'Patient A' }]);
  });
  it('does not send private SQL, actor, or pharmacy IDs to select invoice-linked patients', async () => {
    expect(await getPatientsAction({ reportScope: true })).toEqual({
      success: true, data: [{ id: 'linked-invoice-patient',
        full_name: 'Patient A', name_en: 'Patient A' }],
    });
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'patients.report_picker', recordId: null,
      limit: 200, offset: 0, search: null, drugId: null,
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });
  it('does not retry unscoped SQL after a native pharmacy permission denial', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Patient ownership is ambiguous'));
    expect((await getPatientsAction({ reportScope: true })).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
    mockUser.permissions = {};
    expect((await getPatientsAction({ reportScope: true })).success).toBe(false);
  });
});
