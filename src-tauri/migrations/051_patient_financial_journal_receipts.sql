-- Forward-only, strictly prospective: V1 033/036 payment and notice scopes
-- have no journal UUID. Do not guess an old linkage or rewrite old money.
-- New writers insert this receipt only after both journal lines, in the SAME
-- BEGIN IMMEDIATE transaction. Original receipt/source/journal rows are sealed.
CREATE TABLE native_patient_financial_journal_receipts (
  source_kind TEXT NOT NULL CHECK(source_kind IN ('payment','notice')),
  source_id TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL CHECK(length(trim(pharmacy_id))>0),
  actor_id TEXT NOT NULL CHECK(length(actor_id)>0),
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000000000),
  money_kind TEXT NOT NULL CHECK(money_kind IN ('cash','bank','debit','credit')),
  PRIMARY KEY(source_kind,source_id)
);

CREATE TRIGGER native_patient_financial_receipt_insert_guard
BEFORE INSERT ON native_patient_financial_journal_receipts
BEGIN
  SELECT RAISE(ABORT,'Unverified native patient money source')
  WHERE (NEW.source_kind='payment' AND NOT EXISTS (
    SELECT 1 FROM patient_transactions t JOIN patient_payment_scope sc
      ON sc.transaction_id=t.id
    WHERE t.id=NEW.source_id AND sc.pharmacy_id=NEW.pharmacy_id
      AND t.user_id=NEW.actor_id AND t.type='payment'
      AND t.payment_method=NEW.money_kind AND NEW.money_kind IN ('cash','bank')
      AND typeof(t.amount) IN ('real','integer') AND t.amount>0
      AND abs(t.amount*100.0-NEW.amount_cents)<0.00001
  )) OR (NEW.source_kind='notice' AND NOT EXISTS (
    SELECT 1 FROM financial_notices n JOIN financial_notice_native_scope sc
      ON sc.notice_id=n.id
    WHERE n.id=NEW.source_id AND sc.pharmacy_id=NEW.pharmacy_id
      AND n.pharmacy_id=NEW.pharmacy_id AND n.user_id=NEW.actor_id
      AND n.type=NEW.money_kind AND NEW.money_kind IN ('debit','credit')
      AND n.target_type IN ('customer','pharmacy')
      AND typeof(n.amount) IN ('real','integer') AND n.amount>0
      AND abs(n.amount*100.0-NEW.amount_cents)<0.00001
  ));
  SELECT RAISE(ABORT,'Unverified native patient money journal')
  WHERE NOT EXISTS (
    SELECT 1 FROM daily_journals j WHERE j.id=NEW.journal_id
      AND j.pharmacy_id=NEW.pharmacy_id AND CAST(j.created_by AS TEXT)=NEW.actor_id
      AND j.date=CASE WHEN NEW.source_kind='payment'
                 THEN (SELECT t.date FROM patient_transactions t WHERE t.id=NEW.source_id)
                 ELSE (SELECT n.date FROM financial_notices n WHERE n.id=NEW.source_id) END
      AND typeof(j.total_amount) IN ('real','integer')
      AND abs(j.total_amount*100.0-NEW.amount_cents)<0.00001
  );
  SELECT RAISE(ABORT,'Unbalanced or redirected native patient money journal')
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
    WHERE e.journal_id=NEW.journal_id GROUP BY e.journal_id
    HAVING count(*)=2
      AND sum(CASE WHEN e.type='debit' AND COALESCE(a.is_group,0)=0
        AND a.code=CASE
          WHEN NEW.source_kind='payment' AND NEW.money_kind='cash' THEN '1.1.1'
          WHEN NEW.source_kind='payment' THEN '1.1.4'
          WHEN NEW.money_kind='credit' THEN '4.2'
          WHEN (SELECT n.target_type FROM financial_notices n WHERE n.id=NEW.source_id)='customer' THEN '1.1.2'
          ELSE '1.1.1' END
        AND typeof(e.amount) IN ('real','integer')
        AND abs(e.amount*100.0-NEW.amount_cents)<0.00001 THEN 1 ELSE 0 END)=1
      AND sum(CASE WHEN e.type='credit' AND COALESCE(a.is_group,0)=0
        AND a.code=CASE
          WHEN NEW.source_kind='payment' THEN '1.1.2'
          WHEN NEW.money_kind='debit' THEN '4.2'
          WHEN (SELECT n.target_type FROM financial_notices n WHERE n.id=NEW.source_id)='customer' THEN '1.1.2'
          ELSE '1.1.1' END
        AND typeof(e.amount) IN ('real','integer')
        AND abs(e.amount*100.0-NEW.amount_cents)<0.00001 THEN 1 ELSE 0 END)=1
  );
END;

CREATE TRIGGER native_patient_financial_receipt_no_update BEFORE UPDATE
ON native_patient_financial_journal_receipts
BEGIN SELECT RAISE(ABORT,'Native patient money receipt is immutable'); END;
CREATE TRIGGER native_patient_financial_receipt_no_delete BEFORE DELETE
ON native_patient_financial_journal_receipts
BEGIN SELECT RAISE(ABORT,'Native patient money receipt is immutable'); END;

CREATE TRIGGER native_patient_financial_payment_no_change
BEFORE UPDATE OF id,patient_id,user_id,type,amount,payment_method,date ON patient_transactions
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='payment' AND r.source_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted native patient payment is immutable'); END;
CREATE TRIGGER native_patient_financial_payment_no_delete BEFORE DELETE ON patient_transactions
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='payment' AND r.source_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted native patient payment is immutable'); END;
CREATE TRIGGER native_patient_financial_notice_no_change
BEFORE UPDATE OF id,user_id,target_type,target_id,type,amount,date,pharmacy_id ON financial_notices
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='notice' AND r.source_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted native financial notice is immutable'); END;
CREATE TRIGGER native_patient_financial_notice_no_delete BEFORE DELETE ON financial_notices
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='notice' AND r.source_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted native financial notice is immutable'); END;
CREATE TRIGGER native_patient_payment_scope_no_change BEFORE UPDATE ON patient_payment_scope
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='payment' AND r.source_id=OLD.transaction_id)
BEGIN SELECT RAISE(ABORT,'Receipted patient payment scope is immutable'); END;
CREATE TRIGGER native_patient_payment_scope_no_delete BEFORE DELETE ON patient_payment_scope
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='payment' AND r.source_id=OLD.transaction_id)
BEGIN SELECT RAISE(ABORT,'Receipted patient payment scope is immutable'); END;
CREATE TRIGGER native_patient_notice_scope_no_change BEFORE UPDATE ON financial_notice_native_scope
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='notice' AND r.source_id=OLD.notice_id)
BEGIN SELECT RAISE(ABORT,'Receipted notice scope is immutable'); END;
CREATE TRIGGER native_patient_notice_scope_no_delete BEFORE DELETE ON financial_notice_native_scope
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r
            WHERE r.source_kind='notice' AND r.source_id=OLD.notice_id)
BEGIN SELECT RAISE(ABORT,'Receipted notice scope is immutable'); END;

CREATE TRIGGER native_patient_financial_journal_no_change BEFORE UPDATE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r WHERE r.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted patient money journal is immutable'); END;
CREATE TRIGGER native_patient_financial_journal_no_delete BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r WHERE r.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted patient money journal is immutable'); END;
CREATE TRIGGER native_patient_financial_entry_no_change BEFORE UPDATE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r WHERE r.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted patient money entries are immutable'); END;
CREATE TRIGGER native_patient_financial_entry_no_delete BEFORE DELETE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r WHERE r.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted patient money entries are immutable'); END;
CREATE TRIGGER native_patient_financial_entry_no_append BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_patient_financial_journal_receipts r WHERE r.journal_id=NEW.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted patient money entries are immutable'); END;
