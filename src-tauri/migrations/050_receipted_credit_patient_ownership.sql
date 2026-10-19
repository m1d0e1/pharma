-- Forward-only integrity guard. A native 043 credit-sale receipt establishes
-- the existing patient account relationship for future writes, but does not
-- authenticate the historical identity of a patient already changed before
-- this migration. Legacy sales without a 043 receipt remain for review.
CREATE TRIGGER native_receipted_credit_patient_no_reassignment
BEFORE UPDATE OF patient_id ON sales_invoices
WHEN OLD.payment_method='credit'
  AND EXISTS (
    SELECT 1 FROM native_sale_cogs_provenance p
    WHERE p.sale_id=OLD.id AND p.payment_method='credit'
  )
BEGIN
  SELECT RAISE(ABORT,'Receipted credit sale patient cannot be reassigned')
  WHERE NEW.patient_id IS NOT OLD.patient_id;
END;
