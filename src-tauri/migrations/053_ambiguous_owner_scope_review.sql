-- 052 was installed on some QA databases before all finance/product tenant
-- evidence was considered. Its checksum is immutable. Quarantine any
-- potentially inferred original owner scope when another tenant exists
-- anywhere in the trusted native schema. An explicit, independently
-- authorized scope review is required before reinstating access.
CREATE TABLE IF NOT EXISTS native_owner_scope_review (
  owner_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO native_owner_scope_review(owner_id, reason)
SELECT CAST(u.id AS TEXT), 'Ambiguous legacy owner pharmacy assignment'
FROM users u
WHERE LOWER(COALESCE(u.role, '')) = 'owner'
  AND COALESCE(u.is_active, 1) = 1
  AND (
    NULLIF(TRIM(u.pharmacy_id), '') IS NULL
    OR (
      CAST(u.id AS TEXT) = 'admin'
      AND TRIM(COALESCE(u.pharmacy_id, '')) = 'local_default'
      AND (0
      OR EXISTS (SELECT 1 FROM users WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM inventory WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM sales_invoices WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM shifts WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM activity_log WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM returns WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM purchase_invoices WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM purchase_orders WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM banks WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM daily_journals WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM financial_notices WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM cash_movements WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM points_of_sale WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM expenses WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM commercial_papers WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM credit_cards WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM shortages WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM daily_financial_snapshots WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM patient_payment_scope WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM expense_posting_requests WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM commercial_paper_create_requests WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM financial_notice_native_scope WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM finance_device_create_requests WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM inventory_lot_create_requests WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM inventory_lot_create_acknowledgements WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM inventory_lot_import_receipts WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_stock_ledger_provenance WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_purchase_return_provenance WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_purchase_posting_events WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_sale_cogs_provenance WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_sale_return_cogs_provenance WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_sale_negative_settlement_provenance WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_purchase_create_requests WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_delivery_collection_receipts WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_purchase_zero_delta_stock_events WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_purchase_draft_create_witnesses WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      OR EXISTS (SELECT 1 FROM native_patient_financial_journal_receipts WHERE NULLIF(TRIM(pharmacy_id), '') IS NOT NULL AND TRIM(pharmacy_id) <> 'local_default')
      )
    )
  );

-- Marker changes require a reviewed, forward-only migration. No renderer
-- command may reset the quarantine or silently authorize another tenant.
CREATE TRIGGER IF NOT EXISTS native_owner_scope_review_no_update
BEFORE UPDATE ON native_owner_scope_review
BEGIN
  SELECT RAISE(ABORT, 'Owner scope review is immutable');
END;

CREATE TRIGGER IF NOT EXISTS native_owner_scope_review_no_delete
BEFORE DELETE ON native_owner_scope_review
BEGIN
  SELECT RAISE(ABORT, 'Owner scope review is immutable');
END;
