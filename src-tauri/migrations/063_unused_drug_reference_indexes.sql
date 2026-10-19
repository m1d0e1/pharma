-- Additive lookup indexes for getUnusedItemsAction's NOT EXISTS checks.
-- No table/data rewrites, no historical ownership inference and no changes to
-- the authorization or deletion rules. The existing native action checks all
-- eleven reference sources before showing a drug as safe to delete.
--
-- These names intentionally match the standalone index naming conventions
-- where those indexes already exist, avoiding redundant indexes on upgraded DBs.
CREATE INDEX IF NOT EXISTS idx_refill_reminders_drug_id
  ON refill_reminders(drug_id);

CREATE INDEX IF NOT EXISTS idx_return_items_drug
  ON return_items(drug_id);

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_drug
  ON purchase_order_items(drug_id);

CREATE INDEX IF NOT EXISTS idx_purchase_return_items_drug
  ON purchase_return_items(drug_id);

CREATE INDEX IF NOT EXISTS idx_opening_balance_items_drug
  ON opening_balance_items(drug_id);

-- With the existing drug_id-leading composite/standalone index, this second
-- arm lets SQLite use MULTI-INDEX OR rather than scanning alternatives for
-- `drug_id = m.id OR alternative_id = m.id`.
CREATE INDEX IF NOT EXISTS idx_drug_alternatives_alternative
  ON drug_alternatives(alternative_id);
