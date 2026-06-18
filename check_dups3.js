const Database = require('better-sqlite3');
const db = new Database('./src-tauri/pharma_local.db');

const categories = db.prepare(`
  SELECT DISTINCT TRIM(category) as t
  FROM master_drugs
  WHERE category IS NOT NULL AND TRIM(category) != '' AND LENGTH(TRIM(category)) <= 2
`).all();

console.log("Categories <= 2 chars:");
console.log(categories);

const weird = db.prepare(`
  SELECT DISTINCT TRIM(category) as t
  FROM master_drugs
  WHERE category IS NOT NULL AND TRIM(category) != '' AND LENGTH(TRIM(category)) > 2
  AND NOT (UPPER(SUBSTR(TRIM(category), 1, 1)) BETWEEN 'A' AND 'Z')
  AND NOT (UPPER(SUBSTR(TRIM(category), 1, 1)) BETWEEN 'ا' AND 'ي')
`).all();

console.log("Categories not starting with letter:");
console.log(weird);

db.close();
