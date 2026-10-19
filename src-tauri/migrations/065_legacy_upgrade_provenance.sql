-- Prospective registration of independently reviewed legacy-source provenance.
-- Evidence is NOT a stock, financial posting, payment receipt, source rewrite,
-- or authorization to make a transaction. No source row is backfilled.
-- SHA-256 values are externally verified commitments: stock SQLite cannot
-- compute SHA-256 or verify detached signatures. An audited trusted reviewer
-- must validate signed evidence against the exact source rows before inserting
-- manifests, mappings and the final seal. Only sealed sets are exposed in the
-- evidence VIEW. The view is not a substitute for financial source proof.

CREATE TABLE native_legacy_upgrade_manifests (
    manifest_sha256 TEXT NOT NULL PRIMARY KEY
      CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
        AND manifest_sha256<>printf('%064d',0)),
    authorized_pharmacy_id TEXT NOT NULL
      CHECK(length(authorized_pharmacy_id) BETWEEN 1 AND 128
        AND authorized_pharmacy_id=trim(authorized_pharmacy_id)
        AND lower(authorized_pharmacy_id)<>'local_default'),
    expected_source_count INTEGER NOT NULL
      CHECK(typeof(expected_source_count)='integer' AND expected_source_count BETWEEN 1 AND 10000),
    grant_actor_id TEXT NOT NULL CHECK(length(grant_actor_id) BETWEEN 1 AND 128
       AND grant_actor_id=trim(grant_actor_id)),
    approval_actor_id TEXT NOT NULL CHECK(length(approval_actor_id) BETWEEN 1 AND 128
       AND approval_actor_id=trim(approval_actor_id)
       AND approval_actor_id<>grant_actor_id),
    grant_evidence_sha256 TEXT NOT NULL
      CHECK(length(grant_evidence_sha256)=64 AND grant_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
        AND grant_evidence_sha256<>printf('%064d',0)),
    approval_evidence_sha256 TEXT NOT NULL
      CHECK(length(approval_evidence_sha256)=64 AND approval_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
        AND approval_evidence_sha256<>printf('%064d',0)
        AND approval_evidence_sha256<>grant_evidence_sha256),
    grant_evidence_ref TEXT NOT NULL
      CHECK(length(trim(grant_evidence_ref)) BETWEEN 16 AND 512
        AND grant_evidence_ref=trim(grant_evidence_ref)),
    approval_evidence_ref TEXT NOT NULL
      CHECK(length(trim(approval_evidence_ref)) BETWEEN 16 AND 512
        AND approval_evidence_ref=trim(approval_evidence_ref)
        AND approval_evidence_ref<>grant_evidence_ref),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE TABLE native_legacy_upgrade_source_mappings (
    source_table TEXT NOT NULL CHECK(source_table IN (
        'inventory','sales_invoices','purchase_invoices','returns',
        'activity_log','shortages','purchase_orders','cash_movements',
        'daily_journals','expenses','financial_notices'
    )),
    source_record_id TEXT NOT NULL CHECK(
        length(source_record_id) BETWEEN 1 AND 128
        AND source_record_id=trim(source_record_id)
        AND source_record_id NOT GLOB '*[^ -~]*'
    ),
    manifest_sha256 TEXT NOT NULL REFERENCES native_legacy_upgrade_manifests(manifest_sha256),
    original_identity_class TEXT NOT NULL
      CHECK(original_identity_class IN ('null','blank','local_default','explicit')),
    -- Preserve the exact original literal; NULL, '' and 'local_default'
    -- must never be silently normalized into a claimed tenant.
    original_pharmacy_literal TEXT,
    source_snapshot_sha256 TEXT NOT NULL
      CHECK(length(source_snapshot_sha256)=64
         AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
         AND source_snapshot_sha256<>printf('%064d',0)),
    source_evidence_ref TEXT NOT NULL
      CHECK(length(trim(source_evidence_ref)) BETWEEN 16 AND 512
         AND source_evidence_ref=trim(source_evidence_ref)),
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(source_table,source_record_id),
    CHECK(
        (original_identity_class='null' AND original_pharmacy_literal IS NULL)
        OR (original_identity_class='blank' AND original_pharmacy_literal IS NOT NULL
            AND trim(original_pharmacy_literal)='')
        OR (original_identity_class='local_default' AND original_pharmacy_literal='local_default')
        OR (original_identity_class='explicit' AND original_pharmacy_literal IS NOT NULL
            AND original_pharmacy_literal=trim(original_pharmacy_literal)
            AND original_pharmacy_literal<>''
            AND lower(original_pharmacy_literal)<>'local_default')
    )
) WITHOUT ROWID;
CREATE INDEX idx_native_legacy_upgrade_mapping_manifest
ON native_legacy_upgrade_source_mappings(manifest_sha256,source_table,source_record_id);

CREATE TABLE native_legacy_upgrade_manifest_seals (
    manifest_sha256 TEXT NOT NULL PRIMARY KEY REFERENCES native_legacy_upgrade_manifests(manifest_sha256),
    sealed_by_actor_id TEXT NOT NULL CHECK(length(sealed_by_actor_id) BETWEEN 1 AND 128
       AND sealed_by_actor_id=trim(sealed_by_actor_id)),
    seal_evidence_sha256 TEXT NOT NULL CHECK(
        length(seal_evidence_sha256)=64
        AND seal_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
        AND seal_evidence_sha256<>printf('%064d',0)),
    seal_evidence_ref TEXT NOT NULL CHECK(
        length(trim(seal_evidence_ref)) BETWEEN 16 AND 512
        AND seal_evidence_ref=trim(seal_evidence_ref)),
    sealed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- Both independently signed approvals must come from different active,
-- explicitly tenant-scoped owner/admin accounts. A quarantined owner cannot
-- endorse a proof. Admin needs explicit can_manage_inventory in permissions.
-- Actual detached signatures and digest recomputation happen outside SQLite.
CREATE TRIGGER native_legacy_upgrade_manifest_insert_guard
BEFORE INSERT ON native_legacy_upgrade_manifests
BEGIN
    SELECT RAISE(ABORT,'Legacy manifest already exists; immutable even under REPLACE')
    WHERE EXISTS (SELECT 1 FROM native_legacy_upgrade_manifests m
                  WHERE m.manifest_sha256=NEW.manifest_sha256);
    SELECT RAISE(ABORT,'Independent grant and approval from explicit tenant owners/admins required')
    WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE CAST(u.id AS TEXT)=NEW.grant_actor_id
          AND COALESCE(u.is_active,1)=1
          AND u.pharmacy_id=NEW.authorized_pharmacy_id
          AND (lower(trim(u.role))='owner'
            OR (lower(trim(u.role))='admin' AND CASE WHEN json_valid(u.permissions)
                 THEN json_extract(u.permissions,'$.can_manage_inventory') IN (1,'true')
                 ELSE 0 END))
          AND NOT EXISTS (SELECT 1 FROM native_owner_scope_review review
                          WHERE review.owner_id=NEW.grant_actor_id)
    ) OR NOT EXISTS (
        SELECT 1 FROM users u
        WHERE CAST(u.id AS TEXT)=NEW.approval_actor_id
          AND COALESCE(u.is_active,1)=1
          AND u.pharmacy_id=NEW.authorized_pharmacy_id
          AND (lower(trim(u.role))='owner'
            OR (lower(trim(u.role))='admin' AND CASE WHEN json_valid(u.permissions)
                 THEN json_extract(u.permissions,'$.can_manage_inventory') IN (1,'true')
                 ELSE 0 END))
          AND NOT EXISTS (SELECT 1 FROM native_owner_scope_review review
                          WHERE review.owner_id=NEW.approval_actor_id)
    );
END;

CREATE TRIGGER native_legacy_upgrade_source_insert_guard
BEFORE INSERT ON native_legacy_upgrade_source_mappings
BEGIN
    SELECT RAISE(ABORT,'Source already mapped; no conflicting tenant or REPLACE')
    WHERE EXISTS (SELECT 1 FROM native_legacy_upgrade_source_mappings old
                  WHERE old.source_table=NEW.source_table
                    AND old.source_record_id=NEW.source_record_id);
    SELECT RAISE(ABORT,'Source requires an unsealed and independently approved manifest')
    WHERE NOT EXISTS (SELECT 1 FROM native_legacy_upgrade_manifests m
                      WHERE m.manifest_sha256=NEW.manifest_sha256)
       OR EXISTS (SELECT 1 FROM native_legacy_upgrade_manifest_seals seal
                  WHERE seal.manifest_sha256=NEW.manifest_sha256)
       OR (SELECT COUNT(*) FROM native_legacy_upgrade_source_mappings s
           WHERE s.manifest_sha256=NEW.manifest_sha256)
          >= (SELECT expected_source_count FROM native_legacy_upgrade_manifests
              WHERE manifest_sha256=NEW.manifest_sha256);
    SELECT RAISE(ABORT,'Already explicitly foreign-owned source cannot be reattributed')
    WHERE NEW.original_identity_class='explicit' AND
      NEW.original_pharmacy_literal <>
        (SELECT m.authorized_pharmacy_id FROM native_legacy_upgrade_manifests m
         WHERE m.manifest_sha256=NEW.manifest_sha256);
    -- The recorded literal is compared byte-for-byte to the physical source
    -- identity within the same SQLite statement. TEXT id vs integer id for
    -- activity_log and shortages is handled by canonical CAST(id AS TEXT).
    SELECT RAISE(ABORT,'Missing source row or inconsistent original tenant literal')
    WHERE NOT (
        (NEW.source_table='inventory'
            AND EXISTS (SELECT 1 FROM inventory s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='sales_invoices'
            AND EXISTS (SELECT 1 FROM sales_invoices s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='purchase_invoices'
            AND EXISTS (SELECT 1 FROM purchase_invoices s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='returns'
            AND EXISTS (SELECT 1 FROM returns s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='activity_log'
            AND EXISTS (SELECT 1 FROM activity_log s
                         WHERE CAST(s.id AS TEXT)=NEW.source_record_id
                           AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='shortages'
            AND EXISTS (SELECT 1 FROM shortages s
                         WHERE CAST(s.id AS TEXT)=NEW.source_record_id
                           AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='purchase_orders'
            AND EXISTS (SELECT 1 FROM purchase_orders s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='cash_movements'
            AND EXISTS (SELECT 1 FROM cash_movements s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='daily_journals'
            AND EXISTS (SELECT 1 FROM daily_journals s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='expenses'
            AND EXISTS (SELECT 1 FROM expenses s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
        OR (NEW.source_table='financial_notices'
            AND EXISTS (SELECT 1 FROM financial_notices s WHERE s.id=NEW.source_record_id
                         AND s.pharmacy_id IS NEW.original_pharmacy_literal))
    );
END;

CREATE TRIGGER native_legacy_upgrade_seal_insert_guard
BEFORE INSERT ON native_legacy_upgrade_manifest_seals
BEGIN
    SELECT RAISE(ABORT,'Already sealed; no seal replacement')
    WHERE EXISTS (SELECT 1 FROM native_legacy_upgrade_manifest_seals s
                  WHERE s.manifest_sha256=NEW.manifest_sha256);
    SELECT RAISE(ABORT,'Incomplete legacy mapping manifest or unrelated seal actor')
    WHERE NOT EXISTS (
        SELECT 1 FROM native_legacy_upgrade_manifests m
        JOIN users u ON CAST(u.id AS TEXT)=NEW.sealed_by_actor_id
        WHERE m.manifest_sha256=NEW.manifest_sha256
          AND NEW.sealed_by_actor_id=m.approval_actor_id
          AND u.pharmacy_id=m.authorized_pharmacy_id
          AND COALESCE(u.is_active,1)=1
          AND lower(trim(u.role)) IN ('owner','admin')
          AND (lower(trim(u.role))='owner'
               OR CASE WHEN json_valid(u.permissions)
                  THEN json_extract(u.permissions,'$.can_manage_inventory') IN (1,'true')
                  ELSE 0 END)
          AND NOT EXISTS (SELECT 1 FROM native_owner_scope_review review
                          WHERE review.owner_id=NEW.sealed_by_actor_id)
          AND (SELECT COUNT(*) FROM native_legacy_upgrade_source_mappings mapping
               WHERE mapping.manifest_sha256=m.manifest_sha256)=m.expected_source_count
          AND NEW.seal_evidence_sha256<>m.manifest_sha256
          AND NEW.seal_evidence_sha256<>m.approval_evidence_sha256
          AND NEW.seal_evidence_sha256<>m.grant_evidence_sha256
          AND NEW.seal_evidence_ref<>m.grant_evidence_ref
          AND NEW.seal_evidence_ref<>m.approval_evidence_ref
    );
END;

-- The immutable witness is visible only after the complete and separately
-- approved manifest is sealed. Readers must independently authenticate
-- external signatures and rehash canonical source snapshots before relying on
-- this evidence for any future controlled repair.
CREATE VIEW native_legacy_upgrade_authorized_sources AS
SELECT mapping.source_table, mapping.source_record_id,
       mapping.original_identity_class, mapping.original_pharmacy_literal,
       m.authorized_pharmacy_id, mapping.source_snapshot_sha256,
       mapping.source_evidence_ref, m.manifest_sha256,
       m.grant_actor_id, m.approval_actor_id, m.grant_evidence_sha256,
       m.approval_evidence_sha256, seal.seal_evidence_sha256,
       seal.sealed_at
FROM native_legacy_upgrade_source_mappings mapping
JOIN native_legacy_upgrade_manifests m
  ON m.manifest_sha256=mapping.manifest_sha256
JOIN native_legacy_upgrade_manifest_seals seal
  ON seal.manifest_sha256=m.manifest_sha256;

-- SQL-level immutability covers every approval, manifest, source mapping and
-- seal. The INSERT guards above also block INSERT OR REPLACE even with
-- PRAGMA recursive_triggers=OFF.
CREATE TRIGGER native_legacy_upgrade_manifest_no_update
BEFORE UPDATE ON native_legacy_upgrade_manifests
BEGIN SELECT RAISE(ABORT,'Legacy manifest immutable'); END;
CREATE TRIGGER native_legacy_upgrade_manifest_no_delete
BEFORE DELETE ON native_legacy_upgrade_manifests
BEGIN SELECT RAISE(ABORT,'Legacy manifest immutable'); END;
CREATE TRIGGER native_legacy_upgrade_mapping_no_update
BEFORE UPDATE ON native_legacy_upgrade_source_mappings
BEGIN SELECT RAISE(ABORT,'Legacy source mapping immutable'); END;
CREATE TRIGGER native_legacy_upgrade_mapping_no_delete
BEFORE DELETE ON native_legacy_upgrade_source_mappings
BEGIN SELECT RAISE(ABORT,'Legacy source mapping immutable'); END;
CREATE TRIGGER native_legacy_upgrade_seal_no_update
BEFORE UPDATE ON native_legacy_upgrade_manifest_seals
BEGIN SELECT RAISE(ABORT,'Legacy manifest seal immutable'); END;
CREATE TRIGGER native_legacy_upgrade_seal_no_delete
BEFORE DELETE ON native_legacy_upgrade_manifest_seals
BEGIN SELECT RAISE(ABORT,'Legacy manifest seal immutable'); END;
-- Preserve the source row and its original literal after a mapping is recorded.
-- Rows without a mapping remain governed by existing application rules.
-- These guards create no provenance and never alter any historical row.
-- INSERT guards block REPLACE when recursive_triggers=OFF.
CREATE TRIGGER native_legacy_upgrade_inventory_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON inventory
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='inventory' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_inventory_delete_guard
BEFORE DELETE ON inventory
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='inventory' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_inventory_replace_guard
BEFORE INSERT ON inventory
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='inventory' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_sales_invoices_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON sales_invoices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='sales_invoices' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_sales_invoices_delete_guard
BEFORE DELETE ON sales_invoices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='sales_invoices' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_sales_invoices_replace_guard
BEFORE INSERT ON sales_invoices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='sales_invoices' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_purchase_invoices_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON purchase_invoices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='purchase_invoices' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_purchase_invoices_delete_guard
BEFORE DELETE ON purchase_invoices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='purchase_invoices' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_purchase_invoices_replace_guard
BEFORE INSERT ON purchase_invoices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='purchase_invoices' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_returns_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON returns
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='returns' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_returns_delete_guard
BEFORE DELETE ON returns
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='returns' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_returns_replace_guard
BEFORE INSERT ON returns
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='returns' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_activity_log_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON activity_log
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='activity_log' AND m.source_record_id=CAST(OLD.id AS TEXT))
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_activity_log_delete_guard
BEFORE DELETE ON activity_log
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='activity_log' AND m.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_activity_log_replace_guard
BEFORE INSERT ON activity_log
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='activity_log' AND m.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_shortages_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON shortages
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='shortages' AND m.source_record_id=CAST(OLD.id AS TEXT))
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_shortages_delete_guard
BEFORE DELETE ON shortages
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='shortages' AND m.source_record_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_shortages_replace_guard
BEFORE INSERT ON shortages
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='shortages' AND m.source_record_id=CAST(NEW.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_purchase_orders_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON purchase_orders
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='purchase_orders' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_purchase_orders_delete_guard
BEFORE DELETE ON purchase_orders
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='purchase_orders' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_purchase_orders_replace_guard
BEFORE INSERT ON purchase_orders
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='purchase_orders' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_cash_movements_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='cash_movements' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_cash_movements_delete_guard
BEFORE DELETE ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='cash_movements' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_cash_movements_replace_guard
BEFORE INSERT ON cash_movements
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='cash_movements' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_daily_journals_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='daily_journals' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_daily_journals_delete_guard
BEFORE DELETE ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='daily_journals' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_daily_journals_replace_guard
BEFORE INSERT ON daily_journals
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='daily_journals' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_expenses_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON expenses
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='expenses' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_expenses_delete_guard
BEFORE DELETE ON expenses
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='expenses' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_expenses_replace_guard
BEFORE INSERT ON expenses
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='expenses' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;

CREATE TRIGGER native_legacy_upgrade_financial_notices_identity_guard
BEFORE UPDATE OF id,pharmacy_id ON financial_notices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='financial_notices' AND m.source_record_id=OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.pharmacy_id IS NOT OLD.pharmacy_id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source identity cannot change'); END;
CREATE TRIGGER native_legacy_upgrade_financial_notices_delete_guard
BEFORE DELETE ON financial_notices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='financial_notices' AND m.source_record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be deleted'); END;
CREATE TRIGGER native_legacy_upgrade_financial_notices_replace_guard
BEFORE INSERT ON financial_notices
WHEN EXISTS(SELECT 1 FROM native_legacy_upgrade_source_mappings m WHERE m.source_table='financial_notices' AND m.source_record_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Mapped legacy source cannot be replaced'); END;
