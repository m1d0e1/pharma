"""Logical backup/restore preview of ONLY the identified synthetic BG SQLite DB.

Both backup and restored copies are new evidence files under a unique QA TEMP
directory. Never close, overwrite or restore the running application database.
"""
import hashlib
import json
import os
import pathlib
import runpy
import sqlite3
import sys

_custody = runpy.run_path(str(pathlib.Path(__file__).with_name('qa-background-sqlite.py')))
EXPECTED = _custody['EXPECTED']
require_unique_bg_file = _custody['require_unique_bg_file']


def preview(folder):
    if not __debug__ or sys.platform != 'win32':
        raise RuntimeError('Recovery preview requires Windows and enabled assertions')
    temp = pathlib.Path(os.environ['TEMP']).resolve(strict=True)
    out = pathlib.Path(folder).resolve(strict=True)
    if out.parent != temp or not out.name.startswith('pharma-background-qa-'):
        raise RuntimeError('Only a fresh QA evidence directory under OS TEMP is permitted')
    require_unique_bg_file()
    snapshot = out / 'logical-backup-preview.sqlite'
    recovered = out / 'logical-restored-preview.sqlite'
    for dest in (snapshot, recovered):
        # Exclusive creation; never replace any prior snapshot/evidence.
        with dest.open('xb'):
            pass
    tables = ('_sqlx_migrations', 'native_supplier_payment_receipts',
              'daily_journals', 'journal_entries', 'cash_movements',
              'native_financial_notice_cash_witnesses', 'shifts')

    def facts(db):
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        return {table: db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                for table in tables} | {
                    'supplier_receipts': db.execute('SELECT id,amount_cents,payment_method,journal_id,'
                        'cash_movement_id FROM native_supplier_payment_receipts ORDER BY id').fetchall(),
                    'journals': db.execute('SELECT id FROM daily_journals ORDER BY id').fetchall(),
                    'notice_cash_uuids': db.execute('SELECT notice_id,cash_movement_id '
                        'FROM native_financial_notice_cash_witnesses ORDER BY notice_id').fetchall(),
                }

    original = sqlite3.connect(EXPECTED.as_uri() + '?mode=ro', uri=True, timeout=10)
    original.execute('PRAGMA query_only=ON')
    try:
        before = facts(original)
        backup = sqlite3.connect(snapshot)
        try:
            original.backup(backup)
            assert facts(backup) == before
            copy = sqlite3.connect(recovered)
            try:
                backup.backup(copy)
                assert facts(copy) == before
            finally:
                copy.close()
        finally:
            backup.close()
        assert facts(original) == before, 'Synthetic source changed during preview'
    finally:
        original.close()
    return {'status': 'pass', 'source': 'synthetic_BG_readonly',
            'snapshot_file': snapshot.name, 'restored_file': recovered.name,
            'snapshot_sha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(),
            'restored_sha256': hashlib.sha256(recovered.read_bytes()).hexdigest(),
            'tables_and_identity_verified': len(tables) + 3,
            'original_source_modified': False,
            'limitation': 'Logical SQLite copy/restore into new TEMP only; NOT OS-quiesced app replacement/rollback'}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Expected one exclusive QA evidence directory')
        print(json.dumps(preview(sys.argv[1]), indent=2))
    except Exception as exc:
        print(json.dumps({'status': 'fail', 'error': str(exc)}))
        sys.exit(1)
