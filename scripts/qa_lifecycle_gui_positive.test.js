'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  parseOptions,validatePlan,validateAction,validateProof,dryRun,verifyManifest,
  STAGE_B,IDENTITY,ACTOR,TENANT,CDP_PORT,
} = require('./qa_lifecycle_gui_positive');

const uuid = 'e1111111-1111-4111-8111-111111111111';
function stageAPlan() {
  return {identity:IDENTITY,actorId:ACTOR,tenantId:TENANT,
    runId:uuid,qaDataOnly:true,
    supplierName:'QA Supplier Independent 20261017',
    patientName:'QA Patient Independent 20261017'};
}
function stageBPlan() {
  return {...stageAPlan(),patientFinanceApproved:true,
    supplierOwnershipApproved:true,nativePostingApproved:true,stageACompleted:true,
    stageB:STAGE_B.map(([name,route],index)=>({
      name,route,nativeReceiptReviewRequired:true,
      precedingNativeReceiptIndependentlyVerified:index>0 ? true : undefined,
      actions:[{op:'click',selector:'#qa-real-form-submit',commit:true}],
      proof:[{kind:'exists',selector:'#qa-receipt-visible'}]
    })).map(step=>{
      if (['purchase-report','final-purchase-report'].includes(step.name)) {
        step.actions=[{op:'click',selector:'#qa-report-filters'}];
      }
      return step;
    })};
}

test('default runs are PURE dry-run, never requiring a manifest, port, app process, or AppData',()=>{
  assert.deepEqual(parseOptions([]),{execute:false,stage:'stage-a',step:null,
    manifest:undefined,plan:undefined,out:undefined,ownedPid:undefined});
  const stdout=execFileSync(process.execPath,[require.resolve('./qa_lifecycle_gui_positive'),'--dry-run','--stage','stage-b'],
    {encoding:'utf8',timeout:3000,env:{...process.env,APPDATA:'Z:\\must-not-be-read'}});
  const result=JSON.parse(stdout);
  assert.equal(result.mode,'OFFLINE_DRY_RUN_NO_GUI_OR_APPDATA_ACCESS');
  assert.equal(result.qaPort,CDP_PORT);
  assert.deepEqual(result.steps.map(s=>s.name),STAGE_B.map(s=>s[0]));
  assert.equal(dryRun('stage-a').financeViaRealDOMFormsOnly,true);
});
test('execution mode must pin single stage, exact PID, fresh out and explicit rebuild approval',()=>{
  assert.throws(()=>parseOptions(['--execute']),/confirmation/);
  assert.throws(()=>parseOptions(['--execute','--confirm-rebuilt-qa']),/requires exact/);
  assert.throws(()=>parseOptions(['--stage','stage-b','--execute','--confirm-rebuilt-qa',
    '--manifest','a','--plan','b','--out','c','--owned-pid','123']),/one known/);
  assert.throws(()=>parseOptions(['--dry-run','--execute']),/exactly one/);
  assert.throws(()=>parseOptions(['--stage','stage-z']),/Unknown/);
  const parsed=parseOptions(['--stage','stage-b','--step','pos','--execute','--confirm-rebuilt-qa',
    '--manifest','m','--plan','p','--out','o','--owned-pid','3456']);
  assert.equal(parsed.step,'pos');
});
test('synthetic actors and fresh-run provenance required; no legacy tenant or personally identifying names',()=>{
  assert.equal(validatePlan(stageAPlan(),'stage-a'),true);
  for(const invalid of [
    {identity:'com.pharma.system'},
    {actorId:'admin'},
    {tenantId:'local_default'},
    {runId:'not-a-uuid'},
    {supplierName:'Real Supplier'},
    {patientName:'QA P'},
    {qaDataOnly:false},
  ]) {
    assert.throws(()=>validatePlan({...stageAPlan(),...invalid},'stage-a'));
  }
  assert.throws(()=>validatePlan(stageAPlan(),'stage-b'),/requires/);
});
test('Stage B enforces exactly one committed click per financial form, sequential manual receipt proof',()=>{
  const valid=stageBPlan();
  assert.equal(validatePlan(valid,'stage-b'),true);
  const double=stageBPlan();
  double.stageB[0].actions.push({op:'click',selector:'#another',commit:true});
  assert.throws(()=>validatePlan(double,'stage-b'),/exactly one/);
  const missingManual=stageBPlan();
  missingManual.stageB[2].precedingNativeReceiptIndependentlyVerified=false;
  assert.throws(()=>validatePlan(missingManual,'stage-b'),/receipt verification/);
  const missingProof=stageBPlan();
  missingProof.stageB[4].proof=[];
  assert.throws(()=>validatePlan(missingProof,'stage-b'),/independent UI proof/);
});
test('single reviewed Stage B purchase never needs fabricated selectors for future financial stages',()=>{
  const plan=stageBPlan();
  plan.stageB=[plan.stageB[0]];
  plan.stageB[0].actions=[
    {op:'fill',selector:'#purchase-invoice-number',value:'QA-REVIEWED-01'},
    {op:'wait',selector:'#purchase-drug-search + div button'},
    {op:'click',selector:'button',text:'حفظ نهائي (F9)',commit:true},
  ];
  plan.stageB[0].precommitProof={kind:'textContains',selector:'body',expected:'462.00'};
  assert.equal(validatePlan(plan,'stage-b','purchase'),true);
  assert.throws(()=>validatePlan(plan,'stage-b','pos'),/ordered operator-reviewed|only the requested/i);
  assert.throws(()=>validatePlan(plan,'stage-b'),/requires/);
  assert.throws(()=>validateAction({op:'wait',selector:'#search',commit:true}),/Waiting/);
});
test('DOM action DSL cannot embed executable JavaScript or direct typed native financial calls',()=>{
  for(const invalid of [
    {op:'evaluate',selector:'document.body',value:'window.__TAURI_INTERNALS__.invoke(...)'},
    {op:'click',selector:'#qa',value:'inject'},
    {op:'fill',selector:'#qa',value:{}},
    {op:'fill',selector:'#qa',value:'x'.repeat(181)},
    {op:'select',selector:'#qa',value:'cash',commit:true},
    {op:'click',selector:'\n',commit:true},
  ]) assert.throws(()=>validateAction(invalid));
  assert.doesNotThrow(()=>validateAction({op:'click',selector:'button',text:'حفظ البيانات',commit:true}));
  assert.doesNotThrow(()=>validateProof({kind:'textContains',selector:'[data-test="receipt"]',expected:'462.00'}));
  assert.throws(()=>validateProof({kind:'textContains',selector:'#x'}));
});
test('manifest verification always refuses offline/non-approved environment BEFORE touching files',()=>{
  const original=process.env.PHARMA_QA_APPROVED_EXE_SHA256;
  const originalPid=process.env.PHARMA_QA_APPROVED_PID;
  try {
    delete process.env.PHARMA_QA_APPROVED_EXE_SHA256;
    delete process.env.PHARMA_QA_APPROVED_PID;
    assert.throws(()=>verifyManifest({identifier:IDENTITY,disposable:true},1234,'Z:\\never-read.json'),/Missing independent/);
  } finally {
    if(original===undefined)delete process.env.PHARMA_QA_APPROVED_EXE_SHA256;
    else process.env.PHARMA_QA_APPROVED_EXE_SHA256=original;
    if(originalPid===undefined)delete process.env.PHARMA_QA_APPROVED_PID;
    else process.env.PHARMA_QA_APPROVED_PID=originalPid;
  }
});
