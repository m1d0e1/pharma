"""Isolated SQLx68 -> SQLx69 atomic rename/rollback rehearsal, never installation.

Reads only frozen, detached historical sources, leaves protected originals
unchanged and creates a unique ACL-restricted QA directory. Simulates
interruption between rename steps and verifies successful recovery. This does
NOT certify true power-loss persistence or production updater/restart/login.
"""
from __future__ import annotations

import hashlib
import ctypes
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

from scripts import owner_first_enrollment as custody


V68_FOLDER = "pharma-v02110-current-native-sqlx68-primary-scope-844cda322c1843b7809c9d9f20c259df"
V68_NAME = "NATIVE-SQLX68-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
V68_SHA = "816f49d70f0da6edb04cac8bdc5ee1af7b9ed307fd4ae0459b7e1ef7061481bb"
V69_FOLDER = "pharma-v02110-native-sqlx69-primary-scope-43d756ccfe4d43a0a6b0c07ee742b53a"
V69_NAME = "NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
V69_SHA = "bf0a85e37bce355a75cd741186f206887e4e9912df0d7a511ee299a0fde15e08"


class Refused(ValueError):
    pass


def win32_qa_rename_write_through(src: Path, dst: Path) -> None:
    """Request Windows write-through same-folder rename in the disposable QA.

    This is still NOT a claim of power-loss durability or a production updater.
    Files are separately flushed before this function; no copy/delete fallback.
    """
    custody._require_windows()
    if (src.parent != dst.parent or not src.name.startswith("QA_")
            or not dst.name.startswith("QA_")
            or not src.name.endswith(".sqlite3") or not dst.name.endswith(".sqlite3")
            or src == dst):
        raise Refused("Write-through rename restricted to same-folder QA DB files")
    root, _, _ = custody.source_paths()
    if (src.parent.parent != root or
            not src.parent.name.startswith("pharma-isolated-atomic-history-qa-")):
        raise Refused("Write-through rename outside the isolated QA directory")
    custody._contained_file(src, root)
    if dst.exists():
        custody._contained_file(dst, root)
    elif dst.is_symlink():
        raise Refused("QA replacement target is an alias")
    # MOVEFILE_REPLACE_EXISTING (1) | MOVEFILE_WRITE_THROUGH (8).
    # No MOVEFILE_COPY_ALLOWED; SQLx database moves must stay on the volume.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    move = kernel.MoveFileExW
    move.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
    move.restype = ctypes.c_int
    if move(str(src), str(dst), 0x00000001 | 0x00000008) != 1:
        raise Refused("Windows rejected isolated write-through QA rename")


def classify_qa_interruption(active: str | None, rollback: str | None,
                             incoming: str | None) -> str:
    """Fail-closed dry-run classifier of *pinned* QA artifacts, not an installer.

    Caller must independently validate each existing file's digest, ACL,
    path, sidecars, SQLite version and lock state before passing a version.
    Never authorizes using promoted history or deleting a rollback.
    """
    state = (active, rollback, incoming)
    allowed = {
        ("v68", None, "v69"): "PREPARED_OR_RESTORED_BASELINE",
        (None, "v68", "v69"): "INTERRUPTED_AFTER_BASELINE_RENAME_RESTORE_FIRST",
        ("v69", "v68", None): "PROMOTED_QA_ONLY_UNACCEPTED_KEEP_ROLLBACK",
        ("v68", None, None): "RESTORED_BASELINE_WITHOUT_INCOMING",
    }
    if state not in allowed:
        raise Refused("Ambiguous interrupted QA promotion; no automatic activation")
    return allowed[state]


def fingerprint(path: Path, digest: str) -> None:
    # Reject symlinks/reparse ancestors, hardlinks and sidecars rather than
    # trusting only is_file()/is_symlink() on the final path component.
    custody._contained_file(path, path.parent)
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise Refused("QA artifact SHA-256 differs from approved source")
    custody._private_acl(path, set_restriction=False)


def staged_sqlite(raw: bytes, version: int) -> None:
    with sqlite3.connect(":memory:") as db:
        db.deserialize(raw)
        db.execute("PRAGMA query_only=ON")
        if (db.execute("PRAGMA integrity_check").fetchone() != ("ok",)
                or db.execute("PRAGMA foreign_key_check").fetchone() is not None
                or db.execute("SELECT max(version),COUNT(*) FROM _sqlx_migrations WHERE success=1").fetchone() != (version, version)):
            raise Refused("Historical QA candidate is not a valid source version")
        if db.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone()[0]:
            raise Refused("QA source unexpectedly asserts owner authorization")
        if db.execute("SELECT COUNT(*) FROM native_primary_scope_audit_originals").fetchone()[0] != 7567:
            raise Refused("Original historic scope witnesses differ")


def inspect_qa_recovery_state(folder: Path) -> str:
    """Independent on-disk state recognition, never an automatic restore.

    The version is derived from the *file bytes*, not from its filename or a
    manifest. Anything outside the exclusive disposable QA namespace fails.
    """
    custody._require_windows()
    root, _, _ = custody.source_paths()
    if (folder.parent != root or not folder.name.startswith("pharma-isolated-atomic-history-qa-")
            or not folder.is_dir() or folder.is_symlink()):
        raise Refused("Only a registered-looking isolated QA namespace can be inspected")
    custody._no_reparse(root)
    custody._no_reparse(folder)
    custody._private_acl(folder, set_restriction=False)
    observed: list[str | None] = []
    for name in ("QA_ACTIVE.sqlite3", "QA_ROLLBACK.sqlite3", "QA_INCOMING.sqlite3"):
        path = folder / name
        if not path.exists() and not path.is_symlink():
            # A missing main file with a leftover WAL/SHM/hot journal is an
            # interrupted SQLite state, not permission to invent a clean DB.
            if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
                raise Refused("Orphaned QA SQLite sidecar makes recovery ambiguous")
            observed.append(None)
            continue
        custody._contained_file(path, root)
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest == V68_SHA:
            version = 68
        elif digest == V69_SHA:
            version = 69
        else:
            raise Refused("Unknown/corrupt QA database, no automatic recovery")
        custody._private_acl(path, set_restriction=False)
        staged_sqlite(raw, version)
        observed.append(f"v{version}")
    return classify_qa_interruption(*observed)


def checked_sources() -> tuple[Path, Path, bytes, bytes, Path, tuple, tuple]:
    custody._require_windows()
    root, _, _ = custody.source_paths()
    first = root / V68_FOLDER / V68_NAME
    second = root / V69_FOLDER / V69_NAME
    a, fp_a = custody._capture(first, V68_SHA, root)
    b, fp_b = custody._capture(second, V69_SHA, root)
    staged_sqlite(a, 68)
    staged_sqlite(b, 69)
    return first, second, a, b, root, fp_a, fp_b


def exercise() -> dict:
    first, second, a, b, root, fp_a, fp_b = checked_sources()
    folder = root / ("pharma-isolated-atomic-history-qa-" + uuid.uuid4().hex)
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    active = folder / "QA_ACTIVE.sqlite3"
    baseline = folder / "QA_ROLLBACK.sqlite3"
    incoming = folder / "QA_INCOMING.sqlite3"
    custody._exclusive_file(active, a)
    custody._exclusive_file(incoming, b)
    if classify_qa_interruption("v68", None, "v69") != "PREPARED_OR_RESTORED_BASELINE":
        raise Refused("Invalid prepared recovery state")
    if inspect_qa_recovery_state(folder) != "PREPARED_OR_RESTORED_BASELINE":
        raise Refused("QA files do not match their prepared state")
    # Simulate power loss between renaming away the existing active QA DB and
    # installing the replacement. Restore by atomic rename of the exact backup.
    win32_qa_rename_write_through(active, baseline)
    if not classify_qa_interruption(None, "v68", "v69").startswith("INTERRUPTED_"):
        raise Refused("Interrupted rename was not identified")
    if inspect_qa_recovery_state(folder) != "INTERRUPTED_AFTER_BASELINE_RENAME_RESTORE_FIRST":
        raise Refused("QA interruption did not produce a recoverable on-disk state")
    fingerprint(baseline, V68_SHA)
    if active.exists():
        raise Refused("Failed-to-install state is not isolated")
    win32_qa_rename_write_through(baseline, active)
    fingerprint(active, V68_SHA)
    # Actual QA promotion and restart-equivalent independent open.
    win32_qa_rename_write_through(active, baseline)
    win32_qa_rename_write_through(incoming, active)
    if not classify_qa_interruption("v69", "v68", None).startswith("PROMOTED_"):
        raise Refused("QA promotion state not recognized")
    if inspect_qa_recovery_state(folder) != "PROMOTED_QA_ONLY_UNACCEPTED_KEEP_ROLLBACK":
        raise Refused("QA promotion is not independent of filename labels")
    fingerprint(active, V69_SHA)
    fingerprint(baseline, V68_SHA)
    if inspect_qa_recovery_state(folder) != "PROMOTED_QA_ONLY_UNACCEPTED_KEEP_ROLLBACK":
        raise Refused("Final QA on-disk state differs after rollback and repromotion")
    staged_sqlite(active.read_bytes(), 69)
    # Rollback the QA namespace and prove both versions still match their pins.
    win32_qa_rename_write_through(active, incoming)
    win32_qa_rename_write_through(baseline, active)
    fingerprint(active, V68_SHA)
    fingerprint(incoming, V69_SHA)
    # Final QA-only promotion, retain the original rollback file.
    win32_qa_rename_write_through(active, baseline)
    win32_qa_rename_write_through(incoming, active)
    fingerprint(active, V69_SHA)
    fingerprint(baseline, V68_SHA)
    custody._private_acl(folder, set_restriction=False)
    if any(Path(str(active) + x).exists() for x in ("-wal", "-shm", "-journal")):
        raise Refused("QA stage unexpectedly acquired SQLite sidecars")
    # Compare against metadata captured *before* the QA rehearsal, not a late
    # baseline obtained after running the rename sequence.
    custody._unchanged(first, V68_SHA, fp_a, root)
    custody._unchanged(second, V69_SHA, fp_b, root)
    result = {
        "status": "PASS_QA_ONLY_ATOMIC_RENAME_INTERRUPTED_PROMOTION_AND_ROLLBACK",
        "qa_folder": str(folder), "qa_active_sha256": V69_SHA,
        "qa_rollback_sha256": V68_SHA, "interrupted_rename_restored": True,
        "promote_rollback_repromote": True, "qa_sqlx69_restart_open_valid": True,
        "original_historical_sources_modified": False, "production_profile_modified": False,
        "power_loss_fsync_directory_durability_proven": False,
        "interruption_states_are_qa_classifications_not_an_installer": True,
        "on_disk_qa_source_sha_and_schema_identified_without_filename_trust": True,
        "win32_same_directory_write_through_rename_requested": True,
        "finance_or_original_owner_login_authorized": False,
        "production_promote_permitted": False,
    }
    custody._exclusive_file(folder / "QA_ATOMIC_REHEARSAL_REPORT.json",
                            (json.dumps(result, sort_keys=True) + "\n").encode())
    return result


def main() -> int:
    try:
        print(json.dumps(exercise(), sort_keys=True))
        return 0
    except (custody.Refused, Refused, ValueError, OSError, sqlite3.Error) as exc:
        print(json.dumps({"status": "REFUSED_QA_ONLY_RECOVERY", "reason": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
