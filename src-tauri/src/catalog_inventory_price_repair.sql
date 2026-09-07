-- Approved one-time update repair (or explicit offline opt-in).
-- CSV and local_selling_price are large-unit prices;
-- POS calculates strip/tablet prices using the preserved conversion factors.
UPDATE inventory AS lot
SET local_selling_price = reference.official_price
FROM catalog_repair_reference reference
JOIN catalog_repair_names names ON names.name = reference.name AND names.kind = 0
WHERE lot.drug_id = names.drug_id
  AND lot.local_selling_price IS NOT reference.official_price;
