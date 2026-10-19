-- Forward-additive, inert native metadata for a *single* primary_pharmacy
-- candidate. No INSERT or scope UPDATE is performed by this migration.
-- Production startup must NEVER infer authentication, tenant authorization,
-- financial source provenance or an ownership grant from this evidence.
-- External verifier stores SHA-256 commitments after checking every original
-- physical row, including SQLite FTS/shadows, and direct + indirect links.
-- SQLite itself cannot compute SHA-256 or authenticate the reviewer.
-- 032/052/065/066/067 and their immutable guarantees are untouched.

CREATE TABLE native_primary_scope_audit_batches (
  audit_sha256 TEXT PRIMARY KEY
    CHECK(length(audit_sha256)=64 AND audit_sha256 NOT GLOB '*[^0-9a-f]*'),
  pharmacy_id TEXT NOT NULL DEFAULT 'primary_pharmacy'
    CHECK(pharmacy_id='primary_pharmacy'),
  original_v67_sha256 TEXT NOT NULL
    CHECK(length(original_v67_sha256)=64 AND original_v67_sha256 NOT GLOB '*[^0-9a-f]*'),
  sealed_v29_sha256 TEXT NOT NULL
    CHECK(length(sealed_v29_sha256)=64 AND sealed_v29_sha256 NOT GLOB '*[^0-9a-f]*'),
  observed_native_schema_version INTEGER NOT NULL
    CHECK(typeof(observed_native_schema_version)='integer' AND observed_native_schema_version=67),
  original_physical_table_count INTEGER NOT NULL CHECK(original_physical_table_count BETWEEN 1 AND 512),
  original_physical_row_count INTEGER NOT NULL CHECK(original_physical_row_count BETWEEN 1 AND 3000000),
  expected_original_scope_count INTEGER NOT NULL CHECK(expected_original_scope_count BETWEEN 1 AND 3000000),
  expected_table_witness_count INTEGER NOT NULL CHECK(expected_table_witness_count=original_physical_table_count),
  expected_relation_witness_count INTEGER NOT NULL CHECK(expected_relation_witness_count BETWEEN 1 AND 1024),
  evidence_kind TEXT NOT NULL DEFAULT 'UNSIGNED_TYPED_DISPOSABLE_AUDIT'
    CHECK(evidence_kind='UNSIGNED_TYPED_DISPOSABLE_AUDIT'),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- Exact original SQLite storage class, literal, and rowid survive normalization
-- for future verification and rollback. Original owner PASSWORDS do not enter
-- this metadata. No source or user table is altered by registering rows.
CREATE TABLE native_primary_scope_audit_originals (
  audit_sha256 TEXT NOT NULL REFERENCES native_primary_scope_audit_batches(audit_sha256),
  source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 128),
  source_rowid INTEGER NOT NULL CHECK(typeof(source_rowid)='integer'),
  original_storage TEXT NOT NULL
    CHECK(original_storage IN ('null','integer','real','text','blob')),
  original_literal BLOB,
  original_row_typed_sha256 TEXT NOT NULL
    CHECK(length(original_row_typed_sha256)=64
      AND original_row_typed_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(audit_sha256,source_table,source_rowid),
  CHECK((original_storage='null' AND original_literal IS NULL)
    OR (original_storage<>'null' AND original_literal IS NOT NULL
      AND typeof(original_literal)=original_storage))
) WITHOUT ROWID;
CREATE INDEX native_primary_scope_originals_by_table
  ON native_primary_scope_audit_originals(source_table,source_rowid);

-- Every original SQLite physical table, including FTS and shadow tables, has a
-- typed complete-row digest before/after the *scope-only* transformation. The
-- digests are evidence inputs, not intrinsic SQL guarantees or access grants.
CREATE TABLE native_primary_scope_audit_tables (
  audit_sha256 TEXT NOT NULL REFERENCES native_primary_scope_audit_batches(audit_sha256),
  source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 128),
  original_physical_rows INTEGER NOT NULL CHECK(original_physical_rows>=0),
  directly_scoped INTEGER NOT NULL CHECK(directly_scoped IN (0,1)),
  original_typed_rows_sha256 TEXT NOT NULL
    CHECK(length(original_typed_rows_sha256)=64
      AND original_typed_rows_sha256 NOT GLOB '*[^0-9a-f]*'),
  normalized_typed_rows_sha256 TEXT NOT NULL
    CHECK(length(normalized_typed_rows_sha256)=64
      AND normalized_typed_rows_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(audit_sha256,source_table)
) WITHOUT ROWID;

-- Fixed and declared FKs are structural observations. Matching a key never
-- means the child is owned by the parent, permits a posting, or proves RBAC.
CREATE TABLE native_primary_scope_audit_relations (
  audit_sha256 TEXT NOT NULL REFERENCES native_primary_scope_audit_batches(audit_sha256),
  relation_sha256 TEXT NOT NULL
    CHECK(length(relation_sha256)=64 AND relation_sha256 NOT GLOB '*[^0-9a-f]*'),
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('FIXED','DECLARED_FK')),
  source_rows INTEGER NOT NULL CHECK(source_rows>=0),
  matched_typed_rows INTEGER NOT NULL CHECK(matched_typed_rows>=0),
  coerced_only_rows INTEGER NOT NULL CHECK(coerced_only_rows>=0),
  missing_parent_rows INTEGER NOT NULL CHECK(missing_parent_rows>=0),
  unlinked_rows INTEGER NOT NULL CHECK(unlinked_rows>=0),
  partial_null_rows INTEGER NOT NULL CHECK(partial_null_rows>=0),
  before_edge_sha256 TEXT NOT NULL
    CHECK(length(before_edge_sha256)=64 AND before_edge_sha256 NOT GLOB '*[^0-9a-f]*'),
  after_edge_sha256 TEXT NOT NULL
    CHECK(length(after_edge_sha256)=64 AND after_edge_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(audit_sha256,relation_sha256),
  CHECK(source_rows=matched_typed_rows+coerced_only_rows
      +missing_parent_rows+unlinked_rows+partial_null_rows)
) WITHOUT ROWID;

-- Seals are integrity/count witnesses only. There is deliberately no
-- authorized/pharmacy-owned view, permission flag, or owner enrollment.
CREATE TABLE native_primary_scope_audit_seals (
  audit_sha256 TEXT PRIMARY KEY REFERENCES native_primary_scope_audit_batches(audit_sha256),
  evidence_sha256 TEXT NOT NULL
    CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  sealed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- Optional future owner-only import handshake. This table is EMPTY after
-- migration and after audit staging. The native action layer must first
-- authenticate the real owner, verify the signed evidence over the exact
-- original source SHA, tenant, owner ID and typed mappings, and then register
-- its digest. Merely inserting SQL here is NOT proof of that verification.
-- An original owner stripped of its public bootstrap password in 032 cannot
-- use an inherited/null credential or a guessed 052 local_default scope.
CREATE TABLE native_primary_scope_owner_attestations (
  audit_sha256 TEXT PRIMARY KEY REFERENCES native_primary_scope_audit_seals(audit_sha256),
  original_v67_sha256 TEXT NOT NULL CHECK(length(original_v67_sha256)=64
    AND original_v67_sha256 NOT GLOB '*[^0-9a-f]*'),
  pharmacy_id TEXT NOT NULL CHECK(pharmacy_id='primary_pharmacy'),
  verified_owner_id TEXT NOT NULL CHECK(length(trim(verified_owner_id)) BETWEEN 1 AND 128),
  signed_evidence_sha256 TEXT NOT NULL CHECK(length(signed_evidence_sha256)=64
    AND signed_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  verified_typed_mapping_sha256 TEXT NOT NULL CHECK(length(verified_typed_mapping_sha256)=64
    AND verified_typed_mapping_sha256 NOT GLOB '*[^0-9a-f]*'),
  signed_evidence_ref TEXT NOT NULL CHECK(length(trim(signed_evidence_ref)) BETWEEN 16 AND 512),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE TRIGGER native_primary_scope_owner_attestation_guard
BEFORE INSERT ON native_primary_scope_owner_attestations
BEGIN
  SELECT RAISE(ABORT,'Owner attestation cannot replace existing proof')
  WHERE EXISTS(SELECT 1 FROM native_primary_scope_owner_attestations prior
               WHERE prior.audit_sha256=NEW.audit_sha256);
  SELECT RAISE(ABORT,'Owner attestation requires matching sealed source evidence')
  WHERE NOT EXISTS (
    SELECT 1 FROM native_primary_scope_audit_batches b
    JOIN native_primary_scope_audit_seals s ON s.audit_sha256=b.audit_sha256
    WHERE b.audit_sha256=NEW.audit_sha256
      AND b.original_v67_sha256=NEW.original_v67_sha256
      AND b.pharmacy_id=NEW.pharmacy_id
      AND s.evidence_sha256=NEW.verified_typed_mapping_sha256
  );
  SELECT RAISE(ABORT,'Owner must be enrolled and explicitly tenant scoped')
  WHERE NOT EXISTS (
    SELECT 1 FROM users u
    WHERE CAST(u.id AS TEXT)=NEW.verified_owner_id
      AND lower(trim(u.role))='owner'
      AND u.pharmacy_id=NEW.pharmacy_id
      AND COALESCE(u.is_active,1)=1
      AND typeof(u.password_hash)='text' AND length(u.password_hash)>0
      AND NOT EXISTS(SELECT 1 FROM native_owner_scope_review review
                     WHERE review.owner_id=CAST(u.id AS TEXT))
  );
END;

CREATE TRIGGER native_primary_scope_owner_attestation_no_update
BEFORE UPDATE ON native_primary_scope_owner_attestations
BEGIN SELECT RAISE(ABORT,'Owner attestation immutable'); END;
CREATE TRIGGER native_primary_scope_owner_attestation_no_delete
BEFORE DELETE ON native_primary_scope_owner_attestations
BEGIN SELECT RAISE(ABORT,'Owner attestation immutable'); END;

CREATE TRIGGER native_primary_scope_audit_seal_guard
BEFORE INSERT ON native_primary_scope_audit_seals
BEGIN
  SELECT RAISE(ABORT,'Primary audit seal already exists')
  WHERE EXISTS(SELECT 1 FROM native_primary_scope_audit_seals s
               WHERE s.audit_sha256=NEW.audit_sha256);
  SELECT RAISE(ABORT,'Missing or incomplete typed scope audit evidence')
  WHERE NOT EXISTS(
    SELECT 1 FROM native_primary_scope_audit_batches b
    WHERE b.audit_sha256=NEW.audit_sha256
      AND (SELECT COUNT(*) FROM native_primary_scope_audit_originals a
           WHERE a.audit_sha256=b.audit_sha256)=b.expected_original_scope_count
      AND (SELECT COUNT(*) FROM native_primary_scope_audit_tables t
           WHERE t.audit_sha256=b.audit_sha256)=b.expected_table_witness_count
      AND (SELECT COALESCE(SUM(t.original_physical_rows),0)
           FROM native_primary_scope_audit_tables t
           WHERE t.audit_sha256=b.audit_sha256)=b.original_physical_row_count
      AND (SELECT COUNT(*) FROM native_primary_scope_audit_relations r
           WHERE r.audit_sha256=b.audit_sha256)=b.expected_relation_witness_count
  );
END;

CREATE TRIGGER native_primary_scope_audit_batch_no_change BEFORE UPDATE ON native_primary_scope_audit_batches
BEGIN SELECT RAISE(ABORT,'Primary audit batch immutable'); END;
CREATE TRIGGER native_primary_scope_audit_batch_no_delete BEFORE DELETE ON native_primary_scope_audit_batches
BEGIN SELECT RAISE(ABORT,'Primary audit batch immutable'); END;
CREATE TRIGGER native_primary_scope_audit_batch_no_replace BEFORE INSERT ON native_primary_scope_audit_batches
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_batches b WHERE b.audit_sha256=NEW.audit_sha256)
BEGIN SELECT RAISE(ABORT,'Primary audit batch replacement forbidden'); END;

CREATE TRIGGER native_primary_scope_audit_original_no_change BEFORE UPDATE ON native_primary_scope_audit_originals
BEGIN SELECT RAISE(ABORT,'Typed original immutable'); END;
CREATE TRIGGER native_primary_scope_audit_original_no_delete BEFORE DELETE ON native_primary_scope_audit_originals
BEGIN SELECT RAISE(ABORT,'Typed original immutable'); END;
CREATE TRIGGER native_primary_scope_audit_original_no_replace BEFORE INSERT ON native_primary_scope_audit_originals
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_originals a
 WHERE a.audit_sha256=NEW.audit_sha256 AND a.source_table=NEW.source_table
   AND a.source_rowid=NEW.source_rowid)
BEGIN SELECT RAISE(ABORT,'Typed original replacement forbidden'); END;
CREATE TRIGGER native_primary_scope_audit_original_after_seal BEFORE INSERT ON native_primary_scope_audit_originals
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_seals s WHERE s.audit_sha256=NEW.audit_sha256)
BEGIN SELECT RAISE(ABORT,'Sealed typed original archive cannot grow'); END;

CREATE TRIGGER native_primary_scope_audit_table_no_change BEFORE UPDATE ON native_primary_scope_audit_tables
BEGIN SELECT RAISE(ABORT,'Physical table witness immutable'); END;
CREATE TRIGGER native_primary_scope_audit_table_no_delete BEFORE DELETE ON native_primary_scope_audit_tables
BEGIN SELECT RAISE(ABORT,'Physical table witness immutable'); END;
CREATE TRIGGER native_primary_scope_audit_table_no_replace BEFORE INSERT ON native_primary_scope_audit_tables
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_tables t
 WHERE t.audit_sha256=NEW.audit_sha256 AND t.source_table=NEW.source_table)
BEGIN SELECT RAISE(ABORT,'Physical table witness replacement forbidden'); END;
CREATE TRIGGER native_primary_scope_audit_table_after_seal BEFORE INSERT ON native_primary_scope_audit_tables
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_seals s WHERE s.audit_sha256=NEW.audit_sha256)
BEGIN SELECT RAISE(ABORT,'Sealed table census cannot grow'); END;

CREATE TRIGGER native_primary_scope_audit_relation_no_change BEFORE UPDATE ON native_primary_scope_audit_relations
BEGIN SELECT RAISE(ABORT,'Relationship witness immutable'); END;
CREATE TRIGGER native_primary_scope_audit_relation_no_delete BEFORE DELETE ON native_primary_scope_audit_relations
BEGIN SELECT RAISE(ABORT,'Relationship witness immutable'); END;
CREATE TRIGGER native_primary_scope_audit_relation_no_replace BEFORE INSERT ON native_primary_scope_audit_relations
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_relations r
 WHERE r.audit_sha256=NEW.audit_sha256 AND r.relation_sha256=NEW.relation_sha256)
BEGIN SELECT RAISE(ABORT,'Relationship witness replacement forbidden'); END;
CREATE TRIGGER native_primary_scope_audit_relation_after_seal BEFORE INSERT ON native_primary_scope_audit_relations
WHEN EXISTS(SELECT 1 FROM native_primary_scope_audit_seals s WHERE s.audit_sha256=NEW.audit_sha256)
BEGIN SELECT RAISE(ABORT,'Sealed relationship census cannot grow'); END;

CREATE TRIGGER native_primary_scope_audit_seal_no_change BEFORE UPDATE ON native_primary_scope_audit_seals
BEGIN SELECT RAISE(ABORT,'Primary audit seal immutable'); END;
CREATE TRIGGER native_primary_scope_audit_seal_no_delete BEFORE DELETE ON native_primary_scope_audit_seals
BEGIN SELECT RAISE(ABORT,'Primary audit seal immutable'); END;

CREATE VIEW native_primary_scope_audit_observations AS
SELECT b.audit_sha256,b.pharmacy_id,b.original_v67_sha256,
       b.original_physical_table_count,b.original_physical_row_count,
       b.expected_original_scope_count,b.expected_relation_witness_count,
       s.evidence_sha256,s.sealed_at,
       'UNSIGNED_AUDIT_ONLY_NOT_OWNER_AUTHORIZATION' AS authority
FROM native_primary_scope_audit_batches b
JOIN native_primary_scope_audit_seals s ON s.audit_sha256=b.audit_sha256;
