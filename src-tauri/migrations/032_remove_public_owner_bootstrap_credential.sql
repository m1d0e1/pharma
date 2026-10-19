-- Forward-only security migration. Do not change the historical 001
-- migration: its checksum is part of existing deployed SQLite databases.
-- 001 seeded a publicly documented owner password. Disarm ONLY that exact
-- original account/secret, preserving owners whose password was changed.
-- The native authenticated startup requires one-time operator-proven
-- enrollment before any pharmacy business session can be established.
UPDATE users SET password_hash = NULL
WHERE CAST(id AS TEXT) = 'admin'
  AND role = 'owner'
  AND COALESCE(is_active, 1) = 1
  AND password_hash = '$2b$12$.FYM9XhLwanE5PdySaxB2uMwZwwLpF9fI6HXf/2XArluRQt0kfvVm';
