import { getLocalSession } from '@/lib/auth/local';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';
import { dbSelect, dbGet, dbExecute, dbTransaction, generateId } from '@/lib/db/tauri';

let mockIsTauri = false;
jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@/lib/auth/local', () => ({ getLocalSession: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbGet: jest.fn(), dbExecute: jest.fn(),
  dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));

const sourceError = 'SQL SELECT FROM patients WHERE token=patient-secret';
const nativeCalls = require('@tauri-apps/api/core').invoke as jest.Mock;

const expectNoPostingOrRead = () => {
  for (const operation of [dbSelect, dbGet, dbExecute, dbTransaction, generateId, nativeCalls]) {
    expect(operation).not.toHaveBeenCalled();
  }
};

describe('post-sale COGS unsafe-source and replay denial at the action boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLocalSession as jest.Mock).mockResolvedValue({
      id: 'owner', role: 'owner', pharmacy_id: 'owned-pharmacy',
    });
  });

  for (const native of [false, true]) {
    describe(native ? 'strict native runtime' : 'legacy browser runtime', () => {
      beforeEach(() => { mockIsTauri = native; });

      it('cannot turn an owner-supplied search into an unreceipted or foreign cost candidate', async () => {
        for (const search of ['sale-1', 'foreign-tenant', 'local_default', sourceError, '']) {
          const result = await getSoldItemsForCogsAdjustmentAction(search);
          expect(result).toMatchObject({ success: false });
          expect(result).not.toHaveProperty('data');
          expect(JSON.stringify(result)).not.toContain(sourceError);
        }
        expectNoPostingOrRead();
      });

      it('denies replay, conflicting retry and concurrent unreceipted cost changes', async () => {
        const forgedTargets: Array<number | string> = [
          1, 123_456, 'foreign-tenant', 'legacy-without-043-proof', "1' OR 1=1 --",
        ];
        const maliciousValues = [0, 0.001, 120.25, -1, NaN, Infinity, Number.MAX_VALUE];
        for (const id of forgedTargets) {
          for (const amount of maliciousValues) {
            const result = await updateSoldItemCostAction(id, amount);
            expect(result).toMatchObject({ success: false });
            expect(result).not.toHaveProperty('data');
          }
        }
        const retries = await Promise.all([
          updateSoldItemCostAction(1, 120.25),
          updateSoldItemCostAction(1, 120.25),
          updateSoldItemCostAction(1, 130.25),
        ]);
        expect(retries.every(result => result.success === false)).toBe(true);
        expectNoPostingOrRead();
      });

      it('refuses implicit/foreign tenant claims even with an owner role', async () => {
        for (const pharmacyId of [undefined, null, '', 'local_default', 'another-pharmacy']) {
          (getLocalSession as jest.Mock).mockResolvedValueOnce({ id: 'owner', role: 'owner', pharmacy_id: pharmacyId });
          const result = await updateSoldItemCostAction('sale-1', 120.25);
          expect(result.success).toBe(false);
        }
        expectNoPostingOrRead();
      });

      it('keeps a failed native/browser session read fail closed and does not leak error text', async () => {
        (getLocalSession as jest.Mock).mockRejectedValueOnce(new Error(sourceError));
        const result = await updateSoldItemCostAction(1, 120.25);
        expect(result).toMatchObject({ success: false });
        expect(JSON.stringify(result)).not.toContain(sourceError);
        expectNoPostingOrRead();
      });

      it('denies a non-owner regardless of the old view permission', async () => {
        (getLocalSession as jest.Mock).mockResolvedValueOnce({
          id: 'admin', role: 'admin', pharmacy_id: 'owned-pharmacy', permissions: { can_view_cogs: true },
        }).mockResolvedValueOnce(null);
        expect(await getSoldItemsForCogsAdjustmentAction('sale-1')).toEqual({ success: false, error: 'غير مصرح' });
        expect(await updateSoldItemCostAction(1, 120.25)).toEqual({ success: false, error: 'غير مصرح' });
        expectNoPostingOrRead();
      });
    });
  }
});
