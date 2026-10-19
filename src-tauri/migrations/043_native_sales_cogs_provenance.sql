-- Forward only. Native completed sales and approved returns posted AFTER 043.
-- Historical NULL-tenant/short-description journals are never backfilled.
CREATE TABLE native_sale_cogs_provenance (
  sale_id TEXT PRIMARY KEY NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128 AND trim(pharmacy_id)=pharmacy_id),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  payment_method TEXT NOT NULL,
  sale_micros INTEGER NOT NULL CHECK(sale_micros BETWEEN 0 AND 1000000000000000000),
  cogs_micros INTEGER NOT NULL CHECK(cogs_micros BETWEEN 0 AND 1000000000000000000),
  line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 200),
  line_snapshot TEXT NOT NULL CHECK(json_valid(line_snapshot) AND length(line_snapshot) BETWEEN 2 AND 131072),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sale_cogs_provenance_tenant ON native_sale_cogs_provenance(pharmacy_id,sale_id);
CREATE TABLE native_sale_return_cogs_provenance (
  return_id TEXT PRIMARY KEY NOT NULL REFERENCES returns(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  sale_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128 AND trim(pharmacy_id)=pharmacy_id),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  refund_method TEXT NOT NULL,
  refund_micros INTEGER NOT NULL CHECK(refund_micros BETWEEN 0 AND 1000000000000000000),
  cogs_micros INTEGER NOT NULL CHECK(cogs_micros BETWEEN 0 AND 1000000000000000000),
  line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 200),
  line_snapshot TEXT NOT NULL CHECK(json_valid(line_snapshot) AND length(line_snapshot) BETWEEN 2 AND 131072),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sale_return_cogs_tenant ON native_sale_return_cogs_provenance(pharmacy_id,sale_id);

-- A protected negative-stock sale is later settled from real inventory.
-- Seal that one allowed mutation with a new stock/COGS event instead of
-- permitting the original sale receipt to be silently rewritten.
CREATE TABLE native_sale_negative_settlement_provenance (
  sale_item_id INTEGER PRIMARY KEY REFERENCES sales_items(id) ON DELETE RESTRICT,
  sale_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  stock_quantity REAL NOT NULL CHECK(stock_quantity>=0 AND stock_quantity<=1000000000),
  unit_cost REAL NOT NULL CHECK(unit_cost>=0 AND unit_cost<=1000000000000),
  cogs_micros INTEGER NOT NULL CHECK(cogs_micros BETWEEN 0 AND 1000000000000000000),
  journal_id TEXT UNIQUE REFERENCES daily_journals(id) DEFERRABLE INITIALLY DEFERRED,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((cogs_micros=0 AND journal_id IS NULL) OR
        (cogs_micros>0 AND journal_id IS NOT NULL))
);
CREATE TRIGGER native_negative_settlement_insert_guard BEFORE INSERT ON native_sale_negative_settlement_provenance BEGIN
  SELECT RAISE(ABORT,'Forged negative sale/COGS settlement') WHERE NOT EXISTS (
    SELECT 1 FROM sales_items si JOIN native_sale_cogs_provenance p ON p.sale_id=si.invoice_id
    JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
    JOIN inventory i ON i.id=NEW.inventory_id
    WHERE si.id=NEW.sale_item_id AND si.invoice_id=NEW.sale_id
      AND si.is_negative=1 AND si.inventory_id IS NULL AND COALESCE(si.cost_price,0)=0
      AND p.pharmacy_id=NEW.pharmacy_id AND u.pharmacy_id=NEW.pharmacy_id
      AND COALESCE(u.is_active,1)=1
      AND i.pharmacy_id=NEW.pharmacy_id AND i.drug_id=si.drug_id
      AND abs(NEW.unit_cost*NEW.stock_quantity*1000000-NEW.cogs_micros)<2
  );
END;
CREATE TRIGGER native_negative_settlement_no_update BEFORE UPDATE ON native_sale_negative_settlement_provenance
 BEGIN SELECT RAISE(ABORT,'Negative settlement receipt is immutable'); END;
CREATE TRIGGER native_negative_settlement_no_delete BEFORE DELETE ON native_sale_negative_settlement_provenance
 BEGIN SELECT RAISE(ABORT,'Negative settlement receipt cannot be deleted'); END;

CREATE TRIGGER native_sale_cogs_insert_guard BEFORE INSERT ON native_sale_cogs_provenance BEGIN
 SELECT RAISE(ABORT,'Forged sales source, actor or tenant') WHERE NOT EXISTS (
   SELECT 1 FROM sales_invoices s JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
   WHERE s.id=NEW.sale_id AND s.pharmacy_id=NEW.pharmacy_id
     AND CAST(s.user_id AS TEXT)=NEW.actor_id AND u.pharmacy_id=NEW.pharmacy_id
     AND COALESCE(u.is_active,1)=1 AND s.status='completed'
     AND s.payment_method=NEW.payment_method
     AND typeof(s.total_amount) IN ('real','integer')
     AND abs(s.total_amount*1000000-NEW.sale_micros)<1.0
 );
 SELECT RAISE(ABORT,'Sales source lines incomplete') WHERE
   json_type(NEW.line_snapshot)!='array'
   OR json_array_length(NEW.line_snapshot)!=NEW.line_count
   OR NEW.line_count!=(SELECT count(*) FROM sales_items WHERE invoice_id=NEW.sale_id);
 SELECT RAISE(ABORT,'Sales journal actor/tenant/amount mismatch') WHERE NOT EXISTS (
   SELECT 1 FROM daily_journals j WHERE j.id=NEW.journal_id
     AND j.pharmacy_id=NEW.pharmacy_id AND CAST(j.created_by AS TEXT)=NEW.actor_id
     AND abs(j.total_amount*1000000-(NEW.sale_micros+NEW.cogs_micros))<2
 );
 SELECT RAISE(ABORT,'Sales COGS and revenue journal unbalanced') WHERE NOT EXISTS (
   SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
    WHERE e.journal_id=NEW.journal_id GROUP BY e.journal_id
    HAVING count(*)=CASE WHEN NEW.cogs_micros>0 THEN 4 ELSE 2 END
       AND sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END)
          -sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) BETWEEN -0.000001 AND 0.000001
       AND sum(CASE WHEN a.code='3.1' AND e.type='credit'
            AND abs(e.amount*1000000-NEW.sale_micros)<1 THEN 1 ELSE 0 END)=1
       AND sum(CASE WHEN a.code='4.1' AND e.type='debit'
            AND abs(e.amount*1000000-NEW.cogs_micros)<1 THEN 1 ELSE 0 END)
          =CASE WHEN NEW.cogs_micros>0 THEN 1 ELSE 0 END
       AND sum(CASE WHEN a.code='1.1.3' AND e.type='credit'
            AND abs(e.amount*1000000-NEW.cogs_micros)<1 THEN 1 ELSE 0 END)
          =CASE WHEN NEW.cogs_micros>0 THEN 1 ELSE 0 END
       AND sum(CASE WHEN e.type='debit'
            AND abs(e.amount*1000000-NEW.sale_micros)<1
            AND a.code NOT IN ('3.1','4.1','1.1.3')
            THEN 1 ELSE 0 END)=1
 );
END;
CREATE TRIGGER native_sale_return_cogs_insert_guard BEFORE INSERT ON native_sale_return_cogs_provenance BEGIN
 SELECT RAISE(ABORT,'Forged sales return, original sale, actor or tenant') WHERE NOT EXISTS (
   SELECT 1 FROM returns r JOIN sales_invoices s ON s.id=r.invoice_id
   JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
   WHERE r.id=NEW.return_id AND r.invoice_id=NEW.sale_id
     AND r.pharmacy_id=NEW.pharmacy_id AND s.pharmacy_id=NEW.pharmacy_id
     AND CAST(r.user_id AS TEXT)=NEW.actor_id AND u.pharmacy_id=NEW.pharmacy_id
     AND COALESCE(u.is_active,1)=1
     AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
     AND r.refund_method=NEW.refund_method
     AND typeof(r.total_refund) IN ('real','integer')
     AND abs(r.total_refund*1000000-NEW.refund_micros)<1
 );
 SELECT RAISE(ABORT,'Sales return source lines incomplete') WHERE
    json_type(NEW.line_snapshot)!='array'
    OR json_array_length(NEW.line_snapshot)!=NEW.line_count
    OR NEW.line_count!=(SELECT count(*) FROM return_items WHERE return_id=NEW.return_id);
 SELECT RAISE(ABORT,'Sales return journal tenant/actor/amount mismatch') WHERE NOT EXISTS (
   SELECT 1 FROM daily_journals j WHERE j.id=NEW.journal_id
     AND j.pharmacy_id=NEW.pharmacy_id AND CAST(j.created_by AS TEXT)=NEW.actor_id
     AND abs(j.total_amount*1000000-(NEW.refund_micros+NEW.cogs_micros))<2
 );
 SELECT RAISE(ABORT,'Sales return revenue/COGS reversal unbalanced') WHERE NOT EXISTS (
   SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
   WHERE e.journal_id=NEW.journal_id GROUP BY e.journal_id
   HAVING count(*)=CASE WHEN NEW.cogs_micros>0 THEN 4 ELSE 2 END
     AND sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END)
       -sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) BETWEEN -0.000001 AND 0.000001
     AND sum(CASE WHEN a.code='3.1' AND e.type='debit'
           AND abs(e.amount*1000000-NEW.refund_micros)<1 THEN 1 ELSE 0 END)=1
     AND sum(CASE WHEN a.code='1.1.3' AND e.type='debit'
           AND abs(e.amount*1000000-NEW.cogs_micros)<1 THEN 1 ELSE 0 END)
         =CASE WHEN NEW.cogs_micros>0 THEN 1 ELSE 0 END
     AND sum(CASE WHEN a.code='4.1' AND e.type='credit'
           AND abs(e.amount*1000000-NEW.cogs_micros)<1 THEN 1 ELSE 0 END)
         =CASE WHEN NEW.cogs_micros>0 THEN 1 ELSE 0 END
     AND sum(CASE WHEN e.type='credit'
           AND abs(e.amount*1000000-NEW.refund_micros)<1 AND a.code NOT IN ('3.1','4.1','1.1.3')
           THEN 1 ELSE 0 END)=1
 );
END;
CREATE TRIGGER native_sale_receipt_no_update BEFORE UPDATE ON native_sale_cogs_provenance
 BEGIN SELECT RAISE(ABORT,'Sale/COGS receipt is immutable'); END;
CREATE TRIGGER native_sale_receipt_no_delete BEFORE DELETE ON native_sale_cogs_provenance
 BEGIN SELECT RAISE(ABORT,'Sale/COGS receipt cannot be deleted'); END;
CREATE TRIGGER native_sale_return_receipt_no_update BEFORE UPDATE ON native_sale_return_cogs_provenance
 BEGIN SELECT RAISE(ABORT,'Sales return/COGS receipt is immutable'); END;
CREATE TRIGGER native_sale_return_receipt_no_delete BEFORE DELETE ON native_sale_return_cogs_provenance
 BEGIN SELECT RAISE(ABORT,'Sales return/COGS receipt cannot be deleted'); END;
CREATE TRIGGER native_sale_source_guard BEFORE UPDATE OF id,pharmacy_id,user_id,total_amount,payment_method,status ON sales_invoices
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.sale_id=OLD.id)
 BEGIN
   SELECT RAISE(ABORT,'Receipted financial sale cannot be rewritten')
   WHERE NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id
      OR NEW.user_id IS NOT OLD.user_id OR NEW.total_amount IS NOT OLD.total_amount
      OR NEW.payment_method IS NOT OLD.payment_method OR NEW.status IS NOT OLD.status;
 END;
CREATE TRIGGER native_sale_source_delete_guard BEFORE DELETE ON sales_invoices
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.sale_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Receipted financial sale cannot be deleted'); END;
CREATE TRIGGER native_sale_line_update_guard BEFORE UPDATE ON sales_items
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.sale_id=OLD.invoice_id)
 BEGIN
 SELECT RAISE(ABORT,'Receipted sale line cannot be rewritten')
 WHERE NOT (
   OLD.is_negative=1 AND OLD.inventory_id IS NULL
   AND NEW.is_negative=0 AND NEW.id=OLD.id AND NEW.invoice_id=OLD.invoice_id
   AND NEW.drug_id=OLD.drug_id
   AND NEW.quantity_sold=OLD.quantity_sold
   AND NEW.unit_price=OLD.unit_price
   AND NEW.unit=OLD.unit
   AND NEW.large_to_medium IS OLD.large_to_medium
   AND NEW.medium_to_small IS OLD.medium_to_small
   AND EXISTS (
     SELECT 1 FROM native_sale_negative_settlement_provenance s
      WHERE s.sale_item_id=OLD.id AND s.sale_id=OLD.invoice_id
        AND s.inventory_id=NEW.inventory_id
        AND abs(s.unit_cost-NEW.cost_price)<0.0000001
   )
 ); END;
CREATE TRIGGER native_sale_line_delete_guard BEFORE DELETE ON sales_items
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.sale_id=OLD.invoice_id)
 BEGIN SELECT RAISE(ABORT,'Receipted sale line cannot be deleted'); END;
CREATE TRIGGER native_sale_line_append_guard BEFORE INSERT ON sales_items
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.sale_id=NEW.invoice_id)
 BEGIN SELECT RAISE(ABORT,'Receipted sale cannot gain a line'); END;
CREATE TRIGGER native_sale_return_source_guard BEFORE UPDATE OF id,invoice_id,user_id,pharmacy_id,total_refund,refund_method,status ON returns
 WHEN EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.return_id=OLD.id)
 BEGIN
 SELECT RAISE(ABORT,'Receipted sales return cannot be rewritten')
 WHERE NEW.id IS NOT OLD.id OR NEW.invoice_id IS NOT OLD.invoice_id
    OR NEW.user_id IS NOT OLD.user_id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id
    OR NEW.total_refund IS NOT OLD.total_refund OR NEW.refund_method IS NOT OLD.refund_method
    OR NOT (LOWER(COALESCE(OLD.status,'')) IN ('approved','completed')
       AND LOWER(COALESCE(NEW.status,'')) IN ('approved','completed'));
 END;
CREATE TRIGGER native_sale_return_source_delete_guard BEFORE DELETE ON returns
 WHEN EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.return_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Receipted sales return cannot be deleted'); END;
CREATE TRIGGER native_sale_return_line_update_guard BEFORE UPDATE ON return_items
 WHEN EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.return_id=OLD.return_id)
 BEGIN SELECT RAISE(ABORT,'Receipted return line cannot be rewritten'); END;
CREATE TRIGGER native_sale_return_line_delete_guard BEFORE DELETE ON return_items
 WHEN EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.return_id=OLD.return_id)
 BEGIN SELECT RAISE(ABORT,'Receipted return line cannot be deleted'); END;
CREATE TRIGGER native_sale_return_line_append_guard BEFORE INSERT ON return_items
 WHEN EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.return_id=NEW.return_id)
 BEGIN SELECT RAISE(ABORT,'Receipted return cannot gain a line'); END;
CREATE TRIGGER native_sale_cogs_journal_no_update BEFORE UPDATE ON daily_journals
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.journal_id=OLD.id)
    OR EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.journal_id=OLD.id)
    OR EXISTS(SELECT 1 FROM native_sale_negative_settlement_provenance p WHERE p.journal_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Receipted sale journal is immutable'); END;
CREATE TRIGGER native_sale_cogs_journal_no_delete BEFORE DELETE ON daily_journals
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.journal_id=OLD.id)
    OR EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.journal_id=OLD.id)
    OR EXISTS(SELECT 1 FROM native_sale_negative_settlement_provenance p WHERE p.journal_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Receipted sale journal cannot be deleted'); END;
CREATE TRIGGER native_sale_cogs_entry_no_update BEFORE UPDATE ON journal_entries
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.journal_id=OLD.journal_id)
    OR EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.journal_id=OLD.journal_id)
    OR EXISTS(SELECT 1 FROM native_sale_negative_settlement_provenance p WHERE p.journal_id=OLD.journal_id)
 BEGIN SELECT RAISE(ABORT,'Receipted sale entry is immutable'); END;
CREATE TRIGGER native_sale_cogs_entry_no_delete BEFORE DELETE ON journal_entries
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.journal_id=OLD.journal_id)
    OR EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.journal_id=OLD.journal_id)
    OR EXISTS(SELECT 1 FROM native_sale_negative_settlement_provenance p WHERE p.journal_id=OLD.journal_id)
 BEGIN SELECT RAISE(ABORT,'Receipted sale entry cannot be deleted'); END;
CREATE TRIGGER native_sale_cogs_entry_no_append BEFORE INSERT ON journal_entries
 WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.journal_id=NEW.journal_id)
    OR EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.journal_id=NEW.journal_id)
    OR (EXISTS(SELECT 1 FROM native_sale_negative_settlement_provenance p WHERE p.journal_id=NEW.journal_id)
        AND (SELECT COUNT(*) FROM journal_entries WHERE journal_id=NEW.journal_id)>=2)
 BEGIN SELECT RAISE(ABORT,'Receipted sale journal cannot gain entries'); END;
