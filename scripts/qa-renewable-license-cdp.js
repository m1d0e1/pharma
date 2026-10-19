#!/usr/bin/env node
'use strict';

// Test-only genuine Tauri licensing IPC on the independently pinned private
// desktop. No money writers, browser login, foreground input or trust bypass.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const identifier = 'com.pharma.disposable.qa20261015renewable';
const port = 9334;
const base = path.join(os.tmpdir(), 'pharma-qa-renewable-20261015');
const manifestPath = path.join(base, 'qa-manifest-desktop.json');
const args = process.argv.slice(2);
const installing = args.length === 2 && args[0] === '--install-file';
const mode = args.length === 1 && ['--status','--online-activate','--owner-state'].includes(args[0]) ? args[0] : null;
if (!mode && !installing) {
  throw new Error('Expected --status, --online-activate, --owner-state, or --install-file');
}

function verifyManifest() {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const exe = fs.realpathSync(m.executable);
  const expectedExe = fs.realpathSync(path.join(base, 'pharma.exe'));
  const db = fs.realpathSync(m.database);
  const expectedDb = path.join(process.env.APPDATA, identifier, 'pharma_local.db');
  const digest = fs.readFileSync(path.join(base, 'renewable-bg-executable-sha256.txt'), 'ascii').trim();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  if (!m.disposable || m.identifier !== identifier || exe.toLowerCase() !== expectedExe.toLowerCase()
    || db.toLowerCase() !== expectedDb.toLowerCase() || m.cdp_port !== port
    || actual.toLowerCase() !== digest.toLowerCase() || !Number.isInteger(m.pid)
    || m.pid <= 0 || m.foreground_unchanged !== true) {
    throw new Error('Independent private-desktop executable/database/foreground custody mismatch');
  }
  return { ...m, executable: exe };
}

function verifyOwnedListener(m) {
  const command = `$target=Get-CimInstance Win32_Process -Filter 'ProcessId=${m.pid}';`
    + 'if($null -eq $target -or $target.ExecutablePath -ine $env:PHARMA_BG_EXPECTED_EXE){exit 5};'
    + ` $rows=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);`
    + 'if($rows.Count -ne 1){exit 3};$pidWalk=$rows[0].OwningProcess;'
    + `for($n=0;$n -lt 12;$n++){if($pidWalk -eq ${m.pid}){Write-Output 'RENEWABLE_CDP_OWNED';exit 0};`
    + '$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$pidWalk";'
    + 'if($null -eq $proc){break};$pidWalk=$proc.ParentProcessId};exit 4';
  const proof = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, PHARMA_BG_EXPECTED_EXE: m.executable },
  });
  if (proof.status !== 0 || !proof.stdout.includes('RENEWABLE_CDP_OWNED')) {
    throw new Error('CDP listener is not a descendant of the independently pinned native process');
  }
}

async function main() {
  const m = verifyManifest();
  verifyOwnedListener(m);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('CDP target query failed');
  const pages = (await response.json()).filter(entry => entry.type === 'page');
  if (pages.length !== 1) throw new Error('Expected one native WebView2 page');
  const target = pages[0];
  const url = new URL(target.url);
  if (!['127.0.0.1', 'localhost', 'tauri.localhost'].includes(url.hostname)) {
    throw new Error('Webview page origin is not local native QA');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let next = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const item = JSON.parse(event.data);
    const held = pending.get(item.id);
    if (!held) return;
    pending.delete(item.id);
    if (item.error) held.reject(new Error(item.error.message));
    else held.resolve(item.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Native CDP JS evaluation failed');
    return result.result.value;
  };
  try {
    await send('Runtime.enable');
    const native = await evaluate('!!window.__TAURI_INTERNALS__');
    if (!native) throw new Error('Not an authentic Tauri WebView2 IPC context');
    if (installing) {
      const filename = path.resolve(args[1]);
      if (path.dirname(filename).toLowerCase() !== fs.realpathSync(base).toLowerCase()) {
        throw new Error('Only an issuer result file within the new disposable TEMP root is allowed');
      }
      const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (record.identity !== identifier || !record.test_only || !record.signed_license
        || typeof record.signed_license.payload_b64 !== 'string'
        || typeof record.signed_license.signature_b64 !== 'string') {
        throw new Error('Issuer result is not this independently identified test-only authority');
      }
      const signed = JSON.stringify(record.signed_license);
      const outcome = await evaluate(`(async()=>{
        try {const s=await window.__TAURI_INTERNALS__.invoke('license_install',
          {signedLicense:${JSON.stringify(signed)}});
          return {valid:s.valid===true,startup_ready:s.startup_ready===true,
            license_id:s.license_id,reason:s.reason};}
        catch(e){return {valid:false,error:String(e).slice(0,180)};}
      })()`);
      if (!outcome.valid || outcome.license_id !== record.license_id) {
        throw new Error('Real native Tauri license_install did not authorize the independent test grant: '
          + (outcome.error || outcome.reason || 'no detail'));
      }
      console.log(JSON.stringify({ native_install_valid: true,
        startup_ready: outcome.startup_ready, serial: record.activation_serial,
        identity: identifier, restart_required: !outcome.startup_ready }));
    } else if (mode === '--online-activate') {
      const issued = spawnSync('python', ['-B', '-m', 'scripts.licensing.background_qa', 'online-credential'], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true,
        timeout: 10000, maxBuffer: 8192,
      });
      if (issued.status !== 0) throw new Error('Disposable issuer has no matching online credential');
      const proof = JSON.parse(issued.stdout);
      const result = await evaluate(`(async()=>{
        try {const s=await window.__TAURI_INTERNALS__.invoke('license_activate_online',
          {licenseId:${JSON.stringify(proof.license_id)},activationCode:${JSON.stringify(proof.activation_code)}});
          return {valid:s.valid===true,startup_ready:s.startup_ready===true,license_id:s.license_id};}
        catch(_error){return {valid:false};}
      })()`);
      if (!result.valid || !result.startup_ready || result.license_id !== proof.license_id)
        throw new Error('Native independently issued HTTPS activation failed');
      console.log(JSON.stringify({identity:identifier,real_native_https_activation:true,
        valid:true,startup_ready:true,online_credential_dpapi_sealed:true}));
    } else if (mode === '--owner-state') {
      const state = await evaluate(`(async()=>{
        try {return {ok:true,pending:await window.__TAURI_INTERNALS__.invoke('owner_enrollment_status')};}
        catch(_error){return {ok:false};}
      })()`);
      if (!state.ok) throw new Error('Native owner enrollment status rejected');
      console.log(JSON.stringify({identity:identifier,owner_enrollment_pending:state.pending}));
    } else {
      const status = await evaluate(`(async()=>{
        try {const s=await window.__TAURI_INTERNALS__.invoke('license_status');
          return {valid:s.valid===true,startup_ready:s.startup_ready===true,
            license_id:s.license_id,reason:s.reason,
            machine_fingerprint:s.machine_fingerprint,lease_until_utc:s.lease_until_utc};}
        catch(e){return {error:String(e).slice(0,180)};}
      })()`);
      if (!/^[a-f0-9]{64}$/.test(status.machine_fingerprint || '')) {
        throw new Error('Native licensing status failed to return a valid machine fingerprint');
      }
      console.log(JSON.stringify({ ...status, identity: identifier }));
    }
  } finally {
    socket.close();
  }
}

main().catch(err => { console.error('RENEWABLE_QA_CDP_ERROR=' + err.message); process.exitCode = 1; });
