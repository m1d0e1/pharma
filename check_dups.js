const Database = require('better-sqlite3');
const db = new Database('./src-tauri/pharma_local.db');

const categories = db.prepare(`
  SELECT category, COUNT(*) as c
  FROM master_drugs
  WHERE category IS NOT NULL AND category != ''
  GROUP BY category COLLATE NOCASE
  HAVING c > 1
  LIMIT 10
`).all();

console.log("Categories with NOCASE collision:");
console.log(categories);

const categoriesTrim = db.prepare(`
  SELECT TRIM(category) as t, COUNT(*) as c
  FROM master_drugs
  WHERE category IS NOT NULL AND category != ''
  GROUP BY TRIM(category)
  HAVING c > 1
  LIMIT 10
`).all();

console.log("Categories with TRIM collision:");
console.log(categoriesTrim);

db.close();
