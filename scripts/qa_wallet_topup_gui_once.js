#!/usr/bin/env node
'use strict';
// A single *real DOM form* cash top-up of exactly 5.00 EGP for the prospectively
// owned fresh synthetic Stage-A patient. Requires independently inspected
// pre-commit zero history/open shift. A persistent one-shot lock is created
// BEFORE financial interaction: a crash/unknown reply is NEVER retried.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ACTOR='qa_lifecycle_owner_20261016',TENANT='qa_lifecycle_20261016';
const IDENTITY='com.pharma.disposable.lifecycle.qa20261016';

function assertCustody(pid,sha) {
  const command=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    +`if(!$p -or $p.ExecutablePath -notlike '*pharma-builds\\optimized-offline-qa-20261016\\Pharma-0.2.109-optimized-offline-QA-*.exe'){exit 2};`
    +`if((Get-FileHash $p.ExecutablePath -Algorithm SHA256).Hash -ne '${sha}'){exit 3};`
    +'$l=@(Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction Stop);'
    +`if($l.Count -ne 1 -or $l[0].LocalAddress -ne '127.0.0.1'){exit 4};`
    +'$w=Get-CimInstance Win32_Process -Filter "ProcessId=$($l[0].OwningProcess)";'
    +`if(!$w -or $w.Name -ne 'msedgewebview2.exe' -or $w.ParentProcessId -ne ${pid}){exit 5};`
    +'Write-Output "OWNED_QA"';
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',windowsHide:true,timeout:12000});
  if(r.status!==0||!r.stdout.includes('OWNED_QA'))throw Error('Unverified WebView custody');
}
async function run(pid,sha,planFile) {
  if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<4||
     !/^[0-9A-F]{64}$/.test(sha))throw Error('Bad pinned Windows QA process');
  const root=path.dirname(path.resolve(planFile));
  if(!root.toLowerCase().startsWith(os.tmpdir().toLowerCase()+path.sep)
      ||!root.includes('pharma-qa-stagea-'))throw Error('Only the frozen Stage A temp plan is allowed');
  const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
  if(plan.identity!==IDENTITY||plan.actorId!==ACTOR||plan.tenantId!==TENANT||
     plan.qaDataOnly!==true||!/^QA Patient PhaseTwo [a-f0-9]{12}$/.test(plan.patientName)){
    throw Error('No independently owned synthetic Stage A patient');
  }
  assertCustody(pid,sha);
  const pages=(await (await fetch('http://127.0.0.1:9334/json/list')).json()).filter(x=>x.type==='page');
  const qa=pages.filter(x=>new URL(x.url).hostname==='tauri.localhost');
  const hubs=pages.filter(x=>new URL(x.url).hostname==='downloads-hub');
  if(qa.length!==1||hubs.length>1||pages.length!==qa.length+hubs.length){
    throw Error('Unexpected additional WebView');
  }
  const ws=new WebSocket(qa[0].webSocketDebuggerUrl);
  await new Promise((yes,no)=>{ws.addEventListener('open',yes,{once:true});ws.addEventListener('error',no,{once:true});});
  let seq=0;const pending=new Map();
  ws.addEventListener('message',e=>{let r;try{r=JSON.parse(e.data);}catch{return;}
    const job=pending.get(r.id);if(!job)return;pending.delete(r.id);clearTimeout(job.timer);
    r.error?job.no(Error('CDP command denied')):job.yes(r.result);
  });
  const send=(method,params={})=>new Promise((yes,no)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout'));},12000);
    pending.set(id,{yes,no,timer});ws.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw Error('WebView form operation failed');return r.result?.value;
  };
  let committed=false;
  try{
    await send('Runtime.enable');await send('Page.enable');
    const actor=await evaluate(`(async()=>{const a=await window.__TAURI_INTERNALS__.invoke('current_local_user');return {id:a?.id,tenant:a?.pharmacy_id,role:a?.role};})()`);
    if(actor?.id!==ACTOR||actor?.tenant!==TENANT||actor?.role!=='owner')throw Error('Wrong authenticated tenant');
    await send('Page.navigate',{url:'http://tauri.localhost/patients'});
    let found=false;
    for(let i=0;i<90;i++){
      await delay(150);
      found=await evaluate(`(()=>{
        if(location.pathname!=='/patients')return false;
        const n=${JSON.stringify(plan.patientName)};
        return [...document.querySelectorAll('h3')].filter(x=>x.textContent?.trim()===n).length===1;
      })()`).catch(()=>false);
      if(found)break;
    }
    if(!found)throw Error('Exactly one verified synthetic patient card not found');
    const opened=await evaluate(`(()=>{
      const n=${JSON.stringify(plan.patientName)};
      const h=[...document.querySelectorAll('h3')].filter(e=>e.textContent?.trim()===n);
      if(h.length!==1)return false;
      const card=h[0].closest('.cursor-pointer');
      const b=[...(card?.querySelectorAll('button')||[])].filter(e=>e.textContent?.includes('عرض وتعديل الملف'));
      if(b.length!==1||b[0].disabled)return false;b[0].click();return true;
    })()`);
    if(!opened)throw Error('Could not open exactly one synthetic profile');
    let finance=false;
    for(let i=0;i<80;i++){
      await delay(120);
      finance=await evaluate(`(()=>{
        const d=document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]');
        const b=[...(d?.querySelectorAll('button')||[])].filter(x=>x.textContent?.includes('المالية والتأمين'));
        if(b.length!==1||b[0].disabled)return false;b[0].click();return true;
      })()`).catch(()=>false);
      if(finance)break;
    }
    if(!finance)throw Error('Patient financial tab unavailable');
    let ready=false;
    for(let i=0;i<70;i++){
      await delay(150);
      ready=await evaluate(`(()=>{
        const d=document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]');
        const a=d?.querySelector('#topup-amount');
        const b=[...(d?.querySelectorAll('button')||[])].filter(x=>x.textContent?.trim()==='تأكيد الشحن');
        return !!a&&b.length===1&&!b[0].disabled;
      })()`).catch(()=>false);
      if(ready)break;
    }
    if(!ready)throw Error('Native wallet top-up input not allowed for owner');
    const prepared=await evaluate(`(()=>{
      const a=document.querySelector('#topup-amount');if(!(a instanceof HTMLInputElement))return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(a,'5');
      a.dispatchEvent(new Event('input',{bubbles:true}));a.dispatchEvent(new Event('change',{bubbles:true}));
      return a.value==='5';
    })()`);
    if(!prepared)throw Error('Wallet top-up input failed');
    assertCustody(pid,sha);
    // Persist exclusive intent BEFORE THE SINGLE financial click. This marker
    // is deliberately NOT deleted after success or failure.
    const marker=path.join(root,'wallet-5-egp-native-gui-once.marker');
    const fd=fs.openSync(marker,'wx',0o600);
    fs.writeSync(fd,JSON.stringify({kind:'QA_GUI_WALLET_TOPUP_SINGLE_ATTEMPT',pid,sha,
      tenant:TENANT,syntheticPatient:true,amountCents:500}));fs.closeSync(fd);
    committed=await evaluate(`(()=>{
      const d=document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]');
      const amount=d?.querySelector('#topup-amount');
      const buttons=[...(d?.querySelectorAll('button')||[])].filter(x=>x.textContent?.trim()==='تأكيد الشحن');
      if(!amount||amount.value!=='5'||buttons.length!==1||buttons[0].disabled)return false;
      buttons[0].click();return true;
    })()`);
    if(!committed)throw Error('Single financial click did not fire; do not retry');
    let confirmed=false;
    for(let i=0;i<80;i++){
      await delay(125);
      confirmed=await evaluate(`(()=>
        [...document.querySelectorAll('[role="status"],div')].some(e=>e.textContent?.trim()==='تم شحن المحفظة بنجاح')
      )()`).catch(()=>false);
      if(confirmed)break;
    }
    console.log(JSON.stringify({qaActorTenantVerified:true,newWitnessedSyntheticPatient:true,
      financialFormClickOnce:true,guiSuccessToast:confirmed,amountCents:500,
      independentReceiptAuditStillRequired:true,noAutomaticRetry:true}));
  }finally{ws.close();}
}

if(require.main===module){
  const pid=Number(process.argv[2]),sha=(process.argv[3]||'').toUpperCase(),file=process.argv[4];
  run(pid,sha,file||'').catch(()=>{
    console.error('QA_WALLET_GUI_ATTEMPT_STOPPED; check one-shot marker and immutable 060 receipt before any other action');
    process.exitCode=1;
  });
}
