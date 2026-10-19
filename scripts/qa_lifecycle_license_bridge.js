'use strict';

// Exclusive disposable lifecycle-QA WebView2 bridge. The parent Python
// process captures fingerprint privately and passes a signed *test-only*
// license envelope on stdin. Never print a fingerprint, signature or grant.
const mode = process.argv[2];
if (!['status', 'install'].includes(mode)) throw Error('Invalid QA bridge operation');

async function main() {
  const pages = (await (await fetch('http://127.0.0.1:9334/json/list')).json())
    .filter(p => p.type === 'page' && new URL(p.url).hostname === 'tauri.localhost');
  if (pages.length !== 1) throw Error('Expected exactly one owned Tauri QA page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let index = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const [resolve, reject] = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(Error(data.error.message)) : resolve(data.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++index;
    pending.set(id, [resolve, reject]);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const invoke = async (command, argumentsObject) => {
    const js = `(async()=>{
      if(!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke!=='function')
        throw Error('Missing real native Tauri IPC');
      return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(argumentsObject)});
    })()`;
    const reply = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw Error('Native QA license IPC rejected');
    return reply.result.value;
  };
  try {
    const status = await invoke('license_status', {});
    if (mode === 'status') {
      const marker = status?.machineFingerprint || status?.machine_fingerprint;
      if (!/^[0-9a-f]{64}$/.test(marker)) throw Error('Native fingerprint missing');
      process.stdout.write(JSON.stringify({ fingerprint: marker, valid: status.valid === true }) + '\n');
    } else {
      if (status?.startupReady || status?.startup_ready) throw Error('QA native database already initialized; refusing license replay');
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => {
          data += chunk;
          if (data.length > 16384) reject(Error('Envelope exceeds native limit'));
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
      });
      const envelope = JSON.parse(raw);
      if (!envelope || typeof envelope.payload_b64 !== 'string' || typeof envelope.signature_b64 !== 'string')
        throw Error('Invalid signed QA grant payload');
      const installed = await invoke('license_install', { signedLicense: JSON.stringify(envelope) });
      const verified = await invoke('license_status', {});
      if (installed?.valid !== true || verified?.valid !== true ||
          (verified?.offlineTerm !== true && verified?.offline_term !== true))
        throw Error('Native installation did not validate the offline QA license');
      process.stdout.write(JSON.stringify({ valid: true, offline_term: true,
        startup_ready: !!(verified?.startupReady || verified?.startup_ready) }) + '\n');
    }
  } finally {
    ws.close();
  }
}

main().catch(error => {
  process.stderr.write('Lifecycle QA native license bridge failed: ' + String(error.message || error).slice(0, 120) + '\n');
  process.exitCode = 1;
});
