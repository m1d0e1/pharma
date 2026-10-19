-- Forward-only native purchase-create request replay evidence. A creation
-- request survives later legitimate edits/deletion of a draft or invoice.
-- No historic row or migration is changed/backfilled.
CREATE TABLE native_purchase_create_requests (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36),
  invoice_id TEXT NOT NULL UNIQUE CHECK(length(invoice_id) BETWEEN 1 AND 256),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
  pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128 AND trim(pharmacy_id)=pharmacy_id),
  supplier_id INTEGER NOT NULL CHECK(supplier_id>0),
  source_status TEXT NOT NULL CHECK(source_status IN ('draft','completed')),
  source_total_cents INTEGER NOT NULL CHECK(source_total_cents BETWEEN 0 AND 100000000000000),
  source_line_count INTEGER NOT NULL CHECK(source_line_count BETWEEN 0 AND 200),
  initial_journal_id TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((source_status='draft' AND source_total_cents=0 AND initial_journal_id IS NULL)
      OR (source_status='completed' AND source_total_cents>0 AND initial_journal_id IS NOT NULL))
);
CREATE INDEX idx_native_purchase_create_tenant ON native_purchase_create_requests(pharmacy_id,invoice_id);
CREATE TRIGGER native_purchase_create_request_guard BEFORE INSERT ON native_purchase_create_requests BEGIN
  SELECT RAISE(ABORT,'Purchase creation source, actor, tenant or amount does not match request')
  WHERE NOT EXISTS (
    SELECT 1 FROM purchase_invoices p JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
    WHERE p.id=NEW.invoice_id AND p.pharmacy_id=NEW.pharmacy_id
      AND CAST(p.user_id AS TEXT)=NEW.actor_id AND u.pharmacy_id=NEW.pharmacy_id
      AND COALESCE(u.is_active,1)=1 AND p.supplier_id=NEW.supplier_id
      AND p.status=NEW.source_status AND typeof(p.total_amount) IN ('integer','real')
      AND abs(p.total_amount*100-NEW.source_total_cents)<0.0001
      AND (SELECT COUNT(*) FROM purchase_invoice_items i WHERE i.invoice_id=p.id)=NEW.source_line_count
  );
  SELECT RAISE(ABORT,'Purchase creation journal is not its native initial posting')
  WHERE NEW.source_status='completed' AND NOT EXISTS (
    SELECT 1 FROM native_purchase_posting_events e
    JOIN daily_journals j ON j.id=e.journal_id
    WHERE e.invoice_id=NEW.invoice_id AND e.actor_id=NEW.actor_id
      AND e.pharmacy_id=NEW.pharmacy_id AND e.event_kind='initial'
      AND e.journal_id=NEW.initial_journal_id
      AND e.new_total_cents=NEW.source_total_cents
      AND j.pharmacy_id=NEW.pharmacy_id
  );
END;
CREATE TRIGGER native_purchase_create_request_no_update BEFORE UPDATE ON native_purchase_create_requests
BEGIN SELECT RAISE(ABORT,'Purchase creation request evidence is immutable'); END;
CREATE TRIGGER native_purchase_create_request_no_delete BEFORE DELETE ON native_purchase_create_requests
BEGIN SELECT RAISE(ABORT,'Purchase creation request evidence cannot be deleted'); END;
