import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import Database from 'better-sqlite3';

const CSV_PATH = path.join(process.cwd(), 'db_drug_interactions.csv');

/**
 * Imports drug interactions from CSV into the provided database instance
 */
export async function importInteractionsFromCSV(db: any) {
  console.log('Starting drug interactions import from CSV...');
  
  if (!fs.existsSync(CSV_PATH)) {
    console.warn('CSV file not found at:', CSV_PATH);
    return false;
  }

  try {
    // Ensure table and indexes exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS drug_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingredient_a TEXT NOT NULL COLLATE NOCASE,
        ingredient_b TEXT NOT NULL COLLATE NOCASE,
        severity TEXT NOT NULL DEFAULT 'moderate',
        description_ar TEXT,
        description_en TEXT,
        recommendation TEXT,
        source TEXT DEFAULT 'CSV'
      );
      CREATE INDEX IF NOT EXISTS idx_interactions_a ON drug_interactions(ingredient_a);
      CREATE INDEX IF NOT EXISTS idx_interactions_b ON drug_interactions(ingredient_b);
    `);

    const fileContent = fs.readFileSync(CSV_PATH, 'utf-8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
    });

    console.log(`Parsed ${records.length} records. Importing...`);

    const insert = db.prepare(`
      INSERT INTO drug_interactions (ingredient_a, ingredient_b, description_en, severity)
      VALUES (?, ?, ?, ?)
    `);

    // We use a transaction for speed
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        // Map CSV columns: 'Drug 1', 'Drug 2', 'Interaction Description'
        // Note: CSV doesn't have severity, so we default to 'major' or 'moderate'
        insert.run(
          row['Drug 1']?.trim(), 
          row['Drug 2']?.trim(), 
          row['Interaction Description']?.trim(), 
          'major'
        );
      }
    });

    // Clear existing CSV source interactions to avoid duplicates
    db.prepare("DELETE FROM drug_interactions WHERE source = 'CSV'").run();

    // Process in chunks of 5000 for efficiency
    const chunkSize = 5000;
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      insertMany(chunk);
      if (i % 25000 === 0) console.log(`Imported ${i + chunk.length} / ${records.length}...`);
    }

    console.log('CSV Import completed successfully.');
    return true;
  } catch (error) {
    console.error('CSV Import error:', error);
    return false;
  }
}

// Allow running standalone
if (require.main === module) {
  const DB_PATH = path.join(process.cwd(), 'pharma_local.db');
  const db = new Database(DB_PATH);
  importInteractionsFromCSV(db).then(() => db.close());
}
