-- Add missing fields to master_drugs table for POS compatibility
-- Version: 002
-- Description: Add trade_name, active_ingredient, and official_price fields

-- Add new columns to master_drugs table
ALTER TABLE master_drugs ADD COLUMN trade_name TEXT;
ALTER TABLE master_drugs ADD COLUMN active_ingredient TEXT;
ALTER TABLE master_drugs ADD COLUMN official_price REAL DEFAULT 0;

-- Create index for trade_name search
CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name ON master_drugs(trade_name);
CREATE INDEX IF NOT EXISTS idx_master_drugs_active_ingredient ON master_drugs(active_ingredient);

-- Update existing records to populate new fields from existing columns
UPDATE master_drugs SET trade_name = name_en WHERE trade_name IS NULL;
UPDATE master_drugs SET active_ingredient = generic_name WHERE active_ingredient IS NULL;
