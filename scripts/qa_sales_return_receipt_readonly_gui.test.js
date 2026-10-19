'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { accepted, blocked } = require('./qa_sales_return_receipt_readonly_gui');

test('receipt witness requires every exact boolean and defaults blocked', () => {
  const good=Object.fromEntries(Object.keys(blocked()).map(key=>[key,true]));
  assert.equal(accepted(good),true);
  for(const key of Object.keys(good)){
    assert.equal(accepted({...good,[key]:false}),false);
    assert.equal(accepted({...good,[key]:null}),false);
  }
  assert.ok(Object.values(blocked()).every(value=>value===false));
});

test('unverified runner cannot attach or touch finance without explicit opt-in', () => {
  const result=spawnSync(process.execPath,[path.join(__dirname,'qa_sales_return_receipt_readonly_gui.js')],
    {encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,2);
  assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout.trim().split('=')[1]),blocked());
});

test('WebView native snippet never posts a sale, cash or return transaction', () => {
  const source=fs.readFileSync(path.join(__dirname,'qa_sales_return_receipt_readonly_gui.js'),'utf8');
  const invokes=[...source.matchAll(/await invoke\('([^']+)'/g)].map(item=>item[1]);
  assert.deepEqual(invokes,[
    'current_local_user', 'confirm_sales_return_native',
    'confirm_sales_return_native', 'confirm_sales_return_native',
  ]);
  assert.doesNotMatch(source,/await invoke\('(create_return_critical|process_checkout_critical|post_patient_payment_native|create_master_drug_native)'/);
  assert.doesNotMatch(source,/\.click\(|Page\.navigate|db\.executescript\(/);
  assert.doesNotMatch(source,/db\.execute\(\s*['"]\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)/i);
  assert.match(source,/PRAGMA query_only=ON/);
  assert.match(source,/assertCustody\(pid,sha\)/);
});
