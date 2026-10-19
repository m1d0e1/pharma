'use strict';
const { randomUUID } = require('node:crypto');

// Match the actual Rust source validation errors, not arbitrary IPC failure.
// A missing command, expired license, refused actor, or broken bridge is NOT
// proof that an intentionally invalid financial request was validated.
const expectedDenials = {
  invalid_request_uuid: /Invalid supplier payment request ID/,
  rejected_check_tender: /Invalid supplier payment request(?! ID)/,
  negative_cent_amount: /Supplier tender must be a positive exact-cent amount/,
  invalid_calendar_date: /Invalid supplier payment request(?! ID)/,
  forged_tenant_key_disallowed: /unknown field.{0,70}pharmacyId|pharmacyId.{0,70}unknown field/i,
  overpay_remaining_payable: /Supplier balance or supplier ledger lacks canonical provenance/,
};
function isExpectedSupplierRejection(id, rejection) {
  return typeof rejection === 'string' && expectedDenials[id]?.test(rejection) === true;
}

// These are intentionally rejected IPC calls on the independently owned BG
// synthetic database. Never retry an ambiguous request or submit a valid
// settlement as part of the generic UI sweep.
async function verifyRejectedSupplierInputs(client) {
  const cases = [
    { id:'invalid_request_uuid', payload: {
      supplierId:1001,amount:1,paymentMethod:'bank',date:'2026-10-14',
      notes:'QA synthetic validation only',requestId:'not-a-uuid' } },
    { id:'rejected_check_tender', payload: {
      supplierId:1001,amount:1,paymentMethod:'check',date:'2026-10-14',
      notes:'QA synthetic validation only',requestId:randomUUID() } },
    { id:'negative_cent_amount', payload: {
      supplierId:1001,amount:-1,paymentMethod:'bank',date:'2026-10-14',
      notes:'QA synthetic validation only',requestId:randomUUID() } },
    { id:'invalid_calendar_date', payload: {
      supplierId:1001,amount:1,paymentMethod:'bank',date:'2026-02-30',
      notes:'QA synthetic validation only',requestId:randomUUID() } },
    { id:'forged_tenant_key_disallowed', payload: {
      supplierId:1001,amount:1,paymentMethod:'bank',date:'2026-10-14',
      pharmacyId:'foreign-tenant',notes:'QA synthetic validation only',
      requestId:randomUUID() } },
    { id:'overpay_remaining_payable', payload: {
      supplierId:1001,amount:295.01,paymentMethod:'bank',date:'2026-10-14',
      notes:'QA synthetic overpay rejection only',requestId:randomUUID() } },
  ];
  const evidence = [];
  for (const test of cases) {
    const result = await client.evaluate(`(async () => {
      try {
        const receipt=await window.__TAURI_INTERNALS__.invoke('post_supplier_payment_native',
          {payload:${JSON.stringify(test.payload)}});
        return {accepted:true,hasReceipt:!!receipt?.id};
      } catch(error) {
        return {accepted:false,rejected:String(error).slice(0,160)};
      }
    })()`);
    const validated = result?.accepted === false
      && isExpectedSupplierRejection(test.id, result.rejected);
    evidence.push({id:test.id,
      status:validated ? 'verified_rejection' : result?.accepted ? 'failed_unexpected_acceptance' : 'blocked_unexpected_native_error',
      error_class:validated ? 'expected_native_validation_denial' : 'unexpected_bridge_license_actor_or_validation_error' });
    if (!validated) break; // fail closed; do not make further money requests
  }
  return { scope:'true_Tauri_native_supplier_writer_synthetic_BG_only',
    no_legitimate_request_replay:true,
    cases:evidence, status:evidence.length===cases.length
      && evidence.every(row=>row.status==='verified_rejection') ? 'pass' : 'fail' };
}

module.exports = { verifyRejectedSupplierInputs, isExpectedSupplierRejection };
