const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { repairCopy } = require('./repair-catalog-copy');
const { loadReference } = require('./catalog-reference');

test('CSV repair preserves name/barcode ownership across shifted IDs, duplicates and restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-catalog-test-'));
  const input = path.join(dir, 'original.db');
  const csv = path.join(dir, 'reference.csv');
  let original;
  let repaired;
  try {
    fs.writeFileSync(csv, 'Trade Name,Price,Active Ingredient,Category,Manufacturer\nHIBIOTIC 1 GM 16 TABS.,173,AMOXICILLIN + CLAVULANIC ACID,penicillins,AMOUN\nTEST 10 MG,12,CORRECT,category,"Maker, Ltd"\nAMBIGUOUS,1,A,c,m\nAMBIGUOUS,2,B,c,m\n');
    original = new Database(input);
    original.exec(`CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,generic_name TEXT,active_ingredient TEXT,official_price REAL,category TEXT,manufacturer TEXT,barcode TEXT,notes TEXT);
      CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,quantity REAL,local_selling_price REAL,cost_price REAL,strips_per_box REAL,unit_price REAL);
      CREATE TABLE sales_items(id TEXT PRIMARY KEY,drug_id INTEGER,quantity REAL,unit_price REAL);
      INSERT INTO master_drugs VALUES
        (9719,'HIBIOTIC 1 GM 16 TABS.','HIBIOTIC 1 GM 16 TABS.',NULL,'WRONG',900,'wrong','wrong','6221025022547','keep note'),
        (10345,'HIBIOTIC 1 GM 16 TABS.',NULL,NULL,'AMOXICILLIN + CLAVULANIC ACID',173,'penicillins','AMOUN',NULL,NULL),
        (3,'AMBIGUOUS',NULL,NULL,'KEEP',55,'c','m','AMB','keep'),
        (4,'CUSTOM DRUG',NULL,NULL,'KEEP',99,'c','m','CUSTOM','keep'),
        (5,'  TEST    10 MG  ',NULL,NULL,'WRONG',99,'wrong','wrong','TEST','keep'),
        (6,'TEST 20 MG',NULL,NULL,'KEEP',99,'c','m','OTHER-STRENGTH','keep');
      INSERT INTO inventory VALUES ('lot',9719,1.75,190,100,2,95),('other-lot',10345,1.5,170,90,2,85),('ambiguous-lot',3,1,55,30,1,55),('custom-lot',4,1,99,50,1,99);
      INSERT INTO sales_items VALUES ('sale',9719,0.5,190);`);
    original.exec(fs.readFileSync(path.join(__dirname, '../src-tauri/migrations/009_rebuild_master_drugs_fts.sql'), 'utf8'));
    original.close(); original = null;
    const sourceBytes = fs.readFileSync(input);
    const output = path.join(dir, 'repaired.db');
    const report = await repairCopy(input, output, csv);
    assert.equal(report.changed, 2);
    assert.deepEqual(report.changedByColumn, { official_price: 2, active_ingredient: 2, category: 2, manufacturer: 2 });
    assert.equal(report.unresolvedCount, 3);
    assert.deepEqual(fs.readFileSync(input), sourceBytes);
    repaired = new Database(output);
    assert.equal(repaired.prepare("SELECT value FROM config WHERE key='catalog_reference_repair_version'").get().value, 'csv-catalog-reference-v1');
    assert.equal(repaired.prepare("SELECT value FROM config WHERE key='catalog_name_metadata_repair_version'").get().value, 'csv-catalog-name-metadata-v2');
    assert.equal(repaired.prepare('SELECT active_ingredient FROM master_drugs WHERE id=9719').get().active_ingredient, 'AMOXICILLIN + CLAVULANIC ACID');
    assert.equal(repaired.prepare('SELECT manufacturer FROM master_drugs WHERE id=5').get().manufacturer, 'Maker, Ltd');
    assert.equal(repaired.prepare("SELECT COUNT(*) n FROM master_drugs WHERE trade_name='HIBIOTIC 1 GM 16 TABS.'").get().n, 2);
    assert.deepEqual(repaired.prepare("SELECT rowid FROM master_drugs_fts WHERE master_drugs_fts MATCH 'AMOXICILLIN' ORDER BY rowid").all(), [{ rowid: 9719 }, { rowid: 10345 }]);
    assert.equal(repaired.prepare("SELECT COUNT(*) n FROM master_drugs_fts WHERE master_drugs_fts MATCH 'WRONG' AND rowid=9719").get().n, 0);
    repaired.close(); repaired = null;
    const again = await repairCopy(output, path.join(dir, 'again.db'), csv);
    assert.equal(again.changed, 0);
    const priceOutput = path.join(dir, 'with-pos-prices.db');
    const priced = await repairCopy(input, priceOutput, csv, { updateInventoryPrices: true });
    assert.equal(priced.inventoryPricesChanged, 2);
    assert.deepEqual(fs.readFileSync(input), sourceBytes);
    repaired = new Database(priceOutput);
    assert.equal(repaired.prepare("SELECT value FROM config WHERE key='catalog_inventory_price_repair_version'").get().value, 'csv-inventory-selling-price-v1');
    assert.deepEqual(repaired.prepare("SELECT * FROM inventory WHERE id='lot'").get(), {
      id: 'lot', drug_id: 9719, quantity: 1.75, local_selling_price: 173, cost_price: 100, strips_per_box: 2, unit_price: 95,
    });
    assert.equal(repaired.prepare("SELECT unit_price FROM sales_items WHERE id='sale'").get().unit_price, 190);
    assert.equal(repaired.prepare("SELECT local_selling_price FROM inventory WHERE id='ambiguous-lot'").get().local_selling_price, 55);
    assert.equal(repaired.prepare("SELECT local_selling_price FROM inventory WHERE id='custom-lot'").get().local_selling_price, 99);
    repaired.close(); repaired = null;
    const priceAgain = await repairCopy(priceOutput, path.join(dir, 'prices-again.db'), csv, { updateInventoryPrices: true });
    assert.equal(priceAgain.inventoryPricesChanged, 0);
    await assert.rejects(repairCopy(input, output, csv), /new output path/);
    original = new Database(input);
    original.prepare("INSERT INTO config VALUES ('catalog_reference_repair_version','csv-catalog-reference-v1')").run();
    original.close(); original = null;
    await assert.rejects(repairCopy(input, path.join(dir, 'blocked.db'), csv), /pre-ID-repair backup/);
    fs.writeFileSync(csv, 'Trade Name,Price,Active Ingredient,Category,Manufacturer\nINVALID,not-a-price,A,c,m\n');
    assert.throws(() => loadReference(csv), /Invalid reference name\/price/);
  } finally {
    if (original) original.close();
    if (repaired) repaired.close();
    fs.rmSync(dir, { recursive: true });
  }
});
