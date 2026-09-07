-- Exact normalized names only: never use positional IDs or guess identity from price/ingredients.
-- Collapse repeated whitespace only; preserve punctuation, strength, form and pack size.
CREATE TEMP TABLE catalog_repair_names (kind INTEGER, drug_id INTEGER, name TEXT);
WITH RECURSIVE normalized(kind, drug_id, name) AS (
    SELECT 0, id, UPPER(TRIM(REPLACE(REPLACE(REPLACE(trade_name, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '))) FROM master_drugs
    UNION ALL
    SELECT 1, rowid, UPPER(TRIM(REPLACE(REPLACE(REPLACE(trade_name, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '))) FROM bundled_catalog.catalog_csv_reference
    UNION ALL
    SELECT kind, drug_id, REPLACE(name, '  ', ' ') FROM normalized WHERE INSTR(name, '  ') > 0
)
INSERT INTO catalog_repair_names SELECT kind, drug_id, name FROM normalized WHERE INSTR(name, '  ') = 0;
CREATE INDEX catalog_repair_names_id ON catalog_repair_names(kind, drug_id);
CREATE TEMP TABLE catalog_repair_reference (
    name TEXT PRIMARY KEY,
    official_price REAL,
    active_ingredient TEXT,
    category TEXT,
    manufacturer TEXT
);
INSERT INTO catalog_repair_reference
SELECT names.name, MIN(official_price), MIN(active_ingredient), MIN(category), MIN(manufacturer)
FROM bundled_catalog.catalog_csv_reference csv
JOIN catalog_repair_names names ON names.kind = 1 AND names.drug_id = csv.rowid
WHERE names.name <> ''
GROUP BY names.name
HAVING COUNT(*) = 1;

UPDATE master_drugs AS local
SET official_price = reference.official_price,
    active_ingredient = reference.active_ingredient,
    category = reference.category,
    manufacturer = reference.manufacturer
FROM catalog_repair_reference AS reference
JOIN catalog_repair_names names ON names.name = reference.name AND names.kind = 0
WHERE local.id = names.drug_id
  AND (local.official_price IS NOT reference.official_price
    OR local.active_ingredient IS NOT reference.active_ingredient
    OR local.category IS NOT reference.category
    OR local.manufacturer IS NOT reference.manufacturer);
