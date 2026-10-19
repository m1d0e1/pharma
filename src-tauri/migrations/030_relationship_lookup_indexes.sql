-- Keep packaged/Tauri relationship lookups aligned with the standalone index set.
-- These keys are used by accounting, purchase, and return hot paths and were
-- confirmed to full-scan on the production database before this migration.
CREATE INDEX IF NOT EXISTS idx_journal_entries_account
    ON journal_entries(account_id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_journal
    ON journal_entries(journal_id);

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_invoice
    ON purchase_invoice_items(invoice_id);

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_drug
    ON purchase_invoice_items(drug_id);

CREATE INDEX IF NOT EXISTS idx_return_items_return
    ON return_items(return_id);

CREATE INDEX IF NOT EXISTS idx_returns_invoice_id
    ON returns(invoice_id)
    WHERE invoice_id IS NOT NULL;
