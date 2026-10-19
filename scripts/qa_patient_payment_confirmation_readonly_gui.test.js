#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  accepted, factsBlocked, parseLaunch, payloadFor,
  verifiedWitness, nativeExpression,
} = require('./qa_patient_payment_confirmation_readonly_gui');

const OWNER = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const PATIENT = 'qa-prospectively-owned-patient';
const NONCE = '550e8400-e29b-41d4-a716-446655440000';
const SHA = 'A'.repeat(64);
const PLAN = {
  actorId: OWNER, tenantId: TENANT, qaDataOnly: true, patientId: PATIENT,
  patientName: 'QA Patient PhaseTwo 123456abcdef',
};
const WITNESS = {
  patientId: PATIENT, actorId: OWNER, pharmacyId: TENANT,
  intentSha256: 'a'.repeat(64), oneOwnedPatient: true,
  noCreditSale: true, no051PaymentReceipt: true, noPatientPayment: true,
};

test('read-only 061 witness rejects foreign/malformed/ambiguous or paid source', () => {
  assert.equal(verifiedWitness(WITNESS, PLAN), true);
  assert.equal(verifiedWitness(WITNESS, { ...PLAN, patientId: undefined }), true);
  for (const invalid of [
    { ...WITNESS, patientId: 'other-patient' },
    { ...WITNESS, patientId: "x' OR 1=1 --" },
    { ...WITNESS, patientId: '' },
    { ...WITNESS, pharmacyId: 'local_default' },
    { ...WITNESS, pharmacyId: 'foreign-tenant' },
    { ...WITNESS, actorId: 'other-user' },
    { ...WITNESS, intentSha256: '' },
    { ...WITNESS, intentSha256: 'G'.repeat(64) },
    { ...WITNESS, oneOwnedPatient: false },
    { ...WITNESS, noCreditSale: false },
    { ...WITNESS, no051PaymentReceipt: false },
    { ...WITNESS, noPatientPayment: false },
  ]) {
    assert.equal(verifiedWitness(invalid, PLAN), false, JSON.stringify(Object.keys(invalid)));
  }
  for (const invalidPlan of [
    { ...PLAN, actorId: 'foreign-user' },
    { ...PLAN, tenantId: 'foreign-tenant' },
    { ...PLAN, qaDataOnly: false },
    { ...PLAN, patientId: 'foreign-patient' },
    { ...PLAN, patientId: null },
  ]) assert.equal(verifiedWitness(WITNESS, invalidPlan), false);
  assert.equal(verifiedWitness(null, PLAN), false);
});

test('confirmation payload is exact new v4, bank, 1.00, canonical date and no notes', () => {
  const payload = payloadFor(PATIENT, NONCE, '2026-10-17');
  assert.deepEqual(payload, {
    patientId: PATIENT, shiftId: null, amount: 1, paymentMethod: 'bank',
    notes: null, date: '2026-10-17', requestId: NONCE,
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.deepEqual(payloadFor(PATIENT, randomUUID(), '2026-10-17').paymentMethod, 'bank');
  for (const invalidNonce of [
    '', '00000000-0000-0000-0000-000000000000',
    '550e8400-e29b-11d4-a716-446655440000',
    '550E8400-E29B-41D4-A716-446655440000',
    '550e8400-e29b-41d4-7716-446655440000',
  ]) assert.throws(() => payloadFor(PATIENT, invalidNonce, '2026-10-17'));
  for (const date of ['2026-02-30', '2026-13-01', '2026-10-17T00:00:00', '']) {
    assert.throws(() => payloadFor(PATIENT, NONCE, date));
  }
  assert.throws(() => payloadFor('local_default', NONCE, '2026-10-17'));
  assert.throws(() => payloadFor("patient';UPDATE patient_transactions", NONCE, '2026-10-17'));
});

test('actual WebView expression can only request actor and native read-only confirmation once', () => {
  const expression = nativeExpression(payloadFor(PATIENT, NONCE, '2026-10-17'));
  const nativeCalls = [...expression.matchAll(/invoke\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(nativeCalls, ['current_local_user', 'confirm_patient_payment_native']);
  assert.match(expression, /original===null/);
  assert.match(expression, /actor\?\.role==='owner'/);
  assert.match(expression, /paymentMethod":"bank"/);
  assert.match(expression, /"amount":1/);
  assert.match(expression, /"shiftId":null/);
  assert.doesNotMatch(expression, /create_patient_payment|record_patient_payment|submit_patient_payment|post_patient_payment|\.click\(|Page\.navigate/);
  assert.doesNotMatch(expression, /console\.|log\(|catch\s*\(/);
});

test('acceptance demands every independent boolean, exact null, and no payment writer', () => {
  const expected = Object.fromEntries(Object.keys(factsBlocked()).map(key => [key, true]));
  assert.equal(accepted(expected), true);
  for (const key of Object.keys(expected)) {
    assert.equal(accepted({ ...expected, [key]: false }), false, key);
    assert.equal(accepted({ ...expected, [key]: null }), false, key);
    const omitted = { ...expected };
    delete omitted[key];
    assert.equal(accepted(omitted), false, key);
  }
  assert.equal(accepted({ ...expected, nativeConfirmationNull: 'true' }), false);
  assert.equal(accepted(null), false);
  assert.ok(Object.values(factsBlocked()).every(value => value === false));
});

test('CLI defaults blocked without witnessed, SHA-pinned and explicit exclusive process', () => {
  for (const args of [
    [], ['--execute'], ['--execute', '--exclusive-confirm', 'abc', SHA, 'plan'],
    ['--execute', '--exclusive-confirm', '3333', 'short', 'plan'],
    ['--execute', '--exclusive-confirm', '3333', SHA.toLowerCase(), 'plan'],
    ['--execute', '--exclusive-confirm', '3333', SHA, ''],
    ['--execute', '--not-exclusive', '3333', SHA, 'plan'],
  ]) assert.throws(() => parseLaunch(args));
  assert.deepEqual(parseLaunch(['--execute', '--exclusive-confirm', '3333', SHA, 'qa-plan.json']), {
    pid: 3333, sha: SHA, planPath: 'qa-plan.json',
  });

  const script = path.join(__dirname, 'qa_patient_payment_confirmation_readonly_gui.js');
  const completed = spawnSync(process.execPath, [script], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(completed.status, 2);
  assert.equal(completed.stderr, '');
  assert.match(completed.stdout, /^PINNED_QA_PATIENT_PAYMENT_READONLY_CONFIRMATION=\{[^\n]+\}\r?\n$/);
  const facts = JSON.parse(completed.stdout.trim().split('=')[1]);
  assert.deepEqual(facts, factsBlocked());
  assert.ok(Object.values(facts).every(value => typeof value === 'boolean'));
});

test('static custody/provenance invariants keep runner read-only and default-blocked', () => {
  const script = fs.readFileSync(path.join(__dirname, 'qa_patient_payment_confirmation_readonly_gui.js'), 'utf8');
  assert.match(script, /verifiedPlan\(planPath\)/);
  assert.match(script, /assertCustody\(pid, sha\)/);
  assert.match(script, /PRAGMA query_only=ON/);
  assert.match(script, /mode=ro/);
  assert.match(script, /native_patient_directory_ownership/);
  assert.match(script, /native_patient_financial_journal_receipts/);
  assert.match(script, /SELECT COUNT\(\*\) FROM sales_invoices/);
  assert.match(script, /--exclusive-confirm/);
  assert.match(script, /Runtime\.evaluate/);
  assert.doesNotMatch(script, /\bsend\('Page\.navigate'/);
  assert.doesNotMatch(script, /\binvoke\('(?:record|create|post|save|update|submit|settle)_[^']+'/);
  // sqlite3 .execute is used exclusively for SELECT and read-only PRAGMAs;
  // the harness must never contain SQL mutations or batch script execution.
  assert.doesNotMatch(script, /db\.(?:execute|executemany)\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|VACUUM)\b/i);
  assert.doesNotMatch(script, /db\.executescript\(/);
});
