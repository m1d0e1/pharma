import { dbTransaction, type TransactionDb } from '@/lib/db/tauri';

const LEGACY_PHARMACY_ID = 'placeholder-id';
const DEFAULT_PHARMACY_ID = 'local_default';
const DUMMY_DRUG_ID = 100001;
const COLLIDING_BARCODE = '6221025003843';
const DUMMY_BARCODE = 'TEMP-100001';

export interface OrphanedInventoryItem {
  id: string;
  drug_id: number;
  trade_name: string;
  quantity: number;
  barcode: string | null;
}

export interface LegacyPharmacyScopeMigrationResult {
  affectedItems: OrphanedInventoryItem[];
  migratedRows: number;
  barcodeRowsUpdated: number;
  changed: boolean;
}

async function migrateWithDb(db: Pick<TransactionDb, 'prepare'>): Promise<LegacyPharmacyScopeMigrationResult> {
  const affectedItems = await db.prepare(`
    SELECT
      i.id,
      i.drug_id,
      COALESCE(NULLIF(m.trade_name, ''), NULLIF(m.trade_name_en, ''), 'صنف #' || i.drug_id) AS trade_name,
      i.quantity,
      NULLIF(TRIM(i.barcode), '') AS barcode
    FROM inventory i
    LEFT JOIN master_drugs m ON m.id = i.drug_id
    WHERE (i.pharmacy_id = ? OR i.pharmacy_id IS NULL)
      AND i.quantity > 0
    ORDER BY i.drug_id, i.id
  `).all(LEGACY_PHARMACY_ID) as OrphanedInventoryItem[];

  const scopeUpdate = await db.prepare(`
    UPDATE inventory
    SET pharmacy_id = ?
    WHERE pharmacy_id = ? OR pharmacy_id IS NULL
  `).run(DEFAULT_PHARMACY_ID, LEGACY_PHARMACY_ID);

  // The ID alone is not identity: other installations can use it for a real drug.
  // Repair only an empty, untraded placeholder with no meaningful alternative name.
  const unusedDummy = await db.prepare(`
    SELECT m.id, m.trade_name, m.trade_name_en
    FROM master_drugs m
    WHERE m.id = ?
      AND (
        TRIM(COALESCE(m.barcode, '')) = ?
        OR EXISTS (
          SELECT 1
          FROM inventory i
          WHERE i.drug_id = m.id
            AND TRIM(COALESCE(i.barcode, '')) = ?
        )
      )
      AND NOT EXISTS (SELECT 1 FROM sales_items si WHERE si.drug_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM purchase_invoice_items pii WHERE pii.drug_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.drug_id = m.id AND COALESCE(i.quantity, 0) != 0)
      AND NOT EXISTS (SELECT 1 FROM master_drugs other WHERE other.id != m.id AND TRIM(other.barcode) = ? COLLATE NOCASE)
      AND NOT EXISTS (SELECT 1 FROM inventory other WHERE other.drug_id != m.id AND TRIM(other.barcode) = ? COLLATE NOCASE)
    LIMIT 1
  `).get(DUMMY_DRUG_ID, COLLIDING_BARCODE, COLLIDING_BARCODE, DUMMY_BARCODE, DUMMY_BARCODE) as { id: number; trade_name: string | null; trade_name_en: string | null } | null;

  let barcodeRowsUpdated = 0;
  const names = [unusedDummy?.trade_name, unusedDummy?.trade_name_en].map(name => (name || '').trim()).filter(Boolean);
  if (unusedDummy && names.length > 0 && names.every(name => /^drug\s*#?\s*100001$/i.test(name))) {
    const masterUpdate = await db.prepare(`
      UPDATE master_drugs
      SET barcode = ?
      WHERE id = ? AND TRIM(COALESCE(barcode, '')) = ?
    `).run(DUMMY_BARCODE, DUMMY_DRUG_ID, COLLIDING_BARCODE);
    const inventoryUpdate = await db.prepare(`
      UPDATE inventory
      SET barcode = ?
      WHERE drug_id = ? AND TRIM(COALESCE(barcode, '')) = ?
    `).run(DUMMY_BARCODE, DUMMY_DRUG_ID, COLLIDING_BARCODE);
    barcodeRowsUpdated = masterUpdate.changes + inventoryUpdate.changes;
  }

  const migratedRows = scopeUpdate.changes;
  return {
    affectedItems,
    migratedRows,
    barcodeRowsUpdated,
    changed: migratedRows > 0 || barcodeRowsUpdated > 0,
  };
}

export async function migrateLegacyPlaceholderInventoryScope(): Promise<LegacyPharmacyScopeMigrationResult> {
  return dbTransaction(async transactionDb => migrateWithDb(transactionDb));
}
