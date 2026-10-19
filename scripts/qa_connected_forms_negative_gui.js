#!/usr/bin/env node
'use strict';

/**
 * Actual Windows QA WebView2 form interactions, with NO finance/stock submits.
 * A verified owner, tenant, executable and CDP child are mandatory; results
 * contain only booleans and never source/customer/product/receipt text.
 */
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');
const ACTOR = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const pause = ms => new Promise(ok => setTimeout(ok, ms));

function accepted(facts) {
  return facts?.actorTenantVerified === true && facts?.catalogRequiredPriceBlocked === true &&
    facts?.nativeCatalogFormOpened === true && facts?.supplierAmountRequired === true &&
    facts?.supplierDialogClosedNoSubmit === true && facts?.patientFinanceVisible === true &&
    facts?.walletNoAmountSubmitted === true && facts?.returnUnknownNoRefund === true &&
    facts?.noFinancialSubmit === true;
}

async function run(pid, sha, planPath) {
  const plan = verifiedPlan(planPath);
  assertCustody(pid, sha);
  const targets = (await (await fetch('http://127.0.0.1:9334/json/list', {
    signal: AbortSignal.timeout(6000),
  })).json()).filter(t => t.type === 'page');
  const app = targets.filter(t => new URL(t.url).hostname === 'tauri.localhost');
  if (app.length !== 1 || targets.length > 2 ||
      new URL(app[0].webSocketDebuggerUrl).hostname !== '127.0.0.1') {
    throw Error('QA browser identity is ambiguous');
  }
  const ws = new WebSocket(app[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', no, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  ws.addEventListener('message', e => {
    let message; try { message = JSON.parse(e.data); } catch { return; }
    const wait = pending.get(message.id);
    if (!wait) return;
    clearTimeout(wait.timeout); pending.delete(message.id);
    message.error ? wait.no(Error('QA CDP refused request')) : wait.ok(message.result);
  });
  const send = (method, params = {}) => new Promise((ok, no) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); no(Error('QA WebView request timeout')); }, 25000);
    pending.set(id, { ok, no, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error('QA interaction was rejected');
    return r.result?.value;
  };
  const waitFor = async (expression, attempts = 70) => {
    for (let i = 0; i < attempts; i++) {
      try { if (await evaluate(expression)) return true; } catch { /* route settled asynchronously */ }
      await pause(175);
    }
    return false;
  };
  const navigate = async route => {
    assertCustody(pid, sha);
    await send('Page.navigate', { url: 'http://tauri.localhost' + route });
    if (!await waitFor(`location.pathname===${JSON.stringify(route)}&&document.readyState==='complete'`)) {
      throw Error('QA route did not settle');
    }
  };
  const facts = {
    actorTenantVerified: false, nativeCatalogFormOpened: false,
    catalogRequiredPriceBlocked: false, supplierAmountRequired: false,
    supplierDialogClosedNoSubmit: false, patientFinanceVisible: false,
    walletNoAmountSubmitted: false, returnUnknownNoRefund: false,
    noFinancialSubmit: true,
  };
  let step = 'authorize';
  try {
    await send('Runtime.enable'); await send('Page.enable');
    const actor = await evaluate(`(async()=>{
      const a=await window.__TAURI_INTERNALS__.invoke('current_local_user');
      return {id:a?.id,tenant:a?.pharmacy_id,role:a?.role};})()`);
    facts.actorTenantVerified = actor?.id === ACTOR && actor?.tenant === TENANT && actor?.role === 'owner';
    if (!facts.actorTenantVerified) throw Error('Unverified QA owner');

    // Insert hotkey enters genuine inventory modal, then opens QuickAdd.
    // Never submit a catalog creation or inventory lot in this probe.
    step = 'catalog_validation';
    await navigate('/inventory');
    const inventoryReady = await waitFor(`!!document.querySelector('table')`, 80);
    if (!inventoryReady) throw Error('Inventory table not ready');
    await evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',
      {key:'Insert',code:'Insert',keyCode:45,which:45,bubbles:true}));return true})()`);
    const addReady = await waitFor(`!!document.querySelector('[role="dialog"][aria-labelledby="add-inventory-title"]')`);
    if (addReady) {
      await evaluate(`(()=>{
        const root=document.querySelector('[role="dialog"][aria-labelledby="add-inventory-title"]');
        const btn=[...root.querySelectorAll('button')].find(b=>b.textContent?.includes('إضافة صنف مخصص'));
        if(!btn)return false;btn.click();return true;})()`);
      facts.nativeCatalogFormOpened = await waitFor(`!!document.querySelector('[role="dialog"][aria-labelledby="quick-add-drug-title"]')`);
      if (facts.nativeCatalogFormOpened) {
        facts.catalogRequiredPriceBlocked = await evaluate(`(()=>{
          const root=document.querySelector('[role="dialog"][aria-labelledby="quick-add-drug-title"]');
          const price=root?.querySelector('#quick-drug-price');
          const name=root?.querySelector('#quick-drug-name-ar');
          const form=root?.querySelector('form');
          return !!price && !!name && !!form && price.required === true &&
            price.value === '' && price.checkValidity()===false && form.checkValidity()===false;
        })()`);
      }
    }

    // Legitimate supplier-payment form: do not click financial submit.
    step = 'supplier_invalid_amount';
    await navigate('/purchases/suppliers');
    const supplierReady = await waitFor(`[...document.querySelectorAll('button')]
      .some(b=>b.textContent?.trim()==='سداد دفعة'&&!b.disabled)`, 85);
    if (supplierReady) {
      await evaluate(`(()=>{const b=[...document.querySelectorAll('button')]
        .find(b=>b.textContent?.trim()==='سداد دفعة'&&!b.disabled);if(!b)return false;b.click();return true})()`);
      const dialog = await waitFor(`!!document.querySelector('[role="dialog"][aria-labelledby="supplier-payment-title"]')`, 70);
      if (dialog) {
        facts.supplierAmountRequired = await evaluate(`(()=>{
          const root=document.querySelector('[role="dialog"][aria-labelledby="supplier-payment-title"]');
          const field=root?.querySelector('#supplier-payment-amount');
          const form=root?.querySelector('form');
          if(!field||!form||field.disabled)return false;
          const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
          setter.call(field,'');field.dispatchEvent(new Event('input',{bubbles:true}));
          return field.required===true&&field.checkValidity()===false;
        })()`);
        facts.supplierDialogClosedNoSubmit = await evaluate(`(()=>{
          const b=document.querySelector('button[aria-label="إغلاق سداد المورد"]');
          if(!b||b.disabled)return false;b.click();
          return true;
        })()`);
      }
    }

    // Open the independently witnessed synthetic QA patient's finance tab.
    // No wallet top-up or credit-payment button is ever clicked.
    step = 'patient_finance_no_money';
    await navigate('/patients');
    if (!await waitFor(`!!document.querySelector('button[aria-label^="تعديل بيانات المريض"]')`, 85)) {
      throw Error('Native QA patient directory unavailable');
    }
    const opened = await evaluate(`(()=>{
      const card=[...document.querySelectorAll('div.group')].find(x=>
        x.querySelector('h3')?.textContent===${JSON.stringify(plan.patientName)});
      const button=card?.querySelector('button[aria-label^="تعديل بيانات المريض"]');
      if(!button)return false;button.click();return true;
    })()`);
    if (opened && await waitFor(`!!document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]')`, 90)) {
      await evaluate(`(()=>{const root=document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]');
        const b=[...root.querySelectorAll('button')].find(x=>x.textContent?.trim()==='المالية والتأمين');
        if(!b||b.disabled)return false;b.click();return true})()`);
      facts.patientFinanceVisible = await waitFor(`!!document.querySelector('#topup-amount')`, 80);
      facts.walletNoAmountSubmitted = facts.patientFinanceVisible && await evaluate(`(()=>{
        const root=document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]');
        const field=root?.querySelector('#topup-amount');
        return !!field && field.value === '';
      })()`);
    }

    // Search unmatched return history; no refund form or money button clicked.
    step = 'unknown_return_search';
    await navigate('/returns');
    const ready = await waitFor(`!!document.querySelector('input[aria-label="بحث في سجل المرتجعات"]')`, 70);
    if (ready) {
      await evaluate(`(()=>{
        const input=document.querySelector('input[aria-label="بحث في سجل المرتجعات"]');
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        setter.call(input,'QA_UNMATCHED_NONPOSTING_2026');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        return true;
      })()`);
      facts.returnUnknownNoRefund = await waitFor(`(()=>{
        const x=document.querySelector('input[aria-label="بحث في سجل المرتجعات"]');
        const parent=x?.closest('.space-y-6');
        return !!x && !!parent && !parent.querySelector('[role="dialog"]')
          && [...parent.querySelectorAll('h3')].some(h=>h.textContent?.trim()==='لا توجد نتائج');
      })()`, 90);
    }
    console.log('PINNED_QA_CONNECTED_NEGATIVE_FORMS='+JSON.stringify(facts));
    if (!accepted(facts)) process.exitCode = 2;
  } catch {
    console.error('PINNED_QA_CONNECTED_NEGATIVE_BLOCKED_STAGE='+step);
    process.exitCode = 2;
  } finally {
    ws.close();
  }
}

if (require.main === module) {
  const pid = Number(process.argv[2]);
  const sha = String(process.argv[3] || '').toUpperCase();
  run(pid, sha, String(process.argv[4] || '')).catch(() => {
    console.error('PINNED_QA_CONNECTED_NEGATIVE_FORMS=BLOCKED_NO_FINANCIAL_SUBMISSION');
    process.exitCode = 2;
  });
}
module.exports = { accepted };
