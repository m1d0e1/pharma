#!/usr/bin/env node
'use strict';

// Explicitly reviewed read-only GUI behaviors. Avoid generic button clicks:
// source handlers for unknown controls may mutate stock, cash, or permissions.
const fs = require('node:fs');
const path = require('node:path');

const pressedFilters = [
  '/purchase-orders',
  '/stores/delete-items',
  '/inventory/low-stock',
  '/stores/shortages',
  '/shifts',
  '/accounts/cash-transactions',
  '/receipts',
  '/reports',
];

const safeNavigations = [
  { route: '/shifts', href: '/finance/handover' },
  { route: '/inventory/low-stock', href: '/restock' },
  { route: '/staff', href: '/staff/manage' },
  { route: '/stores', href: '/stores/items' },
  { route: '/returns', href: '/returns/new' },
  { route: '/purchases/returns', href: '/purchases/returns/new' },
  { route: '/sales', href: '/sales/cogs' },
];
const safeButtonNavigations = [
  { route:'/pos', label:'تقارير', href:'/reports' },
  { route:'/pos', label:'خيارات', href:'/settings' },
];

const safeSelectOptions = [
  '/shifts', '/audit', '/expenses', '/stores/adjustments',
];

const safeOpeners = [
  { route: '/staff/manage', label: 'إضافة موظف جديد' },
  { route: '/finance/banks', label: 'إضافة حساب بنكي' },
  { route: '/finance/cards', label: 'إضافة ماكينة / كارت' },
  // The POS calculator uses window.open to an EXTERNAL search engine and is
  // deliberately excluded from zero-focus/zero-external-browser acceptance.
  { route: '/pos', label: 'فواتير معلقة' },
  { route: '/pos', label: 'عميل جديد' },
];

const safeValidationRoutes = [
  '/finance/handover', '/stores/adjustments', '/staff/roles',
  '/inventory/opening-balances/new', '/purchases/new', '/returns/new',
  '/purchases/returns/new', '/purchases/general-returns/new',
  '/finance/banks', '/finance/cards', '/settings',
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = rows => {
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
};

async function runBehaviors(client, origin, out, routeInventory, options = {}) {
  const results = [];
  const add = entry => {
    results.push(entry);
    fs.writeFileSync(path.join(out, 'native-behaviors.json'), JSON.stringify({
      mode: 'private-desktop-readonly', counts: summary(results), scenarios: results,
    }, null, 2));
  };
  const selected = new Set(options.routes || routeInventory);
  const covered = new Set(routeInventory);
  const navigate = async route => {
    await client.send('Page.navigate', { url: origin + route });
    for (let attempt = 0; attempt < 55; attempt++) {
      try {
        if (await client.evaluate(`(() => {let main=document.querySelector('main');
          return location.pathname===${JSON.stringify(route)} && main &&
            main.innerText.trim().length>12 &&
            !/^(جاري تحميل|جارٍ تحميل|loading)/i.test(main.innerText.trim());
        })()`)) return true;
      } catch (_) { /* transient hydration */ }
      await sleep(180);
    }
    return false;
  };
  const routeBlocked = route => options.deniedRoutes?.has(route) === true;

  for (const route of pressedFilters) {
    if (!selected.has(route)) continue;
    if (routeBlocked(route)) {
      add({ route, action: 'all aria-pressed filters', status: 'blocked', evidence: 'route denied' });
      continue;
    }
    if (!await navigate(route)) {
      add({ route, action: 'all aria-pressed filters', status: 'untested', evidence: 'page did not mount' });
      continue;
    }
    const labels = await client.evaluate(`[...document.querySelectorAll('main button[aria-pressed]')]
      .filter(b=>b.getClientRects().length && !b.disabled).map(b=>b.innerText.trim())
      .filter(Boolean).slice(0,12)`);
    if (!labels?.length) {
      add({ route, action: 'aria-pressed filters', status: 'unsupported',
        evidence: 'no reviewed accessible pressed-state controls' });
      continue;
    }
    for (const label of labels) {
      // This is safe for the allowlisted pages because their filtering buttons
      // only set local React state; no server/native writes or form submissions.
      const clicked = await client.evaluate(`(() => {
        const b=[...document.querySelectorAll('main button[aria-pressed]')]
          .find(el=>el.innerText.trim()===${JSON.stringify(label)});
        if(!b||b.disabled)return false;b.click();return true;
      })()`);
      await sleep(140);
      const selectedNow = await client.evaluate(`(() => {
        const b=[...document.querySelectorAll('main button[aria-pressed]')]
          .find(el=>el.innerText.trim()===${JSON.stringify(label)});
        return !!b && b.getAttribute('aria-pressed')==='true';
      })()`);
      add({ route, action: 'filter ' + label.slice(0, 64),
        status: clicked && selectedNow ? 'verified' : 'unverified',
        evidence: 'aria-pressed is true after selection' });
    }
    await navigate(route); // reset all view-only filters
  }

  for (const { route, href } of safeNavigations) {
    if (!selected.has(route)) continue;
    if (!covered.has(href) || routeBlocked(route) || !await navigate(route)) {
      add({ route, action: 'navigate ' + href, status: 'blocked',
        evidence: 'source/target not available or route denied' });
      continue;
    }
    const observed = await client.evaluate(`(() => {
      const a=[...document.querySelectorAll('main a[href]')].find(x =>
        x.getAttribute('href')===${JSON.stringify(href)});
      if(!a||!a.getClientRects().length)return false;
      a.click();return true;
    })()`);
    if (!observed) {
      add({ route, action: 'navigate ' + href, status: 'unsupported',
        evidence: 'exact reviewed anchor not visible' });
      continue;
    }
    let arrived = false;
    for (let i = 0; i < 25; i++) {
      await sleep(100);
      arrived = await client.evaluate(`location.pathname===${JSON.stringify(href)}`);
      if (arrived) break;
    }
    add({ route, action: 'navigate ' + href, status: arrived ? 'verified' : 'unverified',
      evidence: 'actual anchor click changed WebView location to exact target' });
    await navigate(route);
  }

  for (const { route, label } of safeOpeners) {
    if (!selected.has(route)) continue;
    if (routeBlocked(route) || !await navigate(route)) {
      add({ route, action: 'open ' + label, status: 'blocked', evidence: 'unavailable route' });
      continue;
    }
    const before = await client.evaluate(`({ forms: document.querySelectorAll('form').length,
      inputs:document.querySelectorAll('input,textarea,select').length,
      dialogs:document.querySelectorAll('[role="dialog"],[aria-modal="true"]').length })`);
    const clicked = await client.evaluate(`(() => {
      const b=[...document.querySelectorAll('button')].find(el=>
        el.getClientRects().length && el.innerText.trim()===${JSON.stringify(label)} &&
        !el.disabled && el.type!=='submit');
      if(!b)return false;b.click();return true;
    })()`);
    if (!clicked) {
      add({ route, action: 'open ' + label, status: 'unsupported',
        evidence: 'reviewed non-submit opener absent/disabled' });
      continue;
    }
    await sleep(350);
    const after = await client.evaluate(`({ forms: document.querySelectorAll('form').length,
      inputs:document.querySelectorAll('input,textarea,select').length,
      dialogs:document.querySelectorAll('[role="dialog"],[aria-modal="true"]').length })`);
    const opened = after.dialogs > before.dialogs || after.forms > before.forms
      || after.inputs >= before.inputs + 2;
    add({ route, action: 'open ' + label,
      status: opened ? 'verified' : 'unverified',
      evidence: 'new dialog/form/input subtree (no submit or data write)',
      before, after });
    await navigate(route); // drop drafts without mutating DB
  }

  for (const { route, label, href } of safeButtonNavigations) {
    if (!selected.has(route)) continue;
    if (!covered.has(href) || routeBlocked(route) || !await navigate(route)) {
      add({route,action:'button navigation '+label,status:'blocked',evidence:'route unavailable'});
      continue;
    }
    const clicked = await client.evaluate(`(() => {
      const b=[...document.querySelectorAll('button')].find(el=>
        el.getClientRects().length && el.innerText.trim()===${JSON.stringify(label)} &&
        !el.disabled && el.type!=='submit');
      if(!b)return false;b.click();return true;
    })()`);
    let navigated=false;
    if (clicked) for(let i=0;i<25;i++) {
      await sleep(120);
      navigated=await client.evaluate(`location.pathname===${JSON.stringify(href)}`);
      if(navigated)break;
    }
    add({route,action:'button navigation '+label,
      status:navigated?'verified':clicked?'unverified':'unsupported',
      evidence:'reviewed navigation handler moved to exact target route'});
  }

  for (const route of safeSelectOptions) {
    if (!selected.has(route)) continue;
    if (routeBlocked(route) || !await navigate(route)) {
      add({route,action:'read-only select options',status:'blocked',evidence:'route unavailable'});
      continue;
    }
    const selects = await client.evaluate(`[...document.querySelectorAll('select')]
      .filter(el=>el.getClientRects().length>0 && !el.disabled)
      .map((el,index)=>({index,aria:el.getAttribute('aria-label')||'',
        options:[...el.options].map(o=>({value:o.value,label:o.text.trim()})).slice(0,10)}))`);
    if (!selects?.length) {
      add({route,action:'read-only select options',status:'unsupported',evidence:'no available reviewed select'});
      continue;
    }
    // Restrict to source-reviewed list filters, never financial destination,
    // handover recipient, permission assignment, or posting form selects.
    const filterSelect = selects.find(s => /تصفية|filter/i.test(s.aria));
    if (!filterSelect || filterSelect.options.length < 2) {
      add({route,action:'read-only select options',status:'unsupported',
        evidence:'no explicitly labelled read-only list filter'});
      continue;
    }
    for (const item of filterSelect.options.slice(1,6)) {
      const result = await client.evaluate(`(() => {
        const select=[...document.querySelectorAll('select')].find(el=>
          el.getAttribute('aria-label')===${JSON.stringify(filterSelect.aria)});
        if(!select)return {present:false};
        const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
        setter.call(select,${JSON.stringify(item.value)});
        select.dispatchEvent(new Event('change',{bubbles:true}));
        return {present:true};
      })()`);
      await sleep(220);
      const state = await client.evaluate(`(() => {
        const s=[...document.querySelectorAll('select')].find(el=>
          el.getAttribute('aria-label')===${JSON.stringify(filterSelect.aria)});
        return s?.value===${JSON.stringify(item.value)};
      })()`);
      add({route,action:'list select '+item.label.slice(0,60),
        status:result?.present && state?'verified':'unverified',
        evidence:'controlled read-only filter select value retained; data change not inferred'});
    }
    await navigate(route);
  }

  for (const route of safeValidationRoutes) {
    if (!selected.has(route)) continue;
    if (routeBlocked(route) || !await navigate(route)) {
      add({ route, action: 'pristine form validity', status: 'blocked', evidence: 'route not available' });
      continue;
    }
    const result = await client.evaluate(`(() => {
      const forms=[...document.querySelectorAll('main form')];
      return forms.map(f=>({valid:f.checkValidity(),
        required:[...f.elements].filter(e=>e.required).length,
        invalid:[...f.elements].filter(e=>e.validity && !e.validity.valid).length}));
    })()`);
    add({ route, action: 'pristine HTML form validation',
      status: result?.some(f => f.required > 0 && !f.valid && f.invalid > 0) ? 'verified' : 'unsupported',
      evidence: 'HTML validity only; business/Zod validation and submission NOT proven',
      forms: result || [] });
  }
  // LicenseBoundary's manage/close controls only change local UI state.
  // Never click activation, renewal, restart, or signed-license submission.
  if (selected.has('/settings')) {
    if (routeBlocked('/settings') || !await navigate('/settings')) {
      add({ route:'/settings', action:'open تجديد الترخيص', status:'blocked',
        evidence:'settings unavailable; no licensing IPC attempted' });
    } else {
      const opened = await client.evaluate(`(() => {
        const buttons=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length);
        const b=buttons.find(b=>b.textContent.trim()==='تجديد الترخيص');
        if(!b || b.disabled) return false;
        b.click();
        return true;
      })()`);
      await sleep(150);
      const presented = await client.evaluate(`(() => {
        return !!document.querySelector('#license-renewal') &&
          !!document.querySelector('button[aria-label="إغلاق تجديد الترخيص"]') &&
          [...document.querySelectorAll('h2')].some(h=>h.textContent.trim()==='تجديد الترخيص الموقع');
      })()`);
      const closed = presented && await client.evaluate(`(() => {
        const b=document.querySelector('button[aria-label="إغلاق تجديد الترخيص"]');
        if(!b)return false;b.click();return true;
      })()`);
      await sleep(100);
      const restored = closed && await client.evaluate(`(() =>
        !document.querySelector('#license-renewal') &&
        [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='تجديد الترخيص')
      )()`);
      add({ route:'/settings', action:'open تجديد الترخيص',
        status:opened && presented && restored ? 'verified' : opened ? 'unverified' : 'unsupported',
        expected:'native license panel appears and closes without any activation/renewal call',
        observed:{opened,presented,restored},
        evidence:'WebView2 open/close native-license UI controls; no credential or submit' });
    }
  }
  return { mode: 'reviewed_nonposting_controls_only', summary: summary(results), scenarios: results };
}

module.exports = { runBehaviors, pressedFilters, safeNavigations, safeButtonNavigations,
  safeSelectOptions, safeOpeners, safeValidationRoutes };
