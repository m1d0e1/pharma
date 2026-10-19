#!/usr/bin/env python3
"""Detached legacy SQLite custody signature check, never migration authority.

No production owner/reviewer public trust roots are installed. The CLI refuses
before reading input until BOTH roots are independently and securely pinned.
No CLI, JSON, environment, fixture key, or renderer value can install a root.
Synthetic-only internal cryptographic verification NEVER authorizes a migration.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import sys
import time
import uuid
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from scripts.qa_historical_archive_preflight import approved_archive, digest_file

FORMAT = "pharma-legacy-ownership-custody-v1"
PURPOSE = "independent-source-custody-review-not-migration-authorization"
DOMAIN = b"PHARMA:LEGACY:OWNER-REVIEWER:CUSTODY:V1\x00"
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_TABLES = 512
MAX_ROWS = 3_000_000
MAX_APPROVAL_BYTES = 16 * 1024
MAX_APPROVAL_AGE_SECONDS = 30 * 24 * 3600
SHA_HEX = re.compile(r"[0-9a-f]{64}\Z")
TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
IDENTITY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")

# Deliberately empty. A reviewed future deployment must independently pin two
# separately authorized public keys. No runtime input is a source of trust.
_AUTHORIZED_OWNER_PUBLIC_KEY_HEX: str | None = None
_AUTHORIZED_REVIEWER_PUBLIC_KEY_HEX: str | None = None
_AUTHORIZED_OWNER_SIGNER_ID: str | None = None
_AUTHORIZED_REVIEWER_SIGNER_ID: str | None = None


class CustodyDenied(ValueError):
    """Fail closed without ever exposing source records or supplied secrets."""


@dataclass(frozen=True)
class SourceCommitment:
    source_sha256: str
    all_rows_typed_sha256: str
    schema_sha256: str
    full_row_count: int
    table_count: int
    source_size_bytes: int


@dataclass(frozen=True)
class _PinnedSigner:
    signer_id: str
    public_key: bytes


@dataclass(frozen=True)
class _TrustRoots:
    owner: _PinnedSigner
    reviewer: _PinnedSigner


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"),
            ensure_ascii=False, allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise CustodyDenied("Invalid canonical custody evidence") from exc


def _frame(hasher: Any, value: bytes) -> None:
    hasher.update(len(value).to_bytes(8, "big"))
    hasher.update(value)


def _typed(value: Any) -> list[str]:
    if value is None:
        return ["null", ""]
    if type(value) is int:
        return ["integer", str(value)]
    if type(value) is float:
        return ["real", struct.pack(">d", value).hex()]
    if type(value) is str:
        return ["text", value]
    if type(value) is bytes:
        return ["blob", base64.b64encode(value).decode("ascii")]
    raise CustodyDenied("Unsupported SQLite typed value")


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


_FTS_VIRTUAL = "master_drugs_fts"
_FTS_SHADOWS = frozenset({
    "master_drugs_fts_data", "master_drugs_fts_idx",
    "master_drugs_fts_docsize", "master_drugs_fts_config",
})
# The only virtual table allowed is the legacy migration's *external-content*
# FTS5 table; an ordinary FTS5 table, another tokenizer or other content source
# requires new independent review. sqlite_master normally strips IF NOT EXISTS.
_FTS_DDL = re.compile(
    r"""CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?
        (?:master_drugs_fts|"master_drugs_fts"|'master_drugs_fts')
        \s+USING\s+fts5\s*\(
        \s*id\s+UNINDEXED\s*,\s*trade_name\s*,\s*trade_name_en\s*,
        \s*generic_name\s*,\s*active_ingredient\s*,
        (?:\s*manufacturer\s*,\s*category\s*,)?
        \s*content\s*=\s*'master_drugs'\s*,
        \s*content_rowid\s*=\s*'id'\s*\)\s*""",
    re.IGNORECASE | re.VERBOSE,
)
_FTS_VISIBLE_001 = (
    "id", "trade_name", "trade_name_en", "generic_name", "active_ingredient"
)
_FTS_VISIBLE_009 = _FTS_VISIBLE_001 + ("manufacturer", "category")
_FTS_HIDDEN = ("master_drugs_fts", "rank")
_FTS_SHADOW_LAYOUTS = {
    "master_drugs_fts_config": (
        (("k", "", 1, 1), ("v", "", 0, 0)), True,
        r"CREATE\s+TABLE\s+'master_drugs_fts_config'\s*"
        r"\(\s*k\s+PRIMARY\s+KEY\s*,\s*v\s*\)\s+WITHOUT\s+ROWID",
    ),
    "master_drugs_fts_data": (
        (("id", "INTEGER", 0, 1), ("block", "BLOB", 0, 0)), False,
        r"CREATE\s+TABLE\s+'master_drugs_fts_data'\s*"
        r"\(\s*id\s+INTEGER\s+PRIMARY\s+KEY\s*,\s*block\s+BLOB\s*\)",
    ),
    "master_drugs_fts_docsize": (
        (("id", "INTEGER", 0, 1), ("sz", "BLOB", 0, 0)), False,
        r"CREATE\s+TABLE\s+'master_drugs_fts_docsize'\s*"
        r"\(\s*id\s+INTEGER\s+PRIMARY\s+KEY\s*,\s*sz\s+BLOB\s*\)",
    ),
    "master_drugs_fts_idx": (
        (("segid", "", 1, 1), ("term", "", 1, 2), ("pgno", "", 0, 0)),
        True,
        r"CREATE\s+TABLE\s+'master_drugs_fts_idx'\s*"
        r"\(\s*segid\s*,\s*term\s*,\s*pgno\s*,\s*PRIMARY\s+KEY"
        r"\s*\(\s*segid\s*,\s*term\s*\)\s*\)\s+WITHOUT\s+ROWID",
    ),
}


def _validate_fts_schema(schema: list[tuple], db: sqlite3.Connection) -> None:
    """Allow only the exact FTS5 external-content module and generated shadows.

    Every original sqlite_master DDL and every table_xinfo row is included in
    the schema digest later. Neither FTS shadow rows nor the virtual content
    projection may be silently omitted from the full typed-row digest.
    """
    tables = {name: ddl for kind, name, _, ddl in schema if kind == "table"}
    virtuals = {
        name for name, ddl in tables.items()
        if ddl is not None and re.match(
            r"\s*CREATE\s+VIRTUAL\s+TABLE\b", ddl, re.IGNORECASE
        )
    }
    if virtuals - {_FTS_VIRTUAL}:
        raise CustodyDenied("Unrecognized virtual SQLite table")
    has_fts = _FTS_VIRTUAL in virtuals
    special = {name for name in tables if name == _FTS_VIRTUAL or
               name.startswith(_FTS_VIRTUAL + "_")}
    if has_fts:
        if special != {_FTS_VIRTUAL, *_FTS_SHADOWS}:
            raise CustodyDenied("Known FTS5 source/shadow table coverage is incomplete")
        if _FTS_DDL.fullmatch(tables[_FTS_VIRTUAL] or "") is None:
            raise CustodyDenied("FTS5 external-content schema is not the known layout")
        virtual_info = db.execute(
            f"PRAGMA table_xinfo({_quote(_FTS_VIRTUAL)})"
        ).fetchall()
        if (
            tuple(row[1] for row in virtual_info) not in (
                _FTS_VISIBLE_001 + _FTS_HIDDEN,
                _FTS_VISIBLE_009 + _FTS_HIDDEN,
            )
            or tuple(row[6] for row in virtual_info) !=
                (0,) * (len(virtual_info) - 2) + (1, 1)
        ):
            raise CustodyDenied("FTS5 hidden/visible schema differs")
        for name in sorted(_FTS_SHADOWS):
            expected, _, ddl = _FTS_SHADOW_LAYOUTS[name]
            if re.fullmatch(ddl, tables[name] or "", re.IGNORECASE) is None:
                raise CustodyDenied("FTS5 shadow schema differs")
            xinfo = db.execute(f"PRAGMA table_xinfo({_quote(name)})").fetchall()
            if (
                tuple((r[1], r[2].upper(), r[3], r[5]) for r in xinfo) != expected
                or any(r[6] != 0 for r in xinfo)
            ):
                raise CustodyDenied("FTS5 shadow column schema differs")
    elif special:
        raise CustodyDenied("FTS5-like table has no approved virtual source")


def snapshot_sqlite_bytes(source: bytes) -> SourceCommitment:
    """Digest EVERY row of EVERY SQLite table, and the entire SQLite schema.

    Input must be finalized single-file SQLite snapshot bytes, not a live
    WAL-mode source. Deserialize into RAM; never open or modify the source DB.
    Only the exact known external-content FTS5 and its four shadow tables are
    supported. FTS control/rank hidden columns are ephemeral computed values,
    so their schema (not transient query values) is committed; the persistent
    visible rows, rowids and EVERY shadow typed row are all committed.
    """
    if (type(source) is not bytes or not 100 <= len(source) <= MAX_SOURCE_BYTES
            or not source.startswith(b"SQLite format 3\x00")
            or source[18:20] != b"\x01\x01"):
        # WAL-mode file bytes alone omit committed sidecar transactions.
        # Never claim a live WAL base file is the entire original history.
        raise CustodyDenied("Invalid detached SQLite source")
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(source)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise CustodyDenied("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise CustodyDenied("SQLite foreign-key check failed")
        schema = db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "ORDER BY type,name,tbl_name,sql"
        ).fetchall()
        names = sorted(row[1] for row in schema if row[0] == "table")
        if not names or len(names) > MAX_TABLES or len(set(names)) != len(names):
            raise CustodyDenied("Unsupported table coverage")
        _validate_fts_schema(schema, db)
        schema_columns: list[Any] = []
        digest = sha256(DOMAIN + b"ALL-TYPED-ROWS\x00")
        full_count = 0
        for name in names:
            quoted = _quote(name)
            columns = db.execute(f"PRAGMA table_xinfo({quoted})").fetchall()
            known_fts = name == _FTS_VIRTUAL
            if not columns or (not known_fts and any(column[6] != 0 for column in columns)):
                raise CustodyDenied("Hidden/virtual SQLite columns need independent review")
            definition = next(
                (row[3] for row in schema if row[0] == "table" and row[1] == name), None
            )
            if (definition and
                    re.match(r"\s*CREATE\s+VIRTUAL\s+TABLE\b", definition, re.I)
                    and not known_fts):
                raise CustodyDenied("Virtual tables need independent custody coverage")
            column_names = [str(column[1]) for column in columns]
            # Implicit rowids can be used as source identities: include them.
            # If all aliases are shadowed by actual columns, deny ambiguity.
            rowid_sql = ""
            if definition and "WITHOUT ROWID" not in definition.upper():
                used = {col.casefold() for col in column_names}
                alias = next((a for a in ("rowid", "_rowid_", "oid")
                              if a not in used), None)
                if alias is None:
                    raise CustodyDenied("Unverifiable implicit source row identity")
                rowid_sql = f", {alias}"
            schema_columns.append([name, columns])
            row_hashes = []
            # For FTS the hidden control column is an ephemeral per-query
            # pointer/counter, NOT a stored row: reading it would make identical
            # source bytes hash differently on consecutive SELECTs. Commit its
            # presence/type in table_xinfo and hash all five (001) or seven
            # (009) persistent
            # external-content columns, plus stable rowid. Shadow table rows
            # contain the full original index bytes and are hashed separately.
            projection = (
                ", ".join(_quote(col) for col in
                          [c[1] for c in columns if c[6] == 0])
                if known_fts else "*"
            )
            cursor = db.execute(f"SELECT {projection}{rowid_sql} FROM {quoted}")
            while rows := cursor.fetchmany(1024):
                for row in rows:
                    full_count += 1
                    if full_count > MAX_ROWS:
                        raise CustodyDenied("Complete source row budget exceeded")
                    row_hashes.append(sha256(_canonical([_typed(v) for v in row])).digest())
            _frame(digest, _canonical([name, column_names, len(row_hashes)]))
            for row_hash in sorted(row_hashes):
                _frame(digest, row_hash)
        return SourceCommitment(
            source_sha256=sha256(source).hexdigest(),
            all_rows_typed_sha256=digest.hexdigest(),
            schema_sha256=sha256(_canonical({
                "sqlite_master": schema, "table_xinfo": schema_columns,
            })).hexdigest(),
            full_row_count=full_count,
            table_count=len(names),
            source_size_bytes=len(source),
        )
    except sqlite3.DatabaseError as exc:
        raise CustodyDenied("Cannot verify SQLite snapshot") from exc
    finally:
        db.close()


_STATEMENT_KEYS = frozenset({
    "format", "custody_purpose", "source_sha256", "all_rows_typed_sha256",
    "schema_sha256", "target_tenant", "full_row_count", "table_count",
    "source_size_bytes", "request_id", "owner_signer_id",
    "reviewer_signer_id", "issued_at_utc", "expires_at_utc",
})


def _signature_bytes(value: Any) -> bytes:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{86}", value) is None:
        raise CustodyDenied("Invalid detached signature encoding")
    try:
        signature = base64.urlsafe_b64decode(value + "==")
    except (ValueError, base64.binascii.Error) as exc:
        raise CustodyDenied("Invalid detached signature") from exc
    if (len(signature) != 64 or
            base64.urlsafe_b64encode(signature).rstrip(b"=").decode() != value):
        raise CustodyDenied("Noncanonical detached signature")
    return signature


def _crypto_evidence_only(
    bundle: Any,
    source: SourceCommitment,
    roots: _TrustRoots | None,
    *,
    expected_tenant: str,
    expected_request_id: str,
    now_utc: int,
    consumed_request_ids: set[str],
) -> str:
    """Technical Ed25519 check ONLY: no tenant, mapping or migration authority.

    Tests supply independently generated RAM public roots. In-memory replay
    detection is not a substitute for a durable, protected operational ledger.
    """
    if roots is None or not isinstance(roots, _TrustRoots):
        raise CustodyDenied("Independently pinned trust roots are missing")
    signers = (roots.owner, roots.reviewer)
    if (any(not isinstance(s, _PinnedSigner) or
            not isinstance(s.signer_id, str) or
            IDENTITY.fullmatch(s.signer_id) is None or
            type(s.public_key) is not bytes or len(s.public_key) != 32
            for s in signers) or
            roots.owner.signer_id == roots.reviewer.signer_id or
            roots.owner.public_key == roots.reviewer.public_key):
        raise CustodyDenied("Distinct independently pinned owner/reviewer roots required")
    if not isinstance(bundle, dict) or set(bundle) != {"statement", "signatures"}:
        raise CustodyDenied("Invalid custody envelope")
    statement, signatures = bundle["statement"], bundle["signatures"]
    if not isinstance(statement, dict) or set(statement) != _STATEMENT_KEYS:
        raise CustodyDenied("Incomplete or extended custody statement")
    if not isinstance(signatures, dict) or set(signatures) != {"owner", "reviewer"}:
        raise CustodyDenied("Exactly two independent signatures required")
    for key in ("source_sha256", "all_rows_typed_sha256", "schema_sha256"):
        value = statement[key]
        if (not isinstance(value, str) or SHA_HEX.fullmatch(value) is None
                or value == "0" * 64):
            raise CustodyDenied("Invalid custody digest")
    tenant = statement["target_tenant"]
    if (not isinstance(tenant, str) or TENANT.fullmatch(tenant) is None or
            tenant.lower() == "local_default" or tenant != expected_tenant):
        raise CustodyDenied("Expected named tenant does not match")
    try:
        parsed_id = uuid.UUID(statement["request_id"])
    except (TypeError, ValueError, AttributeError) as exc:
        raise CustodyDenied("Invalid custody request identity") from exc
    if (parsed_id.version != 4 or str(parsed_id) != statement["request_id"] or
            statement["request_id"] != expected_request_id or
            statement["request_id"] in consumed_request_ids):
        raise CustodyDenied("Unexpected or replayed custody request")
    if (statement["format"] != FORMAT or statement["custody_purpose"] != PURPOSE or
            statement["owner_signer_id"] != roots.owner.signer_id or
            statement["reviewer_signer_id"] != roots.reviewer.signer_id):
        raise CustodyDenied("Purpose or independent signer does not match")
    for key in ("full_row_count", "table_count", "source_size_bytes",
                "issued_at_utc", "expires_at_utc"):
        if type(statement[key]) is not int:
            raise CustodyDenied("Invalid custody integer type")
    if (type(now_utc) is not int or statement["issued_at_utc"] > now_utc + 120 or
            statement["expires_at_utc"] <= now_utc or
            statement["expires_at_utc"] <= statement["issued_at_utc"] or
            statement["expires_at_utc"] - statement["issued_at_utc"] >
            MAX_APPROVAL_AGE_SECONDS):
        raise CustodyDenied("Custody evidence validity period is rejected")
    for key in ("source_sha256", "all_rows_typed_sha256", "schema_sha256",
                "full_row_count", "table_count", "source_size_bytes"):
        if statement[key] != getattr(source, key):
            raise CustodyDenied("Full historical source commitment differs")
    signed = _canonical(statement)
    for role, signer in (("owner", roots.owner), ("reviewer", roots.reviewer)):
        approval = signatures[role]
        if (not isinstance(approval, dict) or
                set(approval) != {"signer_id", "signature_b64"} or
                approval["signer_id"] != signer.signer_id):
            raise CustodyDenied("Independent signer identity mismatch")
        try:
            Ed25519PublicKey.from_public_bytes(signer.public_key).verify(
                _signature_bytes(approval["signature_b64"]),
                DOMAIN + role.encode("ascii") + b"\x00" + signed,
            )
        except (InvalidSignature, ValueError) as exc:
            raise CustodyDenied("Ed25519 independent custody signature denied") from exc
    consumed_request_ids.add(statement["request_id"])
    return "CRYPTOGRAPHIC_CUSTODY_MATCH_ONLY_NOT_OPERATIONAL_AUTHORIZATION"


def _installed_operational_roots() -> _TrustRoots:
    """No CLI argument, fixture, file or environment variable supplies trust."""
    values = (_AUTHORIZED_OWNER_PUBLIC_KEY_HEX, _AUTHORIZED_REVIEWER_PUBLIC_KEY_HEX,
              _AUTHORIZED_OWNER_SIGNER_ID, _AUTHORIZED_REVIEWER_SIGNER_ID)
    if any(not isinstance(v, str) or not v for v in values):
        raise CustodyDenied("Independent authorized trust anchors are not installed")
    try:
        return _TrustRoots(
            _PinnedSigner(values[2], bytes.fromhex(values[0])),
            _PinnedSigner(values[3], bytes.fromhex(values[1])),
        )
    except ValueError as exc:
        raise CustodyDenied("Independently pinned trust anchors are invalid") from exc


def _read_detached_file(path: Path, limit: int) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise CustodyDenied("Detached custody file is unavailable")
    with path.open("rb") as handle:
        contents = handle.read(limit + 1)
    if len(contents) > limit:
        raise CustodyDenied("Detached custody input exceeds limit")
    return contents


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, value in pairs:
        if name in result:
            raise CustodyDenied("Ambiguous duplicate custody JSON key")
        result[name] = value
    return result


def _reject_nonfinite_json_constant(value: str) -> None:
    raise CustodyDenied("Nonfinite custody JSON is not accepted")


class _SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse normally echoes unknown input, potentially including a
        # mistakenly supplied private key or activation credential.
        self.print_usage(sys.stderr)
        self.exit(2, "DENIED: invalid custody command\n")


def main(argv: list[str] | None = None) -> int:
    parser = _SafeArgumentParser(
        description="Read-only two-party cryptographic custody check; never migration authority"
    )
    parser.add_argument("--source", required=True, help="finalized detached SQLite archive")
    parser.add_argument("--approvals", required=True, help="detached owner/reviewer signed JSON")
    parser.add_argument("--expected-sha256", required=True,
                        help="independently pinned 64-hex source digest")
    parser.add_argument("--expected-tenant", required=True, help="independently known named tenant")
    parser.add_argument("--expected-request-id", required=True, help="independent UUID-v4 challenge")
    args = parser.parse_args(argv)
    try:
        # Fail BEFORE inspecting any path while separately installed roots are
        # absent. No bundled QA keys can ever authorize this CLI.
        roots = _installed_operational_roots()
        pin = args.expected_sha256.lower()
        if SHA_HEX.fullmatch(pin) is None or pin == "0" * 64:
            raise CustodyDenied("Independent source pin is missing or invalid")
        # The archive custodian's boundary checks the resolved approved root,
        # randomized detached folder, forbidden symlinks and live sidecars.
        # A matching filename alone is never evidence of detached custody.
        source_path = approved_archive(
            Path(args.source), Path(os.environ["LOCALAPPDATA"])
        )
        if digest_file(source_path).lower() != pin:
            raise CustodyDenied("Detached source does not match independent pin")
        source = snapshot_sqlite_bytes(_read_detached_file(source_path, MAX_SOURCE_BYTES))
        if source.source_sha256 != pin:
            raise CustodyDenied("Read detached bytes differ from independently pinned source")
        envelope = json.loads(
            _read_detached_file(Path(args.approvals), MAX_APPROVAL_BYTES),
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_nonfinite_json_constant,
        )
        _crypto_evidence_only(
            envelope, source, roots,
            expected_tenant=args.expected_tenant,
            expected_request_id=args.expected_request_id,
            now_utc=int(time.time()), consumed_request_ids=set(),
        )
        if digest_file(source_path).lower() != pin:
            raise CustodyDenied("Detached source changed during custody verification")
        # No mapping/manifest/receipt written. Durable replay authorization
        # requires separately reviewed native integration and operator approval.
        print("CRYPTOGRAPHIC MATCH ONLY; NO MIGRATION OR TENANT AUTHORIZATION")
        return 0
    except (CustodyDenied, OSError, ValueError, sqlite3.Error, KeyError):
        print("DENIED: independent custody authorization unavailable or verification failed",
              file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
