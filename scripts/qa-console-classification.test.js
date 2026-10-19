'use strict';
const assert = require('node:assert/strict');
const { policies, classifyDiagnostic, sanitizeEvent, sanitizeStaticChunkFrame, sanitizeCollectedEvent,
  summarizeEvents, options } = require('./qa-console-classification');
assert.deepEqual(options([]).routeNames, [
  '/', '/accounts', '/sales', '/sales/cogs', '/inventory', '/inventory/item-movements',
  '/patients', '/purchases', '/purchases/suppliers', '/reports/sales',
  '/reports/purchases', '/shifts', '/returns',
]);
assert.deepEqual(options(['--routes=/pos,/stores/adjustments,/finance/handover']).routeNames,
  ['/pos', '/stores/adjustments', '/finance/handover']);
for (const bad of ['--routes=/pos,/pos', '--routes=/unsafe',
  '--routes=/sales/cogs?unsafe=1', '--routes=http://external.invalid/',
  '--routes=/inventory/../../patients']) {
  assert.throws(() => options([bad]), /Only distinct fixed QA routes/);
}

const cases = [
  ['Runtime.exceptionThrown', 'PRIVATE_ERROR detail', 'uncaught_runtime_exception'],
  ['Runtime.consoleAPICalled', 'Strict renderer SQL denied: SELECT full_name FROM patients', 'renderer_sql_denied'],
  ['Runtime.consoleAPICalled', 'Unreconciled legacy journal ownership', 'finance_source_unverified'],
  ['Runtime.consoleAPICalled', 'TypeError Cannot read properties of undefined', 'type_error'],
  ['Runtime.consoleAPICalled', 'TypeError: Failed to fetch', 'network_unavailable'],
  ['Runtime.consoleAPICalled', 'TypeError: net::ERR_ABORTED', 'canceled_navigation_or_request'],
  ['Runtime.consoleAPICalled', 'SqliteError: database is locked', 'database_error_other'],
  ['Runtime.consoleAPICalled', 'SQLITE_CONSTRAINT: write rejected', 'database_error_other'],
  ['Runtime.consoleAPICalled', 'Failed to open database window', 'other_unclassified'],
  ['Runtime.consoleAPICalled', 'A handled failure\n at TypeError in database/init.js', 'other_unclassified'],
  ['Runtime.consoleAPICalled', 'Failed to load balance\n at database/sqlite.ts', 'other_unclassified'],
  ['Runtime.consoleAPICalled', 'net::ERR_ABORTED', 'canceled_navigation_or_request'],
  ['Runtime.consoleAPICalled', 'Failed to fetch', 'network_unavailable'],
  ['Runtime.consoleAPICalled', 'some patient PII value test.email@example.test SECRET', 'other_unclassified'],
];
for (const [source, description, expected] of cases) {
  assert.equal(classifyDiagnostic(source, description), expected);
}
const sensitive = 'SELECT phone, full_name FROM patients WHERE id=secret-123';
const result = sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ description: 'Strict renderer SQL denied ' + sensitive }],
} });
assert.deepEqual(result, { category: 'renderer_sql_denied', origin: 'console_error', site: 'unmapped' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ value: 'Failed to fetch pharmacy name:' }, { description: sensitive }],
} }), { category: 'cosmetic_pharmacy_config_read_failure', origin: 'console_error', site: 'dashboard_layout_pharmacy_name' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ value: 'Failed to load drugs payload from SQLite:' }, { description: sensitive }],
} }), { category: 'secure_cache_catalog_read_failure', origin: 'console_error', site: 'secure_cache_catalog_load' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ value: 'App initialization repair failed' }, { description: sensitive }],
} }), { category: 'initializer_repair_failure', origin: 'console_error', site: 'app_initializer_repair' });
const warningError = 'TypeError: Cannot read properties of undefined\n at database/detail/private/secret.js';
const catalogReloadWarning = sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warning', args: [{ value: 'Reload catalog after cross-window catalog change' }, { description: warningError }],
} });
assert.deepEqual(catalogReloadWarning, { category: 'type_error_warning', origin: 'console_warning', site: 'catalog_cross_window_reload' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warn', args: [{ value: 'secureCache unavailable in searchDrugsAction, searching DB only:' }, { description: warningError }],
} }), { category: 'type_error_warning', origin: 'console_warning', site: 'catalog_lookup_cache_fallback' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ value: 'Failed to load dashboard data:' }, { description: 'DatabaseError: blocked read' }],
} }), { category: 'database_error_other', origin: 'console_error', site: 'dashboard_data_load' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ value: 'Failed to load patients:' }, { description: 'Other error\n at TypeError in database.js' }],
} }), { category: 'other_unclassified', origin: 'console_error', site: 'patients_route_load' });
// Confirmed HeaderAlerts -> getInventoryAlertsAction console.error occurs on
// every dashboard route until its native read is fixed. Keep it investigate.
assert.equal(policies.header_inventory_alerts_native_read_failure, 'investigate');
const alertsError = sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [
    { type: 'string', value: 'Get inventory alerts error:' },
    { type: 'object', subtype: 'error', description: 'Strict renderer SQL denied: ' + sensitive },
  ],
} });
assert.deepEqual(alertsError, {
  category: 'header_inventory_alerts_native_read_failure',
  origin: 'console_error', site: 'header_inventory_alerts_native_read_failure',
});
assert.ok(!JSON.stringify(alertsError).includes(sensitive));
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ value: 'Get inventory alerts error:\n' + sensitive }],
} }), alertsError);
for (const lookalike of ['get inventory alerts error:', 'Get inventory alerts error',
  ' Get inventory alerts error:', 'Get inventory alerts errors:']) {
  assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
    type: 'error', args: [{ type: 'string', value: lookalike }],
  } }), { category: 'other_unclassified', origin: 'console_error', site: 'unmapped' });
}
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ type: 'object', subtype: 'error', description: 'Get inventory alerts error:' }],
} }), { category: 'other_unclassified', origin: 'console_error', site: 'unmapped' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warning', args: [{ type: 'string', value: 'Get inventory alerts error:' }],
} }), { category: 'other_unclassified', origin: 'console_warning', site: 'header_inventory_alerts_native_read_failure' });
const alertsAggregate = summarizeEvents([alertsError, alertsError]);
assert.equal(alertsAggregate.categories.header_inventory_alerts_native_read_failure, 2);
assert.equal(alertsAggregate.sites.header_inventory_alerts_native_read_failure, 2);
assert.ok(!JSON.stringify(alertsAggregate).includes(sensitive));
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ description: 'TypeError: Cannot read properties of undefined' }],
} }), { category: 'type_error', origin: 'console_error', site: 'unmapped' });
// A console warning about fetch/cancellation is not a Network.loadingFailed
// event or an uncaught Runtime.exceptionThrown. Preserve origin and uncertainty.
const handledNetworkWarning = sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warning', args: [{ type: 'string', value: 'TypeError: Failed to fetch ' + sensitive }],
} });
assert.deepEqual(handledNetworkWarning, { category: 'network_warning', origin: 'console_warning', site: 'unmapped' });
assert.equal(policies.network_warning, 'investigate_handled_warning_source_not_confirmed_network_outage');
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warn', args: [{ type: 'string', value: 'AbortError: net::ERR_ABORTED ' + sensitive }],
} }), { category: 'request_cancellation_warning', origin: 'console_warning', site: 'unmapped' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warning', args: [{ type: 'string', value: 'ReferenceError: unknownVariable is not defined' }],
} }), { category: 'reference_error_warning', origin: 'console_warning', site: 'unmapped' });
assert.deepEqual(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'error', args: [{ type: 'string', value: 'TypeError: Failed to fetch ' + sensitive }],
} }), { category: 'network_unavailable', origin: 'console_error', site: 'unmapped' });
assert.deepEqual(sanitizeEvent({ method: 'Log.entryAdded', params: { entry: {
  level: 'warning', text: 'TypeError: Failed to fetch ' + sensitive,
} } }), { category: 'network_warning', origin: 'browser_log_warning', site: 'browser_log' });
assert.deepEqual(sanitizeEvent({ method: 'Log.entryAdded', params: { entry: {
  level: 'error', text: 'TypeError: Cannot read properties of null',
} } }), { category: 'type_error', origin: 'browser_log_error', site: 'browser_log' });
const locateEvent = (type, first, rest = []) => sanitizeEvent({
  method: 'Runtime.consoleAPICalled', params: { type, args: [first, ...rest] },
}, true);
assert.deepEqual(locateEvent('error', { type: 'string', value: 'Failed to load tauri event API' },
  [{ type: 'object', subtype: 'error', description: 'DatabaseError: secret medical text' }]), {
  category: 'database_error_other', origin: 'console_error',
  site: 'dashboard_layout_native_menu_listener', firstArgKind: 'recognized_source_prefix',
});
assert.deepEqual(locateEvent('error', { type: 'string', value: 'Error fetching server session:' }), {
  category: 'other_unclassified', origin: 'console_error',
  site: 'server_session_read', firstArgKind: 'recognized_source_prefix',
});
assert.deepEqual(locateEvent('error', { type: 'string', value: 'Failed to log audit event:' }), {
  category: 'other_unclassified', origin: 'console_error',
  site: 'audit_event_write', firstArgKind: 'recognized_source_prefix',
});
assert.deepEqual(locateEvent('error', { type: 'string', value: 'Unknown private clinical label ' + sensitive }), {
  category: 'other_unclassified', origin: 'console_error',
  site: 'unmapped', firstArgKind: 'unrecognized_string',
});
const rawErrorFirst = locateEvent('error', {
  type: 'object', subtype: 'error', description: 'Failed to load tauri event API\n' + sensitive,
});
assert.deepEqual(rawErrorFirst, {
  category: 'other_unclassified', origin: 'console_error',
  site: 'unmapped', firstArgKind: 'error_object',
});
assert.deepEqual(locateEvent('error', { type: 'object', value: 'Failed to load tauri event API' }), {
  category: 'other_unclassified', origin: 'console_error',
  site: 'unmapped', firstArgKind: 'other_object',
});
assert.deepEqual(locateEvent('error', { type: 'object', description: sensitive }), {
  category: 'other_unclassified', origin: 'console_error',
  site: 'unmapped', firstArgKind: 'other_object',
});
assert.deepEqual(locateEvent('error', undefined), {
  category: 'other_unclassified', origin: 'console_error',
  site: 'unmapped', firstArgKind: 'missing_first_argument',
});
assert.deepEqual(locateEvent('warn', { type: 'number', value: 7 }), {
  category: 'other_unclassified', origin: 'console_warning',
  site: 'unmapped', firstArgKind: 'other_first_argument',
});

// CDP frame coordinates are zero-based. Only a compiled Tauri static chunk
// basename can leave the sanitizer. Nested Next route folders are discarded.
const frame = (url, lineNumber = 0, columnNumber = 135) => ({
  url, lineNumber, columnNumber, functionName: sensitive,
});
const safeChunk = 'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js';
const safeRouteChunk = 'http://tauri.localhost/_next/static/chunks/app/(dashboard)/layout-12345678abcdef00.js';
const safeEncodedRouteChunk = 'http://tauri.localhost/_next/static/chunks/app/%28dashboard%29/layout-12345678abcdef00.js';
assert.deepEqual(sanitizeStaticChunkFrame(frame(safeChunk)), {
  chunkBasename: 'main-app-abcdef1234567890.js', lineNumber: 0, columnNumber: 135,
});
assert.deepEqual(sanitizeStaticChunkFrame(frame(safeRouteChunk, 12, 451)), {
  chunkBasename: 'layout-12345678abcdef00.js', lineNumber: 12, columnNumber: 451,
});
assert.deepEqual(sanitizeStaticChunkFrame(frame(safeEncodedRouteChunk)), {
  chunkBasename: 'layout-12345678abcdef00.js', lineNumber: 0, columnNumber: 135,
});
assert.deepEqual(sanitizeStaticChunkFrame(frame('http://tauri.localhost/_next/static/chunks/3053.63308b82a603f47c.js')), {
  chunkBasename: '3053.63308b82a603f47c.js', lineNumber: 0, columnNumber: 135,
});
const rejectedChunkUrls = [
  '', 'http://tauri.localhost/_next/static/chunks/secret.js',
  'http://tauri.localhost/_next/static/chunks/private-patient-name-123.js',
  'http://tauri.localhost/_next/static/chunks/patient-secret-12345678abcdef00.js',
  'http://tauri.localhost/_next/static/chunks/owner-Mohamed-12345678abcdef00.js',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js?token=' + sensitive,
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js#' + sensitive,
  'http://tauri.localhost/_next/static/chunks/../main-app-abcdef1234567890.js',
  'http://tauri.localhost/_next/static/chunks/evil/main-app-abcdef1234567890.js',
  'http://tauri.localhost/_next/static/chunks/app/../main-app-abcdef1234567890.js',
  'http://tauri.localhost/_next/static/chunks/app/%2e%2e/layout-12345678abcdef00.js',
  'http://tauri.localhost/_next/static/chunks/app/%2Fprivate/layout-12345678abcdef00.js',
  'http://tauri.localhost/_next/static/chunks/app/(patient-secret)/layout-12345678abcdef00.js?q=x',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js/',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js.map',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.JS',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef123456789g.js',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js;secret=x',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js%00',
  'http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js\\secret',
  'http://tauri.localhost:80/_next/static/chunks/main-app-abcdef1234567890.js',
  'http://user@tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js',
  'http://tauri.localhost.evil.invalid/_next/static/chunks/main-app-abcdef1234567890.js',
  'http://example.invalid/_next/static/chunks/main-app-abcdef1234567890.js',
  'file:///C:/private/_next/static/chunks/main-app-abcdef1234567890.js',
  'eval at private source http://tauri.localhost/_next/static/chunks/main-app-abcdef1234567890.js',
];
for (const url of rejectedChunkUrls) assert.equal(sanitizeStaticChunkFrame(frame(url)), null);
for (const [lineNumber, columnNumber] of [[-1, 0], [1.5, 5], ['2', 4], [0, '4'],
  [NaN, 0], [0, Infinity], [1_000_001, 0], [0, 10_000_001]]) {
  assert.equal(sanitizeStaticChunkFrame(frame(safeChunk, lineNumber, columnNumber)), null);
}
assert.equal(sanitizeStaticChunkFrame(null), null);
assert.equal(sanitizeStaticChunkFrame({ lineNumber: 1, columnNumber: 1 }), null);

const consoleWithFrame = (type, url, first = 'Not a known source: ' + sensitive) => ({
  method: 'Runtime.consoleAPICalled', params: {
    type, args: [{ type: 'string', value: first }, { type: 'object', description: sensitive }],
    stackTrace: { callFrames: [frame(url, 4, 93), frame(safeChunk, 55, 66)] },
  },
});
const locatorState = { firstConsoleErrorSeen: false };
const firstWarning = sanitizeCollectedEvent(consoleWithFrame('warning', safeChunk), true, locatorState);
assert.ok(!Object.hasOwn(firstWarning, 'firstConsoleErrorFrame'));
assert.equal(locatorState.firstConsoleErrorSeen, false);
const firstError = sanitizeCollectedEvent(consoleWithFrame('error', safeRouteChunk), true, locatorState);
assert.deepEqual(firstError.firstConsoleErrorFrame, {
  chunkBasename: 'layout-12345678abcdef00.js', lineNumber: 4, columnNumber: 93,
});
assert.equal(locatorState.firstConsoleErrorSeen, true);
const secondError = sanitizeCollectedEvent(consoleWithFrame('error', safeChunk), true, locatorState);
assert.ok(!Object.hasOwn(secondError, 'firstConsoleErrorFrame'));
const sourceSummary = summarizeEvents([firstWarning, firstError, secondError]);
assert.deepEqual(sourceSummary.firstConsoleErrorFrame, firstError.firstConsoleErrorFrame);
assert.deepEqual(sourceSummary.firstConsoleWarningFrame, {
  chunkBasename: 'main-app-abcdef1234567890.js', lineNumber: 4, columnNumber: 93,
});
assert.ok(!JSON.stringify(sourceSummary).includes(sensitive));
assert.ok(!JSON.stringify(sourceSummary).includes('(dashboard)'));
assert.ok(!JSON.stringify(sourceSummary).includes('http://tauri.localhost'));
const invalidFirstState = { firstConsoleErrorSeen: false };
const firstInvalid = sanitizeCollectedEvent(consoleWithFrame('error',
  'http://evil.invalid/_next/static/chunks/main-app-abcdef1234567890.js'), true, invalidFirstState);
assert.equal(firstInvalid.firstConsoleErrorFrame, null);
assert.ok(!Object.hasOwn(sanitizeCollectedEvent(consoleWithFrame('error', safeChunk),
  true, invalidFirstState), 'firstConsoleErrorFrame'));
assert.equal(summarizeEvents([firstInvalid]).firstConsoleErrorFrame, null);
const inactiveLocator = sanitizeCollectedEvent(consoleWithFrame('error', safeChunk), false,
  { firstConsoleErrorSeen: false });
assert.ok(!Object.hasOwn(inactiveLocator, 'firstConsoleErrorFrame'));
assert.ok(!Object.hasOwn(inactiveLocator, 'firstArgKind'));
const firstWarningState = { firstConsoleWarningSeen: false, firstConsoleErrorSeen: false };
const invalidFirstWarning = sanitizeCollectedEvent(consoleWithFrame('warning', 'http://evil.invalid/chunk.js'),
  true, firstWarningState);
assert.equal(invalidFirstWarning.firstConsoleWarningFrame, null);
assert.equal(firstWarningState.firstConsoleWarningSeen, true);
assert.ok(!Object.hasOwn(sanitizeCollectedEvent(consoleWithFrame('warn', safeChunk),
  true, firstWarningState), 'firstConsoleWarningFrame'));
assert.equal(summarizeEvents([invalidFirstWarning]).firstConsoleWarningFrame, null);
assert.ok(!JSON.stringify(sourceSummary).includes(sensitive));
assert.deepEqual(sanitizeEvent({ method: 'Runtime.exceptionThrown', params: {
  exceptionDetails: { exception: { description: 'TypeError: private details ' + sensitive } },
} }), { category: 'uncaught_runtime_exception', origin: 'js_exception', site: 'runtime' });
const canceledNetwork = sanitizeEvent({ method: 'Network.loadingFailed', params: {
  canceled: true, errorText: warningError,
} });
assert.deepEqual(canceledNetwork, { category: 'canceled_network_request', origin: 'network_failure',
  site: 'network', cancellationWindow: 'unknown' });
for (const [phase, expected] of [['during_navigation_command', 'during_navigation_command'],
  ['after_navigation_command', 'after_navigation_command'], ['untrusted/private/path', 'unknown']]) {
  const state = { navigationPhase: phase, firstConsoleErrorSeen: false, firstConsoleWarningSeen: false };
  const canceled = sanitizeCollectedEvent({ method: 'Network.loadingFailed', params: {
    canceled: true, errorText: 'net::ERR_ABORTED ' + sensitive, requestId: sensitive,
  } }, false, state);
  assert.deepEqual(canceled, { category: 'canceled_network_request', origin: 'network_failure',
    site: 'network', cancellationWindow: expected });
  assert.ok(!JSON.stringify(canceled).includes(sensitive));
  assert.deepEqual(summarizeEvents([canceled]).cancellationWindows, { [expected]: 1 });
}
assert.deepEqual(sanitizeEvent({ method: 'Network.loadingFailed', params: {
  canceled: false, errorText: 'net::ERR_ABORTED ' + sensitive,
} }), { category: 'request_abort_without_canceled_flag', origin: 'network_failure', site: 'network' });
assert.deepEqual(sanitizeEvent({ method: 'Network.loadingFailed', params: {
  canceled: 'true', errorText: 'net::ERR_ABORTED ' + sensitive,
} }), { category: 'request_abort_without_canceled_flag', origin: 'network_failure', site: 'network' });
assert.deepEqual(sanitizeEvent({ method: 'Network.loadingFailed', params: {
  canceled: false, errorText: 'net::ERR_CONNECTION_REFUSED ' + sensitive,
} }), { category: 'network_unavailable', origin: 'network_failure', site: 'network' });
const aggregate = summarizeEvents([result, result, catalogReloadWarning, canceledNetwork, handledNetworkWarning, null]);
assert.equal(aggregate.categories.renderer_sql_denied, 2);
assert.equal(aggregate.categories.type_error_warning, 1);
assert.equal(aggregate.origins.console_warning, 2);
assert.equal(aggregate.origins.network_failure, 1);
assert.equal(aggregate.categories.canceled_network_request, 1);
assert.equal(aggregate.categories.network_warning, 1);
assert.deepEqual(aggregate.cancellationWindows, { unknown: 1 });
// The saved /inventory and /patients pattern is a warning AND a distinct
// browser-canceled request. /returns adds another warning. Co-occurrence does
// not establish that the warning and canceled request concern the same fetch.
const unrelatedWarning = sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: {
  type: 'warning', args: [{ type: 'string', value: 'Background operation unavailable ' + sensitive }],
} });
const inventorySample = summarizeEvents([handledNetworkWarning, canceledNetwork]);
const returnsSample = summarizeEvents([handledNetworkWarning, canceledNetwork, unrelatedWarning]);
assert.equal(inventorySample.total, 2);
assert.deepEqual(inventorySample.origins, { console_warning: 1, network_failure: 1 });
assert.equal(inventorySample.categories.network_warning, 1);
assert.equal(inventorySample.categories.canceled_network_request, 1);
assert.equal(inventorySample.categories.uncaught_runtime_exception, undefined);
assert.equal(returnsSample.total, 3);
assert.deepEqual(returnsSample.origins, { console_warning: 2, network_failure: 1 });
assert.equal(returnsSample.categories.uncaught_runtime_exception, undefined);
assert.ok(!JSON.stringify({ inventorySample, returnsSample }).includes(sensitive));
assert.ok(!JSON.stringify({ result, catalogReloadWarning, canceledNetwork, aggregate }).includes(sensitive));
assert.ok(!JSON.stringify({ result, catalogReloadWarning, canceledNetwork, aggregate }).includes('database/detail/private/secret.js'));
const locatedSummary = summarizeEvents([rawErrorFirst, locateEvent('error', { type: 'string', value: sensitive }), null]);
assert.deepEqual(locatedSummary.firstArgKinds, { error_object: 1, unrecognized_string: 1 });
assert.ok(!JSON.stringify(locatedSummary).includes(sensitive));
assert.ok(!JSON.stringify(locatedSummary).includes('Failed to load tauri event API'));
assert.equal(sanitizeEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: sensitive }] } }), null);
assert.throws(() => options(['--execute', '--pid=12680', '--port=9334']), /exclusive/);
assert.throws(() => options(['--execute', '--exclusive-confirm', '--pid=12680', '--port=9334']), /SHA256/);
assert.equal(options(['--execute', '--exclusive-confirm', '--pid=35000', '--port=9334',
  '--expected-sha256=' + 'a'.repeat(64)]).expectedSha256, 'A'.repeat(64));
assert.throws(() => options(['--routes=/admin-unreviewed']), /fixed QA routes/);
assert.deepEqual(options([]).execute, false);
assert.throws(() => options(['--locate-first-arg-once', '--routes=/reports/purchases']), /requires --execute/);
assert.throws(() => options(['--locate-first-arg-once', '--execute', '--routes=/reports/purchases,/patients']), /exactly one/);
assert.throws(() => options(['--locate-first-arg-once', '--execute']), /exactly one/);
const locatorOptions = options(['--locate-first-arg-once', '--execute', '--exclusive-confirm',
  '--pid=35000', '--port=9334', '--routes=/reports/purchases', '--expected-sha256=' + 'a'.repeat(64)]);
assert.equal(locatorOptions.locateFirstArgOnce, true);
assert.deepEqual(locatorOptions.routeNames, ['/reports/purchases']);
console.log('Sanitized console classifier checks passed');
