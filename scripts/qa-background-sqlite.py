"""Read-only real native BG provenance plus tamper tests on an in-memory clone.

Never open the original QA DB or B/C. Never infer missing historic receipts.
Exit nonzero if an exact native source, actor, tenant, cents, journal, cash,
shift or post-058 guard fails.
"""
import json
import os
import pathlib
import sqlite3
import sys

if not __debug__:
    raise SystemExit('QA source verification requires assertions: disable PYTHONOPTIMIZE')

APP_ID = 'com.pharma.disposable.qa20261014bg'
EXPECTED = pathlib.Path(os.environ['APPDATA']) / APP_ID / 'pharma_local.db'


def require_unique_bg_file():
    if os.path.normcase(str(EXPECTED.resolve(strict=True))) != os.path.normcase(str(EXPECTED.absolute())):
        raise RuntimeError('BG app-data database follows a symbolic link or junction')
    original = pathlib.Path(__file__).resolve().parents[1] / 'src-tauri/pharma_local.db'
    other = [original] + [pathlib.Path(os.environ['APPDATA']) / app / 'pharma_local.db'
        for app in ('com.pharma.disposable.qa20261014b', 'com.pharma.disposable.qa20261014c')]
    for candidate in other:
        if candidate.exists() and os.path.samefile(EXPECTED, candidate):
            raise RuntimeError('BG database aliases an original/protected session file')


def audit():
    assert sys.platform == 'win32'
    assert EXPECTED.is_file()
    require_unique_bg_file()
    source = sqlite3.connect(EXPECTED.as_uri() + '?mode=ro', uri=True, timeout=5)
    source.execute('PRAGMA query_only=ON')
    result = {'schema': 'synthetic-59-native-only', 'source': APP_ID,
              'readonly_source': True, 'tamper_scope': 'memory_clone_only'}
    try:
        versions = source.execute('SELECT MAX(version),COUNT(*) FROM _sqlx_migrations').fetchone()
        assert versions == (59, 59), versions
        result['migration_version'] = 59
        assert source.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not source.execute('PRAGMA foreign_key_check').fetchall()
        suppliers = source.execute('''
            SELECT receipt.id,receipt.payment_method,receipt.amount_cents,receipt.pharmacy_id,
                receipt.actor_id,receipt.journal_id,receipt.cash_movement_id,
                supplier.id,tx.amount,tx.user_id,tx.type,j.id,j.pharmacy_id,j.created_by
            FROM native_supplier_payment_receipts receipt
            JOIN suppliers supplier ON supplier.id=receipt.supplier_id
            JOIN supplier_transactions tx ON tx.id=receipt.supplier_transaction_id
            JOIN daily_journals j ON j.id=receipt.journal_id
            ORDER BY receipt.id
        ''').fetchall()
        assert len(suppliers) in (2,3), 'Synthetic C lineage unexpectedly changed'
        methods = set()
        tender_amounts = []
        for (rid, method, cents, pharmacy, actor, journal, cash_id,
             sid, ledger_amount, ledger_actor, transaction_type, jid, journal_tenant, journal_actor) in suppliers:
            assert pharmacy == journal_tenant == 'local_default'
            assert actor == ledger_actor == journal_actor == 'admin'
            assert transaction_type == 'payment' and rid and journal == jid and sid == 1001
            assert round(abs(ledger_amount)*100) == cents
            entries = source.execute('''SELECT je.type,je.amount,a.code FROM journal_entries je
                                      JOIN accounts a ON a.id=je.account_id
                                      WHERE je.journal_id=?''',(journal,)).fetchall()
            assert len(entries) == 2 and {p[0] for p in entries} == {'debit','credit'}
            assert all(round(abs(value)*100) == cents for _,value,_ in entries)
            assert {(kind,code) for kind,_,code in entries} == {
                ('debit','2.1'), ('credit','1.1.1' if method == 'cash' else '1.1.4')
            }
            methods.add(method)
            tender_amounts.append((method,cents))
            if method == 'cash':
                assert cents == 4000 and cash_id
                movement = source.execute('''SELECT cm.amount,cm.user_id,cm.pharmacy_id,
                           cm.shift_id,cm.type,cm.source_type,cm.target_name,sh.pharmacy_id
                           FROM cash_movements cm JOIN shifts sh ON sh.id=cm.shift_id
                           WHERE cm.id=?''',(cash_id,)).fetchone()
                assert movement and round(movement[0]*100) == cents
                assert movement[1] == actor and movement[2] == movement[7] == pharmacy
                assert movement[3] == 'qa-open-shift' and movement[4] == 'disbursement'
                assert movement[5] == 'supplier_payment' and movement[6] == rid
            elif method == 'bank':
                assert cents in (1500,100) and cash_id is None
            else:
                raise AssertionError('Unexpected source settlement method')
        assert methods == {'cash','bank'}
        assert sorted(tender_amounts) in (
            [('bank',1500),('cash',4000)],
            [('bank',100),('bank',1500),('cash',4000)],
        ), 'Unexpected supplier tender or double-posting'
        if len(suppliers)==3:
            extra = source.execute('''SELECT balance_before_cents,balance_after_cents,
                     payment_date,request_id FROM native_supplier_payment_receipts
                     WHERE payment_method='bank' AND amount_cents=100''').fetchall()
            assert len(extra)==1 and extra[0][0:3]==(29500,29400,'2026-10-14')
            assert source.execute('SELECT balance FROM suppliers WHERE id=1001').fetchone()[0]==294
            result['new_BG_bank_one_egp_receipt_prospectively_verified']=1
        result['supplier_cash_and_bank_receipts_verified'] = len(suppliers)

        notices = source.execute('''SELECT w.notice_id,w.journal_id,w.cash_movement_id,
                         w.shift_id,w.pharmacy_id,w.actor_id,w.amount_cents,
                         n.amount,n.user_id,n.pharmacy_id,r.journal_id,r.source_kind,r.source_id
                       FROM native_financial_notice_cash_witnesses w
                       JOIN financial_notices n ON n.id=w.notice_id
                       JOIN native_patient_financial_journal_receipts r
                          ON r.source_id=w.notice_id AND r.source_kind='notice'
                    ''').fetchall()
        assert len(notices) == 1
        (notice_id, journal, cash_id, shift_id, tenant, actor, cents,
         amount, notice_actor, notice_tenant, receipt_journal, kind, source_id) = notices[0]
        assert notice_id == source_id and kind == 'notice' and journal == receipt_journal
        assert cents == 1250 and round(amount*100) == cents
        assert actor == notice_actor == 'admin' and tenant == notice_tenant == 'local_default'
        cm = source.execute('''SELECT cm.amount,cm.shift_id,cm.pharmacy_id,cm.user_id,
                                  cm.type,cm.source_type,cm.target_name,sh.pharmacy_id
                               FROM cash_movements cm JOIN shifts sh ON sh.id=cm.shift_id
                               WHERE cm.id=?''',(cash_id,)).fetchone()
        assert cm and round(cm[0]*100) == cents and cm[1] == shift_id
        assert cm[2] == cm[7] == tenant and cm[3] == actor and cm[4] == 'receipt'
        assert cm[5] == 'financial_notice' and cm[6] == notice_id
        notice_entries = source.execute('''SELECT je.type,je.amount,a.code
                            FROM journal_entries je JOIN accounts a ON a.id=je.account_id
                            WHERE je.journal_id=?''',(journal,)).fetchall()
        assert len(notice_entries) == 2 and {(kind,code) for kind,_,code in notice_entries} == {
            ('debit','1.1.1'),('credit','4.2')}
        assert all(round(abs(amount)*100) == cents for _,amount,_ in notice_entries)
        result['notice_056_exact_identity_verified'] = 1
        result['sqlite_integrity'] = 'ok'
        result['foreign_key_errors'] = 0

        clone = sqlite3.connect(':memory:')
        source.backup(clone)
        clone.execute('PRAGMA foreign_keys=ON')
        clone.execute('PRAGMA recursive_triggers=OFF')
        old = 'qa-open-shift'
        bad_statements = (
            "UPDATE shifts SET pharmacy_id='untrusted_tenant' WHERE id='qa-open-shift'",
            "UPDATE shifts SET id='wrong_shift' WHERE id='qa-open-shift'",
            "DELETE FROM shifts WHERE id='qa-open-shift'",
            "INSERT OR REPLACE INTO shifts(id,pharmacy_id,status) VALUES ('qa-open-shift','untrusted_tenant','closed')",
        )
        for statement in bad_statements:
            clone.execute('SAVEPOINT attempt')
            try:
                clone.execute(statement)
            except sqlite3.DatabaseError:
                pass
            else:
                raise AssertionError('058 guard accepted shift identity attack: ' + statement)
            finally:
                clone.execute('ROLLBACK TO attempt')
                clone.execute('RELEASE attempt')
        assert clone.execute('SELECT pharmacy_id,status FROM shifts WHERE id=?',(old,)).fetchone() == ('local_default','closed')
        columns = [item[1] for item in clone.execute('PRAGMA table_info(native_supplier_payment_receipts)')]
        original_bank = clone.execute("SELECT * FROM native_supplier_payment_receipts WHERE payment_method='bank'").fetchone()
        assert original_bank
        forged = list(original_bank)
        forged[columns.index('balance_before_cents')] = 29500
        forged[columns.index('balance_after_cents')] = 28000
        clone.execute("INSERT INTO supplier_transactions(supplier_id,type,amount,date,reference_id,user_id) "
                      "VALUES(1001,'misc',0,'2026-10-14','bg-test-unreceipted-ledger-noise','admin')")
        sql = ('INSERT OR REPLACE INTO native_supplier_payment_receipts (' + ','.join(columns)
               + ') VALUES (' + ','.join('?' for _ in columns) + ')')
        try:
            clone.execute(sql, forged)
        except sqlite3.DatabaseError:
            pass
        else:
            raise AssertionError('059 guard accepted immutable bank receipt replacement')
        assert clone.execute('SELECT balance_before_cents,balance_after_cents '
                             'FROM native_supplier_payment_receipts WHERE id=?',
                             (original_bank[0],)).fetchone() == (31000,29500)
        # The active native shift uniqueness guard permits one open shift per
        # owned pharmacy; close it on the clone before testing new shift creation.
        clone.execute("UPDATE shifts SET status='closed' WHERE id='c74f61ab-affb-4cb4-8b39-7fd8fc0eca0f'")
        clone.execute("INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash) VALUES ('bg-positive-shift','admin','local_default','open',0)")
        clone.execute("UPDATE shifts SET status='closed' WHERE id='bg-positive-shift'")
        assert clone.execute('SELECT status FROM shifts WHERE id=?',('bg-positive-shift',)).fetchone()[0] == 'closed'
        assert clone.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not clone.execute('PRAGMA foreign_key_check').fetchall()
        clone.close()
        result['058_mutations_rejected_on_in_memory_clone'] = 4
        result['059_receipt_replacement_rejected_on_in_memory_clone'] = 1
        result['new_shift_positive_insert_and_close'] = 'pass'
        result['status'] = 'pass'
        return result
    finally:
        source.close()


if __name__ == '__main__':
    try:
        print(json.dumps(audit(), indent=2))
    except Exception as exc:
        print(json.dumps({'status':'fail','error':str(exc), 'readonly_source':True,
                          'tamper_scope':'memory_clone_only'}))
        sys.exit(1)
