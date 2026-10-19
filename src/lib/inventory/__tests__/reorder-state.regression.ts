/** @jest-environment node */

import Database from 'better-sqlite3';
import { createSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';
import { getEffectiveReorderState, getSalesConversionSql, hasRecoveredStock, resolveRecoveredShortages } from '@/lib/inventory/reorder-state';
import { unitQuantityInLarge } from '@/lib/inventory/unit-quantity';

describe('reorder state transaction-safe schema probing', () => {
  it('detects sale conversion snapshots using SELECT-only transaction reads', async () => {
    const seenSql: string[] = [];
    const scopedDb: any = {
      prepare: (sql: string) => ({
        all: async () => {
          seenSql.push(sql.trim());
          if (!/^SELECT\b/i.test(sql.trim())) throw new Error('transaction read guard only accepts SELECT');
          return [];
        },
      }),
    };

    const conversion = await getSalesConversionSql(scopedDb);

    expect(seenSql.length).toBeGreaterThan(0);
    expect(seenSql.every(sql => /^SELECT\b/i.test(sql))).toBe(true);
    expect(conversion.largeFactor).toContain('si.large_to_medium');
    expect(conversion.smallFactor).toContain('si.medium_to_small');
  });

  it('counts a historical tablet sale as small after the current custom small-unit name changes', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY,
        reorder_point REAL,
        min_limit REAL,
        has_expiry INTEGER,
        large_to_medium REAL,
        medium_to_small REAL,
        medium_unit TEXT,
        small_unit TEXT
      );
      CREATE TABLE inventory (
        drug_id INTEGER,
        pharmacy_id TEXT,
        quantity REAL,
        expiry_date TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        status TEXT,
        created_at TEXT
      );
      CREATE TABLE sales_items (
        invoice_id TEXT,
        drug_id INTEGER,
        quantity_sold REAL,
        unit TEXT,
        is_negative INTEGER,
        large_to_medium REAL,
        medium_to_small REAL
      );
      INSERT INTO master_drugs VALUES (1, 0, 0, 1, 10, 10, 'custom-medium', 'custom-small');
      INSERT INTO sales_invoices VALUES ('historical', NULL, 'completed', CURRENT_TIMESTAMP);
      INSERT INTO sales_items VALUES ('historical', 1, 100, 'Tablet', 0, 10, 10);
      INSERT INTO sales_items VALUES ('historical', 1, 100, 'custom-small', 0, 10, 10);
    `);

    try {
      const state = await getEffectiveReorderState(createSqliteTransactionDb(sqlite), 1, null, 0);
      expect(state).toEqual({ currentStock: 0, reorderThreshold: 2 });
    } finally {
      sqlite.close();
    }
  });

  it('keeps configured custom unit sales, live expiry stock and tenant shortages in sync', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, reorder_point REAL, min_limit REAL, has_expiry INTEGER,
        large_to_medium REAL, medium_to_small REAL, medium_unit TEXT, small_unit TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL,
        expiry_date TEXT, cost_price REAL
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT, created_at TEXT
      );
      CREATE TABLE sales_items (
        invoice_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT,
        is_negative INTEGER, large_to_medium REAL, medium_to_small REAL
      );
      CREATE TABLE shortages (
        id INTEGER PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, status TEXT
      );
      INSERT INTO master_drugs VALUES (1, 0, 0, 1, 12, 5, 'Blister', 'Ampoule');
      INSERT INTO inventory VALUES
        ('available-A', 1, 'A', 0.25, '2032-01-01', 4),
        ('expired-A', 1, 'A', 8, '2020-01-01', 4),
        ('foreign-B', 1, 'B', 6, '2032-01-01', 9);
      INSERT INTO sales_invoices VALUES ('sale-A', 'A', 'completed', CURRENT_TIMESTAMP);
      INSERT INTO sales_items VALUES
        ('sale-A', 1, 6, ' BLiSTEr ', 0, 12, 5),
        ('sale-A', 1, 3, ' aMpOuLe ', 0, 12, 5);
      INSERT INTO shortages VALUES (1, 1, 'A', 'pending'), (2, 1, 'B', 'ordered');
    `);
    const scopedDb = createSqliteTransactionDb(sqlite);
    try {
      // Native Rust unit_quantity_in_large trims and case-folds custom names.
      const expectedUsage = unitQuantityInLarge(6, ' BLiSTEr ', 12, 5, 'Blister', 'Ampoule')
        + unitQuantityInLarge(3, ' aMpOuLe ', 12, 5, 'Blister', 'Ampoule');
      expect(expectedUsage).toBeCloseTo(0.55);
      const before = await getEffectiveReorderState(scopedDb, 1, 'A', 0);
      expect(before?.reorderThreshold).toBeCloseTo(expectedUsage);
      expect(before?.currentStock).toBeCloseTo(0.25);
      expect(await resolveRecoveredShortages(scopedDb, 1, 'A', 0)).toBe(false);

      // Exercise the real recovery query inside an in-memory stock posting
      // transaction. A failed shortage write must roll back the stock change.
      sqlite.exec(`
        CREATE TRIGGER reject_recovery BEFORE UPDATE ON shortages
        BEGIN SELECT RAISE(ABORT, 'synthetic shortage write failure'); END;
        BEGIN IMMEDIATE;
      `);
      sqlite.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(0.75, 'available-A');
      const posted = await getEffectiveReorderState(scopedDb, 1, 'A', 0);
      expect(posted?.currentStock).toBeCloseTo(0.75);
      expect(posted?.reorderThreshold).toBeCloseTo(expectedUsage);
      expect(await hasRecoveredStock(scopedDb, 1, 'A', 0)).toBe(true);
      const attempt = await resolveRecoveredShortages(scopedDb, 1, 'A', 0).then(
        result => ({ result, shortage: sqlite.prepare('SELECT * FROM shortages WHERE id = 1').get() }),
        error => ({ error: String(error) }),
      );
      expect(attempt).toMatchObject({ error: expect.stringContaining('synthetic shortage write failure') });
      sqlite.exec('ROLLBACK');
      expect((await getEffectiveReorderState(scopedDb, 1, 'A', 0))?.currentStock).toBeCloseTo(0.25);
      expect(sqlite.prepare('SELECT status FROM shortages WHERE id = 1').get()).toEqual({ status: 'pending' });

      sqlite.exec('DROP TRIGGER reject_recovery; BEGIN IMMEDIATE;');
      sqlite.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(0.75, 'available-A');
      // Synthetic received/adjusted balance: the expired batch is still
      // inventoried but is unavailable to the live reorder calculation.
      expect((await getEffectiveReorderState(scopedDb, 1, 'A', 0))?.currentStock).toBeCloseTo(0.75);
      expect(await resolveRecoveredShortages(scopedDb, 1, 'A', 0)).toBe(true);
      sqlite.exec('COMMIT');
      expect(await resolveRecoveredShortages(scopedDb, 1, 'A', 0)).toBe(true);
      expect(sqlite.prepare('SELECT id, status FROM shortages ORDER BY id').all()).toEqual([
        { id: 1, status: 'received' },
        { id: 2, status: 'ordered' },
      ]);
      expect(sqlite.prepare(
        "SELECT SUM(quantity * cost_price) AS value FROM inventory WHERE pharmacy_id = 'A' AND expiry_date >= date('now')",
      ).get()).toEqual({ value: 3 });
    } finally {
      sqlite.close();
    }
  });
});
