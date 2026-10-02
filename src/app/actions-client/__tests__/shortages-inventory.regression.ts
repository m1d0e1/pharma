/** @jest-environment node */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockSession: { id: string; role: string; pharmacy_id: string | null };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(mockCreateSqliteTransactionDb(mockDb));
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => 'test-id-' + Math.random().toString(36).slice(2)),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/shortages');
jest.unmock('@/app/actions-client/purchases');
jest.unmock('@/app/actions-client/master-drugs');

import { addInventoryAction, addOpeningBalanceAction, getLowStockAction, updateInventoryAction } from '@/app/actions-client/inventory';
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';
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
  getDrugInventoryQuantityAction,
  getPurchaseOrdersAction,
  updatePurchaseOrderStatusAction,
} from '@/app/actions-client/purchases';

describe('inventory-linked reorder and shortage notebook regression', () => {
  beforeEach(() => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/012_shortages_pharmacy_scope.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/013_shift_handover_details.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/018_unit_conversion_snapshots.sql', 'utf8'));
    mockDb.exec(`
      ALTER TABLE inventory ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      ALTER TABLE purchase_invoice_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN large_to_medium INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      ALTER TABLE purchase_orders ADD COLUMN pharmacy_id TEXT;
      ALTER TABLE activity_log ADD COLUMN pharmacy_id TEXT;
    `);
    mockDb.pragma('foreign_keys = ON');
    mockDb.exec(`
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, reorder_point, default_purchase_qty,
        large_to_medium, medium_to_small, medium_unit, small_unit
      ) VALUES
        (9101, 'صنف ناقص', 'Low Drug', 5, 8, 10, 10, 'شريط', 'قرص'),
        (9102, 'صنف صفري', 'Zero Drug', 0, 1, 1, 1, 'شريط', 'قرص'),
        (9103, 'صنف متوفر', 'Healthy Drug', 5, 1, 1, 1, 'شريط', 'قرص'),
        (9104, 'صنف مؤرشف', 'Archived Drug', 5, 4, 1, 1, 'شريط', 'قرص');

      UPDATE master_drugs SET stop_dealing = 1 WHERE id = 9104;

      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, strips_per_box, expiry_date) VALUES
        ('low-stock', NULL, 9101, 2, 10, '2099-12-31'),
        ('unknown-expiry-stock', NULL, 9101, 50, 10, NULL),
        ('expired-stock', NULL, 9101, 50, 10, '2020-01-01'),
        ('other-pharmacy-stock', 'ph-2', 9101, 50, 10, '2099-12-31'),
        ('zero-stock', NULL, 9102, 0, 1, '2099-12-31'),
        ('healthy-stock', NULL, 9103, 20, 1, '2099-12-31');

      INSERT INTO sales_invoices (id, pharmacy_id, user_id, total_amount, status, created_at)
      VALUES
        ('recent-sale', NULL, 'admin', 2, 'completed', CURRENT_TIMESTAMP),
        ('draft-sale', NULL, 'admin', 100, 'draft', CURRENT_TIMESTAMP),
        ('foreign-sale', 'ph-2', 'admin', 100, 'completed', CURRENT_TIMESTAMP);

      INSERT INTO sales_items (
        invoice_id, drug_id, quantity_sold, unit, is_negative,
        large_to_medium, medium_to_small
      )
      VALUES
        ('recent-sale', 9101, 10, 'شريط', 0, 10, 10),
        ('recent-sale', 9101, 100, 'قرص', 0, 10, 10),
        ('draft-sale', 9101, 1000, 'علبة', 0, 10, 10),
        ('foreign-sale', 9101, 1000, 'علبة', 0, 10, 10);
    `);
  });

  it('shows only unexpired local stock as available when building a purchase order', async () => {
    expect(await getDrugInventoryQuantityAction(9101)).toEqual({ success: true, data: 2 });
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

    expect(dashboardSource).toContain("import { getLowStockAction } from '@/app/actions-client/inventory'");
    expect(dashboardSource).toContain('await getLowStockAction(10)');
    expect(dashboardSource).not.toContain('WITH DrugStock AS');
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

  it('normalizes legacy unit/pill small-unit aliases in reorder demand instead of treating them as whole large packs', async () => {
    mockDb.prepare("DELETE FROM sales_items WHERE invoice_id = 'recent-sale'").run();
    mockDb.prepare(`
      INSERT INTO sales_items (
        invoice_id, drug_id, quantity_sold, unit, is_negative,
        large_to_medium, medium_to_small
      ) VALUES
        ('recent-sale', 9101, 1500, 'unit', 0, 10, 10),
        ('recent-sale', 9101, 1500, 'pill', 0, 10, 10)
    `).run();

    const lowStock = await getLowStockAction(10);
    expect(lowStock.success).toBe(true);
    expect(lowStock.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      avg_monthly_usage: 30,
      reorder_point: 30,
    });

    await addToShortagesAction({ drug_id: 9101, qty: 8 });
    const shortages = await getShortagesAction();
    expect(shortages.success).toBe(true);
    expect(shortages.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      reorder_point: 30,
      deficit: 28,
    });
  });

  it('keeps historical tablet/capsule sale aliases small after the current master unit name changes', async () => {
    mockDb.prepare("UPDATE master_drugs SET small_unit = 'جرعة مخصصة' WHERE id = 9101").run();
    mockDb.prepare("DELETE FROM sales_items WHERE invoice_id = 'recent-sale'").run();
    mockDb.prepare(`
      INSERT INTO sales_items (
        invoice_id, drug_id, quantity_sold, unit, is_negative,
        large_to_medium, medium_to_small
      ) VALUES
        ('recent-sale', 9101, 1000, 'Tablet', 0, 10, 10),
        ('recent-sale', 9101, 1000, 'Capsule', 0, 10, 10),
        ('recent-sale', 9101, 1000, 'قرص', 0, 10, 10),
        ('recent-sale', 9101, 1000, 'كبسولة', 0, 10, 10),
        ('recent-sale', 9101, 1000, 'جرعة مخصصة', 0, 10, 10)
    `).run();

    const lowStock = await getLowStockAction(10);
    expect(lowStock.success).toBe(true);
    expect(lowStock.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      avg_monthly_usage: 50,
      reorder_point: 50,
    });

    await addToShortagesAction({ drug_id: 9101, qty: 8 });
    const shortages = await getShortagesAction();
    expect(shortages.success).toBe(true);
    expect(shortages.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      reorder_point: 50,
      deficit: 48,
    });
  });

  it('keeps the UI low-stock query bounded while synchronizing every low-stock item to shortages', async () => {
    const insert = mockDb.prepare(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, reorder_point, default_purchase_qty)
      VALUES (?, ?, ?, 5, 1)
    `);
    for (let index = 0; index < 251; index += 1) {
      insert.run(9200 + index, `Bulk Low ${index}`, `Bulk Low ${index}`);
    }

    const display = await getLowStockAction(10);
    expect(display.success).toBe(true);
    expect(display.data).toHaveLength(250);
    expect(display.totalCount).toBe(252);

    const sync = await syncLowStockToShortagesAction();
    expect(sync).toMatchObject({ success: true, data: { total: 252 } });
    expect((mockDb.prepare(`
      SELECT COUNT(*) AS count FROM shortages WHERE pharmacy_id = 'local_default'
    `).get() as any).count).toBe(252);
    expect((mockDb.prepare(`
      SELECT COUNT(*) AS count FROM shortages WHERE drug_id = 9450 AND pharmacy_id = 'local_default'
    `).get() as any).count).toBe(1);
  });

  it('does not manually mark a shortage received while usable stock is still below the reorder threshold', async () => {
    await addToShortagesAction({ drug_id: 9101, qty: 8 });
    const shortage = (await getShortagesAction()).data?.find((item: any) => item.drug_id === 9101);
    expect(shortage).toMatchObject({ current_stock: 2, reorder_point: 5 });

    const result = await updateShortageStatusAction(shortage.id, 'received');

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('إعادة الطلب'),
    });
    expect((mockDb.prepare('SELECT status FROM shortages WHERE id = ?').get(shortage.id) as any).status).toBe('pending');
  });

  it('rejects explicit invalid shortage quantities instead of silently changing them to one', async () => {
    expect(await addToShortagesAction({ drug_id: 9102, qty: 0 })).toMatchObject({ success: false });
    expect(await addToShortagesAction({ drug_id: 9102, qty: -4 })).toMatchObject({ success: false });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages WHERE drug_id = 9102').get() as any).count).toBe(0);

    const added = await addToShortagesAction({ drug_id: 9102, qty: 6 });
    expect(added.success).toBe(true);
    const row = mockDb.prepare('SELECT id, requested_quantity FROM shortages WHERE drug_id = 9102').get() as any;
    expect(row.requested_quantity).toBe(6);

    expect(await updateShortageQuantityAction(row.id, 0)).toMatchObject({ success: false });
    expect((mockDb.prepare('SELECT requested_quantity FROM shortages WHERE id = ?').get(row.id) as any).requested_quantity).toBe(6);
  });

  it('keeps reorder usage on the conversion captured when the sale happened', async () => {
    mockDb.prepare('UPDATE master_drugs SET large_to_medium = 20, medium_to_small = 5 WHERE id = 9101').run();

    const lowStock = await getLowStockAction(10);
    expect(lowStock.success).toBe(true);
    expect(lowStock.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      avg_monthly_usage: 2,
      reorder_point: 5,
    });
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
    expect(mockDb.prepare('SELECT pharmacy_id FROM purchase_orders WHERE id = ?').get(poResult.po_id)).toEqual({
      pharmacy_id: 'local_default',
    });

    // Historical ownership belongs to the order row, not the creator's mutable current pharmacy.
    mockDb.prepare("UPDATE users SET pharmacy_id = 'ph-2' WHERE id = 'admin'").run();
    const visibleOrders = await getPurchaseOrdersAction();
    expect(visibleOrders.success).toBe(true);
    expect(visibleOrders.data?.map((order: any) => order.id)).toContain(poResult.po_id);

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

  it('reopens a shortage when its pending purchase order is cancelled', async () => {
    await addToShortagesAction({ drug_id: 9102, qty: 10 });
    const po = await createPurchaseOrderAction({
      supplier_name: 'Cancelled Supplier',
      items: [{ drug_id: 9102, quantity: 10, expected_price: 15 }],
    });
    expect(po.success).toBe(true);
    expect((await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102)?.status).toBe('ordered');

    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'cancelled')).toEqual({ success: true });
    expect((await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102)?.status).toBe('pending');
  });

  it('reopens a cancelled shortage even when an older completed purchase order exists for the same drug', async () => {
    mockDb.exec(`
      INSERT OR IGNORE INTO users (id, username, role, pharmacy_id)
      VALUES ('admin', 'admin', 'owner', NULL);
      INSERT INTO purchase_orders (id, user_id, pharmacy_id, supplier_name, status, total_amount)
      VALUES ('PO-HISTORICAL', 'admin', 'local_default', 'Old Supplier', 'completed', 15);
      INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price)
      VALUES ('PO-HISTORICAL', 9102, 1, 15);
    `);

    await addToShortagesAction({ drug_id: 9102, qty: 10 });
    const currentPo = await createPurchaseOrderAction({
      supplier_name: 'Current Supplier',
      items: [{ drug_id: 9102, quantity: 10, expected_price: 15 }],
    });
    expect(currentPo.success).toBe(true);
    expect((await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102)?.status).toBe('ordered');

    expect(await updatePurchaseOrderStatusAction(currentPo.po_id!, 'cancelled')).toEqual({ success: true });
    expect((await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102)?.status).toBe('pending');
  });

  it('keeps a shortage ordered when another pending purchase order still covers the same drug', async () => {
    await addToShortagesAction({ drug_id: 9102, qty: 10 });
    const firstPo = await createPurchaseOrderAction({
      supplier_name: 'First Supplier',
      items: [{ drug_id: 9102, quantity: 10, expected_price: 15 }],
    });
    expect(firstPo.success).toBe(true);
    mockDb.exec(`
      INSERT INTO purchase_orders (id, user_id, pharmacy_id, supplier_name, status, total_amount)
      VALUES ('PO-SECOND', 'admin', 'local_default', 'Second Supplier', 'pending', 150);
      INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price)
      VALUES ('PO-SECOND', 9102, 10, 15);
    `);

    expect(await updatePurchaseOrderStatusAction(firstPo.po_id!, 'cancelled')).toEqual({ success: true });
    expect((await getShortagesAction()).data?.find((item: any) => item.drug_id === 9102)?.status).toBe('ordered');
  });

  it('does not reopen a cancelled-order shortage when usable stock has already recovered', async () => {
    await addToShortagesAction({ drug_id: 9101, qty: 5 });
    const po = await createPurchaseOrderAction({
      supplier_name: 'Recovered Supplier',
      items: [{ drug_id: 9101, quantity: 5, expected_price: 25 }],
    });
    expect(po.success).toBe(true);
    expect((await getShortagesAction()).data?.find((item: any) => item.drug_id === 9101)?.status).toBe('ordered');

    mockDb.prepare("UPDATE inventory SET quantity = 6 WHERE id = 'low-stock'").run();
    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'cancelled')).toEqual({ success: true });

    expect((mockDb.prepare(
      "SELECT status FROM shortages WHERE drug_id = 9101 ORDER BY id LIMIT 1"
    ).get() as any).status).toBe('received');
  });

  it('keeps shortages active until stock clears the dynamic 30-day demand threshold', async () => {
    mockDb.exec(`
      INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL);
      INSERT OR IGNORE INTO suppliers (id, name_ar, balance) VALUES (1, 'مورد الطلب الديناميكي', 0);
      INSERT INTO sales_invoices (id, pharmacy_id, user_id, total_amount, status, created_at)
      VALUES ('dynamic-demand-sale', NULL, 'admin', 180, 'completed', CURRENT_TIMESTAMP);
      INSERT INTO sales_items (
        invoice_id, drug_id, quantity_sold, unit, is_negative,
        large_to_medium, medium_to_small
      ) VALUES ('dynamic-demand-sale', 9101, 18, 'علبة', 0, 10, 10);
      UPDATE inventory SET quantity = 6 WHERE id = 'low-stock';
    `);

    await addToShortagesAction({ drug_id: 9101, qty: 20 });
    const shortage = (await getShortagesAction()).data?.find((item: any) => item.drug_id === 9101);
    expect(shortage).toMatchObject({
      current_stock: 6,
      reorder_point: 20,
      deficit: 14,
      inventory_status: 'critical',
    });
    const lowStock = await getLowStockAction(10);
    expect(lowStock.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      current_stock: 6,
      reorder_point: 20,
      deficit: 14,
      avg_monthly_usage: 20,
    });

    expect(await updateShortageStatusAction(shortage.id, 'received')).toMatchObject({
      success: false,
      error: expect.stringContaining('حد إعادة الطلب'),
    });

    const receipt = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-DYNAMIC-PARTIAL',
      invoice_date: '2026-09-28',
      payment_method: 'credit',
      status: 'completed',
      cart: [{
        id: 9101,
        quantity: 1,
        cost_price: 20,
        selling_price: 25,
        expiry_date: '2029-12-31',
        strips_per_box: 10,
      }],
    });
    expect(receipt.success).toBe(true);
    expect((mockDb.prepare('SELECT status FROM shortages WHERE id = ?').get(shortage.id) as any).status).not.toBe('received');
  });

  it('keeps the unplaced remainder pending when a purchase order covers only part of a shortage', async () => {
    mockDb.exec(`INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL)`);
    await addToShortagesAction({ drug_id: 9101, qty: 8 });

    const po = await createPurchaseOrderAction({
      supplier_name: 'Partial PO Supplier',
      items: [{ drug_id: 9101, quantity: 5, expected_price: 25 }],
    });
    expect(po.success).toBe(true);

    expect(await syncLowStockToShortagesAction()).toMatchObject({ success: true });
    expect(mockDb.prepare(`
      SELECT requested_quantity, status
      FROM shortages
      WHERE drug_id = 9101
      ORDER BY status, id
    `).all()).toEqual([
      expect.objectContaining({ requested_quantity: 5, status: 'ordered' }),
      expect.objectContaining({ requested_quantity: 3, status: 'pending' }),
    ]);
  });

  it('recombines partial PO coverage into one pending shortage when that order is cancelled', async () => {
    mockDb.exec(`INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL)`);
    await addToShortagesAction({ drug_id: 9101, qty: 8 });
    const po = await createPurchaseOrderAction({
      supplier_name: 'Partial Cancel Supplier',
      items: [{ drug_id: 9101, quantity: 5, expected_price: 25 }],
    });
    expect(po.success).toBe(true);

    expect(mockDb.prepare(`
      SELECT requested_quantity, status
      FROM shortages
      WHERE drug_id = 9101
      ORDER BY status, id
    `).all()).toEqual([
      expect.objectContaining({ requested_quantity: 5, status: 'ordered' }),
      expect.objectContaining({ requested_quantity: 3, status: 'pending' }),
    ]);

    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'cancelled')).toEqual({ success: true });
    expect(mockDb.prepare(`
      SELECT requested_quantity, status
      FROM shortages
      WHERE drug_id = 9101
      ORDER BY id
    `).all()).toEqual([
      expect.objectContaining({ requested_quantity: 8, status: 'pending' }),
    ]);
  });

  it('does not inflate an ordered shortage beyond the quantity actually placed on its purchase order', async () => {
    mockDb.exec(`INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL)`);
    await addToShortagesAction({ drug_id: 9101, qty: 5 });

    const po = await createPurchaseOrderAction({
      supplier_name: 'المورد الرئيسي',
      items: [{ drug_id: 9101, quantity: 5, expected_price: 25 }],
    });
    expect(po.success).toBe(true);

    const beforeSync = mockDb.prepare(`
      SELECT requested_quantity, status FROM shortages WHERE drug_id = 9101 ORDER BY id
    `).all() as any[];
    expect(beforeSync).toEqual([expect.objectContaining({ requested_quantity: 5, status: 'ordered' })]);

    // Current reorder suggestion is 8 (default_purchase_qty), while only 5 was actually ordered.
    const sync = await syncLowStockToShortagesAction();
    expect(sync.success).toBe(true);

    const poItem = mockDb.prepare(`
      SELECT quantity FROM purchase_order_items WHERE po_id = ? AND drug_id = 9101
    `).get(po.po_id) as any;
    expect(poItem.quantity).toBe(5);

    const afterSync = mockDb.prepare(`
      SELECT requested_quantity, status FROM shortages WHERE drug_id = 9101 ORDER BY status, id
    `).all() as any[];
    expect(afterSync).toEqual([
      expect.objectContaining({ requested_quantity: 5, status: 'ordered' }),
      expect.objectContaining({ requested_quantity: 3, status: 'pending' }),
    ]);
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

    // 3. Test draft invoice -> complete invoice resolves shortages once the
    // receipt clears the default effective reorder threshold (10).
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
          quantity: 11,
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

  it('keeps a shortage active when a partial receipt leaves stock below the reorder threshold', async () => {
    mockDb.exec(`
      INSERT OR IGNORE INTO users (id, username, role, pharmacy_id) VALUES ('admin', 'admin', 'owner', NULL);
      INSERT OR IGNORE INTO suppliers (id, name_ar, balance) VALUES (1, 'مورد جزئي', 0);
    `);
    await addToShortagesAction({ drug_id: 9101, qty: 10 });

    const result = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-PARTIAL-SHORTAGE',
      invoice_date: '2026-09-27',
      payment_method: 'credit',
      status: 'completed',
      cart: [{
        id: 9101,
        quantity: 1,
        cost_price: 20,
        selling_price: 25,
        expiry_date: '2029-12-31',
        strips_per_box: 10,
      }],
    });
    expect(result.success).toBe(true);

    expect((mockDb.prepare(`
      SELECT SUM(
        CASE
          WHEN COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL THEN i.quantity
          ELSE 0
        END
      ) AS quantity
      FROM inventory i
      JOIN master_drugs md ON md.id = i.drug_id
      WHERE i.drug_id = 9101
        AND (i.pharmacy_id IS NULL OR i.pharmacy_id = 'local_default')
        AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
    `).get() as any).quantity).toBe(3);
    const shortage = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9101').get() as any;
    expect(shortage.status).not.toBe('received');
    const lowStock = await getLowStockAction(5);
    expect(lowStock.data?.some((row: any) => row.drug_id === 9101)).toBe(true);
  });

  it('resolves recovered shortages when stock is replenished outside the purchase workflow', async () => {
    await addToShortagesAction({ drug_id: 9102, qty: 10 });
    const manualAdd = await addInventoryAction({
      drug_id: 9102,
      quantity: 11,
      local_selling_price: 15,
      expiry_date: '2099-12-31',
    });
    expect(manualAdd.success).toBe(true);

    mockDb.prepare(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, reorder_point, default_purchase_qty)
      VALUES (9105, 'رصيد افتتاحي', 'Opening Balance Drug', 5, 6)
    `).run();
    await addToShortagesAction({ drug_id: 9105, qty: 6 });
    const openingBalance = await addOpeningBalanceAction({
      drug_id: 9105,
      quantity: 6,
      cost_price: 0,
      unit_price: 10,
      expiry_date: '2099-12-31',
    });
    expect(openingBalance.success).toBe(true);

    expect((mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9102').get() as any).status).toBe('received');
    expect((mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9105').get() as any).status).toBe('received');
  });

  it('resolves recovered shortages after inventory edits and positive stock adjustments', async () => {
    mockDb.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES ('admin', 'admin', 'owner')").run();
    mockDb.prepare("INSERT OR IGNORE INTO adjustment_reasons (id, name_ar) VALUES (1, 'تصحيح رصيد')").run();

    await addToShortagesAction({ drug_id: 9102, qty: 11 });
    expect((await updateInventoryAction({
      id: 'zero-stock',
      quantity: 11,
      local_selling_price: 15,
      reason_id: 1,
    })).success).toBe(true);
    expect((mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9102').get() as any).status).toBe('received');

    await addToShortagesAction({ drug_id: 9101, qty: 6 });
    expect((await createStockAdjustmentAction('low-stock', {
      reason_id: 1,
      old_quantity: 2,
      new_quantity: 6,
    })).success).toBe(true);
    expect((mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9101').get() as any).status).toBe('received');
  });

  it('resolves a shortage when correcting an expired lot makes existing stock usable again', async () => {
    await addToShortagesAction({ drug_id: 9101, qty: 6 });

    expect((await updateInventoryAction({
      id: 'expired-stock',
      quantity: 50,
      local_selling_price: 15,
      expiry_date: '2099-12-31',
    })).success).toBe(true);

    expect((mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9101').get() as any).status).toBe('received');
  });

  it('rolls back replenished stock when shortage reconciliation fails inside the transaction', async () => {
    await addToShortagesAction({ drug_id: 9102, qty: 11 });
    mockDb.exec(`
      CREATE TRIGGER reject_received_shortage
      BEFORE UPDATE OF status ON shortages
      WHEN NEW.status = 'received'
      BEGIN
        SELECT RAISE(ABORT, 'shortage reconciliation failed');
      END;
    `);

    const before = (mockDb.prepare('SELECT COUNT(*) AS count FROM inventory WHERE drug_id = 9102').get() as any).count;
    const result = await addInventoryAction({
      drug_id: 9102,
      quantity: 11,
      local_selling_price: 15,
      expiry_date: '2099-12-31',
    });

    expect(result.success).toBe(false);
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM inventory WHERE drug_id = 9102').get() as any).count).toBe(before);
    expect((mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 9102').get() as any).status).toBe('pending');
  });
});
