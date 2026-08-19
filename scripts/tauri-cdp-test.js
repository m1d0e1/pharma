#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const port = Number(portArg?.split('=')[1] || 9333);
const businessOnly = process.argv.includes('--business-only');
const root = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exportedRoutes() {
  const output = path.join(root, 'out');
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.html')) files.push(absolute);
    }
  };
  visit(output);
  return files
    .map((file) => {
      const relative = path.relative(output, file).replaceAll('\\', '/');
      if (relative === 'index.html') return '/';
      return `/${relative.slice(0, -'.html'.length)}`;
    })
    .filter((route) => !['/404', '/login', '/setup', '/subscription', '/unauthorized'].includes(route))
    .sort();
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const result = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
      } catch (error) {
        if (!/context|Inspected target navigated|Cannot find/i.test(String(error)) || attempt === 19) throw error;
        await sleep(100);
      }
    }
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(client, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await client.evaluate(expression)) return;
    } catch (_) {
      // A navigation can briefly destroy the execution context.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function submitLogin(client, username, password) {
  const fill = async (index, value) => {
    await client.evaluate(`document.querySelectorAll('input')[${index}].focus()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
    });
    await client.send('Input.insertText', { text: value });
  };
  await fill(0, username);
  await fill(1, password);
  const point = await client.evaluate(`(() => {
    const rect = document.querySelector('form button').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...point, button: 'left', clickCount: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', ...point, button: 'left', clickCount: 1,
  });
}

async function runPackagedBusinessFlow(client) {
  return client.evaluate(`(async () => {
    try {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const db = await invoke('plugin:sql|load', { db: 'sqlite:pharma_local.db' });
    const select = (query, values = []) => invoke('plugin:sql|select', { db, query, values });
    const write = (sql, params = []) => invoke('db_execute_guarded', { sql, params });
    const stamp = Date.now();
    const pharmacyId = 'codex-e2e-pharmacy';
    const supplierId = 910001;
    const shiftId = 'codex-e2e-shift-' + stamp;
    const purchaseId = 'codex-e2e-purchase-' + stamp;

    await write("UPDATE users SET pharmacy_id = ? WHERE id = 'admin'", [pharmacyId]);
    await write(
      'INSERT OR IGNORE INTO suppliers (id, name_ar, balance) VALUES (?, ?, 0)',
      [supplierId, 'Codex E2E Supplier']
    );
    await write(
      "UPDATE shifts SET status = 'closed', end_time = datetime('now') WHERE user_id = 'admin' AND status = 'open'"
    );
    await write(
      "INSERT INTO shifts (id, user_id, starting_cash, status) VALUES (?, 'admin', 500, 'open')",
      [shiftId]
    );
    const [drug] = await select(
      'SELECT id, trade_name, official_price FROM master_drugs WHERE id = 1'
    );
    if (!drug) throw new Error('Seed master drug id 1 is missing');

    const purchase = await invoke('save_purchase_invoice_critical', {
      payload: {
        id: purchaseId,
        supplier_id: supplierId,
        pharmacy_id: pharmacyId,
        user_id: 'admin',
        invoice_number: 'CODEX-' + stamp,
        invoice_date: '2026-08-18',
        payment_method: 'cash',
        notes: 'packaged CDP business test',
        check_number: null,
        expenses: 2,
        discount_value: 1,
        discount_percent: 2,
        tax_percent: 5,
        status: 'completed',
        cart: [{
          purchase_invoice_item_id: null,
          id: drug.id,
          quantity: 2,
          unit_id: 1,
          expiry_date: '2030-12-31',
          cost_price: 10,
          selling_price: 15,
          bonus_quantity: 0,
          tax_percent: 5,
          discount_percent: 0,
          strips_per_box: 1,
          barcode: 'CODEX-' + stamp
        }]
      }
    });
    const [inventory] = await select(
      'SELECT id, quantity FROM inventory WHERE batch_number = ? AND pharmacy_id = ?',
      ['CODEX-' + stamp, pharmacyId]
    );
    if (!inventory) throw new Error('Completed purchase did not create inventory');

    const checkoutPayload = {
      pharmacy_id: pharmacyId,
      user_id: 'admin',
      items: [{
        drug_id: drug.id,
        inventory_id: inventory.id,
        quantity_sold: 1,
        unit_price: 15,
        selected_unit: 'large',
        is_negative: false
      }],
      patient_id: null,
      shift_id: shiftId,
      payment_method: 'cash',
      check_number: null,
      status: 'completed',
      total_discount: 0,
      additional_fees: 0
    };
    const sale = await invoke('process_checkout_critical', { payload: checkoutPayload });
    const [saleItem] = await select(
      'SELECT id, inventory_id, drug_id, quantity_sold, unit_price FROM sales_items WHERE invoice_id = ?',
      [sale.sale_id]
    );
    if (!saleItem) throw new Error('Checkout did not create a sale item');

    const returnPayload = {
      invoice_id: sale.sale_id,
      user_id: 'admin',
      pharmacy_id: pharmacyId,
      shift_id: shiftId,
      refund_method: 'cash',
      reason: 'packaged regression test',
      patient_id: null,
      items: [{
        sale_item_id: saleItem.id,
        inventory_id: saleItem.inventory_id,
        drug_name: drug.trade_name,
        quantity: 1,
        unit_price: saleItem.unit_price,
        unit: 'large'
      }]
    };
    const returned = await invoke('create_return_critical', { payload: returnPayload });
    const duplicateReturnRejected = await invoke('create_return_critical', {
      payload: returnPayload
    }).then(() => false, () => true);
    const wrongPharmacyRejected = await invoke('process_checkout_critical', {
      payload: { ...checkoutPayload, pharmacy_id: 'wrong-pharmacy' }
    }).then(() => false, () => true);

    const [stock] = await select('SELECT quantity FROM inventory WHERE id = ?', [inventory.id]);
    const [supplier] = await select('SELECT balance FROM suppliers WHERE id = ?', [supplierId]);
    const [supplierHistory] = await select(
      'SELECT COUNT(*) AS rows, COALESCE(SUM(amount), 0) AS net FROM supplier_transactions WHERE reference_id = ?',
      [purchaseId]
    );
    const [cash] = await select(
      'SELECT COUNT(*) AS rows, COALESCE(SUM(amount), 0) AS total FROM cash_movements WHERE shift_id = ?',
      [shiftId]
    );
    const [unbalanced] = await select(
      "SELECT COUNT(*) AS rows FROM (SELECT journal_id FROM journal_entries GROUP BY journal_id HAVING ABS(SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END)) > 0.001)"
    );
    const audits = await select(
      'SELECT action FROM activity_log WHERE details LIKE ? OR details LIKE ? OR details LIKE ?',
      ['%' + purchaseId + '%', '%' + sale.sale_id + '%', '%' + returned.return_id + '%']
    );
    return {
      stamp, pharmacyId, shiftId, purchaseId, purchase, sale, returned,
      duplicateReturnRejected, wrongPharmacyRejected,
      stockQuantity: Number(stock.quantity),
      supplierBalance: Number(supplier.balance),
      supplierHistoryRows: Number(supplierHistory.rows),
      supplierHistoryNet: Number(supplierHistory.net),
      cashMovementRows: Number(cash.rows),
      cashMovementTotal: Number(cash.total),
      unbalancedJournals: Number(unbalanced.rows),
      auditActions: audits.map(row => row.action).sort()
    };
    } catch (error) {
      return { __error: String(error), stack: error?.stack };
    }
  })()`);
}

async function main() {
  const failures = [];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page');
  assert(target, 'No WebView2 page target was exposed');

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable');

  await client.send('Page.navigate', { url: 'http://tauri.localhost/login' });
  await waitFor(client, `location.pathname === '/login' && document.readyState === 'complete'`);
  await client.evaluate(`localStorage.removeItem('pharma_session_user')`);
  await client.send('Page.reload');
  await waitFor(client, `location.pathname === '/login' && document.readyState === 'complete'`);
  await waitFor(client, `document.querySelectorAll('input').length === 2`);

  const initial = await client.evaluate(`({
    href: location.href,
    title: document.title,
    ready: document.readyState,
    inputs: [...document.querySelectorAll('input')].map((input) => input.type),
    buttons: [...document.querySelectorAll('button')].map((button) => button.textContent.trim())
  })`);
  console.log(`INFO initial ${JSON.stringify(initial)}`);
  assert(new URL(initial.href).pathname === '/login', `Expected /login, got ${initial.href}`);
  assert(initial.ready === 'complete', 'Login document did not finish loading');
  assert(initial.inputs.join(',') === 'text,password', 'Login inputs are not wired as username/password');
  assert(initial.buttons.length >= 2, 'Login and initial-sync controls were not rendered');
  console.log('PASS login-render');

  if (!businessOnly) {
    await submitLogin(client, 'missing-user', 'invalid-password');
    await sleep(1000);
    const missingUserState = await client.evaluate(`({ values: [...document.querySelectorAll('input')].map((input) => input.value), disabled: [...document.querySelectorAll('button')].map((button) => button.disabled), body: document.body.innerText })`);
    const missingUserEvents = client.events.slice(-20).map((event) => ({
      method: event.method,
      text: event.params?.entry?.text || event.params?.exceptionDetails?.exception?.description,
      args: event.params?.args?.map((arg) => arg.value || arg.description),
    }));
    if (missingUserState.body.includes('المستخدم غير موجود محلياً')) {
      console.log('PASS missing-user-error');
    } else {
      failures.push('Missing-user login returned an unexpected error because the audit insert violated a foreign key');
      console.log(`FAIL missing-user-error ${JSON.stringify({ state: missingUserState, events: missingUserEvents })}`);
    }

    await submitLogin(client, 'admin', 'incorrect-password');
    await waitFor(client, `document.body.innerText.includes('كلمة المرور غير صحيحة')`);
    console.log('PASS wrong-password-error');
  }

  await submitLogin(client, 'admin', 'admin');
  await waitFor(client, `location.pathname === '/' && document.readyState === 'complete'`, 20000);
  await sleep(1500);
  const dashboard = await client.evaluate(`({
    pathname: location.pathname,
    title: document.title,
    session: JSON.parse(localStorage.getItem('pharma_session_user') || 'null'),
    tauri: !!window.__TAURI_INTERNALS__,
    bodyLength: document.body.innerText.length,
    buttons: document.querySelectorAll('button').length,
    links: document.querySelectorAll('a').length
  })`);
  assert(dashboard.session?.username === 'admin', 'Successful login did not persist the admin session');
  assert(dashboard.tauri, 'Packaged dashboard does not expose the Tauri IPC runtime');
  assert(dashboard.bodyLength > 100, 'Dashboard content did not render');
  console.log(`PASS login-dashboard ${JSON.stringify(dashboard)}`);

  const ipc = await client.evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const result = {};
    result.schema = await invoke('ensure_schema_compatibility').then(() => 'ok', (error) => String(error));
    result.bcryptTrue = await invoke('bcrypt_compare', {
      password: 'admin',
      hash: '$2b$12$.FYM9XhLwanE5PdySaxB2uMwZwwLpF9fI6HXf/2XArluRQt0kfvVm'
    });
    result.bcryptFalse = await invoke('bcrypt_compare', {
      password: 'wrong',
      hash: '$2b$12$.FYM9XhLwanE5PdySaxB2uMwZwwLpF9fI6HXf/2XArluRQt0kfvVm'
    });
    result.readRejected = await invoke('db_execute_guarded', {
      sql: 'SELECT * FROM users', params: []
    }).then(() => false, () => true);
    result.fileRejected = await invoke('write_binary_file', {
      path: 'D:/PhD/Tools/pharma/src-tauri/target/forbidden-smoke.txt', data: [1, 2, 3]
    }).then(() => false, () => true);
    result.invalidCheckoutRejected = await invoke('process_checkout_critical', {
      request: {}
    }).then(() => false, () => true);
    return result;
  })()`);
  assert(ipc.schema === 'ok', `Schema compatibility command failed: ${ipc.schema}`);
  assert(ipc.bcryptTrue === true && ipc.bcryptFalse === false, 'Packaged bcrypt IPC produced incorrect results');
  assert(ipc.readRejected, 'Guarded write command accepted a SELECT statement');
  assert(ipc.fileRejected, 'Binary writer accepted a non-XLSX path');
  assert(ipc.invalidCheckoutRejected, 'Critical checkout accepted an empty payload');
  console.log(`PASS packaged-ipc-boundaries ${JSON.stringify(ipc)}`);

  if (businessOnly) {
    const business = await runPackagedBusinessFlow(client);
    assert(!business.__error, `Packaged business flow failed: ${business.__error}\n${business.stack || ''}`);
    console.log(`INFO packaged-business-flow ${JSON.stringify(business)}`);
    assert(business.purchase.total_amount > 0, 'Purchase total was not positive');
    assert(business.sale.total_amount === 15, `Unexpected checkout total: ${business.sale.total_amount}`);
    assert(business.returned.total_refund === 15, `Unexpected return total: ${business.returned.total_refund}`);
    assert(business.stockQuantity === 2, `Purchase/sale/return stock did not reconcile: ${business.stockQuantity}`);
    assert(business.supplierBalance === 0, `Cash purchase changed supplier balance: ${business.supplierBalance}`);
    assert(business.supplierHistoryRows === 2 && Math.abs(business.supplierHistoryNet) < 0.001, 'Supplier invoice/payment history did not net to zero');
    assert(business.cashMovementRows === 1, `Expected one purchase cash movement, got ${business.cashMovementRows}`);
    assert(Math.abs(business.cashMovementTotal - business.purchase.total_amount) < 0.001, 'Purchase cash movement did not match its committed total');
    assert(business.unbalancedJournals === 0, 'Packaged workflow created an unbalanced journal');
    assert(business.duplicateReturnRejected, 'Duplicate cumulative return was accepted');
    assert(business.wrongPharmacyRejected, 'Cross-pharmacy checkout was accepted');
    assert(
      ['COMPLETE_PURCHASE', 'COMPLETE_SALE', 'CREATE_RETURN'].every(action => business.auditActions.includes(action)),
      `Packaged critical audit trail is incomplete: ${business.auditActions.join(', ')}`
    );
    console.log(`PASS packaged-business-flow ${JSON.stringify(business)}`);
    client.close();
    return;
  }

  const routeResults = [];
  for (const route of exportedRoutes()) {
    const eventStart = client.events.length;
    await client.send('Page.navigate', { url: `http://tauri.localhost${route}` });
    await waitFor(client, `location.pathname === ${JSON.stringify(route)} && document.readyState === 'complete'`, 15000);
    await sleep(900);
    const readRouteState = () => client.evaluate(`({
      route: location.pathname,
      title: document.title,
      bodyLength: document.body.innerText.length,
      bodySample: document.body.innerText.slice(0, 160),
      controls: document.querySelectorAll('button,input,select,textarea,a').length,
      session: !!localStorage.getItem('pharma_session_user'),
      fatal: /ChunkLoadError|Application error|Unhandled Runtime Error/i.test(document.body.innerText)
    })`);
    let state = await readRouteState();
    if (state.bodyLength < 100 || state.controls === 0) {
      await sleep(2500);
      state = await readRouteState();
    }
    state.requestedRoute = route;
    state.redirected = state.route !== route;
    const newEvents = client.events.slice(eventStart);
    const exceptions = newEvents.filter((event) => event.method === 'Runtime.exceptionThrown');
    state.exceptions = exceptions.map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    assert(state.session, `${route} lost the authenticated session`);
    assert(state.bodyLength > 20, `${route} rendered no meaningful content`);
    assert(state.bodyLength > 40 || state.controls > 0, `${route} remained stuck in a loading/guard state: ${state.bodySample}`);
    assert(!state.fatal, `${route} rendered a fatal error`);
    assert(state.exceptions.length === 0, `${route} raised runtime exceptions: ${state.exceptions.join('; ')}`);
    if (route === '/stores/delete-items') {
      assert(state.controls < 300, `Delete-items mounted an unbounded catalogue DOM: ${state.controls} controls`);
    }
    routeResults.push(state);
    console.log(`PASS route ${route} body=${state.bodyLength} controls=${state.controls}`);
  }

  const summary = {
    initial,
    dashboard,
    ipc,
    routesPassed: routeResults.length,
    routes: routeResults,
    runtimeExceptions: client.events.filter((event) => event.method === 'Runtime.exceptionThrown').length,
    failures,
  };
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  client.close();
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
