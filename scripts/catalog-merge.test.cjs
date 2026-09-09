const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { planMerges, applyMerges, mergeCopy } = require('./merge-catalog-copy');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-merge-'));
  const input = path.join(dir, 'original.db'), csv = path.join(dir, 'reference.csv');
  fs.writeFileSync(csv, 'Trade Name,Price,Active Ingredient,Category,Manufacturer\nANDODERMA EXTRA EMOLLIENT GEL 50 ML,130,CORRECT,skin care,ANDALOUS\nALPHA 20 TABS,20,A,c,m\nAMBIGUOUS,1,A,c,m\nAMBIGUOUS,2,B,c,m\n');
  const db = new Database(input);
  db.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,generic_name TEXT,active_ingredient TEXT,official_price REAL,category TEXT,manufacturer TEXT,barcode TEXT,notes TEXT,large_to_medium INTEGER,medium_to_small INTEGER);
    CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id),quantity REAL,barcode TEXT,local_selling_price REAL,cost_price REAL,strips_per_box REAL,expiry_date TEXT,batch_number TEXT);
    CREATE TABLE sales_items(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id),inventory_id TEXT REFERENCES inventory(id),quantity_sold REAL,unit_price REAL);
    CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id),inventory_id TEXT REFERENCES inventory(id),quantity REAL,cost_price REAL,selling_price REAL);
    CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,drug_id INTEGER,inventory_id TEXT,quantity_returned REAL,unit_price REAL);
    CREATE TABLE return_items(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id),inventory_id TEXT,quantity_returned REAL,unit_price REAL,sale_item_id INTEGER);
    CREATE TABLE shortages(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id),requested_quantity REAL,notes TEXT);
    CREATE TABLE refill_reminders(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id));
    CREATE TABLE opening_balance_items(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id));
    CREATE TABLE purchase_order_items(id INTEGER PRIMARY KEY,drug_id INTEGER REFERENCES master_drugs(id));
    CREATE TABLE drug_indications(drug_id INTEGER REFERENCES master_drugs(id),indication_id INTEGER,PRIMARY KEY(drug_id,indication_id));
    CREATE TABLE drug_alternatives(drug_id INTEGER REFERENCES master_drugs(id),alternative_id INTEGER REFERENCES master_drugs(id),PRIMARY KEY(drug_id,alternative_id));
    CREATE TABLE activity_log(id INTEGER PRIMARY KEY,details TEXT);
    INSERT INTO master_drugs VALUES
    (1118,'ANDODERMA EXTRA EMOLLIENT GEL 50 ML','ANDODERMA EXTRA EMOLLIENT GEL 50 ML',NULL,'WRONG',352,'wrong','wrong','6223004690259','keep note',1,NULL),
    (1135,'ANDODERMA EXTRA EMOLLIENT GEL 50 ML',NULL,NULL,'CORRECT',130,'skin care','ANDALOUS',NULL,NULL,NULL,NULL),
    (20,'ALPHA 20 TABS',NULL,NULL,'WRONG',99,'wrong','wrong','ALPHA',NULL,2,NULL),
    (21,'ALPHA 20 TABS',NULL,NULL,'A',20,'c','m',NULL,NULL,NULL,NULL);
    INSERT INTO inventory VALUES
    ('old-lot',1118,0,'6223004690259',130,70,1,'2028-01-01','old'),
    ('new-lot',1118,1,'6223004690259',149,99.83,1,'2028-12-21','45751'),
    ('canonical-lot',1135,0.5,NULL,130,88,1,'2029-01-01','other'),
    ('alpha',20,1.25,'ALPHA',99,10,2,'2028-01-01','split');
    INSERT INTO sales_items VALUES(1,1118,'old-lot',1,149);
    INSERT INTO purchase_invoice_items VALUES(1,1118,'new-lot',2,99.83,149);
    INSERT INTO return_items VALUES(1,1118,'old-lot',0.5,149,1);
    INSERT INTO purchase_return_items VALUES(1,1118,'new-lot',0.5,99.83);
    INSERT INTO shortages VALUES(1,1118,3,'old request'),(2,1135,1,'another request');
    INSERT INTO refill_reminders VALUES(1,1118);
    INSERT INTO opening_balance_items VALUES(1,1118);
    INSERT INTO purchase_order_items VALUES(1,1118);
    INSERT INTO activity_log VALUES(1,'Historical drug_id=1118');`);
  db.exec(fs.readFileSync(path.join(__dirname, '../src-tauri/migrations/009_rebuild_master_drugs_fts.sql'), 'utf8'));
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true }); });
  return { db, dir, input, csv };
}

test('copy recovery moves barcode and every reference to correct record without changing lot/history values', async t => {
  const { db, dir, input, csv } = fixture(t);
  db.close(); const bytes = fs.readFileSync(input);
  const output = path.join(dir, 'merged.db');
  const report = await mergeCopy(input, output, csv);
  assert.equal(report.removed, 2); assert.equal(report.skipped.length, 0);
  assert.deepEqual(fs.readFileSync(input), bytes);
  const recovered = new Database(output);
  try {
    assert.equal(recovered.prepare('SELECT COUNT(*) n FROM master_drugs WHERE id=1118').get().n, 0);
    const drug = recovered.prepare('SELECT * FROM master_drugs WHERE id=1135').get();
    assert.equal(drug.barcode, '6223004690259'); assert.equal(drug.notes, 'keep note');
    assert.equal(drug.active_ingredient, 'CORRECT'); assert.equal(drug.official_price, 130);
    const lot = recovered.prepare("SELECT * FROM inventory WHERE id='new-lot'").get();
    assert.equal(lot.drug_id, 1135); assert.equal(lot.quantity, 1); assert.equal(lot.cost_price, 99.83);
    assert.equal(lot.expiry_date, '2028-12-21'); assert.equal(lot.batch_number, '45751');
    assert.equal(lot.local_selling_price, 130);
    assert.equal(recovered.prepare('SELECT SUM(quantity) n FROM inventory WHERE drug_id=1135').get().n, 1.5);
    assert.deepEqual(recovered.prepare('SELECT * FROM sales_items').get(), { id: 1, drug_id: 1135, inventory_id: 'old-lot', quantity_sold: 1, unit_price: 149 });
    assert.equal(recovered.prepare('SELECT unit_price FROM purchase_return_items').get().unit_price, 99.83);
    assert.equal(recovered.prepare('SELECT COUNT(*) n FROM shortages').get().n, 2);
    assert.equal(recovered.prepare('SELECT large_to_medium FROM master_drugs WHERE id=21').get().large_to_medium, 2);
    assert.equal(recovered.prepare('SELECT details FROM activity_log').get().details, 'Historical drug_id=1118');
    assert.deepEqual(recovered.prepare("SELECT rowid FROM master_drugs_fts WHERE master_drugs_fts MATCH 'ANDODERMA'").all(), [{ rowid: 1135 }]);
    const repeat = planMerges(recovered, csv);
    assert.equal(repeat.merge.length, 0); assert.equal(applyMerges(recovered, repeat).removed, 0);
    assert.deepEqual(recovered.pragma('foreign_key_check'), []);
  } finally { recovered.close(); }
  await assert.rejects(mergeCopy(input, output, csv), /new output path/);
});

test('refuses conflicting units used by existing history, distinct barcodes, and custom notes', t => {
  const { db, csv } = fixture(t);
  db.exec("UPDATE master_drugs SET large_to_medium=3 WHERE id=1135; UPDATE master_drugs SET barcode='OTHER',notes='conflicting note' WHERE id=21; UPDATE master_drugs SET notes='original note' WHERE id=20");
  const plan = planMerges(db, csv);
  assert.equal(plan.merge.length, 0); assert.equal(plan.skipped.length, 2);
  assert.ok(plan.skipped.some(g => g.reasons.some(r => r.includes('effective large_to_medium'))));
  assert.ok(plan.skipped.some(g => g.reasons.some(r => r.includes('Multiple master barcodes'))));
  assert.ok(plan.skipped.some(g => g.reasons.some(r => r.includes('notes'))));
});

test('null conversion cannot change effective units on a used canonical record', t => {
  const { db, csv } = fixture(t);
  db.exec("INSERT INTO sales_items VALUES(2,21,NULL,1,10)");
  const plan = planMerges(db, csv);
  assert.ok(plan.skipped.some(g => g.ids.includes(20) && g.reasons.some(r => r.includes('effective large_to_medium'))));
});

test('never merges differing strengths by barcode, ambiguous CSV names, custom names, or association conflicts', t => {
  const { db, csv } = fixture(t);
  db.exec(`INSERT INTO master_drugs(id,trade_name,barcode) VALUES(300,'ALPHA 40 TABS','ALPHA'),(301,'AMBIGUOUS',NULL),(302,'AMBIGUOUS',NULL),(303,'CUSTOM',NULL),(304,'CUSTOM',NULL);
    INSERT INTO drug_alternatives VALUES(1118,300)`);
  const plan = planMerges(db, csv);
  assert.equal(plan.merge.length, 0); assert.equal(plan.skipped.length, 4);
  assert.ok(plan.skipped.some(g => g.reasons.includes('Ambiguous reference name')));
  assert.ok(plan.skipped.some(g => g.reasons.includes('No exact reference name')));
  assert.ok(plan.skipped.some(g => g.reasons.some(r => r.includes('different drug name'))));
});

test('unknown references and pending serialized work fail closed', t => {
  const { db, csv } = fixture(t);
  db.exec('CREATE TABLE unfamiliar(id INTEGER, product_id INTEGER)');
  assert.throws(() => planMerges(db, csv), /Unreviewed reference/);
  db.exec("DROP TABLE unfamiliar; CREATE TABLE draft_cart(payload TEXT); INSERT INTO draft_cart VALUES ('{}')");
  assert.throws(() => planMerges(db, csv), /Pending work/);
});

test('constraint failure rolls back all remapped references and catalog deletions', t => {
  const { db, csv } = fixture(t);
  const plan = planMerges(db, csv);
  db.exec('CREATE UNIQUE INDEX one_shortage_per_drug ON shortages(drug_id)');
  assert.throws(() => applyMerges(db, plan), /UNIQUE constraint/);
  assert.equal(db.prepare("SELECT drug_id FROM inventory WHERE id='new-lot'").get().drug_id, 1118);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM master_drugs').get().n, 4);
});
