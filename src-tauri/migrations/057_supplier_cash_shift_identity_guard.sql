-- 054 binds cash movements by exact UUID but did not seal the referenced
-- shift identity after it closed. Never infer historical cash associations:
-- guard only shifts referenced by immutable native 054 cash receipts.
CREATE TRIGGER native_supplier_payment_shift_no_rescope
BEFORE UPDATE OF id,pharmacy_id ON shifts
WHEN EXISTS (
  SELECT 1 FROM native_supplier_payment_receipts r
  JOIN cash_movements cm ON cm.id=r.cash_movement_id
  WHERE cm.shift_id=OLD.id
)
BEGIN
  SELECT RAISE(ABORT,'Receipted supplier cash shift identity is immutable');
END;

CREATE TRIGGER native_supplier_payment_shift_no_delete
BEFORE DELETE ON shifts
WHEN EXISTS (
  SELECT 1 FROM native_supplier_payment_receipts r
  JOIN cash_movements cm ON cm.id=r.cash_movement_id
  WHERE cm.shift_id=OLD.id
)
BEGIN
  SELECT RAISE(ABORT,'Receipted supplier cash shift is immutable');
END;
