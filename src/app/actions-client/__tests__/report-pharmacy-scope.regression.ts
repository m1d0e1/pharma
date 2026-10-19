import Database from 'better-sqlite3';

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => ({})),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'admin', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

import {
  getDashboardKPIsAction,
  getReportsDataAction,
  getSalesTrendAction,
} from '@/app/actions-client/reports';
import { getSalesReportsAction, getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';

const mockDbSelect = dbSelect as jest.Mock;
const mockDbGet = dbGet as jest.Mock;

describe('report pharmacy scoping', () => {
  beforeEach(() => {
    mockDbSelect.mockReset().mockResolvedValue([]);
    mockDbGet.mockReset().mockResolvedValue({});
  });

  it('keeps dashboard report queries inside the signed-in pharmacy', async () => {
    expect((await getReportsDataAction()).success).toBe(true);
    expect(mockDbSelect).toHaveBeenCalledTimes(3);
    for (const [sql, params] of mockDbSelect.mock.calls as any[][]) {
      expect(String(sql)).toContain('pharmacy_id = ?');
      expect(String(sql)).toContain('status');
      expect(String(sql)).toContain('completed');
      expect(params).toContain('ph-1');
    }
  });

  it('keeps report charts and unit totals on the same inclusive 30-day window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-28T12:00:00'));
    mockDbGet.mockImplementation(async (sql: string) => {
      if (sql.includes('SUM(si.quantity_sold)')) return { total: 12 };
      return {};
    });

    try {
      const result = await getReportsDataAction();
      expect(result).toMatchObject({
        success: true,
        data: { totalUnitsSold: 12 },
      });

      expect(mockDbSelect).toHaveBeenCalledTimes(3);
      for (const [sql, params] of mockDbSelect.mock.calls as any[][]) {
        expect(String(sql)).toContain("date(");
        expect(String(sql)).toContain("'localtime'");
        expect(params).toContain('2026-08-30');
      }
      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining('SUM(si.quantity_sold)'),
        expect.arrayContaining(['2026-08-30', 'ph-1']),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns the database-local sales day used by report chart buckets', async () => {
    await getReportsDataAction();
    const [salesHistorySql] = mockDbSelect.mock.calls[0] as any[];

    expect(String(salesHistorySql)).toContain("date(created_at, 'localtime') as local_date");
  });

  it('ranks report drugs and categories by comparable large-unit volume', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-28T12:00:00'));
    try {
      await getReportsDataAction();
      const [topDrugsSql, topDrugsParams] = mockDbSelect.mock.calls[1] as any[];
      const [categorySql, categoryParams] = mockDbSelect.mock.calls[2] as any[];

      const sqlite = new Database(':memory:');
      try {
        sqlite.exec(`
          CREATE TABLE sales_invoices (
            id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT, created_at TEXT
          );
         CREATE TABLE master_drugs (
           id INTEGER PRIMARY KEY, trade_name TEXT, category TEXT,
            large_to_medium REAL, medium_to_small REAL, medium_unit TEXT, small_unit TEXT
         );
          CREATE TABLE sales_items (
            invoice_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT,
            large_to_medium REAL, medium_to_small REAL
          );

          INSERT INTO sales_invoices VALUES ('sale-1', 'ph-1', 'completed', '2026-09-28 10:00:00');
         INSERT INTO master_drugs VALUES
            (1, 'Two Boxes', 'Boxes', 1, 1, 'strip', 'tablet'),
            (2, 'Nine Strips', 'Strips', 20, 1, 'blister', 'tablet');
         INSERT INTO sales_items VALUES
           ('sale-1', 1, 2, 'large', 1, 1),
            ('sale-1', 2, 9, 'blister', 10, 1);
        `);

        const drugs = sqlite.prepare(String(topDrugsSql)).all(...topDrugsParams) as Array<{ trade_name: string; quantity_sold: number }>;
        const categories = sqlite.prepare(String(categorySql)).all(...categoryParams) as Array<{ category: string; quantity_sold: number }>;
        expect(drugs[0]).toMatchObject({ trade_name: 'Two Boxes', quantity_sold: 2 });
        expect(drugs[1]).toMatchObject({ trade_name: 'Nine Strips', quantity_sold: 0.9 });
        expect(categories[0]).toMatchObject({ category: 'Boxes', quantity_sold: 2 });
        expect(categories[1]).toMatchObject({ category: 'Strips', quantity_sold: 0.9 });
      } finally {
        sqlite.close();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('scopes invoice search to the signed-in pharmacy', async () => {
    expect((await getSalesReportsAction({})).success).toBe(true);
    const [sql, params] = mockDbSelect.mock.calls[0] as any[];
    expect(String(sql)).toContain('si.pharmacy_id = ?');
    expect(String(sql)).toContain("si.status IN ('completed', 'approved', 'delivered')");
    expect(params).toContain('ph-1');
  });

  it('does not let a renderer pharmacy filter choose tenant ownership for a legacy actor with no tenant', async () => {
    (getLocalSession as jest.Mock).mockResolvedValueOnce({ id: 'legacy-1', role: 'admin', pharmacy_id: null });
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, full_name TEXT);
        CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT);
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY, user_id TEXT, patient_id TEXT,
          pharmacy_id TEXT, status TEXT, created_at TEXT
        );
        CREATE TABLE returns (
          invoice_id TEXT, pharmacy_id TEXT, total_refund REAL, status TEXT
        );
        INSERT INTO sales_invoices VALUES
          ('local-sale', NULL, NULL, NULL, 'completed', '2026-10-12'),
          ('foreign-sale', NULL, NULL, 'foreign-pharmacy', 'completed', '2026-10-13');
      `);
      mockDbSelect.mockImplementationOnce(async (sql: string, params: unknown[] = []) =>
        sqlite.prepare(sql).all(...params));
      const result = await getSalesReportsAction({ pharmacyId: 'foreign-pharmacy' });
      expect(result).toEqual({ success: false, error: 'فشل جلب تقرير المبيعات' });
      expect(mockDbSelect).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('loads only original invoice items in the session pharmacy, not a foreign invoice', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT);
        CREATE TABLE sales_items (id TEXT PRIMARY KEY, invoice_id TEXT, drug_id INTEGER);
        CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, active_ingredient TEXT, barcode TEXT);
        INSERT INTO sales_invoices VALUES ('local-sale','ph-1'),('foreign-sale','ph-2');
        INSERT INTO sales_items VALUES ('local-item','local-sale',1),('foreign-item','foreign-sale',1);
        INSERT INTO master_drugs VALUES (1,'Local Drug','Local drug EN','ingredient','barcode');
      `);
      mockDbSelect.mockImplementation(async (sql: string, params: unknown[] = []) =>
        sqlite.prepare(sql).all(...params));
      expect(await getInvoiceDetailsAction('local-sale')).toMatchObject({
        success: true, data: [{ id: 'local-item', trade_name: 'Local Drug' }],
      });
      expect(await getInvoiceDetailsAction('foreign-sale')).toEqual({ success: true, data: [] });
    } finally {
      sqlite.close();
    }
  });

  it('applies every optional report filter together without admitting another tenant or incomplete invoices', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, full_name TEXT);
        CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT);
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY, user_id TEXT, patient_id TEXT,
          pharmacy_id TEXT, status TEXT, created_at TEXT, payment_method TEXT
        );
        CREATE TABLE returns (
          invoice_id TEXT, pharmacy_id TEXT, total_refund REAL, status TEXT
        );
        INSERT INTO users VALUES ('cashier-a','cashier','Cashier A');
        INSERT INTO patients VALUES ('pat-a','Patient A');
        INSERT INTO sales_invoices VALUES
          ('PFX-100','cashier-a','pat-a','ph-1','completed','2026-10-12 09:00:00','cash'),
          ('PFX-200','cashier-a','pat-a','ph-1','completed','2026-10-12 10:00:00','bank'),
          ('PFX-300','cashier-a','pat-a','ph-1','draft','2026-10-12 10:00:00','cash'),
          ('PFX-400','cashier-a','pat-a','ph-2','completed','2026-10-12 10:00:00','cash'),
          ('PFX-500','cashier-a','pat-a','ph-1','completed','2026-10-13 10:00:00','cash');
        INSERT INTO returns VALUES
          ('PFX-100','ph-1',10,'approved'),
          ('PFX-100','ph-1',2,'completed'),
          ('PFX-100','ph-1',99,'pending'),
          ('PFX-100','ph-2',200,'approved');
      `);
      mockDbSelect.mockImplementation(async (sql: string, params: unknown[] = []) =>
        sqlite.prepare(sql).all(...params));
      const full = await getSalesReportsAction({
        startDate: '2026-10-12', endDate: '2026-10-12',
        userId: 'cashier-a', patientId: 'pat-a',
        paymentMethod: 'cash', invoiceNumber: 'PFX-1',
        pharmacyId: 'ph-2',
      });
      expect(full).toMatchObject({ success: true, data: [{ id: 'PFX-100', staff_name: 'cashier-a', patient_name: null, refunded_amount: 12 }] });
      expect((full as any).data).toHaveLength(1);
      const allPaymentMethods = await getSalesReportsAction({ paymentMethod: 'all' });
      expect((allPaymentMethods as any).data.map((row: any) => row.id)).toEqual(['PFX-500', 'PFX-200', 'PFX-100']);
      expect(mockDbSelect.mock.calls[1][0]).not.toContain('si.payment_method = ?');
    } finally {
      sqlite.close();
    }
  });

  it('reports database failures without leaking SQL or disclosing an invoice from a denied query', async () => {
    mockDbSelect.mockRejectedValueOnce(new Error('synthetic private table name'));
    const muted = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await getSalesReportsAction({ invoiceNumber: 'invoice' })).toEqual({
        success: false, error: 'فشل جلب تقرير المبيعات',
      });
    } finally {
      muted.mockRestore();
    }
    mockDbSelect.mockRejectedValueOnce(new Error('synthetic inaccessible row'));
    expect(await getInvoiceDetailsAction('invoice')).toEqual({
      success: false, error: 'فشل جلب تفاصيل الفاتورة',
    });
  });

  it('rejects unauthenticated and unpermitted invoice reports/details before database access', async () => {
    (getLocalSession as jest.Mock).mockResolvedValueOnce(null);
    expect(await getSalesReportsAction({})).toEqual({ success: false, error: 'غير مصرح' });
    (hasUserPermissionSync as jest.Mock).mockReturnValueOnce(false);
    expect(await getInvoiceDetailsAction('foreign-sale')).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('scopes KPI and trend queries to the signed-in pharmacy', async () => {
    expect((await getDashboardKPIsAction()).success).toBe(true);
    expect(mockDbGet.mock.calls.length).toBeGreaterThanOrEqual(6);
    for (const [sql, params] of mockDbGet.mock.calls.filter(([sql]) =>
      /sales_invoices|journal_entries|stock_adjustments|inventory/i.test(String(sql))
    ) as any[][]) {
      expect(String(sql)).toContain('pharmacy_id');
      expect(params).toContain('ph-1');
    }

    mockDbSelect.mockClear();
    expect((await getSalesTrendAction(7)).success).toBe(true);
    const [sql, params] = mockDbSelect.mock.calls[0] as any[];
    expect(String(sql)).toContain('pharmacy_id');
    expect(params).toContain('ph-1');
  });
});
