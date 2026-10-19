-- SQLite INSERT OR REPLACE can delete a conflicting shift without firing
-- AFTER/BEFORE DELETE triggers while recursive_triggers=OFF. Block the
-- duplicate ID at BEFORE INSERT, before SQLite replaces the sealed shift.
-- Unreferenced/new shifts remain insertable; previous 054/057 are unchanged.
CREATE TRIGGER native_supplier_payment_shift_no_replace
BEFORE INSERT ON shifts
WHEN EXISTS (
  SELECT 1 FROM shifts existing
  JOIN cash_movements cm ON cm.shift_id=existing.id
  JOIN native_supplier_payment_receipts receipt ON receipt.cash_movement_id=cm.id
  WHERE existing.id=NEW.id
)
BEGIN
  SELECT RAISE(ABORT,'Receipted supplier cash shift cannot be replaced');
END;
