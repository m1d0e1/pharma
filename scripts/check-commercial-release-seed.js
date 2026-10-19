#!/usr/bin/env node
'use strict';

// Commercial release interlock. The release runner must inspect only its own
// bundled seed, never an operator's live pharmacy database. No CLI/env override.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'src-tauri', 'pharma_local.db');
const MIGRATION_PATH = path.join(ROOT, 'src-tauri', 'migrations', '001_initial.sql');
const OWNER_CLEANUP_PATH = path.join(ROOT, 'src-tauri', 'migrations', '032_remove_public_owner_bootstrap_credential.sql');
const SCHEMA_PATH = path.join(ROOT, 'src-tauri', 'src', 'schema.rs');
const MAIN_PATH = path.join(ROOT, 'src-tauri', 'src', 'main.rs');
const AUTH_PATH = path.join(ROOT, 'src-tauri', 'src', 'commands', 'auth.rs');
const BCRYPT_LITERAL = /\$2[abxy]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}/g;

function validate({ database, migrationSource, schemaSource, cleanupSource, mainSource, authSource }) {
  if (!database || typeof database.prepare !== 'function' ||
      typeof migrationSource !== 'string' || typeof schemaSource !== 'string') {
    throw new Error('Missing or invalid commercial release preflight inputs');
  }

  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('Bundled seed failed SQLite integrity_check');
  }

  // An uninitialized owner may be enrolled by a future native onboarding flow.
  // Any *usable* bundled password, for any role or username, blocks shipping.
  const users = database.prepare('SELECT password_hash FROM users').all();
  if (users.some(user => user.password_hash !== null && user.password_hash !== undefined &&
      String(user.password_hash).trim() !== '')) {
    throw new Error('Bundled seed contains a configured user password hash');
  }

  const migrationHashes = new Set(migrationSource.match(BCRYPT_LITERAL) || []);
  const schemaHashes = new Set(schemaSource.match(BCRYPT_LITERAL) || []);
  if ([...migrationHashes].some(hash => schemaHashes.has(hash))) {
    throw new Error('Migration and native schema share a hard-coded bcrypt password hash');
  }
  if (schemaHashes.size > 0) {
    throw new Error('Migration or native schema embeds a hard-coded bcrypt password hash');
  }
  if (migrationHashes.size > 0) {
    // Retain migration 001 byte-for-byte (SQLx checksums on upgraded installs).
    // It can be tolerated ONLY when a registered later migration disarms its
    // exact historical bcrypt before the app can authenticate an owner.
    if (migrationHashes.size !== 1 ||
        typeof cleanupSource !== 'string' ||
        typeof mainSource !== 'string' || typeof authSource !== 'string' ||
        !mainSource.includes('include_str!("../migrations/032_remove_public_owner_bootstrap_credential.sql")') ||
        !authSource.includes('owner_enrollment_pending_on_connection') ||
        !authSource.includes('enroll_initial_owner')) {
      throw new Error('Historical default credential is missing a registered native enrollment migration');
    }
    const [legacyHash] = migrationHashes;
    if (!bcrypt.compareSync('admin', legacyHash) ||
        !cleanupSource.includes('UPDATE users SET password_hash = NULL') ||
        !cleanupSource.includes('CAST(id AS TEXT) = \'admin\'') ||
        !cleanupSource.includes(`password_hash = '${legacyHash}'`)) {
      throw new Error('Historic owner credential is not explicitly neutralized by the later migration');
    }
  }

  return true;
}

function run() {
  let database;
  try {
    // lstat rejects symlinks; readonly + query_only prevents SQLite writes.
    // A missing, truncated or non-SQLite artifact must fail before signing.
    const stat = fs.lstatSync(SEED_PATH);
    if (!stat.isFile() || stat.size < 16) {
      throw new Error('Bundled SQLite seed is missing, empty or not a regular file');
    }
    database = new Database(SEED_PATH, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    validate({
      database,
      migrationSource: fs.readFileSync(MIGRATION_PATH, 'utf8'),
      schemaSource: fs.readFileSync(SCHEMA_PATH, 'utf8'),
      cleanupSource: fs.readFileSync(OWNER_CLEANUP_PATH, 'utf8'),
      mainSource: fs.readFileSync(MAIN_PATH, 'utf8'),
      authSource: fs.readFileSync(AUTH_PATH, 'utf8'),
    });
    console.log('Commercial release seed preflight passed');
    return true;
  } catch (error) {
    console.error(`Commercial release seed preflight BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (database) database.close();
  }
}

module.exports = { validate, run };

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error('Commercial release seed preflight accepts no arguments or path overrides');
    process.exitCode = 1;
  } else {
    process.exitCode = run() ? 0 : 1;
  }
}
