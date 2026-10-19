"""One-time read-only audit and release-blocking manifest for new signed v69 QA.

Never installs/signs a certificate into Windows trust, never executes the EXE,
does not run financial IPC or open any customer SQLite file for DB access.
The only output is a NEW manifest beneath this disposable build folder.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes

from scripts import qa_v02110_v69_signed_synthetic_fixture as synthetic
from scripts import qa_v02110_v69_test_authenticode_sign as signer


PROJECT = Path(__file__).resolve().parents[1]
QA = synthetic.QA_ROOT
MANIFEST = QA / "QA_ONLY_RELEASE_BLOCKED.json"
CONFIG = PROJECT / "src-tauri/tauri.v02110-v069-signed-synthetic-finance-qa.conf.json"
STAGE = PROJECT.parent / "pharma-builds/v02110-v069-quickadd-detached-368b53492d5c496eb54a348c132f59e3/out"
EXPECTED = {
    "migration069": "a8fdfc23b552312561b38555d037d33f07999703b18e54eb4a5b8e50890785a8",
    "frontend_index": "59c2f88ab56bdcb9fd1e83eb5b8d800fb847b48ab3a0ea21d3facc9d7c8951fe",
    "frontend_purchase": "66ee34006a5181c52d103450aa8bb1cc16a4a8771cea9cb53c4bbf5d357b68e1",
    "quickadd": "47cbba7f89818c878b404b75521da09b2d95a529a25339d7c7c1386f922c17a0",
    "purchase_source": "2788f7565c5bb46a9189f652dc07c3737cadf3cef6ca2cb87eea11af164cce9c",
    "qa_seed": "2602d9c5d24078cec4dbe5066ff9df71223738e84733747746ff3c55e0678af9",
    "default_seed": "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3",
    "customer_db": "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197",
    "old_signed_qa_exe": "dc7133ca1494249fed5a5a135cd15b1e7a8ba3b5d82876f44b7d09e831666e2c",
    "old_signed_qa_db": "9ae96cee46e1361c8a88f37a4d72e3be535c7e1edd08fdaebfcec12b27db3f65",
    "compiled": "c6d12be7d9b172a8f2296e1c367285819ef03abde91cfcfeace3cbae5513f796",
    "test_signed": "0ead75bea3674509f0368d5779a1c596e6ac3af8fd741d082d2c84eb1e6f0b33",
}


def must(test: bool, explanation: str) -> None:
    if not test:
        raise RuntimeError("Release-blocked signed synthetic QA check: " + explanation)


def hash_file(path: Path, expected: str | None = None) -> str:
    must(path.is_file() and not path.is_symlink(), "file absent or link " + str(path))
    hashed = signer.sha256(path)
    if expected is not None:
        must(hashed == expected, "source/identity/content drift " + str(path))
    return hashed


def windows_signer() -> dict:
    # Windows Authenticode tests cryptographic integrity and emits the test
    # certificate, but an independently self-signed QA root MUST remain
    # UNTRUSTED. UnknownError with *exactly* untrusted-root message is expected.
    script = (
        "$e=Get-Item -LiteralPath '" + str(signer.EXE) + "';"
        "$s=Get-AuthenticodeSignature -LiteralPath '" + str(signer.EXE) + "';"
        "$r=@(Get-ChildItem Cert:\\CurrentUser\\Root,Cert:\\LocalMachine\\Root -ErrorAction SilentlyContinue"
        "|Where-Object {$_.Thumbprint -eq $s.SignerCertificate.Thumbprint});"
        "[pscustomobject]@{status=$s.Status.ToString();reason=$s.StatusMessage;"
        "thumb=$s.SignerCertificate.Thumbprint;version=$e.VersionInfo.ProductVersion;"
        "rootTrustCount=$r.Count}|ConvertTo-Json -Compress"
    )
    command = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                             capture_output=True, text=True, timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=True)
    result = json.loads(command.stdout.strip())
    must(result["status"] == "UnknownError" and "not trusted by the trust provider" in result["reason"],
         "self-signed QA certificate was trusted or signature integrity refused")
    must(result["version"] == "0.2.110" and result["rootTrustCount"] == 0,
         "unexpected version or QA signing root was trusted")
    return result


def attest() -> dict:
    must(os.name == "nt" and not os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"),
         "requires Windows noncommercial QA environment")
    must(QA.is_dir() and not QA.is_symlink() and not MANIFEST.exists(),
         "QA root cannot be linked/reused; existing manifest must not be overwritten")
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    must(config["identifier"] == synthetic.IDENTITY and
         config["mainBinaryName"] == "pharma-v069-synthetic-finance-qa" and
         config["version"] == "0.2.110" and
         config["build"]["beforeBuildCommand"] == "" and
         (PROJECT / "src-tauri" / config["build"]["frontendDist"]).resolve() == STAGE.resolve() and
         config["bundle"]["active"] is False and
         config["bundle"]["createUpdaterArtifacts"] is False and
         config["bundle"]["resources"] == {"qa-resource-v02110/pharma_local.db": "pharma_local.db"},
         "nonproduction app identifier/renderer/config contract changed")
    routes = {
        "migration069": PROJECT / "src-tauri/migrations/069_supplier_return_aware_payment_guard.sql",
        "frontend_index": STAGE / "index.html",
        "frontend_purchase": STAGE / "purchases/new.html",
        "quickadd": PROJECT / "src/components/master-drugs/QuickAddDrugModal.tsx",
        "purchase_source": PROJECT / "src/app/(dashboard)/purchases/new/PurchaseInvoiceClient.tsx",
        "qa_seed": PROJECT / "src-tauri/qa-resource-v02110/pharma_local.db",
        "default_seed": PROJECT / "src-tauri/pharma_local.db",
        "customer_db": Path(os.environ["APPDATA"]) / "com.pharma.system/pharma_local.db",
        "old_signed_qa_exe": (PROJECT.parent / "pharma-builds/v02110-connected-positive-native-756cfb0da5864eac9c4971c9e24bd6c0/Pharma-0.2.110-CONNECTED-POSITIVE-SYNTHETIC-QA-only.exe"),
        "old_signed_qa_db": Path(os.environ["APPDATA"]) / "com.pharma.disposable.connectedpositiveqa20261018/pharma_local.db",
        "compiled": signer.BUILT,
        "test_signed": signer.EXE,
    }
    actual = {key: hash_file(value, EXPECTED[key]) for key, value in routes.items()}
    must('version: 69' in (PROJECT / "src-tauri/src/main.rs").read_text(encoding="utf-8") and
         'include_str!("../migrations/069_supplier_return_aware_payment_guard.sql")' in
         (PROJECT / "src-tauri/src/main.rs").read_text(encoding="utf-8"),
         "compiled v69 native migrations registration missing")

    profile = Path(os.environ["APPDATA"]) / synthetic.IDENTITY
    initial = json.loads((profile / "source.json").read_text(encoding="utf-8"))
    must(initial.get("historical_rows_included") is False and initial.get("synthetic_only") is True and
         initial.get("actor") == synthetic.ACTOR and initial.get("tenant") == synthetic.TENANT,
         "new synthetic QA owner/profile provenance drift")
    original_qa_profile_db = hash_file(profile / "pharma_local.db", initial["db_sha256"])
    with sqlite3.connect((profile / "pharma_local.db").as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        must(db.execute("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1").fetchone() == (67,),
             "new QA fixture must be prelaunch migration v67")
        must(db.execute("SELECT id,pharmacy_id,role FROM users").fetchall() ==
             [(synthetic.ACTOR, synthetic.TENANT, "owner")], "synthetic owner identity mismatch")
        for table in ("inventory", "patients", "suppliers", "purchase_invoices", "sales_invoices", "daily_journals", "journal_entries", "cash_movements"):
            must(db.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone() == (0,),
                 "fresh synthetic business history was not empty")
    synthetic.isolated_constants()
    iss = synthetic.command("issuer-status")
    must(iss["signed_grant_present"] is False and iss["customer_authority"] is False,
         "new synthetic license was already granted or is not QA-only")
    certificate = x509.load_pem_x509_certificate((signer.SIGNER / "qa-cert.pem").read_bytes())
    must(certificate.subject == certificate.issuer, "disposable QA certificate is not self-signed")
    state = windows_signer()
    must(state["thumb"].lower() == certificate.fingerprint(hashes.SHA1()).hex(),
         "Authenticode signer does not match new QA test certificate")
    record = {
        "classification": "SELF_SIGNED_UNTRUSTED_AUTHENTICODE_DISPOSABLE_QA_ONLY",
        "qaOnly": True, "release": "NOT_PRODUCTION_READY",
        "version": "0.2.110", "appId": synthetic.IDENTITY,
        "processExeName": "pharma-v069-synthetic-finance-qa.exe",
        "testSignedExecutableFile": signer.EXE.name,
        "testSignedExecutableSha256": actual["test_signed"].upper(),
        "compiledUnsignedExecutableSha256": actual["compiled"].upper(),
        "testSignedExeBytes": signer.EXE.stat().st_size,
        "testSignedExeProductVersion": state["version"],
        "authenticodeStatus": state["status"],
        "authenticodeReason": state["reason"],
        "codeSigningIssuer": "SELF_SIGNED_EPHEMERAL_TEST_ONLY",
        "codeSigningCertificateThumbprintSHA1": state["thumb"],
        "codeSigningCertificateSha256": certificate.fingerprint(hashes.SHA256()).hex().upper(),
        "codeSigningCertificateNotAfterUtc": certificate.not_valid_after_utc.isoformat(),
        "codeSigningTrustStoreImported": False,
        "testSigningCredentialsFolder": str(signer.SIGNER),
        "testSigningPfxSha256": hash_file(signer.SIGNER / "qa-test-signing.pfx").upper(),
        "testLicensePublicKey": iss["public_key_b64"],
        "testLicenseIssuerFolder": str(synthetic.ISSUER_FOLDER),
        "testOwnerCredentialFolder": str(synthetic.OWNER_FOLDER),
        "testLicenseIssuedAtPackaging": False,
        "commercialLicenseIssued": False,
        "commercialOwnerAuthenticated": False,
        "customerInstallAuthorized": False,
        "customerDataBundled": False,
        "productionPublisherTrusted": False,
        "nativeStrictRendererSqlQa": True,
        "rustToolchain": "1.77.2-x86_64-pc-windows-msvc",
        "cargoProfile": "debug",
        "buildCommand": "npx --no-install tauri build --debug --no-bundle --target x86_64-pc-windows-msvc --config src-tauri/tauri.v02110-v069-signed-synthetic-finance-qa.conf.json --ci",
        "beforeBuildCommandDisabled": True,
        "bundledInstaller": False,
        "updaterArtifactsCreated": False,
        "nativeSqlx069Registered": True,
        "sourceSHA256": {key: value.upper() for key, value in actual.items() if key not in ("compiled", "test_signed")},
        "initialSyntheticProfileSha256": original_qa_profile_db.upper(),
        "initialSyntheticSqlxVersion": 67,
        "initialSyntheticBusinessRows": 0,
        "previousSignedQaPid25528Targeted": False,
        "applicationOrInstallerExecutedAtPackaging": False,
        "financialTransactionPostedAtPackaging": False,
        "guiDebugPortReservedForFutureRun": 9369,
    }
    with MANIFEST.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return {"result": "PASS_UNSIGNED_FOR_COMMERCE_TEST_SIGNED_SYNTHETIC_V69_QA",
            "manifestPath": str(MANIFEST), "manifestSha256": hash_file(MANIFEST),
            "signedExeSha256": actual["test_signed"],
            "trustedByWindows": False, "issuerPublicKey": iss["public_key_b64"],
            "customerOrPreviousQaTouched": False}


if __name__ == "__main__":
    try:
        print(json.dumps(attest(), sort_keys=True))
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as failure:
        print("SIGNED SYNTHETIC v69 QA ATTESTATION REFUSED: " + str(failure), file=sys.stderr)
        raise SystemExit(2)
