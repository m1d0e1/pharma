-- Forward-only: existing 051 cash receipts have no movement UUID. Keep NULL
-- historic witnesses unverifiable; never join or backfill by amount/date.
ALTER TABLE native_patient_financial_journal_receipts
  ADD COLUMN cash_movement_id TEXT REFERENCES cash_movements(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX idx_native_patient_cash_movement_witness
  ON native_patient_financial_journal_receipts(cash_movement_id)
  WHERE cash_movement_id IS NOT NULL;

-- All new cash receipts must claim one exact movement within the same atomic
-- payment/journal transaction. Bank payments and notices have no cash movement.
CREATE TRIGGER native_patient_cash_witness_insert_guard
BEFORE INSERT ON native_patient_financial_journal_receipts
BEGIN
  SELECT RAISE(ABORT,'Unexpected native patient cash movement witness')
  WHERE (NEW.source_kind!='payment' OR NEW.money_kind!='cash')
    AND NEW.cash_movement_id IS NOT NULL;
  SELECT RAISE(ABORT,'Missing or mismatched native patient cash movement UUID')
  WHERE NEW.source_kind='payment' AND NEW.money_kind='cash'
    AND (NEW.cash_movement_id IS NULL OR length(NEW.cash_movement_id)<>36
      OR NOT EXISTS (
        SELECT 1 FROM cash_movements cm
        JOIN patient_transactions pt ON pt.id=NEW.source_id
        JOIN shifts sh ON CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
        WHERE cm.id=NEW.cash_movement_id
          AND cm.source_type='patient_payment' AND cm.target_name=pt.patient_id
          AND cm.type='receipt' AND cm.category='accounts_receivable'
          AND cm.pharmacy_id=NEW.pharmacy_id AND sh.pharmacy_id=NEW.pharmacy_id
          AND lower(trim(sh.status))='open'
          AND CAST(cm.user_id AS TEXT)=NEW.actor_id AND cm.date=pt.date
          AND typeof(cm.amount) IN ('real','integer')
          AND abs(cm.amount*100.0-NEW.amount_cents)<0.00001
      ));
END;

CREATE TRIGGER native_patient_cash_witness_movement_no_update
BEFORE UPDATE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.cash_movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted native patient cash movement is immutable'); END;
CREATE TRIGGER native_patient_cash_witness_movement_no_delete
BEFORE DELETE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.cash_movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted native patient cash movement is immutable'); END;
CREATE TRIGGER native_patient_cash_witness_shift_no_rescope
BEFORE UPDATE OF id,pharmacy_id ON shifts
WHEN EXISTS(SELECT 1 FROM cash_movements cm
            JOIN native_patient_financial_journal_receipts r ON r.cash_movement_id=cm.id
            WHERE CAST(cm.shift_id AS TEXT)=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Receipted patient cash shift identity is immutable'); END;
CREATE TRIGGER native_patient_cash_witness_shift_no_delete
BEFORE DELETE ON shifts
WHEN EXISTS(SELECT 1 FROM cash_movements cm
            JOIN native_patient_financial_journal_receipts r ON r.cash_movement_id=cm.id
            WHERE CAST(cm.shift_id AS TEXT)=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Receipted patient cash shift is immutable'); END;
