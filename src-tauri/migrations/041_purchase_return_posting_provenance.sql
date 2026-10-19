-- New purchase returns only. No legacy row is assigned inferred ownership.
-- Line receipts are inserted before the parent inside one BEGIN IMMEDIATE;
-- deferred FK and parent insertion guard prevent incomplete committed claims.
CREATE TABLE IF NOT EXISTS native_purchase_return_line_provenance (
  return_item_id INTEGER PRIMARY KEY,
  return_id TEXT NOT NULL,
  purchase_invoice_item_id INTEGER NOT NULL,
  inventory_id TEXT NOT NULL,
  quantity_returned REAL NOT NULL CHECK(quantity_returned>0 AND quantity_returned<=1000000000),
  stock_quantity REAL NOT NULL CHECK(stock_quantity>0 AND stock_quantity<=1000000000),
  refund_value REAL NOT NULL CHECK(refund_value>=0 AND refund_value<=1000000000000),
  FOREIGN KEY(return_id) REFERENCES native_purchase_return_provenance(return_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(return_item_id) REFERENCES purchase_return_items(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_purchase_return_line_proof_return
  ON native_purchase_return_line_provenance(return_id);

CREATE TABLE IF NOT EXISTS native_purchase_return_provenance (
  return_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  purchase_invoice_id TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128 AND trim(pharmacy_id)=pharmacy_id),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128 AND trim(actor_id)=actor_id),
  supplier_id INTEGER NOT NULL CHECK(supplier_id>0),
  journal_id TEXT NOT NULL UNIQUE,
  refund_method TEXT NOT NULL CHECK(refund_method IN ('cash','credit')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=100000000000000),
  line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 200),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(return_id) REFERENCES purchase_returns(id) ON DELETE RESTRICT,
  FOREIGN KEY(purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  FOREIGN KEY(journal_id) REFERENCES daily_journals(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_purchase_return_proof_scope
  ON native_purchase_return_provenance(pharmacy_id, purchase_invoice_id);

CREATE TRIGGER IF NOT EXISTS native_purchase_return_line_insert_guard
BEFORE INSERT ON native_purchase_return_line_provenance
BEGIN
  SELECT RAISE(ABORT,'Purchase return line provenance already sealed')
    WHERE EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.return_id=NEW.return_id);
  SELECT RAISE(ABORT,'Forged purchase return line source')
    WHERE NOT EXISTS (
      SELECT 1 FROM purchase_return_items ri
      JOIN purchase_returns r ON r.id=ri.purchase_return_id
      JOIN purchase_invoice_items pi ON pi.id=NEW.purchase_invoice_item_id
      JOIN purchase_invoices original ON original.id=r.purchase_invoice_id
      JOIN inventory i ON i.id=NEW.inventory_id
      WHERE ri.id=NEW.return_item_id AND ri.purchase_return_id=NEW.return_id
        AND ri.purchase_invoice_item_id=NEW.purchase_invoice_item_id
        AND ri.inventory_id=NEW.inventory_id AND pi.invoice_id=r.purchase_invoice_id
        AND pi.inventory_id=NEW.inventory_id AND ri.drug_id=pi.drug_id
        AND i.drug_id=pi.drug_id AND i.pharmacy_id=original.pharmacy_id
        AND original.pharmacy_id IS NOT NULL AND trim(original.pharmacy_id)<>''
        AND typeof(ri.quantity_returned) IN ('integer','real')
        AND abs(ri.quantity_returned-NEW.quantity_returned)<0.000000001
        AND typeof(ri.total_price) IN ('integer','real')
        AND abs(ri.total_price-NEW.refund_value)<0.00001
    );
END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_insert_guard
BEFORE INSERT ON native_purchase_return_provenance
BEGIN
  SELECT RAISE(ABORT,'Purchase return actor/tenant/source mismatch')
    WHERE NOT EXISTS(
      SELECT 1 FROM purchase_returns r
      JOIN purchase_invoices p ON p.id=r.purchase_invoice_id
      JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
      WHERE r.id=NEW.return_id AND r.purchase_invoice_id=NEW.purchase_invoice_id
        AND r.supplier_id=NEW.supplier_id AND p.supplier_id=NEW.supplier_id
        AND CAST(r.user_id AS TEXT)=NEW.actor_id
        AND p.pharmacy_id=NEW.pharmacy_id AND u.pharmacy_id=NEW.pharmacy_id
        AND COALESCE(u.is_active,1)=1
        AND lower(trim(r.status))='completed'
        AND r.refund_method=NEW.refund_method
        AND typeof(r.total_amount) IN ('integer','real')
        AND abs(r.total_amount*100-NEW.amount_cents)<0.0001
    );
  SELECT RAISE(ABORT,'Purchase return line receipts are incomplete')
    WHERE (SELECT count(*) FROM purchase_return_items WHERE purchase_return_id=NEW.return_id)<>NEW.line_count
       OR (SELECT count(*) FROM native_purchase_return_line_provenance WHERE return_id=NEW.return_id)<>NEW.line_count
       OR EXISTS(
          SELECT 1 FROM native_purchase_return_line_provenance l
          JOIN purchase_return_items ri ON ri.id=l.return_item_id
          JOIN inventory i ON i.id=l.inventory_id
          WHERE l.return_id=NEW.return_id AND
             (ri.purchase_return_id<>NEW.return_id OR i.pharmacy_id<>NEW.pharmacy_id)
       )
       OR abs(COALESCE((SELECT sum(refund_value) FROM native_purchase_return_line_provenance
                       WHERE return_id=NEW.return_id),0)*100-NEW.amount_cents)>0.0001;
  SELECT RAISE(ABORT,'Purchase return journal has inconsistent tenant/actor/amount')
    WHERE NOT EXISTS(
      SELECT 1 FROM daily_journals j
      WHERE j.id=NEW.journal_id AND j.pharmacy_id=NEW.pharmacy_id
        AND CAST(j.created_by AS TEXT)=NEW.actor_id
        AND typeof(j.total_amount) IN ('integer','real')
        AND abs(j.total_amount*100-NEW.amount_cents)<0.0001
    );
  SELECT RAISE(ABORT,'Purchase return journal is not exact balanced inventory reversal')
    WHERE NOT EXISTS(
      SELECT 1 FROM journal_entries e
      JOIN accounts a ON a.id=e.account_id
      WHERE e.journal_id=NEW.journal_id
      GROUP BY e.journal_id
      HAVING count(*)=2
        AND sum(CASE WHEN e.type='debit' AND
                 ((NEW.refund_method='credit' AND a.code='2.1') OR
                  (NEW.refund_method='cash' AND a.code='1.1.1')) THEN 1 ELSE 0 END)=1
        AND sum(CASE WHEN e.type='credit' AND a.code='1.1.3' THEN 1 ELSE 0 END)=1
        AND sum(CASE WHEN typeof(e.amount) IN ('integer','real') AND
                     abs(e.amount*100-NEW.amount_cents)<0.0001 THEN 1 ELSE 0 END)=2
    );
END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_receipt_no_update
BEFORE UPDATE ON native_purchase_return_provenance
BEGIN SELECT RAISE(ABORT,'Native purchase return receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_receipt_no_delete
BEFORE DELETE ON native_purchase_return_provenance
BEGIN SELECT RAISE(ABORT,'Native purchase return receipt cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_line_no_update
BEFORE UPDATE ON native_purchase_return_line_provenance
BEGIN SELECT RAISE(ABORT,'Native purchase return line is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_line_no_delete
BEFORE DELETE ON native_purchase_return_line_provenance
BEGIN SELECT RAISE(ABORT,'Native purchase return line cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_source_no_update
BEFORE UPDATE ON purchase_returns
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.return_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_source_no_delete
BEFORE DELETE ON purchase_returns
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.return_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_items_no_update
BEFORE UPDATE ON purchase_return_items
WHEN EXISTS(SELECT 1 FROM native_purchase_return_line_provenance p WHERE p.return_item_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return item is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_items_no_delete
BEFORE DELETE ON purchase_return_items
WHEN EXISTS(SELECT 1 FROM native_purchase_return_line_provenance p WHERE p.return_item_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return item cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_items_no_extra
BEFORE INSERT ON purchase_return_items
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.return_id=NEW.purchase_return_id)
BEGIN SELECT RAISE(ABORT,'Cannot add lines to receipted purchase return'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_journal_no_update
BEFORE UPDATE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return journal is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_journal_no_delete
BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return journal cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_entries_no_update
BEFORE UPDATE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return journal entry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_entries_no_delete
BEFORE DELETE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return journal entry cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_return_entries_no_extra
BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.journal_id=NEW.journal_id)
BEGIN SELECT RAISE(ABORT,'Cannot append purchase return journal entries'); END;
