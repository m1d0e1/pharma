-- Allow one shared open shift per pharmacy while preserving the existing shifts schema.
-- Migration 015 enforced one open shift for the entire database, which mixed drawers
-- when multiple pharmacies shared the same local database.

DROP INDEX IF EXISTS idx_shifts_single_open;

DROP TRIGGER IF EXISTS shifts_one_open_per_pharmacy_insert;
CREATE TRIGGER shifts_one_open_per_pharmacy_insert
BEFORE INSERT ON shifts
WHEN LOWER(COALESCE(NEW.status, '')) = 'open'
 AND EXISTS (
   SELECT 1
   FROM shifts existing_shift
   WHERE LOWER(COALESCE(existing_shift.status, '')) = 'open'
     AND COALESCE((
       SELECT COALESCE(NULLIF(TRIM(existing_owner.pharmacy_id), ''), 'local_default')
       FROM users existing_owner
       WHERE CAST(existing_owner.id AS TEXT) = CAST(existing_shift.user_id AS TEXT)
          OR LOWER(existing_owner.username) = LOWER(CAST(existing_shift.user_id AS TEXT))
       LIMIT 1
     ), 'local_default') = COALESCE((
       SELECT COALESCE(NULLIF(TRIM(new_owner.pharmacy_id), ''), 'local_default')
       FROM users new_owner
       WHERE CAST(new_owner.id AS TEXT) = CAST(NEW.user_id AS TEXT)
          OR LOWER(new_owner.username) = LOWER(CAST(NEW.user_id AS TEXT))
       LIMIT 1
     ), 'local_default')
 )
BEGIN
  SELECT RAISE(ABORT, 'open shift already exists for pharmacy');
END;

DROP TRIGGER IF EXISTS shifts_one_open_per_pharmacy_update;
CREATE TRIGGER shifts_one_open_per_pharmacy_update
BEFORE UPDATE OF status, user_id ON shifts
WHEN LOWER(COALESCE(NEW.status, '')) = 'open'
 AND EXISTS (
   SELECT 1
   FROM shifts existing_shift
   WHERE existing_shift.id <> OLD.id
     AND LOWER(COALESCE(existing_shift.status, '')) = 'open'
     AND COALESCE((
       SELECT COALESCE(NULLIF(TRIM(existing_owner.pharmacy_id), ''), 'local_default')
       FROM users existing_owner
       WHERE CAST(existing_owner.id AS TEXT) = CAST(existing_shift.user_id AS TEXT)
          OR LOWER(existing_owner.username) = LOWER(CAST(existing_shift.user_id AS TEXT))
       LIMIT 1
     ), 'local_default') = COALESCE((
       SELECT COALESCE(NULLIF(TRIM(new_owner.pharmacy_id), ''), 'local_default')
       FROM users new_owner
       WHERE CAST(new_owner.id AS TEXT) = CAST(NEW.user_id AS TEXT)
          OR LOWER(new_owner.username) = LOWER(CAST(NEW.user_id AS TEXT))
       LIMIT 1
     ), 'local_default')
 )
BEGIN
  SELECT RAISE(ABORT, 'open shift already exists for pharmacy');
END;
