#!/usr/bin/env node
/**
 * seed-db.js
 * -----------
 * Seeds pharma_local.db with:
 *   1. master_drugs  — from egypt_drugs_database_full.csv
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

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'pharma_local.db');
const DRUGS_CSV = path.join(ROOT, 'egypt_drugs_database_full.csv');
const INTERACTIONS_CSV = path.join(ROOT, 'db_drug_interactions.csv');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const COPY_DEST = (() => {
  const idx = args.indexOf('--dest');
  return idx !== -1 ? path.join(ROOT, args[idx + 1]) : null;
})();

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

/** Parse a simple CSV line respecting quoted fields */
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

/** Parse CSV file into array of row arrays (skips header) */
function parseCsv(filePath) {
  console.log(`  Reading ${path.basename(filePath)}...`);
  const content = fs.readFileSync(filePath, 'utf8');
  // Remove BOM if present
  const cleaned = content.replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  console.log(`  Columns: ${header.join(', ')}`);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    rows.push(parseCsvLine(line));
  }
  console.log(`  Parsed ${rows.length.toLocaleString()} rows`);
  return { header, rows };
}

// ─────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────

console.log('\n╔════════════════════════════════════════╗');
console.log('║   Pharma DB Seeder                    ║');
console.log('╚════════════════════════════════════════╝\n');

if (DRY_RUN) console.log('⚠  DRY RUN mode — no writes will be made\n');

// 1. Parse CSVs first (fail fast before touching DB)
console.log('📂 Parsing CSVs...');
const drugsData = parseCsv(DRUGS_CSV);
const interactionsData = parseCsv(INTERACTIONS_CSV);
console.log('');

if (DRY_RUN) {
  console.log('✅ Dry run complete.');
  console.log(`   master_drugs rows:     ${drugsData.rows.length.toLocaleString()}`);
  console.log(`   drug_interactions rows: ${interactionsData.rows.length.toLocaleString()}`);
  process.exit(0);
}

// 2. Open database
console.log(`🗄  Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF'); // speed during bulk insert

// 3. Ensure tables exist
console.log('🔧 Ensuring tables exist...');
db.exec(`
  CREATE TABLE IF NOT EXISTS master_drugs (
    id INTEGER PRIMARY KEY,
    trade_name TEXT NOT NULL,
    trade_name_en TEXT,
    generic_name TEXT,
    active_ingredient TEXT,
    barcode TEXT,
    official_price REAL DEFAULT 0,
    category TEXT,
    manufacturer TEXT,
    is_medicine INTEGER DEFAULT 1,
    is_service INTEGER DEFAULT 0,
    is_refrigerated INTEGER DEFAULT 0,
    is_chronic INTEGER DEFAULT 0,
    has_expiry INTEGER DEFAULT 1,
    no_return INTEGER DEFAULT 0,
    origin TEXT,
    notes TEXT,
    large_unit TEXT,
    small_unit TEXT,
    medium_unit TEXT,
    large_to_medium INTEGER,
    medium_to_small INTEGER,
    min_limit INTEGER,
    max_limit INTEGER,
    reorder_point INTEGER,
    default_purchase_qty INTEGER,
    prevent_fractions INTEGER DEFAULT 0,
    tax_percent REAL DEFAULT 0,
    discount_percent REAL DEFAULT 0,
    stop_dealing INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS drug_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient_a TEXT NOT NULL COLLATE NOCASE,
    ingredient_b TEXT NOT NULL COLLATE NOCASE,
    severity TEXT NOT NULL DEFAULT 'moderate',
    description_ar TEXT,
    description_en TEXT,
    recommendation TEXT,
    source TEXT DEFAULT 'DrugBank'
  );
`);

// Ensure unique index exists BEFORE any inserts (required for INSERT OR IGNORE dedup)
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uidx_interactions ON drug_interactions(ingredient_a, ingredient_b)');
} catch (e) {
  console.warn('  Note: could not create uidx_interactions:', e.message);
}


// ─────────────────────────────────────────────────
// 4. Import master_drugs
// ─────────────────────────────────────────────────
console.log('\n💊 Importing master_drugs...');

// CSV columns: id, Trade Name, Price, Active Ingredient, Category, Manufacturer
const existingDrugs = db.prepare('SELECT COUNT(*) as count FROM master_drugs').get();
console.log(`   Existing rows: ${existingDrugs.count.toLocaleString()}`);

const insertDrug = db.prepare(`
  INSERT OR IGNORE INTO master_drugs
    (id, trade_name, official_price, active_ingredient, category, manufacturer)
  VALUES
    (?, ?, ?, ?, ?, ?)
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

const drugsInserted = importDrugs(drugsData.rows);
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

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS product_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    name_ar TEXT NOT NULL,
    name_en TEXT,
    FOREIGN KEY (parent_id) REFERENCES product_categories (id)
  );
  CREATE TABLE IF NOT EXISTS scientific_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_ar TEXT NOT NULL,
    name_en TEXT
  );
  CREATE TABLE IF NOT EXISTS manufacturers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_ar TEXT NOT NULL,
    name_en TEXT
  );
`);

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
db.pragma('foreign_keys = ON');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

console.log('\n✅ Database seeding complete!');

// 7. Optionally copy to destination
if (COPY_DEST) {
  const destPath = path.join(COPY_DEST, 'pharma_local.db');
  console.log(`\n📦 Copying DB to ${destPath}...`);
  fs.mkdirSync(COPY_DEST, { recursive: true });
  fs.copyFileSync(DB_PATH, destPath);
  console.log('   ✅ Done');
}

console.log('\n╔════════════════════════════════════════╗');
console.log('║   Seeding complete! 🎉                ║');
console.log('╚════════════════════════════════════════╝\n');
