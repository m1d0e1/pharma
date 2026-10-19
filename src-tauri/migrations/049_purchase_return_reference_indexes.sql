-- Cover the existing 048 insert guards and fixed owner-only 041/048
-- reconciliation without scanning all supplier/cash transactions per return.
-- Index only; no changes to historical financial data or witness semantics.
CREATE INDEX IF NOT EXISTS idx_native_purchase_return_supplier_reference
  ON supplier_transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_native_purchase_return_cash_source
  ON cash_movements(source_type,target_name);
