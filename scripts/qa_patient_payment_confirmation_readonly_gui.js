#!/usr/bin/env node
'use strict';

/**
 * Prime-operated, read-only Windows WebView2 probe for the exact prospective
 * Stage-A synthetic patient. One authenticated native *confirmation*, never a
 * payment, receipt insertion, finance writer, DOM click or browser navigation.
 * No PID, hash, nonce, person, patient ID, amount, date or IPC error is logged.
 * The negative proof requires no existing 051 patient payment source and no
 * completed credit-sale origin; it cannot prove a positive payment workflow.
 */
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');

const ACTOR = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const CANONICAL_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATIENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SHA = /^[0-9A-F]{64}$/;
const FACT_NAME = 'PINNED_QA_PATIENT_PAYMENT_READONLY_CONFIRMATION=';

function validPatientId(value) {
  return typeof value === 'string' && SAFE_PATIENT_ID.test(value)
    && value !== 'local_default';
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function payloadFor(patientId, requestId, date) {
  if (!validPatientId(patientId) || typeof requestId !== 'string'
      || !CANONICAL_V4.test(requestId) || !isIsoDate(date)) {
    throw Error('Unverified payment confirmation witness');
  }
  return Object.freeze({
    patientId, shiftId: null, amount: 1.00, paymentMethod: 'bank',
    notes: null, date, requestId,
  });
}

// No supplier/patient data are printed by the witness subprocess. The only
// raw field emitted to this Node process is the exact synthetic patient ID.
const READONLY_PATIENT_WITNESS = String.raw`
import json, os, pathlib, sqlite3
p = (pathlib.Path(os.environ['APPDATA']) / 'com.pharma.disposable.lifecycle.qa20261016' / 'pharma_local.db').resolve()
name = os.environ['QA_PATIENT_WITNESS_NAME']
db = sqlite3.connect(p.as_uri() + '?mode=ro', uri=True, timeout=5)
try:
    db.execute('PRAGMA query_only=ON')
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise SystemExit(3)
    if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
        raise SystemExit(4)
    rows = db.execute('''SELECT p.id,w.actor_id,w.pharmacy_id,w.intent_sha256
        FROM patients p JOIN native_patient_directory_ownership w ON w.patient_id=p.id
        WHERE p.full_name=? AND w.actor_id=? AND w.pharmacy_id=?
        LIMIT 3''', (name,'qa_lifecycle_owner_20261016','qa_lifecycle_20261016')).fetchall()
    if len(rows) != 1 or db.execute(
        'SELECT COUNT(*) FROM patients WHERE full_name=?',(name,)).fetchone()[0] != 1:
        raise SystemExit(5)
    patient_id,actor,tenant,intent = rows[0]
    credit = db.execute('''SELECT COUNT(*) FROM sales_invoices
        WHERE patient_id=? AND LOWER(COALESCE(payment_method,''))='credit' ''',
        (patient_id,)).fetchone()[0]
    receipts = db.execute('''SELECT COUNT(*) FROM native_patient_financial_journal_receipts
        WHERE source_kind='payment' AND pharmacy_id=?''',
        ('qa_lifecycle_20261016',)).fetchone()[0]
    payments = db.execute('''SELECT COUNT(*) FROM patient_transactions
        WHERE patient_id=? AND type='payment' ''',(patient_id,)).fetchone()[0]
    print(json.dumps(dict(patientId=patient_id,actorId=actor,pharmacyId=tenant,
        intentSha256=intent,oneOwnedPatient=True,noCreditSale=(credit==0),
        no051PaymentReceipt=(receipts==0),noPatientPayment=(payments==0))))
finally:
    db.close()
`;

function verifiedWitness(witness, plan) {
  return witness !== null && typeof witness === 'object'
    && validPatientId(witness.patientId)
    && witness.actorId === ACTOR && witness.pharmacyId === TENANT
    && typeof witness.intentSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(witness.intentSha256)
    && witness.oneOwnedPatient === true
    && witness.noCreditSale === true
    && witness.no051PaymentReceipt === true
    && witness.noPatientPayment === true
    && plan?.actorId === ACTOR && plan?.tenantId === TENANT
    && plan?.qaDataOnly === true
    && (plan.patientId === undefined || plan.patientId === witness.patientId);
}

function readonlyWitness(plan) {
  const child = spawnSync('python', ['-B', '-c', READONLY_PATIENT_WITNESS], {
    encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4096,
    env: { ...process.env, QA_PATIENT_WITNESS_NAME: plan.patientName },
  });
  if (child.status !== 0 || !child.stdout || child.stdout.length > 2048) {
    throw Error('Independent disposable patient witness unavailable');
  }
  let proof;
  try { proof = JSON.parse(child.stdout); } catch { throw Error('Invalid QA witness format'); }
  if (!verifiedWitness(proof, plan)) throw Error('Cross-scope or unreceipted QA witness');
  return proof;
}

function nativeExpression(input) {
  // ONLY `current_local_user` and the registered read-only confirmation may
  // be invoked. The full private confirmation response stays inside WebView2.
  // The only serialized WebView2 result is an exact-null boolean.
  return `(async()=>{
    const invoke=window.__TAURI_INTERNALS__?.invoke;
    if(typeof invoke!=='function')return {actorTenantVerified:false,confirmationNull:false};
    const actor=await invoke('current_local_user');
    const owned=actor?.id===${JSON.stringify(ACTOR)}
      &&actor?.pharmacy_id===${JSON.stringify(TENANT)}&&actor?.role==='owner';
    if(!owned)return {actorTenantVerified:false,confirmationNull:false};
    const original=await invoke('confirm_patient_payment_native',{payload:${JSON.stringify(input)}});
    return {actorTenantVerified:true,confirmationNull:original===null};
  })()`;
}

const FACT_KEYS = Object.freeze([
  'custodyVerified', 'synthetic061Witness', 'zero051Receipt',
  'zeroCreditSale', 'zeroPatientPayment', 'actorTenantVerified',
  'nativeConfirmationNull', 'sourceUnchanged', 'noPaymentWriter',
]);

function factsBlocked() {
  return Object.fromEntries(FACT_KEYS.map(key => [key, false]));
}

function accepted(facts) {
  return facts !== null && typeof facts === 'object'
    && FACT_KEYS.every(key => facts[key] === true);
}

function parseLaunch(args) {
  if (!Array.isArray(args) || args.length !== 5 || args[0] !== '--execute'
      || args[1] !== '--exclusive-confirm') throw Error('Exclusive verified QA launch required');
  const pid = Number(args[2]);
  const sha = String(args[3]);
  const planPath = args[4];
  if (!Number.isSafeInteger(pid) || pid < 100 || !SHA.test(sha)
      || typeof planPath !== 'string' || !planPath) {
    throw Error('Pinned QA process and plan required');
  }
  return { pid, sha, planPath };
}

async function run(args) {
  const { pid, sha, planPath } = parseLaunch(args);
  const plan = verifiedPlan(planPath);
  if (plan.patientId !== undefined && !validPatientId(plan.patientId)) {
    throw Error('Malformed plan patient identity');
  }
  // Process and WebView2 ownership is mandatory before ANY local QA DB read.
  assertCustody(pid, sha);
  const source = readonlyWitness(plan);
  const nonce = randomUUID(); // Never use a prior payment nonce from a plan.
  const input = payloadFor(source.patientId, nonce, new Date().toISOString().slice(0, 10));
  assertCustody(pid, sha);
  const response = await fetch('http://127.0.0.1:9334/json/list', {
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw Error('Pinned WebView target unavailable');
  const all = await response.json();
  if (!Array.isArray(all) || all.length > 3) throw Error('Ambiguous WebView target count');
  const pages = all.filter(t => t?.type === 'page');
  const app = pages.filter(t => {
    try { const u = new URL(t.url); return u.hostname === 'tauri.localhost'
      && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
    catch { return false; }
  });
  const hub = pages.filter(t => {
    try { return new URL(t.url).hostname === 'downloads-hub'; } catch { return false; }
  });
  if (app.length !== 1 || hub.length > 1 || pages.length !== app.length + hub.length
      || all.length !== pages.length) throw Error('QA WebView target is not unique');
  const debuggerUrl = new URL(app[0].webSocketDebuggerUrl);
  if (debuggerUrl.protocol !== 'ws:' || debuggerUrl.hostname !== '127.0.0.1'
      || debuggerUrl.port !== '9334' || !debuggerUrl.pathname.startsWith('/devtools/page/')) {
    throw Error('QA WebView debugger endpoint is not pinned');
  }
  assertCustody(pid, sha);
  const ws = new WebSocket(debuggerUrl.href);
  await new Promise((yes, no) => {
    ws.addEventListener('open', yes, { once: true });
    ws.addEventListener('error', no, { once: true });
  });
  const pending = new Map();
  let counter = 0;
  ws.addEventListener('message', event => {
    let result;
    try { result = JSON.parse(event.data); } catch { return; }
    const task = pending.get(result.id);
    if (!task) return;
    pending.delete(result.id);
    clearTimeout(task.timeout);
    result.error ? task.no(Error('Read-only CDP request rejected')) : task.yes(result.result);
  });
  const send = (method, params) => new Promise((yes, no) => {
    const id = ++counter;
    const timeout = setTimeout(() => {
      pending.delete(id); no(Error('Read-only WebView timeout'));
    }, 18000);
    pending.set(id, { yes, no, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Runtime.enable', {});
    assertCustody(pid, sha);
    const packet = await send('Runtime.evaluate', {
      expression: nativeExpression(input), awaitPromise: true, returnByValue: true,
    });
    if (packet?.exceptionDetails || packet?.result?.type !== 'object') {
      throw Error('Read-only native confirmation was not completed');
    }
    const result = packet.result.value;
    // A rejection/exception is NOT proof of null; it must fail closed.
    if (result?.actorTenantVerified !== true || result?.confirmationNull !== true) {
      throw Error('No verified read-only null confirmation');
    }
    // Independent postflight query ensures no source, credit sale, receipt or
    // payment appeared during the probe. No write is issued by this runner.
    const after = readonlyWitness(plan);
    assertCustody(pid, sha);
    const facts = {
      custodyVerified: true,
      synthetic061Witness: true,
      zero051Receipt: source.no051PaymentReceipt === true && after.no051PaymentReceipt === true,
      zeroCreditSale: source.noCreditSale === true && after.noCreditSale === true,
      zeroPatientPayment: source.noPatientPayment === true && after.noPatientPayment === true,
      actorTenantVerified: result.actorTenantVerified === true,
      nativeConfirmationNull: result.confirmationNull === true,
      sourceUnchanged: after.patientId === source.patientId
        && after.intentSha256 === source.intentSha256,
      noPaymentWriter: true,
    };
    if (!accepted(facts)) throw Error('Read-only confirmation witness changed');
    return facts;
  } finally {
    ws.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(facts => { console.log(FACT_NAME + JSON.stringify(facts)); })
    .catch(() => {
      // No exception messages, IDs, request body, patient info, amount or date.
      console.log(FACT_NAME + JSON.stringify(factsBlocked()));
      process.exitCode = 2;
    });
}

module.exports = { accepted, factsBlocked, parseLaunch, payloadFor,
  verifiedWitness, nativeExpression };
