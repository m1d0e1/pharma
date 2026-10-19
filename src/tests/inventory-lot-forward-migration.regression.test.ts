/** @jest-environment node */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

describe('native inventory lot nonce forward migration', () => {
  it('preserves existing stock/history and permanently blocks nonce reuse after a lot is deleted', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE inventory(
          id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT,
          quantity REAL, expiry_date TEXT
        );
        CREATE TABLE sales_items(id TEXT PRIMARY KEY, inventory_id TEXT, quantity_sold REAL);
        CREATE TABLE stock_adjustments(id INTEGER PRIMARY KEY,inventory_id TEXT,old_quantity REAL,new_quantity REAL);
        INSERT INTO inventory VALUES
          ('old-branch-a',10,'branch-a',3.5,'2027-02-01'),
          ('old-branch-b',10,'branch-b',2,'2028-01-01');
        INSERT INTO sales_items VALUES('old-sale','old-branch-a',1);
        INSERT INTO stock_adjustments VALUES(12,'old-branch-b',3,2);
      `);
      const beforeStock = db.prepare('SELECT * FROM inventory ORDER BY id').all();
      const beforeSales = db.prepare('SELECT * FROM sales_items').all();
      const beforeAdjustments = db.prepare('SELECT * FROM stock_adjustments').all();
      const migration = fs.readFileSync(path.join(process.cwd(),
        'src-tauri/migrations/038_inventory_lot_create_requests.sql'), 'utf8');
      db.exec(migration);
      expect(db.prepare('SELECT * FROM inventory ORDER BY id').all()).toEqual(beforeStock);
      expect(db.prepare('SELECT * FROM sales_items').all()).toEqual(beforeSales);
      expect(db.prepare('SELECT * FROM stock_adjustments').all()).toEqual(beforeAdjustments);
      expect(db.prepare('SELECT * FROM inventory_lot_create_requests').all()).toEqual([]);

      db.prepare('INSERT INTO inventory(id,drug_id,pharmacy_id,quantity) VALUES(?,?,?,?)')
        .run('native-created',10,'branch-a',1);
      db.prepare('INSERT INTO inventory_lot_create_requests(request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash) VALUES(?,?,?,?,?,?)')
        .run('nonce-once','native-created',10,'branch-a','actor-a','original-payload-hash');
      db.prepare('DELETE FROM inventory WHERE id=?').run('native-created');
      expect(() => db.prepare('INSERT INTO inventory_lot_create_requests(request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash) VALUES(?,?,?,?,?,?)')
        .run('nonce-once','native-retry',20,'branch-b','actor-b','forged-payload-hash')).toThrow();
      expect(db.prepare('SELECT inventory_id,drug_id,pharmacy_id,created_by FROM inventory_lot_create_requests WHERE request_id=?')
        .get('nonce-once')).toEqual({inventory_id:'native-created',drug_id:10,pharmacy_id:'branch-a',created_by:'actor-a'});
    } finally {
      db.close();
    }
  });
  it('applies forward 039 without changing old stock, catalog or immutable 038 receipts', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,quantity REAL);
        CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,official_price REAL);
        INSERT INTO inventory VALUES('lot-old',10,'branch-a',2.5);
        INSERT INTO master_drugs VALUES(10,15.25);
      `);
      const path038 = path.join(process.cwd(), 'src-tauri/migrations/038_inventory_lot_create_requests.sql');
      const path039 = path.join(process.cwd(), 'src-tauri/migrations/039_inventory_create_acknowledgements.sql');
      db.exec(fs.readFileSync(path038, 'utf8'));
      db.prepare('INSERT INTO inventory_lot_create_requests(request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash) VALUES(?,?,?,?,?,?)')
        .run('a1111111-1111-4111-8111-111111111111','lot-old',10,'branch-a','actor-a','hash-A');
      const beforeInventory = db.prepare('SELECT * FROM inventory').all();
      const beforeCatalog = db.prepare('SELECT * FROM master_drugs').all();
      const beforeRequests = db.prepare('SELECT * FROM inventory_lot_create_requests').all();
      db.exec(fs.readFileSync(path039, 'utf8'));
      expect(db.prepare('SELECT * FROM inventory').all()).toEqual(beforeInventory);
      expect(db.prepare('SELECT * FROM master_drugs').all()).toEqual(beforeCatalog);
      expect(db.prepare('SELECT * FROM inventory_lot_create_requests').all()).toEqual(beforeRequests);
      expect(db.prepare('SELECT * FROM inventory_lot_create_acknowledgements').all()).toEqual([]);
      db.prepare('INSERT INTO inventory_lot_create_acknowledgements(request_id,pharmacy_id,acknowledged_by) VALUES(?,?,?)')
        .run('a1111111-1111-4111-8111-111111111111','branch-a','actor-a');
      expect(db.prepare('SELECT acknowledged_by FROM inventory_lot_create_acknowledgements').get())
        .toEqual({ acknowledged_by: 'actor-a' });
      db.prepare('INSERT INTO inventory_lot_import_receipts(request_id,pharmacy_id,created_by,payload_hash,inventory_ids_json,inventory_count) VALUES(?,?,?,?,?,?)')
        .run('b1111111-1111-4111-8111-111111111111','branch-a','actor-a','same-file-hash','["lot-imported"]',1);
      expect(() => db.prepare('INSERT INTO inventory_lot_import_receipts(request_id,pharmacy_id,created_by,payload_hash,inventory_ids_json,inventory_count) VALUES(?,?,?,?,?,?)')
        .run('c1111111-1111-4111-8111-111111111111','branch-a','actor-a','same-file-hash','["duplicated"]',1)).toThrow();
      expect(db.prepare('SELECT payload_hash,inventory_count FROM inventory_lot_import_receipts').get())
        .toEqual({ payload_hash: 'same-file-hash', inventory_count: 1 });
    } finally {
      db.close();
    }
  });
});
