-- Forward-only receipts for native consumed-purchase quantity changes with
-- exactly zero financial delta. No new journal is created for a zero amount;
-- historical initial-journal evidence is referenced only when it exists.
CREATE TABLE native_purchase_zero_delta_stock_events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK(length(event_id)=36),
  invoice_id TEXT NOT NULL CHECK(length(invoice_id) BETWEEN 1 AND 256),
  actor_id TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL,
  supplier_id INTEGER NOT NULL CHECK(supplier_id>0),
  total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 1 AND 100000000000000),
  original_journal_id TEXT,
  line_snapshot TEXT NOT NULL CHECK(json_valid(line_snapshot) AND length(line_snapshot) BETWEEN 2 AND 131072),
  line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 200),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_purchase_zero_delta_source ON native_purchase_zero_delta_stock_events(pharmacy_id,invoice_id,recorded_at);
CREATE TRIGGER native_purchase_zero_delta_guard BEFORE INSERT ON native_purchase_zero_delta_stock_events BEGIN
  SELECT RAISE(ABORT,'Zero-delta purchase stock source/actor/tenant mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM purchase_invoices p JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
    WHERE p.id=NEW.invoice_id AND p.pharmacy_id=NEW.pharmacy_id
      AND p.supplier_id=NEW.supplier_id
      AND u.pharmacy_id=NEW.pharmacy_id AND COALESCE(u.is_active,1)=1
      AND p.status='completed' AND typeof(p.total_amount) IN ('integer','real')
      AND abs(p.total_amount*100-NEW.total_cents)<0.0001
  );
  SELECT RAISE(ABORT,'Zero-delta purchase source lines incomplete or malformed') WHERE
    json_type(NEW.line_snapshot)<>'array' OR json_array_length(NEW.line_snapshot)<>NEW.line_count
    OR (SELECT COUNT(*) FROM purchase_invoice_items WHERE invoice_id=NEW.invoice_id)<>NEW.line_count
    OR EXISTS (SELECT 1 FROM json_each(NEW.line_snapshot) j
      WHERE json_type(j.value)<>'object'
        OR json_type(j.value,'$.lineId')<>'integer'
        OR json_type(j.value,'$.inventoryId')<>'text'
        OR json_type(j.value,'$.oldReceived') NOT IN ('integer','real')
        OR json_type(j.value,'$.newReceived') NOT IN ('integer','real')
        OR json_type(j.value,'$.oldAvailable') NOT IN ('integer','real')
        OR json_type(j.value,'$.newAvailable') NOT IN ('integer','real')
        OR NOT EXISTS (
          SELECT 1 FROM purchase_invoice_items pi JOIN inventory i ON i.id=pi.inventory_id
          WHERE pi.id=json_extract(j.value,'$.lineId') AND pi.invoice_id=NEW.invoice_id
            AND i.id=json_extract(j.value,'$.inventoryId')
            AND i.pharmacy_id=NEW.pharmacy_id AND i.drug_id=pi.drug_id
            AND abs((pi.quantity+COALESCE(pi.bonus_quantity,0))-json_extract(j.value,'$.newReceived'))<0.000001
            AND abs(i.quantity-json_extract(j.value,'$.newAvailable'))<0.000001
        )
    );
  SELECT RAISE(ABORT,'Zero-delta purchase lines do not witness a changed quantity') WHERE
    NOT EXISTS (SELECT 1 FROM json_each(NEW.line_snapshot) j
      WHERE abs(json_extract(j.value,'$.newReceived')-json_extract(j.value,'$.oldReceived'))>0.000001);
  SELECT RAISE(ABORT,'Zero-delta purchase original journal cannot be established')
  WHERE NEW.original_journal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM native_purchase_posting_events e
    JOIN daily_journals dj ON dj.id=e.journal_id
    WHERE e.invoice_id=NEW.invoice_id AND e.event_kind='initial'
      AND e.journal_id=NEW.original_journal_id
      AND e.pharmacy_id=NEW.pharmacy_id
      AND dj.pharmacy_id=NEW.pharmacy_id
  );
END;
CREATE TRIGGER native_purchase_zero_delta_no_update BEFORE UPDATE ON native_purchase_zero_delta_stock_events
BEGIN SELECT RAISE(ABORT,'Zero-delta purchase stock evidence is immutable'); END;
CREATE TRIGGER native_purchase_zero_delta_no_delete BEFORE DELETE ON native_purchase_zero_delta_stock_events
BEGIN SELECT RAISE(ABORT,'Zero-delta purchase stock evidence cannot be deleted'); END;
