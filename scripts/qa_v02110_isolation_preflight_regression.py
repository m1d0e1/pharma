"""Synthetic temp-file and mocked-process regressions; never opens real QA."""
from __future__ import annotations

from contextlib import closing, redirect_stderr
import hashlib
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from scripts import qa_v02110_isolation_preflight as qa


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def connection(port: int, pid: int, address: str = "127.0.0.1"):
    return SimpleNamespace(
        status="LISTEN", laddr=SimpleNamespace(ip=address, port=port), pid=pid
    )


class FakeProcess:
    def __init__(self, *, executable: str = "", pid: int = 0,
                 name: str = "msedgewebview2.exe",
                 arguments: list[str] | None = None, created: float = 1000.0):
        self.executable = executable
        self.parent = pid
        self.process_name = name
        self.arguments = arguments or []
        self.created = created

    def exe(self):
        return self.executable

    def ppid(self):
        return self.parent

    def name(self):
        return self.process_name

    def cmdline(self):
        return self.arguments

    def create_time(self):
        return self.created


class IsolatedReleaseCandidatePreflightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qa-rc110-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.roaming = self.base / "APPDATA"
        self.local = self.base / "LOCALAPPDATA"
        self.roaming.mkdir()
        self.local.mkdir()
        detached = self.local / "pharma-disposable-data-copies"
        detached.mkdir()
        frozen = detached / (
            "production-profile-qa-snapshot-20261017-"
            "0123456789abcdef0123456789abcdef"
        )
        frozen.mkdir()
        self.source = frozen / "production_snapshot_immutable.sqlite3"
        with closing(sqlite3.connect(self.source)) as db:
            db.execute(
                "CREATE TABLE _sqlx_migrations("
                "version INTEGER PRIMARY KEY,success INTEGER NOT NULL)"
            )
            db.executemany(
                "INSERT INTO _sqlx_migrations VALUES(?,1)",
                [(version,) for version in range(1, 30)],
            )
            for index in range(66):
                db.execute(f"CREATE TABLE fixture_{index:02}(id INTEGER PRIMARY KEY)")
            db.commit()
        self.sha = digest(self.source)
        self.pin = patch.object(qa, "SOURCE_PIN_PREFIX", self.sha[:8])
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.overlay = self.base / "synthetic-upgradeqa-tauri.json"
        resource_dir = self.base / "qa-resource-v02110"
        resource_dir.mkdir()
        shutil.copyfile(self.source, resource_dir / "pharma_local.db")
        self.seed_pin = patch.object(qa, "SANITIZED_QA_SEED_SHA256", digest(resource_dir / "pharma_local.db"))
        self.seed_pin.start()
        self.addCleanup(self.seed_pin.stop)
        self.config = {
            "identifier": qa.IDENTIFIER,
            "version": qa.VERSION,
            "productName": "Pharma 0.2.110 Disposable Upgrade QA",
            "build": {"beforeBuildCommand": ""},
            "app": {"windows": [{
                "label": "main", "title": "PHARMA 0.2.110 UPGRADE QA - DISPOSABLE - NOT CUSTOMER INSTALL",
                "width": 1280, "height": 800, "resizable": True, "maximized": False,
            }]},
            "bundle": {
                "active": True, "targets": ["nsis"],
                "resources": {"qa-resource-v02110/pharma_local.db": "pharma_local.db"},
                "createUpdaterArtifacts": False,
            },
        }
        self.write_config()
        self.profile = self.roaming / qa.IDENTIFIER
        self.webview = self.local / qa.IDENTIFIER / "EBWebView"
        self.exe_dir = self.base / ("pharma-qa-upgrade110-" + "a" * 12)
        self.exe_dir.mkdir()
        self.exe = self.exe_dir / "Pharma-0.2.110-upgradeqa.exe"
        self.exe.write_bytes(
            b"MZ" + b"synthetic-binary-only" * 8 + qa.IDENTIFIER.encode()
        )
        self.exe_sha = digest(self.exe)

    def write_config(self):
        self.overlay.write_text(json.dumps(self.config), encoding="utf-8")

    def args(self, mode: str = "plan", **overrides):
        inputs = {
            "mode": mode, "overlay": self.overlay, "source": self.source,
            "source_sha256": self.sha, "app_data": self.roaming,
            "local_app_data": self.local, "profile": self.profile,
            "webview_dir": self.webview, "port": 9341,
            "net_connections": lambda **kwargs: [],
            "process_factory": lambda pid: (_ for _ in ()).throw(
                AssertionError("prelaunch cannot access a running process")
            ),
        }
        if mode != "plan":
            inputs.update(candidate_exe=self.exe, candidate_sha256=self.exe_sha)
        inputs.update(overrides)
        return inputs

    def stage(self):
        self.profile.mkdir()
        # Only temporary synthetic test data is copied, byte-for-byte.
        shutil.copyfile(self.source, self.profile / "pharma_local.db")

    def attached_args(self, *, port: int = 9341):
        self.webview.mkdir(parents=True)
        parent_pid, child_pid, created = 300, 500, 1000.0
        processes = {
            parent_pid: FakeProcess(executable=str(self.exe), created=created),
            child_pid: FakeProcess(
                pid=parent_pid, arguments=[
                    f"--remote-debugging-port={port}",
                    f"--user-data-dir={self.webview}",
                ],
            ),
        }
        return self.args(
            "attached", pid=parent_pid, created_at=created, port=port,
            net_connections=lambda **kwargs: [connection(port, child_pid)],
            process_factory=processes.__getitem__,
        )

    def test_plan_only_accepts_unique_identity_and_unclaimed_targets(self):
        result = qa.preflight(**self.args())
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["candidateIdentifier"], qa.IDENTIFIER)
        self.assertFalse(result["candidateProcessAndLoopbackCdpPinned"])
        self.assertFalse(result["appOrBrowserLaunched"])
        self.assertFalse(result["tenantOrSourceOwnershipAuthorized"])
        self.assertFalse(result["sourceOrProfileModified"])
        self.assertFalse(result["launchAuthorized"])
        self.assertFalse(result["effectiveCompiledIdentifierIndependentlyWitnessed"])
        self.assertFalse(result["licenseOrCustodyGrantVerified"])
        self.assertFalse(result["guiRoutesExecuted"])
        self.assertEqual(self.profile.exists(), False)
        self.assertEqual(len(qa.ROUTES), 5)
        rendered = json.dumps(result)
        for path in (self.source, self.profile, self.exe):
            self.assertNotIn(str(path), rendered)
        self.assertNotIn(self.sha, rendered)
        self.assertNotIn("fixture_", rendered)

    def test_unpinned_or_wrong_source_and_incomplete_v29_ledger_denied(self):
        for candidate in ("not-a-hash", "0" * 64, "a" * 64, self.sha[:-1] + "f"):
            with self.subTest(pin=candidate):
                if candidate == self.sha:
                    continue
                with self.assertRaises(qa.Denied):
                    qa.preflight(**self.args(source_sha256=candidate))
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("DELETE FROM _sqlx_migrations WHERE version=29")
            db.commit()
        changed = digest(self.source)
        with patch.object(qa, "SOURCE_PIN_PREFIX", changed[:8]):
            with self.assertRaisesRegex(qa.Denied, "v29"):
                qa.preflight(**self.args(source_sha256=changed))

    def test_nonapproved_archive_and_sidecars_are_denied(self):
        sibling = self.base / "production_snapshot_immutable.sqlite3"
        shutil.copyfile(self.source, sibling)
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args(source=sibling))
        sidecar = self.source.with_name(self.source.name + "-wal")
        sidecar.write_bytes(b"synthetic")
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args())

    def test_wrong_overlay_identity_or_seed_builder_or_updater_is_denied(self):
        for operation in (
            lambda d: d.update(identifier="com.pharma.system"),
            lambda d: d.update(identifier="com.pharma.disposable.lifecycle.qa20261016"),
            lambda d: d.update(version="0.2.109"),
            lambda d: d["build"].update(
                beforeBuildCommand="npm run seed:db && npm run build:tauri"
            ),
            lambda d: d["bundle"].update(active=False),
            lambda d: d["bundle"].update(resources={"pharma_local.db": "pharma_local.db"}),
            lambda d: d["bundle"].update(createUpdaterArtifacts=True),
        ):
            with self.subTest(case=operation.__code__.co_firstlineno):
                original = json.loads(json.dumps(self.config))
                operation(self.config)
                self.write_config()
                with self.assertRaises(qa.Denied):
                    qa.preflight(**self.args())
                self.config = original
        self.write_config()
        self.assertEqual(qa.preflight(**self.args())["status"], "PASS")

    def test_duplicate_or_extended_overlay_json_cannot_override_effective_identity(self):
        raw = self.overlay.read_text(encoding="utf-8")
        duplicated = raw[:-1] + ', "identifier": "com.pharma.system"}'
        self.overlay.write_text(duplicated, encoding="utf-8")
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args())
        self.overlay.write_text(raw, encoding="utf-8")
        self.config["plugins"] = {"updater": {"active": True}}
        self.write_config()
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args())

    def test_target_aliases_and_preclaimed_qa_id_are_denied(self):
        for wrong in (self.roaming / "com.pharma.system", self.profile / ".."):
            with self.subTest(target=str(wrong)):
                with self.assertRaises(qa.Denied):
                    qa.preflight(**self.args(profile=wrong))
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args(webview_dir=self.webview.parent / "Other"))
        self.profile.mkdir()
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args())

    def test_port_collision_shared_9334_and_foreign_listener_denied(self):
        for port in (9333, 9334, 8000, 65535):
            with self.subTest(port=port), self.assertRaises(qa.Denied):
                qa.preflight(**self.args(port=port))
        occupied = lambda **kwargs: [connection(9341, 777)]
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args(net_connections=occupied))

    def test_staged_exact_copy_and_executable_pin_are_required(self):
        self.stage()
        result = qa.preflight(**self.args("staged"))
        self.assertTrue(result["candidateBinaryPinned"])
        self.assertFalse(result["candidateProcessAndLoopbackCdpPinned"])
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args("staged", candidate_sha256="a" * 64))
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args("staged", candidate_exe=None))
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args("staged", candidate_exe=self.source))
        original = self.exe.read_bytes()
        self.exe.write_bytes(b"MZ" + b"renamed-production-binary" * 8)
        with self.assertRaisesRegex(qa.Denied, "identifier marker"):
            qa.preflight(**self.args("staged", candidate_sha256=digest(self.exe)))
        self.exe.write_bytes(original)
        database = self.profile / "pharma_local.db"
        with database.open("ab") as file:
            file.write(b"synthetic-post-copy-change")
        with self.assertRaisesRegex(qa.Denied, "byte-identical"):
            qa.preflight(**self.args("staged"))

    def test_staged_hardlink_of_real_source_is_not_a_separate_data_copy(self):
        self.profile.mkdir()
        # Temp-file synthetic-only: protects against an actual alias to the
        # original file despite byte-identical hashes and distinct paths.
        import os
        os.link(self.source, self.profile / "pharma_local.db")
        with self.assertRaisesRegex(qa.Denied, "byte-identical"):
            qa.preflight(**self.args("staged"))

    def test_staged_database_sidecar_and_preexisting_webview_denied(self):
        self.stage()
        sidecar = self.profile / "pharma_local.db-wal"
        sidecar.write_bytes(b"synthetic")
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args("staged"))
        sidecar.unlink()
        self.webview.mkdir(parents=True)
        with self.assertRaises(qa.Denied):
            qa.preflight(**self.args("staged"))

    def test_attached_requires_exact_pid_sha_parent_creation_time_and_webview(self):
        self.stage()
        correct = self.attached_args()
        result = qa.preflight(**correct)
        self.assertTrue(result["candidateProcessAndLoopbackCdpPinned"])
        self.assertFalse(result["appOrBrowserLaunched"])
        self.assertFalse(result["launchAuthorized"])
        for replacement in (
            {"created_at": 1002.0},
            {"pid": 301},
            {"candidate_sha256": "f" * 64},
            {"net_connections": lambda **kwargs: []},
            {"net_connections": lambda **kwargs: [connection(9341, 500, "0.0.0.0")]},
            {"net_connections": lambda **kwargs: [connection(9341, 500), connection(9341, 501)]},
            {"process_factory": lambda pid: FakeProcess(
                pid=600, executable=str(self.exe), created=1000.0
            )},
        ):
            with self.subTest(case=str(sorted(replacement))), self.assertRaises(qa.Denied):
                qa.preflight(**{**correct, **replacement})

    def test_missing_owning_webview_debug_arguments_denied(self):
        self.stage()
        args = self.attached_args()
        processes = {
            300: FakeProcess(executable=str(self.exe)),
            500: FakeProcess(pid=300, arguments=[
                "--remote-debugging-port=9334",
                f"--user-data-dir={self.webview}",
            ]),
        }
        with self.assertRaises(qa.Denied):
            qa.preflight(**{**args, "process_factory": processes.__getitem__})

    def test_cli_denies_without_any_log_of_input_paths_or_values(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr), patch.dict("os.environ", {
            "APPDATA": str(self.roaming), "LOCALAPPDATA": str(self.local),
        }):
            exit_code = qa.main([
                "--phase", "plan",
                "--overlay", str(self.overlay),
                "--source", str(self.source),
                "--source-sha256", "deadbeef",
                "--qa-profile", str(self.profile),
                "--qa-webview", str(self.webview),
                "--cdp-port", "9341",
            ])
        self.assertEqual(exit_code, 2)
        self.assertEqual(
            stderr.getvalue().strip(),
            '{"status":"DENIED","noAppOrProfileChange":true}',
        )
        self.assertNotIn(str(self.source), stderr.getvalue())
        self.assertNotIn(self.sha, stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
