-- Forward-only native stock posting evidence, starting with migration 040.
-- Legacy stock_adjustments/daily_journals are never rewritten or backfilled.
-- Historical actor/tenant/account provenance without this row is UNKNOWN.
-- Caller inserts after the stock adjustment and optional balanced journal,
-- inside the SAME native BEGIN IMMEDIATE transaction.
CREATE TABLE IF NOT EXISTS native_stock_ledger_provenance (
  adjustment_id INTEGER PRIMARY KEY NOT NULL,
  inventory_id TEXT NOT NULL CHECK(length(inventory_id) BETWEEN 1 AND 256),
  pharmacy_id TEXT NOT NULL CHECK(length(trim(pharmacy_id)) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 128),
  old_quantity REAL NOT NULL CHECK(
    typeof(old_quantity) IN ('integer','real') AND old_quantity BETWEEN 0 AND 1000000000
  ),
  new_quantity REAL NOT NULL CHECK(
    typeof(new_quantity) IN ('integer','real') AND new_quantity BETWEEN 0 AND 1000000000
  ),
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents BETWEEN 0 AND 100000000000),
  valuation_cents INTEGER NOT NULL CHECK(valuation_cents BETWEEN 0 AND 100000000000000),
  direction TEXT NOT NULL CHECK(direction IN ('increase','decrease')),
  journal_id TEXT UNIQUE,
  inventory_account_id INTEGER,
  counterpart_account_id INTEGER,
  counterpart_type TEXT CHECK(counterpart_type IN ('revenue','expense')),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(adjustment_id) REFERENCES stock_adjustments(id) ON DELETE RESTRICT,
  FOREIGN KEY(inventory_id) REFERENCES inventory(id) ON DELETE RESTRICT,
  FOREIGN KEY(journal_id) REFERENCES daily_journals(id) ON DELETE RESTRICT,
  FOREIGN KEY(inventory_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY(counterpart_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CHECK(old_quantity <> new_quantity),
  CHECK((direction='increase' AND new_quantity>old_quantity)
     OR (direction='decrease' AND new_quantity<old_quantity)),
  CHECK((valuation_cents=0 AND journal_id IS NULL
            AND inventory_account_id IS NULL
            AND counterpart_account_id IS NULL AND counterpart_type IS NULL)
     OR (valuation_cents>0 AND journal_id IS NOT NULL
            AND inventory_account_id IS NOT NULL
            AND counterpart_account_id IS NOT NULL
            AND inventory_account_id<>counterpart_account_id
            AND ((direction='increase' AND counterpart_type='revenue')
                 OR (direction='decrease' AND counterpart_type='expense'))))
);
CREATE INDEX IF NOT EXISTS idx_native_stock_provenance_pharmacy
ON native_stock_ledger_provenance(pharmacy_id, adjustment_id);
CREATE INDEX IF NOT EXISTS idx_native_stock_provenance_lot
ON native_stock_ledger_provenance(inventory_id, adjustment_id);

-- Validate the first native insertion even if callers skip Rust validation.
-- These assertions use structural IDs, not journal description prefixes.
CREATE TRIGGER IF NOT EXISTS native_stock_provenance_insert_guard
BEFORE INSERT ON native_stock_ledger_provenance
BEGIN
  SELECT RAISE(ABORT,'Stock provenance source/actor/tenant mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM stock_adjustments sa
    JOIN inventory i ON i.id=NEW.inventory_id
    JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
    WHERE sa.id=NEW.adjustment_id
      AND sa.inventory_id=NEW.inventory_id
      AND CAST(sa.user_id AS TEXT)=NEW.actor_id
      AND typeof(sa.old_quantity) IN ('integer','real')
      AND typeof(sa.new_quantity) IN ('integer','real')
      AND abs(sa.old_quantity-NEW.old_quantity)<0.000000001
      AND abs(sa.new_quantity-NEW.new_quantity)<0.000000001
      AND i.pharmacy_id=NEW.pharmacy_id AND trim(i.pharmacy_id)<>''
      AND typeof(i.quantity) IN ('integer','real')
      AND abs(i.quantity-NEW.new_quantity)<0.000000001
      AND u.pharmacy_id=NEW.pharmacy_id AND trim(u.pharmacy_id)<>''
      AND COALESCE(u.is_active,1)=1
  );
  SELECT RAISE(ABORT,'Stock provenance valuation is inconsistent')
  WHERE abs((NEW.new_quantity-NEW.old_quantity)
             * (CASE WHEN NEW.new_quantity>NEW.old_quantity THEN 1 ELSE -1 END)
             * NEW.unit_cost_cents-NEW.valuation_cents)>0.0001
     OR NOT EXISTS (
       SELECT 1 FROM inventory i WHERE i.id=NEW.inventory_id
       AND typeof(i.cost_price) IN ('real','integer')
       AND abs(i.cost_price*100-NEW.unit_cost_cents)<0.00001
     );
  SELECT RAISE(ABORT,'Stock provenance journal tenant/actor/amount mismatch')
  WHERE NEW.journal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM daily_journals j
    WHERE j.id=NEW.journal_id AND j.pharmacy_id=NEW.pharmacy_id
      AND CAST(j.created_by AS TEXT)=NEW.actor_id
      AND ((NEW.direction='increase' AND j.id GLOB 'native-lot-adjust-*')
        OR (NEW.direction='decrease' AND
          (j.id GLOB 'native-lot-adjust-*' OR j.id GLOB 'native-lot-zero-*')))
      AND typeof(j.total_amount) IN ('real','integer')
      AND abs(j.total_amount*100-NEW.valuation_cents)<0.00001
  );
  SELECT RAISE(ABORT,'Stock provenance journal entries are not exact and balanced')
  WHERE NEW.journal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM journal_entries e
    WHERE e.journal_id=NEW.journal_id
    GROUP BY e.journal_id
    HAVING COUNT(*)=2
       AND SUM(CASE WHEN e.type='debit' THEN 1 ELSE 0 END)=1
       AND SUM(CASE WHEN e.type='credit' THEN 1 ELSE 0 END)=1
       AND SUM(CASE WHEN typeof(e.amount) IN ('integer','real')
                     AND abs(e.amount*100-NEW.valuation_cents)<0.00001
                    THEN 1 ELSE 0 END)=2
       AND SUM(CASE WHEN e.account_id=NEW.inventory_account_id
                      AND e.type=(CASE WHEN NEW.direction='increase' THEN 'debit' ELSE 'credit' END)
                    THEN 1 ELSE 0 END)=1
       AND SUM(CASE WHEN e.account_id=NEW.counterpart_account_id
                      AND e.type=(CASE WHEN NEW.direction='increase' THEN 'credit' ELSE 'debit' END)
                    THEN 1 ELSE 0 END)=1
  );
  SELECT RAISE(ABORT,'Stock provenance account is not a postable leaf')
  WHERE NEW.journal_id IS NOT NULL AND (
    NOT EXISTS (
      SELECT 1 FROM accounts a WHERE a.id=NEW.inventory_account_id
        AND lower(trim(a.type))='asset' AND COALESCE(a.is_group,0)=0
        AND NOT EXISTS(SELECT 1 FROM accounts c WHERE c.parent_id=a.id)
    ) OR NOT EXISTS (
      SELECT 1 FROM accounts a WHERE a.id=NEW.counterpart_account_id
        AND lower(trim(a.type))=NEW.counterpart_type AND COALESCE(a.is_group,0)=0
        AND NOT EXISTS(SELECT 1 FROM accounts c WHERE c.parent_id=a.id)
    )
  );
END;

-- New provenance is append-only, including timestamps and source claims.
CREATE TRIGGER IF NOT EXISTS native_stock_provenance_no_update
BEFORE UPDATE ON native_stock_ledger_provenance
BEGIN SELECT RAISE(ABORT,'Native stock provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_provenance_no_delete
BEFORE DELETE ON native_stock_ledger_provenance
BEGIN SELECT RAISE(ABORT,'Native stock provenance cannot be deleted'); END;

-- Protect only rows explicitly recorded by this forward-only migration.
-- No trigger modifies, freezes, or backfills an unlinked legacy adjustment.
CREATE TRIGGER IF NOT EXISTS native_stock_adjustment_no_update
BEFORE UPDATE ON stock_adjustments
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.adjustment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Provenance-linked adjustment is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_adjustment_no_delete
BEFORE DELETE ON stock_adjustments
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.adjustment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Provenance-linked adjustment cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_journal_no_update
BEFORE UPDATE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Provenance-linked journal is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_journal_no_delete
BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Provenance-linked journal cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_entries_no_update
BEFORE UPDATE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Provenance-linked journal entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_entries_no_delete
BEFORE DELETE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Provenance-linked journal entries cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_stock_entries_no_extra
BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_stock_ledger_provenance p WHERE p.journal_id=NEW.journal_id)
BEGIN SELECT RAISE(ABORT,'Cannot add lines to provenance-linked journal'); END;
