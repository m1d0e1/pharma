"""Mutation and disposable rollback regressions for pinned v68 NSIS safety gate."""

from __future__ import annotations

import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import qa_v02110_v68_nsis_isolation as qa
from scripts import qa_v02110_v68_nsis_guarded_repackage as guarded
from scripts import qa_v02110_v68_nsis_guarded_runtime as runtime


class NsisContractRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = qa.RETAINED_NSI
        cls.nsi = (root / "installer.nsi").read_text(encoding="utf-8-sig")
        cls.utils = (root / "utils.nsh").read_text(encoding="utf-8-sig")

    def test_pinned_source_explicitly_reports_customer_process_collision(self):
        contract = qa.inspect_nsis(self.nsi, self.utils)
        self.assertTrue(contract["globalSameFilenameProcessKillDuringInstallAndUninstall"])
        self.assertFalse(contract["safeToRunOnCustomerWorkstation"])
        self.assertTrue(contract["canInstallWebView2GloballyIfMissingOrOld"])

    def test_reject_changed_app_identifier(self):
        altered = self.nsi.replace(qa.QA_ID, "com.pharma.system")
        with self.assertRaises(qa.Refused):
            qa.inspect_nsis(altered, self.utils)

    def test_reject_install_into_customer_seed(self):
        altered = self.nsi.replace(
            "qa-resource-v02110\\pharma_local.db",
            "src-tauri\\pharma_local.db",
        )
        with self.assertRaises(qa.Refused):
            qa.inspect_nsis(altered, self.utils)

    def test_reject_uninstall_profile_redirect_to_customer(self):
        altered = self.nsi.replace('RmDir /r "$APPDATA\\${BUNDLEID}"',
                                    'RmDir /r "$APPDATA\\com.pharma.system"')
        with self.assertRaises(qa.Refused):
            qa.inspect_nsis(altered, self.utils)

    def test_reject_uninstall_registry_redirect_to_customer(self):
        altered = self.nsi.replace('DeleteRegKey SHCTX "${UNINSTKEY}"',
                                    'DeleteRegKey SHCTX "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Pharmacy Local Enforcer"')
        with self.assertRaises(qa.Refused):
            qa.inspect_nsis(altered, self.utils)

    def test_reject_missing_global_process_termination_custody(self):
        altered = self.utils.replace('nsis_tauri_utils::KillProcess "${executableName}"',
                                     'nsis_tauri_utils::KillProcessCurrentUser "${executableName}"')
        with self.assertRaises(qa.Refused):
            qa.inspect_nsis(self.nsi, altered)

    def test_reject_changed_install_mode(self):
        with self.assertRaises(qa.Refused):
            qa.inspect_nsis(self.nsi.replace('!define INSTALLMODE "both"',
                                             '!define INSTALLMODE "perMachine"'), self.utils)

    def test_disposable_rollback_deletes_only_its_installed_clone(self):
        with tempfile.TemporaryDirectory(prefix="pharma-v68-nsis-regression-") as tmp:
            root = Path(tmp)
            project = root / "project"
            package = root / "retained-package"
            seed = project / "src-tauri" / "qa-resource-v02110" / "pharma_local.db"
            executable = package / qa.EXECUTABLE
            seed.parent.mkdir(parents=True)
            package.mkdir()
            seed.write_bytes(b"synthetic-qa-seed-test-only")
            executable.write_bytes(b"synthetic-v68-executable-test-only")
            seed_hash = hashlib.sha256(seed.read_bytes()).hexdigest()
            exe_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
            evidence = root / "evidence"
            evidence.mkdir()
            with patch.object(qa, "PROJECT", project), patch.object(qa, "PACKAGE", package), \
                    patch.dict(qa.SHA, {"sanitized": seed_hash, qa.EXECUTABLE: exe_hash}):
                result = qa.offline_clone_rollback(evidence)
                self.assertTrue(result["rollbackRestoredExactSanitizedSeed"])
                self.assertTrue(result["simulatedUninstallRemovedOnlyDisposableInstalledFiles"])
                self.assertFalse((evidence / "simulation" / "install").exists())
                self.assertEqual((evidence / "simulation" / "rollback" / "pharma_local.db").read_bytes(), seed.read_bytes())
                self.assertEqual(executable.read_bytes(), b"synthetic-v68-executable-test-only")

    def test_containment_refuses_escape_outside_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertTrue(qa._within(root / "simulation" / "install", root))
            self.assertFalse(qa._within(root / ".." / "customer-profile", root))

    def test_guarded_repackage_uses_unique_process_name_and_current_user(self):
        rewritten = guarded.guarded_source(self.nsi)
        contract = guarded.inspect_guarded(rewritten)
        self.assertTrue(contract["processHelperNowTargetsUniqueQaFilename"])
        self.assertTrue(contract["installModeCurrentUser"])
        self.assertTrue(contract["webView2InstallationCodeRemoved"])
        self.assertIn('!define MAINBINARYNAME "pharma-v68-primary-qa"', rewritten)
        self.assertIn('File /oname=${MAINBINARYNAME}.exe "${MAINBINARYSRCPATH}"', rewritten)
        self.assertNotIn('!define MAINBINARYNAME "pharma"', rewritten)

    def test_guarded_source_refuses_reintroduced_global_runtime_install(self):
        rewritten = guarded.guarded_source(self.nsi)
        altered = rewritten.replace('Section WebView2\n  ; QA only: skip global runtime installation/update.\nSectionEnd',
                                    'Section WebView2\n  ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install"\nSectionEnd')
        with self.assertRaises(qa.Refused):
            guarded.inspect_guarded(altered)

    def test_guarded_source_refuses_renamed_file_mapping(self):
        rewritten = guarded.guarded_source(self.nsi)
        altered = rewritten.replace('File /oname=${MAINBINARYNAME}.exe "${MAINBINARYSRCPATH}"',
                                    'File "${MAINBINARYSRCPATH}"')
        with self.assertRaises(qa.Refused):
            guarded.inspect_guarded(altered)

    def test_runtime_waits_for_nsis_temporary_uninstaller_to_finish(self):
        # The NSIS /S process can return before its temporary child removes
        # uninstall.exe and the directory, as observed in the first live trial.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "isolated-qa-install"
            target.mkdir()
            calls = []

            def finish_cleanup(seconds):
                calls.append(seconds)
                target.rmdir()

            with patch.object(runtime.time, "sleep", side_effect=finish_cleanup), \
                    patch.object(runtime, "registry_absent", return_value=True), \
                    patch.dict(runtime.os.environ, {"APPDATA": str(root)}):
                result = runtime.verify_removed(target, max_seconds=3)
            self.assertEqual(len(calls), 1)
            self.assertGreaterEqual(result, 0)
            self.assertFalse(target.exists())

    def test_runtime_refuses_uncleared_uninstall_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "still-installed"
            target.mkdir()
            with patch.object(runtime.time, "monotonic", side_effect=[0.0, 25.1]), \
                    patch.object(runtime, "registry_absent", return_value=False):
                with self.assertRaises(qa.Refused):
                    runtime.verify_removed(target, max_seconds=25)


if __name__ == "__main__":
    unittest.main()
