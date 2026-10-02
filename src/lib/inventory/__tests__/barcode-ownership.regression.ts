import Database from 'better-sqlite3';
import {
  assertBarcodeOwnershipAvailable,
  normalizeBarcode,
} from '@/lib/inventory/barcode-ownership';

function adapter(db: Database.Database) {
  return {
    select: async <T = any>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...params as any[]) as T[],
  };
}

describe('shared barcode ownership policy', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY,
        barcode TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        drug_id INTEGER NOT NULL,
        barcode TEXT,
        quantity REAL
      );
    `);
  });

  afterEach(() => db.close());

  it('normalizes whitespace without changing the stored barcode text', () => {
    expect(normalizeBarcode('  AbC-123  ')).toBe('AbC-123');
    expect(normalizeBarcode('   ')).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
  });

  it('allows the same drug to own the same barcode in master and positive inventory', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, barcode) VALUES (1, 'CODE-1');
      INSERT INTO inventory (id, drug_id, barcode, quantity) VALUES ('lot-1', 1, 'code-1', 4);
    `);

    await expect(assertBarcodeOwnershipAvailable(
      adapter(db),
      [{ drugId: 1, barcode: ' CODE-1 ' }],
    )).resolves.toBeUndefined();
  });

  it('rejects a barcode owned by another master drug or positive inventory lot', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, barcode) VALUES (2, 'MASTER-CODE');
      INSERT INTO inventory (id, drug_id, barcode, quantity) VALUES ('lot-3', 3, 'LOT-CODE', 2);
    `);

    await expect(assertBarcodeOwnershipAvailable(
      adapter(db),
      [{ drugId: 1, barcode: 'master-code' }],
    )).rejects.toThrow(/another drug/i);
    await expect(assertBarcodeOwnershipAvailable(
      adapter(db),
      [{ drugId: 1, barcode: 'lot-code' }],
    )).rejects.toThrow(/another drug/i);
  });

  it('ignores zero-quantity historical barcode aliases', async () => {
    db.exec(`
      INSERT INTO inventory (id, drug_id, barcode, quantity) VALUES ('old-empty-lot', 2, 'OLD-CODE', 0);
    `);

    await expect(assertBarcodeOwnershipAvailable(
      adapter(db),
      [{ drugId: 1, barcode: 'old-code' }],
    )).resolves.toBeUndefined();
  });

  it('rejects two requested drugs claiming the same normalized barcode before querying writes', async () => {
    await expect(assertBarcodeOwnershipAvailable(
      adapter(db),
      [
        { drugId: 10, barcode: ' SHARED ' },
        { drugId: 11, barcode: 'shared' },
      ],
    )).rejects.toThrow(/another drug/i);
  });

  it('treats a new drug without an assigned id as conflicting with any existing owner', async () => {
    db.exec(`INSERT INTO master_drugs (id, barcode) VALUES (7, 'EXISTING');`);

    await expect(assertBarcodeOwnershipAvailable(
      adapter(db),
      [{ barcode: 'existing' }],
    )).rejects.toThrow(/another drug/i);
  });
});
