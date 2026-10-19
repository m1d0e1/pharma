-- Prospective notice cash custody. 051 sealed notice -> journal but did not
-- record the separate pharmacy shift cash UUID. Historic rows stay unlinked:
-- never infer a UUID from shared date, amount, source or shift.
CREATE TABLE native_financial_notice_cash_witnesses (
  notice_id TEXT PRIMARY KEY REFERENCES financial_notices(id) ON DELETE RESTRICT,
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  cash_movement_id TEXT NOT NULL UNIQUE REFERENCES cash_movements(id) ON DELETE RESTRICT,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(length(trim(pharmacy_id)) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000000000)
);

CREATE TRIGGER native_notice_cash_witness_insert_guard
BEFORE INSERT ON native_financial_notice_cash_witnesses
BEGIN
  SELECT RAISE(ABORT,'Missing or mismatched native financial notice cash UUID')
  WHERE length(NEW.cash_movement_id)<>36 OR NOT EXISTS (
    SELECT 1 FROM financial_notices n
    JOIN financial_notice_native_scope ns ON ns.notice_id=n.id
    JOIN native_patient_financial_journal_receipts r
      ON r.source_kind='notice' AND r.source_id=n.id
    JOIN daily_journals j ON j.id=r.journal_id
    JOIN cash_movements cm ON cm.id=NEW.cash_movement_id
    JOIN shifts sh ON sh.id=cm.shift_id
    WHERE n.id=NEW.notice_id AND n.target_type='pharmacy'
      AND n.type IN ('debit','credit') AND n.target_id IS NULL
      AND n.pharmacy_id=NEW.pharmacy_id AND ns.pharmacy_id=NEW.pharmacy_id
      AND CAST(n.user_id AS TEXT)=NEW.actor_id
      AND r.pharmacy_id=NEW.pharmacy_id AND r.actor_id=NEW.actor_id
      AND r.money_kind=n.type AND r.journal_id=NEW.journal_id
      AND r.amount_cents=NEW.amount_cents
      AND j.pharmacy_id=NEW.pharmacy_id AND CAST(j.created_by AS TEXT)=NEW.actor_id
      AND j.date=n.date AND typeof(j.total_amount) IN ('integer','real')
      AND abs(j.total_amount*100.0-NEW.amount_cents)<0.00001
      AND typeof(n.amount) IN ('integer','real')
      AND abs(n.amount*100.0-NEW.amount_cents)<0.00001
      AND cm.source_type='financial_notice' AND cm.target_name=n.id
      AND cm.category='financial_notice'
      AND cm.type=CASE n.type WHEN 'debit' THEN 'receipt' ELSE 'disbursement' END
      AND cm.pharmacy_id=NEW.pharmacy_id AND CAST(cm.user_id AS TEXT)=NEW.actor_id
      AND cm.date=n.date AND typeof(cm.amount) IN ('integer','real')
      AND abs(cm.amount*100.0-NEW.amount_cents)<0.00001
      AND cm.shift_id=NEW.shift_id AND sh.pharmacy_id=NEW.pharmacy_id
      AND lower(trim(sh.status))='open'
      AND (SELECT COUNT(*) FROM cash_movements other
           WHERE other.source_type='financial_notice' AND other.target_name=n.id)=1
  );
END;

CREATE TRIGGER native_notice_cash_witness_no_update
BEFORE UPDATE ON native_financial_notice_cash_witnesses
BEGIN SELECT RAISE(ABORT,'Receipted financial notice cash witness is immutable'); END;
CREATE TRIGGER native_notice_cash_witness_no_delete
BEFORE DELETE ON native_financial_notice_cash_witnesses
BEGIN SELECT RAISE(ABORT,'Receipted financial notice cash witness is immutable'); END;
CREATE TRIGGER native_notice_cash_movement_no_update
BEFORE UPDATE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_financial_notice_cash_witnesses w
            WHERE w.cash_movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted financial notice cash movement is immutable'); END;
CREATE TRIGGER native_notice_cash_movement_no_delete
BEFORE DELETE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_financial_notice_cash_witnesses w
            WHERE w.cash_movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted financial notice cash movement is immutable'); END;
CREATE TRIGGER native_notice_cash_movement_no_extra
BEFORE INSERT ON cash_movements
WHEN NEW.source_type='financial_notice' AND EXISTS(
  SELECT 1 FROM native_financial_notice_cash_witnesses w WHERE w.notice_id=NEW.target_name)
BEGIN SELECT RAISE(ABORT,'Cannot duplicate receipted financial notice cash'); END;
CREATE TRIGGER native_notice_cash_shift_no_rescope
BEFORE UPDATE OF id,pharmacy_id ON shifts
WHEN EXISTS(SELECT 1 FROM native_financial_notice_cash_witnesses w WHERE w.shift_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted notice shift identity is immutable'); END;
CREATE TRIGGER native_notice_cash_shift_no_delete
BEFORE DELETE ON shifts
WHEN EXISTS(SELECT 1 FROM native_financial_notice_cash_witnesses w WHERE w.shift_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted notice shift is immutable'); END;
