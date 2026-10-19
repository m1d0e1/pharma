"""Read-only check of the remaining original-owner login boundary."""
import json
import sqlite3
from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_v02110_primary_pharmacy_migration as guard


def check(db):
    db.execute("PRAGMA query_only=ON")
    active = db.execute("SELECT COUNT(*) FROM users WHERE role='owner' AND COALESCE(is_active,1)=1").fetchone()[0]
    pending = db.execute("SELECT COUNT(*) FROM users WHERE id='admin' AND role='owner' AND pharmacy_id='primary_pharmacy' AND password_hash IS NULL").fetchone()[0]
    disputed = db.execute("SELECT COUNT(*) FROM native_owner_scope_review WHERE owner_id='admin'").fetchone()[0]
    attestations = db.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone()[0]
    if (active, pending, disputed, attestations) != (1, 1, 0, 0):
        raise ValueError("Historical owner custody changed; no enrollment permitted")
    return {"status": "ORIGINAL_OWNER_QA_LOGIN_PENDING_LICENSE_ACTIVATION",
            "canonical_original_owner_present": True,
            "password_still_quarantined": True,
            "native_review_disputes": 0,
            "existing_native_enrollment_requires_activation_proof": True,
            "native_activation_or_login_performed": False,
            "production_authorized": False}


def main():
    try:
        data = guard.checked_file(guard.disposable_root() / finance.STAGE / finance.NAME,
                                  finance.PIN)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(data)
            print(json.dumps(check(db), sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, guard.Refused, OSError):
        print(json.dumps({"status": "REFUSED_OWNER_QA_READINESS"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
