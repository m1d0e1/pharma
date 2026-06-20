const Database = require('better-sqlite3');
const db = new Database('pharma_local.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables.map(t => t.name));
for (const table of tables) {
  try {
    const count = db.prepare(`SELECT count(*) as c FROM ${table.name}`).get().c;
    if (count > 0) console.log(`${table.name}: ${count}`);
  } catch (e) {}
}
