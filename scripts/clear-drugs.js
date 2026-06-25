const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'pharma_local.db');

const db = new Database(dbPath);

console.log("Dropping FTS tables and triggers...");
db.exec(`
  DROP TRIGGER IF EXISTS master_drugs_ai;
  DROP TRIGGER IF EXISTS master_drugs_ad;
  DROP TRIGGER IF EXISTS master_drugs_au;
  DROP TABLE IF EXISTS master_drugs_fts;
`);

console.log("Deleting master_drugs...");
db.exec('DELETE FROM master_drugs;');

console.log("Done.");
