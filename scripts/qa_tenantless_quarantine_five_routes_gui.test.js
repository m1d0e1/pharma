'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {ROUTES,blocked,accepted,probeExpression}=require('./qa_tenantless_quarantine_five_routes_gui');
test('the original five routes are exactly frozen and each probes native denial only',()=>{
  assert.deepEqual(ROUTES,['/reports/purchases','/reports/sales','/inventory','/patients','/returns']);
  for(const route of ROUTES){
    const expr=probeExpression(route);
    assert.deepEqual([...expr.matchAll(/await call\('([^']+)'/g)].map(x=>x[1]),['license_status']);
    assert.match(expr,/startup_upgrade_blocked/);
    assert.doesNotMatch(expr,/(create_return_critical|create_purchase_invoice|process_checkout_critical|db_execute|setItem\(|\.click\()/i);
  }
});
test('every independent denial fact is required',()=>{
  const valid=Object.fromEntries(Object.keys(blocked()).map(key=>[key,true]));
  assert.equal(accepted(valid),true);
  for(const key of Object.keys(valid))assert.equal(accepted({...valid,[key]:false}),false);
  assert.ok(Object.values(blocked()).every(value=>value===false));
});
test('a default runner cannot open any GUI, file, license or database',()=>{
  const r=spawnSync(process.execPath,[path.join(__dirname,'qa_tenantless_quarantine_five_routes_gui.js')],{
    windowsHide:true,encoding:'utf8',timeout:10000,
  });
  assert.equal(r.status,2);
  assert.equal(r.stderr,'');
  assert.deepEqual(JSON.parse(r.stdout.trim().split('=')[1]),blocked());
});
