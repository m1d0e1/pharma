const Database = require('better-sqlite3');
const db = new Database('pharma_local.db');

let totalFixed = 0;

function fixTable(tableName) {
  const rows = db.prepare(`SELECT id, expiry_date FROM ${tableName} WHERE expiry_date LIKE '%/%'`).all();
  for (const row of rows) {
    if (!row.expiry_date) continue;
    const parts = row.expiry_date.split('/');
    if (parts.length === 3) {
      let day = parts[0].padStart(2, '0');
      let month = parts[1].padStart(2, '0');
      let year = parts[2];
      
      let newDate = null;
      if (year.length === 4) {
        newDate = `${year}-${month}-${day}`;
      } else if (parts[0].length === 4) {
        newDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }

      if (newDate) {
        db.prepare(`UPDATE ${tableName} SET expiry_date = ? WHERE id = ?`).run(newDate, row.id);
        totalFixed++;
      }
    }
  }
}

fixTable('inventory');
fixTable('purchase_invoice_items');

console.log('Fixed dates in db: ' + totalFixed);
