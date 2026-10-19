#!/usr/bin/env node
'use strict';

// Privacy-preserving, read-only review of the existing disposable QA WebView2.
// One CDP session navigates a fixed allowlist serially. No arguments, SQL,
// request URLs, DOM text, user identifiers or exception descriptions are logged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PAGES = Object.freeze([
  '/', '/accounts', '/sales', '/sales/cogs', '/inventory', '/inventory/item-movements',
  '/patients', '/purchases', '/purchases/suppliers', '/reports/sales',
  '/reports/purchases', '/shifts', '/returns',
]);
// Additional static routes for opt-in connected lifecycle sampling. Keep the
// original 13-route default unchanged, and never accept arbitrary URLs.
const EXTENDED_PAGES = Object.freeze([
  '/inventory/low-stock', '/inventory/settlement', '/stores/adjustments',
  '/purchases/new', '/purchases/returns', '/purchases/returns/new',
  '/purchases/reports', '/returns/new', '/pos', '/sales/delivery',
  '/reports/trial-balance', '/finance/handover', '/receipts', '/audit',
  '/staff/manage', '/settings', '/stores/shortages', '/purchase-orders',
  '/accounts/cash-transactions', '/stores/items', '/inventory/opening-balances',
]);
const ALLOWED_PAGES = new Set([...PAGES, ...EXTENDED_PAGES]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function classifyConsoleSite(firstArg) {
  const site = typeof firstArg === 'string' ? firstArg.slice(0, 240).split(/[\r\n]/, 1)[0] : '';
  if (site.startsWith('Failed to fetch pharmacy name:')) return 'dashboard_layout_pharmacy_name';
  if (site.startsWith('Failed to sync native Administration menu:')) return 'dashboard_layout_native_menu';
  if (site === 'Failed to load tauri event API') return 'dashboard_layout_native_menu_listener';
  if (site.startsWith('Failed to load session:')) return 'dashboard_layout_session';
  if (site.startsWith('App initialization repair failed')) return 'app_initializer_repair';
  if (/^(Failed to load|Error loading).{0,100}(drugs|catalog).{0,60}(SQLite|cache)/i.test(site)) return 'secure_cache_catalog_load';
  if (site.startsWith('Failed to dynamic check session in sidebar:')) return 'sidebar_permission_refresh';
  if (site.startsWith('AuthGuard verification failed:')) return 'auth_guard';
  if (site.startsWith('Failed to load current shift:')) return 'dashboard_current_shift';
  if (site.startsWith('Failed to load current shift stats:')) return 'dashboard_shift_stats';
  if (site.startsWith('Failed to load dead stock:')) return 'dashboard_dead_stock';
  if (site.startsWith('Failed to load expiring items:')) return 'dashboard_expiring_items';
  if (site.startsWith('Failed to load reorder alerts')) return 'dashboard_reorder_alerts';
  if (site.startsWith('Failed to log login activity:')) return 'login_activity_log';
  if (site.startsWith('Error fetching server session:')) return 'server_session_read';
  if (site.startsWith('Failed to log audit event:')) return 'audit_event_write';
  if (site.startsWith('Failed to run database maintenance on client:')) return 'database_maintenance';
  if (site.startsWith('Failed to initialize database tables:')) return 'standalone_database_bootstrap';
  if (site.startsWith('Failed to log activity:')) return 'activity_log_write';
  if (site.startsWith('Failed to load dashboard data:')) return 'dashboard_data_load';
  if (site.startsWith('Failed to load inventory:')) return 'inventory_route_load';
  if (site.startsWith('Get inventory alerts error:')) return 'header_inventory_alerts_native_read_failure';
  if (site.startsWith('Failed to load patients:')) return 'patients_route_load';
  if (site.startsWith('secureCache unavailable in searchDrugsAction, searching DB only:')
      || site.startsWith('secureCache unavailable in searchMasterDrugsAction, searching DB only:')) return 'catalog_lookup_cache_fallback';
  if (site.startsWith('Reload catalog after cross-window catalog change')) return 'catalog_cross_window_reload';
  if (site.startsWith('Client Sync error:')) return 'background_sync';
  return 'unmapped';
}

// A one-route source-locator may count only this fixed enum. An unknown first
// argument must remain unknown: never export strings, hashes, descriptions,
// function names, request details or SQL fragments.
function classifyFirstArgument(first, site) {
  if (site !== 'unmapped') return 'recognized_source_prefix';
  if (!first || typeof first !== 'object') return 'missing_first_argument';
  if (first.type === 'string' || (first.type == null && typeof first.value === 'string')) return 'unrecognized_string';
  if (first.type === 'object' && first.subtype === 'error') return 'error_object';
  if (first.type === 'object') return 'other_object';
  return 'other_first_argument';
}

// CDP callFrame URLs are untrusted. Accept only Tauri's local Next.js JS
// chunks, including Next's app/pages subdirectories, and release just the
// basename and zero-based CDP coordinates. Paths, query strings, fragments,
// other origins, eval locations, source maps and arbitrary strings are denied.
function sanitizeStaticChunkFrame(frame) {
  if (!frame || typeof frame.url !== 'string') return null;
  const prefix = /^https?:\/\/tauri\.localhost\/_next\/static\/chunks\//.exec(frame.url);
  if (!prefix) return null;
  const parts = frame.url.slice(prefix[0].length).split('/');
  const basename = parts.pop();
  // All current exported Next chunk basenames use a numeric/hex chunk ID or
  // one of these fixed runtime/route labels plus a generated hex suffix.
  // Reject arbitrary named files even if they look like a JS chunk.
  if (!basename || !/^(?:\d{1,8}|[a-f0-9]{8}|main-app|main|framework|webpack|polyfills|layout|loading|page|not-found|route|_app|_error)[.-][a-f0-9]{8,32}\.js$/.test(basename)) return null;
  if (parts.length && (parts.length > 8 || !['app', 'pages'].includes(parts[0]) ||
      parts.some(segment => !/^[A-Za-z0-9_-]{1,64}$/.test(segment)
        && !/^\([A-Za-z0-9_-]{1,64}\)$/.test(segment)
        && !/^%28[A-Za-z0-9_-]{1,64}%29$/.test(segment)))) return null;
  if (!Number.isSafeInteger(frame.lineNumber) || frame.lineNumber < 0 || frame.lineNumber > 1_000_000 ||
      !Number.isSafeInteger(frame.columnNumber) || frame.columnNumber < 0 || frame.columnNumber > 10_000_000) return null;
  return { chunkBasename: basename, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber };
}

// Only fixed category labels escape this function. The text is transient: callers
// must never print, cache or serialize the raw event or source diagnostic.
function classifyDiagnostic(source, text = '') {
  // Exception descriptions often include multi-line stack frames and source
  // paths. A file/function named "database" or "TypeError" in a stack is not
  // evidence of a database failure or a thrown TypeError. Keep only the first
  // diagnostic line; no message or stack text ever leaves this classifier.
  const message = typeof text === 'string' ? text.slice(0, 4096).split(/[\r\n]/, 1)[0] : '';
  if (source === 'Runtime.exceptionThrown') return 'uncaught_runtime_exception';
  if (/hydration|React error #418|Text content does not match server/i.test(message)) return 'hydration_mismatch';
  if (/ChunkLoadError|Loading chunk [^\n]* failed|Failed to load chunk/i.test(message)) return 'chunk_load_failure';
  if (/strict renderer SQL|renderer.{0,32}SQL.{0,32}(denied|forbidden|blocked)|arbitrary.{0,32}SQL|SQL.*not.*permitted/i.test(message)) return 'renderer_sql_denied';
  if (/local_default|unreconciled legacy|independently explicit tenant ownership|unverifiable finance journal/i.test(message)) return 'finance_source_unverified';
  if (/not supported|not available|unavailable|غير متاح|غير مكتمل|تعذر التحقق/i.test(message)
      && /native|finance|account|treasury|shift|cash|رصيد|الخزنة|الدرج/i.test(message)) return 'explicit_unavailable';
  if (/unauthorized|not authorized|forbidden|access denied|permission denied|غير مصرح/i.test(message)) return 'authorization_denied';
  if (/ERR_ABORTED|canceled|cancelled|net::ERR_CONNECTION_ABORTED/i.test(message)) return 'canceled_navigation_or_request';
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|Failed to fetch|NetworkError|ERR_TIMED_OUT|Load failed/i.test(message)) return 'network_unavailable';
  if (/\bTypeError\b|is not a function|Cannot read properties of (null|undefined)/i.test(message)) return 'type_error';
  if (/\bReferenceError\b|is not defined/i.test(message)) return 'reference_error';
  if (/Failed to load resource|404 \(Not Found\)|status of 404|ERR_FILE_NOT_FOUND/i.test(message)) return 'resource_load_failure';
  if (/\bSQLITE_[A-Z_]+\b|\bSqliteError\b|\bsqlx\b|database is locked|\bdatabase\s+(?:query|read|write|open|connection|transaction|initialization)\s+(?:failed|error)|\b(?:database|sqlite)\s*error\b/i.test(message)) return 'database_error_other';
  if (/React error|Minified React error/i.test(message)) return 'react_error_other';
  return 'other_unclassified';
}

const policies = Object.freeze({
  uncaught_runtime_exception: 'investigate', hydration_mismatch: 'investigate',
  chunk_load_failure: 'investigate', type_error: 'investigate', reference_error: 'investigate',
  type_error_warning: 'investigate_handled_warning_source',
  reference_error_warning: 'investigate_handled_warning_source',
  network_warning: 'investigate_handled_warning_source_not_confirmed_network_outage',
  request_cancellation_warning: 'investigate_handled_warning_source_not_confirmed_network_cancel',
  database_error_other: 'investigate', react_error_other: 'investigate',
  resource_load_failure: 'investigate',
  cosmetic_pharmacy_config_read_failure: 'cosmetic_fallback_expected_review_native_display_name_read',
  initializer_repair_failure: 'investigate_initialization',
  secure_cache_catalog_read_failure: 'investigate_catalog_cache',
  header_inventory_alerts_native_read_failure: 'investigate',
  renderer_sql_denied: 'guard_expected_caller_review',
  finance_source_unverified: 'fail_closed_expected', explicit_unavailable: 'fail_closed_expected',
  authorization_denied: 'permission_context_review',
  canceled_navigation_or_request: 'review_unconfirmed_abort_context',
  canceled_network_request: 'review_request_cancel_window_not_proof_of_navigation_cause',
  request_abort_without_canceled_flag: 'investigate_abort_without_network_cancel_confirmation',
  network_unavailable: 'context_review_offline', other_unclassified: 'investigate',
});

function classifyHandledWarning(diagnostic) {
  if (diagnostic === 'type_error') return 'type_error_warning';
  if (diagnostic === 'reference_error') return 'reference_error_warning';
  if (diagnostic === 'network_unavailable') return 'network_warning';
  if (diagnostic === 'canceled_navigation_or_request') return 'request_cancellation_warning';
  return diagnostic;
}

function sanitizeEvent(message, locateFirstArg = false, firstConsoleError = false, context = {}) {
  const method = message?.method;
  if (method === 'Runtime.exceptionThrown') {
    return { category: classifyDiagnostic(method), origin: 'js_exception', site: 'runtime' };
  }
  if (method === 'Runtime.consoleAPICalled') {
    const type = message.params?.type;
    if (!['error', 'warning', 'warn', 'assert'].includes(type)) return null;
    const first = message.params?.args?.[0];
    // CDP supplies actual string console arguments in `value`. Never treat an
    // Error object's `description` as a trusted source prefix.
    const site = classifyConsoleSite((first?.type === 'string' || first?.type == null)
      && typeof first?.value === 'string' ? first.value : '');
    const description = (message.params?.args || []).slice(0, 8).map(arg => {
      const value = typeof arg?.value === 'string' ? arg.value
        : typeof arg?.description === 'string' ? arg.description : '';
      return value.slice(0, 512).split(/[\r\n]/, 1)[0];
    }).join(' ');
    const diagnostic = classifyDiagnostic(method, description);
    const category = site === 'dashboard_layout_pharmacy_name' ? 'cosmetic_pharmacy_config_read_failure'
      : site === 'app_initializer_repair' ? 'initializer_repair_failure'
      : site === 'secure_cache_catalog_load' ? 'secure_cache_catalog_read_failure'
      : type === 'error' && site === 'header_inventory_alerts_native_read_failure'
        ? 'header_inventory_alerts_native_read_failure'
      : (type === 'warning' || type === 'warn') ? classifyHandledWarning(diagnostic) : diagnostic;
    const sanitized = { category, origin: type === 'error' || type === 'assert' ? 'console_error' : 'console_warning', site };
    if (locateFirstArg) {
      const located = { ...sanitized, firstArgKind: classifyFirstArgument(first, site) };
      if (firstConsoleError && type === 'error') {
        // Inspect only the first CDP frame. If invalid, never fall through to
        // later frames/errors: that could misattribute the actual caller.
        return { ...located, firstConsoleErrorFrame:
          sanitizeStaticChunkFrame(message.params?.stackTrace?.callFrames?.[0]) };
      }
      if (context.firstConsoleWarning && (type === 'warning' || type === 'warn')) {
        return { ...located, firstConsoleWarningFrame:
          sanitizeStaticChunkFrame(message.params?.stackTrace?.callFrames?.[0]) };
      }
      return located;
    }
    return sanitized;
  }
  if (method === 'Log.entryAdded') {
    const type = message.params?.entry?.level;
    if (!['error', 'warning'].includes(type)) return null;
    const diagnostic = classifyDiagnostic(method, message.params?.entry?.text);
    return { category: type === 'warning' ? classifyHandledWarning(diagnostic) : diagnostic,
      origin: 'browser_log_' + type, site: 'browser_log' };
  }
  if (method === 'Network.loadingFailed') {
    // Do not inspect request IDs, URLs, headers, response bodies or payloads.
    if (message.params?.canceled === true) {
      // Only a temporal observation of our initiated navigation command.
      // `canceled` cannot show which component initiated the abort, so it must
      // never be treated as proof the navigation itself caused the request.
      const cancellationWindow = ['during_navigation_command', 'after_navigation_command']
        .includes(context.navigationPhase) ? context.navigationPhase : 'unknown';
      return { category: 'canceled_network_request', origin: 'network_failure', site: 'network', cancellationWindow };
    }
    const diagnostic = classifyDiagnostic(method, message.params?.errorText);
    return { category: diagnostic === 'canceled_navigation_or_request'
      ? 'request_abort_without_canceled_flag' : diagnostic, origin: 'network_failure', site: 'network' };
  }
  return null;
}

function sanitizeCollectedEvent(message, locateFirstArg, state) {
  const firstConsoleError = locateFirstArg && !state.firstConsoleErrorSeen &&
    message?.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error';
  if (firstConsoleError) state.firstConsoleErrorSeen = true;
  const firstConsoleWarning = locateFirstArg && !state.firstConsoleWarningSeen &&
    message?.method === 'Runtime.consoleAPICalled' &&
    ['warning', 'warn'].includes(message.params?.type);
  if (firstConsoleWarning) state.firstConsoleWarningSeen = true;
  return sanitizeEvent(message, locateFirstArg, firstConsoleError, {
    firstConsoleWarning, navigationPhase: state.navigationPhase,
  });
}

function summarizeEvents(events) {
  const categories = {};
  const origins = {};
  const sites = {};
  const firstArgKinds = {};
  let firstConsoleErrorFrame;
  let firstConsoleWarningFrame;
  const cancellationWindows = {};
  for (const entry of events) {
    if (!entry) continue;
    categories[entry.category] = (categories[entry.category] || 0) + 1;
    origins[entry.origin] = (origins[entry.origin] || 0) + 1;
    sites[entry.site] = (sites[entry.site] || 0) + 1;
    if (entry.firstArgKind) firstArgKinds[entry.firstArgKind] = (firstArgKinds[entry.firstArgKind] || 0) + 1;
    if (Object.prototype.hasOwnProperty.call(entry, 'firstConsoleErrorFrame')) {
      firstConsoleErrorFrame = entry.firstConsoleErrorFrame;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'firstConsoleWarningFrame')) {
      firstConsoleWarningFrame = entry.firstConsoleWarningFrame;
    }
    if (entry.cancellationWindow) {
      cancellationWindows[entry.cancellationWindow] = (cancellationWindows[entry.cancellationWindow] || 0) + 1;
    }
  }
  const aggregate = { total: events.filter(Boolean).length, categories, origins, sites };
  if (Object.keys(firstArgKinds).length) aggregate.firstArgKinds = firstArgKinds;
  if (firstConsoleErrorFrame !== undefined) aggregate.firstConsoleErrorFrame = firstConsoleErrorFrame;
  if (firstConsoleWarningFrame !== undefined) aggregate.firstConsoleWarningFrame = firstConsoleWarningFrame;
  if (Object.keys(cancellationWindows).length) aggregate.cancellationWindows = cancellationWindows;
  return aggregate;
}

function options(argv) {
  const result = { execute: false, locateFirstArgOnce: false, pid: 0, port: 0, expectedSha256: '', routeNames: PAGES, dwellMs: 1800 };
  for (const arg of argv) {
    if (arg === '--execute') result.execute = true;
    else if (arg === '--locate-first-arg-once') result.locateFirstArgOnce = true;
    else if (arg === '--exclusive-confirm') result.exclusiveConfirm = true;
    else if (/^--pid=\d+$/.test(arg)) result.pid = Number(arg.slice(6));
    else if (/^--port=\d+$/.test(arg)) result.port = Number(arg.slice(7));
    else if (/^--expected-sha256=[0-9a-fA-F]{64}$/.test(arg)) result.expectedSha256 = arg.slice(18).toUpperCase();
    else if (/^--dwell-ms=\d+$/.test(arg)) result.dwellMs = Number(arg.slice(11));
    else if (arg.startsWith('--routes=')) {
      const chosen = arg.slice(9).split(',');
      if (!chosen.length || chosen.some(route => !ALLOWED_PAGES.has(route)) || new Set(chosen).size !== chosen.length) {
        throw Error('Only distinct fixed QA routes are permitted');
      }
      result.routeNames = chosen;
    } else throw Error('Invalid console QA argument');
  }
  if (result.dwellMs < 500 || result.dwellMs > 8000) throw Error('Invalid sample dwell');
  if (result.locateFirstArgOnce && (!result.execute || result.routeNames.length !== 1)) {
    throw Error('First-argument locator requires --execute and exactly one fixed QA route');
  }
  if (result.execute && (!result.exclusiveConfirm || !Number.isSafeInteger(result.pid)
      || result.pid <= 0 || result.port !== 9334 || !/^[0-9A-F]{64}$/.test(result.expectedSha256))) {
    throw Error('Explicit current QA PID/executable SHA256/port and exclusive navigation confirmation are required');
  }
  return result;
}

function assertOwnedQaPort(pid, port, expectedSha256) {
  if (process.platform !== 'win32') throw Error('Disposable Windows QA required');
  const ps = `$parent=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`
    + `if(!$parent -or $parent.Name -notlike '*QA*' -or $parent.ExecutablePath -notlike '*pharma-builds\\optimized-offline-qa-20261016\\Pharma-0.2.109-optimized-offline-QA-*.exe'){exit 2};`
    + `if((Get-FileHash -LiteralPath $parent.ExecutablePath -Algorithm SHA256).Hash -ne '${expectedSha256}'){exit 7};`
    + `$listener=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);`
    + `if($listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1'){exit 3};`
    + '$child=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)";'
    + `if(!$child -or $child.Name -ne 'msedgewebview2.exe' -or $child.ParentProcessId -ne ${pid}){exit 4};`
    + `Write-Output 'OWNED_QA_WEBVIEW2'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.status !== 0 || !result.stdout.includes('OWNED_QA_WEBVIEW2')) {
    throw Error('Existing QA WebView2 ownership verification failed');
  }
}

function assertNavigatorIdle() {
  // A cooperative check for other Node/Python QA scripts. CDP does not expose
  // other clients; --exclusive-confirm additionally requires team coordination.
  const ps = `$others=@(Get-CimInstance Win32_Process | Where-Object {`
    + ` $_.ProcessId -ne ${process.pid} -and $_.Name -in @('node.exe','python.exe')`
    + ` -and $_.CommandLine -match '(qa-navigation-timing|qa_lifecycle_gui_|tauri-cdp-test|qa-console-classification)' });`
    + 'if($others.Count -gt 0){exit 5};Write-Output "NAVIGATOR_IDLE"';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.status !== 0 || !result.stdout.includes('NAVIGATOR_IDLE')) {
    throw Error('Another QA navigation command may be active');
  }
}

class CDP {
  constructor(websocketUrl) {
    this.socket = new WebSocket(websocketUrl);
    this.pending = new Map();
    this.sequence = 0;
    this.events = [];
    this.collect = false;
    this.locateFirstArg = false;
    this.firstConsoleErrorSeen = false;
    this.firstConsoleWarningSeen = false;
    this.navigationPhase = 'unknown';
    this.socket.addEventListener('message', ev => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      const pending = this.pending.get(data.id);
      if (pending) {
        this.pending.delete(data.id);
        clearTimeout(pending.timeout);
        data.error ? pending.reject(Error('CDP command failed')) : pending.resolve(data.result);
      } else if (this.collect) {
        const sanitized = sanitizeCollectedEvent(data, this.locateFirstArg, this);
        if (sanitized && this.events.length < 2000) this.events.push(sanitized);
      }
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('CDP connect timeout')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timeout); reject(Error('CDP connect failed')); }, { once: true });
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
  }
  async send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(Error('CDP command timeout')); }, 12000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw Error('Read-only page sampling failed');
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

const PAGE_STATE = `(() => ({
  path:location.pathname,
  hasTauri:!!window.__TAURI_INTERNALS__,
  hasMain:!!document.querySelector('main'),
  headings:document.querySelectorAll('main h1,main h2').length,
  busy:!!document.querySelector('main [aria-busy="true"],main .animate-spin'),
  alerts:document.querySelectorAll('main [role="alert"]').length,
  ready:document.readyState==='complete'
}))()`;

async function sample(client, route, dwellMs, locateFirstArg = false) {
  client.events = [];
  client.locateFirstArg = locateFirstArg;
  client.firstConsoleErrorSeen = false;
  client.firstConsoleWarningSeen = false;
  client.navigationPhase = 'during_navigation_command';
  client.collect = true;
  let state = null;
  let commandSucceeded = true;
  try { await client.send('Page.navigate', { url: 'http://tauri.localhost' + route }); }
  catch { commandSucceeded = false; }
  finally { client.navigationPhase = 'after_navigation_command'; }
  const start = Date.now();
  while (Date.now() - start < dwellMs) {
    await delay(150);
    try { state = await client.evaluate(PAGE_STATE); }
    catch { /* Reload destroys the old execution context briefly. */ }
  }
  client.collect = false;
  client.locateFirstArg = false;
  client.navigationPhase = 'unknown';
  const entries = client.events;
  client.events = [];
  return {
    route, navigationSucceeded: commandSucceeded,
    matchingRoute: state?.path === route,
    tauriBridge: state?.hasTauri === true,
    hasMain: state?.hasMain === true,
    headingCount: Number(state?.headings || 0), busy: state?.busy === true,
    visibleAlertCount: Number(state?.alerts || 0), ready: state?.ready === true,
    ...summarizeEvents(entries),
  };
}

let lastSanitizedProbeStage = 'options';
async function execute(opts) {
  lastSanitizedProbeStage = 'native_custody';
  assertOwnedQaPort(opts.pid, opts.port, opts.expectedSha256);
  lastSanitizedProbeStage = 'exclusive_navigator';
  assertNavigatorIdle();
  lastSanitizedProbeStage = 'cdp_target';
  const targets = await (await fetch(`http://127.0.0.1:${opts.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const pages = targets.filter(target => target.type === 'page');
  // A real WebView2 XLSX download can leave one Chromium downloads-hub page.
  // Never attach to or close it. Require exactly one Tauri origin and refuse
  // any other tab/origin, so extra arbitrary pages cannot inherit QA access.
  const applicationPages = pages.filter(target => {
    try { return new URL(target.url).hostname === 'tauri.localhost'; }
    catch { return false; }
  });
  const downloadHubs = pages.filter(target => {
    try { return new URL(target.url).hostname === 'downloads-hub'; }
    catch { return false; }
  });
  if (applicationPages.length !== 1 || downloadHubs.length > 1 ||
      pages.length !== applicationPages.length + downloadHubs.length) {
    throw Error('Expected exactly one QA app and at most one known WebView2 download hub');
  }
  const webpage = new URL(applicationPages[0].url);
  const ws = new URL(applicationPages[0].webSocketDebuggerUrl);
  if (webpage.hostname !== 'tauri.localhost' || ws.hostname !== '127.0.0.1' || Number(ws.port) !== opts.port) {
    throw Error('Unexpected QA CDP target');
  }

  const client = new CDP(applicationPages[0].webSocketDebuggerUrl);
  lastSanitizedProbeStage = 'cdp_connect';
  await client.open();
  const report = {
    purpose: opts.locateFirstArgOnce ? 'sanitized_one_route_first_argument_locator'
      : 'sanitized_disposable_qa_console_classification',
    qaPid: opts.pid, port: opts.port, categoryPolicy: policies,
    includesRawPayloads: false, samples: [],
  };
  try {
    lastSanitizedProbeStage = 'native_actor';
    const authorized = await client.evaluate(`(async()=>{
      try { const user=await window.__TAURI_INTERNALS__.invoke('current_local_user');
        return !!user && user.role==='owner' && user.id==='qa_lifecycle_owner_20261016'
          && user.pharmacy_id==='qa_lifecycle_20261016';
      } catch { return false; }
    })()`);
    if (!authorized) throw Error('Native QA actor and tenant verification failed');
    lastSanitizedProbeStage = 'sampling';
    for (const route of opts.routeNames) {
      const observation = await sample(client, route, opts.dwellMs, opts.locateFirstArgOnce);
      report.samples.push(observation);
      console.log('CLASSIFIED ' + route + ' events=' + observation.total + ' categories=' + JSON.stringify(observation.categories));
    }
  } finally { client.close(); }
  report.summary = { sampledRoutes: report.samples.length, total: 0, categories: {} };
  lastSanitizedProbeStage = 'summary_write';
  for (const sample of report.samples) {
    report.summary.total += sample.total;
    for (const [category, count] of Object.entries(sample.categories)) {
      report.summary.categories[category] = (report.summary.categories[category] || 0) + count;
    }
  }
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-qa-console-')), 'classification.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log('SANITIZED_REPORT ' + output);
  return report;
}

if (require.main === module) {
  (async () => {
    const opts = options(process.argv.slice(2));
    if (!opts.execute) console.log(JSON.stringify({ mode: 'dry_run_no_cdp', routes: opts.routeNames, policies }, null, 2));
    else await execute(opts);
  })().catch(() => {
    // Export only a fixed internal stage label, not the underlying WebView
    // exception, patient details, SQL, tokens or request URLs.
    console.error('QA_CONSOLE_CLASSIFICATION_REFUSED_OR_FAILED stage=' + lastSanitizedProbeStage);
    process.exitCode = 1;
  });
}

module.exports = { PAGES, policies, classifyDiagnostic, sanitizeEvent, sanitizeStaticChunkFrame,
  sanitizeCollectedEvent, summarizeEvents, options };
