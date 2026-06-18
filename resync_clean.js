const Database = require('better-sqlite3');
const db = new Database('./src-tauri/pharma_local.db');

db.exec(`
  DELETE FROM product_categories;
  DELETE FROM manufacturers;
  DELETE FROM scientific_groups;
  
  INSERT INTO product_categories (name_ar)
  SELECT DISTINCT 
    UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2))
  FROM master_drugs 
  WHERE category IS NOT NULL 
    AND TRIM(category) != '' 
    AND LENGTH(TRIM(category)) > 2
    AND UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2)) NOT IN (SELECT name_ar FROM product_categories);
  
  INSERT INTO scientific_groups (name_ar)
  SELECT DISTINCT 
    UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2))
  FROM master_drugs 
  WHERE category IS NOT NULL 
    AND TRIM(category) != '' 
    AND LENGTH(TRIM(category)) > 2
    AND UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2)) NOT IN (SELECT name_ar FROM scientific_groups);
  
  INSERT INTO manufacturers (name_ar)
  SELECT DISTINCT 
    UPPER(SUBSTR(TRIM(manufacturer), 1, 1)) || LOWER(SUBSTR(TRIM(manufacturer), 2))
  FROM master_drugs 
  WHERE manufacturer IS NOT NULL 
    AND TRIM(manufacturer) != '' 
    AND LENGTH(TRIM(manufacturer)) > 2
    AND UPPER(SUBSTR(TRIM(manufacturer), 1, 1)) || LOWER(SUBSTR(TRIM(manufacturer), 2)) NOT IN (SELECT name_ar FROM manufacturers);
`);

console.log("Cleanup and resync complete!");
db.close();
