-- Prospective, evidence-only protection for specifically registered ORIGINAL
-- legacy detail/ledger identities. Migration 065/066 remains checksum-frozen.
-- Nothing is backfilled or registered by this migration; no historical tenant,
-- payment, supplier, patient or inventory ownership is established.
--
-- Registration must be performed only by an independently trusted reviewer
-- who FIRST recomputes a canonical typed whole-row snapshot SHA-256 from the
-- original historical source and verifies detached evidence independently.
-- SQLite cannot verify SHA-256 contents, detached signatures, genuine source
-- age, or actor consent: this registry is an immutable witness, not a grant.
-- Each child must still be linked to a source mapped in a *sealed* 065 manifest.
--
-- Deliberately exclude mutable master balances and live registers (patients,
-- suppliers, shifts, drugs). Freezing their existing IDs would obstruct modern
-- business operations; unregistered historical rows remain an open limitation.
-- Fixed whitelist below contains integer-PK detail/ledger records plus
-- TEXT-PK patient_transactions. Never derive SQL table names from registry data.

CREATE TABLE native_legacy_original_detail_rows (
  source_table TEXT NOT NULL CHECK(source_table IN (
    'sales_items', 'purchase_invoice_items', 'purchase_order_items',
    'return_items', 'journal_entries', 'supplier_transactions',
    'patient_transactions'
  )),
  source_record_id TEXT NOT NULL CHECK(
    length(source_record_id) BETWEEN 1 AND 128
    AND source_record_id=trim(source_record_id)
    AND source_record_id NOT GLOB '*[^ -~]*'
  ),
  manifest_sha256 TEXT NOT NULL
    REFERENCES native_legacy_upgrade_manifest_seals(manifest_sha256),
  source_snapshot_sha256 TEXT NOT NULL CHECK(
    length(source_snapshot_sha256)=64
    AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    AND source_snapshot_sha256<>printf('%064d',0)
  ),
  source_evidence_ref TEXT NOT NULL CHECK(
    length(source_evidence_ref) BETWEEN 16 AND 512
    AND source_evidence_ref=trim(source_evidence_ref)
  ),
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_table,source_record_id)
) WITHOUT ROWID;

CREATE INDEX idx_legacy_original_detail_manifest
  ON native_legacy_original_detail_rows(manifest_sha256,source_table);

-- No implicit "belongs to this tenant" inference. A candidate can be
-- registered ONLY with an existing 065 sealed manifest and an exact existing
-- child FK to a parent already mapped to that SAME manifest. The supplier and
-- patient transaction tables have no directly mapped parent; only an original
-- invoice referencing the very same supplier/patient can be an anchor.
-- Actual historical provenance must be checked BEFORE registry INSERT; the
-- SQL guards alone cannot distinguish an old child from a newer appended row.
CREATE TRIGGER native_legacy_original_detail_register_guard
BEFORE INSERT ON native_legacy_original_detail_rows
BEGIN
  SELECT RAISE(ABORT,'Original detail registration cannot replace existing proof')
  WHERE EXISTS (
    SELECT 1 FROM native_legacy_original_detail_rows prior
    WHERE prior.source_table=NEW.source_table
      AND prior.source_record_id=NEW.source_record_id
  );
  SELECT RAISE(ABORT,'Original detail registration requires sealed 065 source evidence')
  WHERE NOT EXISTS (
    SELECT 1 FROM native_legacy_upgrade_manifest_seals seal
    JOIN native_legacy_upgrade_manifests manifest
      ON manifest.manifest_sha256=seal.manifest_sha256
    WHERE seal.manifest_sha256=NEW.manifest_sha256
  );
  SELECT RAISE(ABORT,'Original detail identity or mapped parent is absent')
  WHERE NOT (
    (NEW.source_table='sales_items'
      AND EXISTS (
        SELECT 1 FROM sales_items child
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='sales_invoices'
         AND parent.source_record_id=child.invoice_id
        WHERE CAST(child.id AS TEXT)=NEW.source_record_id
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
    OR (NEW.source_table='purchase_invoice_items'
      AND EXISTS (
        SELECT 1 FROM purchase_invoice_items child
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='purchase_invoices'
         AND parent.source_record_id=child.invoice_id
        WHERE CAST(child.id AS TEXT)=NEW.source_record_id
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
    OR (NEW.source_table='purchase_order_items'
      AND EXISTS (
        SELECT 1 FROM purchase_order_items child
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='purchase_orders'
         AND parent.source_record_id=child.po_id
        WHERE CAST(child.id AS TEXT)=NEW.source_record_id
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
    OR (NEW.source_table='return_items'
      AND EXISTS (
        SELECT 1 FROM return_items child
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='returns'
         AND parent.source_record_id=child.return_id
        WHERE CAST(child.id AS TEXT)=NEW.source_record_id
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
    OR (NEW.source_table='journal_entries'
      AND EXISTS (
        SELECT 1 FROM journal_entries child
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='daily_journals'
         AND parent.source_record_id=child.journal_id
        WHERE CAST(child.id AS TEXT)=NEW.source_record_id
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
    OR (NEW.source_table='supplier_transactions'
      AND EXISTS (
        SELECT 1 FROM supplier_transactions child
        JOIN purchase_invoices invoice ON invoice.supplier_id=child.supplier_id
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='purchase_invoices'
         AND parent.source_record_id=invoice.id
        WHERE CAST(child.id AS TEXT)=NEW.source_record_id
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
    OR (NEW.source_table='patient_transactions'
      AND EXISTS (
        SELECT 1 FROM patient_transactions child
        JOIN sales_invoices invoice ON invoice.patient_id=child.patient_id
        JOIN native_legacy_upgrade_source_mappings parent
          ON parent.source_table='sales_invoices'
         AND parent.source_record_id=invoice.id
        WHERE child.id=NEW.source_record_id
          AND typeof(child.id)='text'
          AND parent.manifest_sha256=NEW.manifest_sha256
      ))
  );
END;

-- SQL-level immutable registry and REPLACE defense, even when
-- PRAGMA recursive_triggers=OFF. Never allow removing/changing a registration
-- to reactivate an originally protected row.
CREATE TRIGGER native_legacy_original_detail_no_update
BEFORE UPDATE ON native_legacy_original_detail_rows
BEGIN SELECT RAISE(ABORT,'Registered original detail evidence is immutable'); END;
CREATE TRIGGER native_legacy_original_detail_no_delete
BEFORE DELETE ON native_legacy_original_detail_rows
BEGIN SELECT RAISE(ABORT,'Registered original detail evidence cannot be deleted'); END;

-- Complete-row UPDATE (including apparent no-ops), DELETE, and same-ID
-- INSERT OR REPLACE are disallowed. New/unregistered child rows retain normal
-- native application rules and are NEVER globally frozen.

CREATE TRIGGER native_legacy_original_sales_items_update
BEFORE UPDATE ON sales_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='sales_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original sales item is immutable'); END;
CREATE TRIGGER native_legacy_original_sales_items_delete
BEFORE DELETE ON sales_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='sales_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original sales item cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_sales_items_insert
BEFORE INSERT ON sales_items
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM native_legacy_original_detail_rows p
  WHERE p.source_table='sales_items' AND p.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original sales item cannot be replaced'); END;

CREATE TRIGGER native_legacy_original_purchase_invoice_items_update
BEFORE UPDATE ON purchase_invoice_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='purchase_invoice_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original purchase item is immutable'); END;
CREATE TRIGGER native_legacy_original_purchase_invoice_items_delete
BEFORE DELETE ON purchase_invoice_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='purchase_invoice_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original purchase item cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_purchase_invoice_items_insert
BEFORE INSERT ON purchase_invoice_items
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM native_legacy_original_detail_rows p
  WHERE p.source_table='purchase_invoice_items' AND p.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original purchase item cannot be replaced'); END;

CREATE TRIGGER native_legacy_original_purchase_order_items_update
BEFORE UPDATE ON purchase_order_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='purchase_order_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original purchase-order item is immutable'); END;
CREATE TRIGGER native_legacy_original_purchase_order_items_delete
BEFORE DELETE ON purchase_order_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='purchase_order_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original purchase-order item cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_purchase_order_items_insert
BEFORE INSERT ON purchase_order_items
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM native_legacy_original_detail_rows p
  WHERE p.source_table='purchase_order_items' AND p.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original purchase-order item cannot be replaced'); END;

CREATE TRIGGER native_legacy_original_return_items_update
BEFORE UPDATE ON return_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='return_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original return item is immutable'); END;
CREATE TRIGGER native_legacy_original_return_items_delete
BEFORE DELETE ON return_items
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='return_items'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original return item cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_return_items_insert
BEFORE INSERT ON return_items
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM native_legacy_original_detail_rows p
  WHERE p.source_table='return_items' AND p.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original return item cannot be replaced'); END;

CREATE TRIGGER native_legacy_original_journal_entries_update
BEFORE UPDATE ON journal_entries
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='journal_entries'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original journal entry is immutable'); END;
CREATE TRIGGER native_legacy_original_journal_entries_delete
BEFORE DELETE ON journal_entries
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='journal_entries'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original journal entry cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_journal_entries_insert
BEFORE INSERT ON journal_entries
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM native_legacy_original_detail_rows p
  WHERE p.source_table='journal_entries' AND p.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original journal entry cannot be replaced'); END;

CREATE TRIGGER native_legacy_original_supplier_transactions_update
BEFORE UPDATE ON supplier_transactions
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='supplier_transactions'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original supplier transaction is immutable'); END;
CREATE TRIGGER native_legacy_original_supplier_transactions_delete
BEFORE DELETE ON supplier_transactions
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='supplier_transactions'
               AND p.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original supplier transaction cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_supplier_transactions_insert
BEFORE INSERT ON supplier_transactions
WHEN NEW.id IS NOT NULL AND EXISTS (
  SELECT 1 FROM native_legacy_original_detail_rows p
  WHERE p.source_table='supplier_transactions' AND p.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Registered original supplier transaction cannot be replaced'); END;

CREATE TRIGGER native_legacy_original_patient_transactions_update
BEFORE UPDATE ON patient_transactions
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='patient_transactions' AND p.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Registered original patient transaction is immutable'); END;
CREATE TRIGGER native_legacy_original_patient_transactions_delete
BEFORE DELETE ON patient_transactions
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='patient_transactions' AND p.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Registered original patient transaction cannot be deleted'); END;
CREATE TRIGGER native_legacy_original_patient_transactions_insert
BEFORE INSERT ON patient_transactions
WHEN EXISTS (SELECT 1 FROM native_legacy_original_detail_rows p
             WHERE p.source_table='patient_transactions' AND p.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Registered original patient transaction cannot be replaced'); END;
