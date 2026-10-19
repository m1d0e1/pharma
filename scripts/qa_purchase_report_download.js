#!/usr/bin/env node
'use strict';

// One read-only report navigation + ONE actual GUI Excel export click. No SQL,
// customer data, finance writer, process termination or profile mutation.
// The downloaded QA workbook stays inside a new isolated OS temp directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const EXPECTED_TENANT = 'qa_lifecycle_20261016';
const EXPECTED_ACTOR = 'qa_lifecycle_owner_20261016';
const PORT = 9334;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireCustody(pid, sha) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 4 ||
      !/^[0-9A-F]{64}$/.test(sha)) throw Error('Exact Windows PID and SHA required');
  const code = `$qa=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + 'if(!$qa -or $qa.Name -notlike "Pharma-0.2.109-optimized-offline-QA-*.exe"'
    + ' -or $qa.ExecutablePath -notlike "*pharma-builds\\optimized-offline-qa-20261016\\*"){exit 4};'
    + `if((Get-FileHash -LiteralPath $qa.ExecutablePath -Algorithm SHA256).Hash -ne '${sha}'){exit 5};`
    + `$ls=@(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction Stop);`
    + 'if($ls.Count -ne 1 -or $ls[0].LocalAddress -ne "127.0.0.1"){exit 6};'
    + '$wv=Get-CimInstance Win32_Process -Filter "ProcessId=$($ls[0].OwningProcess)";'
    + `if(!$wv -or $wv.Name -ne 'msedgewebview2.exe' -or $wv.ParentProcessId -ne ${pid}){exit 7};`
    + 'Write-Output "OWNED_DISPOSABLE_QA"';
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',code],
    {encoding:'utf8',windowsHide:true,timeout:12000});
  if (result.status !== 0 || !result.stdout.includes('OWNED_DISPOSABLE_QA')) {
    throw Error('Process, executable hash or WebView listener custody mismatch');
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.downloads = [];
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (this.pending.has(message.id)) {
        const job = this.pending.get(message.id); this.pending.delete(message.id);
        clearTimeout(job.timer);
        message.error ? job.reject(Error('CDP command denied')) : job.resolve(message.result);
      } else if (message.method === 'Browser.downloadWillBegin' ||
                 message.method === 'Browser.downloadProgress') {
        const params = message.params || {};
        // Only generic event type and state; NEVER file URL, GUID, patient
        // name, request metadata, or server payload.
        this.downloads.push({type: message.method, state: params.state || null});
      }
    });
  }
  send(method, params={}) {
    return new Promise((resolve,reject) => {
      const id=++this.seq;
      const timer=setTimeout(() => { this.pending.delete(id); reject(Error('CDP command timed out')); },12000);
      this.pending.set(id,{resolve,reject,timer});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  async evaluate(code) {
    const result=await this.send('Runtime.evaluate',{
      expression:code,awaitPromise:true,returnByValue:true,
    });
    if (result.exceptionDetails) throw Error('GUI evaluation error');
    return result.result?.value;
  }
  close(){this.ws.close();}
}

async function execute(pid, sha) {
  requireCustody(pid,sha);
  const pages=await (await fetch(`http://127.0.0.1:${PORT}/json/list`,
    {signal:AbortSignal.timeout(5000)})).json();
  const targets=pages.filter(p=>p.type==='page');
  if(targets.length!==1 || new URL(targets[0].url).hostname!=='tauri.localhost' ||
     new URL(targets[0].webSocketDebuggerUrl).hostname!=='127.0.0.1') {
    throw Error('Not one owned Tauri WebView');
  }
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pharma-qa-purchases-xlsx-'));
  const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',()=>reject(Error('QA WebView connection denied')),{once:true});
  });
  const cdp=new CDP(ws);
  try {
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Browser.setDownloadBehavior',{
      behavior:'allow',downloadPath:out,eventsEnabled:true,
    });
    const actor=await cdp.evaluate(`(async()=>{
      const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
      return {id:u?.id,tenant:u?.pharmacy_id,role:u?.role};
    })()`);
    if(actor?.id!==EXPECTED_ACTOR || actor?.tenant!==EXPECTED_TENANT || actor.role!=='owner') {
      throw Error('Native QA actor/tenant verification failed');
    }
    await cdp.send('Page.navigate',{url:'http://tauri.localhost/reports/purchases'});
    let ready=false;
    for(let i=0;i<100;i++){
      await sleep(150);
      const state=await cdp.evaluate(`(()=>{
        const b=document.querySelector('button[aria-label="تصدير تقرير المشتريات إلى Excel"]');
        const t=document.querySelector('main')?.textContent||'';
        return {url:location.pathname,ready:!!b&&!b.disabled,
          original:t.includes('462'),returned:t.includes('115.5'),net:t.includes('346.5')};
      })()`).catch(()=>null);
      if(state?.url==='/reports/purchases' && state.ready &&
          state.original && state.returned && state.net){ready=true;break;}
    }
    if(!ready)throw Error('Verified purchase invoice/return/net GUI figures not ready');
    requireCustody(pid,sha);
    const clicked=await cdp.evaluate(`(()=>{
      const b=document.querySelectorAll('button[aria-label="تصدير تقرير المشتريات إلى Excel"]');
      if(b.length!==1||b[0].disabled||!b[0].getClientRects().length)return false;
      b[0].click();return true;
    })()`);
    if(clicked!==true)throw Error('One enabled native export control required');
    let file=null;
    for(let i=0;i<120;i++){
      await sleep(200);
      const files=fs.readdirSync(out).filter(n=>/^purchase-report-\d{4}-\d\d-\d\d\.xlsx$/i.test(n));
      if(files.length>1)throw Error('Ambiguous GUI download');
      if(files.length===1 && cdp.downloads.some(d=>d.state==='completed')){
        file=path.join(out,files[0]);break;
      }
    }
    if(!file || fs.statSync(file).size<2000)throw Error('WebView download did not complete as a nonempty workbook');
    const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    console.log(JSON.stringify({
      qa:true,actorTenantVerified:true,nativeExportClick:true,
      guiOriginal462:true,guiSupplierReturn115_50:true,guiCohortNet346_50:true,
      workbookPath:file,bytes:fs.statSync(file).size,sha256:hash,
      downloadComplete:true,financialMutation:false,
    }));
  } finally {cdp.close();}
}

if(require.main===module) {
  const args=process.argv.slice(2);
  if(args.length!==2 || !/^\d+$/.test(args[0]) || !/^[0-9a-fA-F]{64}$/.test(args[1])){
    console.error('Usage: node scripts/qa_purchase_report_download.js <verified-PID> <verified-SHA256>');
    process.exitCode=2;
  }else execute(Number(args[0]),args[1].toUpperCase()).catch(()=>{
    console.error('GUI_XLSX_EXPORT=BLOCKED; inspect custody/isolated QA temp download privately');
    process.exitCode=1;
  });
}
