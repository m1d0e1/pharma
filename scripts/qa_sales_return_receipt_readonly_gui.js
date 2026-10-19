#!/usr/bin/env node
'use strict';
// Opt-in, SHA-pinned actual WebView2 verification of an ALREADY-posted QA 043
// return. The sole business IPC is READ-ONLY confirmation; never a new refund.
const { assertCustody, verifiedPlan } = require('./qa_connected_gui_readonly');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const OWNER = 'qa_lifecycle_owner_20261016';
const TENANT = 'qa_lifecycle_20261016';
const SHA = /^[0-9A-F]{64}$/;
const FACTS = ['custody','owned043OriginalSource','nativeOriginalReceipt','wrongNonceNull','wrongAmountNull','sourceUnchanged','noRefundWriter'];
function blocked() { return Object.fromEntries(FACTS.map(key=>[key,false])); }
function accepted(result) { return FACTS.every(key=>result?.[key]===true); }
function witness() {
  const py = String.raw`
import sqlite3,os,pathlib,hashlib,json
p=pathlib.Path(os.environ['APPDATA'])/'com.pharma.disposable.lifecycle.qa20261016'/'pharma_local.db'
db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,timeout=5)
db.execute('PRAGMA query_only=ON')
if db.execute('PRAGMA integrity_check').fetchone()!=('ok',) or db.execute('PRAGMA foreign_key_check').fetchone()!=None:raise SystemExit(3)
source=db.execute('''SELECT p.return_id,p.request_id,p.sale_id,p.actor_id,p.pharmacy_id,p.refund_method,p.refund_micros
 FROM native_sale_return_cogs_provenance p JOIN returns r ON r.id=p.return_id
 WHERE p.pharmacy_id=? AND p.actor_id=?''',('qa_lifecycle_20261016','qa_lifecycle_owner_20261016')).fetchall()
if len(source)!=1:raise SystemExit(4)
rid,nonce,sale,actor,tenant,rail,micros=source[0]
if type(micros)!=int or micros<0 or micros%10000!=0 or rail not in ('cash','bank','wallet','patient_account'):raise SystemExit(5)
lines=db.execute('''SELECT ri.sale_item_id,ri.inventory_id,ri.quantity_returned,ri.unit
 FROM return_items ri WHERE ri.return_id=? ORDER BY ri.sale_item_id''',(rid,)).fetchall()
if not 0<len(lines)<=200:raise SystemExit(6)
tuples=[]
for sale_item,lot,qty,unit in lines:
 n=round(qty*1000000)
 if type(sale_item)!=int or not isinstance(lot,str) or not lot or n<=0 or abs(qty*1000000-n)>0.000001:raise SystemExit(7)
 tuples.append([sale_item,lot,n,unit])
digest=hashlib.sha256(json.dumps(tuples,ensure_ascii=False,separators=(',',':')).encode('utf8')).hexdigest()
print(json.dumps(dict(id=rid,requestId=nonce,invoiceId=sale,actorId=actor,pharmacyId=tenant,refundMethod=rail,amountCents=micros//10000,lineSha256=digest)))
db.close()
`;
  const got=spawnSync('python',['-B','-c',py],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4096});
  if(got.status!==0||!got.stdout||got.stdout.length>2048)throw Error('Unverified original QA 043 receipt source');
  const row=JSON.parse(got.stdout);
  if(row.actorId!==OWNER||row.pharmacyId!==TENANT||!Number.isSafeInteger(row.amountCents)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.requestId)||
    !/^[0-9a-f]{64}$/.test(row.lineSha256))throw Error('Unverifiable QA return source');
  return row;
}
async function run(args) {
  if(args.length!==5||args[0]!=='--execute'||args[1]!=='--exclusive-confirm')throw Error('Exact opt-in required');
  const pid=Number(args[2]),sha=String(args[3]),plan=args[4];
  if(!Number.isSafeInteger(pid)||pid<100||!SHA.test(sha))throw Error('Pinned custody missing');
  verifiedPlan(plan);assertCustody(pid,sha);
  const before=witness();
  assertCustody(pid,sha);
  const tabs=await(await fetch('http://127.0.0.1:9334/json/list',{signal:AbortSignal.timeout(6000)})).json();
  if(!Array.isArray(tabs)||tabs.length>2||tabs.some(t=>t.type!=='page'))throw Error('Ambiguous QA target');
  const apps=tabs.filter(t=>{try{return new URL(t.url).hostname==='tauri.localhost'}catch{return false}});
  if(apps.length!==1||tabs.some(t=>t!==apps[0]&&new URL(t.url).hostname!=='downloads-hub'))throw Error('Foreign target');
  const target=new URL(apps[0].webSocketDebuggerUrl);
  if(target.protocol!=='ws:'||target.hostname!=='127.0.0.1'||target.port!=='9334')throw Error('Unowned WebView2');
  assertCustody(pid,sha);
  const ws=new WebSocket(target.href);
  await new Promise((yes,no)=>{ws.addEventListener('open',yes,{once:true});ws.addEventListener('error',no,{once:true})});
  let index=0;const pending=new Map();
  ws.addEventListener('message',e=>{let item;try{item=JSON.parse(e.data)}catch{return}const task=pending.get(item.id);if(!task)return;pending.delete(item.id);clearTimeout(task.timer);item.error?task.no(Error('CDP rejected')):task.yes(item.result)});
  const send=(method,params)=>new Promise((yes,no)=>{const id=++index,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout'))},18000);pending.set(id,{yes,no,timer});ws.send(JSON.stringify({id,method,params}))});
  try {
    await send('Runtime.enable',{});
    const input={requestId:before.requestId,invoiceId:before.invoiceId,refundMethod:before.refundMethod,amountCents:before.amountCents,lineSha256:before.lineSha256};
    const expression=`(async()=>{
      const invoke=window.__TAURI_INTERNALS__?.invoke;
      if(typeof invoke!=='function')return {};
      const actor=await invoke('current_local_user');
      if(actor?.id!==${JSON.stringify(OWNER)}||actor?.pharmacy_id!==${JSON.stringify(TENANT)})return {};
      const input=${JSON.stringify(input)};
      const original=await invoke('confirm_sales_return_native',{payload:input});
      const wrongNonce=await invoke('confirm_sales_return_native',{payload:{...input,requestId:${JSON.stringify(randomUUID())}}});
      const wrongAmount=await invoke('confirm_sales_return_native',{payload:{...input,amountCents:input.amountCents+1}});
      return {nativeOriginalReceipt:!!original&&original.id===${JSON.stringify(before.id)}
          &&original.actorId===${JSON.stringify(OWNER)}&&original.pharmacyId===${JSON.stringify(TENANT)}
          &&original.requestId===input.requestId&&original.lineSha256===input.lineSha256,
        wrongNonceNull:wrongNonce===null,wrongAmountNull:wrongAmount===null};
    })()`;
    const packet=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(packet?.exceptionDetails)throw Error('Native read-only return evaluation failed');
    const after=witness();assertCustody(pid,sha);
    const values=packet.result?.value;
    const result={custody:true,owned043OriginalSource:true,
      nativeOriginalReceipt:values?.nativeOriginalReceipt===true,
      wrongNonceNull:values?.wrongNonceNull===true,wrongAmountNull:values?.wrongAmountNull===true,
      sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),noRefundWriter:true};
    if(!accepted(result))throw Error('Real 043 source confirmation incomplete');
    return result;
  }finally{ws.close()}
}
if(require.main===module){run(process.argv.slice(2)).then(r=>console.log('PINNED_QA_043_READONLY_RETURN='+JSON.stringify(r))).catch(()=>{console.log('PINNED_QA_043_READONLY_RETURN='+JSON.stringify(blocked()));process.exitCode=2})}
module.exports={blocked,accepted};
