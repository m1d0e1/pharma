"""Synthetic-only detached consent-provider, operator and artifact tamper tests."""
from __future__ import annotations

import base64
from contextlib import redirect_stderr
import copy
from hashlib import sha256
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts import qa_original_history_legacy_epoch_consent_preflight as consent
from scripts import qa_original_history_legacy_epoch_policy as policy
from scripts import qa_original_history_legacy_epoch_policy_regression as original


def _pub(private: Ed25519PrivateKey) -> bytes:
    return private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)


class DetachedIndependentConsentRegressions(unittest.TestCase):
    def setUp(self) -> None:
        self.operator_owner = Ed25519PrivateKey.generate()
        self.operator_accountant = Ed25519PrivateKey.generate()
        self.provider_owner = Ed25519PrivateKey.generate()
        self.provider_accountant = Ed25519PrivateKey.generate()
        self.operator_roots = policy._TrustRoots(
            policy._Signer("controlled-owner-review-operator", _pub(self.operator_owner)),
            policy._Signer("controlled-accountant-review-operator", _pub(self.operator_accountant)),
        )
        self.issuer_roots = consent.IndependentConsentRoots(
            policy._Signer("independent-owner-approval-provider", _pub(self.provider_owner)),
            policy._Signer("independent-accountant-approval-provider", _pub(self.provider_accountant)),
        )
        statement = original._reviewed_statement()
        statement["owner_operator_signer_id"] = self.operator_roots.owner_operator.signer_id
        statement["accountant_operator_signer_id"] = self.operator_roots.accountant_operator.signer_id
        self.packet = self._operator_packet(statement)
        self.docs = {}
        manifest_entries = []
        for evidence in statement["evidence"]:
            name = f"{evidence['id']}.pdf"
            # Small synthetic fake PDF bytes. Only the bytes/digests matter;
            # neither content nor person/financial data are test inputs.
            data = b"%PDF-SYNTHETIC-TEST-NO-REAL-APPROVAL\n" + evidence["id"].encode()
            evidence["sha256"] = sha256(data).hexdigest()
            self.docs[name] = data
            manifest_entries.append({"evidence_id": evidence["id"], "filename": name})
        # The exact same document commitments are now within the review subject.
        for role in ("owner", "accountant"):
            statement["human_authorizations"][role]["review_subject_sha256"] = (
                policy._review_subject(statement))
        self.packet = self._operator_packet(statement)
        self.manifest = {"format": consent.MANIFEST_FORMAT, "documents": manifest_entries}
        self.receipts = self._issuer_receipts(statement)

    def _operator_packet(self, statement: dict) -> dict:
        commitment = policy._digest(statement)
        witnesses = {}
        for role, signer_id, signer, timestamp in (
            ("owner", self.operator_roots.owner_operator.signer_id,
             self.operator_owner, original.NOW - 40),
            ("accountant", self.operator_roots.accountant_operator.signer_id,
             self.operator_accountant, original.NOW - 30),
        ):
            claim = {
                "operator_signer_id": signer_id,
                "witnessed_at_utc": original._iso(timestamp),
                "declaration": "witnessed_prior_authenticated_human_review_with_external_evidence",
            }
            content = (policy.DOMAIN + role.encode() + b"\0"
                       + bytes.fromhex(commitment) + policy._canonical(claim))
            witnesses[role] = {
                **claim,
                "signature_b64": base64.urlsafe_b64encode(signer.sign(content)).rstrip(b"=").decode(),
            }
        return {"statement": statement, "commitment_sha256": commitment,
                "operator_witnesses": witnesses}

    def _issuer_receipts(self, statement: dict) -> dict:
        receipts = {}
        for role, signer_id, signer, name, issued in (
            ("owner", self.issuer_roots.owner.signer_id, self.provider_owner,
             "consent_owner_receipt", original.NOW - 45),
            ("accountant", self.issuer_roots.accountant.signer_id,
             self.provider_accountant, "consent_accountant_receipt", original.NOW - 35),
        ):
            record = statement["human_authorizations"][role]
            evidence = next(e for e in statement["evidence"]
                            if e["id"] == record["authorization_evidence_id"])
            assertion = {
                "format": consent.CONSENT_FORMAT,
                "consenting_role": role,
                "issuer_id": signer_id,
                "receipt_id": name,
                "tenant": policy.TENANT,
                "native_sqlx69_sha256": policy.finance.PIN,
                "request_id": statement["request_id"],
                "review_subject_sha256": policy._review_subject(statement),
                "human_consent_evidence_sha256": evidence["sha256"],
                "human_consent_evidence_id": evidence["id"],
                "consenting_subject_reference_sha256": sha256(role.encode() + b"-synthetic-subject").hexdigest(),
                "authentication_method": record["authentication_method"],
                "authenticated_at_utc": record["authenticated_at_utc"],
                "issued_at_utc": original._iso(issued),
                "affirmation": "identity_verified_and_human_approved_exact_financial_review",
            }
            content = consent.CONSENT_DOMAIN + role.encode() + b"\0" + policy._canonical(assertion)
            receipts[role] = {
                "assertion": assertion,
                "signature_b64": base64.urlsafe_b64encode(signer.sign(content)).rstrip(b"=").decode(),
            }
        return {"format": consent.CONSENT_FORMAT, "receipts": receipts}

    def check(self, *, packet=None, receipts=None, manifest=None, documents=None,
              operators=None, issuers=None, witness=None, now=None) -> dict:
        return consent.verify_external_consent(
            self.packet if packet is None else packet,
            self.receipts if receipts is None else receipts,
            self.manifest if manifest is None else manifest,
            self.docs if documents is None else documents,
            operators=self.operator_roots if operators is None else operators,
            issuers=self.issuer_roots if issuers is None else issuers,
            witness_sha256=original.WITNESS if witness is None else witness,
            latest_legacy_source_at_local=original.LAST,
            now_utc=original.NOW if now is None else now,
            expected_request_id=self.packet["statement"]["request_id"],
        )

    def test_independent_issuer_verifies_real_document_bytes_but_no_prod_grant(self):
        result = self.check()
        self.assertTrue(result["all_required_private_document_bytes_sha256_verified"])
        self.assertTrue(result["independent_owner_and_accountant_consent_issuer_attestations_verified"])
        self.assertFalse(result["operator_assertion_alone_accepted"])
        self.assertFalse(result["historical_payment_status_inferred"])
        self.assertFalse(result["historic_native_receipts_created"])
        self.assertFalse(result["opening_balance_journal_posted"])
        self.assertFalse(result["production_allowed"])

    def test_missing_or_changed_real_evidence_bytes_fails_even_with_valid_signatures(self):
        name = next(iter(self.docs))
        missing = dict(self.docs)
        missing.pop(name)
        with self.assertRaises(consent.ConsentDenied):
            self.check(documents=missing)
        tampered = dict(self.docs)
        tampered[name] += b"modified"
        with self.assertRaises(consent.ConsentDenied):
            self.check(documents=tampered)
        extra = dict(self.docs)
        extra["unrecognized.pdf"] = b"private synthetic extra"
        with self.assertRaises(consent.ConsentDenied):
            self.check(documents=extra)

    def test_operator_only_even_two_valid_signatures_and_docs_cannot_self_certify(self):
        missing = {"format": consent.CONSENT_FORMAT, "receipts": {}}
        with self.assertRaises(consent.ConsentDenied):
            self.check(receipts=missing)
        for role in ("owner", "accountant"):
            partially_verified = copy.deepcopy(self.receipts)
            partially_verified["receipts"].pop(role)
            with self.assertRaises(consent.ConsentDenied):
                self.check(receipts=partially_verified)

    def test_self_appointed_consent_issuer_cannot_equal_any_operator(self):
        fake = consent.IndependentConsentRoots(
            policy._Signer("fake-independent-owner", _pub(self.operator_owner)),
            self.issuer_roots.accountant,
        )
        with self.assertRaises(consent.ConsentDenied):
            self.check(issuers=fake)
        same = consent.IndependentConsentRoots(self.issuer_roots.owner,
                                               policy._Signer("second", _pub(self.provider_owner)))
        with self.assertRaises(consent.ConsentDenied):
            self.check(issuers=same)
        with self.assertRaises(consent.ConsentDenied):
            self.check(issuers="operator-assertion")
        with self.assertRaises(consent.ConsentDenied):
            consent._issuer_roots()

    def test_forged_issuer_signature_and_swapped_receipts_rejected(self):
        forged = copy.deepcopy(self.receipts)
        forged["receipts"]["accountant"]["signature_b64"] = (
            base64.urlsafe_b64encode(b"\0" * 64).rstrip(b"=").decode())
        with self.assertRaises(consent.ConsentDenied):
            self.check(receipts=forged)
        switched = copy.deepcopy(self.receipts)
        switched["receipts"]["owner"], switched["receipts"]["accountant"] = (
            switched["receipts"]["accountant"], switched["receipts"]["owner"])
        with self.assertRaises(consent.ConsentDenied):
            self.check(receipts=switched)

    def test_claim_mutations_refused_even_if_issuer_re_signs_changed_claim(self):
        modifications = (
            ("native_sqlx69_sha256", "a" * 64),
            ("tenant", "another_pharmacy"),
            ("request_id", "fake-request"),
            ("consenting_role", "accountant"),
            ("consenting_subject_reference_sha256", "0" * 64),
            ("issuer_id", "operator-for-owner-review"),
            ("review_subject_sha256", "a" * 64),
            ("human_consent_evidence_sha256", "1" * 64),
            ("human_consent_evidence_id", "cash_count"),
            ("authenticated_at_utc", original._iso(original.NOW - 120)),
            ("issued_at_utc", original._iso(original.NOW - 20)),
            ("affirmation", "operator_guesses_customer_approved"),
        )
        for field, value in modifications:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.receipts)
                assertion = changed["receipts"]["owner"]["assertion"]
                assertion[field] = value
                message = (consent.CONSENT_DOMAIN + b"owner\0" + policy._canonical(assertion))
                changed["receipts"]["owner"]["signature_b64"] = (
                    base64.urlsafe_b64encode(self.provider_owner.sign(message)).rstrip(b"=").decode())
                with self.assertRaises(consent.ConsentDenied):
                    self.check(receipts=changed)

    def test_manifest_duplicates_traversal_symlink_and_missing_names_denied(self):
        variations = (
            lambda m: m["documents"].pop(),
            lambda m: m["documents"][0].__setitem__("filename", "../outside.pdf"),
            lambda m: m["documents"][0].__setitem__("filename", "C:\\Windows\\record.pdf"),
            lambda m: m["documents"][0].__setitem__("filename", m["documents"][1]["filename"]),
            lambda m: m["documents"][0].__setitem__("evidence_id", m["documents"][1]["evidence_id"]),
        )
        for mutate in variations:
            with self.subTest(mutate=mutate):
                manifest = copy.deepcopy(self.manifest)
                mutate(manifest)
                with self.assertRaises(consent.ConsentDenied):
                    self.check(manifest=manifest)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(consent.ConsentDenied):
                consent._private_read(root, "../outside.pdf", 100)
            source = root / "real.pdf"
            source.write_bytes(b"synthetic")
            symlink = root / "fake.pdf"
            try:
                symlink.symlink_to(source)
            except (OSError, NotImplementedError):
                pass  # Windows often lacks symlink permission; path traversal still tested.
            else:
                with self.assertRaises(consent.ConsentDenied):
                    consent._private_read(root, "fake.pdf", 100)

    def test_actual_private_directory_bytes_ingested_and_verified(self):
        # External document files exist only under a synthetic temporary root;
        # never write user profile, installed DB, original archive or QA copies.
        with tempfile.TemporaryDirectory() as temporary:
            private = Path(temporary)
            (private / "document-manifest.json").write_bytes(
                policy._canonical(self.manifest))
            (private / "consent-receipts.json").write_bytes(
                policy._canonical(self.receipts))
            for name, raw in self.docs.items():
                (private / name).write_bytes(raw)
            manifest, receipts, docs = consent._read_private_evidence(
                private, self.packet["statement"])
            self.assertTrue(self.check(manifest=manifest, receipts=receipts,
                                       documents=docs)["independent_consent_evidence_crypto_validated"])
            first_name = next(iter(self.docs))
            (private / first_name).write_bytes(b"modified private evidence")
            altered_manifest, altered_receipts, altered_docs = consent._read_private_evidence(
                private, self.packet["statement"])
            with self.assertRaises(consent.ConsentDenied):
                self.check(manifest=altered_manifest, receipts=altered_receipts,
                           documents=altered_docs)

    def test_duplicate_json_keys_and_nonfinite_private_receipt_are_rejected(self):
        with self.assertRaises(policy.CutoverDenied):
            consent._json_blob(b'{"format":"v1","format":"v2"}')
        with self.assertRaises(policy.CutoverDenied):
            consent._json_blob(b'{"consent":Infinity}')

    def test_no_installed_roots_cli_refuses_before_reading_any_private_source(self):
        with patch.object(policy, "_installed_roots", side_effect=policy.CutoverDenied("no keys")), \
                patch.object(consent, "_private_root", side_effect=AssertionError("private directory opened")):
            output = io.StringIO()
            with redirect_stderr(output):
                rc = consent.main(["--expected-request-id", self.packet["statement"]["request_id"]])
            self.assertEqual(rc, 3)
            self.assertIn("BLOCKED_UNVERIFIED_EXTERNAL_FINANCIAL_CONSENT", output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=1)
