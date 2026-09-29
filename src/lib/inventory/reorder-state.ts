import type { TransactionDb } from '@/lib/db/tauri';

type ReorderDb = Pick<TransactionDb, 'prepare'>;

export const DEFAULT_REORDER_LIMIT = 10;

export async function getSalesConversionSql(scopedDb: ReorderDb) {
  const hasColumn = async (column: 'large_to_medium' | 'medium_to_small') => {
    try {
      await scopedDb.prepare(`SELECT ${column} FROM sales_items LIMIT 0`).all();
      return true;
    } catch {
      return false;
    }
  };
  const hasLargeSnapshot = await hasColumn('large_to_medium');
  const hasSmallSnapshot = await hasColumn('medium_to_small');
  const largeSnapshot = hasLargeSnapshot
    ? 'NULLIF(si.large_to_medium, 0), '
    : '';
  const smallSnapshot = hasSmallSnapshot
    ? 'NULLIF(si.medium_to_small, 0), '
    : '';

  return {
    largeFactor: `COALESCE(${largeSnapshot}NULLIF(sales_drug.large_to_medium, 0), 1)`,
    smallFactor: `COALESCE(${smallSnapshot}NULLIF(sales_drug.medium_to_small, 0), 1)`,
  };
}

export async function getEffectiveReorderState(
  scopedDb: ReorderDb,
  drugId: number | string,
  pharmacyId: string | null | undefined,
  defaultLimit = DEFAULT_REORDER_LIMIT,
) {
  const pharmacyScope = String(pharmacyId || 'local_default');
  const conversion = await getSalesConversionSql(scopedDb);
  const row = await scopedDb.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(i.quantity)
        FROM inventory i
        WHERE i.drug_id = md.id
          AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
          AND i.quantity > 0
          AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
      ), 0) AS current_stock,
      MAX(
        COALESCE(NULLIF(md.reorder_point, 0), NULLIF(md.min_limit, 0), ?),
        COALESCE((
          SELECT SUM(
            CASE
              WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = sales_drug.medium_unit
                THEN si.quantity_sold / ${conversion.largeFactor}
              WHEN si.unit = 'small' OR si.unit = sales_drug.small_unit
                THEN si.quantity_sold / (
                  ${conversion.largeFactor}
                  * ${conversion.smallFactor}
                )
              ELSE si.quantity_sold
            END
          )
          FROM sales_items si
          JOIN sales_invoices inv ON inv.id = si.invoice_id
          JOIN master_drugs sales_drug ON sales_drug.id = si.drug_id
          WHERE si.drug_id = md.id
            AND si.is_negative = 0
            AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
            AND (inv.pharmacy_id = ? OR (inv.pharmacy_id IS NULL AND ? = 'local_default'))
            AND inv.created_at >= datetime('now', '-30 days')
        ), 0)
      ) AS reorder_threshold
    FROM master_drugs md
    WHERE md.id = ?
  `).get(
    pharmacyScope,
    pharmacyScope,
    defaultLimit,
    pharmacyScope,
    pharmacyScope,
    drugId,
  ) as any;

  if (!row) return null;
  return {
    currentStock: Number(row.current_stock || 0),
    reorderThreshold: Number(row.reorder_threshold || 0),
  };
}

export async function hasRecoveredStock(
  scopedDb: ReorderDb,
  drugId: number | string,
  pharmacyId: string | null | undefined,
  defaultLimit = DEFAULT_REORDER_LIMIT,
): Promise<boolean> {
  const state = await getEffectiveReorderState(scopedDb, drugId, pharmacyId, defaultLimit);
  return !!state && state.currentStock > state.reorderThreshold;
}

export async function resolveRecoveredShortages(
  scopedDb: ReorderDb,
  drugId: number | string,
  pharmacyId: string | null | undefined,
  defaultLimit = DEFAULT_REORDER_LIMIT,
): Promise<boolean> {
  const pharmacyScope = String(pharmacyId || 'local_default');
  if (!await hasRecoveredStock(scopedDb, drugId, pharmacyScope, defaultLimit)) return false;

  await scopedDb.prepare(`
    UPDATE shortages
    SET status = 'received'
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND (status IN ('pending', 'ordered') OR status IS NULL OR status = '')
  `).run(drugId, pharmacyScope, pharmacyScope);
  return true;
}
