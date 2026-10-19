#!/usr/bin/env node
'use strict';

// Independently inspect ONE already-posted QA 054 receipt read-only, then use
// the actual authenticated Windows WebView2 native IPC to reconfirm it.
// NEVER invoke a financial writer or emit receipt fields, names, notes or IDs.
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const OWNER = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';

function certified(result) {
  return result?.custody === true && result?.qaSourceExact === true &&
    result?.nativeOriginalReceipt === true && result?.changedNonceNull === true &&
    result?.changedAmountNull === true && result?.noFinancialSubmit === true;
}

function readonlyWitness() {
  const python = String.raw`
import os, pathlib, sqlite3, json, hashlib
p=pathlib.Path(os.environ['APPDATA'])/'com.pharma.disposable.lifecycle.qa20261016'/'pharma_local.db'
db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
db.execute('PRAGMA query_only=ON')
rows=db.execute('''SELECT r.id,r.request_id,r.supplier_id,r.invoice_id,r.actor_id,r.pharmacy_id,
 r.amount_cents,r.payment_method,r.payment_date,r.balance_after_cents,st.notes
 FROM native_supplier_payment_receipts r
 JOIN supplier_transactions st ON st.id=r.supplier_transaction_id
 WHERE r.pharmacy_id=? AND r.actor_id=?''',('qa_lifecycle_20261016','qa_lifecycle_owner_20261016')).fetchall()
if len(rows)!=1: raise SystemExit(3)
r=rows[0]
if (r[6] is None or type(r[6])!=int or r[6]<=0 or r[7] not in ('bank','cash') or
    r[4]!='qa_lifecycle_owner_20261016' or r[5]!='qa_lifecycle_20261016'):
    raise SystemExit(4)
if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or db.execute('PRAGMA foreign_key_check').fetchone()!=None:
    raise SystemExit(5)
print(json.dumps(dict(id=r[0],requestId=r[1],supplierId=r[2],invoiceId=r[3],actorId=r[4],
  pharmacyId=r[5],amountCents=r[6],paymentMethod=r[7],date=r[8],
  remainingBalance=r[9]/100.0,notesSha256=hashlib.sha256((r[10] or '').encode('utf-8')).hexdigest())))
db.close()
`;
  const result = spawnSync('python', ['-B','-c',python], {
    encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:32768,
  });
  if (result.status!==0 || !result.stdout || result.stdout.length>4000) {
    throw Error('Pinned QA supplier 054 source is not independently certifiable');
  }
  const row=JSON.parse(result.stdout);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.requestId)
      || typeof row.supplierId!=='number' || !Number.isSafeInteger(row.amountCents)
      || row.actorId!==OWNER || row.pharmacyId!==TENANT
      || !/^[0-9a-f]{64}$/.test(row.notesSha256)) {
    throw Error('Old supplier source has no valid independent native receipt witness');
  }
  return row;
}

async function run(pid,sha,planPath) {
  verifiedPlan(planPath);
  assertCustody(pid,sha);
  const source=readonlyWitness();
  const targets=(await (await fetch('http://127.0.0.1:9334/json/list',{
    signal:AbortSignal.timeout(6000),
  })).json()).filter(t=>t.type==='page');
  const apps=targets.filter(t=>new URL(t.url).hostname==='tauri.localhost');
  if (apps.length!==1 || targets.length>2 ||
      new URL(apps[0].webSocketDebuggerUrl).hostname!=='127.0.0.1') {
    throw Error('QA CDP target is not unique');
  }
  const ws=new WebSocket(apps[0].webSocketDebuggerUrl);
  await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});});
  let next=0;const pending=new Map();
  ws.addEventListener('message',e=>{
    let msg;try{msg=JSON.parse(e.data)}catch{return}
    const w=pending.get(msg.id);if(!w)return;
    clearTimeout(w.timer);pending.delete(msg.id);
    msg.error?w.no(Error('CDP denied read-only verification')):w.ok(msg.result);
  });
  const send=(method,params)=>new Promise((ok,no)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);no(Error('Read-only CDP timeout'))},18000);
    pending.set(id,{ok,no,timer});ws.send(JSON.stringify({id,method,params}));
  });
  try {
    await send('Runtime.enable',{});
    const input={supplierId:source.supplierId,amount:source.amountCents/100,
      paymentMethod:source.paymentMethod,date:source.date,
      requestId:source.requestId,notesSha256:source.notesSha256};
    // ONLY the read-only Tauri confirmation command appears in this snippet.
    const expression=`(async()=>{
      const invoke=window.__TAURI_INTERNALS__?.invoke;
      if(typeof invoke!=='function')return {nativeOriginalReceipt:false};
      const actor=await invoke('current_local_user');
      if(actor?.id!==${JSON.stringify(OWNER)}||actor?.pharmacy_id!==${JSON.stringify(TENANT)})
        return {nativeOriginalReceipt:false};
      const i=${JSON.stringify(input)};
      const original=await invoke('confirm_supplier_payment_native',{payload:i});
      const changedNonce={...i,requestId:${JSON.stringify(crypto.randomUUID())}};
      const changedAmount={...i,amount:i.amount+0.01};
      const nonce=await invoke('confirm_supplier_payment_native',{payload:changedNonce});
      const amount=await invoke('confirm_supplier_payment_native',{payload:changedAmount});
      return {nativeOriginalReceipt:!!original&&original.id===${JSON.stringify(source.id)}
        &&original.invoiceId===${JSON.stringify(source.invoiceId)}
        &&original.actorId===${JSON.stringify(OWNER)}
        &&original.pharmacyId===${JSON.stringify(TENANT)}
        &&original.supplierId===i.supplierId
        &&original.amountCents===${Number(source.amountCents)}
        &&Math.abs(original.remainingBalance-${Number(source.remainingBalance)})<0.000001,
        changedNonceNull:nonce===null,changedAmountNull:amount===null};
    })()`;
    const packet=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(packet.exceptionDetails)throw Error('Authenticated source confirmation UI runtime failed');
    const v=packet.result?.value;
    const result={custody:true,qaSourceExact:true,
      nativeOriginalReceipt:v?.nativeOriginalReceipt===true,
      changedNonceNull:v?.changedNonceNull===true,
      changedAmountNull:v?.changedAmountNull===true,
      noFinancialSubmit:true};
    console.log('PINNED_QA_054_READONLY_RECEIPT_CONFIRMATION='+JSON.stringify(result));
    if(!certified(result)) process.exitCode=2;
  }finally{ws.close()}
}

if(require.main===module) {
  run(Number(process.argv[2]),String(process.argv[3]||'').toUpperCase(),String(process.argv[4]||''))
    .catch(()=>{console.error('PINNED_QA_054_READONLY_RECEIPT_CONFIRMATION=BLOCKED_NO_POST');process.exitCode=2});
}
module.exports={certified};
