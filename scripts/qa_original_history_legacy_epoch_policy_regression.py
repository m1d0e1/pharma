"""Synthetic controlled-operator witness tests: no customer DB/key access."""
from __future__ import annotations

import base64
from contextlib import redirect_stderr
import copy
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import sqlite3
import unittest
import uuid
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts import qa_original_history_legacy_epoch_policy as policy


NOW = int(datetime(2026, 10, 23, 9, 0, tzinfo=timezone.utc).timestamp())
LAST = "2026-10-19 18:00:00"
WITNESS = sha256(b"synthetic-in-memory-aggregate-witness").hexdigest()


def _public(private: Ed25519PrivateKey) -> bytes:
    return private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _iso(utc_seconds: int) -> str:
    return datetime.fromtimestamp(utc_seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _statement() -> dict:
    documents = [
        {"id": kind, "kind": kind,
         "sha256": sha256(("synthetic external evidence " + kind).encode()).hexdigest()}
        for kind in sorted(policy.EVIDENCE_KINDS)
    ]
    lines = []
    for bucket, (direction, kind) in sorted(policy.BUCKETS.items()):
        amount = 100_00 if bucket in ("cash", "opening_equity_credit") else 0
        lines.append({
            "bucket": bucket,
            "debit_cents": amount if direction == "debit" else 0,
            "credit_cents": amount if direction == "credit" else 0,
            "evidence_ids": [kind],
        })
    return {
        "format": policy.FORMAT,
        "purpose": policy.PURPOSE,
        "tenant": policy.TENANT,
        "original_v29_sha256": policy.ORIGINAL_V29_SHA256,
        "native_sqlx69_sha256": policy.finance.PIN,
        "historical_witness_sha256": WITNESS,
        "cutover_at_local": "2026-10-21T09:00:00+03:00",
        "cutover_at_utc": "2026-10-21T06:00:00Z",
        "source_timezone": "Africa/Cairo",
        "latest_legacy_source_at_local": LAST,
        "opening_lines": lines,
        "evidence": documents,
        "exceptions": copy.deepcopy(policy.EXCEPTIONS),
        "legacy_policy": copy.deepcopy(policy.POLICY),
        "request_id": str(uuid.uuid4()),
        "owner_operator_signer_id": "operator-for-owner-review-A",
        "accountant_operator_signer_id": "operator-for-accountant-review-B",
        "issued_at_utc": NOW - 60,
        "expires_at_utc": NOW + 600,
    }


def _reviewed_statement() -> dict:
    statement = _statement()
    subject = policy._review_subject(statement)
    statement["human_authorizations"] = {
        "owner": {
            "authorization_evidence_id": "owner_authorization_record",
            "authenticated_at_utc": _iso(NOW - 55),
            "authentication_method": "independently_witnessed_in_person_identity_and_assent",
            "review_subject_sha256": subject,
        },
        "accountant": {
            "authorization_evidence_id": "accountant_authorization_record",
            "authenticated_at_utc": _iso(NOW - 50),
            "authentication_method": "independently_authenticated_documented_consent",
            "review_subject_sha256": subject,
        },
    }
    return statement


def _packet(statement: dict, owner_operator: Ed25519PrivateKey,
            accountant_operator: Ed25519PrivateKey) -> dict:
    commitment = policy._digest(statement)
    witnesses = {}
    for role, identifier, signer, delay in (
        ("owner", "operator-for-owner-review-A", owner_operator, 40),
        ("accountant", "operator-for-accountant-review-B", accountant_operator, 30),
    ):
        claim = {
            "operator_signer_id": identifier,
            "witnessed_at_utc": _iso(NOW - delay),
            "declaration": "witnessed_prior_authenticated_human_review_with_external_evidence",
        }
        signed = (policy.DOMAIN + role.encode("ascii") + b"\0"
                  + bytes.fromhex(commitment) + policy._canonical(claim))
        witnesses[role] = {
            **claim,
            "signature_b64": base64.urlsafe_b64encode(signer.sign(signed)).rstrip(b"=").decode(),
        }
    return {"statement": statement, "commitment_sha256": commitment,
            "operator_witnesses": witnesses}


class LegacyEpochOpeningBalanceTests(unittest.TestCase):
    def setUp(self):
        self.owner_operator = Ed25519PrivateKey.generate()
        self.accountant_operator = Ed25519PrivateKey.generate()
        self.roots = policy._TrustRoots(
            policy._Signer("operator-for-owner-review-A", _public(self.owner_operator)),
            policy._Signer("operator-for-accountant-review-B", _public(self.accountant_operator)),
        )
        self.statement = _reviewed_statement()
        self.packet = _packet(self.statement, self.owner_operator, self.accountant_operator)

    def verify(self, packet=None, roots=None, *, request=None, witness=None, latest=None, now=None):
        return policy.verify_packet(
            self.packet if packet is None else packet,
            witness_sha256=WITNESS if witness is None else witness,
            latest_legacy_source_at_local=LAST if latest is None else latest,
            roots=self.roots if roots is None else roots,
            now_utc=NOW if now is None else now,
            expected_request_id=self.statement["request_id"] if request is None else request,
        )

    def test_distinct_operator_witnesses_bind_exact_balances_but_cannot_authenticate_humans(self):
        result = self.verify()
        self.assertEqual(result["status"], "TECHNICAL_OPERATOR_WITNESS_RECORDS_VERIFIED_HUMAN_AUTHORIZATION_PENDING")
        self.assertEqual(result["immutable_opening_balance_commitment_sha256"],
                         self.packet["commitment_sha256"])
        self.assertTrue(result["distinct_controlled_operator_witness_signatures_verified"])
        self.assertTrue(result["owner_and_accountant_authorization_evidence_digests_bound"])
        self.assertFalse(result["owner_and_accountant_human_authorization_independently_verified"])
        self.assertTrue(result["operator_assertion_alone_is_not_human_authorization"])
        self.assertFalse(result["production_allowed"])
        self.assertFalse(result["opening_balance_posting_implemented"])
        self.assertFalse(result["historical_receipt_payment_status_inferred"])
        self.assertEqual(self.statement["legacy_policy"]["historic_sale_payment_status"],
                         "unverified_do_not_infer_from_paid_remaining_headers")

    def test_absent_accountant_operator_witness_and_untrusted_signature_rejected(self):
        unsigned = copy.deepcopy(self.packet)
        del unsigned["operator_witnesses"]["accountant"]
        with self.assertRaises(policy.CutoverDenied):
            self.verify(unsigned)
        forged = copy.deepcopy(self.packet)
        forged["operator_witnesses"]["accountant"]["signature_b64"] = (
            base64.urlsafe_b64encode(b"\0" * 64).rstrip(b"=").decode())
        with self.assertRaises(policy.CutoverDenied):
            self.verify(forged)

    def test_two_operator_claims_cannot_turn_unverified_human_consent_into_approval(self):
        # Even when the synthetic operators create an internally coherent
        # packet declaring they witnessed consent, signatures do not prove
        # the purported owner/accountant actually reviewed anything.
        unsigned_claims = copy.deepcopy(self.statement)
        unsigned_claims["human_authorizations"]["owner"]["authentication_method"] = (
            "independently_authenticated_documented_consent"
        )
        forged_but_structurally_valid = _packet(
            unsigned_claims, self.owner_operator, self.accountant_operator
        )
        result = self.verify(forged_but_structurally_valid)
        self.assertFalse(result["owner_and_accountant_human_authorization_independently_verified"])
        self.assertFalse(result["production_allowed"])
        self.assertFalse(result["opening_balance_posting_implemented"])

    def test_separately_authenticated_owner_and_accountant_records_required(self):
        changes = (
            lambda s: s.pop("human_authorizations"),
            lambda s: s["human_authorizations"].pop("owner"),
            lambda s: s["human_authorizations"].pop("accountant"),
            lambda s: s["human_authorizations"]["owner"].__setitem__(
                "authorization_evidence_id", "accountant_authorization_record"),
            lambda s: s["human_authorizations"]["accountant"].__setitem__(
                "authorization_evidence_id", "owner_authorization_record"),
            lambda s: s["human_authorizations"]["owner"].__setitem__(
                "authentication_method", "operator_assertion_only"),
            lambda s: s["human_authorizations"]["owner"].__setitem__(
                "review_subject_sha256", "0" * 64),
            lambda s: s["human_authorizations"]["accountant"].__setitem__(
                "review_subject_sha256", "0" * 64),
            lambda s: s["human_authorizations"]["owner"].__setitem__(
                "authenticated_at_utc", _iso(NOW - 100)),
            lambda s: s["human_authorizations"]["accountant"].__setitem__(
                "authenticated_at_utc", _iso(NOW - 20)),
            lambda s: s["human_authorizations"]["owner"].__setitem__(
                "authenticated_at_utc", "not-a-date"),
            lambda s: s["human_authorizations"]["owner"].__setitem__(
                "additional_unverified_approval", True),
        )
        for change in changes:
            with self.subTest(change=change):
                statement = copy.deepcopy(self.statement)
                change(statement)
                with self.assertRaises(policy.CutoverDenied):
                    self.verify(_packet(statement, self.owner_operator,
                                        self.accountant_operator))

    def test_signed_financial_changes_need_fresh_human_review_subject(self):
        changed = copy.deepcopy(self.statement)
        changed["opening_lines"] = copy.deepcopy(changed["opening_lines"])
        for line in changed["opening_lines"]:
            if line["bucket"] == "cash":
                line["debit_cents"] += 5
            elif line["bucket"] == "opening_equity_credit":
                line["credit_cents"] += 5
        # Balanced values and two new operator signatures are still insufficient
        # if the recorded human consent is for the previous proposal.
        with self.assertRaises(policy.CutoverDenied):
            self.verify(_packet(changed, self.owner_operator, self.accountant_operator))
        changed_docs = copy.deepcopy(self.statement)
        for item in changed_docs["evidence"]:
            if item["kind"] == "bank_statement":
                item["sha256"] = sha256(b"different synthetic bank evidence").hexdigest()
                break
        # Changing the supporting documents after human review also requires
        # a fresh independent consent to that exact reviewed document digest.
        with self.assertRaises(policy.CutoverDenied):
            self.verify(_packet(changed_docs, self.owner_operator, self.accountant_operator))

    def test_role_swapping_and_one_operator_signing_both_roles_denied(self):
        swapped = copy.deepcopy(self.packet)
        swapped["operator_witnesses"]["owner"]["signature_b64"], swapped["operator_witnesses"]["accountant"]["signature_b64"] = (
            swapped["operator_witnesses"]["accountant"]["signature_b64"],
            swapped["operator_witnesses"]["owner"]["signature_b64"])
        with self.assertRaises(policy.CutoverDenied):
            self.verify(swapped)
        same_key_roots = policy._TrustRoots(self.roots.owner_operator,
                                           policy._Signer("operator-for-accountant-review-B", _public(self.owner_operator)))
        with self.assertRaises(policy.CutoverDenied):
            self.verify(roots=same_key_roots)
        same_id_roots = policy._TrustRoots(
            self.roots.owner_operator, policy._Signer(self.roots.owner_operator.signer_id, _public(self.accountant_operator)))
        with self.assertRaises(policy.CutoverDenied):
            self.verify(roots=same_id_roots)
        with self.assertRaises(policy.CutoverDenied):
            policy.verify_packet(self.packet, witness_sha256=WITNESS,
                                 latest_legacy_source_at_local=LAST,
                                 roots=None, now_utc=NOW,
                                 expected_request_id=self.statement["request_id"])

    def test_post_signature_mutation_to_source_buckets_documents_cutover_or_claim_denied(self):
        mutators = (
            lambda s: s.__setitem__("native_sqlx69_sha256", "a" * 64),
            lambda s: s.__setitem__("original_v29_sha256", "a" * 64),
            lambda s: s.__setitem__("tenant", "another_pharmacy"),
            lambda s: s["opening_lines"][0].__setitem__("debit_cents", 900),
            lambda s: s["evidence"][0].__setitem__("sha256", "1" * 64),
            lambda s: s.__setitem__("cutover_at_local", "2026-10-22T09:00:00+03:00"),
            lambda s: s["legacy_policy"].__setitem__("historic_sale_payment_status", "all_paid"),
            lambda s: s.__setitem__("historical_witness_sha256", "f" * 64),
        )
        for mutate in mutators:
            with self.subTest(mutate=mutate):
                changed = copy.deepcopy(self.packet)
                mutate(changed["statement"])
                with self.assertRaises(policy.CutoverDenied):
                    self.verify(changed)

    def test_even_correctly_signed_unbalanced_unknown_or_forged_payment_status_denied(self):
        for field, replacement in (
            ("exceptions", {**self.statement["exceptions"],
                            "all_original_sales_paid_remaining_headers_zero": "all_paid"}),
            ("legacy_policy", {**self.statement["legacy_policy"],
                               "historic_supplier_payment_status": "all_paid"}),
        ):
            with self.subTest(field=field):
                statement = copy.deepcopy(self.statement)
                statement[field] = replacement
                with self.assertRaises(policy.CutoverDenied):
                    self.verify(_packet(statement, self.owner_operator, self.accountant_operator))
        for change in (
            lambda s: s["opening_lines"][0].__setitem__("debit_cents", 1),
            lambda s: s["opening_lines"][0].__setitem__("credit_cents", 1),
            lambda s: s["opening_lines"][0].__setitem__("debit_cents", 1.5),
            lambda s: s["opening_lines"][0].__setitem__("debit_cents", True),
            lambda s: s["opening_lines"].pop(),
            lambda s: s["opening_lines"].__setitem__(0, s["opening_lines"][1]),
        ):
            with self.subTest(change=change):
                statement = copy.deepcopy(self.statement)
                change(statement)
                with self.assertRaises(policy.CutoverDenied):
                    self.verify(_packet(statement, self.owner_operator, self.accountant_operator))

    def test_independently_signed_but_unsupported_documentation_denied(self):
        transformations = (
            lambda s: s["evidence"].pop(),
            lambda s: s["evidence"].__setitem__(0, s["evidence"][1]),
            lambda s: s["evidence"][0].__setitem__("sha256", "0" * 64),
            lambda s: s["evidence"][0].__setitem__("sha256", s["evidence"][1]["sha256"]),
            lambda s: s["opening_lines"][0].__setitem__("evidence_ids", ["cutover_authorization"]),
            lambda s: s["opening_lines"][0].__setitem__("evidence_ids", []),
            lambda s: s["evidence"][0].__setitem__("patient_name", "FORBIDDEN"),
        )
        for mutate in transformations:
            with self.subTest(mutate=mutate):
                statement = copy.deepcopy(self.statement)
                mutate(statement)
                with self.assertRaises(policy.CutoverDenied):
                    self.verify(_packet(statement, self.owner_operator, self.accountant_operator))

    def test_signed_early_cutover_inconsistent_offset_future_issuance_and_expiry_denied(self):
        replacements = (
            ("cutover_at_local", "2026-10-19T18:00:00+03:00"),
            ("cutover_at_local", "2026-10-21T09:00:00"),
            ("cutover_at_local", "2026-10-21T09:00:00+15:00"),
            ("cutover_at_utc", "2026-10-21T07:00:00Z"),
            ("cutover_at_utc", "2026-10-21"),
            ("source_timezone", "unknown"),
            ("issued_at_utc", NOW + 500),
            ("expires_at_utc", NOW - 1),
            ("request_id", str(uuid.uuid1())),
        )
        for field, value in replacements:
            with self.subTest(field=field, value=value):
                statement = copy.deepcopy(self.statement)
                statement[field] = value
                with self.assertRaises(policy.CutoverDenied):
                    self.verify(_packet(statement, self.owner_operator, self.accountant_operator))

    def test_replay_wrong_witness_and_late_source_activity_denied(self):
        for kwargs in ({"request": str(uuid.uuid4())}, {"witness": "f" * 64},
                       {"latest": "2026-10-22 00:00:00"}, {"now": NOW + 601}):
            with self.subTest(kwargs=kwargs), self.assertRaises(policy.CutoverDenied):
                self.verify(**kwargs)

    def test_operator_witness_timestamp_declaration_and_identity_participate_in_signature(self):
        for role in ("owner", "accountant"):
            for prop, replacement in (("witnessed_at_utc", _iso(NOW - 20)),
                                      ("declaration", "approved_without_review"),
                                      ("operator_signer_id", "synthetic-impostor")):
                with self.subTest(role=role, prop=prop):
                    altered = copy.deepcopy(self.packet)
                    altered["operator_witnesses"][role][prop] = replacement
                    with self.assertRaises(policy.CutoverDenied):
                        self.verify(altered)

    def test_malformed_extra_data_duplicate_keys_nonfinite_and_no_trust_roots_denied(self):
        extra = copy.deepcopy(self.packet)
        extra["statement"]["paid_amount"] = 0
        with self.assertRaises(policy.CutoverDenied):
            self.verify(extra)
        with self.assertRaises(policy.CutoverDenied):
            json.loads('{"bucket":1,"bucket":2}', object_pairs_hook=policy._unique_json)
        with self.assertRaises(policy.CutoverDenied):
            json.loads('{"money":NaN}', parse_constant=policy._nonfinite)
        with self.assertRaises(policy.CutoverDenied):
            policy._installed_roots()

    def test_real_cli_fails_before_looking_at_source_or_packet(self):
        with patch.object(policy.custody, "disposable_root", side_effect=AssertionError("source accessed")), \
                patch.object(policy, "_read_packet", side_effect=AssertionError("packet accessed")):
            err = io.StringIO()
            with redirect_stderr(err):
                result = policy.main(["--packet", "nonexistent", "--expected-request-id", "untrusted"])
            self.assertEqual(result, 3)
            self.assertIn("REFUSED_UNACCEPTED_LEGACY_FINANCIAL_CUTOVER", err.getvalue())

    def test_invalid_in_memory_source_is_not_accepted_as_historic_census(self):
        with sqlite3.connect(":memory:") as db:
            with self.assertRaises(sqlite3.Error):
                policy.historical_witness(db)


if __name__ == "__main__":
    unittest.main(verbosity=1)
