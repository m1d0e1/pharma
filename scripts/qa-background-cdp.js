#!/usr/bin/env node
'use strict';

// Only CDP over a verified QA-background process. No OS pointer, clipboard,
// Windows activation, broad native SQL, or financial form submissions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runBehaviors } = require('./qa-background-behaviors');
const { verifyRejectedSupplierInputs } = require('./qa-background-native-negatives');
const { isReadySignedNativeLease, isTrustedSyntheticOwnerReconciliation,
  nativeRouteAcceptance } = require('./qa-background-auth-gate');

const args = process.argv.slice(2);
const option = (name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const activationOnly = args.includes('--activate-only');
const verifyExpiredSynthetic = args.includes('--verify-expired-synthetic');
const behaviorMode = args.includes('--behavior');
const negatives = args.includes('--negative-native');
const oneSyntheticBank = args.includes('--one-synthetic-bank');
if (oneSyntheticBank) {
  throw new Error('BG one-time EGP1 bank payment has been reconciled; do not reissue the financial request');
}
const routeFilter = option('routes')?.split(',').filter(Boolean) || null;
const port = Number(option('port'));
const out = option('out');
const outputLease = option('output-lease');
const manifestPath = option('manifest') || process.env.PHARMA_QA_NATIVE_MANIFEST;
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !out || !manifestPath) {
  throw new Error('CDP requires --port, --out and verified --manifest or PHARMA_QA_NATIVE_MANIFEST');
}
// Direct invocation must never overwrite arbitrary user/QA evidence. Parent
// generates a fresh, unpredictable directory immediately under TEMP. Reject
// symlinks/junction aliases and any prior native-report before first write.
const realOut = fs.realpathSync(out);
const realTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(realOut).toLowerCase() !== realTemp.toLowerCase()
    || !/^pharma-background-qa-[a-zA-Z0-9]{6}$/.test(path.basename(realOut))
    || !fs.statSync(realOut).isDirectory()
    || fs.existsSync(path.join(realOut, 'native-report.json'))) {
  throw new Error('Refusing CDP output directory: not a fresh isolated QA TEMP run');
}
let lease;
try { lease = JSON.parse(fs.readFileSync(path.join(realOut,'.cdp-run-lease'),'utf8')); }
catch (_) { throw new Error('Refusing CDP output directory: runner lease missing'); }
if (!/^[a-f0-9]{48}$/.test(outputLease || '') || outputLease !== lease.token
    || !Number.isInteger(lease.created_at_ms)
    || Math.abs(Date.now() - lease.created_at_ms) > 300000) {
  throw new Error('Refusing CDP output directory: fresh runner lease invalid');
}
const report = { status: 'blocked', mode: 'verified-background-tauri-cdp',
  routes: [], controls: { discovered: 0, verified_safe: 0, verified_searches: 0,
    unsupported: 0, failures: 0 },
  focus_actions: 0, money_submissions: 0, hydration_warnings: 0, warnings: [], failures: [] };
const saved = path.join(realOut, 'native-report.json');
// Atomically claim the report; even two processes racing with the same valid
// output lease cannot overwrite one another's evidence. Retain this owned
// handle for subsequent snapshots instead of truncating the pathname.
const savedFd = fs.openSync(saved, 'wx', 0o600);
const save = () => {
  const data = Buffer.from(JSON.stringify(report, null, 2));
  fs.ftruncateSync(savedFd, 0);
  fs.writeSync(savedFd, data, 0, data.length, 0);
  fs.fsyncSync(savedFd);
};
const financeTabs = [
  'شجرة الحسابات', 'القيود اليومية', 'ميزان المراجعة', 'إعدادات الميزان',
  'الخزينة والتوريدات', 'حركة النقدية', 'نقط البيع', 'الحسابات البنكية',
  'الأوراق المالية', 'البطاقات الائتمانية', 'تعريف المصروفات',
  'المصاريف التشغيلية', 'الإشعارات والتسويات', 'تقارير الوردية', 'سجل الرقابة',
];

function verifyManifest() {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const exe = fs.realpathSync(m.executable);
  const db = fs.realpathSync(m.database);
  const temp = fs.realpathSync(os.tmpdir());
  const containment = p => p.toLowerCase().startsWith(temp.toLowerCase() + path.sep);
  const ownedId = 'com.pharma.disposable.qa20261014bg';
  const expectedDb = path.join(process.env.APPDATA || '', ownedId, 'pharma_local.db');
  if (!m.disposable || m.identifier !== ownedId || !Number.isInteger(m.pid) || !containment(exe)
      || !/pharma-qa-background/i.test(exe) || db.toLowerCase() !== expectedDb.toLowerCase()
      || db.toLowerCase().includes('src-tauri') || !fs.readFileSync(db).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')))
    throw new Error('Refusing CDP: target lacks independent QA-background executable/database custody');
  const stat = fs.statSync(db);
  const original = path.join(__dirname, '../src-tauri/pharma_local.db');
  const alternate = ['com.pharma.disposable.qa20261014b', 'com.pharma.disposable.qa20261014c']
    .map(id => path.join(process.env.APPDATA || '', id, 'pharma_local.db'));
  for (const other of [original, ...alternate]) {
    if (!fs.existsSync(other)) continue;
    const prior = fs.statSync(other);
    if (stat.dev === prior.dev && stat.ino === prior.ino)
      throw new Error('CDP BG data aliases an original or another QA session');
  }
  report.instance = { pid: m.pid, executable: exe, database: db, synthetic: true };
  return m;
}

function verifyDebuggerOwnedByApp(pid, executable) {
  if (process.platform !== 'win32') throw new Error('Private-desktop CDP ownership requires Windows');
  // The listener belongs to a WebView2 subprocess. Walk its OS parent chain
  // to the exact independently compiled BG app, not an arbitrary Tauri tab.
  const code = `$target=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + 'if($null -eq $target -or $target.ExecutablePath -ine $env:PHARMA_BG_EXPECTED_EXE){exit 5};'
    + `$rows=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);`
    + 'if($rows.Count -ne 1){exit 3};$currentPid=$rows[0].OwningProcess;'
    + `for($i=0;$i -lt 12;$i++){if($currentPid -eq ${pid}){Write-Output 'BG_CDP_OWNED';exit 0};`
    + '$process=Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid";'
    + 'if($null -eq $process){break};$currentPid=$process.ParentProcessId};exit 4';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
    { encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, PHARMA_BG_EXPECTED_EXE: executable } });
  if (result.status !== 0 || !result.stdout.includes('BG_CDP_OWNED'))
    throw new Error('CDP listener is not the verified isolated Tauri process descendant');
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const pending = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? pending.reject(new Error(m.error.message)) : pending.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') this.exceptions.push(m);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(js) {
    const response = await this.send('Runtime.evaluate', {
      expression: js, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error((detail.exception?.description || detail.text || 'CDP evaluation exception')
        .replace(/(?:password|secret|token)\s*[=:]\s*\S+/gi, '[redacted]')
        .slice(0, 500));
    }
    return response.result.value;
  }
  close() { this.ws.close(); }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(client, test, maxMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { if (await client.evaluate(test)) return true; } catch (_) { /* route navigation */ }
    await wait(125);
  }
  return false;
}

async function main() {
  const m = verifyManifest();
  verifyDebuggerOwnedByApp(m.pid, report.instance.executable);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  const targets = await response.json();
  if (targets.filter(t => t.type === 'page').length !== 1) throw new Error('Expected exactly one isolated WebView2 page on CDP port');
  const target = targets.find(t => t.type === 'page');
  const origin = new URL(target.url).origin;
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:', 'tauri:'].includes(parsedOrigin.protocol)
      || !['127.0.0.1', 'localhost', 'tauri.localhost'].includes(parsedOrigin.hostname))
    throw new Error('CDP origin is not an isolated native/loopback frontend');
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const ready = await waitFor(client, 'document.readyState === "complete"');
    if (!ready) throw new Error('Isolated WebView2 did not render');
    const initial = await client.evaluate('({href:location.href, title:document.title, tauri:!!window.__TAURI_INTERNALS__, text:document.body.innerText.slice(0,200)})');
    if (!initial.tauri || !/tauri\.localhost|localhost|127\.0\.0\.1|tauri:\/\//.test(initial.href))
      throw new Error('CDP page lacks genuine native Tauri IPC');
    report.startup = { ...initial, text: initial.text?.slice(0, 120) };

    if (verifyExpiredSynthetic) {
      // Capture renderer exceptions after Runtime.enable. A reload is needed:
      // WebView2's initial hydration happened before CDP attached.
      const firstException = client.exceptions.length;
      await client.send('Page.reload', { ignoreCache: true });
      const blockedUi = await waitFor(client, `(() => {
        const body=document.body.innerText;
        return body.includes('تفعيل ترخيص فارما') &&
          !body.includes('نقط البيع') &&
          !body.includes('القيود اليومية');
      })()`, 10000);
      await wait(500);
      const status = await client.evaluate(`(async()=> {
        try {
          const result=await window.__TAURI_INTERNALS__.invoke('license_status');
          return {valid:result.valid, startup_ready:result.startup_ready,
            expired:/expired|lease/i.test(result.reason || '')};
        } catch(error) {return {error:'native-license-status-command-denied'};}
      })()`);
      const hydrationErrors = client.exceptions.slice(firstException).filter(event =>
        /Minified React error #418\b|Hydration failed/i.test(String(
          event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || '')));
      report.synthetic_lease_expiry = { ...status, blocked_ui:blockedUi,
        post_reload_hydration_exceptions:hydrationErrors.length };
      report.status = status.valid===false && status.expired===true && blockedUi
        && hydrationErrors.length===0 ? 'pass' : 'fail';
      if (report.status !== 'pass') report.failures.push({
        phase:'synthetic_lease_expiry',error:'Native licensing did not confirm expired synthetic lease'
      });
      report.warnings.push('Synthetic-only expiry check; no production renewal, issuer, hardware or TPM acceptance');
      save();
      if (report.status !== 'pass') process.exitCode=1;
      return;
    }

    if (activationOnly) {
      // Fresh, isolated synthetic activation via REAL native Tauri IPC, no
      // production issuer key or browser-stored credential. Restart required.
      const license = fs.readFileSync(path.join(path.dirname(m.executable),
        'synthetic-signed-license.json'), 'utf8');
      const activation = await client.evaluate(`(async () => {
        try {
          const result = await window.__TAURI_INTERNALS__.invoke('license_install',
            { signedLicense: ${JSON.stringify(license)} });
          return { valid: result.valid === true, startup_ready: result.startup_ready === true };
        } catch (error) { return { valid: false, error: String(error) }; }
      })()`);
      report.synthetic_activation = activation;
      report.status = activation.valid ? 'pass' : 'fail';
      if (!activation.valid) report.failures.push({ phase: 'synthetic_activation', error: activation.error || 'Native validation rejected synthetic lease' });
      report.warnings.push('Synthetic lease requires a new native startup; this is not a production issuer or TPM certification');
      save();
      if (!activation.valid) process.exitCode = 1;
      return;
    }

    // A browser localStorage session can be stale or forged. Check the signed
    // Tauri license + native startup before any private-desktop login, route,
    // sensitive form or rejected-write attempt.
    const licenseState = await client.evaluate(`(async () => {
      try { const status=await window.__TAURI_INTERNALS__.invoke('license_status');
        return {valid:status.valid===true,startup_ready:status.startup_ready===true};
      } catch (_) { return {valid:false,startup_ready:false}; }
    })()`);
    report.native_license_ready = isReadySignedNativeLease(licenseState);
    if (!report.native_license_ready) {
      report.authenticated = false;
      report.status = 'partial';
      report.warnings.push('Signed native license/startup unavailable: no session, protected route or money operation attempted');
      save();
      process.exitCode = 2;
      return;
    }

    // Authenticate only if the separately supplied synthetic credential is explicitly allowed.
    // The script never prints, logs, or persists the password.
    if (m.synthetic_password_file) {
      const secretFile = fs.realpathSync(m.synthetic_password_file);
      if (!secretFile.toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase() + path.sep))
        throw new Error('Synthetic password must be under TEMP');
      const password = fs.readFileSync(secretFile, 'utf8').trim();
      await client.send('Page.navigate', { url: `${origin}/login` });
      if (!(await waitFor(client, `document.readyState==='complete' &&
        !!document.querySelector('form input[type="text"]') &&
        !!document.querySelector('form input[type="password"]') &&
        !!document.querySelector('form button[type="submit"]')`)))
        throw new Error('Synthetic login form not ready');
      // Wait for the hydrated React form (input DOM alone appears too early).
      await wait(700);
      // React-compatible setter: background renderer DOM events, not OS keyboard input.
      const fill = (kind, value) => `(() => { const el=document.querySelector('form input[type="${kind}"]'); if (!el) throw Error('Synthetic login input missing'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
      await client.evaluate(fill('text', 'admin'));
      await client.evaluate(fill('password', password));
      // DOM .click() is intentional virtual WebView input, not system mouse/focus.
      await client.evaluate(`(() => {const button=document.querySelector('form button[type="submit"]') || document.querySelector('form button'); if(!button) throw Error('Login button missing');button.click();})()`);
      const browserLogin = await waitFor(client, `location.pathname === '/' && !!localStorage.getItem('pharma_session_user')`, 15000);
      if (!browserLogin) throw new Error('Synthetic owner native login failed; did not navigate protected routes');
    } else {
      const browserSession = await client.evaluate('!!localStorage.getItem("pharma_session_user")');
      if (!browserSession) {
        report.authenticated = false;
        report.status = 'partial';
        report.warnings.push('No authenticated synthetic browser session; no privileged route or native operation attempted');
        save();
        process.exitCode = 2;
        return;
      }
    }

    // Owner reconciliation checks the actual currently authorized native
    // session/actor, not localStorage. It refuses non-owner or stale sessions.
    // On failure STOP: never carry on into route handlers or negative writes.
    {
      const audit = await client.evaluate(`(async () => {
        try {
          const value=await window.__TAURI_INTERNALS__.invoke('reconcile_financial_sources_native');
          return {status:value.status,scannedJournals:value.scannedJournals,
            findings:Array.isArray(value.findings)?value.findings.length:-1,
            unverifiableLegacyJournals:value.unverifiableLegacyJournals};
        } catch(error) { return {error:String(error).slice(0,150)}; }
      })()`);
      report.native_owner_reconciliation = audit;
      if (!isTrustedSyntheticOwnerReconciliation(audit))
        throw new Error('Native owner authorization or synthetic journal reconciliation refused');
      report.authenticated = true;
    }

    const inventory = JSON.parse(fs.readFileSync(path.join(out, 'routes.json'), 'utf8')).paths;
    if (routeFilter && routeFilter.some(route => !inventory.includes(route)))
      throw new Error('Requested CDP route does not exist in the static export');
    const routes = routeFilter || inventory;
    const skipRoutes = new Set(['/login', '/setup', '/unauthorized', '/_not-found', '/404', '/auth/signout']);
    for (const route of routes) {
      if (skipRoutes.has(route)) {
        report.routes.push({ route, status: 'not_run', reason: 'auth, logout or initial enrollment boundary' });
        continue;
      }
      if (!report.authenticated) {
        report.routes.push({ route, status: 'blocked', reason: 'authenticated synthetic session unavailable' });
        continue;
      }
      const eventStart = client.exceptions.length;
      try {
        await client.send('Page.navigate', { url: origin + route });
        const navigated = await waitFor(client, `document.readyState==='complete' && location.pathname === ${JSON.stringify(route)}`, 12000);
        if (!navigated) throw new Error('route did not render at requested URL (possible permission redirect)');
        // readyState=complete precedes React hydration, session verification,
        // native IPC and the actual page render. A 175ms snapshot in the old
        // harness captured only the navigation skeleton for all 63 routes.
        const mountedCondition = `(() => { const text=document.querySelector('main')?.innerText.trim() || '';
              return text.length >= 12 && !/^(جاري تحميل|جارٍ تحميل|loading|please wait)/i.test(text); })()`;
        let mounted = await waitFor(client, mountedCondition, 15000);
        let retry = false;
        if (!mounted) {
          // Keep the original slow/blank observation; one bounded reload can
          // distinguish transient hydration from reproducible missing content.
          retry = true;
          await client.send('Page.reload', { ignoreCache: true });
          mounted = await waitFor(client, mountedCondition, 15000);
        }
        if (mounted) await wait(325);
        const detail = await client.evaluate(`(() => {
          const controls=[...document.querySelectorAll('button,a,input,select,textarea,[role="tab"],[role="switch"],[role="menuitem"]')]
            .filter(e=>e.getClientRects().length>0);
          return {
            route:location.pathname, content:document.body.innerText.length,
            main_content:document.querySelector('main')?.innerText.trim().length || 0,
            main_preview:document.querySelector('main')?.innerText.trim().slice(0,180) || '',
            title:document.title, tauri:!!window.__TAURI_INTERNALS__,
            controls:controls.map((e,i)=>({i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),
              label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').trim().slice(0,100),
              required:e.required===true, disabled:!!e.disabled, kind:e.getAttribute('type'),
              expanded:e.getAttribute('aria-expanded'), selected:e.getAttribute('aria-selected'),
              href:e.getAttribute('href')})).slice(0,400),
            fatal:/ChunkLoadError|Application error|Unhandled Runtime Error/i.test(document.body.innerText),
            still_loading:/^(جاري تحميل|جارٍ تحميل|loading|please wait)/i.test(document.querySelector('main')?.innerText.trim() || ''),
            visible_denial:/فشل تحميل|غير مصرح|ليس لديك صلاحية|permission denied|access denied/i.test(document.querySelector('main')?.innerText || '')
          };
        })()`);
        const errors = client.exceptions.slice(eventStart).map(event =>
          String(event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text || 'Unknown runtime error'));
        const hydration = errors.filter(message => /Minified React error #418\b|Hydration failed/i.test(message));
        const hardErrors = errors.filter(message => !/Minified React error #418\b|Hydration failed/i.test(message));
        report.hydration_warnings += hydration.length;
        const entry = { route,
          status: detail.fatal || !detail.tauri || hardErrors.length ? 'fail'
            : detail.visible_denial ? 'blocked_feature_denial'
              : !mounted || detail.still_loading || detail.main_content < 12 ? 'unverified_loading'
                : hydration.length ? 'unverified_hydration' : 'pass',
          text_length: detail.content, main_length: detail.main_content,
          main_preview: detail.main_preview,
          controls_discovered: detail.controls.length,
          page_title: detail.title, retries_after_blank: retry ? 1 : 0,
          exceptions: errors.length,
          hydration_warnings: hydration.length,
          hydration_acceptance: hydration.length ? 'unverified_react_mismatch' : 'no_mismatch_observed',
          hydration_diagnostics: hydration.map(message => message.slice(0, 280)),
          hard_exceptions: hardErrors.map(message => message.slice(0, 250)),
          controls: detail.controls.map(c => ({ ...c,
            coverage: c.tag === 'button' || c.tag === 'input' || c.tag === 'select' ? 'inventoried_unexercised' : 'navigation_only' })) };
        // No generic role=tab/switch click: the handler is unknown and may
        // persist user settings. Only specifically reviewed controls below.
        // Read-only search inputs are safe on explicitly listed directory
        // pages. A changed input alone is NOT successful filtering: the
        // rendered main content must visibly change and is restored afterward.
        const filterRoutes = new Set(['/stores/items', '/patients', '/accounts',
          '/stores/categories', '/stores/manufacturers', '/stores/nature',
          '/stores/scientific-groups', '/stores/usage', '/stores/indications']);
        if (entry.status === 'pass' && filterRoutes.has(route)) {
          const search = detail.controls.find(c => c.tag === 'input'
            && ['text', 'search', null].includes(c.kind) && /بحث|ابحث|search/i.test(c.label));
          if (search) {
            const searchResult = await client.evaluate(`(async () => {
              const all=[...document.querySelectorAll('button,a,input,select,textarea,[role="tab"],[role="switch"],[role="menuitem"]')]
                .filter(e => e.getClientRects().length > 0);
              const el=all[${search.i}];
              if (!el || el.tagName!=='INPUT' || el.value) return {verified:false,reason:'input not pristine'};
              const main=document.querySelector('main');
              if (!main) return {verified:false,reason:'main element absent'};
              const before=main.innerText;
              const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
              const set = value => { setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true})); };
              set('QA_BACKGROUND_NO_MATCH_058');
              await new Promise(resolve => setTimeout(resolve,500));
              const value=el.value,changed=main.innerText!==before;
              set('');
              await new Promise(resolve => setTimeout(resolve,200));
              return {verified:value==='QA_BACKGROUND_NO_MATCH_058' && changed,changed,restored:el.value===''};
            })()`);
            const field = entry.controls.find(c => c.i === search.i);
            if (field) field.coverage = searchResult?.verified && searchResult.restored
              ? 'verified_readonly_filter_and_restore' : 'filter_not_verified';
            if (searchResult?.verified && searchResult.restored) report.controls.verified_searches++;
            else report.controls.unsupported++;
          }
        }
        if (entry.status === 'pass' && route === '/accounts') {
          entry.finance_tabs = [];
          for (const label of financeTabs) {
            const state = await client.evaluate(`(() => {
              const button=[...document.querySelectorAll('[class*="lg:col-span-3"] button')].find(el =>
                el.getClientRects().length>0 && el.innerText.trim()===${JSON.stringify(label)});
              if(!button) return {present:false,selected:false};
              button.click();
              return {present:true,selected:button.className.includes('bg-slate-900')};
            })()`);
            if (!state?.present) {
              entry.finance_tabs.push({ label, status: 'not_visible_or_denied' });
              continue;
            }
            await wait(300);
            const selected = await client.evaluate(`(() => {
              const button=[...document.querySelectorAll('[class*="lg:col-span-3"] button')].find(el =>
                el.getClientRects().length>0 && el.innerText.trim()===${JSON.stringify(label)});
              return !!button && button.className.includes('bg-slate-900');
            })()`);
            entry.finance_tabs.push({ label, status: selected ? 'selected_ui_only' : 'selection_unverified' });
            if (selected) report.controls.verified_safe++;
            else report.controls.unsupported++;
          }
          // The default treasury tab is read-only in this test; restore it.
          await client.evaluate(`(() => {const button=[...document.querySelectorAll('[class*="lg:col-span-3"] button')]
            .find(el => el.innerText.trim()==='الخزينة والتوريدات'); button?.click(); return true;})()`);
        }
        report.controls.discovered += detail.controls.length;
        report.controls.unsupported += entry.controls.filter(c => c.coverage === 'inventoried_unexercised').length;
        if (['fail','unverified_loading','unverified_hydration'].includes(entry.status)) {
          report.failures.push({ route, error: entry.status,
            detail: entry.main_preview, exceptions: entry.hard_exceptions });
          try {
            const shot = await client.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(out, `native-failure-${report.failures.length}.png`), Buffer.from(shot.data, 'base64'));
          } catch (error) { report.warnings.push(`Screenshot unavailable on ${route}: ${error.message}`); }
        }
        report.routes.push(entry);
        console.log(`CDP ${report.routes.length}/${routes.length}: ${route} ${entry.status}, controls=${entry.controls_discovered}`);
      } catch (error) {
        report.routes.push({ route, status: 'fail', error: error.message });
        report.failures.push({ route, error: error.message });
      }
      save();
    }
    if (behaviorMode && report.authenticated) {
      report.behaviors = await runBehaviors(client, origin, out, inventory, {
        routes,
        deniedRoutes: new Set(report.routes
          .filter(item => item.status !== 'pass').map(item => item.route)),
      });
      report.controls.verified_behaviors = report.behaviors.summary.verified || 0;
      report.controls.unverified_behaviors = (report.behaviors.summary.unverified || 0)
        + (report.behaviors.summary.unsupported || 0)
        + (report.behaviors.summary.untested || 0)
        + (report.behaviors.summary.blocked || 0);
    }
    if (negatives && report.authenticated) {
      report.native_rejected_writes = await verifyRejectedSupplierInputs(client);
      if (report.native_rejected_writes.status !== 'pass') {
        report.failures.push({ phase:'native_financial_negative_boundary',
          error:'An intentionally invalid synthetic supplier request was accepted or not checked' });
      }
      save();
    }
    report.hydration_acceptance = report.hydration_warnings === 0
      ? 'no_mismatch_observed' : 'unverified_mismatch_requires_correction';
    report.status = nativeRouteAcceptance({ failures:report.failures, routes:report.routes,
      authenticated:report.authenticated, hydrationWarnings:report.hydration_warnings });
    report.warnings.push('React #418 mismatch prevents complete native route acceptance, even when content mounts; individual behavior assertions remain separately attributed');
    report.warnings.push('Inventoried controls are not automatically proven functional; destructive actions and business validation require native regression tests or isolated explicit safe flows');
    report.warnings.push('Signed installed commercial release, physical TPM, issuance, recovery and external approvals are NOT covered');
    save();
    if (report.status !== 'pass') process.exitCode = report.status === 'partial' ? 2 : 1;
  } finally { client.close(); }
}

main().catch(error => {
  report.status = 'fail'; report.failures.push({ phase: 'setup', error: error.message }); save();
  console.error('Isolated QA CDP failed:', error.message); process.exitCode = 1;
});
