"""Windows laptop-only Pharma license issuer. NOT a customer/prod authority.

Run from the project root: python -m scripts.licensing.local_qa init
The separate operator signing seed and activation credential are DPAPI-sealed
for this Windows account; nothing secret is written to the repository.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import secrets
import ssl
import sys
import time
from urllib.error import HTTPError
from urllib.request import (
    HTTPSHandler,
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
)

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from .authority import Authority, Rejected, _b64url, verify_activation_envelope

LOCAL_HTTPS_PORT = 18765


def directory() -> Path:
    if os.name != "nt" or not os.environ.get("LOCALAPPDATA"):
        raise RuntimeError("Local license QA requires a Windows user profile")
    return Path(os.environ["LOCALAPPDATA"]) / "PharmaLicenseQAOperator"


def state_path() -> Path:
    return directory() / "operator.dpapi"


def tls_paths(operator_directory: Path | None = None) -> tuple[Path, Path]:
    folder = (operator_directory if operator_directory is not None else directory()) / "https-local"
    return folder / "localhost.crt.pem", folder / "localhost.key.pem"


def init_local_tls(operator_directory: Path | None = None) -> dict:
    """A short-lived self-signed *leaf*, not a general-purpose signing CA."""
    certificate_file, private_key_file = tls_paths(operator_directory)
    if certificate_file.exists() or private_key_file.exists():
        raise RuntimeError("Existing QA HTTPS certificate/key must be reviewed; refusing replacement")
    certificate_file.parent.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Pharma QA localhost only")])
    certificate = (x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=14))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
            key_encipherment=True, data_encipherment=False, key_agreement=False,
            key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .sign(key, hashes.SHA256()))
    # The TLS leaf key stays in a profile-owned folder outside the repository.
    # Operator should retain the default Windows ACL (this user's profile,
    # Administrators, SYSTEM), not copy this key to a public directory.
    with private_key_file.open("xb") as output:
        output.write(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption()))
        output.flush()
        os.fsync(output.fileno())
    with certificate_file.open("xb") as output:
        output.write(certificate.public_bytes(serialization.Encoding.PEM))
        output.flush()
        os.fsync(output.fileno())
    return {"certificate_file": str(certificate_file),
            "thumbprint_sha1": certificate.fingerprint(hashes.SHA1()).hex().upper(),
            "expires_at_utc": certificate.not_valid_after_utc.isoformat()}


def verify_local_tls(operator_directory: Path | None = None) -> dict:
    certificate_file, private_key_file = tls_paths(operator_directory)
    cert = x509.load_pem_x509_certificate(certificate_file.read_bytes())
    if cert.subject != cert.issuer or cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value != "Pharma QA localhost only":
        raise RuntimeError("Unexpected QA TLS certificate identity")
    if cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
        raise RuntimeError("Refusing a CA certificate for localhost QA trust")
    sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    if sans.get_values_for_type(x509.DNSName) != ["localhost"] or sans.get_values_for_type(x509.IPAddress) != [ipaddress.ip_address("127.0.0.1")]:
        raise RuntimeError("QA TLS certificate includes an unapproved SAN")
    eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    if list(eku) != [ExtendedKeyUsageOID.SERVER_AUTH]:
        raise RuntimeError("QA TLS certificate is not restricted to server authentication")
    if not cert.not_valid_before_utc <= datetime.now(timezone.utc) < cert.not_valid_after_utc:
        raise RuntimeError("QA TLS certificate has expired")
    key = serialization.load_pem_private_key(private_key_file.read_bytes(), password=None)
    if key.public_key().public_numbers() != cert.public_key().public_numbers():
        raise RuntimeError("QA TLS leaf public/private key mismatch")
    return {"certificate_file": str(certificate_file), "private_key_file": str(private_key_file),
            "thumbprint_sha1": cert.fingerprint(hashes.SHA1()).hex().upper(),
            "expires_at_utc": cert.not_valid_after_utc.isoformat()}


def protect(data: bytes) -> bytes:
    try:
        import win32crypt
    except ImportError as exc:
        raise RuntimeError("This local-only QA tool requires pywin32 (python -m pip install pywin32)") from exc
    return win32crypt.CryptProtectData(data, "Pharma local QA only", None, None, None, 0)


def unprotect(data: bytes) -> bytes:
    import win32crypt
    return win32crypt.CryptUnprotectData(data, None, None, None, 0)[1]


def load() -> dict:
    return json.loads(unprotect(state_path().read_bytes()).decode("utf-8"))


def save(state: dict) -> None:
    path = state_path()
    sealed = protect(json.dumps(state, separators=(",", ":")).encode())
    temporary = path.with_name("operator.pending.dpapi")
    if temporary.exists():
        raise RuntimeError("An interrupted operator update requires manual review; refusing overwrite")
    with temporary.open("xb") as handle:
        handle.write(sealed)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def issuer(state: dict) -> Authority:
    seed = base64.urlsafe_b64decode(state["seed"] + "=")
    return Authority(
        directory() / "issuer.sqlite",
        Ed25519PrivateKey.from_private_bytes(seed),
        operator_secret=state["operator_token"],
    )


def activate(authority: Authority, credentials: dict) -> dict:
    return authority.activate(
        license_id=credentials["license_id"],
        activation_code=credentials["activation_code"],
        machine_fingerprint=credentials["machine_fingerprint"],
        request_nonce=_b64url(secrets.token_bytes(32)),
        requested_at_utc=int(time.time()),
    )


def qa_https_smoke(authority: Authority, credentials: dict) -> dict:
    """Client cert-validation and signed POST through the actual local TLS API."""
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=ssl.create_default_context()),
                          HTTPRedirectHandler())
    url = f"https://localhost:{LOCAL_HTTPS_PORT}"
    with opener.open(url + "/v1/public-key", timeout=8) as response:
        published = json.load(response)
    if published.get("ok") is not True or published.get("result", {}).get("issuer_public_key_b64") != authority.issuer_public_key_b64:
        raise RuntimeError("HTTPS authority public key differs from the QA issuer")
    nonce = _b64url(secrets.token_bytes(32))
    request = Request(url + "/v1/activate", data=json.dumps({
        "license_id": credentials["license_id"],
        "activation_code": credentials["activation_code"],
        "machine_fingerprint": credentials["machine_fingerprint"],
        "request_nonce": nonce,
        "requested_at_utc": int(time.time()),
    }).encode("utf-8"), method="POST", headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=8) as response:
        answer = json.load(response)
    if answer.get("ok") is not True:
        raise RuntimeError("HTTPS QA activation did not return a signed lease")
    signed = answer.get("result")
    verified = verify_activation_envelope(signed, authority.issuer_public_key_b64,
        machine_fingerprint=credentials["machine_fingerprint"], now_utc=int(time.time()))
    try:
        opener.open(request, timeout=8)
        raise RuntimeError("QA HTTPS authority accepted a reused activation nonce")
    except HTTPError as exc:
        if exc.code != 409:
            raise RuntimeError("QA HTTPS replay test rejected with wrong status") from exc
    return {"https_verified": True, "signed_serial": verified["activation_serial"],
            "nonce_replay_rejected": True, "public_key_matched": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Isolated Windows Pharma license QA; never production")
    parser.add_argument("command", choices=("init", "public-key", "grant", "renew", "status",
        "tls-init", "tls-info", "serve-https", "online-credential", "qa-owner-password",
        "https-smoke"))
    parser.add_argument("--fingerprint", default="", help="Copy the 64-character fingerprint from the QA desktop")
    parser.add_argument("--days", type=int, default=7, help="Synthetic subscription term, 1..30 days")
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            if state_path().exists() or (directory() / "issuer.sqlite").exists():
                raise RuntimeError("QA issuer already exists; refusing to rotate keys or reset serials")
            directory().mkdir(parents=True, exist_ok=True)
            state = {"seed": _b64url(secrets.token_bytes(32)), "operator_token": secrets.token_urlsafe(32)}
            save(state)
            authority = issuer(state)
            print(json.dumps({"ready": True, "public_key_b64": authority.issuer_public_key_b64,
                              "qa_operator_directory": str(directory())}))
            return 0
        if args.command == "tls-init":
            print(json.dumps(init_local_tls()))
            return 0
        if args.command == "tls-info":
            print(json.dumps(verify_local_tls()))
            return 0
        state = load()
        authority = issuer(state)
        if args.command == "serve-https":
            from .server import serve_https
            tls = verify_local_tls()
            serve_https(authority, host="127.0.0.1", public_host="localhost",
                        port=LOCAL_HTTPS_PORT,
                        certificate=tls["certificate_file"], private_key=tls["private_key_file"])
            return 0
        if args.command == "https-smoke":
            credentials = state.get("credentials")
            if credentials is None:
                raise RuntimeError("QA license is required for HTTPS smoke")
            print(json.dumps(qa_https_smoke(authority, credentials)))
            return 0
        if args.command == "online-credential":
            credentials = state.get("credentials")
            if credentials is None:
                raise RuntimeError("Issue a QA license before retrieving its online credential")
            print(json.dumps({"license_id": credentials["license_id"],
                              "activation_code": credentials["activation_code"]}))
            return 0
        if args.command == "qa-owner-password":
            if state.get("credentials") is None:
                raise RuntimeError("Issue a QA license before creating a QA owner password")
            if not state.get("qa_owner_password"):
                # Not a production/user password: recoverable from this account's
                # DPAPI state, randomly generated for the disposable QA owner only.
                while True:
                    candidate = "Xy9!" + secrets.token_urlsafe(26)
                    if "admin" not in candidate.lower():
                        break
                state["qa_owner_password"] = candidate
                save(state)
            print(json.dumps({"qa_owner_password": state["qa_owner_password"]}))
            return 0
        if args.command == "public-key":
            print(authority.issuer_public_key_b64)
        elif args.command == "grant":
            if "credentials" in state:
                raise RuntimeError("This QA operator already has a grant; use renew, not another issue")
            if len(args.fingerprint) != 64 or any(c not in "0123456789abcdef" for c in args.fingerprint):
                raise RuntimeError("Copy the exact 64-character lowercase QA desktop fingerprint")
            if not 1 <= args.days <= 30:
                raise RuntimeError("--days must be between 1 and 30")
            record = authority.create_license(expires_at_utc=int(time.time()) + args.days * 86400,
                                              operator_token=state["operator_token"], actor_id="laptop-qa")
            state["credentials"] = {
                "license_id": record["license_id"], "activation_code": record["activation_code"],
                "machine_fingerprint": args.fingerprint,
            }
            save(state)  # Save the one-time bearer credential before attempting to use it.
            signed = activate(authority, state["credentials"])
            verify_activation_envelope(signed, authority.issuer_public_key_b64,
                                       machine_fingerprint=args.fingerprint, now_utc=int(time.time()))
            print(json.dumps({"license_id": record["license_id"], "signed_license": signed}))
        elif args.command == "renew":
            credentials = state.get("credentials")
            if credentials is None:
                raise RuntimeError("No QA grant: use grant with fingerprint first")
            signed = activate(authority, credentials)
            verify_activation_envelope(signed, authority.issuer_public_key_b64,
                                       machine_fingerprint=credentials["machine_fingerprint"], now_utc=int(time.time()))
            print(json.dumps({"license_id": credentials["license_id"], "signed_license": signed}))
        elif args.command == "status":
            credentials = state.get("credentials")
            if credentials is None:
                print(json.dumps({"state": "not-issued", "public_key_b64": authority.issuer_public_key_b64}))
            else:
                print(json.dumps(authority.status(license_id=credentials["license_id"],
                                                 operator_token=state["operator_token"])))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, Rejected) as exc:
        print("Local QA: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
