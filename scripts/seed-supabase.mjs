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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// --- Config ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ntaaxbjeoqyetrmxyktf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error('❌ Set SUPABASE_SERVICE_ROLE_KEY env var first.');
  console.error('   Find it at: Supabase Dashboard > Settings > API > service_role');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// --- CSV Parser (no dependency) ---
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === headers.length) {
      const row = {};
      headers.forEach((h, j) => row[h] = values[j] || null);
      rows.push(row);
    }
  }
  return { headers, rows };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
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
  await createTables();

  // 1. Drugs
  console.log('\n📋 Parsing egypt_drugs_database_full.csv...');
  const drugsCSV = readFileSync(resolve(ROOT, 'egypt_drugs_database_full.csv'), 'utf-8');
  const { rows: drugRows } = parseCSV(drugsCSV);
  
  const drugs = drugRows.map(r => ({
    id: parseInt(r['id']),
    trade_name: r['Trade Name'] || '',
    price: parseFloat(r['Price']) || 0,
    active_ingredient: r['Active Ingredient'] || null,
    category: r['Category'] || null,
    manufacturer: r['Manufacturer'] || null,
  })).filter(d => !isNaN(d.id));

  console.log(`   Parsed ${drugs.length} drugs`);
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
