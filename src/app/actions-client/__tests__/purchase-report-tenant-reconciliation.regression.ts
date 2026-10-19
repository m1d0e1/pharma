/** @jest-environment node */
import Database from 'better-sqlite3';

let sqlite: Database.Database;
let actor: {
  id: string;
  pharmacy_id: string;
  permissions: Record<string, boolean>;
};

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => actor),
  hasUserPermissionSync: jest.fn((session: typeof actor, permission: string) =>
    Boolean(session?.permissions[permission])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'isolated-id'),
}));

import {
  getPurchaseInvoiceDetailsAction,
  getPurchasesReportsAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';

const cents = (value: unknown) => Math.round(Number(value) * 100);
const invoiceIds = (result: any) => (result.data ?? []).map((row: any) => row.id);

describe('purchases report ledger with independently owned tenant fixtures', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, username TEXT, full_name TEXT);
      CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT, phone TEXT, address TEXT, balance REAL);
      CREATE TABLE purchase_invoices (
        id TEXT PRIMARY KEY, supplier_id INTEGER, pharmacy_id TEXT, user_id TEXT,
        invoice_number TEXT, invoice_date TEXT, created_at TEXT, status TEXT,
        payment_method TEXT, total_amount REAL, expenses REAL, tax_percent REAL,
        discount_value REAL, discount_percent REAL
      );
      CREATE TABLE purchase_invoice_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, drug_id INTEGER,
        quantity REAL, bonus_quantity REAL, cost_price REAL, selling_price REAL,
        tax_percent REAL, discount_percent REAL, barcode TEXT, unit_id INTEGER,
        expiry_date TEXT, inventory_id TEXT, strips_per_box REAL, medium_to_small REAL
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT,
        active_ingredient TEXT, official_price REAL, barcode TEXT,
        large_unit TEXT, medium_unit TEXT, small_unit TEXT,
        has_expiry INTEGER, large_to_medium REAL, medium_to_small REAL
      );
      CREATE TABLE units (id INTEGER PRIMARY KEY, name_en TEXT);
      CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, expiry_date TEXT, batch_number TEXT, barcode TEXT);
      CREATE TABLE purchase_returns (id TEXT PRIMARY KEY, purchase_invoice_id TEXT, status TEXT);
      CREATE TABLE purchase_return_items (
        id INTEGER PRIMARY KEY, purchase_return_id TEXT, purchase_invoice_item_id INTEGER,
        inventory_id TEXT, drug_id INTEGER, quantity_returned REAL, unit TEXT
      );
      INSERT INTO users VALUES
        ('buyer-a','tenant-a','buyer-a','Buyer A'),
        ('buyer-b','tenant-b','buyer-b','Buyer B');
      INSERT INTO suppliers VALUES
        (7,'Shared Supplier','Shared', 'PRIVATE CONTACT', 'OTHER TENANT', 9999),
        (8,'Other Supplier','Other', NULL,NULL,4000);
      INSERT INTO master_drugs VALUES
        (10,'Drug Ten','Drug Ten','Ingredient Ten',60,'BC10','علبة','شريط','قرص',1,2,10),
        (11,'Drug Eleven','Drug Eleven','Ingredient Eleven',25,'BC11','علبة','شريط','قرص',1,2,10);
      INSERT INTO purchase_invoices VALUES
        ('cash-a',7,'tenant-a','buyer-a','A-CASH','2026-10-10','2026-10-10 09:00:00','completed','cash',105.75,7,5,5,10),
        ('check-a',8,'tenant-a','buyer-a','A-CHECK','2026-10-11','2026-10-11 09:00:00','completed','check',40,3,20,4.4,0),
        ('credit-a',7,'tenant-a','buyer-a','A-CREDIT','2026-10-12','2026-10-12 09:00:00','completed','credit',30,0,0,0,0),
        ('orphan-a',7,'tenant-a','buyer-a','A-ORPHAN','2026-10-09','2026-10-09 09:00:00','completed','credit',12,0,0,0,0),
        ('draft-a',7,'tenant-a','buyer-a','A-DRAFT','2026-10-12','2026-10-12 09:01:00','draft','credit',0,0,0,0,0),
        ('foreign-b',7,'tenant-b','buyer-b','B-PRIVATE','2026-10-11','2026-10-11 09:00:00','completed','cash',9000,0,0,0,0),
        ('unowned',7,NULL,'buyer-a','UNOWNED','2026-10-11','2026-10-11 09:00:00','completed','cash',8000,0,0,0,0);
      INSERT INTO purchase_invoice_items VALUES
        (1,'cash-a',10,2,4,50,80,10,50,'CASH',NULL,'2028-10-01',NULL,2,10),
        (2,'check-a',11,3,0,10,25,15,0,'CHECK',NULL,'2028-10-01',NULL,2,10),
        (3,'credit-a',10,1,0,30,NULL,0,0,'CREDIT',NULL,'2028-10-01',NULL,2,10),
        (4,'orphan-a',999,2,0,6,8,0,0,'ORPHAN',NULL,'2028-10-01',NULL,2,10),
        (5,'draft-a',10,1,0,2,4,0,0,'DRAFT',NULL,'2028-10-01',NULL,2,10),
        (6,'foreign-b',11,1,0,9000,9999,0,0,'PRIVATE',NULL,'2028-10-01',NULL,2,10),
        (7,'unowned',11,1,0,8000,9999,0,0,'UNOWNED',NULL,'2028-10-01',NULL,2,10);
    `);
    actor = { id: 'report-a', pharmacy_id: 'tenant-a', permissions: { rep_can_view_purchases: true } };
  });
  afterEach(() => sqlite.close());

  it('reconciles posted taxes, header discount, line discounts already in cost, free quantity and orphaned source lines in cents', async () => {
    const result = await getPurchasesReportsAction();
    expect(result.success).toBe(true);
    expect(invoiceIds(result)).toEqual(['credit-a', 'check-a', 'cash-a', 'orphan-a']);
    const rows = new Map((result.data as any[]).map(row => [row.id, row]));
    for (const [id, gross, discount, net, selling] of [
      ['cash-a', 12250, 1675, 10575, 16000],
      ['check-a', 4440, 440, 4000, 7500],
      ['credit-a', 3000, 0, 3000, 6000],
      ['orphan-a', 1200, 0, 1200, 1600],
    ] as const) {
      const row = rows.get(id);
      expect(row).toBeDefined();
      expect([cents(row.gross_amount), cents(row.discount_amount), cents(row.total_amount), cents(row.total_selling_amount)])
        .toEqual([gross, discount, net, selling]);
    }
    expect(result.invoiceCount).toBe(4);
    expect(cents(result.totalCost)).toBe(18775);
    expect(cents(result.totalSelling)).toBe(31100);
    expect((result.data as any[]).reduce((sum, row) => sum + cents(row.gross_amount), 0)).toBe(20890);
    expect((result.data as any[]).reduce((sum, row) => sum + cents(row.discount_amount), 0)).toBe(2115);
  });

  it('filters owned completed invoices by inclusive source date, supplier, user, payment, invoice number and drug name', async () => {
    expect(invoiceIds(await getPurchasesReportsAction({ startDate: '2026-10-11', endDate: '2026-10-12' })))
      .toEqual(['credit-a', 'check-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ supplierId: 8 }))).toEqual(['check-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ userId: 'buyer-a', paymentMethod: 'cash' })))
      .toEqual(['cash-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ invoiceNumber: 'A-ORPHAN' })))
      .toEqual(['orphan-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ drugName: 'Ingredient Eleven' })))
      .toEqual(['check-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ status: 'draft' }))).toEqual(['draft-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ status: 'all' })))
      .toEqual(['credit-a', 'check-a', 'cash-a', 'orphan-a']);
    expect(invoiceIds(await getPurchasesReportsAction({ userId: 'buyer-b' }))).toEqual([]);
    expect(invoiceIds(await getPurchasesReportsAction({ invoiceNumber: 'B-PRIVATE' }))).toEqual([]);
    expect(invoiceIds(await getPurchasesReportsAction({ invoiceNumber: 'UNOWNED' }))).toEqual([]);
  });

  it('keeps orphaned posted lines available for audit with correct reconciled tax and free-stock pricing', async () => {
    const cash = await getPurchaseInvoiceDetailsAction('cash-a', { reportScope: true });
    expect(cash.success).toBe(true);
    expect(cash.data).toHaveLength(1);
    expect(cash.data?.[0]).toMatchObject({ quantity: 2, bonus_quantity: 4, cost_price: 50 });
    expect(cents(cash.data?.[0].line_gross_amount)).toBe(11550);
    expect(cents(cash.data?.[0].line_net_amount)).toBe(10575);
    expect(cents(cash.data?.[0].refundable_large_unit_price)).toBe(5288);

    const orphan = await getPurchaseInvoiceDetailsAction('orphan-a', { reportScope: true });
    expect(orphan.success).toBe(true);
    expect(orphan.data).toHaveLength(1);
    expect(orphan.data?.[0]).toMatchObject({
      drug_id: 999, trade_name: 'صنف #999', barcode: 'ORPHAN', selling_price: 8,
    });
    expect(cents(orphan.data?.[0].line_gross_amount)).toBe(1200);
    expect(cents(orphan.data?.[0].line_net_amount)).toBe(1200);
    expect((await getPurchaseInvoiceDetailsAction('foreign-b', { reportScope: true })).success).toBe(false);
    expect((await getPurchaseInvoiceDetailsAction('unowned', { reportScope: true })).success).toBe(false);
  });

  it('denies unauthorized and legacy reads, and never presents unscoped supplier balances as known', async () => {
    expect((await getSuppliersAction({ reportScope: true })).data).toEqual([
      { id: 8, name_ar: 'Other Supplier', name_en: 'Other' },
      { id: 7, name_ar: 'Shared Supplier', name_en: 'Shared' },
    ]);
    actor.permissions.can_view_suppliers = true;
    const suppliers = await getSuppliersAction();
    expect(suppliers.success).toBe(true);
    expect(suppliers.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 7, balance: null, purchase_count: 4 }),
    ]));
    expect(JSON.stringify(suppliers.data)).not.toContain('9999');
    expect(JSON.stringify(suppliers.data)).not.toContain('PRIVATE CONTACT');

    actor.permissions = {};
    expect(await getPurchasesReportsAction()).toMatchObject({ success: false, error: 'Unauthorized' });
    expect(await getPurchaseInvoiceDetailsAction('cash-a', { reportScope: true }))
      .toMatchObject({ success: false, error: 'Unauthorized' });
    actor.permissions = { rep_can_view_purchases: true };
    actor.pharmacy_id = 'local_default';
    expect(await getPurchasesReportsAction()).toMatchObject({
      success: false, error: 'Legacy purchasing ownership needs independent tenant verification',
    });
    expect(await getSuppliersAction({ reportScope: true })).toMatchObject({
      success: false, error: 'Legacy purchasing ownership needs independent tenant verification',
    });
    expect(await getPurchaseInvoiceDetailsAction('unowned', { reportScope: true })).toMatchObject({
      success: false, error: 'Legacy purchasing ownership needs independent tenant verification',
    });
  });

  it('resolves a uniquely owned historical invoice-number line and rejects cross-tenant alias collisions', async () => {
    sqlite.exec(`
      INSERT INTO purchase_invoices VALUES
        ('historic-a',7,'tenant-a','buyer-a','A-HIST-UNIQUE','2026-10-08','2026-10-08 09:00:00','completed','credit',45,0,0,5,0),
        ('collision-a',7,'tenant-a','buyer-a','SAME-NUMBER','2026-10-07','2026-10-07 09:00:00','completed','credit',15,0,0,0,0),
        ('collision-b',7,'tenant-b','buyer-b','SAME-NUMBER','2026-10-07','2026-10-07 09:00:00','completed','credit',7000,0,0,0,0);
      INSERT INTO purchase_invoice_items VALUES
        (8,'A-HIST-UNIQUE',10,2,0,25,35,0,0,'HIST',NULL,'2028-10-01',NULL,2,10),
        (9,'SAME-NUMBER',11,1,0,7000,9999,0,0,'PRIVATE-ALIAS',NULL,'2028-10-01',NULL,2,10);
    `);
    const historical = await getPurchaseInvoiceDetailsAction('historic-a', { reportScope: true });
    expect(historical.success).toBe(true);
    expect(historical.data).toHaveLength(1);
    expect(historical.data?.[0]).toMatchObject({ drug_id: 10, quantity: 2 });
    expect(cents(historical.data?.[0].line_gross_amount)).toBe(5000);
    const historicReport = await getPurchasesReportsAction({ invoiceNumber: 'A-HIST-UNIQUE' });
    expect(historicReport.data).toHaveLength(1);
    expect([
      cents(historicReport.data?.[0].gross_amount),
      cents(historicReport.data?.[0].discount_amount),
      cents(historicReport.data?.[0].total_amount),
      cents(historicReport.data?.[0].total_selling_amount),
    ]).toEqual([5000, 500, 4500, 7000]);
    expect(invoiceIds(await getPurchasesReportsAction({
      invoiceNumber: 'A-HIST-UNIQUE', drugName: 'Ingredient Ten',
    }))).toEqual(['historic-a']);

    const collision = await getPurchaseInvoiceDetailsAction('collision-a', { reportScope: true });
    expect(collision).toMatchObject({ success: false, error: 'Ambiguous purchase invoice number' });
    expect(JSON.stringify(collision)).not.toContain('PRIVATE-ALIAS');
    expect(JSON.stringify(collision)).not.toContain('9999');
    const collisionReport = await getPurchasesReportsAction({ invoiceNumber: 'SAME-NUMBER' });
    expect(invoiceIds(collisionReport)).toEqual(['collision-a']);
    expect(JSON.stringify(collisionReport)).not.toContain('PRIVATE-ALIAS');
    expect(JSON.stringify(collisionReport)).not.toContain('9999');
    expect(invoiceIds(await getPurchasesReportsAction({
      invoiceNumber: 'SAME-NUMBER', drugName: 'Ingredient Eleven',
    }))).toEqual([]);
  });
});
