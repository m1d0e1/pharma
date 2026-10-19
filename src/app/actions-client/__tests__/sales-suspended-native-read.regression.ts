/** @jest-environment node */

import Database from 'better-sqlite3';

const mockInvoke = jest.fn();
let mockDb: Database.Database;
let mockSession: any;
let mockIsTauri = true;
const mockDbSelect = jest.fn(async (sql: string, args: any[] = []) => mockDb.prepare(sql).all(...args));
const mockDbGet = jest.fn(async (sql: string, args: any[] = []) => mockDb.prepare(sql).get(...args) || null);

jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockDbSelect(args[0], args[1]),
  dbGet: (...args: any[]) => mockDbGet(args[0], args[1]),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) => Boolean(user?.permissions?.[permission])),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(),
  getShiftForPharmacy: jest.fn(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), enrich: jest.fn((rows: any[]) => rows) },
}));

import { fetchDraftsAction } from '@/app/actions-client/sales';

describe('suspended POS invoice native read migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    mockSession = {
      id: 'cashier-a', role: 'cashier', pharmacy_id: 'a',
      permissions: { can_access_pos: true, show_suspended_invoices: true },
    };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE patients(id TEXT,full_name TEXT);
      INSERT INTO patients VALUES('patient-a','Patient A'),('patient-b','Patient B');
      CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,status TEXT,patient_id TEXT,
        total_amount REAL,created_at TEXT,payment_method TEXT,check_number TEXT,discount_amount REAL);
      INSERT INTO sales_invoices VALUES
        ('draft-a','a','draft','patient-a',25,'2026-10-10 12:00:00','check','CHK-9',2),
        ('draft-b','b','draft','patient-b',999,'2026-10-11 12:00:00','cash',NULL,0),
        ('completed-a','a','completed',NULL,30,'2026-10-11 10:00:00','cash',NULL,0);
      CREATE TABLE master_drugs(id INTEGER,has_expiry INTEGER,trade_name TEXT,
        trade_name_en TEXT,active_ingredient TEXT,large_unit TEXT,medium_unit TEXT,
        small_unit TEXT,large_to_medium INTEGER,medium_to_small INTEGER,official_price REAL);
      INSERT INTO master_drugs VALUES
        (1,1,'Medicine A','Medicine A','A','box','strip','tablet',10,2,15),
        (2,1,'Medicine B','Medicine B','B','box','strip','tablet',10,1,4);
      CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,
        quantity_sold REAL,unit_price REAL,item_discount_percent REAL,unit TEXT,is_negative INTEGER);
      INSERT INTO sales_items VALUES
        (1,'draft-a',1,1,15,10,'large',0),
        (2,'draft-a',2,1,4,0,'large',1),
        (3,'draft-b',1,1,999,0,'large',0);
      CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,drug_id INTEGER,quantity INTEGER,
        expiry_date TEXT,local_selling_price REAL,strips_per_box INTEGER,
        medium_to_small INTEGER,created_at TEXT);
      INSERT INTO inventory VALUES
        ('eligible-a','a',1,3,'2099-12-31',17,10,2,'2026-10-01'),
        ('expired-a','a',1,20,'2020-01-01',17,10,2,'2026-10-01'),
        ('foreign-b','b',1,90,'2099-12-31',90,10,2,'2026-10-01'),
        ('negative-a','a',2,99,'2099-12-31',5,10,1,'2026-10-01');
    `);
    mockInvoke.mockImplementation(async (command: string, payload: any) => {
      if (command !== 'db_read_scoped') throw new Error('Unexpected native operation');
      const { queryId, recordId, limit, offset } = payload;
      const rows = queryId === 'sales.suspended.list'
        ? mockDb.prepare(`SELECT si.id,si.total_amount,si.created_at,p.full_name AS patient_name,
            si.patient_id,si.payment_method,si.check_number,si.discount_amount
            FROM sales_invoices si LEFT JOIN patients p ON si.patient_id=p.id
            WHERE si.pharmacy_id='a' AND si.status='draft' ORDER BY si.created_at DESC,si.id DESC`).all()
        : queryId === 'sales.suspended.items'
          ? mockDb.prepare(`SELECT si.drug_id,si.quantity_sold AS qty,si.unit_price AS price,
              COALESCE(si.item_discount_percent,0) AS item_discount_percent,
              si.unit AS selectedUnit,si.is_negative,md.trade_name,md.trade_name_en,
              md.active_ingredient,md.large_unit,md.medium_unit,md.small_unit,
              md.large_to_medium,md.medium_to_small,md.official_price
              FROM sales_items si JOIN sales_invoices invoice ON invoice.id=si.invoice_id
              LEFT JOIN master_drugs md ON si.drug_id=md.id
              WHERE invoice.id=? AND invoice.pharmacy_id='a' AND invoice.status='draft'
              ORDER BY si.id`).all(recordId)
          : queryId === 'sales.suspended.batches'
            ? mockDb.prepare(`SELECT i.id AS inventory_id,i.drug_id,i.quantity,i.expiry_date,
                i.local_selling_price,i.strips_per_box,i.medium_to_small FROM inventory i
                WHERE i.drug_id IN (SELECT si.drug_id FROM sales_items si
                  WHERE si.invoice_id=? AND COALESCE(si.is_negative,0)=0)
                AND i.pharmacy_id='a' AND i.quantity>0 AND i.expiry_date>='2026-10-11'
                ORDER BY i.expiry_date ASC,i.created_at ASC`).all(recordId)
            : (() => { throw new Error('Unknown native query'); })();
      return rows.slice(offset, offset + limit);
    });
  });

  afterEach(() => mockDb.close());

  it('preserves the full invoice/item/batch output shape against the original web branch', async () => {
    const native = await fetchDraftsAction();
    expect(native).toMatchObject({
      success: true,
      data: [expect.objectContaining({
        id: 'draft-a', patient_name: 'Patient A', check_number: 'CHK-9',
        additional_fees: 8, total_amount: 25,
        items: [
          expect.objectContaining({
            drug_id: 1, itemDiscountPercent: 10, total_stock: 3,
            units: { large: 'box', medium: 'strip', small: 'tablet', large_to_medium: 10, medium_to_small: 2 },
            batches: [expect.objectContaining({ inventory_id: 'eligible-a', quantity: 3, unit_price: 17 })],
          }),
          expect.objectContaining({ drug_id: 2, is_negative: 1, total_stock: 0, batches: [] }),
        ],
      })],
    });
    expect(JSON.stringify(native)).not.toMatch(/draft-b|foreign-b|expired-a|negative-a/);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.map(call => call[1].queryId)).toEqual([
      'sales.suspended.list', 'sales.suspended.items', 'sales.suspended.batches',
    ]);
    expect(mockInvoke.mock.calls.every(call => {
      const payload = call[1];
      return call[0] === 'db_read_scoped' &&
        Object.keys(payload).sort().join(',') === 'drugId,limit,offset,queryId,recordId,search' &&
        payload.limit === 200 && payload.offset === 0 && payload.search === null && payload.drugId === null;
    })).toBe(true);

    mockIsTauri = false;
    const web = await fetchDraftsAction();
    expect(web).toEqual(native);
    expect(mockDbSelect).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])('rejects the role permission before using either transport (native=%s)', async native => {
    mockIsTauri = native;
    mockSession.permissions.show_suspended_invoices = false;
    expect(await fetchDraftsAction()).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
    mockSession.permissions.show_suspended_invoices = true;
    mockSession.permissions.can_access_pos = false;
    expect(await fetchDraftsAction()).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('fails closed if native child reads reject and never retries generic SQL', async () => {
    mockInvoke.mockImplementationOnce(async () => [{
      id: 'draft-a', total_amount: 25, discount_amount: 2, created_at: '2026-10-10',
    }]).mockRejectedValueOnce(new Error('Native permission denied'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fetchDraftsAction()).toEqual({ success: false, error: 'فشل جلب المسودات' });
    errorLog.mockRestore();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });
});
