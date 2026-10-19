#!/usr/bin/env node
'use strict';

// Read-only timing probe for the ONE already-running, prime-owned QA WebView2.
// It never launches/stops/focuses a window, invokes mutations, or clicks forms.
// Requires explicit QA PID + CDP port, and refuses arbitrary CDP/browser targets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { exportedRoutes } = require('./qa-background');

function classifyState(s, route) {
  if (!s || !s.tauri) return 'bridge_missing';
  if (s.pathname !== route) return 'redirect';
  if (s.fatal) return 'fatal';
  if (s.notFound) return 'not_found';
  if (s.denial) return 'denied';
  if (s.errorAlert) return 'page_error';
  if (s.identitySpinner) return 'global_auth_loading';
  if (s.layoutSpinner) return 'global_layout_loading';
  if (s.mainLoading) return 'page_loading';
  if (s.dataLoading) return 'page_data_loading';
  if (s.readyState !== 'complete') return 'document_loading';
  if (s.mainLength < 30) return 'empty_main';
  return 'ready';
}

function finalStatus({ phase, elapsedMs }) {
  if (phase === 'ready') return elapsedMs > 4000 ? 'slow_rendered' : 'rendered';
  if (phase === 'denied') return 'blocked_permission';
  if (phase === 'redirect') return 'unexpected_redirect';
  if (phase === 'not_found') return 'not_found';
  if (phase === 'page_error') return 'error_screen';
  if (phase === 'fatal' || phase === 'bridge_missing') return 'runtime_fail';
  return 'slow_or_stuck_loading';
}

function countRouteSummary(routes, expected) {
  const summary = { expected, scanned: routes.length, complete: routes.length === expected };
  for (const entry of routes) summary[entry.status] = (summary[entry.status] || 0) + 1;
  return summary;
}

class CDP {
  constructor(url) {
    this.url = url; this.id = 0; this.pending = new Map(); this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP websocket handshake timed out')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once:true });
      this.ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP websocket rejected')); }, { once:true });
    });
    this.ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p=this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (['Runtime.exceptionThrown','Runtime.consoleAPICalled','Page.frameNavigated'].includes(msg.method)) {
        this.events.push(msg);
      }
    });
  }
  async send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP command timeout')); }, 12000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise:true, returnByValue:true,
    });
    if (result.exceptionDetails) throw new Error('CDP evaluation exception');
    return result.result?.value;
  }
  close() { this.ws?.close(); }
}

// Do not persist DOM text, patient details, usernames, tokens, or console payloads.
const observation = `(() => {
  const body=document.body?.innerText||'';
  const main=document.querySelector('main');
  const text=main?.innerText.trim()||'';
  return {
    pathname:location.pathname,readyState:document.readyState,tauri:!!window.__TAURI_INTERNALS__,
    mainLength:text.length, headingCount:main?.querySelectorAll('h1,h2').length||0,
    visibleControls:[...document.querySelectorAll('main button,main a,main input,main select')].filter(el=>el.getClientRects().length>0).length,
    identitySpinner:body.includes('جاري التحقق من الهوية'),
    layoutSpinner:body.includes('جاري التحميل...') && !main,
    mainLoading:/^(?:جاري|جارٍ) (?:تحميل|التحقق|البحث|جلب)|^(?:loading|please wait)/i.test(text),
    dataLoading:[...(main?.querySelectorAll('[role="status"],[aria-busy="true"]')||[])]
      .some(el=>el.getClientRects().length>0 &&
        (el.getAttribute('aria-busy')==='true' || /(?:جاري|جارٍ) تحميل|loading/i.test(el.innerText||''))),
    denial:/وصول غير مصرح|ليس لديك الصلاحيات|غير مصرح|لا تملك صلاحية|access denied|permission denied/i.test(text),
    errorAlert:[...(main?.querySelectorAll('[role="alert"]')||[])]
      .some(el=>el.getClientRects().length>0 && !!el.innerText?.trim()),
    notFound:/الصفحة غير موجودة|404: This page|404 Page Not Found/i.test(text),
    fatal:/ChunkLoadError|Application error|Unhandled Runtime Error/i.test(body)
  };
})()`;

function classifyEvents(events) {
  const result={ exceptions:0, console_errors:0, console_warnings:0, hydration:0, categories:[] };
  const kinds=new Set();
  for (const event of events) {
    if (event.method === 'Page.frameNavigated') continue;
    if (event.method === 'Runtime.exceptionThrown') result.exceptions++;
    else if (event.params.type === 'error') result.console_errors++;
    else if (event.params.type === 'warning') result.console_warnings++;
    else continue;
    const detail=String(event.params?.exceptionDetails?.text||event.params?.exceptionDetails?.exception?.description||
      (event.params?.args||[]).map(x=>x.value||x.description||'').join(' '));
    if (/React error #418|Hydration failed|hydration/i.test(detail)) { result.hydration++; kinds.add('hydration'); }
    else if (/ChunkLoadError|Failed to load chunk/i.test(detail)) kinds.add('chunk_load');
    else if (/network|Failed to fetch/i.test(detail)) kinds.add('network');
    else if (/permission|unauthorized|denied/i.test(detail)) kinds.add('authorization');
    else if (/sqlite|database/i.test(detail)) kinds.add('database');
    else if (/TypeError/i.test(detail)) kinds.add('type_error');
    else kinds.add('other');
  }
  result.categories=[...kinds];
  return result;
}

function assertOwnedQaPort(pid, port) {
  if (process.platform !== 'win32') throw new Error('Windows-only QA ownership guard');
  const ps=`$qa=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + `if(!$qa -or $qa.Name -notlike '*QA*' -or $qa.ExecutablePath -notlike '*pharma-builds*'){exit 4};`
    + `$conn=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);`
    + `if($conn.Count -ne 1 -or $conn[0].LocalAddress -ne '127.0.0.1'){exit 5};`
    + '$listener=Get-CimInstance Win32_Process -Filter "ProcessId=$($conn[0].OwningProcess)";'
    + `if(!$listener -or $listener.Name -ne 'msedgewebview2.exe' -or $listener.ParentProcessId -ne ${pid}){exit 6};`
    + "Write-Output 'VERIFIED_PRIME_OWNED_QA_WEBVIEW2'";
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{
    encoding:'utf8',windowsHide:true,timeout:10000,
  });
  if (result.status!==0 || !result.stdout.includes('VERIFIED_PRIME_OWNED_QA_WEBVIEW2'))
    throw new Error('Expected QA WebView2 ownership proof failed: refusing to attach');
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function monitor(client, route, maxMs, start, initialEvents, changeRequired=false) {
  let last=null, stable=0, firstMainMs=null, firstPathMs=null, sawIdentity=false,
    globalAuthAfter4s=false, sawDataLoading=false, dataLoadingAfter4s=false, lastPhase='no_dom';
  for (;;) {
    const elapsed=performance.now()-start;
    try {
      const state=await client.evaluate(observation);
      last=state;
      if (state?.mainLength>=30 && firstMainMs===null) firstMainMs=Math.round(elapsed);
      if (state?.pathname===route && firstPathMs===null) firstPathMs=Math.round(elapsed);
      sawIdentity ||= state?.identitySpinner===true;
      sawDataLoading ||= state?.dataLoading===true;
      if (elapsed>=4000 && state?.identitySpinner) globalAuthAfter4s=true;
      if (elapsed>=4000 && state?.dataLoading) dataLoadingAfter4s=true;
      const phase=classifyState(state,route);lastPhase=phase;
      const terminal=['ready','denied','not_found','fatal','bridge_missing','page_error'];
      // The first sample may still show the prior page while CDP commits.
      if (phase==='redirect' && elapsed<1600) stable=0;
      else if (terminal.includes(phase) || (phase==='redirect' && elapsed>=1600)) {
        stable++;
        if (stable>=2 && (!changeRequired || phase!=='ready' || state?.mainLength>0)) break;
      } else stable=0;
    } catch (_) { lastPhase='navigation_pending';stable=0; }
    if (elapsed>maxMs) break;
    await delay(145);
  }
  const elapsedMs=Math.round(performance.now()-start);
  const status=finalStatus({phase:lastPhase,elapsedMs});
  const events=client.events.slice(initialEvents);
  const frameNavigations=events.filter(e=>e.method==='Page.frameNavigated').length;
  return {route,status,phase:lastPhase,elapsedMs,firstPathMs,firstMainMs,
    globalIdentitySeen:sawIdentity,globalIdentityStillAfter4s:globalAuthAfter4s,
    pageDataLoadingSeen:sawDataLoading,pageDataLoadingStillAfter4s:dataLoadingAfter4s,
    mainLength:last?.mainLength||0,headings:last?.headingCount||0,
    controls:last?.visibleControls||0,actualPath:last?.pathname||null,
    frameNavigations,...classifyEvents(events)};
}

async function run() {
  const opts=new Map(process.argv.slice(2).filter(a=>a.startsWith('--')&&a.includes('='))
    .map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
  const pid=Number(opts.get('pid'));
  const port=Number(opts.get('port'));
  const maxMs=Math.max(2500,Math.min(20000,Number(opts.get('timeout-ms')||10000)));
  if (!Number.isInteger(pid) || pid<1 || !Number.isInteger(port) || port<1024 || port>65535)
    throw new Error('Explicit --pid and --port required; no discovery or process launch');
  const routes=exportedRoutes().filter(route=>!['/login','/setup','/unauthorized','/404'].includes(route));
  assertOwnedQaPort(pid,port);
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000)})).json();
  const pages=targets.filter(t=>t.type==='page');
  // A completed real XLSX export may leave one Chromium downloads-hub page.
  // Ignore that UI-owned auxiliary page, but reject all other external pages
  // or duplicate Tauri app tabs before reading any authenticated app state.
  const applicationPages=pages.filter(t=>t.url.startsWith('http://tauri.localhost/'));
  const downloadHubs=pages.filter(t=>{
    try{return new URL(t.url).hostname==='downloads-hub';}catch{return false;}
  });
  if (applicationPages.length!==1 || downloadHubs.length>1 ||
      pages.length!==applicationPages.length+downloadHubs.length)
    throw new Error('Refusing ambiguous or external WebView2 target');
  const client=new CDP(applicationPages[0].webSocketDebuggerUrl);
  await client.connect();
  const output=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pharma-navigation-perf-'));
  const report={mode:'prime_approved_existing_webview2_readonly_navigation',
    expected_source_routes:routes.length,exported_html_pages:exportedRoutes().length,
    app_pid:pid,port,auth_verified:false,direct_routes:[],spa_routes:[],
    caveat:'Direct Page.navigate forces full document reload; SPA clicks are separate. No transaction controls clicked or app data persisted.'};
  const save=()=>fs.writeFileSync(path.join(output,'route-timings.json'),JSON.stringify(report,null,2));
  try {
    await client.send('Runtime.enable'); await client.send('Page.enable');
    const auth=await client.evaluate(`(async()=>{
      try{const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
      return {authenticated:!!u,roleAllowed:!!u&&['owner','admin'].includes(u.role)};}
      catch(_){return {authenticated:false,roleAllowed:false}}})()`);
    if (!auth?.authenticated || !auth.roleAllowed) {
      report.blocker='No verified native owner/admin session in prime-owned WebView; no route navigation attempted';
      save();console.log('BLOCKED_NOT_AUTHENTICATED results='+output);process.exitCode=2;return;
    }
    report.auth_verified=true;
    // Only native authenticated session reads; do not retrieve or persist user profile fields.
    report.native_profile_read_ms=await client.evaluate(`(async()=>{
      const durations=[];
      for(let i=0;i<6;i++){
        const t=performance.now();
        const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
        if(!u)return null;
        durations.push(Math.round((performance.now()-t)*100)/100);
      }
      return durations;
    })()`);
    const selected=opts.get('routes')?.split(',').filter(Boolean);
    const scan=selected?selected.filter(r=>routes.includes(r)):routes;
    if (selected?.some(r=>!routes.includes(r))) throw new Error('Requested route missing from actual export');
    for (const route of scan) {
      const t0=performance.now(),eventStart=client.events.length;
      try {
        await client.send('Page.navigate',{url:`http://tauri.localhost${route}`});
        report.direct_routes.push(await monitor(client,route,maxMs,t0,eventStart));
      } catch (_) {
        report.direct_routes.push({route,status:'runtime_fail',phase:'CDP_navigation_error',elapsedMs:Math.round(performance.now()-t0)});
      }
      const row=report.direct_routes.at(-1);
      console.log(`DIRECT ${report.direct_routes.length}/${scan.length} ${route} ${row.status} ${row.elapsedMs}ms ${row.phase}`);
      save();
    }
    report.direct_summary=countRouteSummary(report.direct_routes,scan.length);
    // Real Next Link handler SPA path, not history.pushState / a fresh document.
    // Only local anchor navigation; never click buttons or submit forms.
    const spaRoutes=process.argv.includes('--skip-spa')?[]:['/','/stores/items','/inventory','/patients','/reports','/'];
    if (spaRoutes.length) {
      await client.send('Page.navigate',{url:'http://tauri.localhost/'});
      await monitor(client,'/',maxMs,performance.now(),client.events.length);
      for (const route of spaRoutes.slice(1)) {
        const start=performance.now(),eventStart=client.events.length;
        let clicked=false;
        try {
          clicked=await client.evaluate(`(() => {
            const a=[...document.querySelectorAll('a[href]')]
              .find(el=>el.getAttribute('href')===${JSON.stringify(route)});
            if(!a)return false; a.click(); return true;
          })()`);
          const result=clicked?await monitor(client,route,maxMs,start,eventStart,true)
            :{route,status:'not_linked',elapsedMs:0};
          report.spa_routes.push(result);
        } catch (_) {report.spa_routes.push({route,status:'runtime_fail',phase:'SPA_navigation_error'});}
        const row=report.spa_routes.at(-1);
        console.log(`SPA ${route} ${row.status} ${row.elapsedMs||0}ms frames=${row.frameNavigations??'?'} clicked=${!!clicked}`);
        save();
      }
      // /stores/manufacturers is reached through the real Stores hub, rather
      // than a direct top-level sidebar item. This is read-only anchor navigation.
      await client.send('Page.navigate',{url:'http://tauri.localhost/stores'});
      await monitor(client,'/stores',maxMs,performance.now(),client.events.length);
      const route='/stores/manufacturers',start=performance.now(),eventStart=client.events.length;
      const clicked=await client.evaluate(`(() => {
        const a=[...document.querySelectorAll('a[href]')].find(el=>el.getAttribute('href')==='/stores/manufacturers');
        if(!a)return false; a.click();return true;
      })()`);
      const result=clicked?await monitor(client,route,maxMs,start,eventStart,true)
        :{route,status:'not_linked',elapsedMs:0};
      report.spa_routes.push(result);save();
      console.log(`SPA ${route} ${result.status} ${result.elapsedMs||0}ms frames=${result.frameNavigations??'?'} clicked=${clicked}`);
    }
    report.completed_at=new Date().toISOString();save();
    console.log('RESULT_DIR '+output);
    console.log('SUMMARY '+JSON.stringify(report.direct_summary));
  } finally {client.close();}
}

module.exports={classifyState,finalStatus,countRouteSummary,monitor,observation};
if (require.main===module) run().catch(err=>{console.error('REFUSED_OR_FAILED '+err.message);process.exitCode=1;});
