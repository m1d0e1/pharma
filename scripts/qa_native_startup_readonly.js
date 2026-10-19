#!/usr/bin/env node
'use strict';

// Strict existing-WebView2 diagnostic for a QA app that is not yet logged in.
// No SQL, credentials or other private native output is retained or printed.
const { spawnSync } = require('node:child_process');
const pause = ms => new Promise(ok => setTimeout(ok, ms));

async function run(pid, sha) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 100 ||
      !/^[A-F0-9]{64}$/.test(sha)) throw Error('Pinned disposable QA process required');
  const cmd = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + `if(!$p -or $p.ExecutablePath -notlike '*pharma-builds\\optimized-offline-qa-20261016\\Pharma-0.2.109-optimized-offline-QA-*.exe'){exit 2};`
    + `if((Get-FileHash -LiteralPath $p.ExecutablePath -Algorithm SHA256).Hash -ne '${sha}'){exit 3};`
    + '$l=@(Get-NetTCPConnection -LocalPort 9334 -State Listen);'
    + `if($l.Count -ne 1 -or $l[0].LocalAddress -ne '127.0.0.1'){exit 4};`
    + '$w=Get-CimInstance Win32_Process -Filter "ProcessId=$($l[0].OwningProcess)";'
    + `if(!$w -or $w.ParentProcessId -ne ${pid} -or $w.Name -ne 'msedgewebview2.exe'){exit 5};`
    + 'Write-Output "PINNED_QA"';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    windowsHide: true, encoding: 'utf8', timeout: 12000,
  });
  if (result.status !== 0 || !result.stdout.includes('PINNED_QA')) throw Error('Not an owned QA WebView');
  const pages = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).filter(p => p.type === 'page');
  const own = pages.filter(p => new URL(p.url).hostname === 'tauri.localhost');
  const hub = pages.filter(p => new URL(p.url).hostname === 'downloads-hub');
  if (own.length !== 1 || hub.length > 1 || pages.length !== own.length + hub.length ||
      new URL(own[0].webSocketDebuggerUrl).hostname !== '127.0.0.1') throw Error('Unexpected target');
  const ws = new WebSocket(own[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    const task = pending.get(m.id);
    if (!task) return;
    pending.delete(m.id);
    clearTimeout(task.timer);
    m.error ? task.fail(Error('CDP operation failed')) : task.ok(m.result);
  });
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); fail(Error('CDP timed out')); }, 28000);
    pending.set(next, { ok, fail, timer });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  try {
    await send('Runtime.enable');
    const response = await send('Runtime.evaluate', {
      expression: `(async()=>{
        const check=async command=>{
          const invoke=window.__TAURI_INTERNALS__?.invoke;
          if(!invoke)return {status:'no_bridge'};
          const pending=Promise.resolve().then(()=>invoke(command))
            .then(value=>({status:'success',value}),error=>{
              const msg=String(error||'');
              const kind=/license|activation/i.test(msg)?'license':
                /database|sqlite|sqlx|pool|disk|db /i.test(msg)?'database':
                /permission|unauthoriz|denied|forbidden/i.test(msg)?'permission':'other';
              return {status:'rejected',kind};
            });
          return Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve({status:'timeout'}),9000))]);
        };
        const enrollment=await check('owner_enrollment_status');
        const actor=await check('current_local_user');
        const license=await check('license_status');
        const reason=license.status==='success'?String(license.value?.reason||''):'';
        const licenseReason=/expired|lease.*ended/i.test(reason)?'expired':
          /signature|public key|verification key|issuer/i.test(reason)?'signature':
          /fingerprint|machine|hardware/i.test(reason)?'binding':
          /clock|rollback|replay|revok/i.test(reason)?'clock_or_revocation':
          /not found|not exist|missing|signed license/i.test(reason)?'missing_license':
          /DPAPI|decrypt|protected.*state|corrupt/i.test(reason)?'protected_state':'other';
        return {path:location.pathname,loginFields:!!document.querySelector('#login-username')&&
          !!document.querySelector('#login-password'),enrollmentErrorVisible:!!document.querySelector('[role="alert"]'),
          nativeBridge:!!window.__TAURI_INTERNALS__,ownerEnrollmentStatus:enrollment.status,
          enrollmentErrorKind:enrollment.kind||null,enrollmentPending:enrollment.status==='success'?enrollment.value:null,
          nativeUserStatus:actor.status,nativeUserErrorKind:actor.kind||null,
          nativeLicenseStatus:license.status,nativeLicenseValid:license.status==='success'?license.value?.valid:null,
          nativeLicenseStartupReady:license.status==='success'?license.value?.startup_ready:null,
          nativeLicenseReasonCategory:license.status==='success'?licenseReason:null,
          nativeActorVerified:actor.status==='success'&&actor.value?.id==='qa_lifecycle_owner_20261016'
            &&actor.value?.pharmacy_id==='qa_lifecycle_20261016'&&actor.value?.role==='owner'};
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) throw Error('Native startup inspection declined');
    const value = response.result?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Malformed QA startup state');
    // All output fields are reviewed fixed labels and booleans, no native data.
    console.log('PINNED_QA_STARTUP_READONLY=' + JSON.stringify(value));
    await pause(20);
  } finally { ws.close(); }
}

if (require.main === module) {
  run(Number(process.argv[2]), String(process.argv[3] || '').toUpperCase()).catch(() => {
    console.error('QA_STARTUP_READONLY=BLOCKED'); process.exitCode = 1;
  });
}
