'use strict';

// A renderer localStorage flag is not proof of native identity or a signed,
// startup-ready lease. This read-only trusted gate is intentionally separate
// from UI route / rejected-financial-action enumeration.
function isReadySignedNativeLease(status) {
  return status?.valid === true && status?.startup_ready === true;
}

function isTrustedSyntheticOwnerReconciliation(value) {
  return value?.status === 'limited_no_findings'
    && Number.isInteger(value.scannedJournals)
    && [4, 5].includes(value.scannedJournals)
    && value.findings === 0
    && value.unverifiableLegacyJournals === 0;
}

function nativeRouteAcceptance({ failures, routes, authenticated, hydrationWarnings }) {
  if (failures.length) return 'fail';
  if (!authenticated || !routes.some(row => row.status === 'pass')
      || routes.some(row => row.status !== 'pass')
      || !Number.isInteger(hydrationWarnings) || hydrationWarnings !== 0) return 'partial';
  return 'pass';
}

module.exports = { isReadySignedNativeLease, isTrustedSyntheticOwnerReconciliation, nativeRouteAcceptance };
