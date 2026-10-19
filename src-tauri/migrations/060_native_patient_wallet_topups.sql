-- Prospective cash wallet top-ups only. Never infer provenance for older global
-- patient wallet balances or backfill historical receipts by matching amounts.
CREATE TABLE native_patient_wallet_topup_receipts (
  request_id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(length(trim(pharmacy_id))>0),
  actor_id TEXT NOT NULL,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  cash_movement_id TEXT NOT NULL UNIQUE REFERENCES cash_movements(id) ON DELETE RESTRICT,
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER native_wallet_topup_receipt_guard BEFORE INSERT
ON native_patient_wallet_topup_receipts BEGIN
  SELECT RAISE(ABORT,'Native wallet top-up receipt cannot replace history')
  WHERE EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts old
                WHERE old.request_id=NEW.request_id OR old.cash_movement_id=NEW.cash_movement_id
                  OR old.journal_id=NEW.journal_id);
  SELECT RAISE(ABORT,'Native wallet top-up cash/journal witness mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM cash_movements cm JOIN shifts s ON s.id=cm.shift_id
    WHERE cm.id=NEW.cash_movement_id AND cm.shift_id=NEW.shift_id
      AND cm.type='receipt' AND cm.category='patient_wallet'
      AND cm.source_type='patient_wallet' AND cm.target_name=NEW.patient_id
      AND cm.user_id=NEW.actor_id AND cm.pharmacy_id=NEW.pharmacy_id
      AND s.pharmacy_id=NEW.pharmacy_id AND s.status='open'
      AND abs(cm.amount*100.0-NEW.amount_cents)<0.00001
  ) OR NOT EXISTS (
    SELECT 1 FROM daily_journals j
    WHERE j.id=NEW.journal_id AND j.created_by=NEW.actor_id
      AND j.pharmacy_id=NEW.pharmacy_id
      AND abs(j.total_amount*100.0-NEW.amount_cents)<0.00001
      AND (SELECT COUNT(*) FROM journal_entries e WHERE e.journal_id=j.id)=2
      AND (SELECT COUNT(*) FROM journal_entries e JOIN accounts a ON a.id=e.account_id
           WHERE e.journal_id=j.id AND a.code='1.1.1' AND e.type='debit'
             AND abs(e.amount*100.0-NEW.amount_cents)<0.00001)=1
      AND (SELECT COUNT(*) FROM journal_entries e JOIN accounts a ON a.id=e.account_id
           WHERE e.journal_id=j.id AND a.code='2.2' AND e.type='credit'
             AND abs(e.amount*100.0-NEW.amount_cents)<0.00001)=1
  );
END;

-- SQLite INSERT OR REPLACE can bypass DELETE guards with recursive_triggers
-- disabled. Reject any replacement of an existing financial witness first.
CREATE TRIGGER native_wallet_topup_cash_replace_guard BEFORE INSERT
ON cash_movements WHEN EXISTS (
  SELECT 1 FROM native_patient_wallet_topup_receipts r
  WHERE r.cash_movement_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'Receipted wallet cash UUID cannot be replaced'); END;
CREATE TRIGGER native_wallet_topup_journal_replace_guard BEFORE INSERT
ON daily_journals WHEN EXISTS (
  SELECT 1 FROM native_patient_wallet_topup_receipts r
  WHERE r.journal_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'Receipted wallet journal UUID cannot be replaced'); END;
CREATE TRIGGER native_wallet_topup_entry_insert_guard BEFORE INSERT
ON journal_entries WHEN EXISTS (
  SELECT 1 FROM native_patient_wallet_topup_receipts r
  WHERE r.journal_id=NEW.journal_id
) BEGIN SELECT RAISE(ABORT,'Receipted wallet journal cannot gain entries'); END;
CREATE TRIGGER native_wallet_topup_shift_replace_guard BEFORE INSERT
ON shifts WHEN EXISTS (
  SELECT 1 FROM native_patient_wallet_topup_receipts r WHERE r.shift_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'Receipted wallet shift UUID cannot be replaced'); END;

CREATE TRIGGER native_wallet_topup_receipt_immutable_update BEFORE UPDATE
ON native_patient_wallet_topup_receipts BEGIN
  SELECT RAISE(ABORT,'Native wallet top-up receipt is immutable');
END;
CREATE TRIGGER native_wallet_topup_receipt_immutable_delete BEFORE DELETE
ON native_patient_wallet_topup_receipts BEGIN
  SELECT RAISE(ABORT,'Native wallet top-up receipt is immutable');
END;
CREATE TRIGGER native_wallet_topup_cash_immutable_update BEFORE UPDATE
ON cash_movements WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                              WHERE cash_movement_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet cash movement is immutable');
END;
CREATE TRIGGER native_wallet_topup_cash_immutable_delete BEFORE DELETE
ON cash_movements WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                              WHERE cash_movement_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet cash movement is immutable');
END;
CREATE TRIGGER native_wallet_topup_journal_immutable_update BEFORE UPDATE
ON daily_journals WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                              WHERE journal_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet journal is immutable');
END;
CREATE TRIGGER native_wallet_topup_journal_immutable_delete BEFORE DELETE
ON daily_journals WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                              WHERE journal_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet journal is immutable');
END;
CREATE TRIGGER native_wallet_topup_entry_immutable_update BEFORE UPDATE
ON journal_entries WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                               WHERE journal_id=OLD.journal_id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet entries are immutable');
END;
CREATE TRIGGER native_wallet_topup_entry_immutable_delete BEFORE DELETE
ON journal_entries WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                               WHERE journal_id=OLD.journal_id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet entries are immutable');
END;
CREATE TRIGGER native_wallet_topup_shift_identity_immutable BEFORE UPDATE OF id,pharmacy_id
ON shifts WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                      WHERE shift_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet shift identity is immutable');
END;
CREATE TRIGGER native_wallet_topup_shift_immutable_delete BEFORE DELETE
ON shifts WHEN EXISTS (SELECT 1 FROM native_patient_wallet_topup_receipts
                      WHERE shift_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'Receipted wallet shift is immutable');
END;
