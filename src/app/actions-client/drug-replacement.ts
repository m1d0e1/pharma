import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';
import { isTauri } from '@/lib/env';
import { notifyDrugIdentityChanged } from '@/lib/inventory/refresh';

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

export async function findDrugBarcodeOwners(barcode: string) {
  const code = barcode.trim();
  if (!code) return [];
  const user = await getLocalSession();
  if (!user || (!hasUserPermissionSync(user, 'can_manage_inventory') && !hasUserPermissionSync(user, 'can_view_purchases'))) return [];
  return dbSelect(`SELECT m.*,
      (SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE drug_id=m.id) AS stock_quantity,
      (SELECT GROUP_CONCAT(DISTINCT barcode) FROM inventory WHERE drug_id=m.id AND TRIM(COALESCE(barcode,''))!='') AS inventory_barcodes
    FROM master_drugs m
    WHERE TRIM(COALESCE(m.barcode,''))=? COLLATE NOCASE
       OR EXISTS(
         SELECT 1 FROM inventory i
         WHERE i.drug_id=m.id
           AND (i.quantity IS NULL OR i.quantity != 0)
           AND TRIM(COALESCE(i.barcode,''))=? COLLATE NOCASE
       )
    ORDER BY m.id`, [code, code]);
}

export async function getDuplicateDrugBarcodeGroupsAction() {
  const user = await getLocalSession();
  if (!user || (!hasUserPermissionSync(user, 'can_manage_inventory') && !hasUserPermissionSync(user, 'can_view_purchases'))) return [];
  const rows = await dbSelect(`WITH owners AS (
      SELECT LOWER(TRIM(barcode)) AS barcode, id AS drug_id
      FROM master_drugs
      WHERE TRIM(COALESCE(barcode,''))!=''
      UNION
      SELECT LOWER(TRIM(barcode)) AS barcode, drug_id
      FROM inventory
      WHERE TRIM(COALESCE(barcode,''))!='' AND (quantity IS NULL OR quantity != 0)
    ), grouped AS (
      SELECT barcode, COUNT(DISTINCT drug_id) AS owner_count
      FROM owners
      GROUP BY barcode
      HAVING COUNT(DISTINCT drug_id) > 1
    )
    SELECT g.barcode,g.owner_count,
           GROUP_CONCAT(o.drug_id) AS owner_ids,
           GROUP_CONCAT(COALESCE(m.trade_name_en,m.trade_name,'#'||o.drug_id),' | ') AS names
    FROM grouped g
    JOIN owners o ON o.barcode=g.barcode
    LEFT JOIN master_drugs m ON m.id=o.drug_id
    GROUP BY g.barcode,g.owner_count
    ORDER BY g.owner_count DESC,g.barcode`, []);
  return rows.map((row: any) => ({
    ...row,
    owner_count: Number(row.owner_count || 0),
    owner_ids: String(row.owner_ids || '').split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    owner_names: String(row.names || '').split(' | ').filter(Boolean),
  }));
}

export async function replaceDrugAction(sourceId: number, targetId: number | null, newDrug: any, password: string, edits?: Record<string, unknown>) {
  try {
    const user = await getLocalSession();
    if (!user || !['owner', 'admin'].includes(user.role) || !hasUserPermissionSync(user, 'can_manage_inventory')) {
      return { success: false, error: 'يلزم حساب مدير أو مالك لديه صلاحية إدارة المخزون لإجراء الاستبدال' };
    }
    if (!isTauri) return { success: false, error: 'الاستبدال الآمن متاح في تطبيق سطح المكتب فقط' };
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ id: number; backup_path: string }>('replace_master_drug', {
      userId: user.id, password,
      payload: { source_id: sourceId, target_id: targetId, new_drug: newDrug, edits: edits || null, confirmed_same_product: true },
    });
    // A committed replacement must not be reported as failed just because cache refresh failed.
    try { await secureCache.reload(); } catch (error) { console.warn('Reload catalog after replacement', error); }
    notifyDrugIdentityChanged({ sourceIds: [sourceId], targetId: result.id });
    return { success: true, id: result.id, backupPath: result.backup_path };
  } catch (error: any) { return { success: false, error: String(error?.message || error) }; }
}

export async function reconcileDrugBarcodeOwnersAction(sourceIds: number[], targetId: number, password: string, edits?: Record<string, unknown>) {
  try {
    const user = await getLocalSession();
    if (!user || !['owner', 'admin'].includes(user.role) || !hasUserPermissionSync(user, 'can_manage_inventory')) {
      return { success: false, error: 'يلزم حساب مدير أو مالك لديه صلاحية إدارة المخزون لإجراء الدمج' };
    }
    if (!isTauri) return { success: false, error: 'الدمج الآمن متاح في تطبيق سطح المكتب فقط' };
    const sources = [...new Set(sourceIds.map(Number))].filter(id => Number.isInteger(id) && id > 0);
    const target = Number(targetId);
    if (!Number.isInteger(target) || target <= 0 || sources.length === 0 || sources.includes(target)) {
      return { success: false, error: 'اختر صنفاً نهائياً واحداً وكل الأصناف المطابقة المطلوب دمجها' };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ id: number; backup_path: string }>('reconcile_master_drug_group', {
      userId: user.id,
      password,
      payload: { source_ids: sources, target_id: target, edits: edits || null, confirmed_same_product: true },
    });
    try { await secureCache.reload(); } catch (error) { console.warn('Reload catalog after group reconciliation', error); }
    notifyDrugIdentityChanged({ sourceIds: sources, targetId: result.id });
    return { success: true, id: result.id, backupPath: result.backup_path };
  } catch (error: any) {
    return { success: false, error: String(error?.message || error) };
  }
}

export async function correctDrugBarcodeConflictAction(drugId: number, conflictingBarcode: string, replacementBarcode: string, password: string) {
  try {
    const user = await getLocalSession();
    if (!user || !['owner', 'admin'].includes(user.role) || !hasUserPermissionSync(user, 'can_manage_inventory')) {
      return { success: false, error: 'يلزم حساب مدير أو مالك لديه صلاحية إدارة المخزون لتصحيح الباركود' };
    }
    if (!isTauri) return { success: false, error: 'تصحيح الباركود الآمن متاح في تطبيق سطح المكتب فقط' };
    const id = Number(drugId);
    const oldCode = String(conflictingBarcode || '').trim();
    const newCode = String(replacementBarcode || '').trim();
    if (!Number.isInteger(id) || id <= 0 || !oldCode) {
      return { success: false, error: 'بيانات تصحيح الباركود غير صالحة' };
    }
    if (newCode && newCode.toLowerCase() === oldCode.toLowerCase()) {
      return { success: false, error: 'أدخل باركوداً مختلفاً أو اتركه فارغاً لإزالة الباركود الخاطئ' };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ id: number; backup_path: string }>('correct_drug_barcode_conflict', {
      userId: user.id,
      password,
      payload: { drug_id: id, conflicting_barcode: oldCode, replacement_barcode: newCode || null },
    });
    try { await secureCache.reload(); } catch (error) { console.warn('Reload catalog after barcode correction', error); }
    notifyDrugIdentityChanged({ sourceIds: [], targetId: result.id });
    return { success: true, id: result.id, backupPath: result.backup_path };
  } catch (error: any) {
    return { success: false, error: String(error?.message || error) };
  }
}

export async function getReplacementDrug(id: number) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_manage_inventory') && !hasUserPermissionSync(user, 'can_view_purchases'))) return null;
    const rows = await dbSelect(`SELECT m.*,
      (SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE drug_id=m.id) AS stock_quantity,
      (SELECT GROUP_CONCAT(DISTINCT barcode) FROM inventory WHERE drug_id=m.id AND TRIM(COALESCE(barcode,''))!='') AS inventory_barcodes,
      (SELECT GROUP_CONCAT(DISTINCT barcode) FROM inventory WHERE drug_id=m.id AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))!='') AS active_inventory_barcodes
      FROM master_drugs m WHERE id=?`, [id]);
    return rows[0] || null;
  } catch (error) {
    // Replacement already committed: callers must recover without suggesting it failed.
    console.warn('Read replacement catalog record', error);
    return null;
  }
}
