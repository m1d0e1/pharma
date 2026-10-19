"""Read-only isolated tenant GUI scan with historical identifiers kept private."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess


def main() -> None:
    profile = Path(os.environ['APPDATA']) / 'com.pharma.disposable.lifecycle.qa20261016' / 'pharma_local.db'
    with sqlite3.connect(profile.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        old_sales = [row[0] for row in db.execute("SELECT id FROM sales_invoices WHERE pharmacy_id='local_default'")]
        # A successful owned-patient lifecycle now exists in this disposable QA
        # profile. Its name is an expected positive result, not a legacy leak.
        # Only patients without this tenant's immutable ownership witness may
        # be used as negative identifiers in the GUI tenant-isolation sweep.
        old_patients = [row[0] for row in db.execute('''
            SELECT p.full_name FROM patients p
            WHERE NOT EXISTS (
                SELECT 1 FROM native_patient_directory_ownership w
                WHERE w.patient_id=p.id AND w.pharmacy_id=?
            )
        ''', ('qa_lifecycle_20261016',))]
        old_barcodes = [row[0] for row in db.execute("SELECT barcode FROM inventory WHERE pharmacy_id='local_default' AND barcode IS NOT NULL")]
    data = {'saleIds': old_sales, 'patientNames': old_patients, 'lotBarcodes': old_barcodes}
    try:
        completed = subprocess.run(['node', str(Path(__file__).with_name('qa_lifecycle_gui_scope.js'))],
                                   input=json.dumps(data), text=True, capture_output=True, timeout=160,
                                   cwd=Path(__file__).resolve().parents[1])
    except subprocess.TimeoutExpired as error:
        stderr = error.stderr or b''
        output = stderr.decode('utf-8', errors='replace') if isinstance(stderr, bytes) else stderr
        routes = re.findall(r'^QA_SCOPE_ROUTE=(/[a-z0-9/\-]+)$', output, re.MULTILINE)
        raise RuntimeError('Read-only GUI scope timed out at ' + (routes[-1] if routes else 'unresolved route')) from None
    if completed.returncode:
        routes = re.findall(r'^QA_SCOPE_ROUTE=(/[a-z0-9/\-]+)$', completed.stderr, re.MULTILINE)
        raise RuntimeError('Read-only GUI scope failed at ' + (routes[-1] if routes else 'unresolved route'))
    # Only sanitized aggregate/booleans returned by the reviewed script.
    results = json.loads(completed.stdout)
    print(json.dumps(results, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
