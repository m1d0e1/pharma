import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let mockDb: Database.Database;
let mockSession: { id: string; role: string; pharmacy_id: string | null };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => 'test-id-' + Math.random().toString(36).slice(2)),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/shortages');
jest.unmock('@/app/actions-client/purchases');

import { getLowStockAction } from '@/app/actions-client/inventory';
import {
  addToShortagesAction,
  deleteShortageAction,
  deleteShortagesBulkAction,
  getShortagesAction,
  syncLowStockToShortagesAction,
  updateShortageQuantityAction,
  updateShortageStatusAction,
  updateShortagesStatusBulkAction,
} from '@/app/actions-client/shortages';
import {
  createPurchaseInvoiceAction,
  completePurchaseInvoiceAction,
  updateCompletedPurchaseInvoiceAction,
  createPurchaseOrderAction,
  updatePurchaseOrderStatusAction,
} from '@/app/actions-client/purchases';

describe('inventory-linked reorder and shortage notebook regression', () => {
  beforeEach(() => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/012_shortages_pharmacy_scope.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/013_shift_handover_details.sql', 'utf8'));
    mockDb.pragma('foreign_keys = ON');
    mockDb.exec(`
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, reorder_point, default_purchase_qty,
        large_to_medium, medium_to_small, medium_unit, small_unit
      ) VALUES
        (9101, 'صنف ناقص', 'Low Drug', 5, 8, 10, 10, 'شريط', 'قرص'),
        (9102, 'صنف صفري', 'Zero Drug', 0, 1, 1, 1, 'شريط', 'قرص'),
        (9103, 'صنف متوفر', 'Healthy Drug', 5, 1, 1, 1, 'شريط', 'قرص');

      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, strips_per_box, expiry_date) VALUES
        ('low-stock', NULL, 9101, 2, 10, '2099-12-31'),
        ('expired-stock', NULL, 9101, 50, 10, '2020-01-01'),
        ('other-pharmacy-stock', 'ph-2', 9101, 50, 10, '2099-12-31'),
        ('zero-stock', NULL, 9102, 0, 1, '2099-12-31'),
        ('healthy-stock', NULL, 9103, 20, 1, '2099-12-31');

      INSERT INTO sales_invoices (id, pharmacy_id, user_id, total_amount, status, created_at)
      VALUES
        ('recent-sale', NULL, 'admin', 2, 'completed', CURRENT_TIMESTAMP),
        ('draft-sale', NULL, 'admin', 100, 'draft', CURRENT_TIMESTAMP),
        ('foreign-sale', 'ph-2', 'admin', 100, 'completed', CURRENT_TIMESTAMP);

      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit, is_negative)
      VALUES
        ('recent-sale', 9101, 10, 'شريط', 0),
        ('recent-sale', 9101, 100, 'قرص', 0),
        ('draft-sale', 9101, 1000, 'علبة', 0),
        ('foreign-sale', 9101, 1000, 'علبة', 0);
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps inventory and shortage drug joins indexable', () => {
    const inventorySource = readFileSync('src/app/actions-client/inventory.ts', 'utf8');
    const dashboardSource = readFileSync('src/app/(dashboard)/page.tsx', 'utf8');
    const shortagesSource = readFileSync('src/app/actions-client/shortages.ts', 'utf8');

    for (const [source, directJoins, castJoins] of [
      [inventorySource, [
        'i.drug_id = m.id',
        'm.id = si.drug_id',
        'm.id = ds.drug_id',
        'm.id = ms.drug_id',
      ], [
        'CAST(i.drug_id AS TEXT) = CAST(m.id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(si.drug_id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(ds.drug_id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(ms.drug_id AS TEXT)',
      ]],
      [dashboardSource, [
        'm.id = ds.drug_id',
        'm.id = ms.drug_id',
      ], [
        'CAST(m.id AS TEXT) = CAST(ds.drug_id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(ms.drug_id AS TEXT)',
      ]],
      [shortagesSource, [
        'm.id = s.drug_id',
        'ds.drug_id = s.drug_id',
      ], [
        'CAST(m.id AS TEXT) = CAST(s.drug_id AS TEXT)',
        'CAST(ds.drug_id AS TEXT) = CAST(s.drug_id AS TEXT)',
      ]],
    ] as const) {
      for (const join of directJoins) expect(source).toContain(join);
      for (const join of castJoins) expect(source).not.toContain(join);
    }
  });

  it('flows from live stock through reorder alerts into a duplicate-safe shortage workflow', async () => {
    const lowStock = await getLowStockAction(10);
    expect(lowStock.success).toBe(true);
    // Drug 9102 (qty=0, no reorder_point, no sales) is now correctly excluded —
    // it was the phantom zero-stock entry the rebuy-alert fix targets.
    expect(lowStock.data?.map((item: any) => item.drug_id)).toEqual([9101]);
    expect(lowStock.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      current_stock: 2,
      quantity: 2,
      reorder_point: 5,
      deficit: 3,
      avg_monthly_usage: 2,
      status: 'critical',
    });

    const firstSync = await syncLowStockToShortagesAction();
    expect(mockDb.prepare('SELECT id, drug_id, requested_quantity, status FROM shortages ORDER BY drug_id').all()).toEqual([
      expect.objectContaining({ drug_id: 9101, requested_quantity: 8, status: 'pending' }),
    ]);
    mockDb.prepare(`
      INSERT INTO shortages (drug_id, requested_quantity, status)
      VALUES (9101, 6, 'pending')
    `).run();
    const secondSync = await syncLowStockToShortagesAction();
    expect(firstSync).toMatchObject({ success: true, data: { total: 1, created: 1, updated: 0 } });
    expect(secondSync).toMatchObject({ success: true, data: { total: 1, created: 0, updated: 1 } });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages').get() as any).count).toBe(1);
    expect((mockDb.prepare('SELECT requested_quantity FROM shortages WHERE drug_id = 9101').get() as any).requested_quantity).toBe(8);

    await addToShortagesAction({ drug_id: 9101, qty: 12, notes: 'ملاحظة الفرع المحلي' });
    await addToShortagesAction({ drug_id: 9101, qty: 3 });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages WHERE drug_id = 9101').get() as any).count).toBe(1);
    expect((mockDb.prepare('SELECT requested_quantity FROM shortages WHERE drug_id = 9101').get() as any).requested_quantity).toBe(12);
    expect((mockDb.prepare('SELECT notes FROM shortages WHERE drug_id = 9101').get() as any).notes).toBe('ملاحظة الفرع المحلي');

    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-2' };
    await addToShortagesAction({ drug_id: 9101, qty: 4, notes: 'ملاحظة الفرع الثاني' });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages WHERE drug_id = 9101').get() as any).count).toBe(2);
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };

    const notebook = await getShortagesAction();
    expect(notebook.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      current_stock: 2,
      reorder_point: 5,
      deficit: 3,
      inventory_status: 'critical',
    });
    // Drug 9102 is no longer auto-synced (qty=0 phantom fix), so add manually
    // to verify the "can't receive zero-stock" guard
    await addToShortagesAction({ drug_id: 9102, qty: 10 });
    const zeroItem = (await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102);
    expect(await updateShortageStatusAction(zeroItem.id, 'received')).toMatchObject({
      success: false,
      error: expect.stringContaining('إضافة الكمية'),
    });

    // Test inline edit of quantity and notes
    const editResult = await updateShortageQuantityAction(zeroItem.id, 25, 'تعديل كمية وملاحظة');
    expect(editResult).toMatchObject({ success: true, requested_quantity: 25 });
    const updatedZeroItem = (await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102);
    expect(updatedZeroItem.requested_quantity).toBe(25);
    expect(updatedZeroItem.notes).toBe('تعديل كمية وملاحظة');

    // Test deleting a shortage item
    const deleteResult = await deleteShortageAction(zeroItem.id);
    expect(deleteResult).toMatchObject({ success: true });
    expect((await getShortagesAction()).data?.some((item: any) => item.drug_id === 9102)).toBe(false);

    mockDb.prepare('UPDATE inventory SET quantity = 7 WHERE drug_id = 9101').run();
    const replenished = await getShortagesAction();
    const replenishedItem = replenished.data?.find((item: any) => item.drug_id === 9101);
    expect(replenishedItem).toMatchObject({ current_stock: 7, deficit: 0, inventory_status: 'sufficient' });

    const received = await updateShortageStatusAction(replenishedItem.id, 'received');
    expect(received.success).toBe(true);
    expect((await getShortagesAction()).data?.some((item: any) => item.drug_id === 9101)).toBe(false);
  });

  it('supports bulk status update and bulk delete on several shortage items', async () => {
    await addToShortagesAction({ drug_id: 9101, qty: 5 });
    await addToShortagesAction({ drug_id: 9102, qty: 10 });
    await addToShortagesAction({ drug_id: 9103, qty: 15 });

    let list = (await getShortagesAction()).data || [];
    expect(list).toHaveLength(3);

    const ids = list.map((i: any) => i.id);

    // Bulk status update to 'ordered'
    const bulkStatusRes = await updateShortagesStatusBulkAction(ids, 'ordered');
    expect(bulkStatusRes).toMatchObject({ success: true, count: 3 });

    list = (await getShortagesAction()).data || [];
    expect(list.every((i: any) => i.status === 'ordered')).toBe(true);

    // Bulk delete 2 items
    const toDelete = [ids[0], ids[1]];
    const bulkDeleteRes = await deleteShortagesBulkAction(toDelete);
    expect(bulkDeleteRes).toMatchObject({ success: true, count: 2 });

    list = (await getShortagesAction()).data || [];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ids[2]);
  });

  it('keeps shortages active when a purchase order closes without receiving inventory', async () => {
    // Insert user for PO creation
    mockDb.exec(`INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL)`);

    // Add zero stock drug and low stock drug to shortages
    await addToShortagesAction({ drug_id: 9102, qty: 10 }); // zero stock (out_of_stock)
    await addToShortagesAction({ drug_id: 9101, qty: 5 });  // current_stock = 2, reorder = 5 -> 2 <= 2.5 (critical)

    const listBeforePO = (await getShortagesAction()).data || [];
    const zeroItem = listBeforePO.find((i: any) => i.drug_id === 9102);
    const criticalItem = listBeforePO.find((i: any) => i.drug_id === 9101);

    expect(zeroItem.inventory_status).toBe('out_of_stock');
    expect(criticalItem.inventory_status).toBe('critical');
    expect(zeroItem.status).toBe('pending');
    expect(criticalItem.status).toBe('pending');

    // Create Purchase Order for these items
    const poResult = await createPurchaseOrderAction({
      supplier_name: 'المورد الرئيسي',
      notes: 'طلبية عاجلة للنواقص',
      items: [
        { drug_id: 9102, quantity: 10, expected_price: 15 },
        { drug_id: 9101, quantity: 5, expected_price: 25 },
      ]
    });
    expect(poResult.success).toBe(true);

    // Status in shortages should now be 'ordered'
    const listAfterPO = (await getShortagesAction()).data || [];
    const zeroAfterPO = listAfterPO.find((i: any) => i.drug_id === 9102);
    const criticalAfterPO = listAfterPO.find((i: any) => i.drug_id === 9101);
    expect(zeroAfterPO.status).toBe('ordered');
    expect(criticalAfterPO.status).toBe('ordered');

    // Closing an order is not an inventory receipt; only a completed purchase invoice receives stock.
    const completeResult = await updatePurchaseOrderStatusAction(poResult.po_id!, 'completed');
    expect(completeResult.success).toBe(true);

    const listAfterClose = (await getShortagesAction()).data || [];
    expect(listAfterClose.find((i: any) => i.drug_id === 9102)?.status).toBe('ordered');
    expect(listAfterClose.find((i: any) => i.drug_id === 9101)?.status).toBe('ordered');

    const row9102 = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9102').get() as any;
    const row9101 = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9101').get() as any;
    expect(row9102.status).toBe('ordered');
    expect(row9101.status).toBe('ordered');
  });

  it('updates shortages to received and resolves stock alerts across purchase invoice lifecycle (create, complete, edit)', async () => {
    mockDb.exec(`
      INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL);
      INSERT OR IGNORE INTO suppliers (id, name_ar, balance) VALUES (1, 'مورد تجريبي', 0);
    `);

    // 1. Drug 9101 is initially low stock (qty=2, reorder=5)
    await addToShortagesAction({ drug_id: 9101, qty: 10 });
    const shortagesBefore = (await getShortagesAction()).data || [];
    expect(shortagesBefore.some((s: any) => s.drug_id === 9101)).toBe(true);

    const lowStockBefore = await getLowStockAction(5);
    expect(lowStockBefore.data?.some((d: any) => d.id === 9101)).toBe(true);

    // 2. Perform a purchase invoice for drug 9101 (qty=10)
    const invoiceRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-TEST-001',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'completed',
      cart: [
        {
          id: 9101,
          quantity: 10,
          cost_price: 20,
          selling_price: 25,
          expiry_date: '2029-12-31',
          strips_per_box: 10,
        },
      ],
    });
    expect(invoiceRes.success).toBe(true);

    // Verify shortage for 9101 is now 'received' and left active notebook
    const shortagesAfter = (await getShortagesAction()).data || [];
    expect(shortagesAfter.some((s: any) => s.drug_id === 9101)).toBe(false);
    const shortage9101 = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9101').get() as any;
    expect(shortage9101.status).toBe('received');

    // Verify stock alert for 9101 is resolved (new stock = 2 + 10 = 12 > reorder_point 5)
    const lowStockAfter = await getLowStockAction(5);
    expect(lowStockAfter.data?.some((d: any) => d.id === 9101)).toBe(false);

    // 3. Test draft invoice -> complete invoice resolves shortages
    await addToShortagesAction({ drug_id: 9102, qty: 5 });
    const draftRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-DRAFT-001',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'draft',
      cart: [
        {
          id: 9102,
          quantity: 5,
          cost_price: 10,
          selling_price: 15,
          expiry_date: '2029-12-31',
          strips_per_box: 1,
        },
      ],
    });
    expect(draftRes.success).toBe(true);

    // In draft status, shortage remains pending
    const shortage9102Draft = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9102').get() as any;
    expect(shortage9102Draft.status).toBe('pending');

    // Complete the draft invoice
    const completeRes = await completePurchaseInvoiceAction(draftRes.id!);
    expect(completeRes.success).toBe(true);

    // Upon completion, shortage is marked received
    const shortage9102Completed = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9102').get() as any;
    expect(shortage9102Completed.status).toBe('received');

    // 4. Test editing completed invoice resolves shortages for added items
    await addToShortagesAction({ drug_id: 9103, qty: 5 });
    const editRes = await updateCompletedPurchaseInvoiceAction({
      id: invoiceRes.id!,
      supplier_id: 1,
      payment_method: 'credit',
      cart: [
        {
          id: 9101,
          quantity: 10,
          cost_price: 20,
          selling_price: 25,
          expiry_date: '2029-12-31',
          strips_per_box: 10,
        },
        {
          id: 9103,
          quantity: 5,
          cost_price: 15,
          selling_price: 20,
          expiry_date: '2029-12-31',
          strips_per_box: 1,
        },
      ],
    });
    expect(editRes.success).toBe(true);

    // Shortage for 9103 is now received
    const shortage9103 = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9103').get() as any;
    expect(shortage9103.status).toBe('received');
  });
});
