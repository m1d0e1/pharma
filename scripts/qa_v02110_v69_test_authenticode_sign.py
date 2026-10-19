"""One-time, self-signed Authenticode for the isolated v69 synthetic QA EXE.

The signer/certificate are NOT approved for customer software or production
licenses. Never import the certificate into any trust store. No timestamps,
remote CA, network calls, NSIS, or application execution. The test-only PFX,
encrypted private PEM, cert, and DPAPI-sealed PFX password stay in the QA tree.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes

from scripts.licensing.local_qa import protect, unprotect
from scripts import qa_v02110_v69_signed_synthetic_fixture as fixture


QA = fixture.QA_ROOT
SIGNER = QA / "test-authenticode-credentials"
EXE = QA / "Pharma-0.2.110-V069-SYNTHETIC-FINANCE-TEST-SIGNED-QA-only.exe"
BUILT = QA / "cargo-target/x86_64-pc-windows-msvc/debug/pharma-v069-synthetic-finance-qa.exe"
OPENSSL = Path(r"C:\Program Files\Git\mingw64\bin\openssl.exe")
SIGNTOOL = Path(r"C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1048576), b""):
            digest.update(part)
    return digest.hexdigest()


def run(arguments: list[str], *, environment: dict | None = None) -> None:
    completed = subprocess.run(arguments, cwd=SIGNER, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, timeout=100,
                               env=environment, check=False,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode != 0:
        raise RuntimeError("Local offline test-signing command failed; exit " +
                           str(completed.returncode) + ": " +
                           completed.stderr[-350:])


def sign() -> dict:
    if os.name != "nt" or os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("Windows test-only signing permitted only without release approval")
    if not QA.is_dir() or QA.is_symlink() or not SIGNER.is_dir() or SIGNER.is_symlink():
        raise RuntimeError("Dedicated QA-only signer directory unavailable")
    if not OPENSSL.is_file() or not SIGNTOOL.is_file() or not BUILT.is_file() or BUILT.is_symlink():
        raise RuntimeError("Isolated compiled binary or signing tools absent")
    key = SIGNER / "qa-private-encrypted.pem"
    cert = SIGNER / "qa-cert.pem"
    pfx = SIGNER / "qa-test-signing.pfx"
    dpapi_password = SIGNER / "pfx-password.dpapi"
    retained = (key, cert, dpapi_password)
    resume_partial = all(path.is_file() and not path.is_symlink() for path in retained)
    if not resume_partial and any(path.exists() or path.is_symlink() for path in retained):
        raise RuntimeError("Interrupted test signer requires explicit review, not key replacement")
    resume_unsigned = (resume_partial and pfx.is_file() and not pfx.is_symlink()
                       and EXE.is_file() and not EXE.is_symlink()
                       and sha256(EXE) == sha256(BUILT))
    if (pfx.exists() or pfx.is_symlink() or EXE.exists() or EXE.is_symlink()) and not resume_unsigned:
        raise RuntimeError("Existing signed or inconsistent QA output: refuse overwrite")
    profile = Path(os.environ["APPDATA"]) / fixture.IDENTITY / "source.json"
    if not profile.is_file():
        raise RuntimeError("New synthetic QA profile must exist before signing")
    evidence = json.loads(profile.read_text(encoding="utf-8"))
    if (evidence.get("app_id") != fixture.IDENTITY or
            evidence.get("historical_rows_included") is not False):
        raise RuntimeError("Synthetic QA profile provenance drift")

    # Do not let inherited directory ACLs expose credentials. Only current
    # Windows account and SYSTEM may read this fresh signer directory.
    account = os.environ.get("USERNAME", "")
    if not account or any(char in account for char in "\r\n:/"):
        raise RuntimeError("Invalid signing ACL account")
    run(["icacls.exe", str(SIGNER), "/inheritance:r",
         "/grant:r", account + ":(OI)(CI)F", "/grant:r", "SYSTEM:(OI)(CI)F"])

    password = (unprotect(dpapi_password.read_bytes()).decode("ascii")
                if resume_partial else secrets.token_urlsafe(45))
    qa_signing_environment = {**os.environ, "PHARMA_V69_QA_TEST_SIGN_PASS": password}
    try:
        # A random TEST password, never real account/license credentials.
        if not resume_partial:
            dpapi_password.write_bytes(protect(password.encode("ascii")))
            run([str(OPENSSL), "genpkey", "-algorithm", "RSA", "-pkeyopt",
                 "rsa_keygen_bits:3072", "-aes-256-cbc", "-pass", "env:PHARMA_V69_QA_TEST_SIGN_PASS",
                 "-out", str(key)], environment=qa_signing_environment)
            run([str(OPENSSL), "req", "-new", "-x509", "-sha256", "-days", "14",
                 "-key", str(key), "-passin", "env:PHARMA_V69_QA_TEST_SIGN_PASS",
                 "-subj", "/CN=Pharma Disposable V69 TEST ONLY Not a Customer Publisher",
                 "-addext", "basicConstraints=critical,CA:FALSE",
                 "-addext", "keyUsage=critical,digitalSignature",
                 "-addext", "extendedKeyUsage=codeSigning", "-out", str(cert)],
                environment=qa_signing_environment)
        if not resume_unsigned:
            run([str(OPENSSL), "pkcs12", "-export", "-inkey", str(key),
                 "-passin", "env:PHARMA_V69_QA_TEST_SIGN_PASS", "-in", str(cert),
                 "-out", str(pfx), "-passout", "env:PHARMA_V69_QA_TEST_SIGN_PASS"],
                environment=qa_signing_environment)
        contents = x509.load_pem_x509_certificate(cert.read_bytes())
        eku = contents.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        if x509.oid.ExtendedKeyUsageOID.CODE_SIGNING not in eku:
            raise RuntimeError("QA certificate lacks Code Signing EKU")
        if not resume_unsigned:
            EXE.write_bytes(BUILT.read_bytes())
        # Windows SDK SignTool on this host rejects @responsefile invocation.
        # The random, *disposable test-only* PFX password is transiently passed
        # to the child process. It is never written in plaintext or logged;
        # commercial certificate/operator secrets must NEVER use this flow.
        run([str(SIGNTOOL), "sign", "/fd", "SHA256", "/f", str(pfx),
             "/p", password, "/d",
             "Pharma v69 SYNTHETIC QA no production authorization", str(EXE)])
        return {
            "testOnly": True,
            "certificateSubject": contents.subject.rfc4514_string(),
            "certificateSha256": contents.fingerprint(hashes.SHA256()).hex(),
            "certificateThumbprintSHA1": contents.fingerprint(hashes.SHA1()).hex(),
            "certificateNotAfterUtc": contents.not_valid_after_utc.isoformat(),
            "codeSigningEku": True,
            "selfSignedNotTrustedForProduction": True,
            "trustStoreImported": False,
            "qaExecutable": str(EXE),
            "unsignedCompiledSourceSha256": sha256(BUILT),
            "testSignedExeSha256": sha256(EXE),
            "certificatePemSha256": sha256(cert),
            "credentialFolder": str(SIGNER),
            "signingPasswordStoredOnlyAsDpapiFile": True,
            "customerCredentialsUsed": False,
            "productionReleaseAuthorized": False,
        }
    finally:
        qa_signing_environment.pop("PHARMA_V69_QA_TEST_SIGN_PASS", None)


if __name__ == "__main__":
    try:
        print(json.dumps(sign(), sort_keys=True))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        print("V69 TEST SIGNING REFUSED: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
