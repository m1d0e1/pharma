'use strict';

// Regression for production-safe customer upgrades: the bundled CSV is
// reference material, never implicit authorization to rewrite an existing
// pharmacy's inventory retail prices or master-drug history on startup.
// Source-only: this test does not open or alter any customer/QA database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const main = () => fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
const repairCopy = () => fs.readFileSync(path.join(ROOT, 'scripts/repair-catalog-copy.js'), 'utf8');

function assertFreshSeedOnlyRepair(source) {
  // A pre-existing zero-byte database is disputed source custody, NOT a new
  // installation. Only a truly absent database can request a bundled seed.
  assert.match(source, /let should_copy_seed\s*=\s*!db_path\.exists\(\)\s*;/);
  assert.match(source, /if should_copy_seed\s*\{\s*let seed_path = seed_path\.as_ref\(\)/);
  assert.match(source, /install_seed_database\(seed_path,\s*&db_path\)\?/);
  const guarded = /if should_copy_seed\s*\{\s*if let Some\(seed_path\) = seed_path\s*\{\s*match schema::repair_catalog_name_drift\(&db_path,\s*&seed_path\)/;
  assert.match(source, guarded,
    'auto catalog/reference repair must be guarded by fresh seed installation');
  assert.equal((source.match(/schema::repair_catalog_name_drift\(&db_path,\s*&seed_path\)/g) || []).length, 1,
    'no other automatic catalog rewrite path is reviewed');
}

test('existing pharmacy native startup skips bundled CSV retail and catalog metadata repair', () => {
  assertFreshSeedOnlyRepair(main());
});

test('adversarial removal or weakening of fresh-seed guard is rejected', () => {
  const source = main();
  assert.throws(
    () => assertFreshSeedOnlyRepair(source.replace(
      'if should_copy_seed {\n                if let Some(seed_path) = seed_path {',
      'if true {\n                if let Some(seed_path) = seed_path {',
    )),
    { name: 'AssertionError' },
  );
  assert.throws(
    () => assertFreshSeedOnlyRepair(source.replace(
      'if should_copy_seed {\n                if let Some(seed_path) = seed_path {',
      'if let Some(seed_path) = seed_path {',
    )),
    { name: 'AssertionError' },
  );
  assert.throws(
    () => assertFreshSeedOnlyRepair(source.replace(
      'let should_copy_seed = !db_path.exists();',
      'let should_copy_seed = !db_path.exists() || fs::metadata(&db_path).map(|m| m.len()==0).unwrap_or(true);',
    )),
    { name: 'AssertionError' },
  );
});

test('legacy ownership preflight refuses zero-byte or orphaned WAL before seed installation', () => {
  const guard = fs.readFileSync(path.join(ROOT, 'src-tauri/src/legacy_upgrade_guard.rs'), 'utf8');
  assert.match(guard, /fn existing_profile_state\(path: &Path\) -> Result<bool, String>/);
  assert.match(guard, /metadata\.len\(\) == 0/);
  assert.match(guard, /\["-wal", "-shm", "-journal"\]/);
  assert.match(guard, /inspect_preexisting_profile\(path: &Path\)[\s\S]*?if !existing_profile_state\(path\)\?/);
  assert.match(guard, /requires_forward_backup\(path: &Path, latest: i64\)[\s\S]*?if !existing_profile_state\(path\)\?/);
});

test('explicit offline catalog recovery preserves input and requires price opt-in', () => {
  const source = repairCopy();
  assert.match(source, /const source = new Database\(input,\s*\{\s*readonly:\s*true,\s*fileMustExist:\s*true\s*\}\)/);
  assert.match(source, /if \(input === output \|\| fs\.existsSync\(output\)/);
  assert.match(source, /updateInventoryPrices = false/);
  assert.match(source, /option === '--inventory-prices'/);
  assert.match(source, /assert\.deepEqual\(fingerprints\(db,\s*updateInventoryPrices\),\s*before/);
});
