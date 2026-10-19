-- Forward-only native purchase-return supplier/cash posting protection.
-- 041 has immutable return/journal witnesses, but did not seal the related
-- supplier_transactions or give old cash_movements a stable source key.
-- Protect reference_id relationships to existing 041 return receipts without
-- inventing cash ownership for historical rows lacking source_type/target_name.
-- Only receipts inserted AFTER this migration must pass both insert guards.

CREATE TRIGGER native_purchase_return_supplier_insert_guard
BEFORE INSERT ON native_purchase_return_provenance
BEGIN
  SELECT RAISE(ABORT,'Purchase return supplier ledger is not the exact refund')
  WHERE (SELECT COUNT(*) FROM supplier_transactions st
         WHERE st.reference_id=NEW.return_id)
       <>CASE WHEN NEW.refund_method='cash' THEN 2 ELSE 1 END
     OR (SELECT COUNT(*) FROM supplier_transactions st
         WHERE st.reference_id=NEW.return_id AND st.type='return'
           AND st.supplier_id=NEW.supplier_id
           AND typeof(st.amount) IN ('real','integer')
           AND abs(st.amount*100-NEW.amount_cents)<0.0001)<>1
     OR (NEW.refund_method='cash' AND
         (SELECT COUNT(*) FROM supplier_transactions st
          WHERE st.reference_id=NEW.return_id AND st.type='payment'
            AND st.supplier_id=NEW.supplier_id
            AND typeof(st.amount) IN ('real','integer')
            AND abs(st.amount*100+NEW.amount_cents)<0.0001)<>1);
END;

CREATE TRIGGER native_purchase_return_cash_insert_guard
BEFORE INSERT ON native_purchase_return_provenance
BEGIN
  SELECT RAISE(ABORT,'Purchase return cash receipt is missing or mismatched')
  WHERE (SELECT COUNT(*) FROM cash_movements cm
         WHERE cm.source_type='purchase_return' AND cm.target_name=NEW.return_id)
          <>CASE WHEN NEW.refund_method='cash' THEN 1 ELSE 0 END
     OR (NEW.refund_method='cash' AND NOT EXISTS (
          SELECT 1 FROM cash_movements cm
          LEFT JOIN shifts sh ON sh.id=cm.shift_id
          WHERE cm.source_type='purchase_return'
            AND cm.target_name=NEW.return_id
            AND cm.category='purchase_return' AND cm.type='receipt'
            AND CAST(cm.user_id AS TEXT)=NEW.actor_id
            AND cm.pharmacy_id=NEW.pharmacy_id
            AND sh.pharmacy_id=NEW.pharmacy_id
            AND lower(trim(sh.status))='open'
            AND typeof(cm.amount) IN ('real','integer')
            AND abs(cm.amount*100-NEW.amount_cents)<0.0001
      ));
END;

-- A 041 return_id already identifies its supplier ledger rows by a complete
-- reference_id. Freeze rows that survive migration; do not infer absent rows
-- or attest to their correctness before the new insert guard.
CREATE TRIGGER native_purchase_return_supplier_no_update
BEFORE UPDATE ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p
            WHERE p.return_id=OLD.reference_id OR p.return_id=NEW.reference_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return supplier transaction is immutable'); END;
CREATE TRIGGER native_purchase_return_supplier_no_delete
BEFORE DELETE ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p
            WHERE p.return_id=OLD.reference_id)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return supplier transaction cannot be deleted'); END;
CREATE TRIGGER native_purchase_return_supplier_no_extra
BEFORE INSERT ON supplier_transactions
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p
            WHERE p.return_id=NEW.reference_id)
BEGIN SELECT RAISE(ABORT,'Cannot append supplier transactions to receipted purchase return'); END;

-- Cash identity is verified only for newly recorded source links. Old 041
-- cash receipts had no purchase return ID on their movement and remain
-- historical claims, even if note text resembles a return.
CREATE TRIGGER native_purchase_return_cash_no_update
BEFORE UPDATE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_purchase_return_provenance p
            WHERE OLD.source_type='purchase_return' AND p.return_id=OLD.target_name)
  OR EXISTS(SELECT 1 FROM native_purchase_return_provenance p
            WHERE NEW.source_type='purchase_return' AND p.return_id=NEW.target_name)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return cash movement is immutable'); END;
CREATE TRIGGER native_purchase_return_cash_no_delete
BEFORE DELETE ON cash_movements
WHEN OLD.source_type='purchase_return'
  AND EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.return_id=OLD.target_name)
BEGIN SELECT RAISE(ABORT,'Receipted purchase return cash movement cannot be deleted'); END;
CREATE TRIGGER native_purchase_return_cash_no_extra
BEFORE INSERT ON cash_movements
WHEN NEW.source_type='purchase_return'
  AND EXISTS(SELECT 1 FROM native_purchase_return_provenance p WHERE p.return_id=NEW.target_name)
BEGIN SELECT RAISE(ABORT,'Cannot append cash movements to receipted purchase return'); END;
