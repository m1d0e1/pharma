import { dbSelect } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isTauri } from '@/lib/env';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';

const SETTLEMENT_PERMISSION = 'can_view_settlement';
const SETTLEMENT_MUTATION_PERMISSION = 'can_manage_inventory';

async function getSettlementContext() {
  const user = await getLocalSession();
  if (!user || !hasUserPermissionSync(user, SETTLEMENT_PERMISSION)) return null;
  return {
    user,
    pharmacyId: String(user.pharmacy_id || 'local_default'),
  };
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

const APPROVED_RETURNS_CTES = `
  approved_return_rows AS (
    SELECT
      ri.sale_item_id,
      r.invoice_id,
      CAST(ri.quantity_returned AS REAL) AS quantity_returned,
      CASE
        WHEN ri.unit IS NULL OR TRIM(ri.unit) = '' THEN COALESCE(NULLIF(TRIM(si.unit), ''), 'large')
        ELSE ri.unit
      END AS return_unit,
      COALESCE(NULLIF(TRIM(si.unit), ''), 'large') AS sold_unit,
      MAX(COALESCE(NULLIF(CAST(si.large_to_medium AS REAL), 0), 1), 1) AS large_to_medium,
      MAX(COALESCE(NULLIF(CAST(si.medium_to_small AS REAL), 0), 1), 1) AS medium_to_small,
      md.medium_unit,
      md.small_unit
    FROM return_items ri
    JOIN returns r ON r.id = ri.return_id
    JOIN sales_items si ON si.id = ri.sale_item_id AND si.invoice_id = r.invoice_id
    LEFT JOIN master_drugs md ON md.id = si.drug_id
    WHERE LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
  ),
  approved_returns AS (
    SELECT
      sale_item_id,
      invoice_id,
      SUM(
        (
          CASE
            WHEN LOWER(TRIM(return_unit)) IN ('medium', 'strip', 'شريط')
              OR (
                TRIM(COALESCE(medium_unit, '')) <> ''
                AND LOWER(TRIM(return_unit)) = LOWER(TRIM(medium_unit))
              )
            THEN quantity_returned / large_to_medium
            WHEN LOWER(TRIM(return_unit)) IN ('small', 'unit', 'pill')
              OR (
                TRIM(COALESCE(small_unit, '')) <> ''
                AND LOWER(TRIM(return_unit)) = LOWER(TRIM(small_unit))
              )
            THEN quantity_returned / (large_to_medium * medium_to_small)
            ELSE quantity_returned
          END
        ) * (
          CASE
            WHEN LOWER(TRIM(sold_unit)) IN ('medium', 'strip', 'شريط')
              OR (
                TRIM(COALESCE(medium_unit, '')) <> ''
                AND LOWER(TRIM(sold_unit)) = LOWER(TRIM(medium_unit))
              )
            THEN large_to_medium
            WHEN LOWER(TRIM(sold_unit)) IN ('small', 'unit', 'pill')
              OR (
                TRIM(COALESCE(small_unit, '')) <> ''
                AND LOWER(TRIM(sold_unit)) = LOWER(TRIM(small_unit))
              )
            THEN large_to_medium * medium_to_small
            ELSE 1
          END
        )
      ) AS returned_quantity
    FROM approved_return_rows
    GROUP BY sale_item_id, invoice_id
  )
`;

export async function getNegativeStockInvoicesAction() {
  try {
    const context = await getSettlementContext();
    if (!context) return { success: false, error: 'Unauthorized' };

    const items = await dbSelect(
      `
        WITH ${APPROVED_RETURNS_CTES}
        SELECT
          si.id,
          si.id AS item_id,
          si.invoice_id,
          si.drug_id,
          si.quantity_sold,
          CAST(COALESCE(ar.returned_quantity, 0) AS REAL) AS returned_quantity,
          MAX(
            CAST(si.quantity_sold AS REAL) - CAST(COALESCE(ar.returned_quantity, 0) AS REAL),
            0
          ) AS net_unreturned_quantity,
          si.unit,
          si.unit_price,
          md.trade_name,
          md.trade_name_en,
          md.barcode,
          s.created_at AS invoice_date
        FROM sales_items si
        LEFT JOIN master_drugs md ON md.id = si.drug_id
        JOIN sales_invoices s ON s.id = si.invoice_id
        LEFT JOIN approved_returns ar
          ON ar.sale_item_id = si.id AND ar.invoice_id = si.invoice_id
        WHERE si.is_negative = 1
          AND (s.status IS NULL OR s.status = '' OR LOWER(s.status) IN ('completed', 'approved', 'delivered'))
          AND (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
        ORDER BY s.created_at DESC
      `,
      [context.pharmacyId, context.pharmacyId],
    );

    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to fetch unsettled items') };
  }
}

/**
 * Legacy entry point retained so stale callers cannot perform the old unsafe,
 * cost-only settlement. Settlement now requires selecting a validated batch.
 */
export async function settleNegativeStockAction(_itemId: number, _costPrice: number) {
  const context = await getSettlementContext();
  if (!context) return { success: false, error: 'Unauthorized' };
  return {
    success: false,
    error: 'Select an inventory batch from the sales settlement screen.',
  };
}

export async function getUnsettledSalesAction() {
  try {
    const context = await getSettlementContext();
    if (!context) return { success: false, error: 'Unauthorized' };

    const items = await dbSelect(
      `
        WITH ${APPROVED_RETURNS_CTES}
        SELECT
          si.id AS item_id,
          si.invoice_id,
          si.quantity_sold,
          CAST(COALESCE(ar.returned_quantity, 0) AS REAL) AS returned_quantity,
          MAX(
            CAST(si.quantity_sold AS REAL) - CAST(COALESCE(ar.returned_quantity, 0) AS REAL),
            0
          ) AS net_unreturned_quantity,
          si.unit,
          si.unit_price,
          md.trade_name,
          md.trade_name_en,
          md.id AS drug_id,
          s.created_at AS sale_date,
          s.created_at AS created_at,
          (
            SELECT COALESCE(SUM(i.quantity), 0)
            FROM inventory i
            JOIN master_drugs stock_md ON stock_md.id = i.drug_id
            WHERE i.drug_id = si.drug_id
              AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
              AND i.quantity > 0
              AND COALESCE(i.batch_number, '') NOT LIKE 'RET-%'
              AND (COALESCE(stock_md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
              AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
          ) AS current_stock_balance
        FROM sales_items si
        LEFT JOIN master_drugs md ON md.id = si.drug_id
        JOIN sales_invoices s ON s.id = si.invoice_id
        LEFT JOIN approved_returns ar
          ON ar.sale_item_id = si.id AND ar.invoice_id = si.invoice_id
        WHERE si.is_negative = 1
          AND (s.status IS NULL OR s.status = '' OR LOWER(s.status) IN ('completed', 'approved', 'delivered'))
          AND (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
        ORDER BY s.created_at DESC
      `,
      [
        context.pharmacyId,
        context.pharmacyId,
        context.pharmacyId,
        context.pharmacyId,
      ],
    );

    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to fetch unsettled items') };
  }
}

export async function getDrugBatchesAction(drugId: number) {
  try {
    const context = await getSettlementContext();
    if (!context) return { success: false, error: 'Unauthorized' };

    const normalizedDrugId = Number(drugId);
    if (!Number.isSafeInteger(normalizedDrugId) || normalizedDrugId <= 0) {
      return { success: false, error: 'Invalid drug' };
    }

    const batches = await dbSelect(
      `
        SELECT
          i.id,
          i.id AS inventory_id,
          i.batch_number,
          i.expiry_date,
          i.quantity,
          i.cost_price
        FROM inventory i
        JOIN master_drugs md ON md.id = i.drug_id
        WHERE i.drug_id = ?
          AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
          AND i.quantity > 0
          AND COALESCE(i.batch_number, '') NOT LIKE 'RET-%'
          AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
          AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
        ORDER BY CASE WHEN i.expiry_date IS NULL THEN 1 ELSE 0 END,
                 i.expiry_date ASC,
                 i.created_at ASC
      `,
      [normalizedDrugId, context.pharmacyId, context.pharmacyId],
    );

    return { success: true, data: batches };
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to fetch batches') };
  }
}

export async function settleSaleItemAction(itemId: number, inventoryId: string) {
  try {
    const context = await getSettlementContext();
    if (!context) return { success: false, error: 'Unauthorized' };
    if (!hasUserPermissionSync(context.user, SETTLEMENT_MUTATION_PERMISSION)) {
      return { success: false, error: 'Unauthorized: inventory management permission required' };
    }
    if (!isTauri) {
      return { success: false, error: 'Settlement is available in the desktop app only.' };
    }

    const saleItemId = Number(itemId);
    const selectedInventoryId = String(inventoryId || '').trim();
    if (!Number.isSafeInteger(saleItemId) || saleItemId <= 0 || !selectedInventoryId) {
      return { success: false, error: 'Invalid settlement selection' };
    }

    const { invoke } = await import('@tauri-apps/api/core');
    const data = await invoke('settle_negative_sale_item_critical', {
      payload: {
        sale_item_id: saleItemId,
        inventory_id: selectedInventoryId,
        pharmacy_id: context.pharmacyId,
        user_id: String(context.user.id),
      },
    });

    notifyInventoryChanged();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to settle sale item') };
  }
}
