#!/usr/bin/env node
'use strict';
// Strict-identity, read-only real WebView2 integration probe. Emits aggregate
// counts and booleans only; never leaks source rows, patient names or tokens.
const {spawnSync} = require('node:child_process');
const sleep = ms => new Promise(done=>setTimeout(done,ms));
const ID='qa_lifecycle_owner_20261016', TENANT='qa_lifecycle_20261016', PORT=9334;

function verifyCustody(pid,sha) {
  if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<100||
     !/^[0-9A-F]{64}$/.test(sha))throw Error('A pinned Windows QA identity is required');
  const command=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + `if(!$p -or $p.ExecutablePath -notlike '*pharma-builds\\optimized-offline-qa-20261016\\Pharma-0.2.109-optimized-offline-QA-*.exe'){exit 2};`
    + `if((Get-FileHash $p.ExecutablePath -Algorithm SHA256).Hash -ne '${sha}'){exit 3};`
    + ` $l=@(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction Stop);`
    + `if($l.Count -ne 1 -or $l[0].LocalAddress -ne '127.0.0.1'){exit 4};`
    + '$child=Get-CimInstance Win32_Process -Filter "ProcessId=$($l[0].OwningProcess)";'
    + `if(!$child -or $child.Name -ne 'msedgewebview2.exe' -or $child.ParentProcessId -ne ${pid}){exit 5};`
    + `Write-Output 'VERIFIED_QA_NATIVE';`;
  const outcome=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  if(outcome.status!==0||!outcome.stdout.includes('VERIFIED_QA_NATIVE')){
    throw Error('Unpinned or unexpected QA WebView');
  }
}

async function check(pid,sha) {
  verifyCustody(pid,sha);
  const targets=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter(t=>t.type==='page');
  if(targets.length!==1 || new URL(targets[0].url).hostname!=='tauri.localhost' ||
    new URL(targets[0].webSocketDebuggerUrl).hostname!=='127.0.0.1'){
    throw Error('Expected exactly one native QA page');
  }
  const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',reject,{once:true});
  });
  let seq=0;const pending=new Map();
  ws.addEventListener('message',event=>{
    let msg;try{msg=JSON.parse(event.data);}catch{return;}
    const request=pending.get(msg.id);if(!request)return;
    pending.delete(msg.id);clearTimeout(request.timer);
    if(msg.error)request.reject(Error('Native CDP operation failed'));
    else request.resolve(msg.result);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timed out'));},30000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
  const ev=async expression=>{
    const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(response.exceptionDetails)throw Error('WebView native probe raised a JS error');
    return response.result?.value;
  };
  try {
    await send('Runtime.enable');
    const actor=await ev(`(async()=>{
      const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
      return {id:u?.id,tenant:u?.pharmacy_id,role:u?.role};})()`);
    if(actor?.id!==ID||actor.tenant!==TENANT||actor.role!=='owner'){
      throw Error('Unverified native tenant or actor');
    }
    verifyCustody(pid,sha);
    const native=await ev(`(async()=>{
      const call=window.__TAURI_INTERNALS__.invoke;
      let catalog;
      try{const rows=await call('read_master_catalog_cache_native');
        catalog={count:rows?.length,valid:Array.isArray(rows)&&rows.length>25000&&
          rows.every((v,i)=>v&&typeof v.id==='number'&&
            (i===0||v.id>rows[i-1].id))};}
      catch{catalog={count:0,valid:false};}
      let result;
      try{const rows=await call('search_returnable_sales_invoices_native',
        {searchTerm:'3726c3df',days:null});
        result={count:rows?.length,owned:Array.isArray(rows)&&rows.length===1&&
          rows[0]?.id==='3726c3df-c9cf-4e32-835a-848d045e69aa'};}
      catch{result={count:0,owned:false};}
      let dateResult;
      try{const rows=await call('list_returnable_sales_invoices_by_date',{date:'2026-10-17'});
        dateResult={count:rows?.length,legacyFree:Array.isArray(rows)&&rows.every(r=>
          typeof r.id==='string'&&!r.id.includes('local_default'))};}
      catch{dateResult={count:0,legacyFree:false};}
      const forbidden=['SELECT id FROM patients LIMIT 1',
         'SELECT * FROM supplier_transactions LIMIT 1'];
      const denied=[];
      for(const sql of forbidden){try{
        await call('db_select_guarded',{sql,params:[],txId:null});denied.push(false);
      }catch(e){denied.push(/not authoriz|unauthoriz|denied|forbidden|prohibit|not allowed|access to|blocked|unavailable/i.test(String(e)));}}
      return {catalog,returnSearch:result,returnDate:dateResult,privateSqlDenied:denied};
    })()`);
    if(!native?.catalog?.valid || !native.returnSearch?.owned ||
      native.privateSqlDenied?.length!==2 || !native.privateSqlDenied.every(Boolean) ||
      !native.returnDate?.legacyFree){
      // Structured diagnostics only: counts and pass/fail booleans, never
      // native rows, drug names, patient names, SQL or exception messages.
      console.error(JSON.stringify({
        catalogValidated:!!native?.catalog?.valid,catalogRows:native?.catalog?.count,
        returnSearchOwned:!!native?.returnSearch?.owned,
        returnSearchRows:native?.returnSearch?.count,
        returnDateLegacyFree:!!native?.returnDate?.legacyFree,
        returnDateRows:native?.returnDate?.count,
        privateSqlDenied:native?.privateSqlDenied,
      }));
      throw Error('Real strict-native integration check failed');
    }
    console.log(JSON.stringify({
      qaActorAndTenant:true,sourceCatalogRows:native.catalog.count,
      catalogSortedAndValidated:true,ownedReturnSearchRows:native.returnSearch.count,
      nativeReturnSearchPositive:true,returnDateListRows:native.returnDate.count,
      returnDateListNoLegacyLeak:true,privateSqlDeniedCount:2,financialMutation:false,
    }));
  }finally{ws.close();await sleep(60);}
}

if(require.main===module){
  const pid=Number(process.argv[2]),sha=(process.argv[3]||'').toUpperCase();
  check(pid,sha).catch(()=>{
    console.error('INTEGRATED_NATIVE_GUI=BLOCKED; review QA custody and typed API results');
    process.exitCode=1;
  });
}
