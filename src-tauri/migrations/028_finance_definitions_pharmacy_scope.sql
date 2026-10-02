-- Banks, card terminals, and POS definitions are operational branch-owned data.
-- Legacy rows predate tenant ownership, so conservatively assign them to local_default.

ALTER TABLE banks ADD COLUMN pharmacy_id TEXT;
UPDATE banks
SET pharmacy_id = 'local_default'
WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';
CREATE INDEX IF NOT EXISTS idx_banks_pharmacy_name
ON banks(pharmacy_id, name_ar);

ALTER TABLE credit_cards ADD COLUMN pharmacy_id TEXT;
UPDATE credit_cards
SET pharmacy_id = 'local_default'
WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';
CREATE INDEX IF NOT EXISTS idx_credit_cards_pharmacy_name
ON credit_cards(pharmacy_id, name_ar);

ALTER TABLE points_of_sale ADD COLUMN pharmacy_id TEXT;
UPDATE points_of_sale
SET pharmacy_id = 'local_default'
WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = '';
CREATE INDEX IF NOT EXISTS idx_points_of_sale_pharmacy_name
ON points_of_sale(pharmacy_id, name_ar);
