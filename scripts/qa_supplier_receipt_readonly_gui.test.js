'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {certified}=require('./qa_supplier_receipt_readonly_gui');
test('054 GUI proof requires exact old receipt and denies changed nonce and money',()=>{
  const ok={custody:true,qaSourceExact:true,nativeOriginalReceipt:true,
    changedNonceNull:true,changedAmountNull:true,noFinancialSubmit:true};
  assert.equal(certified(ok),true);
  for(const name of Object.keys(ok))assert.equal(certified({...ok,[name]:false}),false,name);
  assert.equal(certified(null),false);
});
