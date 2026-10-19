"""Fail-closed ORIGINAL owner evidence audit for pinned native SQLx68→69.

Reads four independently SHA-pinned detached snapshots as OS bytes into private
RAM (sealed v29, current-installed-derived v67, normalized native68, native69).
Does not recover owner credentials, authenticate a signer, change a database,
enroll an owner, mint an attestation, or grant historical tenant authority.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import sqlite3
import sys

from scripts import qa_v02110_primary_pharmacy_migration as qa
from scripts import qa_v02110_native_primary_scope_068 as native
from scripts import qa_v02110_native_sqlx68_primary_scope_stage as stage
from scripts import qa_v02110_native_sqlx69_primary_scope_postflight as v69

V68_SUBDIR = "pharma-v02110-current-native-sqlx68-primary-scope-844cda322c1843b7809c9d9f20c259df"
V68_FILE = "NATIVE-SQLX68-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
V68_PIN = "816f49d70f0da6edb04cac8bdc5ee1af7b9ed307fd4ae0459b7e1ef7061481bb"
V69_SUBDIR = "pharma-v02110-native-sqlx69-primary-scope-43d756ccfe4d43a0a6b0c07ee742b53a"
V69_FILE = "NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
V69_PIN = "bf0a85e37bce355a75cd741186f206887e4e9912df0d7a511ee299a0fde15e08"
OWNER_ID = "admin"
WITNESS_TABLES = (
    "native_primary_scope_audit_batches",
    "native_primary_scope_audit_originals",
    "native_primary_scope_audit_tables",
    "native_primary_scope_audit_relations",
    "native_primary_scope_audit_seals",
    "native_primary_scope_owner_attestations",
)


def source_paths():
    v67, _unused, v29 = stage.sources()
    root = qa.disposable_root()
    return (v29, v67, root / V68_SUBDIR / V68_FILE, root / V69_SUBDIR / V69_FILE)


def verify_ledger(db: sqlite3.Connection, version: int):
    rows = db.execute(
        "SELECT version,description,success,checksum FROM _sqlx_migrations ORDER BY version"
    ).fetchall()
    if [r[0] for r in rows] != list(range(1, version+1)) or any(r[2] != 1 for r in rows):
        raise qa.Refused("Native pinned source SQLx ledger is incomplete")
    if version >= 68 and rows[67][1:] != (
        "primary_pharmacy_typed_scope_audit", 1,
        hashlib.sha384(native.MIGRATION.read_bytes()).digest()
    ):
        raise qa.Refused("Original native068 custody checksum changed")
    if version >= 69 and rows[68][1:] != (
        "supplier_return_aware_payment_guard", 1,
        hashlib.sha384(v69.MIGRATION.read_bytes()).digest()
    ):
        raise qa.Refused("Native069 frozen trigger migration checksum changed")


def owner_row(db: sqlite3.Connection):
    rows = db.execute(
        "SELECT CAST(id AS TEXT),role,COALESCE(is_active,1),"
        "typeof(pharmacy_id),pharmacy_id,typeof(password_hash),password_hash "
        "FROM users WHERE lower(trim(COALESCE(role,'')))='owner'"
    ).fetchall()
    if len(rows) != 1 or rows[0][:3] != (OWNER_ID, "owner", 1):
        raise qa.Refused("Original owner identity or active role changed")
    return rows[0]


def verify_owner_sources(v29: sqlite3.Connection, v67: sqlite3.Connection,
                         v68: sqlite3.Connection, v69db: sqlite3.Connection):
    qa.sealed_version(v29)
    qa.native_version(v67)
    verify_ledger(v68,68)
    verify_ledger(v69db,69)
    for db in (v29,v67,v68,v69db):
        qa.healthy(db)
    original, intermediate, normalized, final = (
        owner_row(db) for db in (v29,v67,v68,v69db))
    # An original password hash is a custody fact, never a reusable login.
    if (original[3] != "null" or original[4] is not None
        or original[5] != "text" or not isinstance(original[6],str)
        or len(original[6]) != 60):
        raise qa.Refused("Sealed v29 original owner credential evidence is missing")
    if intermediate[3:] != ("text","local_default","null",None):
        raise qa.Refused("Current v67 owner no longer reflects 032/052 credential quarantine")
    if any(row[3:] != ("text",qa.TENANT,"null",None) for row in (normalized,final)):
        raise qa.Refused("Original owner credential was restored or tenant was not canonical")
    for db in (v67,v68,v69db):
        if db.execute("SELECT COUNT(*) FROM native_owner_scope_review").fetchone() != (0,):
            raise qa.Refused("Original owner quarantine changed")
    for db in (v68,v69db):
        if db.execute(
            "SELECT COUNT(*) FROM native_primary_scope_owner_attestations"
        ).fetchone() != (0,):
            raise qa.Refused("Unsigned current history cannot create an owner attestation")
    # Assert *all* typed 068 audit rows are preserved byte-exact by native069.
    for table in WITNESS_TABLES:
        a = list(qa.row_stream(v68,table))
        b = list(qa.row_stream(v69db,table))
        if len(a) != len(b) or any(
            len(x) != len(y) or any(not qa.same(p,q) for p,q in zip(x,y))
            for x,y in zip(a,b)
        ):
            raise qa.Refused("Native069 altered immutable original scope/graph evidence")
    originals = v68.execute(
        "SELECT source_table,source_rowid,original_storage,original_literal,"
        "original_row_typed_sha256 FROM native_primary_scope_audit_originals"
    ).fetchall()
    if len(originals) != 7567:
        raise qa.Refused("Original typed 068 scope archive is incomplete")
    by_table = {}
    for table,rowid,kind,literal,sha in originals:
        by_table.setdefault(table,{})[rowid] = (kind,literal,sha)
    matched = 0
    scoped = set(qa.scope_tables(v67))
    if not set(by_table).issubset(scoped):
        raise qa.Refused("Original scope archive contains an unrecognized table")
    for table,ledger in by_table.items():
        index = qa.columns(v67,table).index("pharmacy_id")+1
        for row in qa.row_stream(v67,table):
            entry = ledger.get(row[0])
            if entry is None:
                continue
            kind,literal,whole_row_sha = entry
            if (qa.typed(row[index])[0] != kind
                or not qa.same(row[index],literal)
                or native.typed_row_digest(row) != whole_row_sha):
                raise qa.Refused("Original typed source-bound scope witness differs")
            if kind != "null" and not (
                kind == "text" and (literal == "local_default" or not literal.strip())
            ):
                raise qa.Refused("An explicit foreign original tenant cannot be adopted")
            matched += 1
    if matched != len(originals):
        raise qa.Refused("Source-bound original rowid missing from original v67")
    batch = v68.execute(
        "SELECT pharmacy_id,original_v67_sha256,sealed_v29_sha256,"
        "original_physical_table_count,original_physical_row_count,"
        "expected_original_scope_count,expected_relation_witness_count "
        "FROM native_primary_scope_audit_batches"
    ).fetchall()
    if batch != [(qa.TENANT,stage.CURRENT_V67_SHA,qa.SEALED_PIN,99,289816,7567,147)]:
        raise qa.Refused("068 source-bound audit is not pinned to original v29/v67")
    return {
        "status":"PASS_SOURCE_BOUND_ORIGINAL_OWNER_EVIDENCE_NO_AUTHORIZATION",
        "sealed_v29_sha256":qa.SEALED_PIN,
        "current_installed_derived_v67_sha256":stage.CURRENT_V67_SHA,
        "native_normalized_sqlx68_sha256":V68_PIN,
        "native_combined_sqlx69_sha256":V69_PIN,
        "original_owner_credential_kept_only_as_sealed_v29_audit_fact":True,
        "original_owner_inferred_052_scope_is_not_owner_authentication":True,
        "original_owner_credential_restored_in_v68_or_v69":False,
        "original_typed_scope_rowid_literal_and_full_row_sha_verified":matched,
        "original_fixed_and_declared_relationship_witnesses":147,
        "native_068_owner_attestations":0,
        "native_069_owner_attestations":0,
        "original_owner_login_or_signed_approval_authentication_completed":False,
        "tenant_permission_or_finance_grant_created":False,
        "installed_customer_profile_mutations":0,
    }


def verify():
    paths = source_paths()
    pins = (qa.SEALED_PIN,stage.CURRENT_V67_SHA,V68_PIN,V69_PIN)
    raws = [qa.checked_file(path,pin,sealed=i==0)
            for i,(path,pin) in enumerate(zip(paths,pins))]
    with closing(qa.memory_source(raws[0])) as v29, \
         closing(qa.memory_source(raws[1])) as v67, \
         closing(qa.memory_source(raws[2])) as v68, \
         closing(qa.memory_source(raws[3])) as n69:
        result = verify_owner_sources(v29,v67,v68,n69)
    if any(qa.digest(path)!=pin for path,pin in zip(paths,pins)):
        raise qa.Refused("Pinned original source changed during owner-only audit")
    return result


def main() -> int:
    try:
        print(json.dumps(verify(),sort_keys=True))
        return 0
    except (qa.Refused,OSError,sqlite3.Error,ValueError,TypeError) as exc:
        print(json.dumps({"status":"REFUSED_ORIGINAL_OWNER_SOURCE_BOUND_AUDIT",
                          "reason":str(exc)},sort_keys=True),file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
