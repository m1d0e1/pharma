import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';
import { isTauri } from '@/lib/env';

export async function findDrugBarcodeConflict(barcode: string, targetId?: number) {
  if (!barcode.trim()) return null;
  const user = await getLocalSession();
  if (!user || (!hasUserPermissionSync(user, 'can_manage_inventory') && !hasUserPermissionSync(user, 'can_view_purchases'))) return null;
  // Empty batches retain history, but do not reserve a barcode. Unknown/negative balances still require review.
  return dbGet(`SELECT m.id,m.trade_name,m.trade_name_en,m.barcode,m.large_to_medium,m.official_price
    FROM master_drugs m WHERE m.id != ? AND (TRIM(m.barcode)=? COLLATE NOCASE
      OR EXISTS(SELECT 1 FROM inventory i WHERE i.drug_id=m.id AND (i.quantity IS NULL OR i.quantity != 0) AND TRIM(i.barcode)=? COLLATE NOCASE))
    ORDER BY m.id LIMIT 1`, [targetId || -1, barcode.trim(), barcode.trim()]);
}

export async function replaceDrugAction(sourceId: number, targetId: number | null, newDrug: any, password: string, edits?: Record<string, unknown>) {
  try {
    const user = await getLocalSession();
    if (!user || !['owner', 'admin'].includes(user.role)) return { success: false, error: 'يلزم تسجيل الدخول بحساب مدير أو مالك لإجراء الاستبدال' };
    if (!isTauri) return { success: false, error: 'الاستبدال الآمن متاح في تطبيق سطح المكتب فقط' };
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ id: number; backup_path: string }>('replace_master_drug', {
      userId: user.id, password,
      payload: { source_id: sourceId, target_id: targetId, new_drug: newDrug, edits: edits || null, confirmed_same_product: true },
    });
    // A committed replacement must not be reported as failed just because cache refresh failed.
    try { await secureCache.reload(); } catch (error) { console.warn('Reload catalog after replacement', error); }
    window.dispatchEvent(new Event('inventory-alerts-refresh'));
    return { success: true, id: result.id, backupPath: result.backup_path };
  } catch (error: any) { return { success: false, error: String(error?.message || error) }; }
}

export async function getReplacementDrug(id: number) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_manage_inventory') && !hasUserPermissionSync(user, 'can_view_purchases'))) return null;
    const rows = await dbSelect(`SELECT m.*,
      (SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE drug_id=m.id) AS stock_quantity,
      (SELECT GROUP_CONCAT(DISTINCT barcode) FROM inventory WHERE drug_id=m.id AND TRIM(COALESCE(barcode,''))!='') AS inventory_barcodes
      FROM master_drugs m WHERE id=?`, [id]);
    return rows[0] || null;
  } catch (error) {
    // Replacement already committed: callers must recover without suggesting it failed.
    console.warn('Read replacement catalog record', error);
    return null;
  }
}
