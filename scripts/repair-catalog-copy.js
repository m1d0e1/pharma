// Never changes the input. Usage: node scripts/repair-catalog-copy.js INPUT.db NEW_OUTPUT.db [--inventory-prices]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { loadReference, installReference } = require('./catalog-reference');
const ROOT = path.resolve(__dirname, '..');
const VERSION = 'csv-catalog-name-metadata-v2';
const fields = new Set(['official_price', 'active_ingredient', 'category', 'manufacturer']);
const normalizeName = value => String(value ?? '').replace(/[\t\r\n ]+/g, ' ').trim().toUpperCase();

function fingerprints(db, updateInventoryPrices = false) {
  const result = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    // FTS is a derived search index; changing ingredients must update it.
    if (['config', 'cloud_drug_mappings'].includes(name) || name.startsWith('master_drugs_fts')) continue;
    const quote = value => '"' + value.replace(/"/g, '""') + '"';
    const columns = db.pragma(`table_info(${quote(name)})`).map(row => row.name)
      .filter(column => (name !== 'master_drugs' || !fields.has(column))
        && !(updateInventoryPrices && name === 'inventory' && column === 'local_selling_price'));
    const rows = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)}`).all()
      .map(row => JSON.stringify(row)).sort();
    result[name] = { count: rows.length, hash: crypto.createHash('sha256').update(rows.join('\n')).digest('hex') };
  }
  return result;
}

async function repairCopy(input, output, csv = path.join(ROOT, 'egypt_drugs_drugeye.csv'), { updateInventoryPrices = false } = {}) {
  input = path.resolve(input); output = path.resolve(output);
  if (input === output || fs.existsSync(output) || fs.existsSync(output + '.partial') || fs.existsSync(output + '.report.json')) throw new Error('A new output path is required');
  const rows = loadReference(csv);
  const source = new Database(input, { readonly: true, fileMustExist: true });
  let db;
  try {
    assert.deepEqual(source.pragma('integrity_check').map(row => row.integrity_check), ['ok']);
    const before = fingerprints(source, updateInventoryPrices);
    const fkBefore = source.pragma('foreign_key_check');
    const configBefore = source.prepare('SELECT key,value FROM config ORDER BY key').all();
    if (!configBefore.some(row => row.key === 'catalog_name_metadata_repair_version' && row.value === VERSION)
      && configBefore.some(row => row.key === 'catalog_reference_repair_version' && row.value === 'csv-catalog-reference-v1')) {
      throw new Error('Use the pre-ID-repair backup: original drug names may already have been overwritten');
    }
    await source.backup(output + '.partial');
    db = new Database(output + '.partial');
    db.prepare("ATTACH DATABASE ':memory:' AS bundled_catalog").run();
    // Install the same five-column source used by the release seed generator.
    const reference = new Database(':memory:');
    try {
      installReference(reference, rows);
      db.exec('CREATE TABLE bundled_catalog.catalog_csv_reference AS SELECT trade_name,official_price,active_ingredient,category,manufacturer FROM master_drugs WHERE 0');
      const insert = db.prepare('INSERT INTO bundled_catalog.catalog_csv_reference VALUES (?,?,?,?,?)');
      db.transaction(() => { for (const row of reference.prepare('SELECT * FROM catalog_csv_reference').all()) insert.run(row.trade_name,row.official_price,row.active_ingredient,row.category,row.manufacturer); })();
    } finally { reference.close(); }
    const referenceGroups = new Map();
    for (const row of rows) {
      const name = normalizeName(row[0]);
      referenceGroups.set(name, [...(referenceGroups.get(name) || []), row]);
    }
    const unresolved = db.prepare('SELECT id,trade_name FROM master_drugs ORDER BY id').all()
      .filter(row => referenceGroups.get(normalizeName(row.trade_name))?.length !== 1)
      .map(row => ({ ...row, reason: referenceGroups.has(normalizeName(row.trade_name)) ? 'ambiguous CSV name' : 'no exact CSV name' }));
    const changes = [];
    const inventoryPriceChanges = [];
    const beforeInventory = new Map(source.prepare('SELECT id,drug_id,local_selling_price FROM inventory').all().map(row => [row.id, row]));
    const beforeDrugs = new Map(source.prepare('SELECT * FROM master_drugs').all().map(row => [row.id, row]));
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='master_drugs_fts'").get()) {
        db.exec(fs.readFileSync(path.join(ROOT, 'src-tauri/migrations/009_rebuild_master_drugs_fts.sql'), 'utf8'));
      }
      db.exec(fs.readFileSync(path.join(ROOT, 'src-tauri/src/catalog_metadata_repair.sql'), 'utf8'));
      const changed = db.prepare('SELECT changes() n').get().n;
      if (updateInventoryPrices) {
        db.exec(fs.readFileSync(path.join(ROOT, 'src-tauri/src/catalog_inventory_price_repair.sql'), 'utf8'));
      }
      db.exec('DROP TABLE catalog_repair_reference; DROP TABLE catalog_repair_names;');
      if (changed && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_drug_mappings'").get()) db.exec('DELETE FROM cloud_drug_mappings');
      db.prepare("INSERT INTO config(key,value) VALUES ('catalog_name_metadata_repair_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(VERSION);
      db.prepare("INSERT INTO config(key,value) VALUES ('catalog_reference_repair_version','csv-catalog-reference-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      if (updateInventoryPrices) {
        db.prepare("INSERT INTO config(key,value) VALUES ('catalog_inventory_price_repair_version','csv-inventory-selling-price-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      }
      assert.deepEqual(fingerprints(db, updateInventoryPrices), before, 'Stock, barcodes, names or business records changed');
      assert.deepEqual(db.pragma('foreign_key_check'), fkBefore);
      assert.deepEqual(db.pragma('integrity_check').map(row => row.integrity_check), ['ok']);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='master_drugs_fts'").get()) {
        db.exec("INSERT INTO master_drugs_fts(master_drugs_fts, rank) VALUES('integrity-check', 1)");
      }
      for (const row of db.prepare('SELECT * FROM master_drugs').all()) {
        const referenceRows = referenceGroups.get(normalizeName(row.trade_name));
        if (referenceRows?.length === 1) {
          assert.deepEqual([...fields].map(field => row[field]), referenceRows[0].slice(1),
            `CSV metadata mismatch for drug ${row.id}`);
        }
        const old = beforeDrugs.get(row.id);
        const updated = [...fields].filter(field => old[field] !== row[field]);
        if (updated.length) changes.push({ id: row.id, trade_name: row.trade_name, fields: Object.fromEntries(updated.map(field => [field, { before: old[field], after: row[field] }])) });
      }
      assert.equal(changes.length, changed);
      for (const row of db.prepare('SELECT i.id,i.drug_id,i.local_selling_price,d.trade_name FROM inventory i JOIN master_drugs d ON d.id=i.drug_id').all()) {
        const old = beforeInventory.get(row.id);
        const referenceRows = referenceGroups.get(normalizeName(row.trade_name));
        if (updateInventoryPrices && referenceRows?.length === 1) {
          assert.equal(row.local_selling_price, referenceRows[0][1], `CSV selling price mismatch for lot ${row.id}`);
        }
        if (old.local_selling_price !== row.local_selling_price) {
          assert.ok(updateInventoryPrices && referenceRows?.length === 1, 'Unapproved inventory price change');
          inventoryPriceChanges.push({ id: row.id, drug_id: row.drug_id, trade_name: row.trade_name, before: old.local_selling_price, after: row.local_selling_price });
        }
      }
    })();
    db.exec('DETACH DATABASE bundled_catalog');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close(); db = null;
    const descriptor = fs.openSync(output + '.partial', 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(output + '.partial', output);
    const changedByColumn = Object.fromEntries([...fields].map(field => [field, changes.filter(row => Object.hasOwn(row.fields, field)).length]));
    const report = { output, reference: csv, referenceSha256: crypto.createHash('sha256').update(fs.readFileSync(csv)).digest('hex'), changed: changes.length, changedByColumn, updateInventoryPrices, inventoryPricesChanged: inventoryPriceChanges.length, inventoryPriceChanges, unresolvedCount: unresolved.length, preservedTables: before, changes, unresolved };
    fs.writeFileSync(output + '.report.json', JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ output, changed: changes.length, inventoryPricesChanged: inventoryPriceChanges.length, unresolved: unresolved.length, integrity: 'ok', preservedTables: Object.keys(before).length }));
    return report;
  } finally { if (db) db.close(); source.close(); }
}

module.exports = { repairCopy, fingerprints };
if (require.main === module) {
  const [input, output, option] = process.argv.slice(2);
  if (!input || !output || (option && option !== '--inventory-prices')) throw new Error('Usage: node scripts/repair-catalog-copy.js INPUT.db NEW_OUTPUT.db [--inventory-prices]');
  repairCopy(input, output, undefined, { updateInventoryPrices: option === '--inventory-prices' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
