ALTER TABLE sales_invoices ADD COLUMN points_redeemed INTEGER DEFAULT 0;
ALTER TABLE sales_invoices ADD COLUMN loyalty_discount_amount REAL DEFAULT 0;
