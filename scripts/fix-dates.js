const db = require('better-sqlite3')('pharma_local.db');

// Fix inventory
const invs = db.prepare("SELECT id, expiry_date FROM inventory WHERE expiry_date LIKE '%/%'").all();
let fixed = 0;
const updateInv = db.prepare("UPDATE inventory SET expiry_date = ? WHERE id = ?");
for (const row of invs) {
  if (row.expiry_date) {
    const parts = row.expiry_date.split('/');
    if (parts.length === 3) {
       // DD/MM/YYYY -> YYYY-MM-DD
       const newDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
       updateInv.run(newDate, row.id);
       fixed++;
    }
  }
}
console.log('Fixed inventory dates:', fixed);

// Fix purchase items
const items = db.prepare("SELECT id, expiry_date FROM purchase_invoice_items WHERE expiry_date LIKE '%/%'").all();
let fixedItems = 0;
const updateItem = db.prepare("UPDATE purchase_invoice_items SET expiry_date = ? WHERE id = ?");
for (const row of items) {
  if (row.expiry_date) {
    const parts = row.expiry_date.split('/');
    if (parts.length === 3) {
       const newDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
       updateItem.run(newDate, row.id);
       fixedItems++;
    }
  }
}
console.log('Fixed purchase item dates:', fixedItems);
