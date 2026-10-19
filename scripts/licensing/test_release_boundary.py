"""Static licensing boundary regression tests; no production state or keys."""
from __future__ import annotations

import json
import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


def source(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8-sig")


class ReleaseBoundaryTests(unittest.TestCase):
    def test_manual_offline_release_is_explicit_and_keeps_tpm_and_commercial_signer(self):
        builder = source("src-tauri/build.rs")
        for required in (
            "PHARMA_LICENSE_OFFLINE_ONLY", "PHARMA_LICENSE_DEVICE_MODE",
            "PHARMA_LICENSE_VERIFY_KEY_B64",
            "An offline-only release must not embed an online licensing authority URL",
            "Release issuer public key matches the publicly known QA test key",
        ):
            self.assertIn(required, builder)
        for name in (".github/workflows/release.yml", ".github/workflows/test.yml"):
            workflow = source(name)
            self.assertIn("PHARMA_LICENSE_OFFLINE_ONLY:", workflow)
            self.assertIn("PHARMA_LICENSE_DEVICE_MODE: tpm-v2", workflow)
            self.assertIn("PHARMA_LICENSE_VERIFY_KEY_B64:", workflow)
            self.assertNotIn("PHARMA_LICENSE_ISSUER_SEED_B64", workflow)
        authority = source("scripts/licensing/authority.py")
        native = source("src-tauri/src/commands/auth.rs")
        self.assertIn('self._event(db, license_id, "issue_offline"', authority)
        self.assertIn("offline_fresh_only && !fresh_empty_business_profile(conn).await?", native)
        self.assertIn("status.offline_term && activation_code.is_empty()", native)
        self.assertIn('"sales_invoices"', native)
        self.assertIn('"journal_entries"', native)

    def test_release_uses_public_issuer_key_and_never_embeds_private_issuer_seed(self):
        release = source(".github/workflows/release.yml")
        test_ci = source(".github/workflows/test.yml")
        for workflow in (release, test_ci):
            self.assertIn("PHARMA_LICENSE_VERIFY_KEY_B64", workflow)
            self.assertNotIn("PHARMA_LICENSE_ISSUER_SEED_B64", workflow)
            self.assertNotIn("PHARMA_AUTHORITY_OPERATOR_TOKEN", workflow)
        builder = source("src-tauri/build.rs")
        self.assertIn("Release requires PHARMA_LICENSE_VERIFY_KEY_B64", builder)
        self.assertIn("QwRr_kCSs-lJlOraFdzCDYqqB7ZY_TlU644O-4vcpd4", builder)
        self.assertIn("1P_GZRtjQCUNkm9sDQrS6w8RInIVdus9Y_y2tC6BCRg", builder)
        self.assertIn("Release issuer public key matches the educational Azure test signer", builder)

    def test_release_requires_code_signature_before_publication(self):
        release = source(".github/workflows/release.yml")
        self.assertEqual(release.count("releaseDraft: true"), 2)
        self.assertIn("gh release edit '${{ github.ref_name }}' --draft=false", release)
        self.assertIn("Authenticode code-signing certificate and password are required", release)
        self.assertIn("Production Windows x86 installer requires Authenticode", release)
        self.assertIn("Get-AuthenticodeSignature", release)
        self.assertIn("TimeStamperCertificate", release)
        self.assertLess(release.index("Verify combined x64 and x86 updater manifest"),
                        release.index("Publish verified signed release"))

    def test_educational_cloud_debug_app_is_separate_and_never_published(self):
        config = json.loads(source("src-tauri/tauri.educational-cloud-qa.conf.json"))
        self.assertEqual(config["identifier"], "com.pharma.educationalcloudqa")
        self.assertNotEqual(config["identifier"], "com.pharma.system")
        self.assertIn("NOT COMMERCIAL", config["app"]["windows"][0]["title"])
        self.assertFalse(config["bundle"]["active"])
        self.assertFalse(config["bundle"]["createUpdaterArtifacts"])
        builder = source("scripts/licensing/build-educational-cloud-qa.ps1")
        self.assertIn("https://licenses.getpharmatech.app", builder)
        self.assertIn("1P_GZRtjQCUNkm9sDQrS6w8RInIVdus9Y_y2tC6BCRg", builder)
        self.assertIn("--debug --no-bundle", builder)
        self.assertIn("check-edge-host.py --require-edge-421", builder)
        self.assertNotIn("staging-init", builder)
        self.assertIn("PHARMA_SECURITY_RELEASE_APPROVED", builder)

    def test_both_release_jobs_use_production_environment(self):
        release = source(".github/workflows/release.yml")
        jobs = re.findall(r"^  (publish-tauri|publish-windows-x86-tpm):\n((?:^(?!  \w)[^\n]*\n|^    .*\n)*)", release, re.MULTILINE)
        self.assertEqual({name for name, _ in jobs}, {"publish-tauri", "publish-windows-x86-tpm"})
        for _, job in jobs:
            self.assertRegex(job, r"(?m)^    environment: pharma-production-release$")

    def test_renderer_sql_bypass_does_not_gain_plugin_permissions(self):
        capabilities = json.loads(source("src-tauri/capabilities/default.json"))
        self.assertFalse(any(permission.startswith("sql:") for permission in capabilities["permissions"]))
        renderer_db = source("src/lib/db/tauri.ts")
        self.assertNotIn("import('@tauri-apps/plugin-sql')", renderer_db)
        main = source("src-tauri/src/main.rs")
        self.assertIn("state.enforce()", main)
        self.assertIn("license_status", main)
        self.assertIn("license_install", main)
        self.assertLess(main.index(".check_license()"),main.index("install_seed_database(seed_path, &db_path)"))

    def test_release_native_business_sql_default_denial_cannot_be_disabled_by_debug_assertions(self):
        builder = source("src-tauri/build.rs")
        reader = source("src-tauri/src/commands/guarded_read.rs")
        critical = source("src-tauri/src/commands/critical.rs")
        self.assertIn('std::env::var("PROFILE").as_deref() == Ok("release")', builder)
        self.assertIn('cargo:rustc-cfg=pharma_security_release', builder)
        self.assertIn('cfg!(pharma_security_release)', reader)
        self.assertIn('cfg!(pharma_security_release)', critical)
        self.assertNotIn('cfg!(debug_assertions)', reader)
        self.assertIn('Generic renderer SQL writes are disabled in secure releases', critical)

    def test_x86_qa_cannot_claim_windows_seven_support_with_tpm_only_licensing(self):
        test_ci = source('.github/workflows/test.yml')
        self.assertIn('PHARMA_LICENSE_DEVICE_MODE: tpm-v2', test_ci)
        self.assertIn('PHARMA_LICENSE_AUTHORITY_URL:', test_ci)
        self.assertIn('Windows 7 unsupported', test_ci)
        self.assertNotIn('name: Windows 7 SP1 x86 legacy artifact', test_ci)

    def test_unlicensed_rollback_cannot_become_unlicensed_commit(self):
        main = source("src-tauri/src/main.rs")
        critical = source("src-tauri/src/commands/critical.rs")
        self.assertIn('"license_status" | "license_install"', main)
        self.assertIn('"license_renew_online" | "db_transaction_abort"', main)
        self.assertNotIn('"db_transaction_finish" | "db_transaction_abort"', main)
        self.assertIn('commands::critical::db_transaction_abort,', main)
        self.assertIn('pub async fn db_transaction_abort(', critical)
        self.assertTrue(re.search(r'transactions\s*\.\s*finish\(\s*&tx_id\s*,\s*window\.label\(\)\s*,\s*None\s*,\s*false\s*\)\s*\.\s*await', critical),
                        'Explicit rollback must remain available without a license')
        self.assertNotIn('"db_transaction_finish" | "db_transaction_abort"', main)

    def test_licensed_native_read_pool_exists_before_business_ipc(self):
        """Regression: ordinary guarded SELECT must not depend on sql:load."""
        main = source("src-tauri/src/main.rs")
        critical = source("src-tauri/src/commands/critical.rs")
        self.assertIn("pub struct GuardedReadPool(pub sqlx::SqlitePool)", critical)
        self.assertIn("app.manage(commands::critical::GuardedReadPool(licensed_read_pool))", main)
        # Rustfmt may wrap fluent calls across lines; verify the semantic
        # native pool access without pinning whitespace in generated style.
        self.assertRegex(critical, r"app\s*\.\s*try_state::<GuardedReadPool>\(\)")
        self.assertRegex(critical, r"pool\s*\.\s*0\s*\.\s*acquire\(\)\s*\.\s*await")
        self.assertNotIn("tauri_plugin_sql::DbInstances", critical)
        self.assertLess(main.index(".check_license()"), main.index("let licensed_read_pool"))
        self.assertLess(main.index("migrator.run(&pool)"), main.index("app.manage(commands::critical::GuardedReadPool"))
        self.assertLess(main.index("app.manage(commands::critical::GuardedReadPool"), main.index("mark_startup_complete()"))


if __name__ == "__main__":
    unittest.main()
