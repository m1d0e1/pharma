import Database from 'better-sqlite3';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => 'mock-id'),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn().mockResolvedValue(undefined),
    getAllDrugs: jest.fn(() => [
      {
        id: 25093,
        trade_name: '1 2 3 (ONE TWO THREE) 20 F.C.TABS.',
        trade_name_en: null,
        official_price: 40,
        active_ingredient: 'CHLORPHENIRAMINE + PARACETAMOL(ACETAMINOPHEN) + PSEUDOEPHEDRINE',
        manufacturer: 'HIKMA PHARMA',
        barcode: null,
        is_medicine: 1,
        is_service: 0,
        stop_dealing: 0,
      },
      {
        id: 25094,
        trade_name: '1 2 3 (ONE TWO THREE) EXTRA 20 F.C.TABS.',
        trade_name_en: null,
        official_price: 50,
        active_ingredient: 'CHLORPHENIRAMINE + PARACETAMOL(ACETAMINOPHEN) + PSEUDOEPHEDRINE',
        manufacturer: 'HIKMA PHARMA',
        barcode: null,
        is_medicine: 1,
        is_service: 0,
        stop_dealing: 0,
      },
      {
        id: 25095,
        trade_name: '1 2 3 (ONE TWO THREE) SUSP. 120 ML',
        trade_name_en: null,
        official_price: 40,
        active_ingredient: 'CHLORPHENIRAMINE + PARACETAMOL(ACETAMINOPHEN) + PSEUDOEPHEDRINE',
        manufacturer: 'HIKMA PHARMA',
        barcode: null,
        is_medicine: 1,
        is_service: 0,
        stop_dealing: 0,
      },
      {
        id: 100029,
        trade_name: '1,2,3 tab',
        trade_name_en: '1,2,3 tab',
        official_price: 40,
        active_ingredient: null,
        manufacturer: null,
        barcode: '6221000000010',
        is_medicine: 1,
        is_service: 0,
        stop_dealing: 0,
      },
      {
        id: 100054,
        trade_name: 'one two three syp',
        trade_name_en: 'one two three syp',
        official_price: 32,
        active_ingredient: null,
        manufacturer: null,
        barcode: '6221000003295',
        is_medicine: 1,
        is_service: 0,
        stop_dealing: 0,
      },
    ]),
    updateDrug: jest.fn(),
    addDrug: jest.fn(),
    removeDrug: jest.fn(),
  },
}));

import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';

describe('1 2 3 drug search discovery regression', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY,
        trade_name TEXT NOT NULL,
        trade_name_en TEXT,
        generic_name TEXT,
        active_ingredient TEXT,
        barcode TEXT,
        official_price REAL DEFAULT 0,
        manufacturer TEXT,
        is_medicine INTEGER DEFAULT 1,
        is_service INTEGER DEFAULT 0,
        stop_dealing INTEGER DEFAULT 0
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        drug_id INTEGER,
        quantity REAL,
        cost_price REAL
      );
      INSERT INTO master_drugs (id, trade_name, official_price, active_ingredient, manufacturer) VALUES
        (25093, '1 2 3 (ONE TWO THREE) 20 F.C.TABS.', 40, 'CHLORPHENIRAMINE + PARACETAMOL(ACETAMINOPHEN) + PSEUDOEPHEDRINE', 'HIKMA PHARMA'),
        (25094, '1 2 3 (ONE TWO THREE) EXTRA 20 F.C.TABS.', 50, 'CHLORPHENIRAMINE + PARACETAMOL(ACETAMINOPHEN) + PSEUDOEPHEDRINE', 'HIKMA PHARMA'),
        (25095, '1 2 3 (ONE TWO THREE) SUSP. 120 ML', 40, 'CHLORPHENIRAMINE + PARACETAMOL(ACETAMINOPHEN) + PSEUDOEPHEDRINE', 'HIKMA PHARMA');
    `);
  });

  afterEach(() => {
    mockDb.close();
  });

  it('finds 1 2 3 (ONE TWO THREE) 20 F.C.TABS. when searching "1 2 3"', async () => {
    const res = await searchMasterDrugsAction({ query: '1 2 3' });
    expect(res.success).toBe(true);
    const names = res.data?.map((d: any) => d.trade_name);
    expect(names).toContain('1 2 3 (ONE TWO THREE) 20 F.C.TABS.');
    expect(names).toContain('1,2,3 tab');
  });

  it('finds 1 2 3 (ONE TWO THREE) 20 F.C.TABS. when searching without spaces "123"', async () => {
    const res = await searchMasterDrugsAction({ query: '123' });
    expect(res.success).toBe(true);
    const names = res.data?.map((d: any) => d.trade_name);
    expect(names).toContain('1 2 3 (ONE TWO THREE) 20 F.C.TABS.');
  });

  it('finds 1 2 3 (ONE TWO THREE) 20 F.C.TABS. when searching with commas "1,2,3"', async () => {
    const res = await searchMasterDrugsAction({ query: '1,2,3' });
    expect(res.success).toBe(true);
    const names = res.data?.map((d: any) => d.trade_name);
    expect(names).toContain('1 2 3 (ONE TWO THREE) 20 F.C.TABS.');
  });

  it('finds 1 2 3 (ONE TWO THREE) 20 F.C.TABS. when searching in Arabic "وان تو ثري"', async () => {
    const res = await searchMasterDrugsAction({ query: 'وان تو ثري' });
    expect(res.success).toBe(true);
    const names = res.data?.map((d: any) => d.trade_name);
    expect(names).toContain('1 2 3 (ONE TWO THREE) 20 F.C.TABS.');
  });

  it('finds 1 2 3 (ONE TWO THREE) 20 F.C.TABS. when searching spelled out "one two three"', async () => {
    const res = await searchMasterDrugsAction({ query: 'one two three' });
    expect(res.success).toBe(true);
    const names = res.data?.map((d: any) => d.trade_name);
    expect(names).toContain('1 2 3 (ONE TWO THREE) 20 F.C.TABS.');
  });
});
