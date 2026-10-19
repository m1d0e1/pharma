"""Detached financial consent evidence ingestion and independent-issuer preflight.

No customer signing keys. A separately controlled consent verifier must first
authenticate each real human's review of an exact source-bound balance proposal
and issue a cryptographic receipt for that decision and retained private proof.
Two other controlled operators witness the two records via the legacy policy.
An operator alone cannot manufacture an accepted approval. Operational consent
issuer and operator public trust anchors are deliberately not provisioned.

This is strictly read-only QA/preflight. A valid independent consent proof is
still NOT a native posting, installation, or historical-receipt authorization.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from scripts import qa_original_history_legacy_epoch_policy as policy


CONSENT_FORMAT = "pharma-independent-human-financial-consent-receipt-v1"
CONSENT_DOMAIN = b"PHARMA:INDEPENDENT:HUMAN-FINANCIAL-CONSENT:V1\x00"
MANIFEST_FORMAT = "pharma-private-legacy-epoch-consent-evidence-manifest-v1"
MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024
MAX_RECEIPT_BYTES = 64 * 1024
PRIVATE_FOLDER = "pharma-original-financial-consent-private"
FLAT_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,95}\.(?:pdf|png|jpg|jpeg|txt|json|bin)\Z")

# Two independent consent-verifier credentials are under separate operational
# control from both operator-witness keys. Neither user-supplied JSON, CLI
# parameters nor environment variables are a trusted enrollment mechanism.
_AUTHORIZED_OWNER_CONSENT_ISSUER_PUBLIC_KEY_HEX: str | None = None
_AUTHORIZED_ACCOUNTANT_CONSENT_ISSUER_PUBLIC_KEY_HEX: str | None = None
_AUTHORIZED_OWNER_CONSENT_ISSUER_ID: str | None = None
_AUTHORIZED_ACCOUNTANT_CONSENT_ISSUER_ID: str | None = None


@dataclass(frozen=True)
class IndependentConsentRoots:
    owner: policy._Signer
    accountant: policy._Signer


class ConsentDenied(ValueError):
    """Sanitized refusal; never echo file names or private approval contents."""


def _issuer_roots() -> IndependentConsentRoots:
    values = (_AUTHORIZED_OWNER_CONSENT_ISSUER_PUBLIC_KEY_HEX,
              _AUTHORIZED_ACCOUNTANT_CONSENT_ISSUER_PUBLIC_KEY_HEX,
              _AUTHORIZED_OWNER_CONSENT_ISSUER_ID,
              _AUTHORIZED_ACCOUNTANT_CONSENT_ISSUER_ID)
    if any(not isinstance(value, str) or not value for value in values):
        raise ConsentDenied("Independently controlled consent verifier authority unavailable")
    try:
        return IndependentConsentRoots(
            policy._Signer(values[2], bytes.fromhex(values[0])),
            policy._Signer(values[3], bytes.fromhex(values[1])),
        )
    except ValueError as exc:
        raise ConsentDenied("Invalid protected consent verifier authority") from exc


def _validate_roots(issuers: IndependentConsentRoots,
                    operators: policy._TrustRoots) -> None:
    if not isinstance(issuers, IndependentConsentRoots) or not isinstance(operators, policy._TrustRoots):
        raise ConsentDenied("Both independent consent and operator credentials required")
    pair = (issuers.owner, issuers.accountant)
    ops = (operators.owner_operator, operators.accountant_operator)
    all_signers = pair + ops
    if (any(not isinstance(s, policy._Signer) or not isinstance(s.signer_id, str)
            or policy.SIGNER.fullmatch(s.signer_id) is None or type(s.public_key) is not bytes
            or len(s.public_key) != 32 for s in all_signers)
            or len({s.signer_id for s in all_signers}) != 4
            or len({s.public_key for s in all_signers}) != 4):
        raise ConsentDenied("Consent issuers must be independent of each other and operators")


def _sha_file_bytes(data: bytes) -> str:
    if type(data) is not bytes or not 1 <= len(data) <= MAX_DOCUMENT_BYTES:
        raise ConsentDenied("Private evidence document is missing or oversized")
    return sha256(data).hexdigest()


def _verify_manifest(statement: dict, manifest: Any, documents: dict[str, bytes]) -> dict[str, str]:
    if not isinstance(manifest, dict) or set(manifest) != {"format", "documents"}:
        raise ConsentDenied("Private evidence manifest incomplete")
    if manifest["format"] != MANIFEST_FORMAT or not isinstance(manifest["documents"], list):
        raise ConsentDenied("Unknown private evidence inventory")
    referenced = statement["evidence"]
    if len(manifest["documents"]) != len(referenced) or len(documents) != len(referenced):
        raise ConsentDenied("Every independently referenced document must be ingested")
    expected = {item["id"]: item["sha256"] for item in referenced}
    if len(expected) != len(referenced):
        raise ConsentDenied("Ambiguous financial source-document IDs")
    seen: set[str] = set()
    filenames: set[str] = set()
    for entry in manifest["documents"]:
        if not isinstance(entry, dict) or set(entry) != {"evidence_id", "filename"}:
            raise ConsentDenied("Invalid private evidence manifest entry")
        ref, filename = entry["evidence_id"], entry["filename"]
        if (type(ref) is not str or ref not in expected or ref in seen
                or type(filename) is not str or FLAT_NAME.fullmatch(filename) is None
                or filename in filenames):
            raise ConsentDenied("Unrecognized, duplicate or unsafe private evidence reference")
        if filename not in documents or _sha_file_bytes(documents[filename]) != expected[ref]:
            raise ConsentDenied("Original private evidence bytes do not match signed review")
        seen.add(ref)
        filenames.add(filename)
    if seen != set(expected) or set(documents) != filenames:
        raise ConsentDenied("Unexpected or missing external documentary evidence")
    return {entry["evidence_id"]: entry["filename"] for entry in manifest["documents"]}


def verify_external_consent(packet: Any, receipt_bundle: Any,
                            evidence_manifest: Any, document_bytes: dict[str, bytes],
                            *, operators: policy._TrustRoots,
                            issuers: IndependentConsentRoots,
                            witness_sha256: str,
                            latest_legacy_source_at_local: str,
                            now_utc: int, expected_request_id: str) -> dict:
    """Verify actual document bytes and independently signed consent receipts.

    A trusted external identity/consent verifier is responsible for validating
    the real human and their decision. A signature proves that verifier issued
    the attestation; it cannot independently prove honesty of an issuer. Real
    trust anchors, issuer procedures and artifacts are still required.
    """
    _validate_roots(issuers, operators)
    # Prior source review, finance/tender policy, and both operator signatures.
    operator = policy.verify_packet(
        packet, witness_sha256=witness_sha256,
        latest_legacy_source_at_local=latest_legacy_source_at_local,
        roots=operators, now_utc=now_utc, expected_request_id=expected_request_id,
    )
    statement = packet["statement"]
    files_by_id = _verify_manifest(statement, evidence_manifest, document_bytes)
    if not isinstance(receipt_bundle, dict) or set(receipt_bundle) != {"format", "receipts"}:
        raise ConsentDenied("Independent human consent receipts missing")
    if receipt_bundle["format"] != CONSENT_FORMAT:
        raise ConsentDenied("Unknown independent consent receipt format")
    receipts = receipt_bundle["receipts"]
    if not isinstance(receipts, dict) or set(receipts) != {"owner", "accountant"}:
        raise ConsentDenied("Both distinct human consent verification receipts required")
    signed_subject = policy._review_subject(statement)
    seen_receipt_ids: set[str] = set()
    seen_subjects: set[str] = set()
    for role, issuer in (("owner", issuers.owner), ("accountant", issuers.accountant)):
        envelope = receipts[role]
        if not isinstance(envelope, dict) or set(envelope) != {"assertion", "signature_b64"}:
            raise ConsentDenied("Malformed independent consent issuer envelope")
        claim = envelope["assertion"]
        fields = {"format", "consenting_role", "issuer_id", "receipt_id", "tenant",
                  "native_sqlx69_sha256", "request_id", "review_subject_sha256",
                  "human_consent_evidence_sha256", "human_consent_evidence_id",
                  "consenting_subject_reference_sha256", "authentication_method",
                  "authenticated_at_utc", "issued_at_utc", "affirmation"}
        if not isinstance(claim, dict) or set(claim) != fields:
            raise ConsentDenied("Independent consent verifier assertion incomplete")
        record = statement["human_authorizations"][role]
        ref = record["authorization_evidence_id"]
        consent_evidence = next((e for e in statement["evidence"] if e["id"] == ref), None)
        if consent_evidence is None:
            raise ConsentDenied("Independently referenced approval record missing")
        subject_ref = claim["consenting_subject_reference_sha256"]
        if (claim["format"] != CONSENT_FORMAT or claim["consenting_role"] != role
                or claim["issuer_id"] != issuer.signer_id
                or claim["tenant"] != policy.TENANT
                or claim["native_sqlx69_sha256"] != policy.finance.PIN
                or claim["request_id"] != statement["request_id"]
                or claim["review_subject_sha256"] != signed_subject
                or claim["human_consent_evidence_sha256"] != consent_evidence["sha256"]
                or claim["human_consent_evidence_id"] != ref
                or claim["authentication_method"] != record["authentication_method"]
                or claim["authenticated_at_utc"] != record["authenticated_at_utc"]
                or claim["affirmation"] != "identity_verified_and_human_approved_exact_financial_review"
                or not isinstance(subject_ref, str) or policy.SHA.fullmatch(subject_ref) is None
                or subject_ref == "0" * 64 or subject_ref in seen_subjects):
            raise ConsentDenied("External verifier did not authenticate the same owner's/accountant's exact approval")
        seen_subjects.add(subject_ref)
        if (not isinstance(claim["receipt_id"], str)
                or policy.IDENTIFIER.fullmatch(claim["receipt_id"]) is None
                or claim["receipt_id"] in seen_receipt_ids):
            raise ConsentDenied("Consent receipt identity missing or reused")
        seen_receipt_ids.add(claim["receipt_id"])
        authenticated = policy._utc(claim["authenticated_at_utc"]).timestamp()
        issued = policy._utc(claim["issued_at_utc"]).timestamp()
        witness_time = policy._utc(packet["operator_witnesses"][role]["witnessed_at_utc"]).timestamp()
        if (not statement["issued_at_utc"] <= authenticated <= issued <= witness_time
                or issued > now_utc + 120 or issued > statement["expires_at_utc"]):
            raise ConsentDenied("Independent consent verification was not completed before witness")
        # The real document contents were hashed above. This assertion can
        # only bind to those bytes, not a self-described document name.
        if files_by_id.get(ref) not in document_bytes:
            raise ConsentDenied("Verified human review document not found")
        message = (CONSENT_DOMAIN + role.encode("ascii") + b"\x00"
                   + policy._canonical(claim))
        try:
            Ed25519PublicKey.from_public_bytes(issuer.public_key).verify(
                policy._signature(envelope["signature_b64"]), message)
        except (InvalidSignature, ValueError) as exc:
            raise ConsentDenied("Independent human consent verifier signature invalid") from exc
    return {
        "status": "VERIFIED_EXTERNAL_CONSENT_DOCUMENTS_AND_INDEPENDENT_ISSUER_WITNESSES_NO_PRODUCTION_GRANT",
        "source_sha256": policy.finance.PIN,
        "opening_balance_commitment_sha256": operator["immutable_opening_balance_commitment_sha256"],
        "all_required_private_document_bytes_sha256_verified": True,
        "independent_owner_and_accountant_consent_issuer_attestations_verified": True,
        "distinct_operator_witnesses_verified": True,
        "independent_consent_evidence_crypto_validated": True,
        "operator_assertion_alone_accepted": False,
        "external_issuer_truth_and_real_human_assent_require_governed_trust": True,
        "historical_payment_status_inferred": False,
        "historic_native_receipts_created": False,
        "opening_balance_journal_posted": False,
        "database_mutations": 0,
        "production_allowed": False,
    }


def _private_root() -> Path:
    """Fixed *detached* private area; never application installation or repo."""
    root = policy.custody.disposable_root()
    private = root / PRIVATE_FOLDER
    if not root.is_dir():
        raise ConsentDenied("Detached private evidence parent is unavailable")
    policy.custody._safe_component(root)
    if (not private.is_dir() or private.is_symlink()
            or getattr(private.lstat(), "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise ConsentDenied("Protected private review folder unavailable")
    return private


def _private_read(root: Path, name: str, limit: int) -> bytes:
    if type(name) is not str or FLAT_NAME.fullmatch(name) is None:
        raise ConsentDenied("Private evidence basename rejected")
    path = root / name
    before = path.lstat()
    if (not path.is_file() or path.is_symlink() or before.st_size < 1 or before.st_size > limit
            or before.st_nlink != 1 or getattr(before, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise ConsentDenied("Private evidence source is not a regular unique file")
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    after = path.lstat()
    if (len(data) > limit or len(data) != before.st_size or
            (before.st_ino, before.st_mtime_ns, before.st_size) !=
            (after.st_ino, after.st_mtime_ns, after.st_size)):
        raise ConsentDenied("Detached evidence changed during inspection")
    return data


def _json_blob(raw: bytes) -> Any:
    return json.loads(raw, object_pairs_hook=policy._unique_json,
                      parse_constant=policy._nonfinite)


def _read_private_evidence(root: Path, statement: dict) -> tuple[dict, dict, dict]:
    manifest = _json_blob(_private_read(root, "document-manifest.json", MAX_MANIFEST_BYTES))
    receipt_bundle = _json_blob(_private_read(root, "consent-receipts.json", MAX_RECEIPT_BYTES))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("documents"), list):
        raise ConsentDenied("Detached review document manifest unavailable")
    if len(manifest["documents"]) != len(statement["evidence"]):
        raise ConsentDenied("Detached source document list incomplete")
    filenames = []
    for item in manifest["documents"]:
        if not isinstance(item, dict):
            raise ConsentDenied("Invalid detached document entry")
        name = item.get("filename")
        if type(name) is not str or FLAT_NAME.fullmatch(name) is None:
            raise ConsentDenied("Invalid detached evidence basename")
        filenames.append(name)
    if len(set(filenames)) != len(filenames):
        raise ConsentDenied("Duplicated private evidence filename")
    contents: dict[str, bytes] = {}
    total = 0
    for name in filenames:
        raw = _private_read(root, name, MAX_DOCUMENT_BYTES)
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise ConsentDenied("Private evidence cumulative budget exceeded")
        contents[name] = raw
    return manifest, receipt_bundle, contents


class _SafeParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, "DENIED: invalid private financial consent preflight arguments\n")


def main(argv: list[str] | None = None) -> int:
    parser = _SafeParser(description="Independently witnessed private consent read-only preflight")
    parser.add_argument("--expected-request-id", required=True,
                        help="Already issued UUID-v4 review challenge")
    args = parser.parse_args(argv)
    try:
        # Trust anchors first: never inspect original history, documents, or
        # private profile based only on an operator's statement.
        operators = policy._installed_roots()
        issuers = _issuer_roots()
        _validate_roots(issuers, operators)
        root = _private_root()
        packet_bytes = _private_read(root, "cutover-packet.json", policy.MAX_PACKET_BYTES)
        manifest_bytes = _private_read(root, "document-manifest.json", MAX_MANIFEST_BYTES)
        receipt_bytes = _private_read(root, "consent-receipts.json", MAX_RECEIPT_BYTES)
        packet = _json_blob(packet_bytes)
        source_path = (policy.custody.disposable_root() /
                       policy.finance.STAGE / policy.finance.NAME)
        raw = policy.custody.checked_file(source_path, policy.finance.PIN)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            witness, latest = policy.historical_witness(db)
        if sha256(source_path.read_bytes()).hexdigest() != policy.finance.PIN:
            raise ConsentDenied("Detached SQLx69 source changed during consent preflight")
        statement = packet["statement"]
        manifest, receipts, docs = _read_private_evidence(root, statement)
        result = verify_external_consent(
            packet, receipts, manifest, docs,
            operators=operators, issuers=issuers, witness_sha256=witness,
            latest_legacy_source_at_local=latest, now_utc=int(time.time()),
            expected_request_id=args.expected_request_id,
        )
        # Check file fingerprints twice; reject concurrent private modifications.
        for entry in manifest["documents"]:
            filename = entry["filename"]
            if _private_read(root, filename, MAX_DOCUMENT_BYTES) != docs[filename]:
                raise ConsentDenied("Detached approval document changed during preflight")
        if (sha256(source_path.read_bytes()).hexdigest() != policy.finance.PIN
                or _private_read(root, "cutover-packet.json", policy.MAX_PACKET_BYTES) != packet_bytes
                or _private_read(root, "document-manifest.json", MAX_MANIFEST_BYTES) != manifest_bytes
                or _private_read(root, "consent-receipts.json", MAX_RECEIPT_BYTES) != receipt_bytes):
            raise ConsentDenied("Source or cutover packet changed during preflight")
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ConsentDenied, policy.CutoverDenied, ValueError, KeyError, TypeError,
            OSError, sqlite3.Error, policy.custody.Refused):
        print(json.dumps({"status": "BLOCKED_UNVERIFIED_EXTERNAL_FINANCIAL_CONSENT",
                          "production_allowed": False, "database_mutations": 0}, sort_keys=True),
              file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
