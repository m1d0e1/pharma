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
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    addDrug: jest.fn(),
    removeDrug: jest.fn(),
  },
}));

import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';

describe('searchMasterDrugsAction search and filter browsing regression', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_name TEXT NOT NULL,
        trade_name_en TEXT,
        generic_name TEXT,
        active_ingredient TEXT,
        barcode TEXT,
        official_price REAL DEFAULT 0,
        category TEXT,
        manufacturer TEXT,
        is_medicine INTEGER DEFAULT 1,
        is_service INTEGER DEFAULT 0,
        stop_dealing INTEGER DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        drug_id INTEGER NOT NULL,
        quantity REAL NOT NULL,
        cost_price REAL DEFAULT 0
      );

      INSERT INTO master_drugs (id, trade_name, trade_name_en, official_price, is_medicine, is_service, stop_dealing)
      VALUES
        (1, 'كونكور 5', 'Concor 5mg', 35, 1, 0, 0),
        (2, 'بنادول أزرق', 'Panadol Blue', 25, 1, 0, 0),
        (3, 'قياس ضغط', 'Blood Pressure Check', 10, 0, 1, 0),
        (4, 'دواء موقوف', 'Stopped Drug', 50, 1, 0, 1);
    `);
  });

  afterEach(() => {
    mockDb.close();
  });

  it('returns empty array when called with empty string for autocomplete modals', async () => {
    const res = await searchMasterDrugsAction('');
    expect(res.success).toBe(true);
    expect(res.data).toEqual([]);
  });

  it('returns catalog items when called with options and empty query', async () => {
    const res = await searchMasterDrugsAction({ query: '', type: 'all', status: 'all' });
    expect(res.success).toBe(true);
    expect(res.data?.length).toBeGreaterThan(0);
    const names = res.data?.map((d: any) => d.trade_name);
    expect(names).toContain('كونكور 5');
    expect(names).toContain('بنادول أزرق');
  });

  it('filters by type correctly even without a text query', async () => {
    const res = await searchMasterDrugsAction({ query: '', type: 'service' });
    expect(res.success).toBe(true);
    expect(res.data?.length).toBe(1);
    expect(res.data?.[0].trade_name).toBe('قياس ضغط');
  });

  it('filters by status correctly even without a text query', async () => {
    const res = await searchMasterDrugsAction({ query: '', status: 'stopped' });
    expect(res.success).toBe(true);
    expect(res.data?.length).toBe(1);
    expect(res.data?.[0].trade_name).toBe('دواء موقوف');
  });

  it('searches by keyword matching trade name', async () => {
    const res = await searchMasterDrugsAction({ query: 'Concor' });
    expect(res.success).toBe(true);
    expect(res.data?.length).toBe(1);
    expect(res.data?.[0].trade_name_en).toBe('Concor 5mg');
  });
});
