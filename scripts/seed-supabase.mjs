/**
 * Seed Supabase with drugs and interactions from local CSVs.
 * 
 * Usage:
 *   1. Set SUPABASE_SERVICE_ROLE_KEY env var (from Supabase Dashboard > Settings > API)
 *   2. node scripts/seed-supabase.mjs
 * 
 * This script:
 *   - Creates `cloud_drugs` and `cloud_drug_interactions` tables if they don't exist
 *   - Parses the CSV files
 *   - Uploads in batches of 500
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// --- Config ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ntaaxbjeoqyetrmxyktf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!SERVICE_KEY && !DRY_RUN) {
  console.error('❌ Set SUPABASE_SERVICE_ROLE_KEY env var first.');
  console.error('   Find it at: Supabase Dashboard > Settings > API > service_role');
  process.exit(1);
}

const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// --- CSV Parser (no dependency) ---
function parseCSV(text) {
  const records = parse(text, { bom: true, columns: true, skip_empty_lines: true, trim: true });
  return { headers: records.length ? Object.keys(records[0]) : [], rows: records };
}

const normalizeDrugName = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
const drugKey = (name, manufacturer) => `${normalizeDrugName(name)}|${normalizeDrugName(manufacturer)}`;

function reconcileDrugIds(rows, existingRows) {
  const byName = new Map();
  const byKey = new Map();
  let nextId = 0;
  for (const drug of existingRows) {
    const id = Number(drug.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    nextId = Math.max(nextId, id);
    const name = normalizeDrugName(drug.trade_name);
    byName.set(name, [...(byName.get(name) || []), id]);
    const key = drugKey(drug.trade_name, drug.manufacturer);
    byKey.set(key, [...(byKey.get(key) || []), id]);
  }

  const claimed = new Set();
  return rows.map(row => {
    const tradeName = String(row['Trade Name'] || '').trim();
    if (!tradeName) return null;
    const exact = (byKey.get(drugKey(tradeName, row['Manufacturer'])) || []).filter(id => !claimed.has(id));
    const sameName = (byName.get(normalizeDrugName(tradeName)) || []).filter(id => !claimed.has(id));
    const id = exact.length === 1 ? exact[0] : sameName.length === 1 ? sameName[0] : ++nextId;
    claimed.add(id);
    const price = Number(row['Price']);
    return {
      id,
      trade_name: tradeName,
      price: Number.isFinite(price) && price >= 0 ? price : 0,
      active_ingredient: String(row['Active Ingredient'] || '').trim() || null,
      category: String(row['Category'] || '').trim() || null,
      manufacturer: String(row['Manufacturer'] || '').trim() || null,
    };
  }).filter(Boolean);
}

async function fetchAllCloudDrugs() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('cloud_drugs')
      .select('id,trade_name,manufacturer').order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`Cannot read existing cloud drug IDs: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

// --- Create tables via SQL ---
async function createTables() {
  console.log('📦 Creating Supabase tables...');

  // cloud_drugs — matches egypt_drugs_database_full.csv structure
  const { error: e1 } = await supabase.rpc('exec_sql', { query: `
    CREATE TABLE IF NOT EXISTS cloud_drugs (
      id INTEGER PRIMARY KEY,
      trade_name TEXT NOT NULL,
      price REAL DEFAULT 0,
      active_ingredient TEXT,
      category TEXT,
      manufacturer TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Auto-update updated_at on row change
    CREATE OR REPLACE FUNCTION update_cloud_drugs_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_cloud_drugs_updated_at ON cloud_drugs;
    CREATE TRIGGER trg_cloud_drugs_updated_at
      BEFORE UPDATE ON cloud_drugs
      FOR EACH ROW EXECUTE FUNCTION update_cloud_drugs_updated_at();
  `});

  if (e1) {
    console.log('⚠️  cloud_drugs table creation via RPC failed, trying direct SQL...');
    // Fallback: use the REST API to check if table exists by querying it
    const { error: checkErr } = await supabase.from('cloud_drugs').select('id').limit(1);
    if (checkErr && (checkErr.code === '42P01' || checkErr.code === 'PGRST204')) {
      console.error('❌ Table cloud_drugs does not exist.');
      console.error('   Please run the following SQL in your Supabase SQL Editor:');
      console.error(`
CREATE TABLE cloud_drugs (
  id INTEGER PRIMARY KEY,
  trade_name TEXT NOT NULL,
  price REAL DEFAULT 0,
  active_ingredient TEXT,
  category TEXT,
  manufacturer TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE cloud_drug_interactions (
  id SERIAL PRIMARY KEY,
  drug_1 TEXT NOT NULL,
  drug_2 TEXT NOT NULL,
  interaction_description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
      `);
      process.exit(1);
    } else if (checkErr) {
      console.error('❌ Unexpected error checking cloud_drugs:', checkErr);
      process.exit(1);
    } else {
      console.log('✅ cloud_drugs table already exists');
    }
  } else {
    console.log('✅ cloud_drugs table ready');
  }

  // cloud_drug_interactions — matches db_drug_interactions.csv structure
  const { error: e2 } = await supabase.rpc('exec_sql', { query: `
    CREATE TABLE IF NOT EXISTS cloud_drug_interactions (
      id SERIAL PRIMARY KEY,
      drug_1 TEXT NOT NULL,
      drug_2 TEXT NOT NULL,
      interaction_description TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uidx_cloud_interactions 
      ON cloud_drug_interactions(drug_1, drug_2);

    CREATE OR REPLACE FUNCTION update_cloud_interactions_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_cloud_interactions_updated_at ON cloud_drug_interactions;
    CREATE TRIGGER trg_cloud_interactions_updated_at
      BEFORE UPDATE ON cloud_drug_interactions
      FOR EACH ROW EXECUTE FUNCTION update_cloud_interactions_updated_at();
  `});

  if (e2) {
    const { error: checkErr2 } = await supabase.from('cloud_drug_interactions').select('id').limit(1);
    if (checkErr2 && (checkErr2.code === '42P01' || checkErr2.code === 'PGRST204')) {
      console.error('❌ cloud_drug_interactions table does not exist. Create it manually (SQL above).');
      process.exit(1);
    } else if (checkErr2) {
      console.error('❌ Unexpected error checking interactions:', checkErr2);
      process.exit(1);
    }
    console.log('✅ cloud_drug_interactions table already exists');
  } else {
    console.log('✅ cloud_drug_interactions table ready');
  }
}

// --- Batch upsert ---
async function batchUpsert(table, rows, conflictCol, batchSize = 500) {
  console.log(`⬆️  Uploading ${rows.length} rows to ${table}...`);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: conflictCol, ignoreDuplicates: false });
    
    if (error) {
      console.error(`❌ Batch ${Math.floor(i / batchSize) + 1} failed:`, error.message);
      // Continue with next batch
    } else {
      inserted += batch.length;
    }
    
    if ((i + batchSize) % 5000 === 0 || i + batchSize >= rows.length) {
      console.log(`   ${Math.min(i + batchSize, rows.length)} / ${rows.length}`);
    }
  }
  console.log(`✅ ${inserted} rows uploaded to ${table}`);
}

// --- Main ---
async function main() {
  // Try to create tables (will fallback gracefully if RPC not available)
  if (!DRY_RUN) await createTables();

  // 1. Drugs
  console.log('\n📋 Parsing egypt_drugs_drugeye.csv...');
  const drugsCSV = readFileSync(resolve(ROOT, 'egypt_drugs_drugeye.csv'), 'utf-8');
  const { rows: drugRows } = parseCSV(drugsCSV);
  const expectedColumns = ['Trade Name', 'Price', 'Active Ingredient', 'Category', 'Manufacturer'];
  const actualColumns = drugRows.length ? Object.keys(drugRows[0]) : [];
  if (actualColumns.join('\0') !== expectedColumns.join('\0')) {
    throw new Error(`egypt_drugs_drugeye.csv columns must be exactly: ${expectedColumns.join(', ')}`);
  }

  const baseline = parseCSV(readFileSync(resolve(ROOT, 'egypt_drugs_smart_scrape.csv'), 'utf-8')).rows
    .map(row => ({
      id: Number(row.id),
      trade_name: row['Trade Name'],
      manufacturer: row['Manufacturer'],
    }));
  const existing = DRY_RUN ? baseline : await fetchAllCloudDrugs();
  const drugs = reconcileDrugIds(drugRows, existing.length ? existing : baseline);

  console.log(`   Parsed ${drugs.length} drugs`);
  if (DRY_RUN) {
    console.log(`   Existing IDs retained where identity matched; ${drugs.filter(drug => drug.id > Math.max(...baseline.map(row => row.id))).length} rows need new IDs`);
    console.log('✅ Dry run complete; no cloud data was changed.');
    return;
  }
  await batchUpsert('cloud_drugs', drugs, 'id');

  // 2. Interactions
  console.log('\n📋 Parsing db_drug_interactions.csv...');
  const intCSV = readFileSync(resolve(ROOT, 'db_drug_interactions.csv'), 'utf-8');
  const { rows: intRows } = parseCSV(intCSV);

  // Deduplicate using a unique key 'drug_1|drug_2'
  const uniqueInteractions = new Map();
  for (const r of intRows) {
    const d1 = r['Drug 1'] || '';
    const d2 = r['Drug 2'] || '';
    const desc = r['Interaction Description'] || null;
    if (d1 && d2) {
      const key = `${d1.toLowerCase()}|${d2.toLowerCase()}`;
      uniqueInteractions.set(key, {
        drug_1: d1,
        drug_2: d2,
        interaction_description: desc
      });
    }
  }

  const interactions = Array.from(uniqueInteractions.values());

  console.log(`   Parsed ${intRows.length} rows, deduplicated to ${interactions.length} unique interactions`);
  await batchUpsert('cloud_drug_interactions', interactions, 'drug_1,drug_2');

  console.log('\n🎉 Supabase seeding complete!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
