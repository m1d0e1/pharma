'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireWorkspaceExclusive, lockPathFor } = require('./qa-build-exclusive');

const root = path.resolve(__dirname, '..');

test('static export and background test partitions cannot own one workspace concurrently', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-qa-build-lock-test-'));
  try {
    const file = lockPathFor(root, temporary);
    const releaseQa = acquireWorkspaceExclusive(root, 'qa:background', temporary);
    assert.equal(fs.existsSync(file), true);
    assert.throws(() => acquireWorkspaceExclusive(root, 'build:tauri', temporary), /overlap refused/);
    releaseQa();
    releaseQa();
    assert.equal(fs.existsSync(file), false);
    const releaseBuild = acquireWorkspaceExclusive(root, 'build:tauri', temporary);
    assert.throws(() => acquireWorkspaceExclusive(root, 'qa:background', temporary), /overlap refused/);
    releaseBuild();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmdirSync(temporary);
  }
});

test('a changed lock owner is never deleted or reissued during an ambiguous export', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-qa-build-lock-test-'));
  try {
    const file = lockPathFor(root, temporary);
    const release = acquireWorkspaceExclusive(root, 'build:tauri', temporary);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original + 'intervening-owner', { encoding: 'utf8' });
    assert.throws(release, /owner changed/);
    assert.equal(fs.existsSync(file), true);
    fs.writeFileSync(file, original, { encoding: 'utf8' });
    release();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmdirSync(temporary);
  }
});

test('the actual static build refuses a held QA lock before it renames middleware', () => {
  const middleware = path.join(root, 'src', 'middleware.ts');
  const temporaryMiddleware = path.join(root, 'middleware_temp.ts');
  assert.equal(fs.existsSync(middleware), true, 'repository must be restored before this test');
  assert.equal(fs.existsSync(temporaryMiddleware), false, 'no active static export permitted');
  const before = fs.readFileSync(middleware);
  const release = acquireWorkspaceExclusive(root, 'qa:background');
  try {
    const blocked = spawnSync(process.execPath, [path.join(__dirname, 'build-tauri.js')], {
      cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.equal(blocked.status, 1, String(blocked.error || blocked.stderr));
    assert.match(blocked.stderr, /QA\/build overlap refused/);
    assert.equal(fs.existsSync(temporaryMiddleware), false);
    assert.deepEqual(fs.readFileSync(middleware), before);
  } finally {
    release();
  }
});

test('actual background QA refuses a held static-export lock before running Jest', () => {
  const middleware = path.join(root, 'src', 'middleware.ts');
  assert.equal(fs.existsSync(middleware), true);
  const before = fs.readFileSync(middleware);
  const release = acquireWorkspaceExclusive(root, 'build:tauri');
  try {
    const blocked = spawnSync(process.execPath, [path.join(__dirname, 'qa-background.js'),
      '--headless-only', '--headless-filter=middleware-tauri-dev'], {
      cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.equal(blocked.status, 1, String(blocked.error || blocked.stderr));
    assert.match(blocked.stderr, /QA\/build overlap refused/);
    assert.doesNotMatch(blocked.stdout, /QA Jest [0-9]+:/);
    assert.deepEqual(fs.readFileSync(middleware), before);
  } finally {
    release();
  }
});
