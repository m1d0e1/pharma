#!/usr/bin/env node
'use strict';

// Future-only, SINGLE-port, real-form lifecycle QA for the separately owned
// com.pharma.disposable.lifecycle.qa20261016 identity. Never launches/stops an
// app, browser or process, and never opens/modifies the app SQLite database.
// --dry-run (default) is pure, offline and cannot touch CDP or AppData.
// --execute requires independent executable hash + PID attestation, strict
// native SQL denial, a fresh one-shot lease, and UI-only submissions.
//
// Stage A: native-owned supplier form, fresh patient form, report navigation.
// Stage B: operator-reviewed form actions; intentionally NO arbitrary
// window.__TAURI_INTERNALS__.invoke finance writers or renderer SQL shortcuts.
// Every financial step is at-most-one-click. Ambiguous outcome => stop and
// reconcile native immutable receipts manually; NEVER allocate a new nonce.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const IDENTITY = 'com.pharma.disposable.lifecycle.qa20261016';
const ACTOR = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const CDP_PORT = 9334; // Same reviewed port as qa_lifecycle_gui_login/scope.
const STAGE_A = ['supplier-create', 'patient-create', 'purchases-report'];
const STAGE_B = [
  ['purchase', '/purchases/new'],
  ['purchase-report', '/reports/purchases'],
  ['pos', '/pos'],
  ['sales-return', '/returns/new'],
  ['supplier-bank-payment', '/purchases/suppliers'],
  ['purchase-return', '/purchases/returns/new'],
  ['final-purchase-report', '/reports/purchases'],
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isUUID = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const safeLabel = value => typeof value === 'string' && /^QA[-_ A-Za-z0-9\u0600-\u06ff]{12,72}$/.test(value);
const pause = ms => new Promise(done => setTimeout(done, ms));

function parseOptions(argv) {
  const values = {};
  for (let i = 0; i < argv.length; ++i) {
    const key = argv[i];
    if (!['--dry-run', '--execute', '--stage', '--step', '--manifest', '--plan', '--out',
      '--owned-pid', '--confirm-rebuilt-qa'].includes(key)) throw Error('Unknown runner argument');
    if (['--dry-run', '--execute', '--confirm-rebuilt-qa'].includes(key)) {
      if (values[key]) throw Error('Duplicate runner flag');
      values[key] = true;
    } else {
      if (values[key] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Missing or duplicate runner argument');
      values[key] = argv[++i];
    }
  }
  if (values['--execute'] && values['--dry-run']) throw Error('Select exactly one execution mode');
  if (values['--execute'] && !values['--confirm-rebuilt-qa']) throw Error('Explicit rebuilt QA confirmation required');
  const stage = values['--stage'] || 'stage-a';
  if (!['stage-a', 'stage-b'].includes(stage)) throw Error('Unknown lifecycle stage');
  const step = values['--step'] || null;
  if ((stage !== 'stage-b' && step !== null) ||
      (stage === 'stage-b' && values['--execute'] && !STAGE_B.some(s => s[0] === step))) {
    throw Error('Stage B requires exactly one known, individually audited --step');
  }
  if (values['--execute'] && ['--manifest','--plan','--out','--owned-pid'].some(k => !values[k])) {
    throw Error('Execution requires exact manifest, plan, new evidence folder and independently pinned PID');
  }
  return { execute: !!values['--execute'], stage, step, manifest: values['--manifest'],
    plan: values['--plan'], out: values['--out'], ownedPid: values['--owned-pid'] };
}

function validatePlan(plan, stage, requestedStep = null) {
  if (!plan || plan.identity !== IDENTITY || plan.actorId !== ACTOR ||
      plan.tenantId !== TENANT || !isUUID(plan.runId) ||
      plan.qaDataOnly !== true) throw Error('QA-only, explicit identity/actor/tenant/runId plan required');
  if (!safeLabel(plan.supplierName) || !safeLabel(plan.patientName) ||
      plan.supplierName === plan.patientName) throw Error('Use distinct synthetic QA-only labels');
  if (stage === 'stage-b') {
    if (plan.patientFinanceApproved !== true || plan.supplierOwnershipApproved !== true ||
        plan.nativePostingApproved !== true || plan.stageACompleted !== true ||
        !Array.isArray(plan.stageB) ||
        plan.stageB.length !== (requestedStep ? 1 : STAGE_B.length)) {
      throw Error('Stage B requires fresh native ownership witnesses and operator-reviewed Stage A evidence');
    }
    const expectedSteps = requestedStep
      ? STAGE_B.filter(([name]) => name === requestedStep)
      : STAGE_B;
    if (expectedSteps.length !== plan.stageB.length) {
      throw Error('Only the requested and reviewed GUI stage may execute');
    }
    expectedSteps.forEach(([name, route], n) => {
      const step = plan.stageB[n];
      const sequenceIndex = STAGE_B.findIndex(([expected]) => expected === name);
      if (step.name !== name || step.route !== route ||
          !Array.isArray(step.actions) || step.actions.length < 1 ||
          !Array.isArray(step.proof) || step.proof.length < 1) {
        throw Error('Every Stage B form requires ordered operator-reviewed actions and independent UI proof');
      }
      step.actions.forEach(validateAction);
      step.proof.forEach(validateProof);
      if (step.nativeReceiptReviewRequired !== true ||
          (sequenceIndex > 0 && step.precedingNativeReceiptIndependentlyVerified !== true)) {
        throw Error('Stage B must stop between mutations for independent native receipt verification');
      }
      if (step.precommitProof !== undefined) validateProof(step.precommitProof);
      if (['purchase','pos','sales-return','supplier-bank-payment','purchase-return'].includes(name)
          && step.actions.filter(a => a.op === 'click' && a.commit === true).length !== 1) {
        throw Error('Each financial workflow requires exactly one identifiable UI submit');
      }
    });
  }
  return true;
}

function validateAction(action) {
  if (!action || !['click', 'fill', 'select', 'wait'].includes(action.op) ||
      typeof action.selector !== 'string' || !action.selector ||
      action.selector.length > 200 || /[\r\n]/.test(action.selector)) {
    throw Error('Unreviewed or invalid UI selector');
  }
  if (action.op === 'wait') {
    if (action.commit !== undefined || action.value !== undefined || action.text !== undefined) {
      throw Error('Waiting cannot execute or mutate a form');
    }
  } else if (action.op === 'click') {
    if (action.value !== undefined || (action.commit !== undefined && action.commit !== true)) {
      throw Error('Unexpected UI click action');
    }
    if (action.text !== undefined && (typeof action.text !== 'string' || !action.text ||
      action.text.length > 90)) throw Error('Invalid exact visible button label');
  } else if (action.commit !== undefined || !['string', 'number'].includes(typeof action.value)
    || action.text !== undefined || String(action.value).length > 180) {
    throw Error('Only bounded literal GUI field values are allowed');
  }
}
function validateProof(proof) {
  if (!proof || typeof proof.selector !== 'string' || !proof.selector ||
      proof.selector.length > 200 || !['exists','textContains','absent'].includes(proof.kind) ||
      (proof.kind === 'textContains' && (typeof proof.expected !== 'string' ||
        proof.expected.length < 1 || proof.expected.length > 80))) {
    throw Error('Invalid independent DOM confirmation');
  }
}

function dryRun(stage) {
  return {
    mode: 'OFFLINE_DRY_RUN_NO_GUI_OR_APPDATA_ACCESS',
    stage, identity: IDENTITY, actorVerifiedOnExecution: true,
    qaPort: CDP_PORT, strictPrivateSqlMustDeny: 4,
    steps: stage === 'stage-a' ? STAGE_A : STAGE_B.map(([name,route]) => ({name,route,
      manualNativeReceiptReviewBeforeNext:true})),
    stageBBlockedUnless: [
      'native owned supplier witness and separate QA tenant',
      'native patient creation and ownership witness',
      'fresh immutable source/lot/sale lines',
      'operator reviewed form selectors and backend rebuilt QA approval',
      'manual receipt reconciliation between financial UI submits',
    ],
    financeViaRealDOMFormsOnly: true,
    noLaunchNoAppDataNoRawFinanceSql: true,
  };
}

function verifyManifest(manifest, expectedPid, manifestFile) {
  const approvedHash = process.env.PHARMA_QA_APPROVED_EXE_SHA256;
  const approvedPid = process.env.PHARMA_QA_APPROVED_PID;
  if (process.platform !== 'win32' || !hex64(approvedHash) ||
      !Number.isSafeInteger(Number(approvedPid)) || Number(approvedPid) !== Number(expectedPid) ||
      !Number.isSafeInteger(Number(expectedPid)) || Number(expectedPid) <= 4) {
    throw Error('Missing independent QA executable SHA-256 and exact Windows PID approval');
  }
  if (manifest.identifier !== IDENTITY || manifest.actor_id !== ACTOR ||
      manifest.tenant_id !== TENANT || manifest.disposable !== true ||
      manifest.rebuilt_qa_binary !== true || manifest.strict_renderer_sql !== true ||
      manifest.cdp_port !== CDP_PORT || manifest.pid !== Number(expectedPid) ||
      !hex64(manifest.executable_sha256) ||
      manifest.executable_sha256 !== approvedHash) {
    throw Error('Independent lifecycle identity, strict mode, or executable approval mismatch');
  }
  if (!process.env.APPDATA || !manifest.database || !manifest.executable ||
      !fs.existsSync(manifest.executable) || !fs.existsSync(manifest.database)) {
    throw Error('Verified isolated QA executable and database must already exist');
  }
  const executable = fs.realpathSync(manifest.executable);
  const database = fs.realpathSync(manifest.database);
  const expectedDatabase = path.resolve(process.env.APPDATA, IDENTITY, 'pharma_local.db');
  if (database.toLowerCase() !== expectedDatabase.toLowerCase() ||
      executable.toLowerCase().includes('com.pharma.system') ||
      fs.realpathSync(path.resolve(manifestFile)) === database) {
    throw Error('QA database path not independently confined to new disposable app identity');
  }
  const actualHash = sha256(fs.readFileSync(executable));
  if (actualHash !== approvedHash) throw Error('Installed executable is not the approved rebuilt QA binary');
  return { pid: manifest.pid, executable, database, approvedHash };
}

function verifyListener(owner) {
  const ps = [
    `$owner=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}';`,
    'if($null -eq $owner -or $owner.ExecutablePath -ine $env:PHARMA_QA_EXPECTED_EXE){exit 2};',
    `$listeners=@(Get-NetTCPConnection -LocalPort ${CDP_PORT} -State Listen -ErrorAction Stop);`,
    'if($listeners.Count -ne 1){exit 3};$walk=$listeners[0].OwningProcess;',
    `for($i=0;$i -lt 12;$i++){if($walk -eq ${owner.pid}){Write-Output 'OWNED_QA_CDP';exit 0};`,
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId=$walk";',
    'if($null -eq $p){break};$walk=$p.ParentProcessId};exit 4',
  ].join('');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, PHARMA_QA_EXPECTED_EXE: owner.executable },
  });
  if (result.status !== 0 || !result.stdout.includes('OWNED_QA_CDP')) {
    throw Error('Single CDP port is not held by the exact approved QA PID descendant');
  }
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
    socket.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      msg.error ? pending.reject(Error('CDP protocol command failed')) : pending.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP command timed out')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  async evaluate(expression) {
    const outcome = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (outcome.exceptionDetails) throw Error('Reviewed QA page evaluation failed');
    return outcome.result?.value;
  }
  close() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP closed')); }
    this.pending.clear();
    this.socket.close();
  }
}

async function attachOwnedCDP(owner) {
  verifyListener(owner);
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('CDP port returned invalid status');
  const all = await response.json();
  const pages = all.filter(x => x.type === 'page');
  if (pages.length !== 1) throw Error('Expected exactly one isolated native WebView page');
  const target = pages[0];
  const pageUrl = new URL(target.url);
  const websocketUrl = new URL(target.webSocketDebuggerUrl);
  if (pageUrl.hostname !== 'tauri.localhost' ||
      !['127.0.0.1','localhost'].includes(websocketUrl.hostname) ||
      Number(websocketUrl.port) !== CDP_PORT) {
    throw Error('CDP target does not belong to licensed QA Tauri origin/port');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', () => reject(Error('CDP connect denied')), {once:true});
  });
  const cdp = new CDP(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

async function verifyActor(cdp) {
  const actual = await cdp.evaluate(`(async()=>{
    if(location.hostname!=='tauri.localhost'||!window.__TAURI_INTERNALS__)return null;
    const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
    return {id:u?.id,tenant:u?.pharmacy_id,role:u?.role};
  })()`);
  if (actual?.id !== ACTOR || actual.tenant !== TENANT || actual.role !== 'owner') {
    throw Error('Native verified QA actor/tenant/role is not authenticated');
  }
}

async function strictSqlDenial(cdp) {
  // No returned values or error messages ever leave the WebView, just booleans.
  const checks = await cdp.evaluate(`(async()=>{
    const invoke=window.__TAURI_INTERNALS__.invoke;
    const qs=[
      'SELECT id FROM patients LIMIT 1',
      'SELECT x.id FROM (SELECT id FROM users) x LIMIT 1',
      'WITH owned AS (SELECT id FROM suppliers) SELECT count(*) FROM owned',
      'SELECT id FROM supplier_transactions LIMIT 1'
    ];
    const out=[];
    for(const sql of qs){
      try{await invoke('db_select_guarded',{sql,params:[],txId:null});out.push(false);}
      catch(error){
        const summary=String(error||'');
        out.push(/not authorized|unauthoriz|denied|forbidden|prohibit|not allowed|access to|blocked/i.test(summary));
      }
    }
    let fixed=false;
    try{
      const rows=await invoke('db_read_scoped',{queryId:'patients.directory',
        recordId:null,search:null,drugId:null,limit:1,offset:0});
      fixed=Array.isArray(rows)&&rows.length<=1;
    }catch{fixed=false;}
    return {denied:out,scopedReadWorks:fixed};
  })()`);
  if (checks?.denied?.length !== 4 || !checks.denied.every(Boolean) || !checks.scopedReadWorks) {
    throw Error('Native SQL authorizer did not deny all private reads then permit scoped projection');
  }
  return { deniedPrivateReads: 4, scopedReadWorks: true };
}

async function navigate(cdp, owner, route) {
  verifyListener(owner);
  await verifyActor(cdp);
  await cdp.send('Page.navigate', {url: 'http://tauri.localhost' + route});
  for (let i = 0; i < 110; ++i) {
    await pause(100);
    const state = await cdp.evaluate('({route:location.pathname,ready:document.readyState,hasNative:!!window.__TAURI_INTERNALS__,spinner:!!document.querySelector(".animate-spin")})')
      .catch(() => null);
    if (state?.route === route && state.ready === 'complete' && state.hasNative && !state.spinner) {
      await verifyActor(cdp);
      return;
    }
  }
  throw Error('QA GUI route did not settle without redirect or spinner');
}

async function action(cdp, instruction) {
  validateAction(instruction);
  const ok = await cdp.evaluate(`((a)=>{
    let matches;try{matches=[...document.querySelectorAll(a.selector)]}catch{return false;}
    if(a.op==='click' && a.text!==undefined){
      matches=matches.filter(e=>(e.textContent||'').trim()===a.text);
    }
    if(matches.length!==1)return false;
    const e=matches[0];
    if(!e.isConnected||e.disabled||e.getAttribute('aria-disabled')==='true'
      ||e.closest('[aria-hidden="true"]')||!e.getClientRects().length)return false;
    if(a.op==='click'){e.click();return true;}
    if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement))return false;
    const setter=Object.getOwnPropertyDescriptor(
      e instanceof HTMLSelectElement?HTMLSelectElement.prototype:
      e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;
    setter.call(e,String(a.value));
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    return String(e.value)===String(a.value);
  })(${JSON.stringify(instruction)})`);
  if (ok !== true) throw Error('Exactly one visible enabled reviewed QA form control required');
}

async function proof(cdp, assertion) {
  validateProof(assertion);
  const result = await cdp.evaluate(`((p)=>{
    let elements;try{elements=[...document.querySelectorAll(p.selector)]}catch{return false;}
    if(p.kind==='absent')return elements.length===0;
    if(elements.length!==1)return false;
    if(p.kind==='exists')return !!elements[0].getClientRects().length;
    return (elements[0].textContent||'').includes(p.expected);
  })(${JSON.stringify(assertion)})`);
  if (result !== true) throw Error('Operator-reviewed GUI confirmation did not match');
}

async function waitProof(cdp, assertion) {
  for (let i = 0; i < 50; ++i) {
    try { await proof(cdp, assertion); return; } catch { await pause(150); }
  }
  throw Error('Native QA form did not reach confirmed UI state');
}

function startEvidence(output, owner, plan, stage) {
  // Lock is adjacent to the approved manifest, not to the app database.
  // A crash leaves the lease in place; no automatic replays of money.
  const ledgerPath = output.lease;
  const fd = fs.openSync(ledgerPath, 'wx', 0o600);
  fs.writeSync(fd, JSON.stringify({ stage, runIdSha256: sha256(plan.runId),
    pid: owner.pid, exeSha256: owner.approvedHash, state: 'started' }));
  fs.closeSync(fd);
  return {stage, qaIdentityVerified: true, actorTenantVerified: false,
    strictPrivateSqlDenials: 0, scopedReadAfterDenial: false, steps: [],
    piiCaptured: false, nativeFinanceSqlUsed: false, finished: false};
}

function record(evidence, out, name, status) {
  // Store step status *before* clicking a mutation; a crash is ambiguous.
  evidence.steps.push({step: name,status});
  fs.writeFileSync(out.evidence, JSON.stringify(evidence, null, 2), {mode:0o600});
}

async function runStageA(cdp, owner, plan, evidence, out) {
  await navigate(cdp, owner, '/purchases/suppliers');
  const existingSupplier = await scopedNameExists(cdp,'purchases.suppliers_list',plan.supplierName);
  if (existingSupplier) throw Error('QA supplier already exists; never double-create');
  record(evidence, out, 'supplier-create', 'intent-started');
  // A complete document load is not necessarily the end of React hydration.
  // Wait for the live form handler to mount before the harmless opener click.
  await pause(850);
  await action(cdp, {op:'click',selector:'button',text:'إضافة مورد جديد'});
  await waitProof(cdp,{selector:'[role="dialog"][aria-labelledby="supplier-edit-title"]',kind:'exists'});
  record(evidence, out, 'supplier-create', 'dialog-open-before-any-write');
  await action(cdp,{op:'fill',selector:'#supplier-name-ar',value:plan.supplierName});
  await action(cdp,{op:'fill',selector:'#supplier-name-en',value:'QA supplier'});
  record(evidence, out, 'supplier-create', 'fields-filled-before-commit');
  verifyListener(owner);
  await verifyActor(cdp);
  await action(cdp,{op:'click',selector:'[role="dialog"] button',text:'حفظ البيانات',commit:true});
  await waitProof(cdp,{selector:'[role="dialog"][aria-labelledby="supplier-edit-title"]',kind:'absent'});
  if (!(await scopedNameExists(cdp,'purchases.suppliers_list',plan.supplierName))) {
    throw Error('Native scoped supplier post-creation read was not confirmed');
  }
  record(evidence,out,'supplier-create','gui-and-scoped-read-confirmed');

  await navigate(cdp, owner, '/patients');
  if (await scopedNameExists(cdp,'patients.pos_search',plan.patientName)) {
    throw Error('QA patient already exists; never double-create');
  }
  record(evidence,out,'patient-create','intent-started');
  await pause(850);
  await action(cdp,{op:'click',selector:'button',text:'إضافة مريض'});
  await waitProof(cdp,{selector:'[role="dialog"][aria-labelledby="add-patient-title"]',kind:'exists'});
  record(evidence,out,'patient-create','dialog-open-before-any-write');
  await action(cdp,{op:'fill',selector:'[role="dialog"] input[placeholder="محمد أحمد..."]',value:plan.patientName});
  await action(cdp,{op:'select',selector:'#add-patient-payment-method',value:'cash'});
  record(evidence,out,'patient-create','fields-filled-before-commit');
  // No opening debt, credit, wallet or loyalty is created for an unverified
  // patient. The real form's defaults for all these are zero.
  verifyListener(owner);
  await verifyActor(cdp);
  await action(cdp,{op:'click',selector:'[role="dialog"] button[type="submit"]',commit:true});
  await waitProof(cdp,{selector:'[role="dialog"][aria-labelledby="add-patient-title"]',kind:'absent'});
  if (!(await scopedNameExists(cdp,'patients.pos_search',plan.patientName))) {
    throw Error('Native scoped patient post-creation read was not confirmed');
  }
  record(evidence,out,'patient-create','gui-and-scoped-read-confirmed');

  await navigate(cdp,owner,'/reports/purchases');
  await waitProof(cdp,{selector:'h1',kind:'textContains',expected:'تقرير فواتير المشتريات'});
  const reportReady = await cdp.evaluate(`(async()=>{
    const rows=await window.__TAURI_INTERNALS__.invoke('db_read_scoped',{
      // Native purchasing report requires a validated JSON filter object;
      // an absent recordId is deliberately rejected even for empty grids.
      queryId:'purchases.reports',recordId:'{}',search:null,drugId:null,limit:1,offset:0});
    return Array.isArray(rows)&&rows.length<=1;
  })()`);
  if (reportReady !== true) throw Error('Tenant-scoped purchase report did not return a native bounded projection');
  record(evidence,out,'purchases-report','gui-heading-and-native-scoped-projection-confirmed');
}

async function scopedNameExists(cdp, queryId, name) {
  // Native server-defined query only; no renderer-authored SQL or finance
  // mutations. The response is reduced to a boolean inside WebView2.
  const result = await cdp.evaluate(`(async()=>{
    const supplier=${JSON.stringify(queryId === 'purchases.suppliers_list')};
    for(let offset=0;offset<2000;offset+=(supplier?200:50)){
      const limit=supplier?200:50;
      const rows=await window.__TAURI_INTERNALS__.invoke('db_read_scoped',{
        queryId:${JSON.stringify(queryId)},recordId:null,
        search:supplier?null:${JSON.stringify(name)},drugId:null,limit,offset});
      if(!Array.isArray(rows)||rows.length>limit)return null;
      if(rows.some(row=>row?.name_ar===${JSON.stringify(name)}||
                        row?.full_name===${JSON.stringify(name)}))return true;
      if(rows.length<limit)return false;
    }
    return null;
  })()`);
  if (typeof result !== 'boolean') throw Error('Native scoped directory response failed validation');
  return result;
}

async function runStageB(cdp, owner, plan, evidence, out, stepName) {
  const step = plan.stageB.find(s => s.name === stepName);
  if (!step) throw Error('Unreviewed Stage B step');
  await navigate(cdp,owner,step.route);
  // `document.readyState=complete` precedes React hydration on cold
  // full-document navigation. The controls must have live handlers before
  // proceeding, just like the Stage A real-form flow.
  await pause(850);
  record(evidence,out,step.name,'intent-started');
  for (const [index,a] of step.actions.entries()) {
    if (a.op === 'wait') {
      await waitProof(cdp,{selector:a.selector,kind:'exists'});
      record(evidence,out,step.name,`reviewed-action-${index}-wait-ready`);
      continue;
    }
    if (a.commit) {
      if (step.precommitProof) await waitProof(cdp,step.precommitProof);
      record(evidence,out,step.name,'precommit-verified-one-click-armed');
      verifyListener(owner);
      await verifyActor(cdp);
    }
    // Emit only ordinal/type evidence, not selectors, values, customer names,
    // drugs or patient details. This distinguishes a preparation failure from
    // an ambiguous financial click without creating any retry permission.
    if (!a.commit) record(evidence,out,step.name,`reviewed-action-${index}-${a.op}-started`);
    await action(cdp,a);
    if (!a.commit) record(evidence,out,step.name,`reviewed-action-${index}-${a.op}-ready`);
    if (!a.commit) await pause(150);
  }
  for (const expected of step.proof) await waitProof(cdp,expected);
  record(evidence,out,step.name,'ui-confirmed-awaiting-independent-native-receipt-review');
}

async function execute(opts) {
  const manifestPath = path.resolve(opts.manifest);
  const planPath = path.resolve(opts.plan);
  const appDataRoot = process.env.APPDATA && path.resolve(process.env.APPDATA).toLowerCase();
  const restricted = candidate => {
    const resolved = candidate.toLowerCase();
    return !appDataRoot || resolved === appDataRoot ||
      resolved.startsWith(appDataRoot + path.sep) ||
      resolved.toLowerCase().startsWith(path.resolve(__dirname).toLowerCase() + path.sep);
  };
  if (restricted(manifestPath) || restricted(planPath)) {
    throw Error('Approved manifest/plan files must be outside AppData and scripts source');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const plan = JSON.parse(fs.readFileSync(planPath,'utf8'));
  validatePlan(plan, opts.stage, opts.step);
  const owner = verifyManifest(manifest, opts.ownedPid, manifestPath);
  const outPath = path.resolve(opts.out);
  const repoScripts = __dirname.toLowerCase();
  if (outPath.toLowerCase().startsWith(repoScripts) ||
      outPath.toLowerCase().includes('com.pharma.system') ||
      outPath.toLowerCase().startsWith(path.resolve(process.env.APPDATA || '.').toLowerCase()) ||
      fs.existsSync(outPath) || path.dirname(outPath).toLowerCase() === path.parse(outPath).root.toLowerCase()) {
    throw Error('Evidence must be a new non-AppData, non-repository isolated QA folder');
  }
  // Refuse paths inside repo root too; never mutate source tree from CDP runner.
  if (outPath.toLowerCase().startsWith(path.resolve(__dirname,'..').toLowerCase() + path.sep)) {
    throw Error('Evidence output cannot be inside the repository');
  }
  if (!fs.existsSync(path.dirname(outPath))) throw Error('Pre-provision the isolated QA evidence parent');
  const out = {evidence:path.join(outPath,'sanitized-evidence.json'),
    lease:manifestPath + '.' + (opts.stage === 'stage-b' ? opts.step : opts.stage) + '.oneshot-lock'};
  fs.mkdirSync(outPath, {recursive:false,mode:0o700});
  const evidence = startEvidence(out, owner, plan, opts.stage);
  let cdp;
  try {
    cdp = await attachOwnedCDP(owner);
    await verifyActor(cdp);
    evidence.actorTenantVerified = true;
    const strict = await strictSqlDenial(cdp);
    evidence.strictPrivateSqlDenials = strict.deniedPrivateReads;
    evidence.scopedReadAfterDenial = strict.scopedReadWorks;
    record(evidence,out,'strict-native-sql-gate','passed');
    if (opts.stage === 'stage-a') await runStageA(cdp,owner,plan,evidence,out);
    else await runStageB(cdp,owner,plan,evidence,out,opts.step);
    evidence.finished = true;
    fs.writeFileSync(out.evidence,JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({stage:opts.stage,step:opts.step,passed:true,steps:evidence.steps.length,
      nativeActorScope:true,strictNativeSql:true,proofOnly:true}));
  } finally {
    cdp?.close();
    fs.writeFileSync(out.evidence, JSON.stringify(evidence,null,2));
  }
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (!opts.execute) {console.log(JSON.stringify(dryRun(opts.stage),null,2));return;}
  await execute(opts);
}

if (require.main === module) main().catch(() => {
  // Never surface passwords, customer/supplier names, SQL results, or stack
  // traces from a connected WebView. The private sanitized evidence has the
  // step that needs reviewed manual native receipt reconciliation.
  console.error('QA_LIFECYCLE_POSITIVE=BLOCKED; review isolated sanitized evidence and custody gates');
  process.exitCode = 1;
});

module.exports = {parseOptions,validatePlan,validateAction,validateProof,dryRun,
  verifyManifest, STAGE_A,STAGE_B, IDENTITY,ACTOR,TENANT,CDP_PORT};
