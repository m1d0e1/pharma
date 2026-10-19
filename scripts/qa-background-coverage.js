'use strict';

const moduleName = route => {
  if (route === '/') return 'dashboard';
  const segment = route.split('/').filter(Boolean)[0];
  return segment || 'dashboard';
};

// A source file's owning folder is organizational metadata, NOT a verified
// relationship to a mounted route or a signed native action.
const sourceModule = source => {
  const page = source.match(/^src\/app\/\(dashboard\)\/([^/]+)\//);
  if (page) return page[1];
  const component = source.match(/^src\/components\/([^/]+)\//);
  return component?.[1] || 'shared';
};

// A route render is not a control assertion. Only join an action to a control
// when the reviewed route/label identifies exactly one runtime element.
function controlEvidence(inventory, native, sourceInventory) {
  const actions = native?.behaviors?.scenarios || [];
  const controls = [];
  for (const page of native?.routes || []) {
    for (const control of page.controls || []) {
      const label = (control.label || '').replace(/\s+/g, ' ').trim();
      const sameLabel = (page.controls || []).filter(c => c.tag === control.tag
        && (c.label || '').replace(/\s+/g, ' ').trim() === label);
      // A navigation action names an href, not its link text: two different
      // anchors with the same destination cannot both inherit one click.
      const sameHref = control.tag === 'a' && control.href
        ? (page.controls || []).filter(c => c.tag === 'a' && c.href === control.href)
        : [];
      const matching = actions.filter(action => action.route === page.route && (
        (control.tag === 'button' && ['filter ', 'open ', 'button navigation ']
          .some(prefix => action.action === prefix + label))
        || (control.tag === 'a' && control.href && action.action === 'navigate ' + control.href)
      ));
      const tabEntries = (page.finance_tabs || []).filter(entry => control.tag === 'button'
        && entry.label === label && entry.status === 'selected_ui_only');
      const tab = sameLabel.length === 1 && tabEntries.length === 1 ? tabEntries[0] : null;
      const inputVerified = control.coverage === 'verified_readonly_filter_and_restore';
      const matched = sameLabel.length === 1 && matching.length === 1
        && (control.tag !== 'a' || sameHref.length === 1) ? matching[0] : null;
      const status = page.status === 'blocked_feature_denial' ? 'blocked'
        : page.status !== 'pass' ? 'untested'
          : inputVerified || tab || matched?.status === 'verified' ? 'verified'
            : matched?.status === 'unverified' ? 'failed' : 'untested';
      controls.push({ id: `${page.route}#${control.i}`, route: page.route,
        index: control.i, tag: control.tag, label, kind: control.kind,
        status, evidence: inputVerified ? 'native-report.json: verified filter and restored'
          : tab ? 'native-report.json: accounting selection only'
            : matched ? `native-behaviors.json: ${matched.action}` : 'no exact action witness',
        actual_effect: inputVerified ? 'read-only filtered view restored'
          : tab ? 'selected accounting tab only'
            : matched ? matched.evidence : 'not proven',
        financial_effect: 'not inferred from UI action; require separate native SQLite witness' });
    }
  }
  const source = (sourceInventory.controls || []).map((c, index) => ({
    id: `${c.source}:${c.line}:${c.tag}:${index}`, source: c.source, line: c.line,
    module: sourceModule(c.source), tag: c.tag, category: c.category,
    label_expression: c.label_expression, handler_expression: c.handler_expression,
    required: c.required, disabled_expression: c.disabled_expression,
    status: 'untested',
    expected: 'source JSX handler/label has not been behaviorally attributed to a unique runtime control',
    observed: 'no direct source-line-to-action witness established',
    evidence: 'controls-source.json (static AST provenance only)',
  }));
  const counts = controls.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1; return acc;
  }, { verified: 0, failed: 0, unsupported: 0, blocked: 0, untested: 0 });
  const byModule = new Map();
  for (const c of source) {
    if (!byModule.has(c.module)) byModule.set(c.module, { module: c.module, untested_source_controls: 0 });
    byModule.get(c.module).untested_source_controls++;
  }
  return { semantics: 'Only exact, uniquely identified WebView2 control/action pairs can be verified; source-only controls remain untested',
    runtime_counts: counts, runtime_controls: controls,
    source_control_count: source.length, source_modules: [...byModule.values()].sort((a,b) => a.module.localeCompare(b.module)),
    source_controls: source };
}

function coverageMatrix(inventory, native, sourceInventory) {
  const routes = inventory.paths || [];
  const nativePages = new Map((native?.routes || []).map(row => [row.route, row]));
  const actions = native?.behaviors?.scenarios || [];
  const moduleMap = new Map();
  for (const route of routes) {
    const section = moduleName(route);
    if (!moduleMap.has(section)) moduleMap.set(section, {
      module: section, total_routes: 0, rendered_routes: 0,
      blocked_routes: 0, unresolved_routes: 0,
      runtime_controls_inventoried: 0,
      behaviors_verified: 0, behaviors_unsupported: 0,
      behaviors_unverified: 0, behaviors_blocked: 0,
      routes: [],
    });
    const group = moduleMap.get(section);
    group.total_routes++;
    const page = nativePages.get(route);
    if (page?.status === 'pass') group.rendered_routes++;
    else if (page?.status === 'blocked_feature_denial') group.blocked_routes++;
    else group.unresolved_routes++;
    group.runtime_controls_inventoried += page?.controls_discovered || 0;
    const checks = actions.filter(row => row.route === route);
    group.behaviors_verified += checks.filter(row => row.status === 'verified').length;
    group.behaviors_unverified += checks.filter(row => row.status === 'unverified').length;
    group.behaviors_unsupported += checks.filter(row => row.status === 'unsupported').length;
    group.behaviors_blocked += checks.filter(row =>
      row.status === 'blocked' || row.status === 'untested').length;
    group.routes.push({
      route, render_status: page?.status || 'not_executed',
      runtime_controls: page?.controls_discovered || 0,
      verified_behavior_checks: checks.filter(row => row.status === 'verified').length,
      unverified_behavior_checks: checks.filter(row => row.status !== 'verified').length,
      native_backend_integrity: 'separate_audit_not_inferred_from_UI',
    });
  }
  return {
    semantics: 'Runtime navigation, UI behavior, source inventory, and native SQL acceptance are distinct evidence categories',
    source_level_controls_inventoried_not_automatically_covered: sourceInventory.controls,
    sensitive_source_controls_not_bulk_clicked: sourceInventory.sensitive_manual,
    source_controls_with_direct_source_line_to_native_behavior_witness: 0,
    total_exported_routes: routes.length,
    modules: [...moduleMap.values()].sort((a, b) => a.module.localeCompare(b.module)),
    feature_gaps: [
      'Source JSX inventory does not identify an executable button or form assertion by itself',
      'Most persisted write forms require unique synthetic native postings and exact source/journal/cash receipts',
      'Strict signed installed profile, TPM, issuer, historical finance, destructive DR, shipping seed and human signoff are external',
    ],
  };
}

module.exports = { moduleName, sourceModule, coverageMatrix, controlEvidence };
