const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPaths = [
  path.join(__dirname, '..', 'pharma_local.db'),
  path.join(__dirname, '..', 'src-tauri', 'pharma_local.db'),
  path.join(process.env.APPDATA || '', 'com.pharma.system', 'pharma_local.db'),
  path.join(process.env.APPDATA || '', 'Pharmacy Local Enforcer', 'pharma_local.db'),
];

for (const dbPath of dbPaths) {
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const res = db.prepare('DELETE FROM inventory').run();
      console.log(`Cleared ${res.changes} rows from inventory in ${dbPath}`);
      db.close();
    } catch (e) {
      console.error(`Failed to clear inventory in ${dbPath}:`, e.message);
    }
  }
}
