'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accepted } = require('./qa_connected_forms_negative_gui');

test('connected GUI denial evidence requires every actual no-posting form condition', () => {
  const facts = {
    actorTenantVerified:true,nativeCatalogFormOpened:true,catalogRequiredPriceBlocked:true,
    supplierAmountRequired:true,supplierDialogClosedNoSubmit:true,patientFinanceVisible:true,
    walletNoAmountSubmitted:true,returnUnknownNoRefund:true,noFinancialSubmit:true,
  };
  assert.equal(accepted(facts),true);
  for (const k of Object.keys(facts)) {
    assert.equal(accepted({...facts,[k]:false}),false,k);
  }
  assert.equal(accepted(null),false);
});
