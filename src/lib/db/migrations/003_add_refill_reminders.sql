-- Add refill_reminders table
-- Version: 003
-- Description: Add table for tracking refill reminders

CREATE TABLE IF NOT EXISTS refill_reminders (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    drug_id INTEGER NOT NULL,
    last_sold_date DATE NOT NULL,
    next_refill_date DATE NOT NULL,
    is_notified BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id),
    FOREIGN KEY (drug_id) REFERENCES master_drugs(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_refill_reminders_patient_id ON refill_reminders(patient_id);
CREATE INDEX IF NOT EXISTS idx_refill_reminders_drug_id ON refill_reminders(drug_id);
CREATE INDEX IF NOT EXISTS idx_refill_reminders_next_refill_date ON refill_reminders(next_refill_date);
