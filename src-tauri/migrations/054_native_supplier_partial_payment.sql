-- Only new supplier settlements with a uniquely receipted, unedited CREDIT
-- purchase source are eligible. Suppliers and older supplier ledger rows have
-- no tenant column; this migration does not assign them inferred ownership.
CREATE TABLE native_supplier_payment_receipts (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  supplier_id INTEGER NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  supplier_transaction_id INTEGER NOT NULL UNIQUE REFERENCES supplier_transactions(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(length(trim(pharmacy_id)) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000000000),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','bank')),
  payment_date TEXT NOT NULL,
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  cash_movement_id TEXT UNIQUE REFERENCES cash_movements(id) ON DELETE RESTRICT,
  balance_before_cents INTEGER NOT NULL CHECK(balance_before_cents BETWEEN 1 AND 100000000000000),
  balance_after_cents INTEGER NOT NULL CHECK(balance_after_cents BETWEEN 0 AND 100000000000000),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(balance_before_cents-balance_after_cents=amount_cents),
  CHECK((payment_method='cash')=(cash_movement_id IS NOT NULL))
);
CREATE INDEX idx_native_supplier_payment_invoice ON native_supplier_payment_receipts(invoice_id,supplier_id);

CREATE TRIGGER native_supplier_payment_insert_guard BEFORE INSERT ON native_supplier_payment_receipts
BEGIN
  SELECT RAISE(ABORT,'Supplier payment lacks unambiguous receipted credit invoice')
  WHERE NOT EXISTS (
    SELECT 1 FROM purchase_invoices p
    JOIN native_purchase_create_requests c ON c.invoice_id=p.id
    JOIN native_purchase_posting_events e ON e.journal_id=c.initial_journal_id
    JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
    JOIN suppliers s ON s.id=p.supplier_id
    WHERE p.id=NEW.invoice_id AND p.supplier_id=NEW.supplier_id
      AND p.pharmacy_id=NEW.pharmacy_id AND p.status='completed'
      AND p.payment_method='credit' AND c.source_status='completed'
      AND c.pharmacy_id=NEW.pharmacy_id AND c.supplier_id=NEW.supplier_id
      AND e.invoice_id=p.id AND e.event_kind='initial'
      AND e.pharmacy_id=NEW.pharmacy_id AND e.supplier_id=NEW.supplier_id
      AND e.payment_method='credit'
      AND c.source_total_cents=e.new_total_cents
      AND typeof(p.total_amount) IN ('integer','real')
      AND abs(p.total_amount*100- e.new_total_cents)<0.0001
      AND u.pharmacy_id=NEW.pharmacy_id AND COALESCE(u.is_active,1)=1
      AND typeof(s.balance) IN ('integer','real')
      AND abs(s.balance*100-NEW.balance_before_cents)<0.0001
      AND (SELECT count(*) FROM purchase_invoices pi WHERE pi.supplier_id=NEW.supplier_id)=1
      AND (SELECT count(*) FROM native_purchase_posting_events pe WHERE pe.invoice_id=p.id)=1
      AND (SELECT count(*) FROM purchase_returns pr WHERE pr.supplier_id=NEW.supplier_id)=0
      AND (SELECT count(*) FROM native_supplier_payment_receipts prior WHERE prior.supplier_id=NEW.supplier_id
          AND prior.invoice_id=NEW.invoice_id AND prior.pharmacy_id=NEW.pharmacy_id)
          =(SELECT count(*) FROM native_supplier_payment_receipts prior WHERE prior.supplier_id=NEW.supplier_id)
      AND e.new_total_cents-
          COALESCE((SELECT sum(prior.amount_cents) FROM native_supplier_payment_receipts prior
                    WHERE prior.supplier_id=NEW.supplier_id),0)=NEW.balance_before_cents
  );
  SELECT RAISE(ABORT,'Supplier payment ledger is ambiguous or mismatched') WHERE
    (SELECT count(*) FROM supplier_transactions st WHERE st.supplier_id=NEW.supplier_id)
       <>2+(SELECT count(*) FROM native_supplier_payment_receipts prior WHERE prior.supplier_id=NEW.supplier_id)
    OR (SELECT count(*) FROM supplier_transactions st
        WHERE st.supplier_id=NEW.supplier_id AND st.reference_id=NEW.invoice_id AND st.type='invoice'
          AND typeof(st.amount) IN ('real','integer')
          AND abs(st.amount*100-(SELECT c.source_total_cents FROM native_purchase_create_requests c
                                  WHERE c.invoice_id=NEW.invoice_id))<0.0001)<>1
    OR NOT EXISTS(SELECT 1 FROM supplier_transactions st
      WHERE st.id=NEW.supplier_transaction_id AND st.supplier_id=NEW.supplier_id
        AND st.type='payment' AND st.payment_method=NEW.payment_method
        AND st.reference_id='supplier-payment:'||NEW.id AND st.user_id=NEW.actor_id
        AND st.date=NEW.payment_date AND typeof(st.amount) IN ('integer','real')
        AND abs(st.amount*100-NEW.amount_cents)<0.0001);
  SELECT RAISE(ABORT,'Supplier payment journal mismatched')
  WHERE NOT EXISTS (
    SELECT 1 FROM daily_journals j JOIN journal_entries e ON e.journal_id=j.id
      JOIN accounts a ON a.id=e.account_id
    WHERE j.id=NEW.journal_id AND j.pharmacy_id=NEW.pharmacy_id
      AND CAST(j.created_by AS TEXT)=NEW.actor_id AND j.date=NEW.payment_date
      AND typeof(j.total_amount) IN ('real','integer')
      AND abs(j.total_amount*100-NEW.amount_cents)<0.0001
    GROUP BY j.id HAVING count(*)=2
      AND sum(CASE WHEN e.type='debit' AND a.code='2.1' AND COALESCE(a.is_group,0)=0
                       AND typeof(e.amount) IN ('real','integer')
                       AND abs(e.amount*100-NEW.amount_cents)<0.0001 THEN 1 ELSE 0 END)=1
      AND sum(CASE WHEN e.type='credit' AND a.code=CASE WHEN NEW.payment_method='cash' THEN '1.1.1' ELSE '1.1.4' END
                       AND COALESCE(a.is_group,0)=0 AND typeof(e.amount) IN ('real','integer')
                       AND abs(e.amount*100-NEW.amount_cents)<0.0001 THEN 1 ELSE 0 END)=1
  );
  SELECT RAISE(ABORT,'Supplier payment cash movement mismatched') WHERE
    (NEW.payment_method='bank' AND EXISTS(SELECT 1 FROM cash_movements cm
                                      WHERE cm.source_type='supplier_payment' AND cm.target_name=NEW.id))
    OR (NEW.payment_method='cash' AND NOT EXISTS (
      SELECT 1 FROM cash_movements cm JOIN shifts sh ON sh.id=cm.shift_id
      WHERE cm.id=NEW.cash_movement_id AND cm.source_type='supplier_payment' AND cm.target_name=NEW.id
        AND cm.type='disbursement' AND cm.category='accounts_payable'
        AND cm.pharmacy_id=NEW.pharmacy_id AND sh.pharmacy_id=NEW.pharmacy_id
        AND lower(trim(sh.status))='open' AND CAST(cm.user_id AS TEXT)=NEW.actor_id
        AND cm.date=NEW.payment_date AND typeof(cm.amount) IN ('real','integer')
        AND abs(cm.amount*100-NEW.amount_cents)<0.0001
    )) OR (SELECT count(*) FROM cash_movements cm
            WHERE cm.source_type='supplier_payment' AND cm.target_name=NEW.id)
           <>CASE WHEN NEW.payment_method='cash' THEN 1 ELSE 0 END;
END;

CREATE TRIGGER native_supplier_payment_receipt_no_update BEFORE UPDATE ON native_supplier_payment_receipts
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment is immutable'); END;
CREATE TRIGGER native_supplier_payment_receipt_no_delete BEFORE DELETE ON native_supplier_payment_receipts
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment is immutable'); END;
CREATE TRIGGER native_supplier_payment_supplier_row_no_update BEFORE UPDATE ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.supplier_transaction_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier ledger is immutable'); END;
CREATE TRIGGER native_supplier_payment_supplier_row_no_delete BEFORE DELETE ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.supplier_transaction_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier ledger is immutable'); END;
CREATE TRIGGER native_supplier_payment_supplier_no_duplicate BEFORE INSERT ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r
  WHERE NEW.reference_id='supplier-payment:'||r.id)
BEGIN SELECT RAISE(ABORT,'Cannot append duplicate receipted supplier payment'); END;
CREATE TRIGGER native_supplier_payment_invoice_ledger_no_update BEFORE UPDATE ON supplier_transactions
WHEN OLD.type='invoice' AND EXISTS(SELECT 1 FROM native_supplier_payment_receipts r
  WHERE r.invoice_id=OLD.reference_id)
BEGIN SELECT RAISE(ABORT,'Partially settled supplier invoice ledger is immutable'); END;
CREATE TRIGGER native_supplier_payment_invoice_ledger_no_delete BEFORE DELETE ON supplier_transactions
WHEN OLD.type='invoice' AND EXISTS(SELECT 1 FROM native_supplier_payment_receipts r
  WHERE r.invoice_id=OLD.reference_id)
BEGIN SELECT RAISE(ABORT,'Partially settled supplier invoice ledger is immutable'); END;
CREATE TRIGGER native_supplier_payment_invoice_ledger_no_extra BEFORE INSERT ON supplier_transactions
WHEN NEW.type='invoice' AND EXISTS(SELECT 1 FROM native_supplier_payment_receipts r
  WHERE r.invoice_id=NEW.reference_id)
BEGIN SELECT RAISE(ABORT,'Partially settled supplier invoice cannot gain duplicate ledger claims'); END;
CREATE TRIGGER native_supplier_payment_invoice_no_update BEFORE UPDATE ON purchase_invoices
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.invoice_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Partially settled supplier invoice requires separate reconciliation'); END;
CREATE TRIGGER native_supplier_payment_invoice_no_delete BEFORE DELETE ON purchase_invoices
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.invoice_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Partially settled supplier invoice cannot be deleted'); END;
CREATE TRIGGER native_supplier_payment_journal_no_update BEFORE UPDATE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment journal is immutable'); END;
CREATE TRIGGER native_supplier_payment_journal_no_delete BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment journal is immutable'); END;
CREATE TRIGGER native_supplier_payment_entry_no_update BEFORE UPDATE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment entries are immutable'); END;
CREATE TRIGGER native_supplier_payment_entry_no_delete BEFORE DELETE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment entries are immutable'); END;
CREATE TRIGGER native_supplier_payment_entry_no_append BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.journal_id=NEW.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment entries are immutable'); END;
CREATE TRIGGER native_supplier_payment_cash_no_update BEFORE UPDATE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.cash_movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment cash is immutable'); END;
CREATE TRIGGER native_supplier_payment_cash_no_delete BEFORE DELETE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_supplier_payment_receipts r WHERE r.cash_movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted supplier payment cash is immutable'); END;
CREATE TRIGGER native_supplier_payment_cash_no_extra BEFORE INSERT ON cash_movements
WHEN NEW.source_type='supplier_payment' AND EXISTS(
  SELECT 1 FROM native_supplier_payment_receipts r WHERE r.id=NEW.target_name)
BEGIN SELECT RAISE(ABORT,'Cannot duplicate receipted supplier payment cash'); END;
