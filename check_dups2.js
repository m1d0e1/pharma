const Database = require('better-sqlite3');
const db = new Database('./src-tauri/pharma_local.db');

const categories = db.prepare(`
  SELECT UPPER(TRIM(category)) as u, COUNT(DISTINCT category) as c, GROUP_CONCAT(DISTINCT category) as vals
  FROM master_drugs
  WHERE category IS NOT NULL AND category != ''
  GROUP BY UPPER(TRIM(category))
  HAVING c > 1
  LIMIT 10
`).all();

console.log("Categories with Case/Space collisions:");
console.log(categories);

db.close();
