#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifiedPlan, verifiedBlankPosCountState, verifiedNativeCogsDeniedState, verifiedNativeStockAdjustmentState } = require('./qa_connected_gui_readonly');

const QA_ID = 'qa_lifecycle_owner_20261016';
const QA_TENANT = 'qa_lifecycle_20261016';
const qaPlan = {
  actorId: QA_ID,
  tenantId: QA_TENANT,
  identity: 'com.pharma.disposable.lifecycle.qa20261016',
  qaDataOnly: true,
  patientName: 'QA Patient PhaseTwo 123456abcdef',
};

test('read-only GUI runner refuses foreign/ambiguous patient and actor plans', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-qa-stagea-'));
  const file = path.join(root, 'qa-plan.json');
  const write = plan => fs.writeFileSync(file, JSON.stringify(plan), { flag: 'w' });
  try {
    write(qaPlan);
    assert.deepEqual(verifiedPlan(file), qaPlan);
    for (const invalid of [
      { ...qaPlan, tenantId: 'local_default' },
      { ...qaPlan, tenantId: 'foreign-pharmacy' },
      { ...qaPlan, actorId: 'other-owner' },
      { ...qaPlan, qaDataOnly: false },
      { ...qaPlan, identity: 'com.pharma.system' },
      { ...qaPlan, patientName: 'Real Patient 1' },
      { ...qaPlan, patientName: '' },
    ]) {
      write(invalid);
      assert.throws(() => verifiedPlan(file), /witnessed synthetic patient/);
    }
    write(qaPlan);
    assert.throws(() => verifiedPlan(path.join(root, 'different-plan.json')), /Only independently witnessed/);
    assert.throws(() => verifiedPlan(path.join(process.cwd(), 'qa-plan.json')), /Only independently witnessed/);
  } finally {
    // Only exact files under the newly allocated temporary root are removed.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
});

test('POS count WebView acceptance requires an untouched required blank with native validity', () => {
  const good = {
    realPosRoute: true, handoverDialogVisible: true, handoverFormVisible: true,
    countBlank: true, countExplicitlyRequired: true, blankCountInvalid: true,
    loadingDenied: false, noFinancialSubmitClicked: true,
    dialogDismissedWithoutSubmitting: true,
  };
  assert.equal(verifiedBlankPosCountState(good), true);
  for (const [key, value] of [
    ['realPosRoute', false], ['handoverDialogVisible', false],
    ['handoverFormVisible', false], ['countBlank', false],
    ['countExplicitlyRequired', false], ['blankCountInvalid', false],
    ['loadingDenied', true], ['noFinancialSubmitClicked', false],
    ['dialogDismissedWithoutSubmitting', false],
  ]) {
    assert.equal(verifiedBlankPosCountState({ ...good, [key]: value }), false, key);
  }
  assert.equal(verifiedBlankPosCountState(undefined), false);
});

test('COGS real-WebView acceptance requires a visible additive-source denial and no writable controls', () => {
  const accepted = {
    realCogsRoute: true, sourceUnavailableNotice: true,
    searchFieldDisabled: true, searchButtonDisabled: true,
    noCostWriteControls: true, financialMutation: false,
  };
  assert.equal(verifiedNativeCogsDeniedState(accepted), true);
  for (const [field, invalid] of [
    ['realCogsRoute', false], ['sourceUnavailableNotice', false],
    ['searchFieldDisabled', false], ['searchButtonDisabled', false],
    ['noCostWriteControls', false], ['financialMutation', true],
  ]) {
    assert.equal(verifiedNativeCogsDeniedState({ ...accepted, [field]: invalid }), false, field);
  }
  assert.equal(verifiedNativeCogsDeniedState(undefined), false);
});

test('native stock adjustment GUI evidence never substitutes a physical count or submit', () => {
  const good = { realRoute: true,nativeOwnedLotRead: true,nativeReasonRead: true,
    nativeAdjustmentLotRead: true,reasonsVisible: true,searchFormVisible: true,
    selectedLotUnchanged: true,noStockWriteClicked: true,financialMutation: false };
  assert.equal(verifiedNativeStockAdjustmentState(good),true);
  for(const [field,value] of [
    ['realRoute',false],['nativeOwnedLotRead',false],['nativeReasonRead',false],
    ['nativeAdjustmentLotRead',false],['reasonsVisible',false],['searchFormVisible',false],
    ['selectedLotUnchanged',false],['noStockWriteClicked',false],['financialMutation',true]
  ]) assert.equal(verifiedNativeStockAdjustmentState({...good,[field]:value}),false,field);
  assert.equal(verifiedNativeStockAdjustmentState(null),false);
});
