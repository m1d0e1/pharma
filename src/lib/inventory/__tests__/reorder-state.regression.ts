/** @jest-environment node */

import Database from 'better-sqlite3';
import { createSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';
import { getEffectiveReorderState, getSalesConversionSql } from '@/lib/inventory/reorder-state';

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
});
