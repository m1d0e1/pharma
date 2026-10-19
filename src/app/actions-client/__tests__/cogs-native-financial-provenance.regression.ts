import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'qa-owner', role: 'owner', pharmacy_id: 'qa-owned' })),
}));
jest.mock('@/lib/auth/staff-policy', () => ({ isStaffOwner: jest.fn(() => true) }));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: {} }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbGet: jest.fn(), dbExecute: jest.fn(), dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));

describe('strict native sold-item COGS provenance boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not disguise unauthorized private sales SQL as an empty native search', async () => {
    const result = await getSoldItemsForCogsAdjustmentAction('ACNEBLESS');
    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(result.error).toMatch(/قيود|موثق|أصلية/);
    expect(result).not.toHaveProperty('data');
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('refuses post-sale cost mutation without a native idempotent journal receipt', async () => {
    const result = await updateSoldItemCostAction(8, 120.25);
    expect(result).toEqual(expect.objectContaining({ success: false }));
    expect(result.error).toMatch(/قيود|موثق|أصلية/);
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('never posts a correction, rewrites sealed sale/return costs, or exposes private sale search for forged targets', async () => {
    // A receipted historical sale may already have several partial returns;
    // neither a forged target ID nor an arbitrary new cost establishes the
    // original line, tenant, historical cost, or return provenance.
    for (const itemId of [8, 999999, "8' OR 1=1 --", 'legacy-unknown']) {
      for (const newCost of [0.01, 120.25, -15, Number.NaN]) {
        const result = await updateSoldItemCostAction(itemId, newCost);
        expect(result).toEqual(expect.objectContaining({ success: false }));
        expect(result).not.toHaveProperty('data');
      }
    }
    for (const search of ['sale-id', 'foreign-tenant-sale', 'legacy-return']) {
      expect(await getSoldItemsForCogsAdjustmentAction(search)).toEqual(
        expect.objectContaining({ success: false }),
      );
    }
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});
