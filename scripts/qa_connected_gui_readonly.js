#!/usr/bin/env node
'use strict';

// Real Windows WebView2 business-UI checks with no monetary mutations.
// Print only aggregate pass/fail booleans; never log patient or sale details.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACTOR = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const SHA_RE = /^[A-F0-9]{64}$/;

function assertCustody(pid, sha) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 100 || !SHA_RE.test(sha)) {
    throw Error('Windows SHA-pinned QA process required');
  }
  const ps = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + `if(!$p -or $p.ExecutablePath -notlike '*pharma-builds\\optimized-offline-qa-20261016\\Pharma-0.2.109-optimized-offline-QA-*.exe'){exit 2};`
    + `if((Get-FileHash -LiteralPath $p.ExecutablePath -Algorithm SHA256).Hash -ne '${sha}'){exit 3};`
    + '$l=@(Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction Stop);'
    + `if($l.Count -ne 1 -or $l[0].LocalAddress -ne '127.0.0.1'){exit 4};`
    + '$w=Get-CimInstance Win32_Process -Filter "ProcessId=$($l[0].OwningProcess)";'
    + `if(!$w -or $w.Name -ne 'msedgewebview2.exe' -or $w.ParentProcessId -ne ${pid}){exit 5};`
    + 'Write-Output "PINNED_QA"';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 12000,
  });
  if (r.status !== 0 || !r.stdout.includes('PINNED_QA')) throw Error('QA process/WebView custody changed');
}

function verifiedPlan(file) {
  const absolute = path.resolve(file);
  if (!absolute.toLowerCase().startsWith(os.tmpdir().toLowerCase() + path.sep)
      || !absolute.includes('pharma-qa-stagea-') || path.basename(absolute) !== 'qa-plan.json') {
    throw Error('Only independently witnessed Stage A plan is accepted');
  }
  const plan = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (plan.actorId !== ACTOR || plan.tenantId !== TENANT || plan.qaDataOnly !== true
      || plan.identity !== 'com.pharma.disposable.lifecycle.qa20261016'
      || !/^QA Patient PhaseTwo [a-f0-9]{12}$/.test(plan.patientName)) {
    throw Error('Expected witnessed synthetic patient plan');
  }
  return plan;
}

function verifiedBlankPosCountState(state) {
  return state?.realPosRoute === true && state?.handoverDialogVisible === true &&
    state?.handoverFormVisible === true && state?.countBlank === true &&
    state?.countExplicitlyRequired === true && state?.blankCountInvalid === true &&
    state?.loadingDenied === false && state?.noFinancialSubmitClicked === true &&
    state?.dialogDismissedWithoutSubmitting === true;
}

function verifiedNativeCogsDeniedState(state) {
  return state?.realCogsRoute === true && state?.sourceUnavailableNotice === true &&
    state?.searchFieldDisabled === true && state?.searchButtonDisabled === true &&
    state?.noCostWriteControls === true && state?.financialMutation === false;
}

function verifiedNativeStockAdjustmentState(state) {
  return state?.realRoute === true && state?.nativeOwnedLotRead === true &&
    state?.nativeReasonRead === true && state?.nativeAdjustmentLotRead === true &&
    state?.reasonsVisible === true && state?.searchFormVisible === true &&
    state?.selectedLotUnchanged === true && state?.noStockWriteClicked === true &&
    state?.financialMutation === false;
}

async function run(pid, sha, planPath, alertsOnly = false, posStateOnly = false, purchaseStateOnly = false, purchaseCostOnly = false, offlineReadOnly = false, settlementReadOnly = false, handoverCountOnly = false, posHandoverCountOnly = false, cogsDeniedOnly = false, stockAdjustmentReadOnly = false) {
  const plan = verifiedPlan(planPath);
  assertCustody(pid, sha);
  const targets = (await (await fetch('http://127.0.0.1:9334/json/list', {
    signal: AbortSignal.timeout(5000),
  })).json()).filter(t => t.type === 'page');
  const app = targets.filter(t => new URL(t.url).hostname === 'tauri.localhost');
  const hubs = targets.filter(t => new URL(t.url).hostname === 'downloads-hub');
  if (app.length !== 1 || hubs.length > 1 || targets.length !== app.length + hubs.length
      || new URL(app[0].webSocketDebuggerUrl).hostname !== '127.0.0.1') {
    throw Error('QA WebView target ambiguity');
  }
  const ws = new WebSocket(app[0].webSocketDebuggerUrl);
  await new Promise((yes, no) => {
    ws.addEventListener('open', yes, { once: true });
    ws.addEventListener('error', no, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    let answer;
    try { answer = JSON.parse(event.data); } catch { return; }
    const task = pending.get(answer.id);
    if (!task) return;
    pending.delete(answer.id);
    clearTimeout(task.timer);
    answer.error ? task.no(Error('CDP operation rejected')) : task.yes(answer.result);
  });
  const send = (method, params = {}) => new Promise((yes, no) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); no(Error('CDP timeout')); }, 25000);
    pending.set(id, { yes, no, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalPage = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error('Read-only DOM verification failed');
    return r.result?.value;
  };
  const waitFor = async (expression, attempts = 70) => {
    for (let i = 0; i < attempts; i++) {
      await pause(150);
      try { if (await evalPage(expression)) return true; } catch { /* transient navigation context */ }
    }
    return false;
  };
  const navigate = async route => {
    assertCustody(pid, sha);
    await send('Page.navigate', { url: 'http://tauri.localhost' + route });
    if (!await waitFor(`location.pathname===${JSON.stringify(route)}&&document.readyState==='complete'`)) {
      throw Error('QA route navigation did not settle');
    }
  };
  const facts = {
    ownerTenantAuthenticated: false, returnSearchMatchesOwnedSale: false,
    returnItemDetailsResolved: false, returnQuantityStartsZero: false,
    partiallyReturnedSaleCapsQuantity: false,
    partialReturnRefundPreviewMatchesReceipt: false,
    negativeUnknownReturnSearchEmpty: false, patientWalletFiveVisible: false,
    patientProfileOpens: false, financeTabAccessible: false,
    posPatientSelectionVerified: false, posWalletBalanceFiveVerified: false,
    posEmptyCartCheckoutDisabled: false,
    shiftRemainsOpen: false, trialBalanceScreen: false,
    nativeTrialBalanceExactCents: false, nativeCashExcludesBankSettlement: false,
    nativeInventoryAlertsOwned: false, headerAlertsMatchNative: false,
    financialMutation: false,
  };
  let sanitizedStage = 'native_actor';
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    const actor = await evalPage(`(async()=>{const a=await window.__TAURI_INTERNALS__.invoke('current_local_user');return {id:a?.id,tenant:a?.pharmacy_id,role:a?.role};})()`);
    facts.ownerTenantAuthenticated = actor?.id === ACTOR && actor?.tenant === TENANT && actor?.role === 'owner';
    if (!facts.ownerTenantAuthenticated) throw Error('QA owner/tenant not authenticated');

    if (stockAdjustmentReadOnly) {
      sanitizedStage = 'stock_adjustment_native_source_and_unsaved_form';
      await navigate('/stores/adjustments');
      const formReady = await waitFor(`!!document.querySelector('input[aria-label="البحث عن صنف لتسوية المخزون"]')
        && document.querySelectorAll('#adjustment-reason option').length>1`, 90);
      const native = await evalPage(`(async()=>{
        const invoke=window.__TAURI_INTERNALS__?.invoke;
        if(!invoke)return {owned:false,reasons:false,lot:false};
        const read=(queryId,search,limit)=>invoke('db_read_scoped',{
          queryId,recordId:null,search,drugId:null,limit,offset:0});
        const owned=await invoke('db_read_scoped',{
          queryId:'inventory.enriched',recordId:null,search:null,drugId:null,limit:200,offset:0});
        const source=Array.isArray(owned)&&owned.length===1?owned[0]:null;
        const name=source?.trade_name_en||source?.trade_name;
        if(!source||typeof name!=='string'||name.trim().length<3)return {owned:false,reasons:false,lot:false};
        const term=name.trim().slice(0,Math.min(5,name.trim().length));
        const reasons=await read('inventory.adjustment_reasons',null,100);
        const lots=await read('inventory.adjustment_lots',term,20);
        const matched=Array.isArray(lots)&&lots.find(x=>x.id===source.id&&x.quantity===source.quantity);
        return {owned:true,reasons:Array.isArray(reasons)&&reasons.length===4,
          lot:!!matched,quantity:matched?.quantity,term};
      })()`);
      const typed = native?.lot && await evalPage(`(()=>{
        const field=document.querySelector('input[aria-label="البحث عن صنف لتسوية المخزون"]');
        if(!field)return false;
        const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(!set)return false;
        set.call(field,${JSON.stringify(native?.term || '')});
        field.dispatchEvent(new Event('input',{bubbles:true}));
        return true;
      })()`);
      const optionReady = !!typed && await waitFor(`(()=>{
        const field=document.querySelector('input[aria-label="البحث عن صنف لتسوية المخزون"]');
        return !!field?.parentElement?.querySelector('button');
      })()`, 70);
      const selection = optionReady && await evalPage(`(()=>{
        const field=document.querySelector('input[aria-label="البحث عن صنف لتسوية المخزون"]');
        const option=field?.parentElement?.querySelector('button');
        if(!option)return false;option.click();return true;
      })()`);
      const selectedReady = !!selection && await waitFor(`(()=>{
        const qty=document.querySelector('#adjustment-new-quantity');
        return !!qty&&qty.value!==''&&Number(qty.value)===${Number.isFinite(native?.quantity) ? native.quantity : -1}
          &&!!document.querySelector('#adjustment-reason');
      })()`, 65);
      const state = {
        realRoute: true, nativeOwnedLotRead: native?.owned===true,
        nativeReasonRead: native?.reasons===true, nativeAdjustmentLotRead: native?.lot===true,
        reasonsVisible: formReady, searchFormVisible: !!typed,
        selectedLotUnchanged: !!selectedReady,
        noStockWriteClicked: true, financialMutation: false,
      };
      console.log('PINNED_QA_STOCK_ADJUSTMENT_UNSUBMITTED='+JSON.stringify({
        ...state,actorTenantVerified:facts.ownerTenantAuthenticated,
      }));
      if (!verifiedNativeStockAdjustmentState(state)) process.exitCode = 2;
      return;
    }

    if (cogsDeniedOnly) {
      sanitizedStage = 'cogs_native_missing_additive_provenance';
      await navigate('/sales/cogs');
      const settled = await waitFor(`!!document.querySelector('input[aria-label="بحث باسم الصنف أو رقم الفاتورة"]')`, 90);
      const state = await evalPage(`(()=>{
        const notice=[...document.querySelectorAll('[role="alert"]')].find(n=>
          n.textContent?.includes('لا يجوز إعادة كتابة تكلفة سطر بيع أو مرتجع'));
        const search=document.querySelector('input[aria-label="بحث باسم الصنف أو رقم الفاتورة"]');
        const buttons=[...document.querySelectorAll('button')];
        const submit=buttons.filter(b=>b.textContent?.trim()==='بحث');
        const save=buttons.filter(b=>b.getAttribute('aria-label')?.startsWith('حفظ تكلفة'));
        return {realCogsRoute:location.pathname==='/sales/cogs',
          sourceUnavailableNotice:!!notice&&notice.textContent?.includes('قيد مستقل'),
          searchFieldDisabled:search?.disabled===true,
          searchButtonDisabled:submit.length===1&&submit[0].disabled===true,
          noCostWriteControls:save.length===0,financialMutation:false};
      })()`);
      console.log('PINNED_QA_COGS_NO_UNRECEIPTED_WRITE='+JSON.stringify({
        ...state,readSettled:settled,actorTenantVerified:facts.ownerTenantAuthenticated,
      }));
      if (!settled || !verifiedNativeCogsDeniedState(state)) process.exitCode=2;
      return;
    }

    if (posHandoverCountOnly) {
      sanitizedStage = 'pos_handover_blank_count_real_webview';
      await navigate('/pos');
      const openSelector = `(()=>{
        const buttons=[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='تسليم الدرج');
        return buttons.length===1&&!buttons[0].disabled;
      })()`;
      if (!await waitFor(openSelector, 90)) throw Error('POS handover entry not ready');
      const opened = await evalPage(`(()=>{
        const buttons=[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='تسليم الدرج');
        if(buttons.length!==1||buttons[0].disabled)return false;
        buttons[0].click();return true;
      })()`);
      if (!opened) throw Error('POS handover entry unavailable');
      const ready = await waitFor(`(()=>{
        const dialog=document.querySelector('[role="dialog"][aria-labelledby="pos-handover-title"]');
        return !!dialog&&(!!dialog.querySelector('#handover-actual-cash')||
          !!dialog.querySelector('[role="alert"]'));
      })()`, 90);
      const state = await evalPage(`(()=>{
        const dialog=document.querySelector('[role="dialog"][aria-labelledby="pos-handover-title"]');
        const input=dialog?.querySelector('#handover-actual-cash');
        const form=input?.closest('form');
        return {realPosRoute:location.pathname==='/pos',handoverDialogVisible:!!dialog,
          handoverFormVisible:!!form&&form.querySelector('button[type="submit"]')!==null,
          countBlank:input?.value==='',countExplicitlyRequired:input?.required===true&&
            input?.getAttribute('aria-required')==='true',
          blankCountInvalid:input?.validity?.valueMissing===true&&input?.checkValidity()===false,
          loadingDenied:!!dialog?.querySelector('[role="alert"]'),
          noFinancialSubmitClicked:true};
      })()`);
      // Close only the read-only modal. Never touch its submit control or
      // synthesize an operator cash count in a QA probe.
      let dismissed = false;
      if (state?.handoverDialogVisible) {
        const closeClicked = await evalPage(`(()=>{const dialog=document.querySelector('[role="dialog"][aria-labelledby="pos-handover-title"]');
          const close=dialog?.querySelector('button[aria-label="إغلاق تسليم الدرج"]');
          if(!close||close.disabled)return false;close.click();return true;})()`);
        dismissed = closeClicked === true && await waitFor(
          `!document.querySelector('[role="dialog"][aria-labelledby="pos-handover-title"]')`, 35);
      }
      state.dialogDismissedWithoutSubmitting = dismissed;
      const accepted = ready && verifiedBlankPosCountState(state);
      console.log('PINNED_QA_POS_PHYSICAL_COUNT_UNSUBMITTED='+JSON.stringify({
        ...state,readSettled:ready,actorTenantVerified:facts.ownerTenantAuthenticated,
        financialMutation:false,
      }));
      if (!accepted) process.exitCode=2;
      return;
    }

    if (handoverCountOnly) {
      sanitizedStage = 'handover_blank_count_real_webview';
      await navigate('/finance/handover');
      const ready=await waitFor(`!!document.querySelector('#handover-actual-cash')||
        !![...document.querySelectorAll('p')].find(x=>x.textContent?.includes('تعذر تحميل'))`,85);
      const state=await evalPage(`(()=>{
        const input=document.querySelector('#handover-actual-cash');
        const form=input?.closest('form');
        const submit=[...(form?.querySelectorAll('button[type="submit"]')||[])];
        return {realRoute:location.pathname==='/finance/handover',
          handoverFormVisible:!!input&&!!form&&submit.length===1,
          countBlank:input?.value==='',countExplicitlyRequired:input?.required===true,
          financialFormNotSubmitted:!!form&&form.querySelector('input')!==null,
          loadingDenied:!![...document.querySelectorAll('p')].find(x=>x.textContent?.includes('تعذر تحميل'))};
      })()`);
      console.log('PINNED_QA_PHYSICAL_COUNT_UNSUBMITTED='+JSON.stringify({
        ...state,readSettled:ready,actorTenantVerified:facts.ownerTenantAuthenticated,financialMutation:false,
      }));
      if(!ready||!state?.handoverFormVisible||!state?.countBlank||!state?.countExplicitlyRequired)process.exitCode=2;
      return;
    }

    if (settlementReadOnly) {
      sanitizedStage = 'native_negative_settlement_source_preflight';
      const Database = require('better-sqlite3');
      const dbPath=path.join(process.env.APPDATA||'', 'com.pharma.disposable.lifecycle.qa20261016', 'pharma_local.db');
      const localDb = new Database(dbPath, {readonly:true,fileMustExist:true});
      let certifiedBaseline = false;
      try {
        localDb.pragma('query_only=ON');
        const row=localDb.prepare(`SELECT COUNT(*) n FROM sales_items si
          JOIN sales_invoices s ON s.id=si.invoice_id WHERE si.is_negative=1 AND s.pharmacy_id=?`).get(TENANT);
        certifiedBaseline = row?.n === 0;
      } finally { localDb.close(); }
      if (!certifiedBaseline) throw Error('Native negative sale source preflight changed; refuse scripted expectation');
      const results={ actorTenantVerified:facts.ownerTenantAuthenticated,
        existingQaNegativeSaleCountZero:certifiedBaseline,
        nativeOwnedEmptyList:false, foreignBatchSourceDenied:false,
        actualSettlementRoute:false, settledWithoutFakeRows:false,
        financialMutation:false };
      const native=await evalPage(`(async()=>{
        const invoke=window.__TAURI_INTERNALS__.invoke;
        let own=false,deny=false;
        try{const rows=await invoke('read_settlement_native',{queryId:'unsettled_sales',drugId:null});
          own=rows?.actorId===${JSON.stringify(ACTOR)}&&rows?.pharmacyId===${JSON.stringify(TENANT)}
            &&Array.isArray(rows?.rows)&&rows.rows.length===0;}catch{}
        try{await invoke('read_settlement_native',{queryId:'drug_batches',drugId:132});}
        catch{deny=true;}
        return {own,deny};
      })()`);
      results.nativeOwnedEmptyList=!!native?.own;
      results.foreignBatchSourceDenied=!!native?.deny;
      sanitizedStage = 'native_negative_settlement_real_screen';
      await navigate('/inventory/settlement');
      results.actualSettlementRoute=await waitFor(`location.pathname==='/inventory/settlement'&&!!document.querySelector('main')`, 90);
      results.settledWithoutFakeRows=await waitFor(`(()=>{
        const root=document.querySelector('main');
        return !!root && !![...root.querySelectorAll('p')].find(x=>x.textContent?.includes('لا يوجد مبيعات معلقة للتسوية'))
          && !root.querySelector('[role="alert"]')
          && !root.querySelector('button[aria-label="تسوية الآن"]');
      })()`,85);
      console.log('PINNED_NATIVE_SETTLEMENT_GUI_READONLY='+JSON.stringify(results));
      if(!Object.entries(results).every(([key,value])=>key==='financialMutation'?value===false:value===true))process.exitCode=2;
      return;
    }

    if (offlineReadOnly) {
      sanitizedStage = 'offline_local_qa_preflight';
      await navigate('/inventory');
      if(!await waitFor(`!!document.querySelector('main')&&!!window.__TAURI_INTERNALS__`, 65)) {
        throw Error('Owned inventory screen unavailable before offline emulation');
      }
      await send('Network.enable');
      let offlineSet = false;
      let inspected = null;
      let restored = false;
      try {
        sanitizedStage = 'offline_local_qa_check';
        await send('Network.emulateNetworkConditions', {
          offline:true,latency:0,downloadThroughput:0,uploadThroughput:0,
        });
        offlineSet = true;
        inspected = await evalPage(`(async()=>{
          const offline=navigator.onLine===false;
          const invoke=window.__TAURI_INTERNALS__?.invoke;
          if(!invoke)return {offline,nativeRead:false,actorVerified:false};
          try {
            const [actor,alerts]=await Promise.all([
              invoke('current_local_user'),invoke('read_inventory_alerts_native')
            ]);
            return {offline,actorVerified:actor?.id===${JSON.stringify(ACTOR)}&&
              actor?.pharmacy_id===${JSON.stringify(TENANT)}&&actor?.role==='owner',
              nativeRead:alerts?.pharmacyId===${JSON.stringify(TENANT)}&&
                alerts?.actorId===${JSON.stringify(ACTOR)}&&Array.isArray(alerts?.alerts)};
          }catch{return {offline,nativeRead:false,actorVerified:false};}
        })()`);
      } finally {
        if (offlineSet) {
          sanitizedStage = 'offline_local_qa_restore';
          await send('Network.emulateNetworkConditions', {
            offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,
          });
          restored = true;
          await send('Network.disable');
        }
      }
      const online = await evalPage('navigator.onLine===true');
      const results = {
        qaOwnerVerified:facts.ownerTenantAuthenticated,
        chromiumNetworkOffline:!!inspected?.offline,
        nativeAuthenticatedOfflineRead:!!inspected?.actorVerified && !!inspected?.nativeRead,
        networkRestored:restored && !!online,
        financialMutation:false,
      };
      console.log('PINNED_QA_OFFLINE_NONPOSTING='+JSON.stringify(results));
      if (!results.chromiumNetworkOffline || !results.nativeAuthenticatedOfflineRead ||
          !results.networkRestored) process.exitCode=2;
      return;
    }

    if (purchaseCostOnly) {
      sanitizedStage = 'unverified_acquisition_cost_form';
      const path=require('node:path');
      const Database=require('better-sqlite3');
      const qaDbPath=path.join(process.env.APPDATA||'', 'com.pharma.disposable.lifecycle.qa20261016', 'pharma_local.db');
      const localDb=new Database(qaDbPath,{readonly:true,fileMustExist:true});
      let candidate;
      try {
        localDb.pragma('query_only=ON');
        candidate=localDb.prepare('SELECT id,trade_name_en,official_price,base_price,has_expiry FROM master_drugs WHERE id=82').get();
        const owned=localDb.prepare('SELECT COUNT(*) AS count FROM inventory WHERE drug_id=82').get();
        if(candidate?.id!==82||candidate.official_price!==5||candidate.base_price!==0||
          candidate.has_expiry!==1||typeof candidate.trade_name_en!=='string'||
          candidate.trade_name_en.length<18||owned?.count!==0)throw Error('Candidate drifted');
      }finally{localDb.close();}
      sanitizedStage = 'purchase_cost_native_route';
      await navigate('/purchases/new');
      if (!await waitFor(`!!document.querySelector('#purchase-drug-search')&&!!document.querySelector('#purchase-supplier')`, 95)) {
        throw Error('Purchase form hydration did not settle');
      }
      await pause(450);
      const preflight=await evalPage(`(()=>({
        newForm:[...document.querySelectorAll('h1')].some(x=>x.textContent?.includes('فاتورة شراء جديدة')),
        defaultCredit:[...document.querySelectorAll('button')].some(x=>x.textContent?.trim()==='آجل'&&x.getAttribute('aria-pressed')==='true'),
        hasSearch:!!document.querySelector('#purchase-drug-search'),
        hasPending:Object.keys(sessionStorage).some(k=>k.endsWith('pending-native-create-v1')),
        emptyGrid:document.querySelectorAll('[role="region"][aria-label="بنود فاتورة الشراء القابلة للتمرير"] tbody tr').length===1,
      }))()`);
      if(!preflight?.newForm||!preflight?.defaultCredit||!preflight?.hasSearch||preflight?.hasPending||!preflight?.emptyGrid){
        console.log('PURCHASE_UI_INITIAL_GUARDS='+JSON.stringify(preflight));
        throw Error('Purchase preflight failed closed');
      }
      sanitizedStage = 'purchase_cost_catalog_search';
      await evalPage(`document.querySelector('#purchase-drug-search').focus()`);
      await send('Input.insertText',{text:candidate.trade_name_en.slice(0,18)});
      const exactName=JSON.stringify(candidate.trade_name_en);
      const found=await waitFor(`(()=>[...document.querySelectorAll('#purchase-drug-search+div button, #purchase-drug-search~div button')].filter(b=>b.querySelector('div.font-black')?.textContent?.trim()===${exactName}).length===1)()`,90);
      if(!found) {
        const searchDiagnostic=await evalPage(`(()=>({searched:document.querySelector('#purchase-drug-search')?.value?.length>2,
          results:document.querySelectorAll('#purchase-drug-search+div button').length,
          anyToast:!!document.querySelector('[role="status"]'),
          searchHasNative:!!window.__TAURI_INTERNALS__}))()`);
        console.log('PURCHASE_UI_SEARCH_REDACTED='+JSON.stringify(searchDiagnostic));
        throw Error('Unique verified catalog candidate was not exposed by purchase search');
      }
      sanitizedStage = 'purchase_cost_cart_selection';
      const selected=await evalPage(`(()=>{const candidates=[...document.querySelectorAll('#purchase-drug-search+div button, #purchase-drug-search~div button')].filter(b=>b.querySelector('div.font-black')?.textContent?.trim()===${exactName});if(candidates.length!==1)return false;candidates[0].click();return true})()`);
      if(!selected)throw Error('Cannot select prospective read-only purchase item');
      const live=await waitFor(`(()=>{
        const tr=document.querySelector('[role="region"][aria-label="بنود فاتورة الشراء القابلة للتمرير"] tbody tr');
        const td=tr?.querySelectorAll('td');
        return td?.length===12&&Number(td[2]?.querySelector('input')?.value)===5&&
          Number(td[9]?.querySelector('input')?.value)===0&&
          !!td[9]?.querySelector('[role="note"]')?.textContent?.includes('أدخل تكلفة شراء مؤكدة من المورد');
      })()`,70);
      console.log('PURCHASE_UNVERIFIED_COST_GUI='+JSON.stringify({
        ownerTenantAuthenticated:facts.ownerTenantAuthenticated,
        explicitCatalogRetailFive:preflight.newForm,
        costDoesNotDefaultToRetail:!!live,
        noInvoiceSubmitted:true,
        financialMutation:false,
      }));
      if(!live)process.exitCode=2;
      return;
    }

    if (purchaseStateOnly) {
      sanitizedStage = 'purchase_form_readonly_preflight';
      await navigate('/purchases/new');
      await pause(1200);
      const state = await evalPage(`(()=>{
        const supplier=document.querySelector('#purchase-supplier');
        const buttons=[...document.querySelectorAll('button')];
        const credit=buttons.find(b=>b.textContent?.trim()==='آجل');
        const save=buttons.find(b=>b.textContent?.includes('حفظ نهائي'));
        const drafts=Object.keys(sessionStorage).filter(k=>k.includes('purchase')&&k.includes('pending-native-create'));
        return {
          route:location.pathname==='/purchases/new',
          headerNew:[...document.querySelectorAll('h1')].some(x=>x.textContent?.includes('فاتورة شراء جديدة')),
          supplierControl:!!supplier,syntheticSupplierAvailable:!!supplier?.querySelector('option[value="2"]'),
          supplierSelected:String(supplier?.value||'')==='2',
          creditSelected:credit?.getAttribute('aria-pressed')==='true',
          invoiceInput:!!document.querySelector('#purchase-invoice-number'),
          invoiceDate:!!document.querySelector('#purchase-invoice-date'),
          drugSearch:!!document.querySelector('#purchase-drug-search'),
          savePresent:!!save,saveDisabled:!!save?.disabled,
          editMode:new URLSearchParams(location.search).has('edit_invoice_id'),
          pendingCreateDrafts:drafts.length,
          lineItems:document.querySelectorAll('[role="region"][aria-label="بنود فاتورة الشراء القابلة للتمرير"] tbody tr').length,
        };
      })()`);
      console.log('PINNED_QA_PURCHASE_FORM_PRECHECK='+JSON.stringify(state));
      return;
    }

    if (posStateOnly) {
      sanitizedStage = 'pos_diagnostic_without_mutation';
      await navigate('/pos');
      await pause(2800);
      const name = JSON.stringify(plan.patientName);
      const safeState = await evalPage(`(()=>({
        correctRoute:location.pathname==='/pos',
        searchInput:!!document.querySelector('input[data-nav="patient-input"]'),
        anyPatientSelected:!!document.querySelector('button[aria-label^="إلغاء اختيار العميل "]'),
        qaPatientSelected:!!document.querySelector('button[aria-label="إلغاء اختيار العميل '+${name}+'"]'),
        checkoutDisabled:!!document.querySelector('button[data-nav="checkout-button"]')?.disabled,
        searchResults:document.querySelectorAll('.absolute.top-full button').length,
        visibleAlert:!!document.querySelector('main [role="alert"]'),
        spinner:!!document.querySelector('main .animate-spin'),
      }))()`);
      console.log('CONNECTED_POS_SAFE_STATE='+JSON.stringify(safeState));
      return;
    }

    if (alertsOnly) {
      sanitizedStage = 'native_alerts_and_live_header';
      await navigate('/reports/purchases');
      const result = await evalPage(`(async()=>{
        try {
          const p=await window.__TAURI_INTERNALS__.invoke('read_inventory_alerts_native');
          const rows=p?.alerts,c=p?.counts;
          if(p?.actorId!==${JSON.stringify(ACTOR)}||p?.pharmacyId!==${JSON.stringify(TENANT)}||
             !Array.isArray(rows)||rows.length>30||!c||c.total!==rows.length||
             c.total!==c.lowStock+c.expiring+c.expired)return {valid:false};
          const ownedLow=rows.some(a=>a?.alert_type==='low_stock'&&a?.quantity===2);
          let dismissed=[];
          try{const saved=JSON.parse(localStorage.getItem('pharma_dismissed_alerts')||'[]');
            if(Array.isArray(saved))dismissed=saved;}catch{}
          const active=rows.filter(a=>!dismissed.includes(String(a.id)+'-'+a.alert_type)).length;
          return {valid:ownedLow,active,count:rows.length};
        }catch{return {valid:false};}
      })()`);
      const observed = {
        ownerTenantAuthenticated: facts.ownerTenantAuthenticated,
        nativeOwnedLowStock: !!result?.valid,
        nativeAlertCountWithinBudget: Number.isSafeInteger(result?.count)&&result.count>=1&&result.count<=30,
        nativeHeaderCountMatches:false, nativeHeaderDropdownUsable:false,
        financialMutation:false,
      };
      if (observed.nativeOwnedLowStock) {
        const expected = JSON.stringify('فتح التنبيهات (' + String(result.active) + ')');
        observed.nativeHeaderCountMatches = await waitFor(`(()=>{
          const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.startsWith('فتح التنبيهات ('));
          return !!b&&b.getAttribute('aria-label')===${expected};
        })()`, 90);
        if(observed.nativeHeaderCountMatches) {
          const clicked=await evalPage(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.startsWith('فتح التنبيهات ('));if(!b)return false;b.click();return true})()`);
          observed.nativeHeaderDropdownUsable=!!clicked&&await waitFor(`!!document.querySelector('[role="region"][aria-label="التنبيهات"]')`,55);
        }
      }
      console.log('NATIVE_QA_HEADER_ALERTS_READONLY='+JSON.stringify(observed));
      if(!Object.entries(observed).every(([key,value])=>key==='financialMutation'?value===false:value===true))process.exitCode=2;
      return;
    }

    sanitizedStage = 'owned_return_detail';
    await navigate('/returns/new');
    if (!await waitFor(`!!document.getElementById('sales-return-search')`)) throw Error('Native return search not mounted');
    await evalPage(`document.getElementById('sales-return-search').focus()`);
    await send('Input.insertText', { text: '3726c3df' });
    const owned = `(()=>{const b=[...document.querySelectorAll('button[aria-pressed]')].filter(x=>x.textContent?.includes('3726c3df'));return b.length===1&&b[0].getAttribute('aria-pressed')==='true'})()`;
    facts.returnSearchMatchesOwnedSale = await waitFor(owned, 90);
    if (facts.returnSearchMatchesOwnedSale) {
      const detail = `(()=>{const h=[...document.querySelectorAll('h2')].some(h=>h.textContent?.trim()==='أصناف الفاتورة');return h&&document.querySelectorAll('input[aria-label^="كمية مرتجع"]').length>0})()`;
      facts.returnItemDetailsResolved = await waitFor(detail, 85);
      facts.returnQuantityStartsZero = !!await evalPage(`(()=>{const inputs=[...document.querySelectorAll('input[aria-label^="كمية مرتجع"]')];return inputs.length>0&&inputs.every(x=>x.value===''||Number(x.value)===0)})()`);
      if (facts.returnItemDetailsResolved && facts.returnQuantityStartsZero) {
        // This sale is already partly refunded, leaving exactly one large unit
        // at 150 EGP. Deliberately request two through the REAL controlled
        // numeric input and verify UI clamps to one before any native write.
        const inputReady = await evalPage(`(()=>{const inputs=[...document.querySelectorAll('input[aria-label^="كمية مرتجع"]')];if(inputs.length!==1)return false;inputs[0].focus();inputs[0].select();return true})()`);
        if (inputReady) {
          await send('Input.insertText', { text: '2' });
          facts.partiallyReturnedSaleCapsQuantity = await waitFor(`(()=>{const i=document.querySelector('input[aria-label^="كمية مرتجع"]');return !!i&&Number(i.value)===1})()`, 50);
          facts.partialReturnRefundPreviewMatchesReceipt = facts.partiallyReturnedSaleCapsQuantity &&
            await waitFor(`(()=>{const h=[...document.querySelectorAll('h3')].find(x=>x.textContent?.trim()==='إجمالي قيمة المرتجع');const s=h?.parentElement?.querySelector('span.text-3xl');return !!s&&/^150\\.00\\s*ج/.test(s.textContent?.trim()||'')})()`, 45);
        }
      }
    }
    // Browser-level text input only: never activate a refund submit button.
    await evalPage(`(()=>{const a=document.getElementById('sales-return-search');a.focus();a.select();return true})()`);
    await send('Input.insertText', { text: 'zz-unowned-qa-no-invoice-20261017' });
    facts.negativeUnknownReturnSearchEmpty = await waitFor(`(()=>{const a=document.getElementById('sales-return-search');return a?.value==='zz-unowned-qa-no-invoice-20261017' && document.querySelectorAll('button[aria-pressed]').length===0})()`, 80);

    sanitizedStage = 'owned_patient_profile';
    await navigate('/patients');
    const name = JSON.stringify(plan.patientName);
    if (!await waitFor(`(()=>[...document.querySelectorAll('h3')].filter(e=>e.textContent?.trim()===${name}).length===1)()`)) {
      throw Error('One prospective owned patient card required');
    }
    facts.patientWalletFiveVisible = !!await evalPage(`(()=>{const h=[...document.querySelectorAll('h3')].find(e=>e.textContent?.trim()===${name});const card=h?.closest('.cursor-pointer');return !!card&&card.textContent?.includes('رصيد المحفظة')&&card.textContent?.includes('5.00')})()`);
    const opened = await evalPage(`(()=>{const h=[...document.querySelectorAll('h3')].find(e=>e.textContent?.trim()===${name});const buttons=[...(h?.closest('.cursor-pointer')?.querySelectorAll('button')||[])].filter(x=>x.textContent?.includes('عرض وتعديل الملف'));if(buttons.length!==1)return false;buttons[0].click();return true})()`);
    facts.patientProfileOpens = !!opened && await waitFor(`!!document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]')`, 70);
    if (facts.patientProfileOpens) {
      facts.financeTabAccessible = await evalPage(`(()=>{const d=document.querySelector('[role="dialog"][aria-labelledby="patient-profile-title"]');const b=[...(d?.querySelectorAll('button')||[])].filter(x=>x.textContent?.includes('المالية والتأمين'));if(b.length!==1||b[0].disabled)return false;b[0].click();return true})()`);
      facts.financeTabAccessible = !!facts.financeTabAccessible && await waitFor(`!!document.querySelector('[role="dialog"] #topup-amount')`, 75);
    }
    sanitizedStage = 'pos_patient_wallet_preview';
    await navigate('/pos');
    // POS deliberately persists the selected patient between navigations.
    // A repeated *read-only* probe must validate the already selected native
    // patient rather than assume an empty draft and replace that selection.
    const previouslySelected = `!!document.querySelector('button[aria-label="إلغاء اختيار العميل '+${name}+'"]')`;
    const patientControlReady = await waitFor(`(()=>${previouslySelected}||!!document.querySelector('input[data-nav="patient-input"]'))()`, 95);
    if (!patientControlReady) throw Error('POS patient state not available');
    if (!await evalPage(previouslySelected)) {
      await evalPage(`document.querySelector('input[data-nav="patient-input"]').focus()`);
      await send('Input.insertText', { text: plan.patientName });
      if (!await waitFor(`(()=>{const a=document.querySelector('input[data-nav="patient-input"]');const exact=[...document.querySelectorAll('button')].filter(b=>b.textContent?.includes(${name})&&b.closest('.absolute.top-full'));return a?.value===${name}&&exact.length===1})()`, 90)) {
        throw Error('Verified synthetic patient not present in POS search');
      }
      await evalPage(`(()=>{const found=[...document.querySelectorAll('button')].filter(b=>b.textContent?.includes(${name})&&b.closest('.absolute.top-full'));if(found.length!==1)return false;found[0].click();return true})()`);
    }
    facts.posPatientSelectionVerified = await waitFor(previouslySelected, 90);
    if (facts.posPatientSelectionVerified) {
      const chosen = await evalPage(`(()=>{const group=document.querySelector('[role="group"][aria-labelledby="pos-payment-method-label"]');const wallet=[...(group?.querySelectorAll('button')||[])].filter(x=>x.textContent?.trim()==='محفظة');if(wallet.length!==1)return false;wallet[0].click();return true})()`);
      facts.posWalletBalanceFiveVerified = !!chosen && await waitFor(`(()=>{const btn=[...document.querySelectorAll('[role="group"][aria-labelledby="pos-payment-method-label"] button')].find(b=>b.textContent?.trim()==='محفظة');const blocks=[...document.querySelectorAll('span')].filter(x=>x.textContent?.trim()==='رصيد المحفظة:');return btn?.getAttribute('aria-pressed')==='true'&&blocks.some(x=>x.parentElement?.textContent?.includes('5.00'))})()`, 65);
      facts.posEmptyCartCheckoutDisabled = !!await evalPage(`(()=>{const b=document.querySelector('button[data-nav="checkout-button"]');return !!b&&b.disabled})()`);
    }
    sanitizedStage = 'shift_screen';
    await navigate('/shifts');
    facts.shiftRemainsOpen = await waitFor(`(()=>[...document.querySelectorAll('h2')].some(e=>e.textContent?.includes('الوردية المشتركة مفتوحة حالياً')))()`, 85);
    sanitizedStage = 'native_finance_projection';
    await navigate('/reports/trial-balance');
    facts.trialBalanceScreen = await waitFor(`(()=>document.querySelectorAll('main h1,main h2').length>0 && !document.querySelector('main .animate-spin,main [role="alert"]'))()`, 85);
    // The live native accounting projection must agree with the independently
    // preflighted ledger: 1,404.00 EGP on each side, 300 cash sale minus 150
    // cash refund plus the *single* 5 cash wallet funding = 155 cash. The
    // supplier's separate 25 EGP bank settlement must not enter drawer cash.
    // Only aggregate integer-cents results are returned to this test process.
    const ledger = await evalPage(`(async()=>{
      const call=window.__TAURI_INTERNALS__.invoke;
      const args={limit:200,offset:0};
      let p,t;
      try{p=await call('finance_read_projection',{queryId:'trial_balance',...args});}
      catch{return {trial:false,cash:false,source:'trial_native_rejected'};}
      try{t=await call('finance_read_projection',{queryId:'treasury_cash_ledger',...args});}
      catch{return {trial:false,cash:false,source:'treasury_native_rejected'};}
      const scoped=x=>x?.actorId===${JSON.stringify(ACTOR)}&&x?.pharmacyId===${JSON.stringify(TENANT)}&&Array.isArray(x?.rows);
      const cents=x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x*100-Math.round(x*100))<0.0001?Math.round(x*100):null;
      if(!scoped(p)||!scoped(t)||p.rows.length===0||p.rows.length>=200||t.rows.length!==1)return {trial:false,cash:false};
      let debit=0,credit=0;
      for(const row of p.rows){
        if(Number(row.is_group)===1)continue;
        const d=cents(row.total_debit),c=cents(row.total_credit);
        if(d===null||c===null||d<0||c<0)return {trial:false,cash:false};
        debit+=d;credit+=c;
      }
      return {trial:debit===140400&&credit===140400,cash:cents(t.rows[0].ledger_cash_balance)===15500};
    })()`);
    facts.nativeTrialBalanceExactCents = !!ledger?.trial;
    facts.nativeCashExcludesBankSettlement = !!ledger?.cash;
    const nativeAlerts = await evalPage(`(async()=>{
      try {
        const result=await window.__TAURI_INTERNALS__.invoke('read_inventory_alerts_native');
        const alerts=result?.alerts,counts=result?.counts;
        if(result?.actorId!==${JSON.stringify(ACTOR)}||result?.pharmacyId!==${JSON.stringify(TENANT)}||
          !Array.isArray(alerts)||alerts.length>30||!counts||counts.total!==alerts.length||
          counts.total!==counts.lowStock+counts.expiring+counts.expired)return {valid:false};
        const hasOwnedLowStock=alerts.some(a=>a?.alert_type==='low_stock'&&a?.quantity===2);
        // Never output real drug names, barcodes, lot IDs or saved dismissals.
        let dismissed=[];
        try{const saved=JSON.parse(localStorage.getItem('pharma_dismissed_alerts')||'[]');
          if(Array.isArray(saved))dismissed=saved;}catch{}
        const active=alerts.filter(a=>!dismissed.includes(String(a.id)+'-'+a.alert_type)).length;
        return {valid:hasOwnedLowStock,active};
      }catch{return {valid:false};}
    })()`);
    facts.nativeInventoryAlertsOwned = !!nativeAlerts?.valid;
    if (facts.nativeInventoryAlertsOwned) {
      facts.headerAlertsMatchNative = await waitFor(`(()=>{
        const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.startsWith('فتح التنبيهات ('));
        return !!b&&b.getAttribute('aria-label')===${JSON.stringify('فتح التنبيهات (') }+${JSON.stringify('')}+String(${Number(nativeAlerts.active)})+')';
      })()`, 65);
      if(facts.headerAlertsMatchNative) {
        const opened=await evalPage(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.startsWith('فتح التنبيهات ('));if(!b)return false;b.click();return true})()`);
        facts.headerAlertsMatchNative=!!opened&&await waitFor(`!!document.querySelector('[role="region"][aria-label="التنبيهات"]')`,40);
      }
    }
    if(ledger?.source) console.log('CONNECTED_GUI_NATIVE_FINANCE_STAGE='+ledger.source);
    console.log('CONNECTED_GUI_READONLY=' + JSON.stringify(facts));
    if (Object.values(facts).some(x => x !== true && x !== false) ||
        !Object.entries(facts).every(([k, v]) => k === 'financialMutation' ? v === false : v === true)) {
      process.exitCode = 2;
    }
  } catch {
    console.error('CONNECTED_GUI_READONLY_STAGE=' + sanitizedStage);
    throw Error('Native GUI read-only scope did not complete');
  } finally {
    ws.close();
  }
}

if (require.main === module) {
  const pid = Number(process.argv[2]);
  const sha = String(process.argv[3] || '').toUpperCase();
  run(pid, sha, process.argv[4] || '', process.argv[5] === '--alerts-only', process.argv[5] === '--pos-state', process.argv[5] === '--purchase-state', process.argv[5] === '--purchase-cost', process.argv[5] === '--offline-readonly', process.argv[5] === '--settlement-readonly', process.argv[5] === '--handover-count', process.argv[5] === '--pos-handover-count', process.argv[5] === '--cogs-denied', process.argv[5] === '--stock-adjustment-readonly').catch(() => {
    console.error('CONNECTED_GUI_READONLY=BLOCKED; no monetary control was submitted');
    process.exitCode = 1;
  });
}

module.exports = { assertCustody, verifiedPlan, verifiedBlankPosCountState, verifiedNativeCogsDeniedState, verifiedNativeStockAdjustmentState };
