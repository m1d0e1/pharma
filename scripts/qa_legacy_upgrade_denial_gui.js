#!/usr/bin/env node
'use strict';

/**
 * Prime-only negative WebView2 QA: the registered legacy archive inspector
 * MUST reject because no native PreapprovedLegacyArchiveGrant was provisioned.
 * This probes denial, NOT an archive, upgrade, migration, financial history,
 * database source, renderer SQL, or financial posting. Output: booleans only.
 * No GUI/CDP connection is made without a witnessed plan, exact executable
 * SHA/PID, owner/tenant login, and independently attested WebView2 custody.
 */
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');

const ACTOR = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const MISSING_GRANT = 'Archive reading has not been independently authorized';
const LABEL = 'PINNED_QA_LEGACY_ARCHIVE_GRANT_DENIAL=';
const SHA = /^[A-F0-9]{64}$/;
const FACT_KEYS = Object.freeze([
  'custodyVerified',
  'witnessedPlanVerified',
  'actorTenantVerified',
  'archiveReadAttemptedOnce',
  'exactMissingGrantRejected',
  'noArchiveFactsReturned',
  'noFinancialWriterInvoked',
]);

function factsBlocked() {
  return Object.fromEntries(FACT_KEYS.map(key => [key, false]));
}

function accepted(facts) {
  return facts !== null && typeof facts === 'object'
    && FACT_KEYS.every(key => facts[key] === true)
    && Object.keys(facts).length === FACT_KEYS.length;
}

function parseLaunch(argv) {
  if (!Array.isArray(argv) || argv.length !== 5
      || argv[0] !== '--execute' || argv[1] !== '--exclusive-confirm') {
    throw Error('Exclusive pinned QA launch required');
  }
  const pid = Number(argv[2]);
  const sha = argv[3];
  const planPath = argv[4];
  if (!Number.isSafeInteger(pid) || pid < 100 || !SHA.test(sha)
      || typeof planPath !== 'string' || !planPath) {
    throw Error('Invalid pinned QA custody arguments');
  }
  return { pid, sha, planPath };
}

function nativeExpression() {
  // The only bridge functions allowed in this fixed script. Do not include
  // native error text, actor or snapshot contents in Runtime.evaluate result.
  // In particular, a generic command-not-found, auth or IPC error MUST FAIL.
  return `(async()=>{
    const invoke=window.__TAURI_INTERNALS__?.invoke;
    if(typeof invoke!=='function')return {
      actorTenantVerified:false,archiveReadAttemptedOnce:false,
      exactMissingGrantRejected:false,noArchiveFactsReturned:false};
    const owner=await invoke('current_local_user');
    const owned=owner?.id===${JSON.stringify(ACTOR)}
      &&owner?.pharmacy_id===${JSON.stringify(TENANT)}
      &&owner?.role==='owner';
    if(!owned)return {
      actorTenantVerified:false,archiveReadAttemptedOnce:false,
      exactMissingGrantRejected:false,noArchiveFactsReturned:false};
    let exact=false;
    let returned=false;
    try {
      await invoke('read_legacy_archive_scope_facts_native');
      returned=true;
    } catch (error) {
      const message=typeof error==='string' ? error
        : (error instanceof Error ? error.message : null);
      exact=message===${JSON.stringify(MISSING_GRANT)};
    }
    return {
      actorTenantVerified:true,archiveReadAttemptedOnce:true,
      exactMissingGrantRejected:exact,noArchiveFactsReturned:!returned};
  })()`;
}

function verifiedNativeDenial(reply) {
  return reply !== null && typeof reply === 'object'
    && Object.keys(reply).length === 4
    && reply.actorTenantVerified === true
    && reply.archiveReadAttemptedOnce === true
    && reply.exactMissingGrantRejected === true
    && reply.noArchiveFactsReturned === true;
}

function verifiedTarget(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 2
      || targets.some(target => target?.type !== 'page')) {
    throw Error('Ambiguous pinned WebView2 target set');
  }
  const app = targets.filter(target => {
    try {
      const url = new URL(target.url);
      return url.protocol === 'http:' && url.hostname === 'tauri.localhost'
        && !url.username && !url.password;
    } catch { return false; }
  });
  const hub = targets.filter(target => {
    try { return new URL(target.url).hostname === 'downloads-hub'; }
    catch { return false; }
  });
  if (app.length !== 1 || hub.length > 1 || app.length + hub.length !== targets.length) {
    throw Error('QA WebView identity is ambiguous');
  }
  const debuggerUrl = new URL(app[0].webSocketDebuggerUrl);
  if (debuggerUrl.protocol !== 'ws:' || debuggerUrl.hostname !== '127.0.0.1'
      || debuggerUrl.port !== '9334'
      || !/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(debuggerUrl.pathname)
      || debuggerUrl.username || debuggerUrl.password || debuggerUrl.search || debuggerUrl.hash) {
    throw Error('QA WebView2 debugger endpoint is unverified');
  }
  return debuggerUrl.href;
}

async function run(argv) {
  const { pid, sha, planPath } = parseLaunch(argv);
  // verifiedPlan checks the fixed temp plan location, disposable app identity,
  // synthetic patient name, actor and tenant; NO patient data is read/logged.
  verifiedPlan(planPath);
  assertCustody(pid, sha);
  const response = await fetch('http://127.0.0.1:9334/json/list', {
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw Error('Pinned QA debugger discovery refused');
  const endpoint = verifiedTarget(await response.json());
  assertCustody(pid, sha);
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let sequence = 0;
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('Pinned QA socket refused')), { once: true });
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Error('Read-only QA CDP command refused'));
      else request.resolve(message.result);
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Read-only QA CDP timeout'));
      }, 18000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable', {});
    assertCustody(pid, sha);
    const packet = await send('Runtime.evaluate', {
      expression: nativeExpression(), awaitPromise: true, returnByValue: true,
    });
    if (packet?.exceptionDetails || packet?.result?.type !== 'object'
        || !verifiedNativeDenial(packet.result?.value)) {
      throw Error('Archive absence-of-grant denial was not exactly verified');
    }
    assertCustody(pid, sha);
    const facts = {
      custodyVerified: true,
      witnessedPlanVerified: true,
      actorTenantVerified: true,
      archiveReadAttemptedOnce: true,
      exactMissingGrantRejected: true,
      noArchiveFactsReturned: true,
      noFinancialWriterInvoked: true,
    };
    if (!accepted(facts)) throw Error('Incomplete native archive denial facts');
    return facts;
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    socket.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(facts => { console.log(LABEL + JSON.stringify(facts)); })
    .catch(() => {
      // No raw native exception, source data, PID, hash, path or PII in output.
      console.log(LABEL + JSON.stringify(factsBlocked()));
      process.exitCode = 2;
    });
}

module.exports = {
  accepted, factsBlocked, parseLaunch, nativeExpression,
  verifiedNativeDenial, verifiedTarget,
};
