'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Forensic reference only: the EGP1 synthetic payment was already posted,
// independently reconciled, and must NEVER be replayed. Retain the original
// one-off algorithm for historical review, but fail at entry even if somebody
// imports this helper outside the disabled CLI path.
const ONE_TIME_PAYMENT_REPLAY_ENABLED = false;

// Explicit one-off POSITIVE synthetic issuer-independent native integration.
// Do not invoke in the generic route sweep, do not retry an ambiguous commit.
async function postOneVerifiedSyntheticBankPayment(client, out, audit) {
  if (!ONE_TIME_PAYMENT_REPLAY_ENABLED)
    throw new Error('Previously verified synthetic EGP1 bank payment is permanently disabled; no retry or new request ID');
  if (audit?.status !== 'limited_no_findings' || audit.scannedJournals !== 4
      || audit.findings !== 0 || audit.unverifiableLegacyJournals !== 0) {
    return { status:'blocked', reason:'Exactly four original verified journals are required' };
  }
  const requestId = randomUUID();
  const payload = {supplierId:1001,amount:1,paymentMethod:'bank',date:'2026-10-14',
    notes:'One-off isolated QA BG EGP 1 bank payment to exercise migration 059',requestId};
  const intent = path.join(out, 'one-time-supplier-bank-intent.json');
  // Durable pre-submit evidence survives ambiguous native IPC acknowledgements.
  fs.writeFileSync(intent, JSON.stringify({ status:'request_prepared_not_confirmed',
    synthetic_only:true,requestId,amount_cents:100,payment_method:'bank',
    source_supplier_id:1001,expected_prior_balance_cents:29500 },null,2),
  {flag:'wx'});
  let result;
  try {
    result = await client.evaluate(`(async()=>{
      try {
        const r=await window.__TAURI_INTERNALS__.invoke('post_supplier_payment_native',
          {payload:${JSON.stringify(payload)}});
        return {accepted:true,receipt_id:r.id,remaining_balance:r.remainingBalance};
      }catch(e){return {accepted:false,error:String(e).slice(0,140)};}
    })()`);
  } catch (error) {
    return {status:'unverifiable',requestId,
      reason:'IPC acknowledgement ambiguous; DO NOT resubmit; inspect SQLite read-only'};
  }
  return {status:result?.accepted === true && typeof result.receipt_id === 'string'
    && result.receipt_id.length === 36 && result.remaining_balance === 294
      ? 'posted_pending_independent_SQLite_verification'
      : 'not_confirmed_do_not_retry',
    requestId,receipt_id:result?.receipt_id || null,
    remaining_balance:result?.remaining_balance ?? null,
    synthetic_bank_amount_cents:100,
    repeat_allowed:false};
}

module.exports = {postOneVerifiedSyntheticBankPayment};
