-- SQLite REPLACE suppresses DELETE triggers with recursive_triggers=OFF.
-- A second, unreceipted ledger row can make the 054 BEFORE INSERT financial
-- guard accept a forged balance_history on an existing bank receipt. Block
-- every UNIQUE-identity collision before REPLACE can delete the old receipt.
-- New UUID/request/ledger/journal/cash identities still post normally.
CREATE TRIGGER native_supplier_payment_receipt_no_replace
BEFORE INSERT ON native_supplier_payment_receipts
WHEN EXISTS (
  SELECT 1 FROM native_supplier_payment_receipts old
  WHERE old.id=NEW.id OR old.request_id=NEW.request_id
    OR old.supplier_transaction_id=NEW.supplier_transaction_id
    OR old.journal_id=NEW.journal_id
    OR (NEW.cash_movement_id IS NOT NULL
        AND old.cash_movement_id=NEW.cash_movement_id)
)
BEGIN
  SELECT RAISE(ABORT,'Receipted supplier payment identity cannot be replaced');
END;
