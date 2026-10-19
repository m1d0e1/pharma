"""Read-only review-witness policy for the immutable SQLx69 legacy epoch.

Owner and accountant approve business records through independently authenticated
ordinary review. They are NOT key custodians: distinct, controlled *operators*
may sign evidence of that prior human authorization. The cryptographic check
only confirms operator signatures and record binding. It does not authenticate
the actual humans, inspect private approval documents, or authorize posting.
No operator trust roots or human approval verifiers are installed here.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_original_history_cash_tender_transition as tender
from scripts import qa_v02110_primary_pharmacy_migration as custody


FORMAT = "pharma-original-history-legacy-epoch-opening-balance-v2"
PURPOSE = "independent-legacy-epoch-opening-balance-review-only"
DOMAIN = b"PHARMA:ORIGINAL:LEGACY-EPOCH:OPENING-BALANCE:V2\x00"
TENANT = "primary_pharmacy"
ORIGINAL_V29_SHA256 = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"
MAX_PACKET_BYTES = 128 * 1024
MAX_APPROVAL_AGE_SECONDS = 30 * 24 * 3600
SHA = re.compile(r"[0-9a-f]{64}\Z")
IDENTIFIER = re.compile(r"[a-z][a-z0-9_-]{2,63}\Z")
SIGNER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")

# Operational witness operator roots MUST come from separately controlled,
# independently reviewed service-side provisioning in a future implementation.
# Owners and accountants never enroll or manage cryptographic keys.
# No environment variable, packet, CLI parameter or synthetic QA signer can
# install them. This module always refuses operational CLI verification today.
_AUTHORIZED_OWNER_OPERATOR_PUBLIC_KEY_HEX: str | None = None
_AUTHORIZED_ACCOUNTANT_OPERATOR_PUBLIC_KEY_HEX: str | None = None
_AUTHORIZED_OWNER_OPERATOR_SIGNER_ID: str | None = None
_AUTHORIZED_ACCOUNTANT_OPERATOR_SIGNER_ID: str | None = None


class CutoverDenied(ValueError):
    """Fail closed without leaking source financial data or document names."""


@dataclass(frozen=True)
class _Signer:
    signer_id: str
    public_key: bytes


@dataclass(frozen=True)
class _TrustRoots:
    owner_operator: _Signer
    accountant_operator: _Signer


# Debit and credit directions describe an actual balanced journal proposal,
# not historical receipts or a request to write into the normalized source.
BUCKETS = {
    "cash": ("debit", "cash_count"),
    "bank": ("debit", "bank_statement"),
    "customer_receivables": ("debit", "receivables_schedule"),
    "inventory_at_cost": ("debit", "physical_inventory_count"),
    "supplier_credits": ("debit", "supplier_statement"),
    "suspense_debit": ("debit", "dispute_register"),
    "opening_equity_debit": ("debit", "equity_reconciliation"),
    "supplier_payables": ("credit", "supplier_statement"),
    "patient_wallet_liability": ("credit", "patient_wallet_schedule"),
    "customer_credit_liability": ("credit", "credit_memo_schedule"),
    "suspense_credit": ("credit", "dispute_register"),
    "opening_equity_credit": ("credit", "equity_reconciliation"),
}
EVIDENCE_KINDS = {kind for _, kind in BUCKETS.values()} | {
    "cutover_authorization", "owner_authorization_record", "accountant_authorization_record",
}
AUTHENTICATION_METHODS = {
    "independently_witnessed_in_person_identity_and_assent",
    "independently_authenticated_documented_consent",
}
# A human must authorize the exact financial proposal. Consent records should
# refer to this independent digest, avoiding circular references to their own
# evidence SHA-256 and subsequent operator witness signatures.
REVIEW_SUBJECT_KEYS = {
    "tenant", "original_v29_sha256", "native_sqlx69_sha256",
    "historical_witness_sha256", "cutover_at_local", "cutover_at_utc",
    "source_timezone", "latest_legacy_source_at_local", "opening_lines",
    "exceptions", "legacy_policy", "request_id",
}
EXCEPTIONS = {
    "all_original_sales_paid_remaining_headers_zero": "unverified_no_payment_inference",
    "pre_shared_shift_sales_returns": "preserve_original_null_shift_ids",
    "supplier_payment_references_without_invoice_match": "external_receipts_not_inferred",
    "sale_lines_without_original_inventory_lot": "original_cogs_not_inferred",
    "shift_discrepancies": "carry_forward_for_independent_review",
}
POLICY = {
    "historic_sale_payment_status": "unverified_do_not_infer_from_paid_remaining_headers",
    "historic_supplier_payment_status": "externally_unverified_no_native_receipt_backfill",
    "historic_patient_ar_wallet_status": "independent_opening_balance_review_required",
    "historic_pre_shift_null_shift_ids": "preserve_original_before_shared_shift",
    "historic_rows_journals_stock_and_cost": "immutable_no_historical_reposting",
    "post_cutover_transactions": "new_native_receipted_events_only",
    "opening_balance_journal": "deferred_separate_native_transaction_after_review",
}
STATEMENT_KEYS = {
    "format", "purpose", "tenant", "original_v29_sha256",
    "native_sqlx69_sha256", "historical_witness_sha256", "cutover_at_local",
    "cutover_at_utc", "source_timezone", "latest_legacy_source_at_local",
    "opening_lines", "evidence", "exceptions", "legacy_policy", "request_id",
    "owner_operator_signer_id", "accountant_operator_signer_id",
    "human_authorizations", "issued_at_utc", "expires_at_utc",
}


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise CutoverDenied("Invalid cutover canonical evidence") from exc


def _digest(value: Any) -> str:
    return sha256(DOMAIN + _canonical(value)).hexdigest()


def _review_subject(statement: dict) -> str:
    subject = {field: statement[field] for field in sorted(REVIEW_SUBJECT_KEYS)}
    # The business reviewers must approve the exact independent *supporting*
    # source-document commitments too. Exclude only their own consent records:
    # including those would create a circular consent-document hash.
    subject["reviewed_document_commitments"] = [
        item for item in statement["evidence"]
        if isinstance(item, dict) and item.get("kind") not in {
            "owner_authorization_record", "accountant_authorization_record"
        }
    ]
    return _digest(subject)


def _utc(value: Any) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value):
        raise CutoverDenied("Cutover UTC timestamp must be second-precision Z")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise CutoverDenied("Invalid cutover UTC timestamp") from exc


def _local(value: Any) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d", value):
        raise CutoverDenied("Cutover requires explicit offset and seconds")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise CutoverDenied("Invalid offset-aware cutover time") from exc
    if parsed.utcoffset() is None or abs(parsed.utcoffset()) > timedelta(hours=14):
        raise CutoverDenied("Invalid cutover UTC offset")
    return parsed


def _counted_cents(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 10**13:
        raise CutoverDenied("Opening money must be bounded nonnegative integer cents")
    return value


def historical_witness(db: sqlite3.Connection) -> tuple[str, str]:
    """Hash SQLx69 aggregate evidence and chronology, never source row details.

    Called only on a separately SHA-pinned, deserialized RAM snapshot. Existing
    strict witnessed counts ensure historical payment status is not assumed.
    """
    db.execute("PRAGMA query_only=ON")
    financial = finance.check(db)
    cash = tender.check(db)  # includes patient, supplier AP and link checks
    latest = db.execute("""
        SELECT MAX(ts) FROM (
            SELECT MAX(datetime(created_at)) ts FROM sales_invoices
            UNION ALL SELECT MAX(datetime(created_at)) FROM returns
            UNION ALL SELECT MAX(datetime(created_at)) FROM purchase_invoices
            UNION ALL SELECT MAX(datetime(created_at)) FROM purchase_returns
            UNION ALL SELECT MAX(datetime(date)) FROM daily_journals
            UNION ALL SELECT MAX(datetime(created_at)) FROM daily_journals
            UNION ALL SELECT MAX(datetime(date)) FROM supplier_transactions
            UNION ALL SELECT MAX(datetime(created_at)) FROM supplier_transactions
            UNION ALL SELECT MAX(datetime(date)) FROM patient_transactions
            UNION ALL SELECT MAX(datetime(created_at)) FROM patient_transactions
            UNION ALL SELECT MAX(datetime(date)) FROM cash_movements
            UNION ALL SELECT MAX(datetime(actual_date)) FROM cash_movements
            UNION ALL SELECT MAX(datetime(created_at)) FROM cash_movements
            UNION ALL SELECT MAX(datetime(created_at)) FROM stock_adjustments
            UNION ALL SELECT MAX(datetime(start_time)) FROM shifts
            UNION ALL SELECT MAX(datetime(end_time)) FROM shifts
        )
    """).fetchone()[0]
    if not isinstance(latest, str) or not re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", latest):
        raise CutoverDenied("Historical economic activity chronology cannot be bounded")
    witness = {
        "source_sha256": finance.PIN,
        "original_v29_sha256": ORIGINAL_V29_SHA256,
        "tenant": TENANT,
        "financial": financial,
        "tender": cash,
        "latest_source_at_local": latest,
        "historical_payment_status": "unverified",
        "historical_source_immutable": True,
    }
    return _digest(witness), latest


def _validate_lines(statement: dict, evidence_by_id: dict) -> None:
    lines = statement["opening_lines"]
    if not isinstance(lines, list) or len(lines) != len(BUCKETS):
        raise CutoverDenied("All opening-balance classes must be explicitly reviewed")
    seen: set[str] = set()
    debit = credit = 0
    for line in lines:
        if not isinstance(line, dict) or set(line) != {"bucket", "debit_cents", "credit_cents", "evidence_ids"}:
            raise CutoverDenied("Malformed opening-balance class")
        bucket = line["bucket"]
        if not isinstance(bucket, str) or bucket not in BUCKETS or bucket in seen:
            raise CutoverDenied("Unknown or duplicate opening-balance class")
        seen.add(bucket)
        direction, supporting_kind = BUCKETS[bucket]
        d, c = _counted_cents(line["debit_cents"]), _counted_cents(line["credit_cents"])
        if (direction == "debit" and c) or (direction == "credit" and d):
            raise CutoverDenied("Opening-balance direction mismatched")
        refs = line["evidence_ids"]
        if not isinstance(refs, list) or len(refs) != 1 or type(refs[0]) is not str:
            raise CutoverDenied("Exactly one reviewed evidence reference per opening class required")
        if refs[0] not in evidence_by_id or evidence_by_id[refs[0]] != supporting_kind:
            raise CutoverDenied("Opening class has no matching independent evidence category")
        debit += d
        credit += c
    if seen != set(BUCKETS) or debit == 0 or debit != credit:
        raise CutoverDenied("Opening-balance proposal is incomplete or unbalanced")


def _validate_statement(statement: Any, *, witness_sha256: str,
                        latest_legacy_source_at_local: str,
                        roots: _TrustRoots, now_utc: int) -> None:
    if not isinstance(statement, dict) or set(statement) != STATEMENT_KEYS:
        raise CutoverDenied("Incomplete or extended cutover statement")
    if (statement["format"] != FORMAT or statement["purpose"] != PURPOSE
            or statement["tenant"] != TENANT
            or statement["original_v29_sha256"] != ORIGINAL_V29_SHA256
            or statement["native_sqlx69_sha256"] != finance.PIN
            or statement["historical_witness_sha256"] != witness_sha256
            or not isinstance(witness_sha256, str) or SHA.fullmatch(witness_sha256) is None
            or statement["legacy_policy"] != POLICY):
        raise CutoverDenied("Source, scope or immutable legacy epoch policy differs")
    if (statement["owner_operator_signer_id"] != roots.owner_operator.signer_id
            or statement["accountant_operator_signer_id"] != roots.accountant_operator.signer_id):
        raise CutoverDenied("Distinct operator witness identities do not match installed roots")
    if not isinstance(statement["source_timezone"], str) or not re.fullmatch(
            r"[A-Za-z_]+(?:/[A-Za-z0-9_+\-]+)+", statement["source_timezone"]):
        raise CutoverDenied("Named source timezone must be independently declared")
    try:
        historic_zone = ZoneInfo(statement["source_timezone"])
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CutoverDenied("Source timezone is not a recognized IANA location") from exc
    if statement["latest_legacy_source_at_local"] != latest_legacy_source_at_local:
        raise CutoverDenied("Historical source chronology differs")
    try:
        latest = datetime.strptime(latest_legacy_source_at_local, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError) as exc:
        raise CutoverDenied("Invalid historical source timestamp") from exc
    local = _local(statement["cutover_at_local"])
    utc = _utc(statement["cutover_at_utc"])
    # Round-trip through the owner's declared legal location to reject stale
    # offsets, DST gaps and inconsistent source-local epochs.
    zone_local = utc.astimezone(historic_zone)
    if (local.astimezone(timezone.utc) != utc
            or local.replace(tzinfo=None) != zone_local.replace(tzinfo=None)
            or local.utcoffset() != zone_local.utcoffset()
            or local.replace(tzinfo=None) <= latest):
        raise CutoverDenied("Cutover must occur strictly after last recorded historic event")
    if any(type(statement[field]) is not int for field in ("issued_at_utc", "expires_at_utc")):
        raise CutoverDenied("Invalid signed approval time")
    issued, expiry = statement["issued_at_utc"], statement["expires_at_utc"]
    if (type(now_utc) is not int or issued > now_utc + 120 or expiry <= now_utc
            or expiry <= issued or expiry - issued > MAX_APPROVAL_AGE_SECONDS
            or utc.timestamp() > issued + 120):
        raise CutoverDenied("Unissued, stale or premature opening-balance acceptance")
    try:
        request = uuid.UUID(statement["request_id"])
    except (TypeError, ValueError, AttributeError) as exc:
        raise CutoverDenied("Invalid unique cutover request") from exc
    if request.version != 4 or str(request) != statement["request_id"]:
        raise CutoverDenied("Only canonical UUID-v4 cutover requests are supported")
    evidence = statement["evidence"]
    if not isinstance(evidence, list) or not len(EVIDENCE_KINDS) <= len(evidence) <= 64:
        raise CutoverDenied("Required independent source documents absent")
    evidence_by_id: dict[str, str] = {}
    seen_digests: set[str] = set()
    for item in evidence:
        if not isinstance(item, dict) or set(item) != {"id", "kind", "sha256"}:
            raise CutoverDenied("Malformed independent document commitment")
        eid, kind, digest = item["id"], item["kind"], item["sha256"]
        if (not isinstance(eid, str) or IDENTIFIER.fullmatch(eid) is None
                or eid in evidence_by_id or not isinstance(kind, str)
                or kind not in EVIDENCE_KINDS or not isinstance(digest, str)
                or SHA.fullmatch(digest) is None or digest == "0" * 64
                or digest in seen_digests or digest in (finance.PIN, ORIGINAL_V29_SHA256)):
            raise CutoverDenied("Missing, duplicated or untrusted external evidence commitment")
        evidence_by_id[eid] = kind
        seen_digests.add(digest)
    if {kind for kind in evidence_by_id.values()} != EVIDENCE_KINDS:
        raise CutoverDenied("All independent financial evidence classes required")
    _validate_lines(statement, evidence_by_id)
    exceptions = statement["exceptions"]
    if not isinstance(exceptions, dict) or exceptions != EXCEPTIONS:
        raise CutoverDenied("Historical unsettled exceptions require explicit no-inference policy")
    human = statement["human_authorizations"]
    if not isinstance(human, dict) or set(human) != {"owner", "accountant"}:
        raise CutoverDenied("Separate owner and accountant human authorization records required")
    review_subject = _review_subject(statement)
    for role in ("owner", "accountant"):
        record = human[role]
        if not isinstance(record, dict) or set(record) != {
                "authorization_evidence_id", "authenticated_at_utc",
                "authentication_method", "review_subject_sha256"}:
            raise CutoverDenied("Independent human authorization record incomplete")
        ref = record["authorization_evidence_id"]
        if (not isinstance(ref, str) or evidence_by_id.get(ref) != role + "_authorization_record"
                or not isinstance(record["authentication_method"], str)
                or record["authentication_method"] not in AUTHENTICATION_METHODS
                or record["review_subject_sha256"] != review_subject):
            raise CutoverDenied("Human authorization must bind independently evidenced exact review subject")
        authenticated = _utc(record["authenticated_at_utc"]).timestamp()
        if not issued <= authenticated <= now_utc + 120 or authenticated > expiry:
            raise CutoverDenied("Human review authorization timestamp outside signed request window")
    if human["owner"]["authorization_evidence_id"] == human["accountant"]["authorization_evidence_id"]:
        raise CutoverDenied("Owner and accountant cannot share one authorization record")


def _signature(raw: Any) -> bytes:
    if not isinstance(raw, str) or not re.fullmatch(r"[A-Za-z0-9_-]{86}", raw):
        raise CutoverDenied("Invalid controlled operator witness signature")
    try:
        decoded = base64.urlsafe_b64decode(raw + "==")
    except (ValueError, base64.binascii.Error) as exc:
        raise CutoverDenied("Invalid controlled operator witness signature") from exc
    if len(decoded) != 64 or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != raw:
        raise CutoverDenied("Noncanonical controlled operator witness signature")
    return decoded


def verify_packet(packet: Any, *, witness_sha256: str,
                  latest_legacy_source_at_local: str, roots: _TrustRoots | None,
                  now_utc: int, expected_request_id: str) -> dict:
    """Only technical verification; cannot authorize post/import/upgrade.

    Caller must establish full pinned SQLx69 custody independently. Synthetic
    tests inject operator keys; the real CLI obtains only installed anchors.
    The presence of operator-signed claims or evidence digests NEVER proves
    that an owner or accountant was genuinely authenticated or agreed.
    """
    if (not isinstance(roots, _TrustRoots) or any(
            not isinstance(x, _Signer) or not isinstance(x.signer_id, str)
            or SIGNER.fullmatch(x.signer_id) is None or type(x.public_key) is not bytes
            or len(x.public_key) != 32 for x in (roots.owner_operator, roots.accountant_operator))
            or roots.owner_operator.signer_id == roots.accountant_operator.signer_id
            or roots.owner_operator.public_key == roots.accountant_operator.public_key):
        raise CutoverDenied("Independent pinned operator witness roots are missing")
    if not isinstance(packet, dict) or set(packet) != {"statement", "commitment_sha256", "operator_witnesses"}:
        raise CutoverDenied("Cutover witness envelope malformed")
    statement = packet["statement"]
    _validate_statement(statement, witness_sha256=witness_sha256,
                        latest_legacy_source_at_local=latest_legacy_source_at_local,
                        roots=roots, now_utc=now_utc)
    if not isinstance(expected_request_id, str) or statement["request_id"] != expected_request_id:
        raise CutoverDenied("Cutover request not independently challenged")
    commitment = _digest(statement)
    if packet["commitment_sha256"] != commitment:
        raise CutoverDenied("Immutable opening-balance statement digest mismatched")
    witnesses = packet["operator_witnesses"]
    if not isinstance(witnesses, dict) or set(witnesses) != {"owner", "accountant"}:
        raise CutoverDenied("Distinct operators must witness both real human review records")
    for role, signer in (("owner", roots.owner_operator),
                         ("accountant", roots.accountant_operator)):
        entry = witnesses[role]
        if not isinstance(entry, dict) or set(entry) != {
                "operator_signer_id", "witnessed_at_utc", "declaration", "signature_b64"}:
            raise CutoverDenied("Controlled operator witness record incomplete")
        if (entry["operator_signer_id"] != signer.signer_id
                or entry["declaration"] != "witnessed_prior_authenticated_human_review_with_external_evidence"):
            raise CutoverDenied("Operator witness has not claimed a prior human authorization")
        signed_at = _utc(entry["witnessed_at_utc"]).timestamp()
        authorized_at = _utc(statement["human_authorizations"][role]["authenticated_at_utc"]).timestamp()
        if not authorized_at <= signed_at <= now_utc + 120:
            raise CutoverDenied("Operator witness must follow recorded human authorization")
        if signed_at > statement["expires_at_utc"]:
            raise CutoverDenied("Operator witness arrived after review expiry")
        declaration = {k: entry[k] for k in ("operator_signer_id", "witnessed_at_utc", "declaration")}
        message = DOMAIN + role.encode("ascii") + b"\x00" + bytes.fromhex(commitment) + _canonical(declaration)
        try:
            Ed25519PublicKey.from_public_bytes(signer.public_key).verify(
                _signature(entry["signature_b64"]), message)
        except (ValueError, InvalidSignature) as exc:
            raise CutoverDenied("Controlled operator witness signature invalid") from exc
    return {
        "status": "TECHNICAL_OPERATOR_WITNESS_RECORDS_VERIFIED_HUMAN_AUTHORIZATION_PENDING",
        "immutable_opening_balance_commitment_sha256": commitment,
        "source_sha256": finance.PIN,
        "distinct_controlled_operator_witness_signatures_verified": True,
        "owner_and_accountant_authorization_evidence_digests_bound": True,
        "owner_and_accountant_human_authorization_independently_verified": False,
        "operator_assertion_alone_is_not_human_authorization": True,
        "historical_receipt_payment_status_inferred": False,
        "source_rows_or_native_receipts_modified": False,
        "opening_balance_posting_implemented": False,
        "production_allowed": False,
    }


def _installed_roots() -> _TrustRoots:
    values = (_AUTHORIZED_OWNER_OPERATOR_PUBLIC_KEY_HEX, _AUTHORIZED_ACCOUNTANT_OPERATOR_PUBLIC_KEY_HEX,
              _AUTHORIZED_OWNER_OPERATOR_SIGNER_ID, _AUTHORIZED_ACCOUNTANT_OPERATOR_SIGNER_ID)
    if any(not isinstance(value, str) or not value for value in values):
        raise CutoverDenied("Independent controlled operator witness roots unprovisioned")
    try:
        return _TrustRoots(_Signer(values[2], bytes.fromhex(values[0])),
                           _Signer(values[3], bytes.fromhex(values[1])))
    except ValueError as exc:
        raise CutoverDenied("Malformed independently installed trust anchor") from exc


def _unique_json(pairs: list[tuple[str, Any]]) -> dict:
    data: dict = {}
    for key, value in pairs:
        if key in data:
            raise CutoverDenied("Ambiguous duplicate key in signed financial evidence")
        data[key] = value
    return data


def _nonfinite(_: str) -> None:
    raise CutoverDenied("Nonfinite numeric evidence denied")


def _read_packet(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_PACKET_BYTES:
        raise CutoverDenied("Detached acceptance packet missing or oversized")
    raw = path.read_bytes()
    if len(raw) > MAX_PACKET_BYTES:
        raise CutoverDenied("Detached acceptance packet oversized")
    return json.loads(raw, object_pairs_hook=_unique_json, parse_constant=_nonfinite)


class _SafeParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, "DENIED: invalid legacy financial witness arguments\n")


def main(argv: list[str] | None = None) -> int:
    parser = _SafeParser(description="Read-only historical opening balance review; no posting")
    parser.add_argument("--packet", required=True, help="Detached operator-witnessed review packet")
    parser.add_argument("--expected-request-id", required=True, help="Independently issued UUID-v4 request")
    args = parser.parse_args(argv)
    try:
        roots = _installed_roots()  # Never touch original/QA data before both roots exist.
        path = custody.disposable_root() / finance.STAGE / finance.NAME
        raw = custody.checked_file(path, finance.PIN)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            witness, latest = historical_witness(db)
        if sha256(path.read_bytes()).hexdigest() != finance.PIN:
            raise CutoverDenied("Pinned SQLx69 source changed during cutover verification")
        packet = _read_packet(Path(args.packet))
        result = verify_packet(packet, witness_sha256=witness,
                               latest_legacy_source_at_local=latest, roots=roots,
                               now_utc=int(time.time()),
                               expected_request_id=args.expected_request_id)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (CutoverDenied, ValueError, KeyError, OSError, sqlite3.Error, custody.Refused):
        print(json.dumps({"status": "REFUSED_UNACCEPTED_LEGACY_FINANCIAL_CUTOVER",
                          "database_mutations": 0, "production_allowed": False}),
              file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
