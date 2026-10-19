-- Prospective original-request and source-content custody for native draft
-- purchases. Existing 044 receipts are not backfilled or certified.
CREATE TABLE native_purchase_draft_create_witnesses (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES native_purchase_create_requests(request_id),
  invoice_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  pharmacy_id TEXT NOT NULL,
  original_request_sha256 TEXT NOT NULL CHECK(length(original_request_sha256)=64 AND original_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  original_source_sha256 TEXT NOT NULL CHECK(length(original_source_sha256)=64 AND original_source_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER native_purchase_draft_witness_guard BEFORE INSERT ON native_purchase_draft_create_witnesses
BEGIN
  SELECT RAISE(ABORT,'Draft creation witness has no authenticated original receipt')
  WHERE NOT EXISTS (
    SELECT 1 FROM native_purchase_create_requests r JOIN purchase_invoices p ON p.id=r.invoice_id
    WHERE r.request_id=NEW.request_id AND r.invoice_id=NEW.invoice_id
      AND r.actor_id=NEW.actor_id AND r.pharmacy_id=NEW.pharmacy_id
      AND r.source_status='draft' AND r.source_total_cents=0 AND r.initial_journal_id IS NULL
      AND p.pharmacy_id=NEW.pharmacy_id AND CAST(p.user_id AS TEXT)=NEW.actor_id
      AND p.status='draft'
      AND (SELECT count(*) FROM purchase_invoice_items i WHERE i.invoice_id=p.id)=r.source_line_count
  );
END;
CREATE TRIGGER native_purchase_draft_witness_no_update BEFORE UPDATE ON native_purchase_draft_create_witnesses
BEGIN SELECT RAISE(ABORT,'Original draft creation witness is immutable'); END;
CREATE TRIGGER native_purchase_draft_witness_no_delete BEFORE DELETE ON native_purchase_draft_create_witnesses
BEGIN SELECT RAISE(ABORT,'Original draft creation witness cannot be deleted'); END;
