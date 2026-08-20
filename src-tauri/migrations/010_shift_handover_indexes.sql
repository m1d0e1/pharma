-- 010_shift_handover_indexes.sql
-- Composite indexes for shift handover acceleration

CREATE INDEX IF NOT EXISTS idx_sales_invoices_shift_status_pay ON sales_invoices(shift_id, status, payment_method);
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift_type ON cash_movements(shift_id, type);
CREATE INDEX IF NOT EXISTS idx_returns_shift_status_refund ON returns(shift_id, status, refund_method);