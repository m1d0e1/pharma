"""Read-only live v29 equivalence and detached SQLx69 sequence-preserving QA.

An *already running* customer may advance SQLite's internal AUTOINCREMENT
state even if not one historical business row changed. This never authorizes
an import, license, historical owner enrollment, or production replacement.
The source file is read with OS byte reads only, never opened as a disk-backed
SQLite connection and never locked/checkpointed or written.

Outputs only aggregates/SHAs (no owner records, patients, customers or sales
identifiers). Any live typed history/schema/migration difference fails closed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_atomic_rehearsal as staged
from scripts import qa_original_history_preinstall_gate as gate
from scripts import qa_v02110_primary_pharmacy_migration as guard


class Refused(ValueError):
    pass


TOKEN = re.compile(r"[0-9a-f]{32}\Z")
QA_PREFIX = "pharma-v02110-live-sequence-qa-"
QA_NAME = "QA_SQLX69_ACCOUNT_SEQUENCE_ALIGNED.sqlite3"
QA_MANIFEST = "QA_SOURCE_REBASE_METADATA.json"


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _ram(raw: bytes) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    try:
        conn.deserialize(raw)
        conn.execute("PRAGMA query_only=ON")
        if (conn.execute("PRAGMA integrity_check").fetchone() != ("ok",)
                or conn.execute("PRAGMA foreign_key_check").fetchone() is not None):
            raise Refused("Customer SQLite history fails integrity checks")
    except BaseException:
        conn.close()
        raise
    return conn


def compare_business_identical(old: sqlite3.Connection,
                               live: sqlite3.Connection) -> dict:
    """Allow ONLY an upward accounts AUTOINCREMENT cursor, no other drift."""
    if custody._schema(old) != custody._schema(live):
        raise Refused("Live v29 schema changed; no historic rebase")
    tables = custody._tables(old)
    if len(tables) != 67 or "sqlite_sequence" not in tables:
        raise Refused("Unexpected historical v29 source table inventory")
    if tables != custody._tables(live):
        raise Refused("Customer physical table census differs")
    if (old.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone()
            != (29, 29) or
            live.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone()
            != (29, 29)):
        raise Refused("Source v29 SQLx ledger changed")
    matched_rows = 0
    for name in tables:
        if name == "sqlite_sequence":
            continue
        try:
            matched_rows += custody._same_rows(
                old, live, name, custody._columns(old, name))
        except custody.Refused as exc:
            raise Refused("A live historic economic/source row has changed") from exc
    a, b = custody._sequences(old), custody._sequences(live)
    if (set(a) != set(b)
            or any(a[name] != b[name] for name in a if name != "accounts")
            or "accounts" not in a
            or b["accounts"] < a["accounts"]
            or b["accounts"] > a["accounts"] + 100_000):
        raise Refused("Live AUTOINCREMENT source changed beyond the pinned accounts cursor")
    # The active counter must at least exceed the maximum existing key; it
    # must never be rewound to make a normalized QA database look byte-pinned.
    account_key: int | None = live.execute(
        "SELECT MAX(id) FROM accounts").fetchone()[0]
    if type(account_key) is not int or b["accounts"] < account_key:
        raise Refused("Active account ID sequence is inconsistent with account rows")
    return {
        "original_business_and_physical_history_rows_equal": matched_rows,
        "original_accounts_sequence": a["accounts"],
        "live_accounts_sequence": b["accounts"],
        "only_internal_account_sequence_changed": a["accounts"] != b["accounts"],
        "live_history_finance_or_schema_changed": False,
    }


def _live_os_bytes_stable() -> bytes:
    live = Path(os.environ["APPDATA"]) / "com.pharma.system" / "pharma_local.db"
    if not live.is_file() or live.is_symlink():
        raise Refused("Original installed source missing or aliased")
    info = live.lstat()
    if (info.st_nlink != 1 or info.st_size != gate.ORIGINAL_BYTES or
            getattr(info, "st_file_attributes", 0) &
            getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise Refused("Installed v29 file size/identity is unsafe")
    if any(Path(str(live) + ext).exists() for ext in ("-wal", "-shm", "-journal")):
        # WAL bytes can contain uncheckpointed committed history. Never read
        # just the base SQLite file and claim a complete active source.
        raise Refused("Running source has mutable SQLite sidecars")
    first = live.read_bytes()
    second = live.read_bytes()
    after = live.lstat()
    if (first != second or len(first) != gate.ORIGINAL_BYTES
            or (info.st_size, info.st_mtime_ns, info.st_ino) !=
            (after.st_size, after.st_mtime_ns, after.st_ino)
            or any(Path(str(live) + e).exists()
                   for e in ("-wal", "-shm", "-journal"))):
        raise Refused("Running v29 source changed while reading; no QA rebase")
    return first


def rebased_candidate(original_raw: bytes, current_raw: bytes,
                      native_raw: bytes) -> tuple[bytes, dict]:
    """Build a RAM-only v69 candidate with current v29 account sequence."""
    with _ram(original_raw) as old, _ram(current_raw) as current:
        witness = compare_business_identical(old, current)
    with sqlite3.connect(":memory:") as qa:
        qa.deserialize(native_raw)
        if (qa.execute("PRAGMA integrity_check").fetchone() != ("ok",)
                or qa.execute("PRAGMA foreign_key_check").fetchone() is not None):
            raise Refused("Original native SQLx69 candidate failed SQLite integrity")
        if qa.execute(
            "SELECT COUNT(*),MAX(version) FROM _sqlx_migrations"
        ).fetchone() != (69, 69):
            raise Refused("Only genuinely migrated SQLx69 source can be rebased")
        current_cursor = qa.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='accounts'"
        ).fetchone()
        if current_cursor != (witness["original_accounts_sequence"],):
            raise Refused("Detached SQLx69 source no longer matches original account sequence")
        if qa.execute("SELECT COUNT(*) FROM native_primary_scope_audit_batches").fetchone() != (1,):
            raise Refused("Unsigned historic normalization evidence disappeared")
        qa.execute(
            "UPDATE sqlite_sequence SET seq=? WHERE name='accounts'",
            (witness["live_accounts_sequence"],))
        # Python sqlite3.serialize() captures committed SQLite pages, not
        # a private uncommitted transaction's row updates. Commit the RAM
        # transaction before serialization (no disk DB is connected).
        qa.commit()
        # Serialize only in RAM. Never create a connection to an app-data DB.
        altered = qa.serialize()
    with _ram(altered) as check:
        if check.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='accounts'"
        ).fetchone() != (witness["live_accounts_sequence"],):
            raise Refused("QA candidate failed to preserve active account sequence")
    with _ram(native_raw) as baseline, _ram(altered) as rebased:
        # The rebase is NOT allowed to alter a single modern migrated business
        # or provenance row; only sqlite_sequence can differ.
        if custody._schema(baseline) != custody._schema(rebased):
            raise Refused("QA schema unexpectedly changed")
        for table in custody._tables(baseline):
            if table != "sqlite_sequence":
                try:
                    custody._same_rows(baseline, rebased, table,
                                       custody._columns(baseline, table))
                except custody.Refused as exc:
                    raise Refused("QA account rebase altered migrated rows") from exc
    witness["native_sqlx69_still_unsigned_and_quarantined"] = True
    witness["native_receipts_or_business_records_invented"] = False
    witness["original_source_modified"] = False
    witness["production_installation_authorized"] = False
    return altered, witness


def exercise() -> dict:
    custody._require_windows()
    root = guard.disposable_root()
    qa_original = Path(os.environ["APPDATA"]) / gate.HISTORY_QA_IDENTIFIER / "pharma_local.db"
    if not gate._pinned_source(qa_original):
        raise Refused("Independent archived customer v29 pin unavailable")
    original = qa_original.read_bytes()
    current = _live_os_bytes_stable()
    source69, source_fp = custody._capture(root / staged.V69_FOLDER / staged.V69_NAME,
                                           staged.V69_SHA, root)
    native, witness = rebased_candidate(original, current, source69)
    # Avoid stale-current-source acceptance if app mutated the installed
    # file while RAM-based comparison was running.
    if _sha(_live_os_bytes_stable()) != _sha(current):
        raise Refused("Installed original source advanced during detached QA preparation")
    if _sha(qa_original.read_bytes()) != gate.ORIGINAL_SHA:
        raise Refused("Archived original unexpectedly changed")
    custody._unchanged(root / staged.V69_FOLDER / staged.V69_NAME,
                       staged.V69_SHA, source_fp, root)
    output_dir = root / (QA_PREFIX + uuid.uuid4().hex)
    if output_dir.exists() or not root.is_dir():
        raise Refused("Disposable output already exists")
    custody._no_reparse(root)
    output_dir.mkdir(mode=0o700)
    custody._private_acl(output_dir)
    dest = output_dir / QA_NAME
    custody._exclusive_file(dest, native)
    witness.update({
        "status": "PASS_DETACHED_LIVE_SEQUENCE_ALIGNED_SQLX69_UNACCEPTED",
        "current_live_source_sha256": _sha(current),
        "original_archived_source_sha256": gate.ORIGINAL_SHA,
        "original_native_sqlx69_sha256": staged.V69_SHA,
        "detached_rebased_sqlx69_sha256": _sha(native),
        "detached_output_path": str(dest),
        "app_database_written": False,
    })
    if _sha(dest.read_bytes()) != witness["detached_rebased_sqlx69_sha256"]:
        raise Refused("QA output bytes changed during creation")
    custody._exclusive_file(output_dir / QA_MANIFEST,
                            (json.dumps(witness, sort_keys=True) + "\n").encode())
    return witness


def verify_token(token: str) -> dict:
    """Revalidate an existing disposable QA candidate against *today's* live.

    This check cannot whitelist production, cannot choose arbitrary paths,
    and does not treat a JSON manifest as a signature or authorization.
    """
    custody._require_windows()
    if not TOKEN.fullmatch(token):
        raise Refused("Malformed isolated original-history QA token")
    root = guard.disposable_root()
    folder = root / (QA_PREFIX + token)
    output = folder / QA_NAME
    manifest_path = folder / QA_MANIFEST
    custody._no_reparse(root)
    custody._no_reparse(folder)
    custody._private_acl(folder, set_restriction=False)
    custody._contained_file(output, root)
    custody._no_reparse(manifest_path)
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise Refused("QA metadata must be a local regular file")
    metadata = manifest_path.stat()
    if metadata.st_nlink != 1 or not 200 < metadata.st_size <= 16_384:
        raise Refused("QA metadata file is malformed")
    custody._private_acl(manifest_path, set_restriction=False)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise Refused("Malformed QA data provenance metadata") from exc
    if not isinstance(manifest, dict) or (
        manifest.get("status") !=
        "PASS_DETACHED_LIVE_SEQUENCE_ALIGNED_SQLX69_UNACCEPTED"
    ) or manifest.get("production_installation_authorized") is not False:
        raise Refused("QA metadata is not an unaccepted original history result")
    qa_original = (Path(os.environ["APPDATA"]) / gate.HISTORY_QA_IDENTIFIER
                   / "pharma_local.db")
    if not gate._pinned_source(qa_original):
        raise Refused("Independent original v29 archive no longer SHA pinned")
    original = qa_original.read_bytes()
    live = _live_os_bytes_stable()
    source = custody._capture(root / staged.V69_FOLDER / staged.V69_NAME,
                              staged.V69_SHA, root)
    derived, witness = rebased_candidate(original, live, source[0])
    digest = _sha(derived)
    if (manifest.get("original_business_and_physical_history_rows_equal")
            != witness["original_business_and_physical_history_rows_equal"]
            or manifest.get("original_accounts_sequence")
            != witness["original_accounts_sequence"]
            or manifest.get("live_accounts_sequence")
            != witness["live_accounts_sequence"]
            or manifest.get("current_live_source_sha256") != _sha(live)
            or manifest.get("original_archived_source_sha256") != gate.ORIGINAL_SHA
            or manifest.get("original_native_sqlx69_sha256") != staged.V69_SHA
            or manifest.get("detached_rebased_sqlx69_sha256") != digest
            or manifest.get("detached_output_path") != str(output)
            or _sha(output.read_bytes()) != digest
            or manifest.get("native_receipts_or_business_records_invented") is not False
            or manifest.get("original_source_modified") is not False):
        raise Refused("Stale, damaged or spoofed detached original-history QA stage")
    with _ram(derived) as db:
        # Original normalization evidence, financial witness and original
        # tender epoch must remain at their deliberately UNCERTIFIED statuses.
        from scripts import qa_original_history_financial_acceptance as finance
        from scripts import qa_original_history_cash_tender_transition as tender
        result_finance = finance.check(db)
        result_tender = tender.check(db)
        if (result_finance.get("production_allowed") is not False
                or result_tender.get("production_allowed") is not False):
            raise Refused("QA unexpectedly claims original finance authorization")
    if _sha(_live_os_bytes_stable()) != _sha(live):
        raise Refused("Live original source changed during detached QA validation")
    custody._unchanged(root / staged.V69_FOLDER / staged.V69_NAME,
                       staged.V69_SHA, source[1], root)
    return {
        "status": "PASS_DETACHED_SQLX69_LIVE_SEQUENCE_POSTFLIGHT_UNACCEPTED",
        "qa_stage_sha256": digest,
        "live_v29_sha256": _sha(live),
        "verified_business_history_rows_identical": witness[
            "original_business_and_physical_history_rows_equal"],
        "accounts_sequence_preserved": witness["live_accounts_sequence"],
        "historical_native_source_audit_preserved": True,
        "historical_finance_independently_certified": False,
        "original_owner_authenticated": False,
        "production_installation_authorized": False,
        "all_original_files_left_unmodified": True,
    }


def main() -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--verify-token", type=str)
        args = parser.parse_args()
        result = verify_token(args.verify_token) if args.verify_token is not None else exercise()
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, custody.Refused, guard.Refused, OSError, sqlite3.Error) as err:
        # Error text intentionally never includes original financial records.
        print(json.dumps({"status": "REFUSED_LIVE_ORIGINAL_QA_SOURCE_REBASE",
                          "reason": type(err).__name__}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
