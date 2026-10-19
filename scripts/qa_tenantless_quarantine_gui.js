#!/usr/bin/env node
'use strict';

// Windows SHA/PID-locked, zero-financial-write acceptance for an existing
// MIXED-owner legacy database. The actual app MUST stay alive and visibly
// quarantine the old scope, not rewrite the owner or crash at setup.
// Never print actors, SQLite paths, native exceptions or archive contents.
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');
const FLAGS = Object.freeze([
  'shaAndDirectChild', 'witnessedDisposablePlan', 'nativeLicenseValid',
  'nativeMigrationNotReady', 'nativeLegacyOwnershipBlocked',
  'quarantineMessageVisible', 'noRestartOrActivationEscape',
  'protectedPharmacyUIAbsent', 'nativeDataIPCRejected',
  'noFinancialWriterInvoked',
]);
const SHA_RE = /^[0-9A-F]{64}$/;

function blocked() {
  return Object.fromEntries(FLAGS.map(key => [key, false]));
}

function accepted(data) {
  return data && typeof data === 'object'
    && Object.keys(data).length === FLAGS.length
    && FLAGS.every(key => data[key] === true);
}

function expression() {
  // Two native commands, both read-only. No renderer-supplied file path, SQL,
  // approval, nonce, guessed tenant, cash amount or transaction writer.
  return `(async()=>{
    const invoke=window.__TAURI_INTERNALS__?.invoke;
    if(typeof invoke!=='function')return {};
    const status=await invoke('license_status');
    let refused=false;
    try{await invoke('current_local_user');}catch{refused=true;}
    const blocker=document.querySelector('[role="alert"][aria-label="مراجعة ملكية السجلات القديمة"]');
    const texts=Array.from(document.querySelectorAll('h1,p')).map(e=>e.textContent||'');
    const forbidden=[...document.querySelectorAll('button,a')].some(e=>
      e.textContent?.includes('إعادة تشغيل التطبيق')
      ||e.textContent?.includes('تفعيل الترخيص')
      ||e.getAttribute('href')==='/pos'
      ||e.getAttribute('href')==='/purchases');
    return {
      valid:status?.valid===true,
      noReady:status?.startup_ready===false,
      blocked:status?.startup_upgrade_blocked===true,
      visible:!!blocker && texts.some(t=>t.includes('تم إيقاف الترقية لحماية سجلات الصيدلية')),
      noEscapes:!forbidden,
      noBusinessUI:!!blocker&&!document.querySelector('#pos-checkout-submit,#purchase-save-button,[data-testid="patient-wallet-topup"]'),
      denied:refused,
    };
  })()`;
}

async function execute(args) {
  if (args.length !== 5 || args[0] !== '--execute' || args[1] !== '--exclusive-confirm') {
    throw Error('Explicit SHA-pinned quarantine acceptance required');
  }
  const pid = Number(args[2]), sha = args[3];
  if (!Number.isSafeInteger(pid) || pid < 100 || !SHA_RE.test(sha)) {
    throw Error('QA PID or SHA not supplied');
  }
  verifiedPlan(args[4]);
  assertCustody(pid, sha);
  const pages=(await (await fetch('http://127.0.0.1:9334/json/list',{
    signal:AbortSignal.timeout(6000),
  })).json()).filter(page=>page.type==='page');
  const apps=pages.filter(page=>{
    try{return new URL(page.url).hostname==='tauri.localhost';}catch{return false;}
  });
  if(apps.length!==1 || pages.length>2 || pages.some(page=>page!==apps[0] &&
      new URL(page.url).hostname!=='downloads-hub'))throw Error('Untrusted QA WebView targets');
  const url=new URL(apps[0].webSocketDebuggerUrl);
  if(url.protocol!=='ws:' || url.hostname!=='127.0.0.1' || url.port!=='9334') {
    throw Error('Non-local native WebView');
  }
  const ws=new WebSocket(url.href);
  await new Promise((ok,no)=>{
    ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});
  });
  let next=0;const pending=new Map();
  ws.addEventListener('message',e=>{
    let msg;try{msg=JSON.parse(e.data);}catch{return;}
    const req=pending.get(msg.id);if(!req)return;
    pending.delete(msg.id);clearTimeout(req.timer);
    msg.error?req.no(Error('QA CDP denied')):req.ok(msg.result);
  });
  const send=(method,params)=>new Promise((ok,no)=>{
    const id=++next,timer=setTimeout(()=>{
      pending.delete(id);no(Error('Read-only quarantine CDP timeout'));
    },18000);
    pending.set(id,{ok,no,timer});ws.send(JSON.stringify({id,method,params}));
  });
  try{
    await send('Runtime.enable',{});
    const packet=await send('Runtime.evaluate',{
      expression:expression(),awaitPromise:true,returnByValue:true,
    });
    if(packet?.exceptionDetails)throw Error('Legacy guard display evaluation failed');
    const state=packet?.result?.value;
    assertCustody(pid,sha);
    const flags={
      shaAndDirectChild:true,witnessedDisposablePlan:true,
      nativeLicenseValid:state?.valid===true,
      nativeMigrationNotReady:state?.noReady===true,
      nativeLegacyOwnershipBlocked:state?.blocked===true,
      quarantineMessageVisible:state?.visible===true,
      noRestartOrActivationEscape:state?.noEscapes===true,
      protectedPharmacyUIAbsent:state?.noBusinessUI===true,
      nativeDataIPCRejected:state?.denied===true,
      noFinancialWriterInvoked:true,
    };
    if(!accepted(flags))throw Error('Unsafe or unavailable legacy upgrade quarantine');
    return flags;
  }finally{ws.close();}
}

if(require.main===module){
  execute(process.argv.slice(2)).then(value=>{
    console.log('PINNED_QA_NATIVE_MIXED_OWNER_QUARANTINE='+JSON.stringify(value));
  }).catch(()=>{
    console.log('PINNED_QA_NATIVE_MIXED_OWNER_QUARANTINE='+JSON.stringify(blocked()));
    process.exitCode=2;
  });
}
module.exports={blocked,accepted,expression};
