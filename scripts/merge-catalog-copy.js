// Offline recovery only: never point this at the live application's output path.
// Keeps a complete source backup and an ID mapping; never sums/recreates stock lots.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { loadReference } = require('./catalog-reference');
const { repairCopy } = require('./repair-catalog-copy');

const ROOT = path.resolve(__dirname, '..');
const normalize = value => String(value ?? '').replace(/[\t\r\n ]+/g, ' ').trim().toUpperCase();
const quote = value => '"' + value.replace(/"/g, '""') + '"';
const metadata = ['official_price', 'active_ingredient', 'category', 'manufacturer'];
// Explicitly reviewed foreign AND non-foreign-key references. Unknown references stop recovery.
const references = {
  inventory: ['drug_id'], sales_items: ['drug_id'], refill_reminders: ['drug_id'],
  return_items: ['drug_id'], purchase_invoice_items: ['drug_id'], purchase_order_items: ['drug_id'],
  purchase_return_items: ['drug_id'], opening_balance_items: ['drug_id'], shortages: ['drug_id'],
  drug_indications: ['drug_id'], drug_alternatives: ['drug_id', 'alternative_id'],
};
const derived = name => name.startsWith('master_drugs_fts') || name === 'cloud_drug_mappings';
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
const hashRows = rows => crypto.createHash('sha256').update(rows.map(r => JSON.stringify(r)).sort().join('\n')).digest('hex');

function verifySchema(db) {
  for (const name of tables(db)) {
    if (derived(name)) continue;
    const allowed = references[name] || [];
    for (const column of db.pragma(`table_info(${quote(name)})`)) {
      if (/^(drug_id|alternative_id|local_drug_id|product_id)$/.test(column.name) && !allowed.includes(column.name)) {
        throw new Error(`Unreviewed reference: ${name}.${column.name}`);
      }
    }
    for (const fk of db.pragma(`foreign_key_list(${quote(name)})`)) {
      if (fk.table === 'master_drugs' && (!allowed.includes(fk.from) || fk.to !== 'id')) {
        throw new Error(`Unreviewed foreign key: ${name}.${fk.from}`);
      }
    }
    // Serialized pending work needs an application-specific remapper, not a text replacement.
    if (/queue|outbox|draft|suspend/i.test(name) && db.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get()) {
      throw new Error(`Pending work in ${name}; finish/review it before merging IDs`);
    }
  }
}

function planMerges(db, csv) {
  verifySchema(db);
  const groups = new Map(), reference = new Map(), namesById = new Map(), barcodeOwners = new Map();
  const existingTables = new Set(tables(db)), usedIds = new Set();
  for (const [table, columns] of Object.entries(references)) {
    if (!existingTables.has(table)) continue;
    for (const column of columns) for (const row of db.prepare(`SELECT DISTINCT ${quote(column)} id FROM ${quote(table)}`).all()) usedIds.add(row.id);
  }
  for (const row of loadReference(csv)) reference.set(normalize(row[0]), [...(reference.get(normalize(row[0])) || []), row]);
  for (const drug of db.prepare('SELECT * FROM master_drugs ORDER BY id').all()) {
    const name = normalize(drug.trade_name);
    groups.set(name, [...(groups.get(name) || []), drug]); namesById.set(drug.id, name);
  }
  for (const row of db.prepare('SELECT id AS drug_id,barcode FROM master_drugs UNION SELECT drug_id,barcode FROM inventory').all()) {
    if (normalize(row.barcode)) barcodeOwners.set(normalize(row.barcode), new Set([...(barcodeOwners.get(normalize(row.barcode)) || []), namesById.get(row.drug_id)]));
  }
  const merge = [], skipped = [];
  for (const [name, drugs] of groups) {
    if (drugs.length < 2) continue;
    const reasons = [], ref = reference.get(name);
    if (ref?.length !== 1) reasons.push(ref ? 'Ambiguous reference name' : 'No exact reference name');
    const barcodes = [...new Set(drugs.map(d => d.barcode).filter(b => b != null && b !== ''))];
    if (barcodes.length > 1) reasons.push('Multiple master barcodes: needs verified alias mapping');
    const ids = new Set(drugs.map(d => d.id));
    const lotBarcodes = db.prepare(`SELECT barcode FROM inventory WHERE drug_id IN (${drugs.map(() => '?').join(',')})`).all(...ids).map(r => r.barcode);
    if ([...barcodes, ...lotBarcodes].some(b => (barcodeOwners.get(normalize(b))?.size || 0) > 1)) reasons.push('Barcode also identifies a different drug name/strength/pack');
    // Historical returns sometimes fall back to master conversion factors. Do not change these.
    for (const field of ['large_to_medium', 'medium_to_small']) {
      const explicit = drugs.map(d => d[field]).find(v => v != null && v !== '');
      const targetFactor = Number(explicit) > 0 ? Number(explicit) : 1;
      if (drugs.some(d => usedIds.has(d.id) && (Number(d[field]) > 0 ? Number(d[field]) : 1) !== targetFactor)) reasons.push(`Different effective ${field} for existing stock/history`);
    }
    const ignored = new Set(['id', 'trade_name', 'barcode', 'created_at', ...metadata]);
    for (const field of Object.keys(drugs[0]).filter(k => !ignored.has(k))) {
      const values = new Set(drugs.map(d => d[field]).filter(v => v != null && v !== ''));
      if (values.size > 1) reasons.push(`Conflicting preserved field: ${field}`);
    }
    // Association collisions require a separate business decision; never DELETE OR IGNORE history.
    for (const table of ['drug_indications', 'drug_alternatives']) {
      if (tables(db).includes(table) && db.prepare(`SELECT 1 FROM ${table} WHERE drug_id IN (${drugs.map(() => '?').join(',')}) ${table === 'drug_alternatives' ? `OR alternative_id IN (${drugs.map(() => '?').join(',')})` : ''} LIMIT 1`).get(...ids, ...(table === 'drug_alternatives' ? ids : []))) {
        reasons.push(`Existing ${table} associations require review`);
      }
    }
    if (reasons.length) { skipped.push({ name, ids: [...ids], reasons }); continue; }
    // Prefer the already-correct record requested by the user. Otherwise correct first,
    // then keep a deterministic record; IDs themselves never establish drug identity.
    const score = drug => metadata.filter((field, index) => drug[field] === ref[0][index + 1]).length;
    const canonical = [...drugs].sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
    const preserved = {};
    for (const field of Object.keys(canonical).filter(k => !ignored.has(k))) {
      if (canonical[field] == null || canonical[field] === '') {
        const value = drugs.map(d => d[field]).find(v => v != null && v !== '');
        if (value !== undefined) preserved[field] = value;
      }
    }
    if (!canonical.barcode && barcodes.length) preserved.barcode = barcodes[0];
    merge.push({ name, canonicalId: canonical.id, removedIds: drugs.filter(d => d.id !== canonical.id).map(d => d.id), preserved, originalRecords: drugs });
  }
  return { merge, skipped };
}

function snapshot(db, idMap = new Map()) {
  const result = {};
  for (const table of tables(db)) {
    if (table === 'master_drugs' || table === 'config' || derived(table)) continue;
    const rows = db.prepare(`SELECT * FROM ${quote(table)}`).all();
    for (const row of rows) for (const field of references[table] || []) row[field] = idMap.get(row[field]) ?? row[field];
    result[table] = { count: rows.length, hash: hashRows(rows) };
  }
  return result;
}

function applyMerges(db, plan) {
  verifySchema(db);
  const idMap = new Map(plan.merge.flatMap(g => g.removedIds.map(id => [id, g.canonicalId])));
  const expected = snapshot(db, idMap);
  const original = new Map(db.prepare('SELECT * FROM master_drugs').all().map(r => [r.id, r]));
  const expectedMasters = new Map([...original].filter(([id]) => !idMap.has(id)));
  for (const g of plan.merge) expectedMasters.set(g.canonicalId, { ...expectedMasters.get(g.canonicalId), ...g.preserved });
  const remapped = {};
  db.pragma('foreign_keys = ON');
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'Repair requires a valid starting database');
  db.transaction(() => {
    for (const [table, columns] of Object.entries(references)) {
      if (!tables(db).includes(table)) continue;
      for (const column of columns) {
        const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE ${quote(column)}=?`);
        let changed = 0;
        for (const [from, to] of idMap) changed += update.run(to, from).changes;
        remapped[`${table}.${column}`] = changed;
      }
    }
    for (const group of plan.merge) {
      for (const [field, value] of Object.entries(group.preserved)) db.prepare(`UPDATE master_drugs SET ${quote(field)}=? WHERE id=?`).run(value, group.canonicalId);
      for (const id of group.removedIds) assert.equal(db.prepare('DELETE FROM master_drugs WHERE id=?').run(id).changes, 1);
    }
    if (idMap.size && tables(db).includes('cloud_drug_mappings')) db.exec('DELETE FROM cloud_drug_mappings');
    assert.deepEqual(snapshot(db), expected, 'A stock lot or business field changed beyond its approved drug ID');
    assert.equal(hashRows(db.prepare('SELECT * FROM master_drugs').all()), hashRows([...expectedMasters.values()]), 'Unexpected catalog change');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check').map(r => r.integrity_check), ['ok']);
    if (tables(db).includes('master_drugs_fts')) db.exec("INSERT INTO master_drugs_fts(master_drugs_fts,rank) VALUES('integrity-check',1)");
    for (const [table, columns] of Object.entries(references)) {
      if (!tables(db).includes(table)) continue;
      for (const column of columns) {
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${quote(table)} r LEFT JOIN master_drugs d ON d.id=r.${quote(column)} WHERE r.${quote(column)} IS NOT NULL AND d.id IS NULL`).get().n, 0, `Dangling ${table}.${column}`);
      }
    }
  })();
  return { removed: idMap.size, groups: plan.merge.length, remapped, preservedTables: expected };
}

async function mergeCopy(input, output, csv = path.join(ROOT, 'egypt_drugs_drugeye.csv')) {
  input = path.resolve(input); output = path.resolve(output);
  if (input === output || fs.existsSync(output) || fs.existsSync(output + '.partial') || fs.existsSync(output + '.report.json') || fs.existsSync(output + '.recovery')) throw new Error('A new output path is required');
  const directory = output + '.recovery'; fs.mkdirSync(directory);
  const backup = path.join(directory, 'original.db'), staged = path.join(directory, 'corrected.db');
  const source = new Database(input, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(source.pragma('integrity_check').map(r => r.integrity_check), ['ok']); await source.backup(backup); }
  finally { source.close(); }
  const before = new Database(backup, { readonly: true });
  let plan;
  try { plan = planMerges(before, csv); } finally { before.close(); }
  // Explicitly retains the user's earlier choice to update current POS selling prices too.
  const correction = await repairCopy(backup, staged, csv, { updateInventoryPrices: true });
  const db = new Database(staged);
  let result;
  try {
    result = applyMerges(db, plan);
    db.prepare("INSERT INTO config(key,value) VALUES ('catalog_csv_repair_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`اكتمل التصحيح المحلي ودمج ${result.groups} مجموعة مكررة (${result.removed} سجل). تم الاحتفاظ بكل دفعات المخزون والكميات والتكاليف والفواتير. ${plan.skipped.length} مجموعة تحتاج مراجعة.`);
    // The old path belongs to the originating computer; it is not a backup of this repaired copy.
    db.prepare("DELETE FROM config WHERE key='catalog_csv_repair_backup_path'").run();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const report = { input, output, backup, reference: csv, referenceSha256: correction.referenceSha256,
    metadataChanges: correction.changed, inventoryPriceChanges: correction.inventoryPricesChanged,
    ...result, merges: plan.merge, skipped: plan.skipped, metadataUnresolved: correction.unresolved };
  const fd = fs.openSync(staged, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.copyFileSync(staged, output + '.partial', fs.constants.COPYFILE_EXCL);
  const copied = fs.openSync(output + '.partial', 'r+'); try { fs.fsyncSync(copied); } finally { fs.closeSync(copied); }
  assert.deepEqual(fs.readFileSync(output + '.partial'), fs.readFileSync(staged));
  fs.writeFileSync(output + '.report.json', JSON.stringify(report, null, 2), { flag: 'wx' });
  // Publish complete bytes atomically and exclusively; a rename can replace an
  // unrelated file created during recovery. Both paths are on the same volume.
  fs.linkSync(output + '.partial', output);
  fs.unlinkSync(output + '.partial');
  console.log(JSON.stringify({ output, removed: result.removed, mergedGroups: result.groups, skippedGroups: plan.skipped.length, integrity: 'ok' }));
  return report;
}

module.exports = { planMerges, applyMerges, mergeCopy };
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4) throw new Error('Usage: node scripts/merge-catalog-copy.js INPUT.db NEW_OUTPUT.db');
  mergeCopy(input, output).catch(error => { console.error(error); process.exitCode = 1; });
}
