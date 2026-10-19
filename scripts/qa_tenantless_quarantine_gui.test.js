'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {blocked,accepted,expression}=require('./qa_tenantless_quarantine_gui');

test('quarantine requires each independent native and GUI fact',()=>{
  const valid=Object.fromEntries(Object.keys(blocked()).map(k=>[k,true]));
  assert.equal(accepted(valid),true);
  for(const field of Object.keys(valid)){
    assert.equal(accepted({...valid,[field]:false}),false);
    assert.equal(accepted({...valid,[field]:null}),false);
  }
  assert.deepEqual(Object.values(blocked()),Array(10).fill(false));
});

test('native quarantine expression contains only read-only status and gated identity commands',()=>{
  const script=expression();
  assert.deepEqual([...script.matchAll(/await invoke\('([^']+)'/g)].map(m=>m[1]),
    ['license_status','current_local_user']);
  assert.doesNotMatch(script,/(create_return_critical|process_checkout_critical|db_execute_guarded|license_install|CREATE\s+TABLE|UPDATE\s+users)/i);
  assert.doesNotMatch(script,/(\.click\(|Page\.navigate|localStorage|sessionStorage)/);
  assert.match(script,/startup_upgrade_blocked/);
});

test('default invocation never connects to browser or database',()=>{
  const r=spawnSync(process.execPath,[path.join(__dirname,'qa_tenantless_quarantine_gui.js')],{
    encoding:'utf8',windowsHide:true,timeout:10000,
  });
  assert.equal(r.status,2);
  assert.equal(r.stderr,'');
  assert.deepEqual(JSON.parse(r.stdout.trim().split('=')[1]),blocked());
});
