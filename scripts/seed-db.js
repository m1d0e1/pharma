#!/usr/bin/env node
/**
 * seed-db.js
 * -----------
 * Seeds pharma_local.db with:
 *   1. master_drugs  — existing catalog enriched by egypt_drugs_drugeye.csv
 *   2. drug_interactions — from db_drug_interactions.csv
 *
 * Usage:
 *   node scripts/seed-db.js                  # uses default path (project root)
 *   node scripts/seed-db.js --dry-run        # count rows only, no writes
 *   node scripts/seed-db.js --dest src-tauri # copies result DB into src-tauri/
 *
 * Idempotent: uses INSERT OR IGNORE, safe to run multiple times.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const BASELINE_DRUGS_CSV = path.join(ROOT, 'egypt_drugs_smart_scrape.csv');
const DRUGS_CSV = path.join(ROOT, 'egypt_drugs_drugeye.csv');
const INTERACTIONS_CSV = path.join(ROOT, 'db_drug_interactions.csv');
const MIGRATIONS_DIR = path.join(ROOT, 'src-tauri', 'migrations');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COPY_DEST = (() => {
  const idx = args.indexOf('--dest');
  if (idx === -1) return null;
  if (!args[idx + 1]) throw new Error('--dest requires a directory');
  const dest = path.resolve(ROOT, args[idx + 1]);
  if (dest !== ROOT && !dest.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error('--dest must stay inside the project directory');
  }
  return dest;
})();
const OUTPUT_DB = COPY_DEST
  ? path.join(COPY_DEST, 'pharma_local.db')
  : path.join(ROOT, 'pharma_local.db');
const DB_PATH = COPY_DEST
  ? path.join(COPY_DEST, '.pharma_local.seed.tmp.db')
  : OUTPUT_DB;

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

/** Parse CSV file into array of row arrays (skips header) */
function parseCsv(filePath, required = false) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Required seed file not found: ${filePath}`);
    console.warn(`  ⚠ Warning: ${path.basename(filePath)} not found. Skipping CSV parse.`);
    return { header: [], rows: [] };
  }
  console.log(`  Reading ${path.basename(filePath)}...`);
  const records = parse(fs.readFileSync(filePath, 'utf8'), {
    bom: true,
    skip_empty_lines: true,
    trim: true,
  });
  const header = records[0] || [];
  console.log(`  Columns: ${header.join(', ')}`);
  const rows = records.slice(1);
  console.log(`  Parsed ${rows.length.toLocaleString()} rows`);
  return { header, rows };
}

function assertColumns(actual, expected, filename) {
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`${filename} columns must be exactly: ${expected.join(', ')}`);
  }
}

const normalizeDrugName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
const drugKey = (name, manufacturer) => `${normalizeDrugName(name)}|${normalizeDrugName(manufacturer)}`;

function mergeDrugCatalog(baselineRows, updateRows) {
  const finalRows = new Map();
  const idsByName = new Map();
  const idsByKey = new Map();
  let nextId = 0;

  for (const row of baselineRows) {
    const [rawId, tradeName, price, activeIngredient, category, manufacturer] = row;
    const id = Number.parseInt(rawId, 10);
    if (!Number.isSafeInteger(id) || id <= 0 || !normalizeDrugName(tradeName)) continue;
    finalRows.set(id, [id, tradeName, price, activeIngredient, category, manufacturer]);
    nextId = Math.max(nextId, id);
    const name = normalizeDrugName(tradeName);
    idsByName.set(name, [...(idsByName.get(name) || []), id]);
    idsByKey.set(drugKey(tradeName, manufacturer), [...(idsByKey.get(drugKey(tradeName, manufacturer)) || []), id]);
  }

  const claimedIds = new Set();
  for (const row of updateRows) {
    const [tradeName, price, activeIngredient, category, manufacturer] = row;
    const name = normalizeDrugName(tradeName);
    if (!name) continue;
    const exact = (idsByKey.get(drugKey(tradeName, manufacturer)) || []).filter(id => !claimedIds.has(id));
    const sameName = (idsByName.get(name) || []).filter(id => !claimedIds.has(id));
    const id = exact.length === 1 ? exact[0] : sameName.length === 1 ? sameName[0] : ++nextId;
    claimedIds.add(id);
    finalRows.set(id, [id, tradeName, price, activeIngredient, category, manufacturer]);
  }

  return [...finalRows.values()].sort((a, b) => a[0] - b[0]);
}

// ─────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────


// ─────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────

console.log('\n╔════════════════════════════════════════╗');
console.log('║   Pharma DB Seeder                    ║');
console.log('╚════════════════════════════════════════╝\n');

if (DRY_RUN) console.log('⚠  DRY RUN mode — no writes will be made\n');

// 1. Parse CSVs first (fail fast before touching DB)
console.log('📂 Parsing CSVs...');
const drugsData = parseCsv(DRUGS_CSV, false);
const baselineDrugsData = parseCsv(BASELINE_DRUGS_CSV, true);
const interactionsData = parseCsv(INTERACTIONS_CSV);
assertColumns(baselineDrugsData.header, ['id', 'Trade Name', 'Price', 'Active Ingredient', 'Category', 'Manufacturer'], path.basename(BASELINE_DRUGS_CSV));
let preparedDrugRows;
if (drugsData.rows.length > 0) {
  assertColumns(drugsData.header, ['Trade Name', 'Price', 'Active Ingredient', 'Category', 'Manufacturer'], path.basename(DRUGS_CSV));
  preparedDrugRows = mergeDrugCatalog(baselineDrugsData.rows, drugsData.rows);
} else {
  preparedDrugRows = baselineDrugsData.rows.map(r => [
    Number.parseInt(r[0], 10), r[1], r[2], r[3], r[4], r[5]
  ]).filter(r => Number.isSafeInteger(r[0]) && r[0] > 0);
}
console.log('');

if (DRY_RUN) {
  console.log('✅ Dry run complete.');
  console.log(`   updated source rows:   ${drugsData.rows.length.toLocaleString()}`);
  console.log(`   preserved + updated:   ${preparedDrugRows.length.toLocaleString()}`);
  console.log(`   drug_interactions rows: ${interactionsData.rows.length.toLocaleString()}`);
  process.exit(0);
}

// 2. Open database
if (COPY_DEST) {
  fs.mkdirSync(COPY_DEST, { recursive: true });
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    fs.rmSync(file, { force: true });
  }
}
console.log(`🗄  Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF'); // speed during bulk insert

// 3. Build schema from the same immutable migrations used by Tauri.
console.log('🔧 Applying schema migrations...');
for (const filename of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
}


// ─────────────────────────────────────────────────
// 4. Import master_drugs
// ─────────────────────────────────────────────────
console.log('\n💊 Importing master_drugs...');

// Prepared columns: id, Trade Name, Price, Active Ingredient, Category, Manufacturer
const existingDrugs = db.prepare('SELECT COUNT(*) as count FROM master_drugs').get();
console.log(`   Existing rows: ${existingDrugs.count.toLocaleString()}`);

const insertDrug = db.prepare(`
  INSERT OR IGNORE INTO master_drugs
    (id, trade_name, official_price, active_ingredient, category, manufacturer, created_at)
  VALUES
    (?, ?, ?, ?, ?, ?, '1970-01-01 00:00:00')
`);

const importDrugs = db.transaction((rows) => {
  let inserted = 0;
  for (const row of rows) {
    const [id, tradeName, price, activeIngredient, category, manufacturer] = row;
    const numId = parseInt(id, 10);
    if (isNaN(numId) || !tradeName) continue;

    const result = insertDrug.run(
      numId,
      tradeName || '',
      parseFloat(price) || 0,
      activeIngredient || '',
      category || '',
      manufacturer || ''
    );
    if (result.changes > 0) inserted++;
  }
  return inserted;
});

const drugsInserted = importDrugs(preparedDrugRows);
const totalDrugs = db.prepare('SELECT COUNT(*) as count FROM master_drugs').get();
console.log(`   ✅ Inserted: ${drugsInserted.toLocaleString()} new rows`);
console.log(`   📊 Total in DB: ${totalDrugs.count.toLocaleString()}`);

// ─────────────────────────────────────────────────
// 5. Import drug_interactions
// ─────────────────────────────────────────────────
console.log('\n⚡ Importing drug_interactions...');

// CSV columns: Drug 1, Drug 2, Interaction Description
const existingInteractions = db.prepare('SELECT COUNT(*) as count FROM drug_interactions').get();
console.log(`   Existing rows: ${existingInteractions.count.toLocaleString()}`);

const insertInteraction = db.prepare(`
  INSERT OR IGNORE INTO drug_interactions
    (ingredient_a, ingredient_b, severity, description_en, recommendation, source)
  VALUES
    (?, ?, ?, ?, ?, 'DrugBank')
`);

/**
 * Extract severity from description text.
 * DrugBank descriptions start with: "<drugA> may <verb>..." = minor/moderate
 * We default everything to 'moderate' since the CSV has no explicit severity.
 */
function extractSeverity(description) {
  const lower = (description || '').toLowerCase();
  if (lower.includes('serious') || lower.includes('toxic') || lower.includes('fatal') || lower.includes('life-threatening')) {
    return 'major';
  }
  if (lower.includes('minor') || lower.includes('slight')) {
    return 'minor';
  }
  return 'moderate';
}

const BATCH_SIZE = 5000;
let totalInserted = 0;
const rows = interactionsData.rows;

console.log(`   Processing ${rows.length.toLocaleString()} rows in batches of ${BATCH_SIZE.toLocaleString()}...`);

for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  const batchInsert = db.transaction((batchRows) => {
    let cnt = 0;
    for (const row of batchRows) {
      const [drugA, drugB, description] = row;
      if (!drugA || !drugB) continue;
      const result = insertInteraction.run(
        drugA.trim(),
        drugB.trim(),
        extractSeverity(description),
        description || '',
        ''
      );
      if (result.changes > 0) cnt++;
    }
    return cnt;
  });
  totalInserted += batchInsert(batch);

  const pct = Math.round(((i + batch.length) / rows.length) * 100);
  process.stdout.write(`\r   Progress: ${pct}% (${(i + batch.length).toLocaleString()} / ${rows.length.toLocaleString()})`);
}

console.log('');
const totalInteractions = db.prepare('SELECT COUNT(*) as count FROM drug_interactions').get();
console.log(`   ✅ Inserted: ${totalInserted.toLocaleString()} new rows`);
console.log(`   📊 Total in DB: ${totalInteractions.count.toLocaleString()}`);

// ─────────────────────────────────────────────────
// 6. Auto-sync categories, scientific groups & manufacturers from master_drugs
// ─────────────────────────────────────────────────
console.log('\n🔄 Syncing categories, scientific groups & manufacturers from master_drugs...');

  const syncCategories = db.prepare(`
    INSERT INTO product_categories (name_ar)
    SELECT DISTINCT 
      UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2))
    FROM master_drugs 
    WHERE category IS NOT NULL 
      AND TRIM(category) != '' 
      AND LENGTH(TRIM(category)) > 2
      AND UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2)) NOT IN (SELECT name_ar FROM product_categories)
  `);
  const catChanges = syncCategories.run();
  console.log(`   Categories synced: ${catChanges.changes} new`);

  const syncGroups = db.prepare(`
    INSERT INTO scientific_groups (name_ar)
    SELECT DISTINCT 
      UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2))
    FROM master_drugs 
    WHERE category IS NOT NULL 
      AND TRIM(category) != '' 
      AND LENGTH(TRIM(category)) > 2
      AND UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2)) NOT IN (SELECT name_ar FROM scientific_groups)
  `);
  const groupChanges = syncGroups.run();
  console.log(`   Scientific groups synced: ${groupChanges.changes} new`);

  const syncManufacturers = db.prepare(`
    INSERT INTO manufacturers (name_ar)
    SELECT DISTINCT 
      UPPER(SUBSTR(TRIM(manufacturer), 1, 1)) || LOWER(SUBSTR(TRIM(manufacturer), 2))
    FROM master_drugs 
    WHERE manufacturer IS NOT NULL 
      AND TRIM(manufacturer) != '' 
      AND LENGTH(TRIM(manufacturer)) > 2
      AND UPPER(SUBSTR(TRIM(manufacturer), 1, 1)) || LOWER(SUBSTR(TRIM(manufacturer), 2)) NOT IN (SELECT name_ar FROM manufacturers)
  `);
const mfgResult = syncManufacturers.run();
console.log(`   Manufacturers synced: ${mfgResult.changes} new`);

// ─────────────────────────────────────────────────
// 7. Finalize
// ─────────────────────────────────────────────────
if (COPY_DEST) {
  const businessTables = [
    'patients', 'inventory', 'sales_invoices', 'sales_items',
    'purchase_invoices', 'purchase_invoice_items', 'returns', 'return_items'
  ];
  const populated = businessTables.filter(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  if (populated.length) throw new Error(`Seed contains business data: ${populated.join(', ')}`);
  const users = db.prepare('SELECT id, username FROM users').all();
  if (users.length !== 1 || users[0].id !== 'admin' || users[0].username !== 'admin') {
    throw new Error('Seed must contain only the default admin user');
  }
}
db.pragma('foreign_keys = ON');
const foreignKeyErrors = db.pragma('foreign_key_check');
if (foreignKeyErrors.length) throw new Error(`Seed foreign-key check failed: ${JSON.stringify(foreignKeyErrors)}`);
if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Seed integrity check failed');
db.exec('ANALYZE');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

console.log('\n✅ Database seeding complete!');

// 8. Publish the isolated build artifact.
if (COPY_DEST) {
  console.log(`\n📦 Publishing DB to ${OUTPUT_DB}...`);
  const previous = `${OUTPUT_DB}.seed.previous`;
  fs.rmSync(previous, { force: true });
  for (const file of [`${OUTPUT_DB}-wal`, `${OUTPUT_DB}-shm`]) {
    fs.rmSync(file, { force: true });
  }
  if (fs.existsSync(OUTPUT_DB)) fs.renameSync(OUTPUT_DB, previous);
  try {
    fs.renameSync(DB_PATH, OUTPUT_DB);
    fs.rmSync(previous, { force: true });
  } catch (error) {
    if (fs.existsSync(previous)) fs.renameSync(previous, OUTPUT_DB);
    throw error;
  } finally {
    for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      fs.rmSync(file, { force: true });
    }
  }
  console.log('   ✅ Done');
}

console.log('\n╔════════════════════════════════════════╗');
console.log('║   Seeding complete! 🎉                ║');
console.log('╚════════════════════════════════════════╝\n');
