const db = require('better-sqlite3')('src-tauri/pharma_local.db');
const rows = db.prepare(`SELECT id, expiry_date FROM inventory WHERE expiry_date LIKE '%/%'`).all();
let count = 0;
for (const r of rows) {
  const p = r.expiry_date.split('/');
  if (p.length === 3) {
    const nd = `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
    db.prepare(`UPDATE inventory SET expiry_date = ? WHERE id = ?`).run(nd, r.id);
    count++;
  }
}
console.log('Fixed', count, 'dates');
