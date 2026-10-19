"""Read-only pinned synthetic native purchase→lot→journal identity auditor.

The only mutation probes run against a SQLite :memory: backup. Never post,
retry the historical purchase nonce, or open the protected repository DB.
"""

import json
import os
from pathlib import Path
import sqlite3
import sys
from contextlib import closing
from decimal import Decimal

if not __debug__ or sys.platform != 'win32':
    raise SystemExit('Requires assertions and isolated Windows synthetic instance')

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ['APPDATA']) / 'com.pharma.disposable.qa20261014bg' / 'pharma_local.db'
PROTECTED = ROOT / 'src-tauri' / 'pharma_local.db'
EXPECTED_INVOICE = 'b923e803-fc9e-49d2-be12-398fac05d1f3'
EXPECTED_LOT = '79961d50-25e0-450f-a00e-92490bdf09f8'
EXPECTED_JOURNAL = '7567c74b-08cd-4894-8e81-2f95a63c6da7'


def cents(value):
    amount = Decimal(str(value)) * 100
    assert amount == amount.to_integral_value(), ('nonintegral cents', value)
    return int(amount)


def assert_purchase_identity(db):
    request = db.execute("""
        SELECT request_id,invoice_id,actor_id,pharmacy_id,supplier_id,
               source_status,source_total_cents,source_line_count,initial_journal_id
          FROM native_purchase_create_requests
    """).fetchall()
    assert len(request) == 1, ('purchase request count', len(request))
    nonce, invoice_id, actor, tenant, supplier, status, value, lines, journal_id = request[0]
    assert nonce and invoice_id == EXPECTED_INVOICE
    assert journal_id == EXPECTED_JOURNAL, ('unexpected pinned journal', journal_id)
    assert (actor, tenant, supplier, status, value, lines) == (
        'admin', 'local_default', 1001, 'completed', 35000, 1)
    # This pins CURRENT disposable-fixture actor state, not the historical
    # user's eligibility at the time of the purchase or a tenant-wide proof.
    current_actor = db.execute(
        'SELECT role,pharmacy_id,is_active FROM users WHERE id=?', (actor,)
    ).fetchone()
    assert current_actor == ('owner', tenant, 1), ('synthetic actor current scope', current_actor)

    invoice = db.execute("""
        SELECT supplier_id,pharmacy_id,user_id,invoice_number,total_amount,paid_amount,
               payment_method,status FROM purchase_invoices WHERE id=?
    """, (invoice_id,)).fetchone()
    assert invoice == (supplier, tenant, actor, 'QA-REAL-NATIVE-20261014-01',
                       350, 0, 'credit', 'completed'), ('invoice', invoice)

    events = db.execute("""
        SELECT actor_id,pharmacy_id,supplier_id,event_kind,journal_id,payment_method,
               signed_cents,old_total_cents,new_total_cents,line_snapshot
          FROM native_purchase_posting_events WHERE invoice_id=?
    """, (invoice_id,)).fetchall()
    assert len(events) == 1, ('purchase posting events', len(events))
    event_actor,event_tenant,event_supplier,kind,event_journal,method,signed,old,new,snapshot = events[0]
    assert (event_actor,event_tenant,event_supplier,kind,event_journal,method,signed,old,new) == (
        actor,tenant,supplier,'initial',journal_id,'credit',35000,0,35000)
    snapshots = json.loads(snapshot)
    assert len(snapshots) == 1

    items = db.execute("""
        SELECT id,drug_id,quantity,expiry_date,cost_price,selling_price,bonus_quantity,
               tax_percent,discount_percent,inventory_id,strips_per_box,medium_to_small
          FROM purchase_invoice_items WHERE invoice_id=?
    """, (invoice_id,)).fetchall()
    assert len(items) == 1
    line_id,drug_id,quantity,expiry,cost,selling,bonus,tax,discount,lot_id,strips,medium = items[0]
    assert (line_id,drug_id,quantity,expiry,cents(cost),cents(selling),bonus,cents(tax),
            lot_id,strips,medium) == (
        1,90001,10,'2027-12-31',3500,4600,0,0,EXPECTED_LOT,1,1)
    snap = snapshots[0]
    assert snap['lineId'] == line_id and snap['drugId'] == drug_id
    assert snap['inventoryId'] == lot_id and snap['originalLotVerifiable'] is True
    assert (cents(snap['cost']), cents(snap['quantity']), cents(snap['bonus'])) == (3500,1000,0)
    assert abs(Decimal(str(snap['discount'])) - Decimal(str(discount))) < Decimal('0.000001')
    assert Decimal(str(snap['tax'])) == Decimal(str(tax))
    assert cents(Decimal(str(cost)) * Decimal(quantity)) == value

    lots = db.execute("""
        SELECT drug_id,pharmacy_id,quantity,local_selling_price,cost_price,
               expiry_date,batch_number,strips_per_box,medium_to_small
          FROM inventory WHERE id=?
    """, (lot_id,)).fetchall()
    assert lots == [(drug_id, tenant, quantity, selling, cost, expiry,
                     'PURCHASE-' + invoice_id, strips, medium)], ('stock lot identity', lots)

    journal = db.execute("""
        SELECT created_by,pharmacy_id,total_amount,description
          FROM daily_journals WHERE id=?
    """, (journal_id,)).fetchone()
    assert journal and journal[0] == actor and journal[1] == tenant
    assert cents(journal[2]) == value and invoice_id in journal[3]
    entries = db.execute("""
        SELECT je.type,je.amount,a.code,a.type,a.is_group FROM journal_entries je
        JOIN accounts a ON a.id=je.account_id WHERE je.journal_id=?
    """, (journal_id,)).fetchall()
    assert len(entries) == 2
    assert {(kind, code, cents(amount), account_type, is_group)
            for kind,amount,code,account_type,is_group in entries} == {
        ('debit','1.1.3',value,'asset',0),('credit','2.1',value,'liability',0)
    }, ('purchase journal entries', entries)

    ledger = db.execute("""
        SELECT amount FROM supplier_transactions WHERE supplier_id=? AND type='invoice'
               AND reference_id=?
    """, (supplier, invoice_id)).fetchall()
    assert len(ledger) == 1 and cents(ledger[0][0]) == value
    payments = db.execute("""
        SELECT amount FROM supplier_transactions WHERE supplier_id=? AND type='payment'
    """, (supplier,)).fetchall()
    assert sorted(cents(p[0]) for p in payments) == [100,1500,4000]
    outstanding = value - sum(cents(p[0]) for p in payments)
    actual_balance = db.execute('SELECT balance FROM suppliers WHERE id=?',(supplier,)).fetchone()[0]
    assert cents(actual_balance) == outstanding == 29400
    assert db.execute('SELECT COUNT(*) FROM sales_invoices').fetchone()[0] == 0
    assert db.execute('SELECT COUNT(*) FROM purchase_returns').fetchone()[0] == 0
    return {'invoice': invoice_id, 'lot': lot_id, 'invoice_cents': value,
            'stock_base_units': quantity, 'lot_unit_cost_cents': cents(cost),
            'projected_unit_sale_cents': cents(selling), 'projected_gross_margin_cents':
            cents((Decimal(str(selling)) - Decimal(str(cost))) * Decimal(quantity)),
            'supplier_outstanding_cents': outstanding,
            'journal': journal_id, 'source_request_count': len(request),
            'posting_events': len(events)}


def audit():
    assert SOURCE.is_file() and PROTECTED.is_file()
    assert SOURCE.resolve(strict=True) == SOURCE.absolute(), 'Synthetic DB symlink or junction'
    assert not os.path.samefile(SOURCE, PROTECTED), 'Synthetic source aliases protected original'
    with closing(sqlite3.connect(SOURCE.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
        db.execute('PRAGMA query_only=ON')
        assert db.execute('SELECT MAX(version),COUNT(*) FROM _sqlx_migrations').fetchone() == (59,59)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        found = assert_purchase_identity(db)
        clone = sqlite3.connect(':memory:')
        try:
            db.backup(clone)
            clone.execute('PRAGMA foreign_keys=ON')
            probes = (
                ('stock quantity alteration',
                 'UPDATE inventory SET quantity=quantity+1 WHERE id=?', (EXPECTED_LOT,)),
                ('source tenant alteration',
                 'UPDATE inventory SET pharmacy_id=? WHERE id=?', ('other_tenant', EXPECTED_LOT)),
                ('journal amount alteration',
                 "UPDATE journal_entries SET amount=amount+1 WHERE journal_id=? AND type='debit'",
                 (found['journal'],)),
                ('purchase supplier alteration',
                 'UPDATE purchase_invoices SET supplier_id=999 WHERE id=?', (EXPECTED_INVOICE,)),
            )
            verified = []
            expected_guards = {
                'journal amount alteration': 'Receipted purchase journal entry is immutable',
                'purchase supplier alteration': 'Partially settled supplier invoice requires separate reconciliation',
            }
            for name, sql, params in probes:
                clone.execute('SAVEPOINT probe')
                try:
                    try:
                        clone.execute(sql, params)
                    except sqlite3.IntegrityError as error:
                        assert str(error) == expected_guards.get(name), (
                            'unexpected SQLite error, not the expected financial guard', name, str(error))
                        verified.append({'name':name, 'result':'rejected_by_sqlite_guard'})
                    else:
                        try:
                            assert_purchase_identity(clone)
                        except AssertionError:
                            verified.append({'name':name, 'result':'detected_by_identity_auditor'})
                        else:
                            raise AssertionError('Tamper not detected: ' + name)
                finally:
                    clone.execute('ROLLBACK TO probe')
                    clone.execute('RELEASE probe')
            assert len(verified) == len(probes)
            assert_purchase_identity(clone)
            found['memory_only_tamper_tests'] = verified
        finally:
            clone.close()
        return dict(status='pass', source='com.pharma.disposable.qa20261014bg',
                    readonly_source=True, tamper_scope='memory_only',
                    sqlite_integrity='ok', foreign_key_errors=0, **found)


if __name__ == '__main__':
    try:
        print(json.dumps(audit(), indent=2))
    except Exception as exc:
        print(json.dumps({'status':'fail','error':str(exc),'readonly_source':True,
                          'tamper_scope':'memory_only'}))
        sys.exit(1)
