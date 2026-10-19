#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {
  accepted, factsBlocked, parseLaunch, nativeExpression,
  verifiedNativeDenial, verifiedTarget,
} = require('./qa_legacy_upgrade_denial_gui');

const OWNER = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const EXACT_DENIAL = 'Archive reading has not been independently authorized';
const HASH = 'A'.repeat(64);

const successReply = Object.freeze({
  actorTenantVerified: true, archiveReadAttemptedOnce: true,
  exactMissingGrantRejected: true, noArchiveFactsReturned: true,
});

function runMockedBridge(options = {}) {
  const calls = [];
  const invoke = async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'current_local_user') {
      return Object.prototype.hasOwnProperty.call(options, 'actor')
        ? options.actor : { id: OWNER, pharmacy_id: TENANT, role: 'owner' };
    }
    if (name === 'read_legacy_archive_scope_facts_native') {
      if (options.returnValue !== undefined) return options.returnValue;
      throw options.error ?? EXACT_DENIAL;
    }
    throw Error('Unexpected financial writer/native bridge call');
  };
  const context = { window: { __TAURI_INTERNALS__: { invoke } } };
  return Promise.resolve(vm.runInNewContext(nativeExpression(), context))
    .then(result => ({ result: JSON.parse(JSON.stringify(result)), calls }));
}

test('only exact grant-absent native rejection qualifies; no archive facts are returned', async () => {
  const { result, calls } = await runMockedBridge();
  assert.deepEqual(result, successReply);
  assert.equal(verifiedNativeDenial(result), true);
  assert.deepEqual(calls.map(x => x.name), [
    'current_local_user', 'read_legacy_archive_scope_facts_native',
  ]);
  assert.equal(calls[1].payload, undefined, 'no renderer path, SQL or grant parameter');

  for (const error of [
    'Command read_legacy_archive_scope_facts_native not found',
    'Unauthorized', 'Archive not found', '',
    'Archive reading has not been independently authorized ',
    { message: EXACT_DENIAL },
  ]) {
    const reply = (await runMockedBridge({ error })).result;
    assert.equal(reply.exactMissingGrantRejected, false);
    assert.equal(verifiedNativeDenial(reply), false);
  }
});

test('a successful native archive result is a denial-probe FAILURE, never a success', async () => {
  for (const data of [{ readOnly: true }, { explicitScopeBusinessCounts: {} }, null]) {
    const { result, calls } = await runMockedBridge({ returnValue: data });
    assert.equal(result.archiveReadAttemptedOnce, true);
    assert.equal(result.exactMissingGrantRejected, false);
    assert.equal(result.noArchiveFactsReturned, false);
    assert.equal(verifiedNativeDenial(result), false);
    assert.equal(calls.length, 2);
  }
});

test('wrong actor, tenant or role blocks the archive bridge entirely', async () => {
  for (const actor of [
    null,
    { id: 'other-owner', pharmacy_id: TENANT, role: 'owner' },
    { id: OWNER, pharmacy_id: 'local_default', role: 'owner' },
    { id: OWNER, pharmacy_id: 'other-tenant', role: 'owner' },
    { id: OWNER, pharmacy_id: TENANT, role: 'admin' },
    { id: OWNER, pharmacy_id: TENANT, role: 'cashier' },
  ]) {
    const { result, calls } = await runMockedBridge({ actor });
    assert.deepEqual(calls.map(item => item.name), ['current_local_user']);
    assert.equal(result.actorTenantVerified, false);
    assert.equal(result.archiveReadAttemptedOnce, false);
    assert.equal(verifiedNativeDenial(result), false);
  }
});

test('the WebView expression has only the two exact allowed IPC calls', () => {
  const expression = nativeExpression();
  assert.deepEqual([...expression.matchAll(/invoke\('([^']+)'/g)].map(match => match[1]), [
    'current_local_user', 'read_legacy_archive_scope_facts_native',
  ]);
  assert.match(expression, /message===['"]Archive reading has not been independently authorized['"]/);
  assert.match(expression, /owner\?\.role==='owner'/);
  assert.doesNotMatch(expression, /\.click\(|fetch\(|Page\.navigate|console\.|document\.|localStorage|sessionStorage/);
  assert.doesNotMatch(expression, /(?:execute_sql|execute_batch|post_|pay_|update_|INSERT|DELETE|CREATE TABLE)/);
  assert.doesNotMatch(expression, /actor\.id\s*=|archivePath|snapshotPath|expectedSha/);
});

test('accepted facts require exactly all seven true booleans, never raw exceptions', () => {
  const good = Object.fromEntries(Object.keys(factsBlocked()).map(key => [key, true]));
  assert.equal(accepted(good), true);
  for (const key of Object.keys(good)) {
    assert.equal(accepted({ ...good, [key]: false }), false);
    assert.equal(accepted({ ...good, [key]: 'true' }), false);
    const without = { ...good };
    delete without[key];
    assert.equal(accepted(without), false);
  }
  assert.equal(accepted({ ...good, error: EXACT_DENIAL }), false);
  assert.equal(accepted(null), false);
  assert.ok(Object.values(factsBlocked()).every(x => x === false));
  for (const bad of [
    { ...successReply, noArchiveFactsReturned: 'true' },
    { ...successReply, nativeError: EXACT_DENIAL },
    { ...successReply, exactMissingGrantRejected: null },
    null,
  ]) assert.equal(verifiedNativeDenial(bad), false);
});

test('QA CDP target validation rejects foreign pages, endpoint, or extra tabs', () => {
  const page = {
    type: 'page', url: 'http://tauri.localhost/patients',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/page/A123-b456',
  };
  assert.equal(verifiedTarget([page]), page.webSocketDebuggerUrl);
  const hub = { ...page, url: 'http://downloads-hub/' };
  assert.equal(verifiedTarget([page, hub]), page.webSocketDebuggerUrl);
  for (const invalid of [
    [], [page, page], [page, page, hub],
    [{ ...page, url: 'http://evil.test/' }],
    [{ ...page, url: 'https://tauri.localhost/patients' }],
    [{ ...page, webSocketDebuggerUrl: 'ws://localhost:9334/devtools/page/a' }],
    [{ ...page, webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/a' }],
    [{ ...page, webSocketDebuggerUrl: 'ws://127.0.0.1:9334/devtools/browser/a' }],
    [page, { ...hub, type: 'service_worker' }],
  ]) assert.throws(() => verifiedTarget(invalid));
});

test('default CLI stays blocked without exclusive custody; output is boolean-only', () => {
  for (const args of [
    [], ['--execute'],
    ['--execute', '--exclusive-confirm', '0', HASH, 'plan'],
    ['--execute', '--exclusive-confirm', 'NaN', HASH, 'plan'],
    ['--execute', '--exclusive-confirm', '3333', HASH.toLowerCase(), 'plan'],
    ['--execute', '--exclusive-confirm', '3333', 'BAD', 'plan'],
    ['--execute', '--exclusive-confirm', '3333', HASH, ''],
    ['--execute', '--other', '3333', HASH, 'plan'],
  ]) assert.throws(() => parseLaunch(args));
  assert.deepEqual(parseLaunch([
    '--execute', '--exclusive-confirm', '3333', HASH, 'qa-plan.json',
  ]), { pid: 3333, sha: HASH, planPath: 'qa-plan.json' });

  // No args never reaches plan, custody, debugger discovery or a real GUI.
  const runner = path.join(__dirname, 'qa_legacy_upgrade_denial_gui.js');
  const completed = spawnSync(process.execPath, [runner], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(completed.status, 2);
  assert.equal(completed.stderr, '');
  assert.match(completed.stdout, /^PINNED_QA_LEGACY_ARCHIVE_GRANT_DENIAL=\{[^\n]+\}\r?\n$/);
  const facts = JSON.parse(completed.stdout.trim().split('=')[1]);
  assert.deepEqual(facts, factsBlocked());
  assert.ok(Object.values(facts).every(x => typeof x === 'boolean'));
});

test('static scripts forbid financial writers, database access and navigation', () => {
  const script = fs.readFileSync(path.join(__dirname, 'qa_legacy_upgrade_denial_gui.js'), 'utf8');
  assert.match(script, /verifiedPlan\(planPath\)/);
  assert.match(script, /assertCustody\(pid, sha\)/);
  assert.match(script, /--execute/);
  assert.match(script, /--exclusive-confirm/);
  assert.match(script, /Runtime\.evaluate/);
  assert.match(script, /read_legacy_archive_scope_facts_native/);
  assert.doesNotMatch(script, /\bsend\('Page\.navigate'/);
  assert.doesNotMatch(script, /\bsend\('(?:DOM\.|Input\.|Network\.|Page\.|Browser\.)/);
  assert.doesNotMatch(script, /(?:sqlite3|better-sqlite3|sqlx|db\.execute|spawnSync|execSync|openSync)/);
  assert.doesNotMatch(script, /\binvoke\('(?:create|update|delete|record|post|submit|settle|pay)_[^']+'/);
});
