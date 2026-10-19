'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyState, finalStatus, countRouteSummary } = require('./qa-navigation-timing');

const ready = (overrides={}) => ({
  pathname:'/inventory', readyState:'complete', mainLength:215,
  mainLoading:false, identitySpinner:false, layoutSpinner:false,
  denial:false, notFound:false, fatal:false, tauri:true, ...overrides,
});

test('global identity spinner cannot masquerade as a mounted route even when main content is populated', () => {
  assert.equal(classifyState(ready({ identitySpinner:true }),'/inventory'), 'global_auth_loading');
  assert.equal(classifyState(ready({ layoutSpinner:true }),'/inventory'), 'global_layout_loading');
  assert.equal(classifyState(ready({ mainLoading:true }),'/inventory'), 'page_loading');
  assert.equal(classifyState(ready({dataLoading:true,mainLength:500}),'/inventory'), 'page_data_loading');
  assert.equal(classifyState(ready({ mainLength:0 }),'/inventory'), 'empty_main');
  assert.equal(classifyState(ready(),'/inventory'), 'ready');
});

test('redirect, native bridge loss, access denial and not-found page cannot be classified as passes', () => {
  assert.equal(classifyState(ready({ pathname:'/login' }),'/inventory'),'redirect');
  assert.equal(classifyState(ready({ tauri:false }),'/inventory'),'bridge_missing');
  assert.equal(classifyState(ready({ denial:true }),'/inventory'),'denied');
  assert.equal(classifyState(ready({ notFound:true }),'/inventory'),'not_found');
  assert.equal(classifyState(ready({ errorAlert:true }),'/inventory'),'page_error');
  assert.equal(classifyState(ready({ fatal:true }),'/inventory'),'fatal');
  assert.equal(finalStatus({phase:'global_auth_loading',elapsedMs:4200}),'slow_or_stuck_loading');
  assert.equal(finalStatus({phase:'ready',elapsedMs:4200}),'slow_rendered');
  assert.equal(finalStatus({phase:'denied',elapsedMs:250}),'blocked_permission');
  assert.equal(finalStatus({phase:'page_error',elapsedMs:500}),'error_screen');
});

test('route summary retains all route classifications and never reports incomplete inventory as full', () => {
  const summary=countRouteSummary([
    {route:'/inventory',status:'rendered',elapsedMs:900},
    {route:'/patients',status:'slow_rendered',elapsedMs:4500},
    {route:'/reports',status:'blocked_permission',elapsedMs:600},
    {route:'/stores/delete-items',status:'slow_or_stuck_loading',elapsedMs:12000},
  ], 63);
  assert.equal(summary.scanned,4);
  assert.equal(summary.expected,63);
  assert.equal(summary.complete,false);
  assert.equal(summary.slow_or_stuck_loading,1);
  assert.equal(summary.blocked_permission,1);
  assert.equal(summary.slow_rendered,1);
});
