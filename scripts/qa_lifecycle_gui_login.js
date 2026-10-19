'use strict';
// DOM form login into ONLY the separately licensed disposable lifecycle QA
// WebView2. The parent sends the DPAPI-restored test credential via stdin.
// Never print credentials, bearer status, patient/supplier or native user data.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const input = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; if (data.length > 1000) reject(Error('Oversize credential')); });
    process.stdin.on('end', () => resolve(JSON.parse(data)));
    process.stdin.on('error', reject);
  });
  if (input?.username !== 'qa_lifecycle_owner_20261016' || typeof input.password !== 'string' ||
      input.password.length < 20) throw Error('Invalid disposable lifecycle owner credential');
  const pages = (await (await fetch('http://127.0.0.1:9334/json/list')).json())
    .filter(page => page.type === 'page' && new URL(page.url).hostname === 'tauri.localhost');
  if (pages.length !== 1) throw Error('Not a unique lifecycle QA WebView');
  const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, bad) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', bad, { once: true }); });
  let seq = 0;
  const pend = new Map();
  socket.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (!pend.has(m.id)) return;
    const [ok, bad] = pend.get(m.id); pend.delete(m.id);
    m.error ? bad(Error(m.error.message)) : ok(m.result);
  });
  const ev = async expression => {
    const id = ++seq;
    const reply = await new Promise((ok, bad) => {
      pend.set(id, [ok, bad]);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (reply.exceptionDetails) throw Error('Native QA page evaluation failure');
    return reply.result?.value;
  };
  try {
    const initial = await ev('({page:location.pathname,native:!!window.__TAURI_INTERNALS__})');
    if (!initial?.native || initial.page !== '/login') throw Error('Lifecycle QA native login route not ready');
    const submitted = await ev(`(()=>{
      const u=document.querySelector('#login-username'),p=document.querySelector('#login-password');
      if(!u||!p)return false;
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(u,${JSON.stringify(input.username)});u.dispatchEvent(new Event('input',{bubbles:true}));
      setter.call(p,${JSON.stringify(input.password)});p.dispatchEvent(new Event('input',{bubbles:true}));
      const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('دخول للنظام المحلي'));
      if(!button)return false;button.click();return true;
    })()`);
    if (!submitted) throw Error('Disposable native login form submission failed');
    const started = Date.now();
    let page = '/login';
    for (let i = 0; i < 100; i++) {
      await wait(110);
      page = await ev('location.pathname');
      if (page === '/') break;
    }
    if (page !== '/') throw Error('Disposable tenant login did not reach dashboard');
    const session = await ev(`(async()=>{
      const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
      return {id:u?.id,pharmacy:u?.pharmacy_id,role:u?.role};
    })()`);
    if (session?.id !== 'qa_lifecycle_owner_20261016' ||
        session.pharmacy !== 'qa_lifecycle_20261016' || session.role !== 'owner')
      throw Error('Native actor ID/tenant/role mismatch: fail closed');
    console.log('LIFECYCLE_GUI_LOGIN=PASS');
    console.log('NATIVE_ISOLATED_ACTOR_AND_TENANT=PASS');
    console.log('AUTH_FORM_WALL_MS=' + (Date.now() - started));
  } finally {
    socket.close();
  }
}

main().catch(error => {
  console.error('LIFECYCLE_GUI_LOGIN_ERROR=' + String(error.message || error).slice(0, 140));
  process.exitCode = 1;
});
