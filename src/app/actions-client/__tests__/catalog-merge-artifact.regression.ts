/** @jest-environment node */
// Opt-in read-only integration test for an offline repaired artifact. No private DB in git.
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let mockDb: Database.Database;
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(() => { throw new Error('Artifact validation must be read-only'); }),
  dbTransaction: jest.fn(() => { throw new Error('Artifact validation must be read-only'); }),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'validation-only', role: 'owner', pharmacy_id: 'local_default' })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { secureCache } from '@/lib/cache/secure_cache';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { barcodeLookupAction } from '@/app/actions-client/sales';

const artifact = process.env.PHARMA_RECOVERY_TEST_DB;
const suite = artifact ? describe : describe.skip;
suite('repaired catalog artifact through actual purchase search, cache and POS actions', () => {
  let report: { merges: { canonicalId: number; removedIds: number[]; name: string }[] };
  beforeAll(async () => {
    mockDb = new Database(artifact!, { readonly: true, fileMustExist: true });
    report = JSON.parse(readFileSync(artifact! + '.report.json', 'utf8'));
    await secureCache.reload();
  });
  afterAll(() => mockDb?.close());

  it('ANDODERMA search by name/barcode returns one corrected item after cache load and reload', async () => {
    for (let restart = 0; restart < 2; restart++) {
      await secureCache.reload();
      for (const query of ['ANDODERMA EXTRA EMOLLIENT GEL 50 ML', '6223004690259']) {
        const result = await searchMasterDrugsAction({ query });
        expect(result.success).toBe(true);
        const matching = result.data?.filter(d => d.trade_name === 'ANDODERMA EXTRA EMOLLIENT GEL 50 ML');
        expect(matching).toHaveLength(1);
        expect(matching?.[0]).toMatchObject({ id: 1135, barcode: '6223004690259', official_price: 149 });
      }
    }
  });

  it('every merged barcode with available stock resolves the canonical ID and correct sellable quantity', async () => {
    let checked = 0;
    for (const group of report.merges) {
      const drug = mockDb.prepare('SELECT barcode,official_price,active_ingredient FROM master_drugs WHERE id=?').get(group.canonicalId) as any;
      for (const id of group.removedIds) expect(secureCache.getDrug(id)).toBeUndefined();
      if (!drug.barcode) continue;
      const lots = mockDb.prepare(`SELECT quantity FROM inventory WHERE drug_id=?
        AND (pharmacy_id='local_default' OR pharmacy_id IS NULL) AND quantity>0
        AND (expiry_date IS NULL OR expiry_date>=date('now','localtime'))`).all(group.canonicalId) as any[];
      if (!lots.length) continue;
      const result = await barcodeLookupAction(drug.barcode);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ id: group.canonicalId, official_price: drug.official_price });
      expect(result.data?.quantity).toBeCloseTo(lots.reduce((sum, lot) => sum + lot.quantity, 0), 8);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    console.log(`Validated ${checked} merged barcode/stock flows through the actual POS action`);
  }, 60000);
});
