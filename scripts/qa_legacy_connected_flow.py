"""TEST ONLY: connected legacy-source preservation against real 065+066 SQL.

No CLI, filesystem database input, real grants, credentials or native process.
This is a synthetic reference graph, NOT a native checkout/posting simulator;
financial/accounting arithmetic is an independent acceptance invariant and
cannot prove historical tenant ownership or permit an actual upgrade.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from scripts.qa_legacy_upgrade_mapping_matrix_065 import (
    MANIFEST, MAPPING, SEAL, Source, build_memory_database,
    identity_class, source_row_hash, trusted_synthetic_bundle,
)


class FlowRejected(AssertionError):
    """A linked historical claim is incomplete, inconsistent or foreign."""


def require(predicate: bool, code: str) -> None:
    if not predicate:
        raise FlowRejected(code)


def scalar(db: sqlite3.Connection, statement: str, args: tuple = ()) -> Any:
    row = db.execute(statement, args).fetchone()
    return None if row is None else row[0]


def equal_money(actual: float, expected: float) -> bool:
    return abs(actual - expected) < 0.0000001


def build_connected_memory() -> sqlite3.Connection:
    """Real 065+066 DDL applied to entirely synthetic, in-memory tables."""
    db = build_memory_database()
    columns = {
        "inventory": "drug_id INTEGER, supplier_id TEXT, batch_number TEXT, expiry_date TEXT, strips_per_box INTEGER, medium_to_small INTEGER, cost_price REAL",
        "purchase_invoices": "supplier_id TEXT, purchase_order_id TEXT, paid_amount REAL",
        "purchase_orders": "supplier_id TEXT, status TEXT",
        "sales_invoices": "patient_id TEXT, payment_method TEXT, status TEXT",
        "returns": "invoice_id TEXT, refund_method TEXT",
        "cash_movements": "shift_id TEXT, user_id TEXT, source_type TEXT, target_name TEXT",
        "daily_journals": "created_by TEXT, source_type TEXT, source_id TEXT",
        "expenses": "cash_movement_id TEXT, journal_id TEXT",
    }
    for table, specification in columns.items():
        for fragment in specification.split(", "):
            db.execute(f"ALTER TABLE {table} ADD COLUMN {fragment}")
    db.executescript("""
        CREATE TABLE master_drugs(id INTEGER PRIMARY KEY, large_to_medium INTEGER NOT NULL,
            medium_to_small INTEGER NOT NULL);
        CREATE TABLE suppliers(id TEXT PRIMARY KEY, pharmacy_id TEXT NOT NULL);
        CREATE TABLE patients(id TEXT PRIMARY KEY, wallet_balance REAL NOT NULL);
        CREATE TABLE shifts(id TEXT PRIMARY KEY, pharmacy_id TEXT NOT NULL,
            starting_cash REAL NOT NULL, closing_cash REAL NOT NULL);
        CREATE TABLE purchase_order_items(id TEXT PRIMARY KEY, order_id TEXT, drug_id INTEGER,
            quantity REAL, received_quantity REAL);
        CREATE TABLE purchase_invoice_items(id TEXT PRIMARY KEY, invoice_id TEXT,
            inventory_id TEXT, drug_id INTEGER, quantity REAL, unit_cost REAL);
        CREATE TABLE sales_items(id TEXT PRIMARY KEY, invoice_id TEXT, inventory_id TEXT,
            drug_id INTEGER, quantity_sold REAL, unit TEXT, large_to_medium INTEGER,
            medium_to_small INTEGER, cost_price REAL);
        CREATE TABLE return_items(id TEXT PRIMARY KEY, return_id TEXT, sale_item_id TEXT,
            quantity_returned REAL, unit TEXT);
        CREATE TABLE journal_entries(id TEXT PRIMARY KEY, journal_id TEXT, account_code TEXT,
            side TEXT, amount_cents INTEGER);
        CREATE TABLE supplier_payments(id TEXT PRIMARY KEY, supplier_id TEXT, invoice_id TEXT,
            cash_movement_id TEXT, journal_id TEXT, amount REAL);
        CREATE TABLE native_patient_wallet_topup_receipts(request_id TEXT PRIMARY KEY,
            patient_id TEXT, pharmacy_id TEXT, actor_id TEXT, shift_id TEXT,
            cash_movement_id TEXT, journal_id TEXT, amount_cents INTEGER);
    """)
    db.execute("INSERT INTO master_drugs VALUES(77,12,10)")
    db.execute("INSERT INTO suppliers VALUES('supplier-synthetic','branch-a')")
    db.execute("INSERT INTO patients VALUES('patient-synthetic',64)")
    db.execute("INSERT INTO shifts VALUES('shift-synthetic','branch-a',10,65)")

    # Source tenant literals intentionally differ: no silent normalization,
    # and these values never assert genuine ownership of historic records.
    db.execute("""INSERT INTO inventory
        (id,pharmacy_id,payload,quantity,drug_id,supplier_id,batch_number,
         expiry_date,strips_per_box,medium_to_small,cost_price)
        VALUES('lot-connected',NULL,'historical lot',11,77,'supplier-synthetic',
            'BATCH-A','2035-12-31',12,10,10)""")
    db.execute("""INSERT INTO purchase_orders
        (id,pharmacy_id,payload,total_amount,supplier_id,status)
        VALUES('order-connected',' ','historical order',120,'supplier-synthetic','received')""")
    db.execute("""INSERT INTO purchase_invoices
        (id,pharmacy_id,payload,total_amount,supplier_id,purchase_order_id,paid_amount)
        VALUES('purchase-connected',NULL,'supplier receipt',120,'supplier-synthetic',
            'order-connected',40)""")
    db.execute("INSERT INTO purchase_order_items VALUES('poi-connected','order-connected',77,12,12)")
    db.execute("INSERT INTO purchase_invoice_items VALUES('pii-connected','purchase-connected','lot-connected',77,12,10)")
    db.execute("""INSERT INTO sales_invoices
        (id,pharmacy_id,payload,total_amount,patient_id,payment_method,status)
        VALUES('sale-connected','local_default','wallet sale',72,
               'patient-synthetic','wallet','completed')""")
    db.execute("INSERT INTO sales_items VALUES('sale-line-connected','sale-connected','lot-connected',77,24,'medium',12,10,10)")
    db.execute("""INSERT INTO returns
        (id,pharmacy_id,payload,total_refund,invoice_id,refund_method)
        VALUES('return-connected',NULL,'wallet return',36,'sale-connected','wallet')""")
    db.execute("INSERT INTO return_items VALUES('return-line-connected','return-connected','sale-line-connected',12,'medium')")

    for movement in (
        ('cash-wallet',100,'patient_wallet','patient-synthetic'),
        ('cash-supplier',-40,'supplier_payment','supplier-synthetic'),
        ('cash-expense',-5,'expense','expense-connected'),
    ):
        db.execute("""INSERT INTO cash_movements
            (id,pharmacy_id,payload,amount,shift_id,user_id,source_type,target_name)
            VALUES(?,'branch-a','historical drawer movement',?,
                   'shift-synthetic','owner-a-1',?,?)""",movement)

    journals = (
        ('journal-purchase','purchase','purchase-connected',120),
        ('journal-sale','sale','sale-connected',92),
        ('journal-return','return','return-connected',46),
        ('journal-wallet','wallet_topup','wallet-request',100),
        ('journal-supplier','supplier_payment','supplier-payment',40),
        ('journal-expense','expense','expense-connected',5),
    )
    for journal in journals:
        db.execute("""INSERT INTO daily_journals
            (id,pharmacy_id,payload,created_by,source_type,source_id,total_amount)
            VALUES(?,'branch-a','historic double entry','owner-a-1',?,?,?)""",journal)
    entries = {
        'journal-purchase': (('1.1.3','debit',12000),('2.1','credit',12000)),
        'journal-sale': (('2.2','debit',7200),('3.1','credit',7200),
                         ('4.1','debit',2000),('1.1.3','credit',2000)),
        'journal-return': (('3.2','debit',3600),('2.2','credit',3600),
                           ('1.1.3','debit',1000),('4.1','credit',1000)),
        'journal-wallet': (('1.1.1','debit',10000),('2.2','credit',10000)),
        'journal-supplier': (('2.1','debit',4000),('1.1.1','credit',4000)),
        'journal-expense': (('5.1','debit',500),('1.1.1','credit',500)),
    }
    for journal_id, lines in entries.items():
        for i, (account, side, cents) in enumerate(lines):
            db.execute("INSERT INTO journal_entries VALUES(?,?,?,?,?)",
                       (f'{journal_id}-{i}', journal_id, account, side, cents))
    db.execute("INSERT INTO supplier_payments VALUES('supplier-payment','supplier-synthetic','purchase-connected','cash-supplier','journal-supplier',40)")
    db.execute("""INSERT INTO native_patient_wallet_topup_receipts VALUES
        ('wallet-request','patient-synthetic','branch-a','owner-a-1',
         'shift-synthetic','cash-wallet','journal-wallet',10000)""")
    db.execute("""INSERT INTO expenses
        (id,pharmacy_id,payload,amount,cash_movement_id,journal_id)
        VALUES('expense-connected','branch-a','historical expense',5,
               'cash-expense','journal-expense')""")
    db.execute("INSERT INTO activity_log(id,pharmacy_id,payload,details) VALUES(101,NULL,'history','historical linked activity')")
    db.execute("INSERT INTO shortages(id,pharmacy_id,payload,requested_quantity) VALUES(102,'local_default','historical shortage',2)")
    db.execute("INSERT INTO financial_notices(id,pharmacy_id,payload,amount) VALUES('notice-connected',NULL,'historic notice',0)")
    return db


CORE = (
    'users', 'native_owner_scope_review', 'master_drugs', 'suppliers', 'patients', 'shifts', 'purchase_order_items',
    'purchase_invoice_items', 'sales_items', 'return_items', 'journal_entries',
    'supplier_payments', 'native_patient_wallet_topup_receipts',
)
SOURCE_IDS = {
    'inventory': ('lot-connected',),
    'purchase_orders': ('order-connected',),
    'purchase_invoices': ('purchase-connected',),
    'sales_invoices': ('sale-connected',),
    'returns': ('return-connected',),
    'cash_movements': ('cash-wallet','cash-supplier','cash-expense'),
    'daily_journals': ('journal-purchase','journal-sale','journal-return',
                       'journal-wallet','journal-supplier','journal-expense'),
    'expenses': ('expense-connected',),
    'activity_log': ('101',),
    'shortages': ('102',),
    'financial_notices': ('notice-connected',),
}
ALL_HISTORY_TABLES = tuple(sorted((*SOURCE_IDS, *CORE)))


def typed(value: Any) -> tuple[str, Any]:
    """Preserve exact SQLite material type/float bits/null/byte identity."""
    if value is None:
        return ('null', None)
    if isinstance(value, int):
        return ('integer', str(value))
    if isinstance(value, float):
        return ('real', value.hex())
    if isinstance(value, bytes):
        return ('blob', value.hex())
    if isinstance(value, str):
        return ('text', value)
    raise TypeError(f'unsupported SQLite fixture value {type(value).__name__}')


def typed_record_map(db: sqlite3.Connection) -> dict[str, dict[tuple[str, Any], tuple]]:
    """Explicit record IDs -> per-column typed values, not row counts/hashes."""
    snapshot = {}
    for table in ALL_HISTORY_TABLES:
        columns = tuple(row[1] for row in db.execute(f'PRAGMA table_info("{table}")'))
        key_name = ('request_id' if table == 'native_patient_wallet_topup_receipts'
                    else 'owner_id' if table == 'native_owner_scope_review' else 'id')
        key_idx = columns.index(key_name)
        rows = {}
        for row in db.execute(f'SELECT * FROM "{table}"'):
            key = typed(row[key_idx])
            require(key not in rows, 'duplicate_typed_primary_identity')
            rows[key] = tuple(zip(columns, map(typed, row)))
        snapshot[table] = rows
    return snapshot


def record_map_digest(records: dict) -> str:
    normalized = {table: [((key[0], key[1]), values)
                          for key, values in sorted(rows.items())]
                  for table, rows in sorted(records.items())}
    return hashlib.sha256(json.dumps(normalized, sort_keys=True,
                                     ensure_ascii=False).encode()).hexdigest()


def connected_sources(db: sqlite3.Connection) -> tuple[Source, ...]:
    sources = []
    for table, ids in SOURCE_IDS.items():
        for record_id in ids:
            source = db.execute(f'SELECT pharmacy_id FROM "{table}" WHERE CAST(id AS TEXT)=?',
                                (record_id,)).fetchone()
            require(source is not None, 'missing_source_' + table)
            sources.append(Source(table, record_id, source[0]))
    return tuple(sources)


def _exists(db: sqlite3.Connection, statement: str, args: tuple = ()) -> bool:
    return scalar(db, statement, args) == 1


def validate_connected_graph(db: sqlite3.Connection) -> None:
    """Fail closed on missing/foreign links and accounting mismatch; read-only.

    This is a bounded *synthetic acceptance graph*, not an implementation of
    application native posting authorization, signed historical proof, or
    a generally applicable historical financial reconciliation algorithm.
    """
    for source in connected_sources(db):
        require(source.original in (None, '', ' ', 'local_default', 'branch-a'),
                'foreign_source_pharmacy')
    require(_exists(db, """SELECT 1 FROM purchase_orders po JOIN suppliers sup
        ON po.supplier_id=sup.id AND sup.pharmacy_id='branch-a'
        JOIN purchase_invoices pi ON pi.purchase_order_id=po.id
            AND pi.supplier_id=sup.id
        JOIN purchase_order_items oi ON oi.order_id=po.id
        JOIN purchase_invoice_items item ON item.invoice_id=pi.id
            AND item.drug_id=oi.drug_id AND item.quantity=oi.received_quantity
        JOIN inventory lot ON lot.id=item.inventory_id AND lot.drug_id=item.drug_id
            AND lot.supplier_id=sup.id AND lot.batch_number='BATCH-A'
            AND lot.expiry_date='2035-12-31'
            AND lot.expiry_date>=date('now')
        WHERE po.id='order-connected' AND pi.id='purchase-connected'
            AND lot.id='lot-connected' AND oi.quantity=12
            AND pi.total_amount=120 AND po.total_amount=120
            AND item.quantity=12 AND item.unit_cost=10"""), 'purchase_lot_supplier_link')

    require(_exists(db, """SELECT 1 FROM sales_invoices sale
        JOIN patients p ON p.id=sale.patient_id
        JOIN sales_items si ON si.invoice_id=sale.id
        JOIN inventory lot ON lot.id=si.inventory_id AND lot.drug_id=si.drug_id
        JOIN master_drugs drug ON drug.id=si.drug_id
        JOIN returns r ON r.invoice_id=sale.id AND r.refund_method='wallet'
        JOIN return_items ri ON ri.return_id=r.id AND ri.sale_item_id=si.id
        WHERE sale.id='sale-connected' AND r.id='return-connected'
          AND sale.status='completed' AND sale.payment_method='wallet'
          AND sale.total_amount=72 AND r.total_refund=36
          AND si.unit='medium' AND ri.unit=si.unit
          AND si.large_to_medium=lot.strips_per_box
          AND si.medium_to_small=lot.medium_to_small
          AND si.large_to_medium=drug.large_to_medium
          AND si.medium_to_small=drug.medium_to_small
          AND si.quantity_sold=24 AND ri.quantity_returned=12
          AND si.cost_price=lot.cost_price AND lot.cost_price=10"""), 'sale_return_lot_patient_conversion_link')
    for table in ('purchase_order_items', 'purchase_invoice_items',
                  'sales_items', 'return_items', 'supplier_payments',
                  'native_patient_wallet_topup_receipts'):
        require(scalar(db, f'SELECT COUNT(*) FROM "{table}"') == 1,
                'unclaimed_' + table)

    # Selected-unit conservation: one purchased lot, two boxes sold as strips,
    # one box returned. COGS must use base-box quantity, not 24 strip units.
    received = scalar(db,"SELECT quantity FROM purchase_invoice_items WHERE id='pii-connected'")
    sold = scalar(db,"""SELECT si.quantity_sold*1.0/si.large_to_medium
        FROM sales_items si WHERE si.id='sale-line-connected'""")
    returned = scalar(db,"""SELECT ri.quantity_returned*1.0/si.large_to_medium
        FROM return_items ri JOIN sales_items si ON si.id=ri.sale_item_id
        WHERE ri.id='return-line-connected'""")
    remaining = scalar(db,"SELECT quantity FROM inventory WHERE id='lot-connected'")
    require(equal_money(remaining, received - sold + returned), 'stock_unit_conservation')
    sale_cogs = int(round(sold * 10 * 100))
    refund_cogs = int(round(returned * 10 * 100))
    require(sale_cogs == 2000 and refund_cogs == 1000, 'base_unit_cogs')

    require(_exists(db,"""SELECT 1 FROM native_patient_wallet_topup_receipts r
        JOIN patients p ON p.id=r.patient_id
        JOIN cash_movements cm ON cm.id=r.cash_movement_id
        JOIN daily_journals j ON j.id=r.journal_id
        JOIN shifts sh ON sh.id=r.shift_id
        WHERE r.request_id='wallet-request' AND r.pharmacy_id='branch-a'
          AND r.actor_id='owner-a-1' AND r.amount_cents=10000
          AND cm.shift_id=sh.id AND sh.pharmacy_id=r.pharmacy_id
          AND cm.pharmacy_id=r.pharmacy_id AND j.pharmacy_id=r.pharmacy_id
          AND cm.user_id=r.actor_id AND j.created_by=r.actor_id
          AND cm.source_type='patient_wallet' AND cm.target_name=p.id
          AND cm.amount*100=r.amount_cents AND j.total_amount*100=r.amount_cents"""),
            'wallet_cash_shift_journal_witness')
    wallet = scalar(db,"SELECT wallet_balance FROM patients WHERE id='patient-synthetic'")
    require(equal_money(wallet, 100 - 72 + 36), 'wallet_receipt_sale_return_conservation')

    require(_exists(db,"""SELECT 1 FROM supplier_payments sp
        JOIN purchase_invoices pi ON pi.id=sp.invoice_id AND pi.supplier_id=sp.supplier_id
        JOIN suppliers s ON s.id=sp.supplier_id AND s.pharmacy_id='branch-a'
        JOIN cash_movements cm ON cm.id=sp.cash_movement_id
        JOIN daily_journals j ON j.id=sp.journal_id
        JOIN shifts sh ON sh.id=cm.shift_id AND sh.pharmacy_id=s.pharmacy_id
        WHERE sp.id='supplier-payment' AND sp.amount=40 AND pi.paid_amount=40
            AND cm.amount=-sp.amount AND cm.source_type='supplier_payment'
            AND cm.target_name=sp.supplier_id AND cm.pharmacy_id=s.pharmacy_id
            AND j.source_type='supplier_payment' AND j.source_id=sp.id
            AND j.pharmacy_id=s.pharmacy_id"""), 'supplier_payment_cash_journal_link')
    require(_exists(db,"""SELECT 1 FROM expenses e
        JOIN cash_movements cm ON cm.id=e.cash_movement_id
        JOIN daily_journals j ON j.id=e.journal_id
        WHERE e.id='expense-connected' AND e.amount=5
          AND cm.amount=-e.amount AND cm.source_type='expense'
          AND cm.target_name=e.id AND j.source_type='expense'
          AND j.source_id=e.id AND cm.pharmacy_id=e.pharmacy_id
          AND j.pharmacy_id=e.pharmacy_id"""), 'expense_cash_journal_link')
    require(equal_money(scalar(db,"SELECT closing_cash FROM shifts WHERE id='shift-synthetic'"),
                        scalar(db,"SELECT starting_cash FROM shifts WHERE id='shift-synthetic'")
                        + scalar(db,"SELECT SUM(amount) FROM cash_movements WHERE shift_id='shift-synthetic'")),
            'shift_cash_conservation')
    require(scalar(db,"SELECT COUNT(*) FROM cash_movements WHERE shift_id='shift-synthetic'")==3,
            'unclaimed_shift_cash')

    expected_journals = {
        'journal-purchase': ({('1.1.3','debit',12000),('2.1','credit',12000)},12000),
        'journal-sale': ({('2.2','debit',7200),('3.1','credit',7200),
                         ('4.1','debit',sale_cogs),('1.1.3','credit',sale_cogs)},9200),
        'journal-return': ({('3.2','debit',3600),('2.2','credit',3600),
                           ('1.1.3','debit',refund_cogs),('4.1','credit',refund_cogs)},4600),
        'journal-wallet': ({('1.1.1','debit',10000),('2.2','credit',10000)},10000),
        'journal-supplier': ({('2.1','debit',4000),('1.1.1','credit',4000)},4000),
        'journal-expense': ({('5.1','debit',500),('1.1.1','credit',500)},500),
    }
    require(scalar(db,"SELECT COUNT(*) FROM daily_journals WHERE source_type IS NOT NULL")==6,
            'journal_count')
    for journal_id, (expected, header_cents) in expected_journals.items():
        actual = db.execute("""SELECT account_code,side,amount_cents FROM journal_entries
            WHERE journal_id=?""",(journal_id,)).fetchall()
        require(len(actual)==len(expected) and set(actual)==expected,
                'original_journal_entries_' + journal_id)
        debit = sum(cents for _,side,cents in actual if side=='debit')
        credit = sum(cents for _,side,cents in actual if side=='credit')
        header = scalar(db,"SELECT total_amount FROM daily_journals WHERE id=?",(journal_id,))
        require(debit==credit==header_cents and equal_money(header*100, header_cents),
                'journal_balance_' + journal_id)
    require(scalar(db, 'SELECT COUNT(*) FROM journal_entries') ==
            sum(len(lines) for lines, _ in expected_journals.values()),
            'unclaimed_journal_entries')


def map_synthetic_evidence(db: sqlite3.Connection, sources: tuple[Source,...]):
    """Strictly a test HMAC / fake user manifest, never genuine authorization."""
    bundle = trusted_synthetic_bundle(db,sources)
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute(MANIFEST,bundle.manifest_params)
        for mapping in bundle.mappings:
            db.execute(MAPPING,mapping)
        db.execute(SEAL,bundle.seal_params)
        db.execute('COMMIT')
    except BaseException:
        db.execute('ROLLBACK')
        raise
    for source, mapping in zip(sources,bundle.mappings):
        require(mapping[3]==identity_class(source.original), 'source_identity_class_changed')
        require(mapping[4]==source.original, 'original_tenant_literal_changed')
        require(mapping[5]==source_row_hash(db,source), 'original_typed_source_sha_changed')
    require(scalar(db,'SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources')==len(sources),
            'synthetic_evidence_view_count')
    return bundle
