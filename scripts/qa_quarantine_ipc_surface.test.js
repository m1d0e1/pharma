'use strict';

// Static, fail-closed regression for the quarantined native IPC surface.
// Node built-ins only. Never launches Tauri, opens AppData or connects to SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'src-tauri', 'src', 'main.rs');
const LICENSING = path.join(ROOT, 'src-tauri', 'src', 'licensing.rs');
const CAPABILITIES = path.join(ROOT, 'src-tauri', 'capabilities');
const EXPECTED_EXCEPTIONS = Object.freeze([
  'license_status',
  'license_install',
  'license_activate_online',
  'license_renew_online',
  'db_transaction_abort',
]);
const EXPECTED_PERMISSIONS = Object.freeze([
  'core:default',
  'core:window:allow-create',
  'core:webview:allow-create-webview-window',
  'dialog:default',
  'updater:default',
  'process:default',
  'core:app:default',
]);
const EXPECTED_PLUGINS = Object.freeze([
  'tauri_plugin_sql::Builder::default().add_migrations("sqlite:pharma_local.db",migrations).build()',
  'tauri_plugin_dialog::init()',
  'tauri_plugin_updater::Builder::new().build()',
  'tauri_plugin_process::init()',
]);

function source(file) {
  return fs.readFileSync(file, 'utf8');
}

// Strip comments while keeping Rust string literals. A fake guard hidden in
// a comment must not satisfy the security assertion. Unterminated comments
// and strings fail closed.
function uncommentRust(input) {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const raw = /^(?:b?r)(#{0,12})"/.exec(input.slice(i));
    const char = /^'(?:[^'\\]|\\.)'/.exec(input.slice(i));
    if (raw) {
      const terminator = '"' + raw[1];
      const end = input.indexOf(terminator, i + raw[0].length);
      assert.ok(end >= 0, 'unterminated Rust raw string');
      out += input.slice(i, end + terminator.length);
      i = end + terminator.length;
    } else if (char) {
      out += char[0];
      i += char[0].length;
    } else if (input[i] === '"') {
      let end = i + 1;
      for (; end < input.length; end++) {
        if (input[end] === '\\') {
          end++;
        } else if (input[end] === '"') {
          break;
        }
      }
      assert.ok(end < input.length, 'unterminated Rust string');
      out += input.slice(i, end + 1);
      i = end + 1;
    } else if (input.startsWith('//', i)) {
      const newline = input.indexOf('\n', i + 2);
      if (newline === -1) break;
      out += '\n';
      i = newline + 1;
    } else if (input.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (depth > 0 && i < input.length) {
        if (input.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (input.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      assert.equal(depth, 0, 'unterminated Rust block comment');
      out += ' ';
    } else {
      out += input[i++];
    }
  }
  return out;
}

// Extract one balanced Rust parenthesized invocation, ignoring delimiters in
// string literals. Existing project syntax here has no raw-string arguments.
function argumentsOfCall(input, callName, { expected = 1 } = {}) {
  const occurrences = [...input.matchAll(
    new RegExp('\\.' + callName + '\\s*\\(', 'g'),
  )];
  assert.equal(occurrences.length, expected, `expected exactly ${expected} .${callName} call(s)`);
  return occurrences.map(({ index, 0: match }) => {
    const start = index + match.length;
    let depth = 1;
    let inString = false;
    let escaped = false;
    for (let i = start; i < input.length; i++) {
      const char = input[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (!depth) return input.slice(start, i);
      }
    }
    assert.fail(`unterminated .${callName}(...) call`);
  });
}

function requireExactGuard(mainSource) {
  const main = uncommentRust(mainSource);
  const invocation = argumentsOfCall(main, 'invoke_handler')[0];
  const handler = /^\s*\{\s*let\s+commands\s*:\s*fn\s*\(\s*tauri::ipc::Invoke\s*<\s*tauri::Wry\s*>\s*\)\s*->\s*bool\s*=\s*tauri::generate_handler!\s*\[([\s\S]*?)\]\s*;\s*([\s\S]*?)\s*\}\s*$/.exec(invocation);
  assert.ok(handler, 'app commands must be generated once inside the guarded invoke_handler block');
  const names = [...handler[1].matchAll(/\b([a-zA-Z_]\w*(?:::[a-zA-Z_]\w*)*)\s*,/g)].map(x => x[1]);
  assert.ok(names.length >= 80, 'missing native command registrations, inspect new dispatch wiring');
  assert.equal((handler[1].match(/tauri::generate_handler!/g) || []).length, 0);
  assert.ok(names.includes('commands::critical::db_select_guarded'), 'DB reader must be guarded');
  assert.ok(names.includes('commands::critical::db_execute_guarded'), 'DB writer must be guarded');
  assert.ok(names.includes('commands::master_drug_create_native::create_master_drug_native'));
  assert.ok(names.includes('commands::critical::db_transaction_abort'));
  assert.equal(new Set(names).size, names.length, 'duplicate command registration');

  // Deliberately use a strict whole-body shape. Otherwise inserting an
  // unguarded early return, dispatch, or unrelated fast path might pass a
  // fragile assertion checking only that the word 'enforce' occurs somewhere.
  const wrapper = /^\s*move\s*\|\s*invoke\s*:\s*tauri::ipc::Invoke\s*\|\s*\{\s*let\s+name\s*=\s*invoke\.message\.command\(\)\s*;\s*if\s+!\s*matches!\s*\(\s*name\s*,\s*([^)]*?)\s*\)\s*\{\s*let\s+webview\s*=\s*invoke\.message\.webview\(\)\s*;\s*let\s+state\s*=\s*webview\.app_handle\(\)\.state\s*::\s*<\s*licensing::LicenseGuard\s*>\s*\(\)\s*;\s*if\s+let\s+Err\s*\(\s*reason\s*\)\s*=\s*state\.enforce\(\)\s*\{\s*invoke\.resolver\.reject\s*\(\s*format!\s*\(\s*"License required: \{reason\}"\s*\)\s*\)\s*;\s*return\s+true\s*;\s*\}\s*\}\s*commands\s*\(\s*invoke\s*\)\s*\}\s*$/.exec(handler[2]);
  assert.ok(wrapper, 'LicenseGuard::enforce must reject and return before the ONLY commands(invoke) dispatch');
  const allowlistTokens = wrapper[1].trim().split(/\s*\|\s*/);
  const exceptions = allowlistTokens.map(token => {
    assert.match(token, /^"[a-z][a-z0-9_]*"$/, 'exceptions must be literal exact command names');
    return token.slice(1, -1);
  });
  assert.deepEqual(exceptions, EXPECTED_EXCEPTIONS, 'exception list must remain EXACTLY the five non-data commands');
  const registered = new Set(names.map(name => name.split('::').at(-1)));
  for (const name of exceptions) {
    assert.ok(registered.has(name), `exception ${name} must be a registered command`);
  }
  // A second handler anywhere could bypass this single central choke point.
  assert.equal((main.match(/\.invoke_handler\s*\(/g) || []).length, 1);
  assert.equal((main.match(/\bcommands\s*\(\s*invoke\s*\)/g) || []).length, 1);
  return { commandCount: names.length, exceptions };
}

function requireStartupFailClosed(licensingSource, mainSource) {
  const licensing = uncommentRust(licensingSource);
  const main = uncommentRust(mainSource);
  assert.match(licensing, /startup_ready\s*:\s*AtomicBool::new\s*\(\s*false\s*\)/,
    'LicenseGuard must start locked');
  assert.match(licensing, /pub\s+fn\s+enforce\s*\(\s*&self\s*\)\s*->\s*Result\s*<\s*\(\s*\)\s*,\s*String\s*>\s*\{\s*if\s+!self\.startup_ready\.load\s*\(\s*Ordering::Acquire\s*\)\s*\{\s*return\s+Err\s*\(/,
    'enforce must refuse startup_ready=false before further checks');
  const quarantine = main.indexOf('mark_legacy_upgrade_blocked()');
  const pool = main.indexOf('app.manage(commands::critical::GuardedReadPool(');
  const ready = main.indexOf('mark_startup_complete()');
  assert.ok(quarantine >= 0 && pool > quarantine && ready > pool,
    'quarantine must occur before native pool and startup readiness');
  const denial = main.slice(main.lastIndexOf('if let Err(error)', quarantine), pool);
  assert.match(denial, /mark_legacy_upgrade_blocked\s*\(\s*\)\s*;\s*return\s+Ok\s*\(\s*\(\s*\)\s*\)\s*;/,
    'quarantined setup must return before database startup');
}

function requireSafePlugins(mainSource) {
  const main = uncommentRust(mainSource);
  const plugins = argumentsOfCall(main, 'plugin', { expected: EXPECTED_PLUGINS.length })
    .map(plugin => plugin.replace(/\s+/g, '').replace(/,$/, ''));
  assert.deepEqual(plugins, EXPECTED_PLUGINS,
    'plugin surface changed; review new direct IPC capabilities for unsafe DB reads/writes');
}

function requireNoRawDatabaseCapability(capabilityFiles) {
  assert.deepEqual(Object.keys(capabilityFiles).sort(), ['default.json'],
    'new capability files require explicit native-data security review');
  const capability = JSON.parse(capabilityFiles['default.json']);
  assert.deepEqual(capability.windows, ['main', 'window_*']);
  assert.deepEqual(capability.permissions, EXPECTED_PERMISSIONS,
    'added ACL permission may bypass the guarded native invoke handler');
  // Defense in depth against nested/object-shaped or newly introduced SQL
  // permissions in the capability document.
  const walk = value => {
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /(?:^|[^\w])(?:sql|fs|shell|http):/i,
        'raw SQL, filesystem, shell or network plugin ACL must not be exposed');
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        walk(key);
        walk(item);
      }
    }
  };
  walk(capability.permissions);
}

function readCapabilityFiles() {
  const names = fs.readdirSync(CAPABILITIES);
  assert.ok(names.every(name => name.endsWith('.json')),
    'every capability file must be inspected');
  return Object.fromEntries(
    names.map(name => [name, source(path.join(CAPABILITIES, name))]),
  );
}

test('real v066 native IPC dispatch has one pre-dispatch LicenseGuard gate and exactly five exceptions', () => {
  const result = requireExactGuard(source(MAIN));
  assert.deepEqual(result.exceptions, EXPECTED_EXCEPTIONS);
  assert.ok(result.commandCount > 100);
});

test('real quarantine initializes fail-closed and never reaches native pool/readiness', () => {
  requireStartupFailClosed(source(LICENSING), source(MAIN));
});

test('real Tauri plugin builder list and capability ACL deny raw renderer database access', () => {
  requireSafePlugins(source(MAIN));
  requireNoRawDatabaseCapability(readCapabilityFiles());
});

test('adversarial IPC source mutations fail closed, not merely keyword-checked', () => {
  const main = source(MAIN);
  const substitutions = [
    ['state.enforce()', 'state.status()'],
    ['return true;', 'return false;'],
    ['commands(invoke)', 'commands(invoke); commands(invoke)'],
    ['if !matches!(name,', 'if matches!(name,'],
    ['let state = webview.app_handle().state::<licensing::LicenseGuard>();',
      'let state = webview.app_handle().state::<licensing::OtherGuard>();'],
    ['invoke.resolver.reject(format!("License required: {reason}"));', 'let _message = reason;'],
    ['"db_transaction_abort")', '"db_transaction_abort" | "db_select_guarded")'],
    ['"license_status" | "license_install"', '"license_status" | "db_execute_guarded" | "license_install"'],
    ['"license_renew_online" | "db_transaction_abort"', '"license_renew_online"'],
    ['commands(invoke)', 'if name == "db_select_guarded" { return commands(invoke); } commands(invoke)'],
    ['.invoke_handler({', '.invoke_handler(another_handler).invoke_handler({'],
    ['tauri::generate_handler![', 'tauri::generate_handler![commands::critical::db_execute_guarded,'],
  ];
  for (const [needle, replacement] of substitutions) {
    assert.ok(main.includes(needle), `fixture anchor not found: ${needle}`);
    assert.throws(() => requireExactGuard(main.replace(needle, replacement)),
      { name: 'AssertionError' }, `mutation must fail: ${needle}`);
  }
  const commentedGuard = main.replace('if let Err(reason) = state.enforce() {',
    '// if let Err(reason) = state.enforce() {\nif false {');
  assert.throws(() => requireExactGuard(commentedGuard), { name: 'AssertionError' });
});

test('adversarial licensing, plugin and capability changes are rejected', () => {
  const main = source(MAIN);
  const licensing = source(LICENSING);
  const capabilityFiles = readCapabilityFiles();
  assert.throws(() => requireStartupFailClosed(
    licensing.replace('startup_ready: AtomicBool::new(false)', 'startup_ready: AtomicBool::new(true)'),
    main,
  ), { name: 'AssertionError' });
  assert.throws(() => requireStartupFailClosed(
    licensing.replace('if !self.startup_ready.load(Ordering::Acquire)',
      'if self.startup_ready.load(Ordering::Acquire)'),
    main,
  ), { name: 'AssertionError' });
  assert.throws(() => requireSafePlugins(
    main.replace('.plugin(tauri_plugin_dialog::init())',
      '.plugin(tauri_plugin_fs::init()).plugin(tauri_plugin_dialog::init())'),
  ), { name: 'AssertionError' });
  const original = JSON.parse(capabilityFiles['default.json']);
  for (const permission of [
    'sql:default', 'sql:allow-select', 'sql:allow-load', 'sql:allow-execute',
    'sql:*', 'fs:allow-read-file', 'shell:allow-execute', 'http:default',
    { identifier: 'sql:allow-select' },
  ]) {
    const mutant = JSON.stringify({
      ...original, permissions: [...original.permissions, permission],
    });
    assert.throws(
      () => requireNoRawDatabaseCapability({ 'default.json': mutant }),
      { name: 'AssertionError' },
      `permission must fail: ${JSON.stringify(permission)}`,
    );
  }
  assert.throws(() => requireNoRawDatabaseCapability({
    ...capabilityFiles, 'unsafe.json': capabilityFiles['default.json'],
  }), { name: 'AssertionError' });
});
