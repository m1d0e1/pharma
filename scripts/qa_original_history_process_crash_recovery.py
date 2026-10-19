"""QA-only *actual separate process exit* between Windows DB renames.

No customer app, production profile, online license or native business IPC is
used. A child process terminates after renaming the disposable QA baseline;
the parent independently reopens and recovers the pinned v68 baseline.
This is NOT a physical power failure / production updater acceptance test.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_atomic_rehearsal as atomic


CHILD_CRASH_EXIT = 73
CHILD_ARG = '--qa-child-crash-after-baseline-rename'
SAFE_TOKEN = re.compile(r'[0-9a-f]{32}\Z')


def qa_folder_from_token(token: str) -> Path:
    if not SAFE_TOKEN.fullmatch(token):
        raise atomic.Refused('Private QA process token is malformed')
    root, _, _ = custody.source_paths()
    custody._no_reparse(root)
    folder = root / ('pharma-isolated-atomic-history-qa-' + token)
    if not folder.is_dir() or folder.is_symlink():
        raise atomic.Refused('Isolated QA process folder is missing')
    custody._no_reparse(folder)
    custody._private_acl(folder, set_restriction=False)
    return folder


def child_crash(token: str) -> None:
    """Restricted test child: never takes an absolute path as input."""
    folder = qa_folder_from_token(token)
    if atomic.inspect_qa_recovery_state(folder) != 'PREPARED_OR_RESTORED_BASELINE':
        raise atomic.Refused('QA worker refusing unsafe baseline state')
    atomic.win32_qa_rename_write_through(folder / 'QA_ACTIVE.sqlite3',
                                         folder / 'QA_ROLLBACK.sqlite3')
    # Deliberate hard process exit, rather than a caught Python exception.
    os._exit(CHILD_CRASH_EXIT)


def exercise() -> dict:
    first, second, a, b, root, fp_a, fp_b = atomic.checked_sources()
    token = uuid.uuid4().hex
    folder = root / ('pharma-isolated-atomic-history-qa-' + token)
    if folder.exists() or folder.is_symlink():
        raise atomic.Refused('Private QA crash folder collision')
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    active = folder / 'QA_ACTIVE.sqlite3'
    incoming = folder / 'QA_INCOMING.sqlite3'
    baseline = folder / 'QA_ROLLBACK.sqlite3'
    custody._exclusive_file(active, a)
    custody._exclusive_file(incoming, b)
    if atomic.inspect_qa_recovery_state(folder) != 'PREPARED_OR_RESTORED_BASELINE':
        raise atomic.Refused('Private QA process-crash preflight failed')
    worker = subprocess.run(
        [sys.executable, '-B', '-m',
         'scripts.qa_original_history_process_crash_recovery', CHILD_ARG, token],
        cwd=str(Path(__file__).resolve().parent.parent),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=60,
        check=False,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    if worker.returncode != CHILD_CRASH_EXIT:
        raise atomic.Refused('QA child did not prove its separate process interruption')
    if atomic.inspect_qa_recovery_state(folder) != 'INTERRUPTED_AFTER_BASELINE_RENAME_RESTORE_FIRST':
        raise atomic.Refused('Crash did not retain the recoverable original QA backup')
    atomic.win32_qa_rename_write_through(baseline, active)
    if atomic.inspect_qa_recovery_state(folder) != 'PREPARED_OR_RESTORED_BASELINE':
        raise atomic.Refused('Recovered QA original failed independent reopening')
    atomic.win32_qa_rename_write_through(active, baseline)
    atomic.win32_qa_rename_write_through(incoming, active)
    if atomic.inspect_qa_recovery_state(folder) != 'PROMOTED_QA_ONLY_UNACCEPTED_KEEP_ROLLBACK':
        raise atomic.Refused('Safe QA post-crash promotion did not match its verified slots')
    custody._unchanged(first, atomic.V68_SHA, fp_a, root)
    custody._unchanged(second, atomic.V69_SHA, fp_b, root)
    result = {
        'status': 'PASS_QA_SEPARATE_PROCESS_CRASH_RESTORE_AND_UNACCEPTED_REPROMOTE',
        'qa_folder': str(folder),
        'original_v68_recovered_after_child_exit': True,
        'child_exited_before_second_rename': True,
        'separate_process_exit_code': CHILD_CRASH_EXIT,
        'qa_active_sha256': atomic.V69_SHA,
        'qa_rollback_sha256': atomic.V68_SHA,
        'source_snapshots_unchanged': True,
        'original_customer_profile_modified': False,
        'windows_actual_power_loss_proven': False,
        'production_installer_or_webview2_tested': False,
        'original_history_license_or_finance_authorized': False,
        'production_allowed': False,
    }
    custody._exclusive_file(folder / 'QA_CHILD_EXIT_RECOVERY_REPORT.json',
                            (json.dumps(result, sort_keys=True) + '\n').encode())
    return result


def main() -> int:
    try:
        custody._require_windows()
        if len(sys.argv) == 3 and sys.argv[1] == CHILD_ARG:
            child_crash(sys.argv[2])
            return 2  # Deliberate exit path must use os._exit above.
        if len(sys.argv) != 1:
            raise atomic.Refused('Unsupported QA crash harness arguments')
        print(json.dumps(exercise(), sort_keys=True))
        return 0
    except (atomic.Refused, custody.Refused, OSError, ValueError,
            subprocess.TimeoutExpired):
        print(json.dumps({'status': 'REFUSED_QA_PROCESS_CRASH_RECOVERY'}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
