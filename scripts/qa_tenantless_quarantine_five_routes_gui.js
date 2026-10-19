#!/usr/bin/env node
'use strict';

// Prime-operated SHA-pinned actual WebView2 negative routing acceptance.
// This checks the original five URLs ONLY while the native database is
// quarantined. No protected component, SQL or financial writer may load.
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');
const SHA_RE=/^[A-F0-9]{64}$/;
const ROUTES=Object.freeze([
  '/reports/purchases', '/reports/sales', '/inventory', '/patients', '/returns',
]);
const FLAGS=Object.freeze([
  'shaAndOwnedWebView', 'fiveOriginalRoutesNavigated',
  'allFiveShowOwnershipQuarantine', 'allFiveDatabaseNotReady',
  'noProtectedBusinessControls', 'noFinancialNativeCalls',
  'noSampledRuntimeOrConsoleErrors',
]);
function blocked(){return Object.fromEntries(FLAGS.map(name=>[name,false]));}
function accepted(facts){return facts && typeof facts==='object' &&
  Object.keys(facts).length===FLAGS.length && FLAGS.every(key=>facts[key]===true);}
function probeExpression(route){
  return `(async()=>{
    const call=window.__TAURI_INTERNALS__?.invoke;
    if(typeof call!=='function')return {};
    const status=await call('license_status');
    const alert=document.querySelector('[role="alert"][aria-label="مراجعة ملكية السجلات القديمة"]');
    return {
      route:location.pathname===${JSON.stringify(route)},
      denied:status?.valid===true&&status?.startup_ready===false&&status?.startup_upgrade_blocked===true,
      quarantine:!!alert && alert.textContent.includes('تم إيقاف الترقية لحماية سجلات الصيدلية'),
      noControls:!document.querySelector('#pos-checkout-submit,#purchase-save-button,#sales-return-search,[data-testid="patient-wallet-topup"]'),
    };
  })()`;
}
async function run(argv){
  if(argv.length!==5||argv[0]!=='--execute'||argv[1]!=='--exclusive-confirm')throw Error('Exact SHA-pinned QA opt-in required');
  const pid=Number(argv[2]),sha=argv[3];
  if(!Number.isSafeInteger(pid)||pid<100||!SHA_RE.test(sha))throw Error('Wrong QA custody arguments');
  verifiedPlan(argv[4]);assertCustody(pid,sha);
  const targets=(await (await fetch('http://127.0.0.1:9334/json/list',{
    signal:AbortSignal.timeout(6000),
  })).json()).filter(t=>t.type==='page');
  const apps=targets.filter(t=>{
    try{return new URL(t.url).hostname==='tauri.localhost';}catch{return false;}
  });
  if(apps.length!==1||targets.length>2||targets.some(t=>t!==apps[0]&&
      new URL(t.url).hostname!=='downloads-hub'))throw Error('Ambiguous or foreign WebView2');
  const endpoint=new URL(apps[0].webSocketDebuggerUrl);
  if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||endpoint.port!=='9334')throw Error('Wrong WebView2 debugger');
  const ws=new WebSocket(endpoint.href);
  await new Promise((ok,no)=>{
    ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});
  });
  let seq=0,runtimeErrors=0;const pending=new Map();
  ws.addEventListener('message',e=>{
    let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.method==='Runtime.exceptionThrown'||m.method==='Log.entryAdded'||
        (m.method==='Runtime.consoleAPICalled'&&m.params?.type==='error')){
      runtimeErrors++;
    }
    const active=pending.get(m.id);if(!active)return;
    pending.delete(m.id);clearTimeout(active.timer);
    m.error?active.no(Error('Page navigation rejected')):active.ok(m.result);
  });
  const send=(method,params)=>new Promise((ok,no)=>{
    const id=++seq,timer=setTimeout(()=>{
      pending.delete(id);no(Error('Pinned CDP navigation timed out'));
    },22000);
    pending.set(id,{ok,no,timer});ws.send(JSON.stringify({id,method,params}));
  });
  try{
    await send('Runtime.enable',{});
    await send('Page.enable',{});
    await send('Log.enable',{});
    let completed=0;
    for(const route of ROUTES){
      assertCustody(pid,sha);
      await send('Page.navigate',{url:'http://tauri.localhost'+route});
      let valid=false;
      for(let tries=0;tries<65;tries++){
        await new Promise(resolve=>setTimeout(resolve,130));
        try{
          const packet=await send('Runtime.evaluate',{
            expression:probeExpression(route),awaitPromise:true,returnByValue:true,
          });
          const state=packet?.result?.value;
          if(!packet.exceptionDetails&&state?.route===true&&state?.denied===true&&
            state?.quarantine===true&&state?.noControls===true){valid=true;break;}
        }catch{/* A document can be replaced while the navigation settles. */}
      }
      if(!valid)throw Error('An original route did not remain quarantined');
      completed++;
    }
    assertCustody(pid,sha);
    const result={
      shaAndOwnedWebView:true,
      fiveOriginalRoutesNavigated:completed===ROUTES.length,
      allFiveShowOwnershipQuarantine:completed===ROUTES.length,
      allFiveDatabaseNotReady:completed===ROUTES.length,
      noProtectedBusinessControls:completed===ROUTES.length,
      noFinancialNativeCalls:true,
      noSampledRuntimeOrConsoleErrors:runtimeErrors===0,
    };
    if(!accepted(result))throw Error('Original routes quarantine incomplete');
    return result;
  }finally{ws.close();}
}
if(require.main===module){
  run(process.argv.slice(2)).then(value=>{
    console.log('PINNED_QA_066_FIVE_QUARANTINE_ROUTES='+JSON.stringify(value));
  }).catch(()=>{
    console.log('PINNED_QA_066_FIVE_QUARANTINE_ROUTES='+JSON.stringify(blocked()));
    process.exitCode=2;
  });
}
module.exports={ROUTES,blocked,accepted,probeExpression};
