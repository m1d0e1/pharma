-- Forward-only migration 042: durable native purchase posting events.
-- The invoice is intentionally NOT an FK: a later legitimate full edit or
-- reversal may replace/delete mutable invoice lines. Historical events remain.
CREATE TABLE IF NOT EXISTS native_purchase_posting_events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK(length(event_id)=36),
  invoice_id TEXT NOT NULL CHECK(length(invoice_id) BETWEEN 1 AND 256),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128),
  pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128 AND trim(pharmacy_id)=pharmacy_id),
  supplier_id INTEGER NOT NULL CHECK(supplier_id>0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('initial','edit_delta','reverse')),
  journal_id TEXT NOT NULL UNIQUE,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','credit','check')),
  signed_cents INTEGER NOT NULL CHECK(signed_cents BETWEEN -100000000000000 AND 100000000000000 AND signed_cents<>0),
  old_total_cents INTEGER NOT NULL CHECK(old_total_cents BETWEEN 0 AND 100000000000000),
  new_total_cents INTEGER NOT NULL CHECK(new_total_cents BETWEEN 0 AND 100000000000000),
  -- Independent immutable source-line witness, captured before legacy edits
  -- delete/recreate lines. A snapshot is evidence of what native SQL read,
  -- not a signature authenticating data before migration 043.
  line_snapshot TEXT NOT NULL CHECK(length(line_snapshot) BETWEEN 2 AND 131072 AND json_valid(line_snapshot)),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(journal_id) REFERENCES daily_journals(id) ON DELETE RESTRICT,
  CHECK(
    (event_kind='initial' AND old_total_cents=0 AND signed_cents=new_total_cents)
    OR (event_kind='edit_delta' AND new_total_cents-old_total_cents=signed_cents)
    OR (event_kind='reverse' AND new_total_cents=0 AND signed_cents=-old_total_cents)
  )
);
CREATE INDEX IF NOT EXISTS idx_native_purchase_event_source
  ON native_purchase_posting_events(invoice_id, event_id);
CREATE INDEX IF NOT EXISTS idx_native_purchase_event_tenant
  ON native_purchase_posting_events(pharmacy_id, recorded_at);

CREATE TRIGGER IF NOT EXISTS native_purchase_posting_insert_guard
BEFORE INSERT ON native_purchase_posting_events
BEGIN
  SELECT RAISE(ABORT,'Purchase posting actor/tenant/invoice mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM users u JOIN purchase_invoices p
      ON p.id=NEW.invoice_id
    WHERE CAST(u.id AS TEXT)=NEW.actor_id AND COALESCE(u.is_active,1)=1
      AND u.pharmacy_id=NEW.pharmacy_id AND trim(u.pharmacy_id)<>''
      AND p.pharmacy_id=NEW.pharmacy_id AND p.supplier_id=NEW.supplier_id
      AND lower(trim(p.status))='completed'
  );
  SELECT RAISE(ABORT,'Purchase posting journal owner/scope/amount mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM daily_journals j
    WHERE j.id=NEW.journal_id AND j.pharmacy_id=NEW.pharmacy_id
      AND CAST(j.created_by AS TEXT)=NEW.actor_id
      AND typeof(j.total_amount) IN ('integer','real')
      AND abs(j.total_amount*100-abs(NEW.signed_cents))<0.0001
  );
  SELECT RAISE(ABORT,'Purchase posting journal is not two-sided inventory accounting')
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
    WHERE e.journal_id=NEW.journal_id
    GROUP BY e.journal_id
    HAVING count(*)=2
      AND sum(CASE WHEN a.code='1.1.3' AND
         e.type=(CASE WHEN NEW.signed_cents>0 THEN 'debit' ELSE 'credit' END)
         THEN 1 ELSE 0 END)=1
      AND sum(CASE WHEN a.code=(CASE WHEN NEW.payment_method='cash' THEN '1.1.1' ELSE '2.1' END)
          AND e.type=(CASE WHEN NEW.signed_cents>0 THEN 'credit' ELSE 'debit' END)
          THEN 1 ELSE 0 END)=1
      AND sum(CASE WHEN typeof(e.amount) IN ('integer','real')
          AND abs(e.amount*100-abs(NEW.signed_cents))<0.0001
          THEN 1 ELSE 0 END)=2
  );
  SELECT RAISE(ABORT,'Purchase source snapshot missing original invoice lines')
  WHERE json_type(NEW.line_snapshot)<>'array'
     OR json_array_length(NEW.line_snapshot)>200
     OR json_array_length(NEW.line_snapshot)=0
     OR (SELECT count(*) FROM purchase_invoice_items WHERE invoice_id=NEW.invoice_id)
       <>json_array_length(NEW.line_snapshot);
END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_no_update
BEFORE UPDATE ON native_purchase_posting_events
BEGIN SELECT RAISE(ABORT,'Native purchase posting event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_no_delete
BEFORE DELETE ON native_purchase_posting_events
BEGIN SELECT RAISE(ABORT,'Native purchase posting event cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_journal_no_update
BEFORE UPDATE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_purchase_posting_events p WHERE p.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase journal is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_journal_no_delete
BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_purchase_posting_events p WHERE p.journal_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase journal cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_entry_no_update
BEFORE UPDATE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_purchase_posting_events p WHERE p.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase journal entry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_entry_no_delete
BEFORE DELETE ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_purchase_posting_events p WHERE p.journal_id=OLD.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase journal entry cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS native_purchase_event_entry_no_extra
BEFORE INSERT ON journal_entries
WHEN EXISTS(SELECT 1 FROM native_purchase_posting_events p WHERE p.journal_id=NEW.journal_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase journal cannot gain extra entries'); END;
