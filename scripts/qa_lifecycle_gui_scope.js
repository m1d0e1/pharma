'use strict';
// Read-only review of true licensed Tauri WebView2 routes. Parent supplies
// existing *disposable* source identifiers only through stdin. No names,
// invoice IDs, customer details or financial transactions are logged.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const privateTargets = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; if (data.length > 16384) reject(Error('Too many QA identifiers')); });
    process.stdin.on('end', () => resolve(JSON.parse(data)));
    process.stdin.on('error', reject);
  });
  const pages = (await (await fetch('http://127.0.0.1:9334/json/list')).json())
    .filter(page => page.type === 'page' && new URL(page.url).hostname === 'tauri.localhost');
  if (pages.length !== 1) throw Error('Only one reviewed lifecycle QA window permitted');
  const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((yes, no) => { socket.addEventListener('open', yes, { once: true }); socket.addEventListener('error', no, { once: true }); });
  let seq = 0;
  const pend = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!pend.has(data.id)) return;
    const [yes, no, timer] = pend.get(data.id);
    clearTimeout(timer);
    pend.delete(data.id);
    data.error ? no(Error(data.error.message)) : yes(data.result);
  });
  const send = (method, params = {}) => new Promise((yes, no) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pend.delete(id);
      no(Error('Read-only QA CDP command timed out'));
    }, 12000);
    pend.set(id, [yes, no, timer]);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const outcome = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (outcome.exceptionDetails) throw Error('QA page evaluation error');
    return outcome.result?.value;
  };
  const scope = await evaluate(`(async()=>{
    const user=await window.__TAURI_INTERNALS__.invoke('current_local_user');
    return {id:user?.id,tenant:user?.pharmacy_id,role:user?.role};
  })()`);
  if (scope?.id !== 'qa_lifecycle_owner_20261016' || scope.tenant !== 'qa_lifecycle_20261016' || scope.role !== 'owner')
    throw Error('Native actor not independently owned by the lifecycle QA tenant');
  await send('Page.enable');
  const routes = ['/reports/sales','/sales','/inventory','/inventory/item-movements',
    '/returns','/patients','/purchases','/reports/purchases','/purchases/suppliers','/accounts','/shifts'];
  const results = [];
  for (const route of routes) {
    // Only route names, never patient names or identifiers, enter diagnostics.
    console.error('QA_SCOPE_ROUTE=' + route);
    const start = Date.now();
    await send('Page.navigate', { url: 'http://tauri.localhost' + route });
    let read = null;
    for (let i = 0; i < 130; i++) {
      await delay(55);
      try {
        read = await evaluate(`(()=>({path:location.pathname,
          h:!!document.querySelector('h1'),spinner:!!document.querySelector('.animate-spin'),
          body:(document.body?.innerText||''),alerts:document.querySelectorAll('[role=alert]').length,
          tableRows:document.querySelectorAll('tbody tr').length}))()`);
      } catch { continue; }
      if (read?.path === route && read.h && !read.spinner && Date.now() - start > 600) break;
    }
    if (!read || read.path !== route) throw Error('Lifecycle page did not reach requested route');
    // Check old profile source identifiers in-memory, not in user-visible logs.
    const oldSaleVisible = privateTargets.saleIds.some(id => read.body.includes(id) || read.body.includes('#' + id.slice(0, 8)));
    const oldPatientVisible = privateTargets.patientNames.some(name => name && read.body.includes(name));
    const oldInventoryVisible = privateTargets.lotBarcodes.some(code => code && read.body.includes(code));
    results.push({ route, elapsedMs: Date.now() - start, heading: read.h,
      remainingSpinner: read.spinner, visibleAlertCount: read.alerts,
      displayedTableRows: read.tableRows,
      legacySaleIdentifierVisible: oldSaleVisible,
      legacyPatientNameVisible: oldPatientVisible,
      legacyInventoryBarcodeVisible: oldInventoryVisible });
  }
  console.log(JSON.stringify({ verifiedNativeOwnerTenant: true, routes: results }, null, 2));
  socket.close();
}

run().catch(error => {
  console.error('LIFECYCLE_READONLY_GUI_ERROR=' + String(error.message || error).slice(0, 130));
  process.exitCode = 1;
});
