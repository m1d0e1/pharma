import Database from 'better-sqlite3';
import { getLocalSession } from '@/lib/auth/local';
import { dbSelect, dbGet, dbExecute, dbTransaction, generateId } from '@/lib/db/tauri';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';

// This was originally a regression for the browser-only cost-overwrite and
// generic journal path. That path cannot be used after immutable native sale
// and return accounting: retain its scenarios as negative source tests.
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbGet: jest.fn(), dbExecute: jest.fn(),
  dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({ getLocalSession: jest.fn() }));

let fixture: Database.Database;
const actor = { id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' };

const assertNoLegacySql = () => {
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
  expect(generateId).not.toHaveBeenCalled();
};

describe('sold-item COGS corrections cannot rewrite legacy or native source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getLocalSession as jest.Mock).mockResolvedValue(actor);
    fixture = new Database(':memory:');
    fixture.exec(`
      CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT);
      CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, quantity_sold REAL, unit TEXT, cost_price REAL);
      CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, status TEXT);
      CREATE TABLE return_items (return_id TEXT, sale_item_id INTEGER, quantity_returned REAL, unit TEXT);
      CREATE TABLE daily_journals (id TEXT PRIMARY KEY, pharmacy_id TEXT);
      CREATE TABLE journal_entries (journal_id TEXT, amount REAL);
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY, action TEXT);
      INSERT INTO sales_invoices VALUES ('sale-1', 'ph-1', 'completed'),
        ('sale-foreign', 'ph-2', 'completed'),
        ('sale-legacy', NULL, 'completed'),
        ('sale-draft', 'ph-1', 'draft');
      INSERT INTO sales_items VALUES
        (1,'sale-1',10,'medium',50), (2,'sale-foreign',1,'large',40),
        (3,'sale-legacy',1,'large',40), (4,'sale-draft',1,'large',40);
      INSERT INTO returns VALUES ('return-1','sale-1','approved');
      INSERT INTO return_items VALUES ('return-1',1,2,NULL);
    `);
  });

  afterEach(() => fixture.close());

  const snapshot = () => ({
    lines: fixture.prepare('SELECT * FROM sales_items ORDER BY id').all(),
    returns: fixture.prepare('SELECT * FROM return_items ORDER BY sale_item_id').all(),
    journals: fixture.prepare('SELECT * FROM daily_journals').all(),
    entries: fixture.prepare('SELECT * FROM journal_entries').all(),
    audits: fixture.prepare('SELECT * FROM activity_log').all(),
  });

  it('denies listing without assuming legacy NULL or foreign-tenancy sources are correctable', async () => {
    for (const search of ['Drug', 'sale-foreign', 'sale-legacy', 'sale-1']) {
      const result = await getSoldItemsForCogsAdjustmentAction(search);
      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty('data');
    }
    assertNoLegacySql();
  });

  it('rejects repeated sold-line corrections without changing costs, returns or journals', async () => {
    const before = snapshot();
    const requests: Array<[number | string, number]> = [
      [1, 55], [1, 55], [1, 45], [2, 45], [3, 45], [4, 45],
      [1, 0], [1, -10], [1, Number.NaN], [1, Infinity], ["1' OR 1=1 --", 100],
    ];
    for (const [id, cost] of requests) {
      const result = await updateSoldItemCostAction(id, cost);
      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty('data');
    }
    expect(snapshot()).toEqual(before);
    assertNoLegacySql();
  });

  it('denies parallel retry attempts without ever entering a posting transaction', async () => {
    const before = snapshot();
    const attempts = await Promise.all(Array.from({ length: 20 }, () => updateSoldItemCostAction(1, 55)));
    expect(attempts.every(result => result.success === false)).toBe(true);
    expect(snapshot()).toEqual(before);
    assertNoLegacySql();
  });

  it('does not allow admins to correct even with the obsolete COGS view flag', async () => {
    (getLocalSession as jest.Mock).mockResolvedValueOnce({
      id: 'admin-1', role: 'admin', pharmacy_id: 'ph-1', permissions: { can_view_cogs: true },
    }).mockResolvedValueOnce({ id: 'admin-1', role: 'admin', permissions: { can_view_cogs: true } });
    expect(await getSoldItemsForCogsAdjustmentAction('Drug')).toEqual({ success: false, error: 'غير مصرح' });
    expect(await updateSoldItemCostAction(1, 55)).toEqual({ success: false, error: 'غير مصرح' });
    assertNoLegacySql();
  });
});
