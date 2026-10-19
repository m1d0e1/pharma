-- Prospective typed native catalog creations only. The global master_drugs
-- metadata stays global; tenant and actor here describe the creator, not a
-- pharmacy-level stock or ownership claim over shared drug metadata.
-- No historical master_drugs rows receive a receipt.
-- Register only master rows inserted AFTER this migration. Historical records
-- cannot subsequently acquire a native creation receipt through direct SQL.
CREATE TABLE native_master_drug_create_candidates (
    drug_id INTEGER PRIMARY KEY
);
CREATE TRIGGER native_master_drug_create_candidate
AFTER INSERT ON master_drugs
BEGIN
    INSERT INTO native_master_drug_create_candidates(drug_id) VALUES(NEW.id);
END;
CREATE TRIGGER native_master_drug_candidate_no_update
BEFORE UPDATE ON native_master_drug_create_candidates
BEGIN SELECT RAISE(ABORT,'Catalog creation candidate is immutable'); END;
CREATE TRIGGER native_master_drug_candidate_no_delete
BEFORE DELETE ON native_master_drug_create_candidates
WHEN EXISTS (SELECT 1 FROM master_drugs d WHERE d.id=OLD.drug_id)
BEGIN SELECT RAISE(ABORT,'Catalog creation candidate is immutable'); END;
CREATE TRIGGER native_master_drug_candidate_cleanup
AFTER DELETE ON master_drugs
BEGIN
    DELETE FROM native_master_drug_create_candidates WHERE drug_id=OLD.id;
END;
CREATE TRIGGER native_master_drug_existing_id_no_replace
BEFORE INSERT ON master_drugs
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM master_drugs prior WHERE prior.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Existing catalog identity cannot be replaced'); END;

CREATE TABLE native_master_drug_create_receipts (
    request_id TEXT NOT NULL PRIMARY KEY CHECK(
        length(request_id)=36
        AND substr(request_id,9,1)='-'
        AND substr(request_id,14,1)='-'
        AND substr(request_id,15,1)='4'
        AND substr(request_id,19,1)='-'
        AND substr(request_id,20,1) IN ('8','9','a','b')
        AND substr(request_id,24,1)='-'
        AND length(replace(request_id,'-',''))=32
        AND replace(request_id,'-','') NOT GLOB '*[^0-9a-f]*'
    ),
    drug_id INTEGER NOT NULL UNIQUE REFERENCES master_drugs(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128 AND actor_id=trim(actor_id)),
    pharmacy_id TEXT NOT NULL CHECK(length(pharmacy_id) BETWEEN 1 AND 128
        AND pharmacy_id=trim(pharmacy_id) AND lower(pharmacy_id)<>'local_default'),
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64
        AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER native_master_drug_receipt_insert_guard
BEFORE INSERT ON native_master_drug_create_receipts
BEGIN
    SELECT RAISE(ABORT,'Native drug creation requires an active independent owner/admin tenant')
    WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE CAST(u.id AS TEXT)=NEW.actor_id AND COALESCE(u.is_active,1)=1
          AND lower(trim(u.role)) IN ('owner','admin')
          AND u.pharmacy_id=NEW.pharmacy_id
          AND NOT EXISTS (SELECT 1 FROM native_owner_scope_review r WHERE r.owner_id=NEW.actor_id)
    );
    SELECT RAISE(ABORT,'Native catalog receipt requires a new stockless master record')
    WHERE NOT EXISTS (SELECT 1 FROM native_master_drug_create_candidates c WHERE c.drug_id=NEW.drug_id)
       OR NOT EXISTS (SELECT 1 FROM master_drugs d WHERE d.id=NEW.drug_id)
       OR EXISTS (SELECT 1 FROM inventory i WHERE i.drug_id=NEW.drug_id)
       OR EXISTS (SELECT 1 FROM native_master_drug_create_receipts r
                  WHERE r.drug_id=NEW.drug_id OR r.request_id=NEW.request_id);
END;
CREATE TRIGGER native_master_drug_receipt_no_update
BEFORE UPDATE ON native_master_drug_create_receipts
BEGIN SELECT RAISE(ABORT,'Native catalog creation receipt is immutable'); END;
CREATE TRIGGER native_master_drug_receipt_no_delete
BEFORE DELETE ON native_master_drug_create_receipts
BEGIN SELECT RAISE(ABORT,'Native catalog creation receipt is immutable'); END;

-- Even with recursive_triggers disabled, a REPLACE must not silently discard
-- the immutable request record or its associated catalog identity.
CREATE TRIGGER native_master_drug_receipted_replace
BEFORE INSERT ON master_drugs
WHEN EXISTS (SELECT 1 FROM native_master_drug_create_receipts r WHERE r.drug_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Receipted master drug ID cannot be replaced'); END;
CREATE TRIGGER native_master_drug_receipted_delete
BEFORE DELETE ON master_drugs
WHEN EXISTS (SELECT 1 FROM native_master_drug_create_receipts r WHERE r.drug_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Receipted master drug identity cannot be deleted'); END;
