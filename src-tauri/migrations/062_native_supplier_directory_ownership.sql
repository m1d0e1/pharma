-- Prospective tenant ownership ONLY. Never backfill existing global suppliers,
-- NULL-pharmacy invoices, or shared historic supplier ledgers. The native
-- writer must create supplier + witness + audit in one BEGIN IMMEDIATE.
CREATE TABLE native_supplier_directory_ownership (
  supplier_id INTEGER PRIMARY KEY REFERENCES suppliers(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(length(trim(pharmacy_id)) BETWEEN 1 AND 128
    AND pharmacy_id=trim(pharmacy_id) AND lower(pharmacy_id)<>'local_default'),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 128 AND actor_id=trim(actor_id)),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_native_supplier_directory_tenant ON native_supplier_directory_ownership(pharmacy_id,supplier_id);

-- A witness can never be attached to an already-financially-used supplier,
-- and the creator must be an active, explicitly scoped owner/admin. The
-- trusted typed command alone proves the supplier was *newly inserted*.
CREATE TRIGGER native_supplier_owner_insert_guard BEFORE INSERT ON native_supplier_directory_ownership BEGIN
  SELECT RAISE(ABORT,'Supplier provenance requires a fresh zero-balance directory row')
  WHERE NOT EXISTS(SELECT 1 FROM suppliers s WHERE s.id=NEW.supplier_id AND typeof(s.balance) IN ('integer','real') AND s.balance=0)
    OR EXISTS(SELECT 1 FROM purchase_invoices p WHERE p.supplier_id=NEW.supplier_id)
    OR EXISTS(SELECT 1 FROM purchase_returns r WHERE r.supplier_id=NEW.supplier_id)
    OR EXISTS(SELECT 1 FROM supplier_transactions t WHERE t.supplier_id=NEW.supplier_id)
    OR EXISTS(SELECT 1 FROM native_supplier_directory_ownership old WHERE old.supplier_id=NEW.supplier_id OR old.request_id=NEW.request_id);
  SELECT RAISE(ABORT,'Supplier provenance actor must be explicitly tenant-owned')
  WHERE NOT EXISTS (
    SELECT 1 FROM users u WHERE CAST(u.id AS TEXT)=NEW.actor_id
      AND COALESCE(u.is_active,1)=1 AND lower(trim(u.role)) IN ('owner','admin')
      AND u.pharmacy_id=NEW.pharmacy_id
      AND NOT EXISTS (SELECT 1 FROM native_owner_scope_review review WHERE review.owner_id=NEW.actor_id)
  );
END;
CREATE TRIGGER native_supplier_owner_immutable_update BEFORE UPDATE ON native_supplier_directory_ownership
BEGIN SELECT RAISE(ABORT,'Supplier tenant provenance is immutable'); END;
CREATE TRIGGER native_supplier_owner_immutable_delete BEFORE DELETE ON native_supplier_directory_ownership
BEGIN SELECT RAISE(ABORT,'Supplier tenant provenance is immutable'); END;

-- Prevent SQLite INSERT OR REPLACE from dropping the witness or replacing a
-- previously owned supplier ID even when recursive_triggers=OFF.
CREATE TRIGGER native_supplier_owner_replace_guard BEFORE INSERT ON suppliers
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Owned supplier ID cannot be replaced'); END;
CREATE TRIGGER native_supplier_owner_delete_guard BEFORE DELETE ON suppliers
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Owned supplier cannot be deleted'); END;
CREATE TRIGGER native_supplier_owner_contact_guard BEFORE UPDATE ON suppliers
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.name_ar IS NOT OLD.name_ar
    OR NEW.name_en IS NOT OLD.name_en OR NEW.phone IS NOT OLD.phone
    OR NEW.address IS NOT OLD.address OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'Owned supplier directory is immutable without a typed update'); END;

-- The buyer/return actor and invoice must match the new supplier's *explicit*
-- owner tenant. Historic supplier IDs have no witness and retain old rules.
CREATE TRIGGER native_supplier_owned_purchase_insert BEFORE INSERT ON purchase_invoices
WHEN EXISTS (SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id
  AND (NEW.pharmacy_id IS NOT o.pharmacy_id OR NOT EXISTS(
    SELECT 1 FROM users u WHERE CAST(u.id AS TEXT)=CAST(NEW.user_id AS TEXT)
      AND COALESCE(u.is_active,1)=1 AND u.pharmacy_id=o.pharmacy_id)))
  OR (EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id)
    AND EXISTS(SELECT 1 FROM purchase_invoices old WHERE old.id=NEW.id))
  OR EXISTS (SELECT 1 FROM purchase_invoices old
    JOIN native_supplier_directory_ownership o ON o.supplier_id=old.supplier_id
    WHERE old.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Owned supplier purchase requires the owner pharmacy'); END;
CREATE TRIGGER native_supplier_owned_purchase_update BEFORE UPDATE ON purchase_invoices
WHEN EXISTS (SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id
  AND (NEW.pharmacy_id IS NOT o.pharmacy_id OR NOT EXISTS(
    SELECT 1 FROM users u WHERE CAST(u.id AS TEXT)=CAST(NEW.user_id AS TEXT)
      AND COALESCE(u.is_active,1)=1 AND u.pharmacy_id=o.pharmacy_id)))
  OR EXISTS (SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.supplier_id
    AND (NEW.supplier_id IS NOT OLD.supplier_id OR NEW.pharmacy_id IS NOT o.pharmacy_id
      OR NEW.id IS NOT OLD.id))
  OR (NEW.supplier_id IS NOT OLD.supplier_id AND EXISTS(
    SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id))
BEGIN SELECT RAISE(ABORT,'Owned supplier purchase cannot be reassigned'); END;
CREATE TRIGGER native_supplier_owned_posted_purchase_no_delete BEFORE DELETE ON purchase_invoices
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.supplier_id)
 AND EXISTS(SELECT 1 FROM native_purchase_posting_events e WHERE e.invoice_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Owned supplier posted invoice cannot be deleted'); END;

CREATE TRIGGER native_supplier_owned_return_insert BEFORE INSERT ON purchase_returns
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id
  AND NOT EXISTS(SELECT 1 FROM purchase_invoices p JOIN users u ON CAST(u.id AS TEXT)=CAST(NEW.user_id AS TEXT)
    WHERE p.id=NEW.purchase_invoice_id AND p.supplier_id=NEW.supplier_id
      AND p.pharmacy_id=o.pharmacy_id AND u.pharmacy_id=o.pharmacy_id AND COALESCE(u.is_active,1)=1))
  OR (EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id)
    AND EXISTS(SELECT 1 FROM purchase_returns old WHERE old.id=NEW.id))
  OR EXISTS(SELECT 1 FROM purchase_returns old JOIN native_supplier_directory_ownership o ON o.supplier_id=old.supplier_id
    WHERE old.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Owned supplier return requires an owned source invoice'); END;
CREATE TRIGGER native_supplier_owned_return_update BEFORE UPDATE ON purchase_returns
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.supplier_id
  OR o.supplier_id=NEW.supplier_id)
BEGIN SELECT RAISE(ABORT,'Owned supplier financial return is immutable'); END;
CREATE TRIGGER native_supplier_owned_return_delete BEFORE DELETE ON purchase_returns
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.supplier_id)
BEGIN SELECT RAISE(ABORT,'Owned supplier financial return cannot be deleted'); END;

-- Historical supplier ledger is unscoped. New owned entries must instead
-- point to a tenant-owned invoice/return. Native supplier payment's temporary
-- ledger entry precedes its typed receipt in the same transaction, so allow
-- only that narrowly shaped credit-invoice+actor witness. 054 still validates
-- the entire posting and aborts on missing/mismatched receipts.
CREATE TRIGGER native_supplier_owned_ledger_insert BEFORE INSERT ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM supplier_transactions old JOIN native_supplier_directory_ownership o ON o.supplier_id=old.supplier_id
  WHERE old.id=NEW.id)
 OR (EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id)
     AND EXISTS(SELECT 1 FROM supplier_transactions old WHERE old.id=NEW.id))
 OR (EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id)
 AND NOT EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id AND (
   (NEW.type IN ('invoice','payment') AND EXISTS(
     SELECT 1 FROM purchase_invoices p WHERE p.id=NEW.reference_id
       AND p.supplier_id=o.supplier_id AND p.pharmacy_id=o.pharmacy_id))
   OR (NEW.type IN ('return','payment') AND EXISTS(
     SELECT 1 FROM purchase_returns r JOIN purchase_invoices p ON p.id=r.purchase_invoice_id
     WHERE r.id=NEW.reference_id AND r.supplier_id=o.supplier_id
       AND p.supplier_id=o.supplier_id AND p.pharmacy_id=o.pharmacy_id))
   OR (NEW.type='payment' AND NEW.reference_id GLOB 'supplier-payment:*'
       AND NEW.user_id IS NOT NULL AND NEW.payment_method IN ('cash','bank')
       AND EXISTS(SELECT 1 FROM users u WHERE CAST(u.id AS TEXT)=CAST(NEW.user_id AS TEXT)
         AND COALESCE(u.is_active,1)=1 AND u.pharmacy_id=o.pharmacy_id)
       AND (SELECT COUNT(*) FROM purchase_invoices p WHERE p.supplier_id=o.supplier_id)=1
       AND EXISTS(SELECT 1 FROM purchase_invoices p JOIN native_purchase_create_requests c ON c.invoice_id=p.id
         WHERE p.supplier_id=o.supplier_id AND p.pharmacy_id=o.pharmacy_id
           AND p.status='completed' AND p.payment_method='credit' AND c.pharmacy_id=o.pharmacy_id))
 )))
BEGIN SELECT RAISE(ABORT,'Owned supplier ledger lacks owner-scoped source'); END;
CREATE TRIGGER native_supplier_owned_ledger_update BEFORE UPDATE ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.supplier_id OR o.supplier_id=NEW.supplier_id)
BEGIN SELECT RAISE(ABORT,'Owned supplier ledger is immutable'); END;
CREATE TRIGGER native_supplier_owned_ledger_delete BEFORE DELETE ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=OLD.supplier_id)
BEGIN SELECT RAISE(ABORT,'Owned supplier ledger cannot be deleted'); END;

CREATE TRIGGER native_supplier_owned_receipt_insert BEFORE INSERT ON native_supplier_payment_receipts
WHEN EXISTS(SELECT 1 FROM native_supplier_directory_ownership o WHERE o.supplier_id=NEW.supplier_id
 AND (o.pharmacy_id IS NOT NEW.pharmacy_id OR NOT EXISTS(
   SELECT 1 FROM users u WHERE CAST(u.id AS TEXT)=NEW.actor_id
     AND COALESCE(u.is_active,1)=1 AND u.pharmacy_id=o.pharmacy_id)))
BEGIN SELECT RAISE(ABORT,'Owned supplier receipt belongs to a different pharmacy'); END;
