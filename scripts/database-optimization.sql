-- Database Optimization Script for Pharma Tech SaaS
-- This script creates recommended indexes for optimal query performance

-- ==========================================
-- 1. INVENTORY TABLE OPTIMIZATIONS
-- ==========================================

-- Index for pharmacy-scoped queries (most common)
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_id ON inventory(pharmacy_id);

-- Composite index for pharmacy + drug lookups
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_drug ON inventory(pharmacy_id, master_drug_id);

-- Index for expiry date queries (for expiry alerts)
CREATE INDEX IF NOT EXISTS idx_inventory_expiry_date ON inventory(expiry_date) WHERE quantity > 0;

-- Composite index for low stock queries (pharmacy + quantity)
CREATE INDEX IF NOT EXISTS idx_inventory_low_stock ON inventory(pharmacy_id, quantity) WHERE quantity < 10;

-- Index for barcode lookups (if barcode scanning is used)
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode) WHERE barcode IS NOT NULL;

-- Index for pharmacy + expiry date (for expiry widget)
CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_expiry ON inventory(pharmacy_id, expiry_date) WHERE quantity > 0;

-- ==========================================
-- 2. SALES_INVOICES TABLE OPTIMIZATIONS
-- ==========================================

-- Index for pharmacy-scoped invoice queries
CREATE INDEX IF NOT EXISTS idx_sales_invoices_pharmacy_id ON sales_invoices(pharmacy_id);

-- Index for date range queries (reports dashboard)
CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_at ON sales_invoices(created_at);

-- Composite index for pharmacy + date queries (most reports)
CREATE INDEX IF NOT EXISTS idx_sales_invoices_pharmacy_date ON sales_invoices(pharmacy_id, created_at);

-- Index for user performance tracking
CREATE INDEX IF NOT EXISTS idx_sales_invoices_user_id ON sales_invoices(user_id);

-- Index for patient invoice history
CREATE INDEX IF NOT EXISTS idx_sales_invoices_patient_id ON sales_invoices(patient_id) WHERE patient_id IS NOT NULL;

-- ==========================================
-- 3. SALES_ITEMS TABLE OPTIMIZATIONS
-- ==========================================

-- Index for invoice item lookups
CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_id ON sales_items(invoice_id);

-- Index for inventory item sales history
CREATE INDEX IF NOT EXISTS idx_sales_items_inventory_id ON sales_items(inventory_id);

-- Composite index for sales analysis (invoice + inventory)
CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_inventory ON sales_items(invoice_id, inventory_id);

-- ==========================================
-- 4. PATIENTS TABLE OPTIMIZATIONS
-- ==========================================

-- Index for pharmacy-scoped patient queries
CREATE INDEX IF NOT EXISTS idx_patients_pharmacy_id ON patients(pharmacy_id);

-- Index for phone number lookups (quick patient search)
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone) WHERE phone IS NOT NULL;

-- Index for patient name searches
CREATE INDEX IF NOT EXISTS idx_patients_full_name ON patients(full_name);

-- Composite index for pharmacy + name searches
CREATE INDEX IF NOT EXISTS idx_patients_pharmacy_name ON patients(pharmacy_id, full_name);

-- ==========================================
-- 5. PROFILES TABLE OPTIMIZATIONS
-- ==========================================

-- Index for pharmacy staff lookups
CREATE INDEX IF NOT EXISTS idx_profiles_pharmacy_id ON profiles(pharmacy_id);

-- Index for role-based access control
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- Composite index for pharmacy + role queries
CREATE INDEX IF NOT EXISTS idx_profiles_pharmacy_role ON profiles(pharmacy_id, role);

-- ==========================================
-- 6. MASTER_DRUGS TABLE OPTIMIZATIONS
-- ==========================================

-- Index for drug name searches
CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name ON master_drugs(trade_name);

-- Index for active ingredient searches
CREATE INDEX IF NOT EXISTS idx_master_drugs_active_ingredient ON master_drugs(active_ingredient);

-- Index for category filtering
CREATE INDEX IF NOT EXISTS idx_master_drugs_category ON master_drugs(category);

-- Full-text search index for comprehensive drug search
CREATE INDEX IF NOT EXISTS idx_master_drugs_search ON master_drugs USING gin(
    to_tsvector('english', trade_name || ' ' || active_ingredient || ' ' || category)
);

-- ==========================================
-- 7. REFILL_REMINDERS TABLE OPTIMIZATIONS
-- ==========================================

-- Index for patient refill reminders
CREATE INDEX IF NOT EXISTS idx_refill_reminders_patient_id ON refill_reminders(patient_id);

-- Index for status-based queries (pending reminders)
CREATE INDEX IF NOT EXISTS idx_refill_reminders_status ON refill_reminders(status);

-- Index for next refill date (upcoming reminders)
CREATE INDEX IF NOT EXISTS idx_refill_reminders_next_date ON refill_reminders(next_refill_date) WHERE status = 'pending';

-- Composite index for patient + status queries
CREATE INDEX IF NOT EXISTS idx_refill_reminders_patient_status ON refill_reminders(patient_id, status);

-- ==========================================
-- 8. WHATSAPP_LOGS TABLE OPTIMIZATIONS
-- ==========================================

-- Index for user activity tracking
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_user_id ON whatsapp_logs(user_id);

-- Index for timestamp-based queries
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_created_at ON whatsapp_logs(created_at);

-- ==========================================
-- 9. PERFORMANCE-SPECIFIC OPTIMIZATIONS
-- ==========================================

-- Materialized view for daily sales summary (refreshed hourly)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_sales_summary AS
SELECT 
    pharmacy_id,
    DATE(created_at) as sale_date,
    COUNT(*) as transaction_count,
    SUM(total_amount) as total_revenue,
    AVG(total_amount) as average_basket_size
FROM sales_invoices
WHERE created_at >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY pharmacy_id, DATE(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_sales_summary ON mv_daily_sales_summary(pharmacy_id, sale_date);

-- Materialized view for inventory summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_inventory_summary AS
SELECT 
    i.pharmacy_id,
    md.category,
    COUNT(*) as total_items,
    SUM(i.quantity) as total_quantity,
    SUM(i.quantity * i.local_selling_price) as total_value,
    COUNT(CASE WHEN i.quantity < 5 THEN 1 END) as low_stock_items,
    COUNT(CASE WHEN i.expiry_date <= CURRENT_DATE + INTERVAL '30 days' THEN 1 END) as expiring_soon_items
FROM inventory i
JOIN master_drugs md ON i.master_drug_id = md.id
WHERE i.quantity > 0
GROUP BY i.pharmacy_id, md.category;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_inventory_summary ON mv_inventory_summary(pharmacy_id, category);

-- ==========================================
-- 10. QUERY PERFORMANCE MONITORING
-- ==========================================

-- Function to identify missing indexes
CREATE OR REPLACE FUNCTION suggest_missing_indexes()
RETURNS TABLE(
    table_name text,
    column_name text,
    usage_count bigint,
    query_example text
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        schemaname || '.' || relname as table_name,
        attname as column_name,
        seq_scan as usage_count,
        'SELECT * FROM ' || schemaname || '.' || relname || ' WHERE ' || attname || ' = ?' as query_example
    FROM pg_stat_user_tables
    JOIN pg_attribute ON pg_stat_user_tables.relid = pg_attribute.attrelid
    WHERE seq_scan > 1000
    AND attnum > 0
    AND NOT attisdropped
    AND NOT EXISTS (
        SELECT 1 FROM pg_index 
        WHERE pg_index.indrelid = pg_attribute.attrelid 
        AND pg_attribute.attnum = ANY(pg_index.indkey)
    )
    ORDER BY seq_scan DESC
    LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 11. INDEX MAINTENANCE
-- ==========================================

-- Function to rebuild fragmented indexes
CREATE OR REPLACE FUNCTION maintain_indexes()
RETURNS void AS $$
DECLARE
    index_record RECORD;
BEGIN
    FOR index_record IN 
        SELECT schemaname, tablename, indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
        AND indexname NOT LIKE '%_pkey'
    LOOP
        EXECUTE 'REINDEX INDEX CONCURRENTLY ' || quote_ident(index_record.schemaname) || '.' || quote_ident(index_record.indexname);
        RAISE NOTICE 'Reindexed: %', index_record.indexname;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 12. APPLICATION NOTES
-- ==========================================

/*
IMPORTANT NOTES FOR DEVELOPERS:

1. Index Creation Order:
   - Run this script in a maintenance window
   - Large tables may take time to index
   - Use CONCURRENTLY for production (not shown here for simplicity)

2. Monitoring:
   - Use pg_stat_user_indexes to monitor index usage
   - Drop unused indexes to reduce write overhead
   - Monitor index size with pg_indexes_size()

3. Trade-offs:
   - More indexes = faster reads, slower writes
   - Composite indexes support multiple query patterns
   - Partial indexes reduce size for filtered queries

4. Recommended Maintenance Schedule:
   - Weekly: Update materialized views
   - Monthly: Rebuild fragmented indexes
   - Quarterly: Review and drop unused indexes

5. Query Patterns Optimized:
   - Pharmacy-scoped queries (multi-tenant isolation)
   - Date-range reports (dashboard analytics)
   - Search operations (patient/drug lookup)
   - Real-time inventory checks (POS operations)
*/

-- ==========================================
-- EXECUTION INSTRUCTIONS
-- ==========================================

/*
To apply these optimizations:

1. Test in staging first:
   psql -h staging-db -U postgres -d pharma_db -f scripts/database-optimization.sql

2. Monitor performance impact:
   SELECT * FROM pg_stat_user_indexes WHERE schemaname = 'public';

3. For production, create indexes concurrently:
   CREATE INDEX CONCURRENTLY idx_name ON table(column);

4. Schedule materialized view refresh:
   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_sales_summary;
*/