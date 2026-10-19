import Database from 'better-sqlite3';
import { dbSelect } from '@/lib/db/tauri';
import { getUnusedItemsAction } from '@/app/actions-client/master-drugs';

let mockDb: Database.Database;
let mockSession: any = { id: 'authorized-admin', role: 'admin', permissions: { can_manage_inventory: true } };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    !!user && user.permissions?.[permission] === true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { reload: jest.fn(), updateDrug: jest.fn(), getAllDrugs: jest.fn(() => []) },
}));

jest.mock('@/lib/inventory/refresh', () => ({
  notifyDrugCatalogChanged: jest.fn(),
  notifyInventoryChanged: jest.fn(),
}));

const relationshipTables = [
  'inventory', 'sales_items', 'refill_reminders', 'return_items',
  'purchase_invoice_items', 'purchase_order_items', 'purchase_return_items',
  'opening_balance_items', 'shortages', 'drug_indications', 'drug_alternatives',
];

describe('getUnusedItemsAction list projection and safety boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'authorized-admin', role: 'admin', permissions: { can_manage_inventory: true } };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT,
        manufacturer TEXT, official_price REAL, is_medicine INTEGER,
        barcode TEXT, notes TEXT
      );
      INSERT INTO master_drugs VALUES
        (1,'برافو','Bravo','Maker A',7.5,1,'BARCODE-NOT-FOR-DELETE-LIST','PRIVATE-NOTE'),
        (2,'سجل مبيعات','Sold','Maker B',8.5,1,'BARCODE-2','NOTE-2'),
        (3,'صنف بديل','Alternative','Maker C',9.5,0,'BARCODE-3','NOTE-3');
    `);
    for (const table of relationshipTables) {
      mockDb.exec(
        table === 'drug_alternatives'
          ? 'CREATE TABLE drug_alternatives (id INTEGER PRIMARY KEY, drug_id INTEGER, alternative_id INTEGER)'
          : `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, drug_id INTEGER)`,
      );
    }
    mockDb.exec(`
      INSERT INTO sales_items(id,drug_id) VALUES (1,2);
      INSERT INTO drug_alternatives(id,drug_id,alternative_id) VALUES (1,2,3);
    `);
  });

  afterEach(() => mockDb.close());

  it('returns only the six fields used by delete-list/search and replacement identity, never full master records', async () => {
    const result = await getUnusedItemsAction();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{
      id: 1,
      trade_name: 'برافو',
      trade_name_en: 'Bravo',
      manufacturer: 'Maker A',
      official_price: 7.5,
      is_medicine: 1,
    }]);
    expect(Object.keys(result.data![0]).sort()).toEqual([
      'id', 'is_medicine', 'manufacturer', 'official_price', 'trade_name', 'trade_name_en',
    ]);
    const sql = (dbSelect as jest.Mock).mock.calls[0][0] as string;
    expect(sql).not.toContain('SELECT m.*');
    expect(sql).toMatch(/ORDER BY m\.trade_name ASC/);
    expect((sql.match(/EXISTS\(/g) || []).length).toBe(11);
    // Both source and alternative-target links must block destructive deletion.
    expect(sql).toMatch(/drug_id = m\.id OR alternative_id = m\.id/);
  });

  it('rejects revoked inventory permissions before reading any master-drug data', async () => {
    mockSession = { id: 'admin-revoked', role: 'admin', permissions: { can_manage_inventory: false } };
    await expect(getUnusedItemsAction()).resolves.toMatchObject({ success: false, error: 'Unauthorized' });
    expect(dbSelect).not.toHaveBeenCalled();
  });
});
