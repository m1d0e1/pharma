"""Detached Windows ReplaceFileW atomic-replacement/process-crash QA.

This intentionally operates only on new, owner/SYSTEM-ACL disposable files,
never the application's installed database or historical archive. Windows
ReplaceFileW backs up the old active as part of one replacement operation,
avoiding the absent-active gap of a two-rename algorithm. This still does not
establish power-loss durability or authorization to install the real history.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_atomic_rehearsal as atomic
from scripts import qa_original_history_process_crash_recovery as crash


CHILD_ARG = '--qa-child-replace-exit'
CHILD_EXIT = 74


def replace_file_with_backup(active: Path, incoming: Path, backup: Path) -> None:
    custody._require_windows()
    root, _, _ = custody.source_paths()
    folder = active.parent
    if (incoming.parent != folder or backup.parent != folder or
            folder.parent != root or
            not folder.name.startswith('pharma-isolated-atomic-history-qa-') or
            active.name != 'QA_ACTIVE.sqlite3' or
            incoming.name not in ('QA_INCOMING.sqlite3', 'QA_ROLLBACK.sqlite3',
                                  'QA_ROLLFORWARD.sqlite3') or
            backup.name not in ('QA_ROLLBACK.sqlite3', 'QA_ROLLFORWARD.sqlite3') or
            len({active, incoming, backup}) != 3):
        raise atomic.Refused('ReplaceFileW is restricted to private QA active/incoming/backup')
    custody._private_acl(folder, set_restriction=False)
    for path in (active, incoming):
        custody._contained_file(path, root)
        custody._private_acl(path, set_restriction=False)
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest == atomic.V68_SHA:
            version = 68
        elif digest == atomic.V69_SHA:
            version = 69
        else:
            raise atomic.Refused('Unknown original-derived QA source cannot be replaced')
        atomic.staged_sqlite(raw, version)
    if backup.exists() or backup.is_symlink():
        raise atomic.Refused('ReplaceFileW cannot overwrite existing QA recovery backup')
    for suffix in ('-wal', '-shm', '-journal'):
        for path in (active, incoming, backup):
            if Path(str(path) + suffix).exists():
                raise atomic.Refused('SQLite sidecar makes QA atomic replacement unsafe')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    replace = kernel.ReplaceFileW
    replace.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p,
                        ctypes.c_wchar_p, ctypes.c_uint32,
                        ctypes.c_void_p, ctypes.c_void_p)
    replace.restype = ctypes.c_int
    # Strict Windows replace-with-backup; zero flags preserves default ACL
    # behavior. No copy/delete or non-atomic fallback if Win32 refuses.
    if replace(str(active), str(incoming), str(backup), 0, None, None) != 1:
        raise atomic.Refused('Win32 refused QA ReplaceFileW with independent backup')


def exercise() -> dict:
    source68, source69, a, b, root, fp68, fp69 = atomic.checked_sources()
    token = uuid.uuid4().hex
    folder = root / ('pharma-isolated-atomic-history-qa-' + token)
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    active = folder / 'QA_ACTIVE.sqlite3'
    incoming = folder / 'QA_INCOMING.sqlite3'
    rollback = folder / 'QA_ROLLBACK.sqlite3'
    rollforward = folder / 'QA_ROLLFORWARD.sqlite3'
    custody._exclusive_file(active, a)
    custody._exclusive_file(incoming, b)
    if atomic.inspect_qa_recovery_state(folder) != 'PREPARED_OR_RESTORED_BASELINE':
        raise atomic.Refused('Pinned QA ReplaceFileW preflight failed')
    child = subprocess.run(
        [sys.executable, '-B', '-m',
         'scripts.qa_original_history_replacefile_recovery', CHILD_ARG, token],
        cwd=str(Path(__file__).resolve().parent.parent),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=60, check=False,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if child.returncode != CHILD_EXIT:
        raise atomic.Refused('Separate QA ReplaceFileW child did not complete its crash point')
    if atomic.inspect_qa_recovery_state(folder) != 'PROMOTED_QA_ONLY_UNACCEPTED_KEEP_ROLLBACK':
        raise atomic.Refused('Crash-after-replace state cannot independently reopen both versions')
    replace_file_with_backup(active, rollback, rollforward)
    atomic.fingerprint(active, atomic.V68_SHA)
    atomic.fingerprint(rollforward, atomic.V69_SHA)
    # Re-promote without losing the original v68 rollback.
    replace_file_with_backup(active, rollforward, rollback)
    if atomic.inspect_qa_recovery_state(folder) != 'PROMOTED_QA_ONLY_UNACCEPTED_KEEP_ROLLBACK':
        raise atomic.Refused('Second safe QA atomic promotion failed')
    custody._unchanged(source68, atomic.V68_SHA, fp68, root)
    custody._unchanged(source69, atomic.V69_SHA, fp69, root)
    output = {
        'status': 'PASS_QA_WIN32_REPLACEFILE_CRASH_REOPEN_ROLLBACK_REPROMOTE',
        'qa_folder': str(folder),
        'child_process_hard_exit_after_atomic_replace': True,
        'one_call_win32_replace_with_original_backup': True,
        'active_never_intentionally_removed_before_replacement': True,
        'verified_rollback_and_repromotion': True,
        'active_sha256': atomic.V69_SHA,
        'rollback_sha256': atomic.V68_SHA,
        'sources_unchanged': True,
        'production_customer_profile_modified': False,
        'actual_power_loss_or_installer_validated': False,
        'original_owner_login_or_finance_certified': False,
        'production_upgrade_allowed': False,
    }
    custody._exclusive_file(folder / 'QA_REPLACEFILE_PROCESS_EXIT_REPORT.json',
                            (json.dumps(output, sort_keys=True) + '\n').encode('utf-8'))
    return output


def main() -> int:
    try:
        custody._require_windows()
        if len(sys.argv) == 3 and sys.argv[1] == CHILD_ARG:
            folder = crash.qa_folder_from_token(sys.argv[2])
            if atomic.inspect_qa_recovery_state(folder) != 'PREPARED_OR_RESTORED_BASELINE':
                raise atomic.Refused('Unsafe QA child replacement state')
            replace_file_with_backup(folder / 'QA_ACTIVE.sqlite3',
                                     folder / 'QA_INCOMING.sqlite3',
                                     folder / 'QA_ROLLBACK.sqlite3')
            os._exit(CHILD_EXIT)
        if len(sys.argv) != 1:
            raise atomic.Refused('Unsupported QA ReplaceFileW invocation')
        print(json.dumps(exercise(), sort_keys=True))
        return 0
    except (atomic.Refused, custody.Refused, OSError, ValueError,
            subprocess.TimeoutExpired):
        print(json.dumps({'status': 'REFUSED_QA_WIN32_REPLACEFILE_RECOVERY'}),
              file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
