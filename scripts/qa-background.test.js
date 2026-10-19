'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { catalog } = require('./qa-background-inventory');
const { exportedRoutes, summarizeJest, classifyNativeExit, assertionEvidence } = require('./qa-background');

test('per-assertion headless records explicitly never claim native financial effects', () => {
  const cases = assertionEvidence({ testResults: [{ name: 'C:\\qa\\src\\spec.test.tsx',
    assertionResults: [{ fullName: 'reject invalid amount before submit', status:'passed', failureMessages: [] },
      { fullName: 'deny foreign user', status:'failed', failureMessages: ['forbidden'] }] }] }, 'jest-part-01.json');
  assert.equal(cases.length, 2);
  assert.equal(cases[0].status, 'passed');
  assert.match(cases[0].native_effect, /not proven/);
  assert.equal(cases[1].status, 'failed');
  assert.equal(cases[1].evidence_file, 'jest-part-01.json');
  assert.throws(() => assertionEvidence({status:'pass'}, 'missing.json'), /testResults/);
});
const { controlEvidence, sourceModule } = require('./qa-background-coverage');
const { isReadySignedNativeLease, isTrustedSyntheticOwnerReconciliation,
  nativeRouteAcceptance } = require('./qa-background-auth-gate');
const { isExpectedSupplierRejection, verifyRejectedSupplierInputs } = require('./qa-background-native-negatives');
const { mergeNativeSamples } = require('./qa-background-merge-evidence');
const { postOneVerifiedSyntheticBankPayment } = require('./qa-background-native-positive');

test('the archived synthetic EGP1 bank helper itself refuses invocation before any CDP request', async () => {
  let nativeInvoked = false;
  await assert.rejects(postOneVerifiedSyntheticBankPayment({ evaluate:async () => {
    nativeInvoked = true;
  } }, '/does-not-exist', {status:'limited_no_findings',scannedJournals:4,findings:0,
    unverifiableLegacyJournals:0}), /permanently disabled/);
  assert.equal(nativeInvoked, false);
});

test('historical native merge chooses best authenticated render per route but never duplicates cross-run actions', () => {
  const inventory = {paths:['/pos','/purchases/suppliers','/settings']};
  const source = {controls:[{source:'src/components/finance/AccountsManagementClient.tsx',line:15,tag:'button',category:'sensitive'}]};
  const samples = [
    {name:'pharma-background-qa-aaaaaa',native:{routes:[{route:'/pos',status:'unverified_loading',controls:[{i:0,tag:'button',label:'Checkout'}]}],
      behaviors:{scenarios:[{route:'/pos',action:'open Checkout',status:'verified',evidence:'stale'}]}}},
    {name:'pharma-background-qa-bbbbbb',native:{routes:[
      {route:'/pos',status:'pass',hydration_warnings:1,main_preview:'POS',controls_discovered:1,controls:[{i:0,tag:'button',label:'Checkout'}]},
      {route:'/purchases/suppliers',status:'blocked_feature_denial',controls_discovered:1,controls:[{i:0,tag:'button',label:'Pay'}]},
    ],behaviors:{scenarios:[]}}},
  ];
  const merged = mergeNativeSamples(samples,inventory,source);
  assert.equal(merged.summary.distinct_native_routes,2);
  assert.equal(merged.summary.routes_rendered,1);
  assert.equal(merged.summary.routes_hydration_unverified,1);
  assert.equal(merged.summary.clean_rendered_native_routes,0);
  assert.equal(merged.summary.routes_blocked,1);
  assert.equal(merged.summary.runtime_control_counts.verified,0);
  assert.equal(merged.summary.runtime_control_counts.blocked,1);
  assert.equal(merged.runtime_controls[0].status,'untested');
  assert.equal(merged.modules.find(m=>m.module==='pos').route_mounts_observed,1);
  assert.equal(merged.modules.find(m=>m.module==='pos').rendered_routes,0);
  assert.equal(merged.runtime_controls[0].evidence_run,samples[1].name);
  assert.equal(merged.routes.find(r=>r.route==='/settings').status,'untested');
  assert.equal(merged.source_controls[0].status,'untested');
});

test('historical route without explicit hydration instrumentation never becomes a clean accepted control', () => {
  const inventory = { paths:['/pos'] };
  const source = { controls:[] };
  const makeSample = page => [{ name:'pharma-background-qa-cccccc', native:{
    routes:[page],behaviors:{scenarios:[{route:'/pos',action:'open Checkout',status:'verified',evidence:'opened'}]},
  }}];
  const unknown = mergeNativeSamples(makeSample({route:'/pos',status:'pass',
    controls_discovered:1,controls:[{i:0,tag:'button',label:'Checkout'}]}),inventory,source);
  assert.equal(unknown.summary.routes_rendered,1);
  assert.equal(unknown.summary.routes_hydration_unknown,1);
  assert.equal(unknown.summary.clean_rendered_native_routes,0);
  assert.equal(unknown.runtime_controls[0].status,'untested');
  const clean = mergeNativeSamples(makeSample({route:'/pos',status:'pass',
    hydration_warnings:0,hydration_acceptance:'no_mismatch_observed',
    controls_discovered:1,controls:[{i:0,tag:'button',label:'Checkout'}]}),inventory,source);
  assert.equal(clean.summary.clean_rendered_native_routes,1);
  assert.equal(clean.runtime_controls[0].status,'verified');
});

test('native invalid-payment checks reject missing bridge, licensing failure or unrelated errors as non-evidence', async () => {
  assert.equal(isExpectedSupplierRejection('invalid_request_uuid','Invalid supplier payment request ID'), true);
  assert.equal(isExpectedSupplierRejection('negative_cent_amount','Supplier tender must be a positive exact-cent amount'), true);
  assert.equal(isExpectedSupplierRejection('forged_tenant_key_disallowed','unknown field `pharmacyId`'), true);
  assert.equal(isExpectedSupplierRejection('overpay_remaining_payable','Supplier balance or supplier ledger lacks canonical provenance'), true);
  for (const invalid of ['Unknown command: post_supplier_payment_native', 'License has expired',
    'Authenticated role cannot settle suppliers','Failed to fetch']) {
    assert.equal(isExpectedSupplierRejection('invalid_request_uuid',invalid), false);
    const result = await verifyRejectedSupplierInputs({ evaluate:async () => ({ accepted:false,rejected:invalid }) });
    assert.equal(result.status, 'fail');
    assert.equal(result.cases.length, 1, 'unexpected denial must not trigger more financial IPC');
    assert.equal(result.cases[0].status, 'blocked_unexpected_native_error');
  }
});

test('different-label duplicate hrefs and duplicated tab labels never inherit one successful click witness', () => {
  const native = { routes:[{ route:'/accounts',status:'pass',controls:[
    {i:0,tag:'a',label:'Report A',href:'/reports'},
    {i:1,tag:'a',label:'Report B',href:'/reports'},
    {i:2,tag:'button',label:'نقط البيع'},
    {i:3,tag:'button',label:'نقط البيع'},
  ],finance_tabs:[{label:'نقط البيع',status:'selected_ui_only'}]}],
  behaviors:{scenarios:[{route:'/accounts',action:'navigate /reports',status:'verified',evidence:'navigated'}]} };
  const result = controlEvidence({paths:['/accounts']},native,{controls:[]});
  assert.deepEqual(result.runtime_controls.map(c=>c.status),['untested','untested','untested','untested']);
});

test('native route actions require signed startup plus a real owner-authorized read-only reconciliation, not localStorage', () => {
  assert.equal(isReadySignedNativeLease({ valid:true, startup_ready:true }), true);
  assert.equal(isReadySignedNativeLease({ valid:true, startup_ready:false }), false);
  assert.equal(isReadySignedNativeLease({ valid:false, startup_ready:true }), false);
  const owner = { status:'limited_no_findings',scannedJournals:5,findings:0,unverifiableLegacyJournals:0 };
  assert.equal(isTrustedSyntheticOwnerReconciliation(owner), true);
  assert.equal(isTrustedSyntheticOwnerReconciliation({ ...owner, status:'denied' }), false);
  assert.equal(isTrustedSyntheticOwnerReconciliation({ ...owner, findings:1 }), false);
  assert.equal(isTrustedSyntheticOwnerReconciliation({ ...owner, scannedJournals:'5' }), false);
  assert.equal(isTrustedSyntheticOwnerReconciliation({ ...owner, scannedJournals:6 }), false);
});

test('rendered controls are not accepted as clean native routes when React hydration failed', () => {
  const accepted = { failures:[],routes:[{status:'pass'}],authenticated:true,hydrationWarnings:0 };
  assert.equal(nativeRouteAcceptance(accepted), 'pass');
  assert.equal(nativeRouteAcceptance({ ...accepted, hydrationWarnings:1 }), 'partial');
  assert.equal(nativeRouteAcceptance({ ...accepted, authenticated:false }), 'partial');
  assert.equal(nativeRouteAcceptance({ ...accepted, failures:[{error:'owner'}] }), 'fail');
  assert.equal(nativeRouteAcceptance({ ...accepted, routes:[{status:'unverified_hydration'}] }), 'partial');
});

test('native acceptance rejects absent or invalid aggregate hydration diagnostics', () => {
  const accepted = { failures:[],routes:[{status:'pass'}],authenticated:true,hydrationWarnings:0 };
  for (const invalid of [undefined, null, -1, 0.5, NaN, Infinity, '0']) {
    assert.equal(nativeRouteAcceptance({ ...accepted, hydrationWarnings:invalid }), 'partial',
      `invalid hydration count ${String(invalid)} must not certify native acceptance`);
  }
});

test('source-level inventory groups every JSX control without implying signed native coverage', () => {
  assert.equal(sourceModule('src/app/(dashboard)/patients/page.tsx'), 'patients');
  assert.equal(sourceModule('src/components/finance/AccountsManagementClient.tsx'), 'finance');
  assert.equal(sourceModule('src/components/LicenseBoundary.tsx'), 'shared');
  const source = { controls: [{ source:'src/components/finance/AccountsManagementClient.tsx',
    line:22,tag:'button',label_expression:'notice',handler_expression:'openNotice()',required:false,
    disabled_expression:null,category:'state_changing_or_sensitive_manual_native_check' }] };
  const result = controlEvidence({paths:[]}, {routes:[]}, source);
  assert.equal(result.source_modules[0].module, 'finance');
  assert.equal(result.source_modules[0].untested_source_controls, 1);
  assert.equal(result.source_controls[0].status, 'untested');
  assert.match(result.source_controls[0].evidence, /static AST/);
});

test('previously reconciled EGP1 bank payment cannot be reissued through either background entrypoint', () => {
  for (const entry of ['qa-background.js', 'qa-background-cdp.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, entry), '--one-synthetic-bank'], {
      cwd: path.dirname(__dirname), encoding: 'utf8', windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /EGP1 bank|EGP1 bank receipt|one-time EGP1/i);
  }
});

test('direct CDP call refuses to overwrite existing QA evidence even if given an arbitrary out and manifest', () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-qa-cdp-reject-'));
  const sentinel = path.join(own, 'native-report.json');
  fs.writeFileSync(sentinel, 'KEEP_PRIOR_EVIDENCE', { flag:'wx' });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'qa-background-cdp.js'),
    '--port=9333', `--out=${own}`, `--manifest=${path.join(own, 'nonexistent-manifest.json')}`],
  { cwd:path.dirname(__dirname), encoding:'utf8',windowsHide:true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Refusing CDP output directory/);
  assert.equal(fs.readFileSync(sentinel,'utf8'), 'KEEP_PRIOR_EVIDENCE');
  const plausible = fs.mkdtempSync(path.join(os.tmpdir(),'pharma-background-qa-'));
  const withoutLease = spawnSync(process.execPath,[path.join(__dirname,'qa-background-cdp.js'),
    '--port=9333',`--out=${plausible}`,`--manifest=${path.join(plausible,'fake.json')}`],
  {cwd:path.dirname(__dirname),encoding:'utf8',windowsHide:true});
  assert.notEqual(withoutLease.status,0);
  assert.match(`${withoutLease.stderr}\n${withoutLease.stdout}`, /runner lease missing/);
  assert.equal(fs.existsSync(path.join(plausible,'native-report.json')),false);
});

test('per-control coverage never promotes route rendering, duplicated labels, or source inventory to behavioral verification', () => {
  const native = { routes: [{ route: '/purchase-orders', status: 'pass', controls: [
    { i: 0, tag: 'button', label: 'Pending' },
    { i: 1, tag: 'button', label: 'Delete' },
    { i: 2, tag: 'button', label: 'Delete' },
  ] }], behaviors: { scenarios: [
    { route: '/purchase-orders', action: 'filter Pending', status: 'verified', evidence: 'aria-pressed true' },
    { route: '/purchase-orders', action: 'open Delete', status: 'verified', evidence: 'dialog open' },
  ] } };
  const result = controlEvidence({ paths: ['/purchase-orders'] }, native,
    { controls: [{ source: 'PurchaseOrder.tsx', line: 10, tag: 'button', category: 'sensitive' }] });
  assert.deepEqual(result.runtime_controls.map(c => c.status), ['verified', 'untested', 'untested']);
  assert.equal(result.source_controls[0].status, 'untested');
  assert.equal(result.runtime_controls[0].financial_effect.startsWith('not inferred'), true);
});

test('source inventory distinguishes unverified UI controls from executed checks', () => {
  const result = catalog();
  assert.ok(result.source_files > 50);
  assert.ok(result.controls_found > 100);
  assert.ok(result.sensitive_manual_count > 0);
  assert.ok(result.controls.some(c => c.source.includes('AccountsManagementClient.tsx')));
  assert.ok(result.controls.every(c => c.coverage === 'source_inventoried_not_proven'));
});

test('exported static pages include high-risk real routes', () => {
  const routes = exportedRoutes();
  assert.ok(routes.length >= 60);
  for (const route of ['/pos', '/patients', '/purchases/suppliers', '/finance/handover']) {
    assert.ok(routes.includes(route), `missing exported route ${route}`);
  }
});

test('Jest summary preserves a failed suite rather than declaring a pass', () => {
  const result = summarizeJest('FAIL src/test.regression.tsx\nTest Suites: 1 failed, 20 passed\nTests: 1 failed, 100 passed\nTime: 3 s');
  assert.deepEqual(result.failures, ['src/test.regression.tsx']);
  assert.match(result.tests, /1 failed/);
});

test('partial native feature denials remain explicitly partial, never green or falsely fatal', () => {
  assert.equal(classifyNativeExit(2, 'partial'), 'partial');
  assert.equal(classifyNativeExit(1, 'partial'), 'fail');
  assert.equal(classifyNativeExit(0, 'pass'), 'pass');
  assert.equal(classifyNativeExit(0, 'partial'), 'fail');
});
