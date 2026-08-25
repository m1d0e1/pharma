import Database from 'better-sqlite3';

let sqlite: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => callback()),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner' })),
}));

jest.unmock('@/app/actions-client/interactions');

import { checkDrugInteractions } from '@/app/actions-client/interactions';

describe('POS interaction safety', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE drug_interactions (
        id INTEGER PRIMARY KEY,
        ingredient_a TEXT,
        ingredient_b TEXT,
        severity TEXT,
        description_en TEXT,
        description_ar TEXT,
        recommendation TEXT
      );
      CREATE TABLE patient_allergies (
        id INTEGER PRIMARY KEY,
        patient_id TEXT,
        allergen TEXT,
        severity TEXT
      );
      CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, active_ingredient TEXT);
      CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER);
      CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, created_at TEXT);
      CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER);

      INSERT INTO drug_interactions VALUES
        (1, 'Deferasirox', 'Ambroxol', 'moderate', 'interaction', NULL, NULL);
      INSERT INTO master_drugs VALUES (1, 'Ambroxol');
      INSERT INTO inventory VALUES ('old-lot', 1);
      INSERT INTO sales_invoices VALUES ('old-sale', 'patient-1', datetime('now'));
      INSERT INTO sales_items VALUES (1, 'old-sale', 'old-lot', 1);
    `);
  });

  afterEach(() => sqlite.close());

  it('does not treat a previous sale as a medicine the patient is still taking', async () => {
    const result = await checkDrugInteractions(['Deferasirox'], 'patient-1');

    expect(result).toMatchObject({
      success: true,
      data: { interactions: [], allergies: [], hasCritical: false, hasMajor: false },
    });
  });

  it('still reports a genuine interaction between two current cart medicines', async () => {
    const result = await checkDrugInteractions(['Deferasirox', 'Ambroxol'], 'patient-1');

    expect(result.success).toBe(true);
    expect(result.data?.interactions).toHaveLength(1);
    expect(result.data?.interactions[0]).toMatchObject({
      ingredient_a: 'Deferasirox',
      ingredient_b: 'Ambroxol',
      severity: 'moderate',
    });
  });
});
