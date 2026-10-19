/** @jest-environment node */

const invoke = jest.fn();
const dbGet = jest.fn();
const dbSelect = jest.fn();
const dbTransaction = jest.fn();
let actor: any = { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a', permissions: {} };

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => dbSelect(...args),
  dbGet: (...args: unknown[]) => dbGet(...args),
  dbExecute: jest.fn(),
  dbTransaction: (...args: unknown[]) => dbTransaction(...args),
  generateId: () => 'qa-id',
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => actor,
  hasUserPermissionSync: () => true,
  verifyPassword: jest.fn(() => { throw new Error('password hash must not reach the renderer'); }),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(async () => ({ id: 'shift-a' })),
  ensurePermanentShiftForUser: jest.fn(),
}));
jest.mock('@/lib/finance/drawer', () => ({ loadHandoverDetails: jest.fn() }));

import { getLocalUsersClient } from '@/lib/settings/client';
import { getLocalUsersAction } from '@/app/actions-client/auth';
import { processHandoverAction } from '@/app/actions-client/handover';

const handover = {
  shiftId: 'shift-a', actualCash: 100, transferAmount: 50, transferTargetId: 'bank-1',
  transferTargetType: 'bank' as const, receiverUsername: 'cashier-a',
  receiverPasswordHash: 'plaintext-qa',
};

describe('Tauri credentials remain in native authentication code', () => {
  beforeEach(() => {
    actor = { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a', permissions: {} };
    jest.clearAllMocks();
    invoke.mockResolvedValue([{ id: 'staff-a', username: 'cashier-a', has_password: true }]);
    dbGet.mockResolvedValue({ id: 'staff-a', pharmacy_id: 'ph-a' });
  });

  it('loads native staff summaries without raw SELECT of password_hash', async () => {
    expect((await getLocalUsersClient()).success).toBe(true);
    expect((await getLocalUsersAction()).success).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('list_local_staff_summaries');
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('verifies receiver password inside one native handover posting, not a detached preflight', async () => {
    invoke.mockResolvedValue(null); // simulated native rejection
    const result = await processHandoverAction(handover);
    expect(result.success).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('process_handover_native', {
      payload: expect.objectContaining({
        shiftId:'shift-a',receiverUsername:'cashier-a',receiverPassword:'plaintext-qa',
        requestId:'qa-id',transferTargetType:'bank',
      }),
    });
    expect(invoke).not.toHaveBeenCalledWith('verify_handover_credentials', expect.anything());
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('blocks owner-managed closure until an atomic owner-authorized native workflow exists', async () => {
    invoke.mockResolvedValue(null);
    dbGet.mockResolvedValue({ id: 'staff-a', username: 'cashier-a', role: 'cashier', pharmacy_id: 'ph-a' });
    const result = await processHandoverAction({ ...handover, closeOnly: true,
      managedUserId: 'staff-a', authorizerPassword: 'owner-pass' });
    expect(result.success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});
