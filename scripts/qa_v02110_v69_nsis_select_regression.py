"""In-memory NSIS tamper tests plus read-only verification of retained v69 QA."""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from scripts import qa_v02110_v69_nsis_select as gate
from scripts import qa_v02110_v69_nsis_guarded_runtime as pinned


class HardenedNsisSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.generated = pinned.ORIGINAL_NSI.read_text(encoding="utf-8-sig")
        cls.hardened = pinned.HARDENED_NSI.read_text(encoding="utf-8-sig")
        cls.manifest = json.loads(pinned.MANIFEST.read_text(encoding="utf-8-sig"))

    def test_actual_package_selects_only_hardened_hash(self):
        selected = gate.select()
        self.assertEqual(Path(selected["selectedInstaller"]), pinned.HARDENED_SETUP)
        self.assertEqual(selected["selectedSha256"], pinned.HARDENED_SETUP_SHA256)
        self.assertTrue(selected["generatedNsisUpdaterRejected"])
        self.assertFalse(selected["commercialReleaseAllowed"])

    def test_refuses_original_generated_setup_even_if_file_exists(self):
        with self.assertRaisesRegex(pinned.common.Refused, "only hardened"):
            gate.verify_manifest_selection(self.manifest, pinned.ORIGINAL_SETUP)

    def test_manifest_cannot_promote_generated_installer(self):
        changed = {**self.manifest, "nsisFile": pinned.ORIGINAL_SETUP.name,
                   "nsisSha256": pinned.ORIGINAL_SETUP_SHA256.upper()}
        with self.assertRaisesRegex(pinned.common.Refused, "nsisFile"):
            gate.verify_manifest_selection(changed)

    def test_rejects_removed_generated_updater_evidence(self):
        altered = self.generated.replace("needsadmin=true", "needsadmin=false")
        with self.assertRaisesRegex(pinned.common.Refused, "updater risk changed"):
            gate.verify_webview_guard(altered, self.hardened)

    def test_rejects_machine_updater_reintroduced_into_hardened_section(self):
        mutated = self.hardened.replace(
            "Section WebView2\n  ; DISPOSABLE QA ONLY:",
            "Section WebView2\n  ExecWait '$R1 /install'\n  ; DISPOSABLE QA ONLY:",
        )
        self.assertNotEqual(mutated, self.hardened)
        with self.assertRaisesRegex(pinned.common.Refused, "executable WebView2"):
            gate.verify_webview_guard(self.generated, mutated)

    def test_rejects_nonproduction_label_or_hardened_source_drift(self):
        for field, replacement in (
            ("qaOnly", False),
            ("commercialIssuerConfigured", True),
            ("hardenedNsisSourceSha256", "00" * 32),
        ):
            with self.subTest(field=field):
                with self.assertRaises(pinned.common.Refused):
                    gate.verify_manifest_selection({**self.manifest, field: replacement})


if __name__ == "__main__":
    unittest.main()
