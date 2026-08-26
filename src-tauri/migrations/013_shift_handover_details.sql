-- Add handover audit and transfer columns to shifts
ALTER TABLE shifts ADD COLUMN actual_cash REAL;
ALTER TABLE shifts ADD COLUMN transfer_amount REAL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN transfer_target TEXT;
ALTER TABLE shifts ADD COLUMN cash_difference REAL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN receiver_id TEXT;
