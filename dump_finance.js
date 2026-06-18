const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'src-tauri', 'pharma_local.db');
const db = new Database(dbPath);

try {
  ['accounts', 'expense_definitions', 'banks', 'papers', 'cards', 'pos_machines', 'trial_balance_settings'].forEach(table => {
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      console.log(`=== ${table} ===`);
      console.table(rows);
    } catch(e) {
      console.log(`Error querying ${table}: ${e.message}`);
    }
  });
} catch (error) {
  console.error('Error running test:', error);
} finally {
  db.close();
}
