-- Prospective patient directory ownership only. Historical patient records
-- predate tenant identity and must never be backfilled from sales or staff.
CREATE TABLE native_patient_directory_ownership (
  patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE RESTRICT,
  pharmacy_id TEXT NOT NULL CHECK(
    length(trim(pharmacy_id)) > 0 AND trim(pharmacy_id) <> 'local_default'
  ),
  actor_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX native_patient_directory_ownership_by_tenant
  ON native_patient_directory_ownership(pharmacy_id, patient_id);

CREATE TRIGGER native_patient_directory_owner_immutable_update
  BEFORE UPDATE ON native_patient_directory_ownership
  BEGIN SELECT RAISE(ABORT,'Native patient ownership is immutable'); END;

CREATE TRIGGER native_patient_directory_owner_immutable_delete
  BEFORE DELETE ON native_patient_directory_ownership
  BEGIN SELECT RAISE(ABORT,'Native patient ownership cannot be deleted'); END;

-- Preserve the patient identity that was explicitly witnessed. This also
-- guards against replacing a patient ID while recursive triggers are off.
CREATE TRIGGER native_patient_directory_identity_immutable_update
  BEFORE UPDATE OF id ON patients
  WHEN EXISTS (
    SELECT 1 FROM native_patient_directory_ownership owned
    WHERE owned.patient_id = OLD.id
  )
  BEGIN SELECT RAISE(ABORT,'Witnessed patient identity is immutable'); END;

CREATE TRIGGER native_patient_directory_identity_immutable_delete
  BEFORE DELETE ON patients
  WHEN EXISTS (
    SELECT 1 FROM native_patient_directory_ownership owned
    WHERE owned.patient_id = OLD.id
  )
  BEGIN SELECT RAISE(ABORT,'Witnessed patient cannot be deleted'); END;

CREATE TRIGGER native_patient_directory_identity_replace_guard
  BEFORE INSERT ON patients
  WHEN EXISTS (
    SELECT 1 FROM native_patient_directory_ownership owned
    WHERE owned.patient_id = NEW.id
  )
  BEGIN SELECT RAISE(ABORT,'Witnessed patient ID cannot be replaced'); END;
