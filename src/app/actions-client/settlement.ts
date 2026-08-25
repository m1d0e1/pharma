import { dbSelect } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isTauri } from '@/lib/env';

const SETTLEMENT_PERMISSION = 'can_view_settlement';

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

export async function getNegativeStockInvoicesAction() {
  try {
    const context = await getSettlementContext();
    if (!context) return { success: false, error: 'Unauthorized' };

    const items = await dbSelect(
      `
        WITH approved_returns AS (
          SELECT ri.sale_item_id, r.invoice_id,
                 SUM(CAST(ri.quantity_returned AS REAL)) AS returned_quantity
          FROM return_items ri
          JOIN returns r ON r.id = ri.return_id
          WHERE LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
          GROUP BY ri.sale_item_id, r.invoice_id
        )
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
        WITH approved_returns AS (
          SELECT ri.sale_item_id, r.invoice_id,
                 SUM(CAST(ri.quantity_returned AS REAL)) AS returned_quantity
          FROM return_items ri
          JOIN returns r ON r.id = ri.return_id
          WHERE LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
          GROUP BY ri.sale_item_id, r.invoice_id
        )
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
            WHERE i.drug_id = si.drug_id
              AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
              AND i.quantity > 0
              AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
          ) AS current_stock_balance
        FROM sales_items si
        LEFT JOIN master_drugs md ON md.id = si.drug_id
        JOIN sales_invoices s ON s.id = si.invoice_id
        LEFT JOIN approved_returns ar
          ON ar.sale_item_id = si.id AND ar.invoice_id = si.invoice_id
        WHERE si.is_negative = 1
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
          id,
          id AS inventory_id,
          batch_number,
          expiry_date,
          quantity,
          cost_price
        FROM inventory
        WHERE drug_id = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          AND quantity > 0
          AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
        ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
                 expiry_date ASC,
                 created_at ASC
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

    return { success: true, data };
  } catch (error) {
    return { success: false, error: errorMessage(error, 'Failed to settle sale item') };
  }
}
