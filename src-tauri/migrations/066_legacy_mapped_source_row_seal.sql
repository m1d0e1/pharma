-- Forward-only hardening for 065's prospective, independently reviewed
-- evidence-only source mappings. Migration 065 is checksum-frozen.
-- Prevent ALL updates to a mapped source row, including stock quantity,
-- monetary fields, timestamps, history, and apparent no-op updates.
-- Existing 065 source-id/tenant UPDATE, DELETE, and INSERT/REPLACE guards
-- continue to enforce their original protections. This migration creates
-- no grants, source mappings, seals, receipts, or source-row changes.
-- Triggers fire after any mapping is recorded, not just after final seal:
-- changes to a pending mapped snapshot must also be refused.
-- Physical table names are a fixed 065 whitelist, never dynamic SQL.

CREATE TRIGGER native_legacy_upgrade_inventory_payload_no_update
BEFORE UPDATE ON inventory
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='inventory' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_sales_invoices_payload_no_update
BEFORE UPDATE ON sales_invoices
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='sales_invoices' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_purchase_invoices_payload_no_update
BEFORE UPDATE ON purchase_invoices
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='purchase_invoices' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_returns_payload_no_update
BEFORE UPDATE ON returns
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='returns' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_activity_log_payload_no_update
BEFORE UPDATE ON activity_log
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='activity_log' AND proof.source_record_id=CAST(OLD.id AS TEXT)
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_shortages_payload_no_update
BEFORE UPDATE ON shortages
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='shortages' AND proof.source_record_id=CAST(OLD.id AS TEXT)
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_purchase_orders_payload_no_update
BEFORE UPDATE ON purchase_orders
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='purchase_orders' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_cash_movements_payload_no_update
BEFORE UPDATE ON cash_movements
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='cash_movements' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_daily_journals_payload_no_update
BEFORE UPDATE ON daily_journals
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='daily_journals' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_expenses_payload_no_update
BEFORE UPDATE ON expenses
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='expenses' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

CREATE TRIGGER native_legacy_upgrade_financial_notices_payload_no_update
BEFORE UPDATE ON financial_notices
WHEN EXISTS (
    SELECT 1 FROM native_legacy_upgrade_source_mappings AS proof
    WHERE proof.source_table='financial_notices' AND proof.source_record_id=OLD.id
)
BEGIN
    SELECT RAISE(ABORT,'Mapped legacy source row sealed against every UPDATE');
END;

