"""Source-only safeguard: legacy release publishing must remain disabled.

This test is deliberately dependency-free and never opens issuer/customer data,
contacts a provider, builds a release, or executes a signing action.
"""

from pathlib import Path
import re
import unittest


REPO = Path(__file__).resolve().parents[1]


class LegacyReleaseLockdownTests(unittest.TestCase):
    def test_legacy_parent_publisher_unconditionally_disabled(self):
        source = (REPO / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn("\n  publish-tauri:\n", source)
        parent = source.split("\n  publish-tauri:\n", 1)[1].split(
            "\n  publish-windows7-x86:\n", 1)[0]
        self.assertRegex(parent, r"(?m)^    if: \$\{\{ false \}\}$")
        self.assertRegex(parent, r"(?m)^    environment: pharma-production-release$")

    def test_legacy_x86_publisher_cannot_bypass_disabled_parent(self):
        source = (REPO / ".github/workflows/release.yml").read_text(encoding="utf-8")
        x86 = source.split("\n  publish-windows7-x86:\n", 1)[1]
        self.assertRegex(x86, r"(?m)^    needs: publish-tauri$")
        # No alternative independent publishing job may run while locked down.
        jobs_source = source.split("\njobs:\n", 1)[1]
        jobs = re.findall(r"(?m)^  ([a-z0-9-]+):$", jobs_source)
        self.assertEqual(jobs, ["publish-tauri", "publish-windows7-x86"])


if __name__ == "__main__":
    unittest.main()
