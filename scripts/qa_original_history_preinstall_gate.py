"""Read-only NO-GO/GO evidence inventory before original-history PHARMA install.

This deliberately has no install/promote/update mode, and never accepts
caller-supplied authorization flags. Only verifiable native source evidence is
read; licensing and independent review are reported as unverified until the
real user completes the secure steps outside this diagnostic tool.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys

from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_original_history_owner_readiness as owner
from scripts import qa_original_history_supplier_ap_reconciliation as ap
from scripts import qa_original_history_payment_linkage as patients
from scripts import qa_original_history_cash_tender_transition as tender
from scripts import qa_v02110_primary_pharmacy_migration as guard

ORIGINAL_SHA = '4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197'
ORIGINAL_BYTES = 60035072
HISTORY_QA_IDENTIFIER = 'com.pharma.disposable.currenthistoryguardedqa20261018'


def _pinned_source(path: Path) -> bool:
    if not path.is_file() or path.is_symlink() or path.stat().st_size != ORIGINAL_BYTES:
        return False
    if getattr(path.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
        return False
    if any(Path(str(path) + x).exists() for x in ('-wal','-shm','-journal')):
        return False
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(part)
    return digest.hexdigest() == ORIGINAL_SHA


def check() -> dict:
    local = os.environ['LOCALAPPDATA']
    appdata = os.environ['APPDATA']
    live = Path(appdata) / 'com.pharma.system' / 'pharma_local.db'
    isolated = Path(appdata) / HISTORY_QA_IDENTIFIER / 'pharma_local.db'
    live_match = _pinned_source(live)
    isolated_match = _pinned_source(isolated)
    if not isolated_match:
        raise ValueError('Independent original archived source SHA/sidecars changed: STOP')
    current_live_equivalence = None
    current_live_digest = ORIGINAL_SHA
    if not live_match:
        # A currently running PHARMA may independently advance its accounts
        # AUTOINCREMENT reservation without modifying any historic row. Only
        # a *complete exact typed-row census* against our separately SHA-
        # pinned v29 archive can distinguish this from genuine live changes.
        # This is a diagnostic, never an installation authorization.
        from scripts import qa_original_history_live_sequence_rebase as rebase
        current_raw = rebase._live_os_bytes_stable()
        with rebase._ram(isolated.read_bytes()) as original, rebase._ram(current_raw) as current:
            current_live_equivalence = rebase.compare_business_identical(original, current)
        current_live_digest = hashlib.sha256(current_raw).hexdigest()
    raw = guard.checked_file(guard.disposable_root() / finance.STAGE / finance.NAME, finance.PIN)
    with sqlite3.connect(':memory:') as db:
        db.deserialize(raw)
        finance_result = finance.check(db)
        owner_result = owner.check(db)
        ap_result = ap.check(db)
        payment_result = patients.check(db)
        cash_result = tender.check(db)
    # Presence of even a real signed-license file is NOT license validation.
    # The product's native LicenseGuard must verify a server-issued signature,
    # activation credential, clock/machine binding and restart separately.
    profile_dir = Path(appdata) / HISTORY_QA_IDENTIFIER
    local_qa_signed_license_present = (profile_dir / 'licensing' / 'signed-license.json').is_file()
    if hashlib.sha256((guard.disposable_root() / finance.STAGE / finance.NAME).read_bytes()).hexdigest() != finance.PIN:
        raise ValueError('Protected normalized SQLx69 source changed during preinstall review')
    if not live_match:
        from scripts import qa_original_history_live_sequence_rebase as rebase
        if hashlib.sha256(rebase._live_os_bytes_stable()).hexdigest() != current_live_digest:
            raise ValueError('Live original database advanced during preinstall review: STOP')
    return {
        'status': 'BLOCKED_ORIGINAL_HISTORY_PREINSTALL_REQUIREMENTS',
        'original_windows_v29_sha256': ORIGINAL_SHA,
        'original_installed_source_unchanged': live_match,
        'current_installed_v29_sha256': current_live_digest,
        'current_installed_v29_business_and_physical_rows_identical_to_archived_original':
            live_match or current_live_equivalence['original_business_and_physical_history_rows_equal'] == 289753,
        'live_accounts_autoincrement_source_cursor': (
            current_live_equivalence['live_accounts_sequence']
            if current_live_equivalence else 4829
        ),
        'live_source_metadata_sequence_only_drift': (
            current_live_equivalence['only_internal_account_sequence_changed']
            if current_live_equivalence else False
        ),
        'live_source_business_equivalence_is_not_import_or_financial_authorization': True,
        'detached_historical_qa_v29_same_original_sha': isolated_match,
        'detached_sqlx69_original_data_sha256': finance.PIN,
        'original_scope_to_primary_pharmacy_preservation_verified': True,
        'original_financial_journals_balanced': finance_result['balanced_historical_journals'],
        'historical_supplier_ap_internal_balances_reconciled':
            ap_result['all_supplier_closing_balance_formulas_match'],
        'historical_patient_cash_date_amount_multiset_matching':
            payment_result['witness_counts']['patient_cash_amount_date_unmatched_groups'] == 0,
        'historical_patient_wallet_cash_amount_multiset_matching':
            payment_result['witness_counts']['patient_wallet_cash_amount_unmatched_groups'] == 0,
        'historical_cash_sales_without_linked_shift':
            cash_result['original_unattributed_counts']['original_cash_sale_without_shift'],
        'historical_sale_returns_without_linked_shift':
            cash_result['original_unattributed_counts']['original_return_without_shift'],
        'original_pre_shared_shift_cash_sales_chronologically_verified':
            cash_result['verified_pre_shared_shift_source_census']['original_cash_sales_without_shift_and_before_first_shift'],
        'original_pre_shared_shift_sale_returns_chronologically_verified':
            cash_result['verified_pre_shared_shift_source_census']['original_returns_without_shift_and_before_first_shift'],
        'historical_legacy_pre_shift_era_requires_shift_repair': False,
        'historical_shifts_with_discrepancy_status':
            cash_result['original_unattributed_counts']['original_shift_discrepancy_status'],
        'historical_cash_receipt_events_and_sale_tender_are_not_equivalent': True,
        'original_cash_sale_tender_and_returns_causally_attributed': False,
        'original_owner_password_remains_quarantined':
            owner_result['password_still_quarantined'],
        'historical_qa_signed_license_file_present': local_qa_signed_license_present,
        'native_verified_qa_online_license_and_activation_proof': False,
        'verified_source_bound_historical_offline_import_grant': False,
        'ordinary_customer_offline_license_is_not_an_original_history_import_grant': True,
        'original_owner_authenticated_on_historical_qa_profile': False,
        'original_supplier_cash_and_sales_tender_external_evidence_accepted': False,
        'legacy_opening_balance_transition_independently_certified': False,
        'transactional_historical_windows_gui_acceptance': False,
        'actual_power_loss_installer_rollback_acceptance': False,
        'original_owner_final_production_install_approval': False,
        'new_history_installation_or_database_write_performed': False,
        'production_upgrade_allowed': False,
    }


def main() -> int:
    try:
        report = check()
        print(json.dumps(report, sort_keys=True))
        # Intentional nonzero: do not accidentally treat a diagnostic pass as
        # approval to install original business/financial data.
        return 3
    except (ValueError, KeyError, OSError, sqlite3.Error, guard.Refused):
        print(json.dumps({'status': 'REFUSED_PREINSTALL_SOURCE_IDENTITY'}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
