#!/usr/bin/env node
'use strict';

// Reclassify historical, separately-captured synthetic WebView2 observations
// with CURRENT strict per-control rules. Do not mutate legacy evidence or
// merge actions from a different observation into an unrelated route render.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { catalog } = require('./qa-background-inventory');
const { exportedRoutes } = require('./qa-background');
const { controlEvidence, coverageMatrix } = require('./qa-background-coverage');

const rank = { pass: 3, blocked_feature_denial: 2, unverified_loading: 1 };

function acceptedRouteStatus(page) {
  if (page.status !== 'pass') return page.status;
  if (!Number.isInteger(page.hydration_warnings) || page.hydration_warnings < 0)
    return 'unverified_hydration_unknown';
  if (page.hydration_warnings > 0) return 'unverified_hydration';
  // A legacy report recording zero without this explicit instrumentation
  // cannot establish that hydration exceptions were even observable.
  return page.hydration_acceptance === 'no_mismatch_observed'
    ? 'pass' : 'unverified_hydration_unknown';
}

function mergeNativeSamples(samples, inventory, source) {
  const chosen = new Map();
  const seen = new Map();
  for (const sample of samples) {
    for (const page of sample.native.routes || []) {
      if (!page.route || !inventory.paths.includes(page.route)) continue;
      const history = seen.get(page.route) || [];
      history.push({ source_run:sample.name, status:page.status,
        hydration_warnings:page.hydration_warnings ?? null,
        controls_discovered:page.controls_discovered || 0 });
      seen.set(page.route, history);
      const previous = chosen.get(page.route);
      if (!previous || (rank[page.status] || 0) >= (rank[previous.page.status] || 0))
        chosen.set(page.route, { page, sample });
    }
  }
  const selectedRoutes = [];
  const selectedActions = [];
  for (const [route, {page, sample}] of chosen) {
    selectedRoutes.push({ ...page,
      status:acceptedRouteStatus(page),
      original_render_status:page.status,
      evidence_run:sample.name });
    // Only one selected route can donate actions to that route's witnesses.
    selectedActions.push(...(sample.native.behaviors?.scenarios || [])
      .filter(action => action.route === route));
  }
  const selectedNative = { routes:selectedRoutes, behaviors:{scenarios:selectedActions} };
  const controls = controlEvidence(inventory, selectedNative, source);
  const matrix = coverageMatrix(inventory, selectedNative, source);
  const controlsWithProvenance = controls.runtime_controls.map(c => {
    const selected = chosen.get(c.route);
    return { ...c, expected:'specific reviewed action effect (only where exactly identified)',
      observed:c.actual_effect, native_effect:c.financial_effect,
      evidence_run:selected.sample.name,
      evidence_location:`${selected.sample.name}/native-report.json`,
      behavioral_evidence_location:`${selected.sample.name}/native-behaviors.json`,
      hydration_acceptance:acceptedRouteStatus(selected.page)==='pass' ? 'no_mismatch_observed'
        : acceptedRouteStatus(selected.page),
    };
  });
  const routeObservations = inventory.paths.map(route => {
    const selected = chosen.get(route);
    const raw = selected?.page.status || 'untested';
    const status = selected ? acceptedRouteStatus(selected.page) : 'untested';
    return {route, status, raw_render_status:raw,
      evidence_run:selected?.sample.name || null,
      hydration_acceptance:status==='pass' ? 'no_mismatch_observed' : status,
      actual_rendering:selected?.page.main_preview || null,
      history:seen.get(route) || [],
      source_linkage:'No JSX source-control attribution follows merely from rendering',
    };
  });
  const observedPages = routeObservations.filter(r => r.status !== 'untested');
  const modules = matrix.modules.map(group => ({ ...group,
    route_mounts_observed:group.routes.filter(r=>chosen.get(r.route)?.page.status==='pass').length,
    hydration_mismatch_mounts:group.routes.filter(r=>chosen.get(r.route)?.page.status==='pass'
      && chosen.get(r.route).page.hydration_warnings>0).length,
    unknown_hydration_mounts:group.routes.filter(r=>chosen.get(r.route)?.page.status==='pass'
      && acceptedRouteStatus(chosen.get(r.route).page)==='unverified_hydration_unknown').length,
    semantics:'rendered_routes counts clean accepted native routes; route_mounts_observed includes hydrated-with-mismatch content',
  }));
  return {
    interpretation:'Historical native routes were exercised in separate PRE-FIX synthetic sessions; best observed route is NOT a new authenticated post-fix run',
    sources:samples.map(s=>s.name),
    summary:{ exported_routes:inventory.paths.length,distinct_native_routes:observedPages.length,
      routes_rendered:observedPages.filter(r=>r.raw_render_status==='pass').length,
      routes_hydration_unverified:observedPages.filter(r=>r.status==='unverified_hydration').length,
      routes_hydration_unknown:observedPages.filter(r=>r.status==='unverified_hydration_unknown').length,
      routes_blocked:observedPages.filter(r=>r.status==='blocked_feature_denial').length,
      routes_loading:observedPages.filter(r=>r.status==='unverified_loading').length,
      clean_rendered_native_routes:observedPages.filter(r=>r.status==='pass' && r.hydration_acceptance==='no_mismatch_observed').length,
      runtime_control_counts:controls.runtime_counts,
      source_control_counts:controls.source_control_count,
      native_money_postings_from_merge:0,
    },
    routes:routeObservations,
    runtime_controls:controlsWithProvenance,
    source_modules:controls.source_modules,
    source_controls:controls.source_controls,
    modules,
    unresolved:['Hydration warnings invalidate clean route acceptance even if route rendered',
      'Historical native rejection-only evidence must be reclassified by exact native error',
      'Neither Jest mocks nor JSX source inventory establish real SQLite financial effects',
      'Signed installed license/issuer TPM, tenant ownership, hardware and human release gates remain open'],
  };
}

function loadSamples(names) {
  const temp = fs.realpathSync(os.tmpdir());
  return names.map(name => {
    if (!/^pharma-background-qa-[A-Za-z0-9]{6}$/.test(name))
      throw new Error('Only named existing isolated QA TEMP evidence runs may be merged');
    const dir = fs.realpathSync(path.join(temp, name));
    if (path.dirname(dir).toLowerCase() !== temp.toLowerCase())
      throw new Error('Evidence source escaped the TEMP root');
    return {name, native:JSON.parse(fs.readFileSync(path.join(dir,'native-report.json'),'utf8'))};
  });
}

function main() {
  const names = process.argv.slice(2);
  if (!names.length || new Set(names).size !== names.length) throw new Error('Supply distinct existing QA TEMP run folder names');
  const inventory = {paths:exportedRoutes()};
  const merged = mergeNativeSamples(loadSamples(names), inventory, catalog());
  const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pharma-background-merged-'));
  const file = path.join(output,'merged-native-control-evidence.json');
  fs.writeFileSync(file,JSON.stringify(merged,null,2),{flag:'wx'});
  console.log(JSON.stringify({status:'historical_reclassified_not_retested',file,summary:merged.summary}));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('Native QA evidence merge refused:',error.message); process.exitCode=1; }
}
module.exports = {mergeNativeSamples};
