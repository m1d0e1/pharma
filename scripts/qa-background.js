#!/usr/bin/env node
'use strict';

// Background-only automation: no keyboard/mouse/window activation or database writes.
// Logs are deliberately kept OUTSIDE the dirty/protected repository.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { catalog } = require('./qa-background-inventory');
const { coverageMatrix, controlEvidence } = require('./qa-background-coverage');
const { acquireWorkspaceExclusive } = require('./qa-build-exclusive');

const root = path.resolve(__dirname, '..');
const opts = new Set(process.argv.slice(2));
const skipJest = opts.has('--native-only') || opts.has('--inventory-only');
const skipNative = opts.has('--headless-only') || opts.has('--inventory-only');
const headlessFilter = [...opts].find(value => /^--headless-filter=[a-zA-Z0-9._-]+$/.test(value))?.split('=')[1] || null;
  const portFlag = [...opts].find(value => /^--native-port=\d+$/.test(value));
  const nativeRoutes = [...opts].find(value => value.startsWith('--native-routes='));
  const behaviorMode = opts.has('--behavior');
  const verifyExpiredSynthetic = opts.has('--verify-expired-synthetic');
  const negativeNative = opts.has('--negative-native');
  const oneSyntheticBank = opts.has('--one-synthetic-bank');
if (oneSyntheticBank) {
  throw new Error('Previously verified one-time BG EGP1 bank receipt already exists; duplicate posting is permanently disabled');
}
const port = portFlag ? Number(portFlag.split('=')[1]) : Number(process.env.PHARMA_QA_CDP_PORT || 0);
if (process.env.PHARMA_QA_OUTPUT_DIR) {
  throw new Error('Custom QA output directories are disabled to protect existing files and evidence');
}
const canonicalTemp = fs.realpathSync(os.tmpdir());
const canonicalRepo = fs.realpathSync(root);
if (canonicalTemp.toLowerCase() === canonicalRepo.toLowerCase()
    || canonicalTemp.toLowerCase().startsWith(canonicalRepo.toLowerCase() + path.sep)
    || canonicalRepo.toLowerCase().startsWith(canonicalTemp.toLowerCase() + path.sep)) {
  throw new Error('QA TEMP root is not safely separate from the repository');
}
const outDir = fs.mkdtempSync(path.join(canonicalTemp, 'pharma-background-qa-'));

function runNode(executable, args, filename) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    shell: false, windowsHide: true, timeout: 12 * 60 * 1000,
  });
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : '');
  fs.writeFileSync(path.join(outDir, filename), output);
  return { code: result.status ?? -1, signal: result.signal || null, error: result.error?.message || null, output };
}

function summarizeJest(output) {
  const extract = (label) => {
    const pattern = new RegExp(`^${label}:\\s+(.+)$`, 'm');
    return output.match(pattern)?.[1]?.trim() || 'not reported';
  };
  return { suites: extract('Test Suites'), tests: extract('Tests'), time: extract('Time'),
    failures: [...output.matchAll(/^FAIL (.+)$/gm)].map(match => match[1]) };
}

function assertionEvidence(json, evidenceFile) {
  if (!Array.isArray(json?.testResults)) throw new Error('Jest JSON lacks testResults');
  return json.testResults.flatMap(suite => (suite.assertionResults || []).map(test => ({
    test_file: path.relative(root, suite.name).replaceAll('\\', '/'),
    action_test: test.fullName, status: test.status,
    failure_message_count: Array.isArray(test.failureMessages) ? test.failureMessages.length : 0,
    evidence_file: evidenceFile,
    observed_effect: test.status === 'passed' ? 'Jest assertions passed' : 'see isolated Jest log/JSON',
    native_effect: 'not proven by Jest; integration with genuine Tauri/SQLite must be separately evidenced',
  })));
}

function classifyNativeExit(code, reportedStatus) {
  if (code === 0 && reportedStatus === 'pass') return 'pass';
  // The native route sweep uses exit 2 for an authenticated, intentionally
  // denied or unavailable feature. This is incomplete coverage, not a crash.
  if (code === 2 && reportedStatus === 'partial') return 'partial';
  return 'fail';
}

function exportedRoutes() {
  const base = path.join(root, 'out');
  if (!fs.existsSync(base)) return [];
  const routes = [];
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.name.endsWith('.html')) {
        const rel = path.relative(base, full).replaceAll('\\', '/');
        routes.push(rel === 'index.html' ? '/' : '/' + rel.slice(0, -5).replace(/\/index$/, ''));
      }
    }
  }
  visit(base);
  return [...new Set(routes)].sort();
}

async function main() {
  const report = { schema_version: 1, mode: 'background-no-os-input',
    started_at: new Date().toISOString(), output_dir: outDir,
    headless: { status: 'not_run', partitions: [], coverage: {} },
    native: { status: 'not_run', reason: 'No verified, independent disposable CDP instance configured' },
    native_integrity: { status: 'not_run' },
    release_approval: 'OPEN/BLOCKED', limitations: [] };
  const paths = exportedRoutes();
  report.route_inventory = { source: 'out/*.html', count: paths.length, paths };
  const source = catalog();
  report.source_control_inventory = { files: source.source_files, controls: source.controls_found,
    by_element: source.counts_by_element, sensitive_manual: source.sensitive_manual_count,
    classification: source.coverage_semantics };
  fs.writeFileSync(path.join(outDir, 'controls-source.json'), JSON.stringify(source, null, 2));
  fs.writeFileSync(path.join(outDir, 'routes.json'), JSON.stringify(report.route_inventory, null, 2));
  const executable = process.platform === 'win32' ? 'node.exe' : process.execPath;
  if (!skipJest) {
    const inventory = runNode(executable, [require.resolve('jest/bin/jest'), '--listTests', '--runInBand'], 'jest-inventory.log');
    const allTests = inventory.output.split(/\r?\n/).filter(s => /\.(?:test|regression|audit)\.[jt]sx?$/.test(s));
    const tests = headlessFilter ? allTests.filter(p => path.basename(p).includes(headlessFilter)) : allTests;
    report.headless.inventory_count = allTests.length;
    report.headless.selected_count = tests.length;
    report.headless.scope = headlessFilter ? `filtered:${headlessFilter}` : 'all_configured_Jest_files';
    if (inventory.code !== 0 || tests.length === 0) {
      report.headless.status = 'fail';
      report.headless.error = 'Jest test inventory unavailable';
    } else {
      const partitionSize = 41; // prior verified stable execution limit; new process for each partition
      const headlessActions = [];
      for (let offset = 0; offset < tests.length; offset += partitionSize) {
        const batch = tests.slice(offset, offset + partitionSize);
        const id = 1 + Math.floor(offset / partitionSize);
        const filename = `jest-part-${String(id).padStart(2, '0')}.log`;
        const jsonFilename = `jest-part-${String(id).padStart(2, '0')}.json`;
        const result = runNode(executable, [require.resolve('jest/bin/jest'), '--ci', '--runInBand',
          '--silent', '--testTimeout=15000', '--json',
          `--outputFile=${path.join(outDir, jsonFilename)}`, '--runTestsByPath', ...batch], filename);
        const part = { id, files: batch.length, exit_code: result.code, log: filename,
          ...summarizeJest(result.output) };
        try {
          const json = JSON.parse(fs.readFileSync(path.join(outDir, jsonFilename), 'utf8'));
          const evidence = assertionEvidence(json, jsonFilename);
          part.assertions = evidence.length;
          part.passed_assertions = evidence.filter(test => test.status === 'passed').length;
          part.assertion_evidence = jsonFilename;
          headlessActions.push(...evidence);
        } catch (error) {
          part.evidence_failure = `Jest action-level report missing/invalid: ${error.message}`;
        }
        report.headless.partitions.push(part);
        fs.writeFileSync(path.join(outDir, 'headless-actions.json'), JSON.stringify({
          scope: report.headless.scope, interpretation: 'Per-test results; NOT source-line control attribution or native posting',
          assertions: headlessActions,
        }, null, 2));
        console.log(`QA Jest ${id}: ${part.tests}, exit=${part.exit_code}`);
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
      }
      report.headless.status = report.headless.partitions.every(p => p.exit_code === 0 && !p.evidence_failure) ? 'pass' : 'fail';
      report.headless.coverage = { test_files: tests.length,
        fresh_processes: report.headless.partitions.length,
        assertion_records: headlessActions.length,
        native_side_effects_verified_by_Jest: 0,
        failed_partitions: report.headless.partitions.filter(p => p.exit_code !== 0).map(p => p.id) };
    }
  }
  if (!skipNative && port > 0 && port < 65536) {
    const custody = runNode(process.platform === 'win32' ? 'python.exe' : 'python3',
      [path.join(__dirname, 'qa-background-sqlite.py')], 'native-sqlite.log');
    try { report.native_integrity = JSON.parse(custody.output); }
    catch { report.native_integrity = { status: 'fail', reason: 'Unparseable native custody report' }; }
    if (custody.code !== 0) report.native_integrity.status = 'fail';
    if (report.native_integrity.status === 'pass') {
      const recovery = runNode(process.platform === 'win32' ? 'python.exe' : 'python3',
        [path.join(__dirname, 'qa-background-recovery.py'), outDir], 'native-recovery-preview.log');
      try { report.native_recovery_preview = JSON.parse(recovery.output); }
      catch { report.native_recovery_preview = { status: 'fail', reason: 'Unparseable recovery preview' }; }
      if (recovery.code !== 0) report.native_recovery_preview.status = 'fail';
    }
    const outputLease = randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(outDir, '.cdp-run-lease'), JSON.stringify({
      token:outputLease, created_at_ms:Date.now(), runner_pid:process.pid,
    }), { flag:'wx', mode:0o600 });
    const native = runNode(executable, [path.join(__dirname, 'qa-background-cdp.js'),
      `--port=${port}`, `--out=${outDir}`,
      `--output-lease=${outputLease}`,
      `--manifest=${process.env.PHARMA_QA_NATIVE_MANIFEST || ''}`,
      ...(behaviorMode ? ['--behavior'] : []),
      ...(verifyExpiredSynthetic ? ['--verify-expired-synthetic'] : []),
      ...(negativeNative ? ['--negative-native'] : []),
      ...(oneSyntheticBank ? ['--one-synthetic-bank'] : []),
      ...(nativeRoutes ? ['--routes=' + nativeRoutes.slice('--native-routes='.length)] : [])], 'native-cdp.log');
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(path.join(outDir, 'native-report.json'), 'utf8')); } catch (_) {}
    report.native = parsed || { status: 'fail', error: 'Native CDP report missing', exit_code: native.code };
    report.native.exit_code = native.code;
    report.native.status = classifyNativeExit(native.code, report.native.status);
    // Re-read after every CDP action; a failed rejected-write check must not
    // silently modify a synthetic supplier source or leave a journal behind.
    const postAudit = runNode(process.platform === 'win32' ? 'python.exe' : 'python3',
      [path.join(__dirname, 'qa-background-sqlite.py')], 'native-sqlite-after.log');
    try { report.native_integrity_after = JSON.parse(postAudit.output); }
    catch { report.native_integrity_after = { status:'fail', error:'Post-CDP custody JSON invalid' }; }
    if (postAudit.code !== 0) report.native_integrity_after.status = 'fail';
  } else if (!skipNative) {
    report.native.status = 'blocked';
    report.limitations.push('Native CDP requires explicit --native-port and verified disposable window; B/C and original QA untouched');
  }
  report.completed_at = new Date().toISOString();
  report.status = opts.has('--inventory-only') ? 'inventory_only'
    : report.headless.status === 'fail' || report.native.status === 'fail'
      || report.native_integrity.status === 'fail'
      || report.native_recovery_preview?.status === 'fail'
      || report.native_integrity_after?.status === 'fail' ? 'fail'
    : skipJest && report.native.status === 'pass' ? (verifyExpiredSynthetic ? 'partial' : 'pass')
    : report.headless.status === 'pass' && (skipNative || report.native.status === 'pass') ? 'pass' : 'partial';
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const matrix = coverageMatrix(report.route_inventory, report.native, report.source_control_inventory);
  fs.writeFileSync(path.join(outDir, 'coverage-matrix.json'), JSON.stringify(matrix, null, 2));
  const controls = controlEvidence(report.route_inventory, report.native, source);
  fs.writeFileSync(path.join(outDir, 'control-evidence.json'), JSON.stringify(controls, null, 2));
  report.control_evidence = { path: 'control-evidence.json', runtime_counts: controls.runtime_counts,
    source_untested: controls.source_control_count };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'routes.json'), JSON.stringify(report.route_inventory, null, 2));
  console.log(`QA background status=${report.status}, evidence=${outDir}`);
  if (!['pass', 'inventory_only'].includes(report.status)) process.exitCode = report.status === 'partial' ? 2 : 1;
}

if (require.main === module) {
  // Serialize with the build's temporary middleware/actions renames. The lock
  // spans every Jest partition and is released even after a failing suite.
  async function runExclusively() {
    const release = acquireWorkspaceExclusive(root, 'qa:background');
    try { await main(); } finally { release(); }
  }
  runExclusively().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { summarizeJest, exportedRoutes, classifyNativeExit, assertionEvidence };
