-- Forward only. Delivery cash collection is a separate, immutable event.
-- Sale amount, native 043 receipt and original sale journal never change.
CREATE TABLE native_delivery_collection_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36
    AND substr(request_id,15,1)='4'
    AND substr(request_id,20,1) IN ('8','9','a','b')
    AND request_id=lower(request_id)),
  sale_id TEXT NOT NULL UNIQUE REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128 AND trim(pharmacy_id)=pharmacy_id),
  actor_id TEXT NOT NULL,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  journal_id TEXT NOT NULL UNIQUE REFERENCES daily_journals(id) ON DELETE RESTRICT,
  movement_id TEXT NOT NULL UNIQUE REFERENCES cash_movements(id) ON DELETE RESTRICT,
  sale_cents INTEGER NOT NULL CHECK(sale_cents BETWEEN 0 AND 100000000000),
  fee_cents INTEGER NOT NULL CHECK(fee_cents BETWEEN 0 AND 100000000000),
  total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 1 AND 100000000000
    AND total_cents=sale_cents+fee_cents),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_native_delivery_collection_tenant
 ON native_delivery_collection_receipts(pharmacy_id,sale_id);

CREATE TRIGGER native_delivery_collection_insert_guard
BEFORE INSERT ON native_delivery_collection_receipts BEGIN
  SELECT RAISE(ABORT,'Delivery collection source lacks verified native delivery sale')
  WHERE NOT EXISTS(
    SELECT 1 FROM sales_invoices s
    JOIN native_sale_cogs_provenance p ON p.sale_id=s.id
    JOIN daily_journals original ON original.id=p.journal_id
    WHERE s.id=NEW.sale_id AND s.pharmacy_id=NEW.pharmacy_id
      AND s.payment_method='delivery' AND s.status='completed'
      AND p.pharmacy_id=NEW.pharmacy_id AND p.payment_method='delivery'
      AND typeof(s.total_amount) IN ('integer','real')
      AND s.total_amount>=0 AND s.total_amount<=1000000000
      AND abs(s.total_amount*100-NEW.sale_cents)<0.000001
      AND p.sale_micros=NEW.sale_cents*10000
      AND original.pharmacy_id=NEW.pharmacy_id
      AND CAST(original.created_by AS TEXT)=p.actor_id
      AND typeof(original.total_amount) IN ('integer','real')
      AND abs(original.total_amount*1000000-(p.sale_micros+p.cogs_micros))<2
      AND EXISTS(
        SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
        WHERE e.journal_id=p.journal_id GROUP BY e.journal_id
        HAVING count(*)=CASE WHEN p.cogs_micros>0 THEN 4 ELSE 2 END
          AND abs(sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END)
                 -sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END))<0.000001
          AND sum(CASE WHEN a.code='1.1.2' AND e.type='debit'
                       AND abs(e.amount*1000000-p.sale_micros)<1 THEN 1 ELSE 0 END)=1
          AND sum(CASE WHEN a.code='3.1' AND e.type='credit'
                       AND abs(e.amount*1000000-p.sale_micros)<1 THEN 1 ELSE 0 END)=1
          AND sum(CASE WHEN a.code='4.1' AND e.type='debit'
                       AND abs(e.amount*1000000-p.cogs_micros)<1 THEN 1 ELSE 0 END)
                   =CASE WHEN p.cogs_micros>0 THEN 1 ELSE 0 END
          AND sum(CASE WHEN a.code='1.1.3' AND e.type='credit'
                       AND abs(e.amount*1000000-p.cogs_micros)<1 THEN 1 ELSE 0 END)
                   =CASE WHEN p.cogs_micros>0 THEN 1 ELSE 0 END
      )
  );
  SELECT RAISE(ABORT,'Delivery collection actor or cash shift belongs to another pharmacy')
  WHERE NOT EXISTS(
    SELECT 1 FROM users u JOIN shifts sh ON sh.id=NEW.shift_id
    WHERE CAST(u.id AS TEXT)=NEW.actor_id AND u.pharmacy_id=NEW.pharmacy_id
      AND COALESCE(u.is_active,1)=1 AND sh.pharmacy_id=NEW.pharmacy_id
      AND sh.status='open'
  );
  SELECT RAISE(ABORT,'Delivery collection cash movement is missing or mismatched')
  WHERE NOT EXISTS(
    SELECT 1 FROM cash_movements m
    WHERE m.id=NEW.movement_id AND m.pharmacy_id=NEW.pharmacy_id
      AND CAST(m.user_id AS TEXT)=NEW.actor_id AND m.shift_id=NEW.shift_id
      AND m.type='receipt' AND m.category='delivery'
      AND m.source_type='delivery_collection'
      AND typeof(m.amount) IN ('real','integer')
      AND abs(m.amount*100-NEW.total_cents)<0.000001
  );
  SELECT RAISE(ABORT,'Delivery collection journal is not a balanced receivable transfer')
  WHERE NOT EXISTS(
    SELECT 1 FROM daily_journals j
    WHERE j.id=NEW.journal_id AND j.pharmacy_id=NEW.pharmacy_id
      AND CAST(j.created_by AS TEXT)=NEW.actor_id
      AND typeof(j.total_amount) IN ('real','integer')
      AND abs(j.total_amount*100-NEW.total_cents)<0.000001
      AND EXISTS (
        SELECT 1 FROM journal_entries e
        JOIN accounts a ON a.id=e.account_id
        WHERE e.journal_id=j.id GROUP BY e.journal_id
        HAVING count(*)=CASE WHEN NEW.sale_cents>0 AND NEW.fee_cents>0 THEN 3 ELSE 2 END
          AND abs(sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END)
                  -sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END))<0.000001
          AND sum(CASE WHEN a.code='1.1.1' AND a.type='asset'
                          AND COALESCE(a.is_group,0)=0 AND e.type='debit'
                          AND abs(e.amount*100-NEW.total_cents)<0.000001 THEN 1 ELSE 0 END)=1
          AND sum(CASE WHEN a.code='1.1.2' AND a.type='asset'
                          AND COALESCE(a.is_group,0)=0 AND e.type='credit'
                          AND abs(e.amount*100-NEW.sale_cents)<0.000001 THEN 1 ELSE 0 END)
                    =CASE WHEN NEW.sale_cents>0 THEN 1 ELSE 0 END
          AND sum(CASE WHEN a.code='3.2' AND a.type='revenue'
                          AND COALESCE(a.is_group,0)=0 AND e.type='credit'
                          AND abs(e.amount*100-NEW.fee_cents)<0.000001 THEN 1 ELSE 0 END)
                    =CASE WHEN NEW.fee_cents>0 THEN 1 ELSE 0 END
      )
  );
END;

-- The receipt's insert is the only authorization for 043's restricted status
-- transition. UPDATE is performed here, atomically, after source validation.
DROP TRIGGER native_sale_source_guard;
CREATE TRIGGER native_sale_source_guard
BEFORE UPDATE OF id,pharmacy_id,user_id,total_amount,payment_method,status ON sales_invoices
WHEN EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.sale_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT,'Receipted financial sale cannot be rewritten')
  WHERE NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id
    OR NEW.user_id IS NOT OLD.user_id OR NEW.total_amount IS NOT OLD.total_amount
    OR NEW.payment_method IS NOT OLD.payment_method
    OR (NEW.status IS NOT OLD.status AND NOT (
      OLD.status='completed' AND NEW.status='delivered'
      AND OLD.payment_method='delivery'
      AND EXISTS(SELECT 1 FROM native_delivery_collection_receipts c
                 WHERE c.sale_id=OLD.id AND c.pharmacy_id=OLD.pharmacy_id)
    ));
END;
CREATE TRIGGER native_delivery_collection_set_status
AFTER INSERT ON native_delivery_collection_receipts
BEGIN
  UPDATE sales_invoices SET status='delivered'
  WHERE id=NEW.sale_id AND pharmacy_id=NEW.pharmacy_id
    AND payment_method='delivery' AND status='completed';
  SELECT RAISE(ABORT,'Delivery status transition failed') WHERE changes()!=1;
END;

CREATE TRIGGER native_delivery_receipt_no_update BEFORE UPDATE ON native_delivery_collection_receipts
BEGIN SELECT RAISE(ABORT,'Delivery collection receipt is immutable'); END;
CREATE TRIGGER native_delivery_receipt_no_delete BEFORE DELETE ON native_delivery_collection_receipts
BEGIN SELECT RAISE(ABORT,'Delivery collection receipt cannot be deleted'); END;
CREATE TRIGGER native_delivery_journal_no_update BEFORE UPDATE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Delivery collection journal is immutable'); END;
CREATE TRIGGER native_delivery_journal_no_delete BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Delivery collection journal cannot be deleted'); END;
CREATE TRIGGER native_delivery_entry_no_update BEFORE UPDATE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Delivery collection entry is immutable'); END;
CREATE TRIGGER native_delivery_entry_no_delete BEFORE DELETE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Delivery collection entry cannot be deleted'); END;
CREATE TRIGGER native_delivery_entry_no_append BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.journal_id=NEW.journal_id)
BEGIN SELECT RAISE(ABORT,'Delivery collection journal cannot gain entries'); END;
CREATE TRIGGER native_delivery_movement_no_update BEFORE UPDATE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Delivery cash movement is immutable'); END;
CREATE TRIGGER native_delivery_movement_no_delete BEFORE DELETE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_delivery_collection_receipts r WHERE r.movement_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Delivery cash movement cannot be deleted'); END;
