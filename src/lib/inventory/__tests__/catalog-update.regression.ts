import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';
import {
  applyMasterDrugCatalogUpdate,
  previewMasterDrugCatalogUpdate,
  type CatalogFieldDecision,
  type CatalogNewDrugDecision,
  type CatalogUpdateDatabase,
  type MasterDrugCatalogUpdatePreview,
} from '@/lib/inventory/catalog-update';

function applyCurrentMigrations(db: Database.Database) {
  for (const file of readdirSync('src-tauri/migrations').filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'));
  }
}

function adapter(db: Database.Database): CatalogUpdateDatabase {
  return {
    select: async (sql, params = []) => db.prepare(sql).all(...params),
    transaction: async callback => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback(createSqliteTransactionDb(db));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function reviewedFieldDecisions(
  preview: MasterDrugCatalogUpdatePreview,
  chooseCatalog: (field: string, catalogDrugId: number) => boolean = () => false,
): CatalogFieldDecision[] {
  return preview.changedDrugs.flatMap(drug => drug.changes.map(change => ({
    catalogDrugId: drug.catalogDrugId,
    masterDrugId: drug.masterDrugId,
    field: change.field,
    action: chooseCatalog(change.field, drug.catalogDrugId) ? 'use_catalog' : 'keep_local',
    expectedCurrentValue: change.currentValue,
    expectedIncomingValue: change.incomingValue,
  })));
}

function reviewedNewDrugDecisions(
  preview: MasterDrugCatalogUpdatePreview,
  addIds: number[] = [],
): CatalogNewDrugDecision[] {
  const add = new Set(addIds);
  return preview.newDrugs.map(drug => ({
    catalogDrugId: drug.catalogDrugId,
    action: add.has(drug.catalogDrugId) ? 'add' : 'keep_absent',
  }));
}

describe('safe drug catalog reconciliation', () => {
  let db: Database.Database;
  const catalogRows = [
    {
      id: 100,
      trade_name: 'PANADOL 500',
      active_ingredient: 'PARACETAMOL',
      manufacturer: 'HALEON',
      official_price: 60,
      reorder_point: 99,
      notes: 'CATALOG NOTE MUST NOT REPLACE LOCAL NOTE',
    },
    { id: 110, trade_name: 'UNCHANGED DRUG', official_price: 10 },
    { id: 200, trade_name: 'PREVIOUSLY REMOVED DRUG', official_price: 20 },
    { id: 201, trade_name: 'GENUINE NEW DRUG', official_price: 30, reorder_point: 50 },
    { id: 202, trade_name: 'SUPPRESSED FROM EARLIER REVIEW', official_price: 40 },
    { id: 300, trade_name: 'OFFICIAL CATALOG DRUG', active_ingredient: 'OFFICIAL INGREDIENT' },
  ];

  beforeEach(() => {
    db = new Database(':memory:');
    applyCurrentMigrations(db);
    db.pragma('foreign_keys = ON');
    db.exec(`
      INSERT INTO users (id, username, role, is_active)
      VALUES ('catalog-admin', 'catalog-test-owner', 'owner', 1);

      INSERT INTO master_drugs (
        id, trade_name, active_ingredient, manufacturer, official_price,
        reorder_point, notes, barcode
      ) VALUES
        (100, 'PANADOL 500', 'PARACETAMOL', 'GSK LOCAL', 55, 7, 'LOCAL PHARMACY NOTE', 'P100'),
        (110, 'UNCHANGED DRUG', NULL, NULL, 10, 4, 'LOCAL UNCHANGED NOTE', 'P110'),
        (300, 'MY CUSTOM DRUG USING THIS ID', 'CUSTOM INGREDIENT', 'LOCAL LAB', 15, 2, 'CUSTOM', 'C300'),
        (900, 'LOCAL CUSTOM CREAM', 'CUSTOM MIX', 'LOCAL COMPOUNDING', 12, 3, 'CUSTOM USER DRUG', 'C900');

      INSERT INTO inventory (
        id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price,
        expiry_date, barcode, batch_number
      ) VALUES ('lot-100', 100, 'local_default', 17, 62, 40, '2030-01-01', 'P100', 'LOT-A');

      INSERT INTO sales_invoices (
        id, pharmacy_id, user_id, total_amount, payment_method, status
      ) VALUES ('sale-100', 'local_default', 'catalog-admin', 62, 'cash', 'completed');

      INSERT INTO sales_items (
        invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price
      ) VALUES ('sale-100', 'lot-100', 100, 1, 62, 'large', 40);

      INSERT INTO suppliers (id, name_ar, name_en)
      VALUES (91001, 'مورد اختبار الدليل', 'Catalog test supplier');

      INSERT INTO purchase_invoices (
        id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date,
        total_amount, paid_amount, payment_method, status
      ) VALUES (
        'purchase-100', 91001, 'local_default', 'catalog-admin', 'CAT-100', '2026-09-20',
        80, 80, 'cash', 'completed'
      );

      INSERT INTO purchase_invoice_items (
        invoice_id, drug_id, quantity, expiry_date, cost_price, selling_price,
        inventory_id, barcode
      ) VALUES (
        'purchase-100', 100, 2, '2030-01-01', 40, 62, 'lot-100', 'P100'
      );

      INSERT INTO returns (
        id, invoice_id, user_id, reason, total_refund, refund_method, status
      ) VALUES (
        'return-100', 'sale-100', 'catalog-admin', 'Catalog simulation return', 62, 'cash', 'completed'
      );

      INSERT INTO return_items (
        return_id, inventory_id, drug_id, drug_name, quantity_returned,
        unit_price, total_price, sale_item_id, unit
      ) VALUES (
        'return-100', 'lot-100', 100, 'PANADOL 500', 1,
        62, 62, (SELECT id FROM sales_items WHERE invoice_id = 'sale-100' LIMIT 1), 'large'
      );

      INSERT INTO drug_catalog_suppressions (catalog_drug_id, reason, created_by)
      VALUES (202, 'kept_absent_by_user', 'catalog-admin');
    `);
  });

  afterEach(() => db.close());

  it('previews altered-user data conservatively and applies only reviewed choices without moving stock or history', async () => {
    const database = adapter(db);
    const preview = await previewMasterDrugCatalogUpdate(catalogRows, database);

    expect(preview.summary).toMatchObject({
      incomingCount: 6,
      changedDrugCount: 1,
      newDrugCount: 3,
      suppressedDrugCount: 1,
      identityConflictCount: 1,
      currentOnlyCount: 1,
      unchangedCount: 1,
      inventoryRowsAffected: 0,
      historyRowsAffected: 0,
    });

    const changed = preview.changedDrugs.find(drug => drug.catalogDrugId === 100)!;
    expect(changed.matchMethod).toBe('same_id_name');
    expect(changed.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'manufacturer', currentValue: 'GSK LOCAL', incomingValue: 'HALEON', defaultDecision: 'keep_local' }),
      expect.objectContaining({ field: 'official_price', currentValue: 55, incomingValue: 60, defaultDecision: 'keep_local' }),
    ]));
    expect(changed.protectedChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'reorder_point', currentValue: 7, incomingValue: 99 }),
      expect.objectContaining({ field: 'notes', currentValue: 'LOCAL PHARMACY NOTE', incomingValue: 'CATALOG NOTE MUST NOT REPLACE LOCAL NOTE' }),
    ]));
    expect(preview.newDrugs.find(drug => drug.catalogDrugId === 202)?.suppressed).toBe(true);
    expect(preview.identityConflicts).toEqual([
      expect.objectContaining({ catalogDrugId: 300, masterDrugId: 300, currentName: 'MY CUSTOM DRUG USING THIS ID' }),
    ]);
    expect(preview.currentOnlySample).toEqual([
      expect.objectContaining({ masterDrugId: 900, name: 'LOCAL CUSTOM CREAM' }),
    ]);

    const stockBefore = db.prepare(`
      SELECT id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, barcode, batch_number
      FROM inventory WHERE id = 'lot-100'
    `).get();
    const saleBefore = db.prepare(`
      SELECT invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price
      FROM sales_items WHERE invoice_id = 'sale-100'
    `).get();
    const purchaseBefore = db.prepare(`
      SELECT invoice_id, drug_id, quantity, expiry_date, cost_price, selling_price, inventory_id, barcode
      FROM purchase_invoice_items WHERE invoice_id = 'purchase-100'
    `).get();
    const returnBefore = db.prepare(`
      SELECT return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, total_price, sale_item_id, unit
      FROM return_items WHERE return_id = 'return-100'
    `).get();

    const result = await applyMasterDrugCatalogUpdate({
      rows: catalogRows,
      previewSignature: preview.signature,
      fieldDecisions: reviewedFieldDecisions(preview, (field, id) => id === 100 && field === 'manufacturer'),
      newDrugDecisions: reviewedNewDrugDecisions(preview, [201]),
      identityConflictDecisions: preview.identityConflicts.map(conflict => ({
        catalogDrugId: conflict.catalogDrugId,
        action: 'keep_local',
      })),
      userId: 'catalog-admin',
      backupPath: 'simulation://pre-update-backup/pharma_local.db',
      sourceName: 'drug-directory-2026-10.xlsx',
    }, database);

    expect(result).toMatchObject({
      updatedDrugs: 1,
      updatedFields: 1,
      addedDrugs: 1,
      keptAbsentDrugs: 2,
      conflictsKeptLocal: 1,
      currentOnlyPreserved: 1,
      inventoryRowsAffected: 0,
      historyRowsAffected: 0,
    });

    expect(db.prepare(`
      SELECT id, trade_name, manufacturer, official_price, reorder_point, notes, barcode
      FROM master_drugs WHERE id = 100
    `).get()).toEqual({
      id: 100,
      trade_name: 'PANADOL 500',
      manufacturer: 'HALEON',
      official_price: 55,
      reorder_point: 7,
      notes: 'LOCAL PHARMACY NOTE',
      barcode: 'P100',
    });
    expect(db.prepare(`SELECT id, trade_name, notes FROM master_drugs WHERE id = 900`).get()).toEqual({
      id: 900,
      trade_name: 'LOCAL CUSTOM CREAM',
      notes: 'CUSTOM USER DRUG',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM master_drugs WHERE id = 200`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT id, trade_name, official_price, reorder_point FROM master_drugs WHERE id = 201`).get()).toEqual({
      id: 201,
      trade_name: 'GENUINE NEW DRUG',
      official_price: 30,
      reorder_point: null,
    });
    expect(db.prepare(`SELECT id, trade_name, active_ingredient FROM master_drugs WHERE id = 300`).get()).toEqual({
      id: 300,
      trade_name: 'MY CUSTOM DRUG USING THIS ID',
      active_ingredient: 'CUSTOM INGREDIENT',
    });

    expect(db.prepare(`
      SELECT id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, barcode, batch_number
      FROM inventory WHERE id = 'lot-100'
    `).get()).toEqual(stockBefore);
    expect(db.prepare(`
      SELECT invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price
      FROM sales_items WHERE invoice_id = 'sale-100'
    `).get()).toEqual(saleBefore);
    expect(db.prepare(`
      SELECT invoice_id, drug_id, quantity, expiry_date, cost_price, selling_price, inventory_id, barcode
      FROM purchase_invoice_items WHERE invoice_id = 'purchase-100'
    `).get()).toEqual(purchaseBefore);
    expect(db.prepare(`
      SELECT return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, total_price, sale_item_id, unit
      FROM return_items WHERE return_id = 'return-100'
    `).get()).toEqual(returnBefore);

    expect(db.prepare(`SELECT catalog_drug_id, master_drug_id FROM drug_catalog_links ORDER BY catalog_drug_id`).all()).toEqual([
      { catalog_drug_id: 100, master_drug_id: 100 },
      { catalog_drug_id: 110, master_drug_id: 110 },
      { catalog_drug_id: 201, master_drug_id: 201 },
    ]);
    expect(db.prepare(`SELECT catalog_drug_id, reason FROM drug_catalog_suppressions ORDER BY catalog_drug_id`).all()).toEqual([
      { catalog_drug_id: 200, reason: 'kept_absent_by_user' },
      { catalog_drug_id: 202, reason: 'kept_absent_by_user' },
      { catalog_drug_id: 300, reason: 'identity_conflict_kept_local' },
    ]);
    expect(db.prepare(`SELECT field_name, policy FROM drug_catalog_field_policies WHERE master_drug_id = 100 ORDER BY field_name`).all()).toEqual([
      { field_name: 'manufacturer', policy: 'catalog' },
      { field_name: 'official_price', policy: 'local' },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_update_runs`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE action = 'DRUG_CATALOG_RECONCILE'`).get()).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects a stale reviewed preview and rolls back all catalog metadata writes', async () => {
    const database = adapter(db);
    const rows = [catalogRows[0]];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);
    db.prepare(`UPDATE master_drugs SET manufacturer = 'LOCAL CHANGE AFTER PREVIEW' WHERE id = 100`).run();

    await expect(applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: reviewedFieldDecisions(preview, () => true),
      newDrugDecisions: [],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database)).rejects.toThrow(/changed while it was being reviewed/i);

    expect(db.prepare(`SELECT manufacturer FROM master_drugs WHERE id = 100`).get()).toEqual({ manufacturer: 'LOCAL CHANGE AFTER PREVIEW' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_links`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_field_policies`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_update_runs`).get()).toEqual({ count: 0 });
  });

  it('rejects a reviewed catalog barcode that belongs to another positive inventory row and rolls back', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, official_price) VALUES (101, 'OTHER LOCAL DRUG', 5);
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, barcode)
      VALUES ('other-lot', 101, 'local_default', 3, 'SHARED-BARCODE');
    `);
    const database = adapter(db);
    const rows = [{ id: 100, trade_name: 'PANADOL 500', barcode: 'SHARED-BARCODE' }];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    await expect(applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: reviewedFieldDecisions(preview, field => field === 'barcode'),
      newDrugDecisions: [],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database)).rejects.toThrow(/already assigned to another drug/i);

    expect(db.prepare(`SELECT barcode FROM master_drugs WHERE id = 100`).get()).toEqual({ barcode: 'P100' });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_links`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_field_policies`).get()).toEqual({ count: 0 });
  });

  it('rejects duplicate incoming catalog IDs before any review can be applied', async () => {
    await expect(previewMasterDrugCatalogUpdate([
      { id: 100, trade_name: 'PANADOL 500' },
      { id: 100, trade_name: 'DUPLICATE ID' },
    ], adapter(db))).rejects.toThrow(/Duplicate drug id 100/i);
  });

  it('quarantines a second catalog record targeting an already linked local drug without creating a duplicate link', async () => {
    db.prepare(`
      INSERT INTO drug_catalog_links (catalog_drug_id, master_drug_id, linked_by)
      VALUES (1000, 110, 'catalog-admin')
    `).run();
    const database = adapter(db);
    const rows = [
      { id: 1000, trade_name: 'UNCHANGED DRUG', official_price: 10 },
      { id: 110, trade_name: 'UNCHANGED DRUG', official_price: 10 },
    ];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    expect(preview.matchedLinks).toEqual([{ catalogDrugId: 1000, masterDrugId: 110 }]);
    expect(preview.identityConflicts).toEqual([
      expect.objectContaining({ catalogDrugId: 110, masterDrugId: 110, incomingName: 'UNCHANGED DRUG' }),
    ]);

    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: [],
      newDrugDecisions: [],
      identityConflictDecisions: [{ catalogDrugId: 110, action: 'keep_local' }],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare('SELECT catalog_drug_id, master_drug_id FROM drug_catalog_links ORDER BY catalog_drug_id').all()).toEqual([
      { catalog_drug_id: 1000, master_drug_id: 110 },
    ]);
    expect(db.prepare('SELECT catalog_drug_id, reason FROM drug_catalog_suppressions WHERE catalog_drug_id = 110').get()).toEqual({
      catalog_drug_id: 110,
      reason: 'identity_conflict_kept_local',
    });
    expect(db.prepare('SELECT id, official_price FROM master_drugs WHERE id = 110').get()).toEqual({ id: 110, official_price: 10 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each([
    { rows: [{ id: 110, trade_name: 'UNCHANGED DRUG', official_price: 10 }, { id: 1000, trade_name: 'UNCHANGED DRUG', official_price: 10 }] },
    { rows: [{ id: 110, trade_name: 'UNCHANGED DRUG', official_price: 10 }] },
  ])('keeps the persisted catalog owner when another matching catalog ID arrives: %j', async ({ rows }) => {
    db.prepare(`
      INSERT INTO drug_catalog_links (catalog_drug_id, master_drug_id, linked_by)
      VALUES (1000, 110, 'catalog-admin')
    `).run();
    const database = adapter(db);
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    expect(preview.identityConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogDrugId: 110, masterDrugId: 110 }),
    ]));
    expect(preview.matchedLinks).toEqual(rows.length === 2
      ? [{ catalogDrugId: 1000, masterDrugId: 110 }]
      : []);

    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: [],
      newDrugDecisions: [],
      identityConflictDecisions: [{ catalogDrugId: 110, action: 'keep_local' }],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare('SELECT catalog_drug_id, master_drug_id FROM drug_catalog_links').all()).toEqual([
      { catalog_drug_id: 1000, master_drug_id: 110 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM drug_catalog_links WHERE catalog_drug_id = 110').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('quarantines duplicate incoming barcodes before applying either new drug', async () => {
    const database = adapter(db);
    const rows = [
      { id: 701, trade_name: 'FIRST DUPLICATE BARCODE', barcode: 'DUPLICATE-CATALOG-BARCODE' },
      { id: 702, trade_name: 'SECOND DUPLICATE BARCODE', barcode: 'duplicate-catalog-barcode' },
    ];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    expect(preview.newDrugs).toEqual([]);
    expect(preview.identityConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogDrugId: 701, currentName: 'باركود مكرر داخل الدليل' }),
      expect.objectContaining({ catalogDrugId: 702, currentName: 'باركود مكرر داخل الدليل' }),
    ]));

    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: [],
      newDrugDecisions: [],
      identityConflictDecisions: preview.identityConflicts.map(conflict => ({
        catalogDrugId: conflict.catalogDrugId,
        action: 'keep_local' as const,
      })),
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id IN (701, 702)').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT catalog_drug_id, reason FROM drug_catalog_suppressions WHERE catalog_drug_id IN (701, 702) ORDER BY catalog_drug_id').all()).toEqual([
      { catalog_drug_id: 701, reason: 'identity_conflict_kept_local' },
      { catalog_drug_id: 702, reason: 'identity_conflict_kept_local' },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM drug_catalog_links WHERE catalog_drug_id IN (701, 702)').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('allows a selected master-barcode release before adding its catalog replacement, but preserves active lot ownership', async () => {
    const database = adapter(db);
    db.prepare("UPDATE master_drugs SET barcode = 'TRANSFERRED-CODE' WHERE id = 110").run();
    const transferRows = [
      { id: 110, trade_name: 'UNCHANGED DRUG', barcode: null },
      { id: 703, trade_name: 'TRANSFERRED BARCODE DRUG', barcode: 'TRANSFERRED-CODE' },
    ];
    const transferPreview = await previewMasterDrugCatalogUpdate(transferRows, database);

    await applyMasterDrugCatalogUpdate({
      rows: transferRows,
      previewSignature: transferPreview.signature,
      fieldDecisions: reviewedFieldDecisions(transferPreview, field => field === 'barcode'),
      newDrugDecisions: [{ catalogDrugId: 703, action: 'add' }],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 110').get()).toEqual({ barcode: null });
    expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 703').get()).toEqual({ barcode: 'TRANSFERRED-CODE' });

    db.exec(`
      UPDATE master_drugs SET barcode = 'ACTIVE-LOT-CODE' WHERE id = 110;
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, barcode)
      VALUES ('active-110', 110, 'local_default', 1, 'ACTIVE-LOT-CODE');
    `);
    const blockedRows = [
      { id: 110, trade_name: 'UNCHANGED DRUG', barcode: null },
      { id: 704, trade_name: 'ACTIVE LOT BARCODE DRUG', barcode: 'ACTIVE-LOT-CODE' },
    ];
    const blockedPreview = await previewMasterDrugCatalogUpdate(blockedRows, database);

    await expect(applyMasterDrugCatalogUpdate({
      rows: blockedRows,
      previewSignature: blockedPreview.signature,
      fieldDecisions: reviewedFieldDecisions(blockedPreview, field => field === 'barcode'),
      newDrugDecisions: [{ catalogDrugId: 704, action: 'add' }],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database)).rejects.toThrow(/already assigned to another drug/i);

    expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 110').get()).toEqual({ barcode: 'ACTIVE-LOT-CODE' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 704').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT barcode FROM inventory WHERE id = ?').get('active-110')).toEqual({ barcode: 'ACTIVE-LOT-CODE' });
  });

  it('treats same-ID metadata-only similarity as an identity conflict instead of an automatic catalog link', async () => {
    db.prepare(`
      INSERT INTO master_drugs (
        id, trade_name, barcode, active_ingredient, manufacturer, category, official_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(400, 'LOCAL CUSTOM A', 'LOCAL-400', 'SHARED INGREDIENT', 'SAME LAB', 'TABLETS', 11);

    const preview = await previewMasterDrugCatalogUpdate([{
      id: 400,
      trade_name: 'OFFICIAL DIFFERENT DRUG',
      barcode: 'OFFICIAL-400',
      active_ingredient: 'SHARED INGREDIENT',
      manufacturer: 'SAME LAB',
      category: 'TABLETS',
      official_price: 20,
    }], adapter(db));

    expect(preview.changedDrugs).toEqual([]);
    expect(preview.matchedLinks).toEqual([]);
    expect(preview.identityConflicts).toEqual([
      expect.objectContaining({
        catalogDrugId: 400,
        masterDrugId: 400,
        currentName: 'LOCAL CUSTOM A',
        incomingName: 'OFFICIAL DIFFERENT DRUG',
      }),
    ]);
  });

  it('remembers prior field policy as context but starts every new release with keep-local', async () => {
    db.prepare(`
      INSERT INTO drug_catalog_field_policies (master_drug_id, field_name, policy, updated_by)
      VALUES (100, 'official_price', 'catalog', 'catalog-admin')
    `).run();

    const preview = await previewMasterDrugCatalogUpdate([
      { id: 100, trade_name: 'PANADOL 500', official_price: 70 },
    ], adapter(db));
    const price = preview.changedDrugs[0]?.changes.find(change => change.field === 'official_price');

    expect(price).toMatchObject({
      currentValue: 55,
      incomingValue: 70,
      policy: 'catalog',
      defaultDecision: 'keep_local',
    });
  });

  it('rejects an invalid negative catalog selling price before review or writes', async () => {
    await expect(previewMasterDrugCatalogUpdate([
      { id: 100, trade_name: 'PANADOL 500', official_price: -5 },
    ], adapter(db))).rejects.toThrow(/Invalid selling price/i);

    expect(db.prepare('SELECT official_price FROM master_drugs WHERE id = 100').get()).toEqual({ official_price: 55 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM drug_catalog_update_runs').get()).toEqual({ count: 0 });
  });

  it('blocks enabling expiry tracking while positive stock still has no expiry date', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, has_expiry, official_price)
      VALUES (120, 'NO EXPIRY LOCAL STOCK', 0, 10);
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, expiry_date)
      VALUES ('no-expiry-lot', 120, 'local_default', 5, NULL);
    `);
    const database = adapter(db);
    const rows = [{ id: 120, trade_name: 'NO EXPIRY LOCAL STOCK', has_expiry: 1 }];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);
    const expiryChange = preview.changedDrugs[0]?.changes.find(change => change.field === 'has_expiry');

    expect(expiryChange).toMatchObject({
      currentValue: 0,
      incomingValue: 1,
      defaultDecision: 'keep_local',
      blockedReason: expect.stringContaining('مخزون موجب'),
    });

    await expect(applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: reviewedFieldDecisions(preview, field => field === 'has_expiry'),
      newDrugDecisions: [],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database)).rejects.toThrow(/cannot be applied/i);

    expect(db.prepare('SELECT has_expiry FROM master_drugs WHERE id = 120').get()).toEqual({ has_expiry: 0 });
    expect(db.prepare('SELECT quantity, expiry_date FROM inventory WHERE id = ?').get('no-expiry-lot')).toEqual({
      quantity: 5,
      expiry_date: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM drug_catalog_field_policies WHERE master_drug_id = 120').get()).toEqual({ count: 0 });
  });

  it('uses a valid English trade name when a new catalog row has a blank primary trade name', async () => {
    const database = adapter(db);
    const rows = [{ id: 450, trade_name: null, trade_name_en: 'ENGLISH FALLBACK DRUG', official_price: 14 }];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    expect(preview.newDrugs[0]).toMatchObject({
      catalogDrugId: 450,
      name: 'ENGLISH FALLBACK DRUG',
      incoming: expect.objectContaining({ trade_name_en: 'ENGLISH FALLBACK DRUG', official_price: 14 }),
    });

    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: [],
      newDrugDecisions: [{ catalogDrugId: 450, action: 'add' }],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare('SELECT trade_name, trade_name_en, official_price FROM master_drugs WHERE id = 450').get()).toEqual({
      trade_name: 'ENGLISH FALLBACK DRUG',
      trade_name_en: 'ENGLISH FALLBACK DRUG',
      official_price: 14,
    });
  });

  it('exposes protected incoming values for a new drug without applying them', async () => {
    const database = adapter(db);
    const rows = [{
      id: 451,
      trade_name: 'NEW WITH LOCAL-ONLY COLUMNS',
      official_price: 21,
      notes: 'catalog note',
      reorder_point: 99,
      large_to_medium: 12,
    }];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    expect(preview.newDrugs[0]).toMatchObject({
      incoming: expect.objectContaining({
        trade_name: 'NEW WITH LOCAL-ONLY COLUMNS',
        official_price: 21,
        notes: 'catalog note',
        reorder_point: 99,
        large_to_medium: 12,
      }),
      protectedIncomingFields: expect.arrayContaining(['notes', 'reorder_point', 'large_to_medium']),
    });

    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: [],
      newDrugDecisions: [{ catalogDrugId: 451, action: 'add' }],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare(`
      SELECT trade_name, official_price, notes, reorder_point, large_to_medium
      FROM master_drugs WHERE id = 451
    `).get()).toEqual({
      trade_name: 'NEW WITH LOCAL-ONLY COLUMNS',
      official_price: 21,
      notes: null,
      reorder_point: null,
      large_to_medium: null,
    });
  });

  it('leaves a suppression tombstone when any hard-delete path removes a linked catalog drug', async () => {
    const database = adapter(db);
    const rows = [{ id: 110, trade_name: 'UNCHANGED DRUG', official_price: 10 }];
    const preview = await previewMasterDrugCatalogUpdate(rows, database);

    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: [],
      newDrugDecisions: [],
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
    }, database);

    expect(db.prepare(`SELECT catalog_drug_id, master_drug_id FROM drug_catalog_links WHERE catalog_drug_id = 110`).get()).toEqual({
      catalog_drug_id: 110,
      master_drug_id: 110,
    });

    db.prepare(`DELETE FROM master_drugs WHERE id = 110`).run();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM master_drugs WHERE id = 110`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_links WHERE catalog_drug_id = 110`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT catalog_drug_id, reason FROM drug_catalog_suppressions WHERE catalog_drug_id = 110`).get()).toEqual({
      catalog_drug_id: 110,
      reason: 'deleted_locally',
    });
  });

  it('accepts DrugEye rows without IDs, matches unique names to existing drugs, and assigns new IDs above the local maximum without deleting local-only drugs', async () => {
    const database = adapter(db);
    const rows = [
      {
        'Trade Name': 'PANADOL 500',
        Price: '60',
        'Active Ingredient': 'PARACETAMOL',
        Category: 'analgesic',
        Manufacturer: 'HALEON',
      },
      {
        'Trade Name': 'DRUGEYE ONLY DRUG',
        Price: '25',
        'Active Ingredient': 'NEW INGREDIENT',
        Category: 'new category',
        Manufacturer: 'NEW LAB',
      },
    ];

    const preview = await previewMasterDrugCatalogUpdate(rows, database);
    expect(preview.summary.incomingCount).toBe(2);
    expect(preview.changedDrugs).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogDrugId: 100, masterDrugId: 100 }),
    ]));
    const newDrug = preview.newDrugs.find(drug => drug.name === 'DRUGEYE ONLY DRUG');
    expect(newDrug).toBeTruthy();
    expect(newDrug!.catalogDrugId).toBeGreaterThan(900);

    const localOnlyBefore = db.prepare(`SELECT * FROM master_drugs WHERE id = 900`).get();
    await applyMasterDrugCatalogUpdate({
      rows,
      previewSignature: preview.signature,
      fieldDecisions: reviewedFieldDecisions(preview, () => true),
      newDrugDecisions: reviewedNewDrugDecisions(preview, [newDrug!.catalogDrugId]),
      identityConflictDecisions: [],
      userId: 'catalog-admin',
      backupPath: 'simulation://backup',
      sourceName: 'egypt_drugs_drugeye.csv',
    }, database);

    expect(db.prepare(`SELECT * FROM master_drugs WHERE id = 900`).get()).toEqual(localOnlyBefore);
    expect(db.prepare(`SELECT trade_name, official_price, active_ingredient, category, manufacturer FROM master_drugs WHERE id = ?`).get(newDrug!.catalogDrugId)).toEqual({
      trade_name: 'DRUGEYE ONLY DRUG',
      official_price: 25,
      active_ingredient: 'NEW INGREDIENT',
      category: 'new category',
      manufacturer: 'NEW LAB',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('quarantines duplicate or ambiguous DrugEye trade names instead of guessing identities', async () => {
    const database = adapter(db);
    const duplicatePreview = await previewMasterDrugCatalogUpdate([
      { 'Trade Name': 'DUPLICATE DRUGEYE', Price: '10' },
      { 'Trade Name': 'DUPLICATE DRUGEYE', Price: '11' },
    ], database);
    expect(duplicatePreview.identityConflicts).toHaveLength(2);
    expect(duplicatePreview.newDrugs).toHaveLength(0);

    db.exec(`
      INSERT INTO master_drugs (id, trade_name, official_price) VALUES
        (901, 'AMBIGUOUS DRUGEYE', 1),
        (902, 'AMBIGUOUS DRUGEYE', 2);
    `);
    const ambiguousPreview = await previewMasterDrugCatalogUpdate([
      { 'Trade Name': 'AMBIGUOUS DRUGEYE', Price: '12' },
    ], database);
    expect(ambiguousPreview.identityConflicts).toEqual([
      expect.objectContaining({
        incomingName: 'AMBIGUOUS DRUGEYE',
        reason: expect.stringContaining('أكثر من سجل محلي'),
      }),
    ]);
    expect(ambiguousPreview.newDrugs).toHaveLength(0);
  });
});
