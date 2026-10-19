"""Fail-closed, read-only Windows QA v0.2.110 isolation preflight.

This is NOT a launcher, signer, migrator, tenant grant, data copier, or CDP
client. It only checks independently supplied custody facts and filesystem /
process metadata. Its only output is fixed public identifiers and booleans.

Modes: plan (no profile/executable yet), staged (byte-identical detached copy
and SHA-pinned QA executable), attached (same proof plus exact owned WebView2
loopback listener and PID/create-time evidence).

An abbreviated source hash is never an independent custody pin. The operator
must supply the complete 64-hex SHA-256 verified outside this helper.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
from typing import Any

from scripts.qa_historical_archive_preflight import approved_archive


IDENTIFIER = "com.pharma.disposable.upgradeqa20261017"
VERSION = "0.2.110"
SOURCE_PIN_PREFIX = "06fc00f3"
EXPECTED_TABLES = 67
EXPECTED_MIGRATION = 29
ARCHIVE_BYTES_LIMIT = 512 * 1024 * 1024
ROUTES = ("/reports/purchases", "/reports/sales", "/inventory", "/patients", "/returns")
HEX_SHA = re.compile(r"[0-9a-fA-F]{64}\Z")
QA_EXE = re.compile(r"[A-Za-z0-9._-]+\.exe\Z", re.IGNORECASE)
RUN_FOLDER = re.compile(
    r"(?:pharma-qa-upgrade110-[0-9a-f]{12,32}|v02110-(?:qa-sanitized|guarded-final)-[0-9a-f]{32})\Z"
)
FRESH_SOURCE_FOLDER = re.compile(r"pharma-v02110-prebuild-snapshot-[0-9a-f]{32}\Z")
SANITIZED_QA_SEED_SHA256 = "2602d9c5d24078cec4dbe5066ff9df71223738e84733747746ff3c55e0678af9"
BLOCKED_PORTS = {9333, 9334}


class Denied(ValueError):
    """Sanitize all CLI errors: never echo row values, paths or secrets."""


def _path_same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _plain(path: Path, *, must_exist: bool) -> Path:
    if not path.is_absolute() or ".." in path.parts:
        raise Denied("Unapproved QA path")
    absolute = Path(os.path.abspath(path))
    if must_exist and not absolute.exists():
        raise Denied("Missing QA custody path")
    current = absolute
    while True:
        if current.exists() or current.is_symlink():
            metadata = current.lstat()
            if stat.S_ISLNK(metadata.st_mode) or (
                getattr(metadata, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            ):
                raise Denied("Filesystem indirection is not approved")
        parent = current.parent
        if parent == current:
            break
        current = parent
    if absolute.exists() and not _path_same(absolute.resolve(strict=True), absolute):
        raise Denied("Aliased QA custody path")
    return absolute


def _hash_file(path: Path, *, limit: int = ARCHIVE_BYTES_LIMIT) -> str:
    path = _plain(path, must_exist=True)
    if not path.is_file() or not 100 <= path.stat().st_size <= limit:
        raise Denied("Unsupported pinned QA source or executable")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def _source_pin(value: str) -> str:
    if not isinstance(value, str) or HEX_SHA.fullmatch(value) is None:
        raise Denied("Independent full 64-hex source SHA-256 is mandatory")
    digest = value.lower()
    if not digest.startswith(SOURCE_PIN_PREFIX) or digest == "0" * 64:
        raise Denied("Wrong independently pinned v29 source")
    return digest


def _unique_json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise Denied("Ambiguous duplicate QA overlay JSON field")
        result[key] = value
    return result


def verify_overlay(overlay: Path) -> str:
    overlay = _plain(overlay, must_exist=True)
    if not overlay.is_file() or overlay.stat().st_size > 16_384:
        raise Denied("Missing or oversized QA-only Tauri overlay")
    try:
        settings = json.loads(
            overlay.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_json_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(
                Denied("Non-finite QA overlay JSON value")
            ),
        )
    except (ValueError, UnicodeError) as exc:
        raise Denied("Invalid QA-only Tauri configuration") from exc
    if not isinstance(settings, dict) or set(settings) != {
        "identifier", "version", "productName", "build", "app", "bundle"
    }:
        raise Denied("Invalid QA-only Tauri configuration")
    build, bundle = settings.get("build"), settings.get("bundle")
    app = settings.get("app")
    if (settings.get("identifier") != IDENTIFIER
        or settings.get("version") != VERSION
        or not isinstance(settings.get("productName"), str)
        or settings["productName"] != "Pharma 0.2.110 Disposable Upgrade QA"
        or build != {"beforeBuildCommand": ""}
        or app != {"windows": [{
            "label": "main",
            "title": "PHARMA 0.2.110 UPGRADE QA - DISPOSABLE - NOT CUSTOMER INSTALL",
            "width": 1280, "height": 800, "resizable": True, "maximized": False,
        }]}
        or bundle != {
            "active": True, "targets": ["nsis"],
            "resources": {"qa-resource-v02110/pharma_local.db": "pharma_local.db"},
            "createUpdaterArtifacts": False,
        }):
        raise Denied("QA overlay retains production identity or unsafe build behavior")
    resource = overlay.parent / "qa-resource-v02110" / "pharma_local.db"
    if _hash_file(resource) != SANITIZED_QA_SEED_SHA256:
        raise Denied("QA resource no longer matches the inspected credential-free seed")
    return _hash_file(overlay, limit=16_384)


def verify_v29_source(source: Path, pin: str, local_app_data: Path) -> Path:
    pin = _source_pin(pin)
    # Uses the pre-existing detached custody root/folder/sidecar/symlink rules.
    source = _plain(source, must_exist=True)
    local_app_data = _plain(local_app_data, must_exist=True)
    private_root = local_app_data / "pharma-disposable-data-copies"
    fresh = (source.name == "current-v02109-sealed.sqlite3"
             and FRESH_SOURCE_FOLDER.fullmatch(source.parent.name) is not None)
    try:
        if fresh:
            if (not _path_same(source.parent.parent, private_root)
                or not source.is_file()
                or source.parent.is_symlink()
                or any(Path(str(source) + suffix).exists()
                       for suffix in ("-wal", "-shm", "-journal"))):
                raise Denied("Fresh v29 source not in independent private custody")
            approved = source
        else:
            approved = approved_archive(source, local_app_data)
    except (ValueError, OSError) as exc:
        raise Denied("Unapproved detached historical source") from exc
    if _hash_file(approved) != pin:
        raise Denied("Detached historical source differs from independent pin")
    with approved.open("rb") as handle:
        header = handle.read(100)
    if (len(header) != 100 or not header.startswith(b"SQLite format 3\0")
        or header[18:20] != b"\x01\x01"):
        raise Denied("WAL or incomplete source cannot be cloned")
    try:
        with closing(sqlite3.connect(
            approved.as_uri() + "?mode=ro&immutable=1", uri=True
        )) as db:
            db.execute("PRAGMA query_only=ON")
            if db.execute("PRAGMA query_only").fetchone()[0] != 1:
                raise Denied("Detached source is not query-only")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise Denied("Detached source integrity failed")
            total_tables = db.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
            ).fetchone()[0]
            if total_tables != EXPECTED_TABLES:
                raise Denied("Historical source table census differs")
            migration = db.execute(
                "SELECT COUNT(*),COUNT(DISTINCT version),MIN(version),MAX(version),"
                "SUM(CASE WHEN success=1 AND typeof(version)='integer' THEN 1 ELSE 0 END)"
                " FROM _sqlx_migrations"
            ).fetchone()
            if tuple(migration) != (
                EXPECTED_MIGRATION, EXPECTED_MIGRATION, 1,
                EXPECTED_MIGRATION, EXPECTED_MIGRATION,
            ):
                raise Denied("Historical source is not the complete v29 ledger")
    except sqlite3.Error as exc:
        raise Denied("Uninspectable read-only historical source") from exc
    if _hash_file(approved) != pin:
        raise Denied("Detached source changed during read-only preflight")
    return approved


def _check_port(port: int, *, expected_pid: int | None, net_connections: Any) -> tuple[int | None, bool]:
    if type(port) is not int or not 9300 <= port <= 9399 or port in BLOCKED_PORTS:
        raise Denied("Disallowed or shared QA CDP port")
    try:
        listeners = [c for c in net_connections(kind="tcp")
                     if c.status == "LISTEN" and c.laddr and c.laddr.port == port]
    except Exception as exc:
        raise Denied("Cannot safely inspect Windows CDP listeners") from exc
    if expected_pid is None:
        if listeners:
            raise Denied("Chosen candidate CDP port is occupied")
        return None, True
    if len(listeners) != 1 or listeners[0].laddr.ip != "127.0.0.1":
        raise Denied("Unowned or non-loopback candidate CDP listener")
    pid = listeners[0].pid
    if type(pid) is not int or pid < 100:
        raise Denied("Unidentified candidate WebView2 CDP listener")
    return pid, False


def verify_attached_process(
    *, pid: int, created_at: float, listener_pid: int, port: int,
    candidate_exe: Path, webview_dir: Path, process_factory: Any,
) -> None:
    if type(pid) is not int or pid < 100 or not isinstance(created_at, float):
        raise Denied("Pinned QA PID and creation time are required")
    try:
        app = process_factory(pid)
        child = process_factory(listener_pid)
        command = [str(part) for part in child.cmdline()]
        child_name = child.name().lower()
        parent = child.ppid()
        app_executable = Path(app.exe())
        actual_start = float(app.create_time())
    except Exception as exc:
        raise Denied("Cannot independently attest candidate process") from exc
    if (not _path_same(app_executable, candidate_exe)
        or abs(actual_start - created_at) > 0.01
        or parent != pid or child_name != "msedgewebview2.exe"
        or not any(part == f"--remote-debugging-port={port}" for part in command)
        or not any(part.strip('"').lower().startswith("--user-data-dir=")
                   and _path_same(Path(part.strip('"').split("=", 1)[1].strip('"')), webview_dir)
                   for part in command)):
        raise Denied("Candidate PID/WebView2 ownership or user data differs")


def verify_profile(
    *, mode: str, source: Path, pin: str,
    app_data: Path, local_app_data: Path, profile: Path, webview_dir: Path,
) -> None:
    roaming = _plain(app_data, must_exist=True) / IDENTIFIER
    webview = _plain(local_app_data, must_exist=True) / IDENTIFIER / "EBWebView"
    if not _path_same(profile, roaming) or not _path_same(webview_dir, webview):
        raise Denied("QA AppData/WebView target is not the fresh compiled identifier")
    _plain(profile, must_exist=mode != "plan")
    _plain(webview_dir, must_exist=mode == "attached")
    if mode == "plan":
        if profile.exists() or webview.parent.exists():
            raise Denied("QA candidate identifier is already claimed")
        return
    db = profile / "pharma_local.db"
    if (not profile.is_dir() or not db.is_file()
        or _path_same(db, source) or os.path.samefile(db, source)
        or _hash_file(db) != pin):
        raise Denied("Staged QA historical copy not byte-identical to pinned source")
    for suffix in ("-wal", "-shm", "-journal"):
        if (profile / ("pharma_local.db" + suffix)).exists():
            raise Denied("Staged QA copy has a live SQLite sidecar")
    if mode == "staged" and webview.exists():
        raise Denied("Prelaunch WebView2 data folder is already occupied")
    if mode == "attached" and not webview.is_dir():
        raise Denied("Pinned QA WebView2 user data folder is absent")


def verify_candidate_binary(
    exe: Path | None, pin: str | None, *, mode: str,
    source: Path, app_data: Path, local_app_data: Path,
) -> Path | None:
    if mode == "plan" and exe is None and pin is None:
        return None
    if exe is None or pin is None or HEX_SHA.fullmatch(pin) is None:
        raise Denied("Candidate executable needs independently pinned full SHA-256")
    checked = _plain(exe, must_exist=True)
    if not QA_EXE.fullmatch(checked.name):
        raise Denied("Non-Windows candidate executable")
    if not RUN_FOLDER.fullmatch(checked.parent.name):
        raise Denied("Candidate executable is not in a unique isolated build")
    if (checked.is_relative_to(_plain(app_data, must_exist=True))
        or checked.is_relative_to(_plain(local_app_data, must_exist=True))
        or checked == source):
        raise Denied("Candidate executable aliases an app profile or source")
    if _hash_file(checked) != pin.lower():
        raise Denied("Candidate executable differs from independent build SHA-256")
    # A renamed production executable with a freshly computed hash is not a
    # QA build. This marker is a necessary check, NOT cryptographic evidence
    # that the compiled effective Tauri config matches the reviewed overlay.
    with checked.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise Denied("Candidate is not a Windows PE executable")
        stream.seek(0)
        found = False
        overlap = b""
        needle = IDENTIFIER.encode("ascii")
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            if needle in overlap + chunk:
                found = True
                break
            overlap = chunk[-(len(needle) - 1):]
        if not found:
            raise Denied("Candidate binary lacks the reviewed QA identifier marker")
    return checked


def preflight(
    *, mode: str, overlay: Path, source: Path, source_sha256: str,
    app_data: Path, local_app_data: Path, profile: Path, webview_dir: Path,
    port: int, candidate_exe: Path | None = None,
    candidate_sha256: str | None = None, pid: int | None = None,
    created_at: float | None = None, net_connections: Any = None,
    process_factory: Any = None,
) -> dict[str, Any]:
    if sys.platform != "win32":
        # Unit tests inject explicitly synthetic platform-independent probes.
        if net_connections is None or process_factory is None:
            raise Denied("Real Windows process custody is mandatory")
    if mode not in {"plan", "staged", "attached"}:
        raise Denied("Unknown QA preflight phase")
    pin = _source_pin(source_sha256)
    verify_overlay(overlay)
    locked_source = verify_v29_source(source, pin, local_app_data)
    verify_profile(
        mode=mode, source=locked_source, pin=pin,
        app_data=app_data, local_app_data=local_app_data,
        profile=profile, webview_dir=webview_dir,
    )
    binary = verify_candidate_binary(
        candidate_exe, candidate_sha256, mode=mode, source=locked_source,
        app_data=app_data, local_app_data=local_app_data,
    )
    if net_connections is None or process_factory is None:
        try:
            import psutil  # read-only Win32 process/TCP API; never spawn.
        except ImportError as exc:
            raise Denied("Read-only Windows process evidence unavailable") from exc
        net_connections = psutil.net_connections
        process_factory = psutil.Process
    if mode == "attached":
        if binary is None or pid is None or created_at is None:
            raise Denied("Candidate PID, creation time and pinned binary are required")
        child_pid, _ = _check_port(port, expected_pid=pid, net_connections=net_connections)
        assert child_pid is not None
        verify_attached_process(
            pid=pid, created_at=created_at, listener_pid=child_pid, port=port,
            candidate_exe=binary, webview_dir=webview_dir,
            process_factory=process_factory,
        )
    else:
        if pid is not None or created_at is not None:
            raise Denied("Prelaunch stage cannot attest a running process")
        _check_port(port, expected_pid=None, net_connections=net_connections)
    # The script reports no SQL row values, usernames, paths, identifiers from
    # archive content, source digests, bearer tokens or debug websocket URLs.
    return {
        "status": "PASS", "phase": mode, "candidateIdentifier": IDENTIFIER,
        "version": VERSION, "legacyRoutesExpected": len(ROUTES),
        "operatorSuppliedFullSourcePinMatched": True,
        "sourceImmutableV29And67Tables": True,
        "isolatedProfileTargetVerified": True,
        "candidateBinaryPinned": binary is not None,
        "candidateProcessAndLoopbackCdpPinned": mode == "attached",
        # Marker presence and process ownership alone cannot independently
        # prove the executable's *effective compiled* Tauri config. An
        # operator-reviewed build provenance witness is still required.
        "effectiveCompiledIdentifierIndependentlyWitnessed": False,
        "licenseOrCustodyGrantVerified": False,
        "guiRoutesExecuted": False,
        "launchAuthorized": False,
        "appOrBrowserLaunched": False,
        "tenantOrSourceOwnershipAuthorized": False,
        "sourceOrProfileModified": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("plan", "staged", "attached"), required=True)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--qa-profile", type=Path, required=True)
    parser.add_argument("--qa-webview", type=Path, required=True)
    parser.add_argument("--cdp-port", type=int, required=True)
    parser.add_argument("--candidate-exe", type=Path)
    parser.add_argument("--candidate-sha256")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--process-created-at", type=float)
    args = parser.parse_args(argv)
    try:
        result = preflight(
            mode=args.phase, overlay=args.overlay,
            source=args.source, source_sha256=args.source_sha256,
            app_data=Path(os.environ["APPDATA"]),
            local_app_data=Path(os.environ["LOCALAPPDATA"]),
            profile=args.qa_profile, webview_dir=args.qa_webview,
            port=args.cdp_port,
            candidate_exe=args.candidate_exe,
            candidate_sha256=args.candidate_sha256,
            pid=args.pid, created_at=args.process_created_at,
        )
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
        return 0
    except (Denied, OSError, sqlite3.Error, KeyError, ValueError):
        print('{"status":"DENIED","noAppOrProfileChange":true}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
