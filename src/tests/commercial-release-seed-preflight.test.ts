/** @jest-environment node */

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

const { validate, run } = require('../../scripts/check-commercial-release-seed.js');

function fixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT,
      role TEXT, is_active INTEGER DEFAULT 1
    );
  `);
  return database;
}

function check(database: Database.Database, migrationSource = '-- synthetic migration', schemaSource = '// synthetic schema') {
  return validate({ database, migrationSource, schemaSource });
}

describe('commercial release seed preflight (synthetic SQLite only)', () => {
  let database: Database.Database;

  beforeEach(() => { database = fixture(); });
  afterEach(() => { database.close(); });

  it('exposes a fixed-path CLI runner and accepts a seed with no usable bundled credentials', () => {
    expect(typeof run).toBe('function');
    expect(check(database)).toBe(true);
    database.exec(`
      INSERT INTO users (id, username, role, password_hash)
      VALUES ('owner', 'new-owner', 'owner', NULL), ('staff', 'employee', 'cashier', '  ');
    `);
    expect(check(database)).toBe(true);
  });

  it.each([
    ['owner', 'owner', 1, bcrypt.hashSync('not-a-default', 4)],
    ['cashier', 'cashier', 1, 'plaintext-is-also-configured'],
    ['disabled', 'owner', 0, bcrypt.hashSync('inactive-password', 4)],
  ])('rejects a configured password hash on any bundled account (%s)', (id, role, active, hash) => {
    database.prepare('INSERT INTO users (id, username, role, is_active, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, role, active, hash);
    expect(() => check(database)).toThrow('configured user password hash');
  });

  it('rejects the same hard-coded bcrypt hash appearing in the migration and runtime schema', () => {
    const fixedHash = bcrypt.hashSync('synthetic-secret', 4);
    expect(() => check(database, `INSERT INTO users VALUES ('admin', '${fixedHash}')`,
      `const credential = '${fixedHash}'`)).toThrow('share a hard-coded bcrypt');
  });

  it('rejects the known admin password even if the migration and runtime hashes have different salts', () => {
    const one = bcrypt.hashSync('admin', 4);
    const two = bcrypt.hashSync('admin', 4);
    expect(one).not.toBe(two);
    expect(() => check(database, `'${one}'`, `'${two}'`))
      .toThrow('hard-coded bcrypt password hash');
  });

  it('rejects a single embedded bcrypt literal even when it is not shared or a known default', () => {
    expect(() => check(database, '-- safe', `let hash = '${bcrypt.hashSync('random-synthetic', 4)}'`))
      .toThrow('hard-coded bcrypt password hash');
  });

  it('preserves migration-001 checksum while the registered forward-only migration clears only the known owner secret', () => {
    const root = path.resolve(__dirname, '../..');
    const historic = fs.readFileSync(path.join(root, 'src-tauri/migrations/001_initial.sql'),'utf8');
    const cleanup = fs.readFileSync(path.join(root,
      'src-tauri/migrations/032_remove_public_owner_bootstrap_credential.sql'),'utf8');
    const main = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'),'utf8');
    const auth = fs.readFileSync(path.join(root, 'src-tauri/src/commands/auth.rs'),'utf8');
    const schema = fs.readFileSync(path.join(root, 'src-tauri/src/schema.rs'),'utf8');
    const historicHash = historic.match(/\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}/)?.[0];
    expect(historicHash).toBeTruthy();
    database.prepare('INSERT INTO users(id,username,password_hash,role) VALUES (?,?,?,?)')
      .run('admin','admin',historicHash,'owner');
    expect(() => validate({ database, migrationSource: historic, schemaSource: schema,
      cleanupSource: cleanup, mainSource: main, authSource: auth })).toThrow('configured user password hash');
    const changedHash = bcrypt.hashSync('DistinctOwner!Password2026',4);
    database.prepare('INSERT INTO users(id,username,password_hash,role) VALUES (?,?,?,?)')
      .run('different-owner','different-owner',changedHash,'owner');
    database.exec(cleanup);
    expect(database.prepare('SELECT password_hash FROM users WHERE id = ?').get('admin'))
      .toEqual({ password_hash: null });
    expect(database.prepare('SELECT password_hash FROM users WHERE id = ?').get('different-owner'))
      .toEqual({ password_hash: changedHash });
    // Commercial seed cannot bundle even a legitimate customer credential.
    expect(() => validate({ database, migrationSource: historic, schemaSource: schema,
      cleanupSource: cleanup, mainSource: main, authSource: auth })).toThrow('configured user password hash');
    database.prepare('DELETE FROM users WHERE id = ?').run('different-owner');
    expect(validate({ database, migrationSource: historic, schemaSource: schema,
      cleanupSource: cleanup, mainSource: main, authSource: auth })).toBe(true);
  });

  it('fails closed when the SQLite schema or validation input is incomplete', () => {
    expect(() => validate({ database, schemaSource: null, migrationSource: '-- sql' }))
      .toThrow('Missing or invalid');
    const missingUsers = new Database(':memory:');
    try {
      expect(() => check(missingUsers)).toThrow();
    } finally {
      missingUsers.close();
    }
  });

  it('keeps the CLI path fixed and gates both architectures before signing', () => {
    const root = path.resolve(__dirname, '../..');
    const script = fs.readFileSync(path.join(root, 'scripts/check-commercial-release-seed.js'), 'utf8');
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    expect(script).toContain("path.join(ROOT, 'src-tauri', 'pharma_local.db')");
    expect(script).toContain('readonly: true, fileMustExist: true');
    expect(script).not.toContain('process.env.');
    expect(workflow.match(/run: node scripts\/check-commercial-release-seed\.js/g)).toHaveLength(2);
    expect(workflow.match(/run: npm audit --omit=dev --audit-level=high/g)).toHaveLength(2);
    expect(workflow).toContain('npm run seed:db && node scripts/check-commercial-release-seed.js && npm run build:tauri');
    expect(workflow).toContain("$config.build.beforeBuildCommand = 'node scripts/check-commercial-release-seed.js'");
  });
});
