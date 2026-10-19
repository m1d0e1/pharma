
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
import { requireOpenShiftId } from './finance';
import { localDate } from '@/lib/time';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { unitQuantityInLarge, largeQuantityInUnit } from '@/lib/inventory/unit-quantity';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

// Durable crash marker, not a permission or receipt. Raw reasons, patient
// identities and drug names never enter storage. Only a native, session-bound
// read of the exact 043 receipt can clear a marker after a lost acknowledgment.
const RETURN_RECOVERY_KEY = 'pharma:sales-return-native-ack:v1';
const RETURN_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type ReturnRail = 'cash' | 'bank' | 'patient_account' | 'wallet';
type ReturnHint = {
  version: 1; requestId: string; invoiceId: string; rail: ReturnRail;
  amountCents: number; lineSha256: string; scopeSha256: string;
};
type NativeReturnConfirmation = {
  id: string; requestId: string; invoiceId: string; actorId: string;
  pharmacyId: string; refundMethod: ReturnRail; amountCents: number;
  lineSha256: string;
};
let nativeReturnInFlight = false;

function returnStorage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('Native refund recovery storage is unavailable');
  }
  return window.localStorage;
}
function readReturnHint(): ReturnHint | null {
  const raw = returnStorage().getItem(RETURN_RECOVERY_KEY);
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error('Corrupt refund recovery marker; verify original receipt');
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new Error('Corrupt refund recovery marker; verify original receipt');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Corrupt refund recovery marker; verify original receipt');
  }
  const hint = value as Record<string, unknown>;
  if (Object.keys(hint).sort().join(',') !== 'amountCents,invoiceId,lineSha256,rail,requestId,scopeSha256,version' ||
    hint.version !== 1 || typeof hint.requestId !== 'string' || !RETURN_UUID_V4.test(hint.requestId) ||
    typeof hint.invoiceId !== 'string' || !hint.invoiceId.trim() || hint.invoiceId.length > 256 ||
    !['cash', 'bank', 'patient_account', 'wallet'].includes(String(hint.rail)) ||
    !Number.isSafeInteger(hint.amountCents) || Number(hint.amountCents) < 0 ||
    typeof hint.lineSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(hint.lineSha256) ||
    typeof hint.scopeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(hint.scopeSha256)) {
    throw new Error('Corrupt refund recovery marker; verify original receipt');
  }
  return hint as ReturnHint;
}

export function nativeSalesReturnRecoveryPending(): boolean {
  if (!isTauri) return false;
  // If storage is inaccessible or malformed, treat it as unresolved: never
  // generate a second refund nonce by assuming the record is absent.
  try { return readReturnHint() !== null; } catch { return true; }
}

async function returnDigest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('SHA-256 required before a native refund can be submitted');
  }
  const data = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

type NativeReturnInput = {
  request_id?: string; invoice_id: string; shift_id?: string;
  refund_method: ReturnRail; reason: string; patient_id?: string | number;
  expected_total_refund?: number;
  items: { sale_item_id?: number; inventory_id: string; drug_name: string;
    quantity: number; unit_price: number; unit?: string }[];
};

function canonicalReturnLines(items: NativeReturnInput['items']) {
  if (!items.length || items.length > 200) throw new Error('Invalid native refund lines');
  const lines = items.map(item => {
    const micro = Math.round(item.quantity * 1_000_000);
    const unit = item.unit || 'large';
    if (!Number.isSafeInteger(item.sale_item_id) || Number(item.sale_item_id) <= 0 ||
      typeof item.inventory_id !== 'string' || !item.inventory_id ||
      !Number.isFinite(item.quantity) || micro <= 0 || !Number.isSafeInteger(micro) ||
      Math.abs(item.quantity * 1_000_000 - micro) > 0.000001 ||
      !['large', 'medium', 'small'].includes(unit)) {
      throw new Error('Native refund original line source is incomplete');
    }
    return [item.sale_item_id, item.inventory_id, micro, unit] as [number, string, number, string];
  }).sort((a, b) => a[0] - b[0]);
  if (lines.some((line, i) => i > 0 && line[0] === lines[i - 1][0])) {
    throw new Error('Duplicate native refund sale item');
  }
  return lines;
}

async function confirmPendingNativeReturn(hint: ReturnHint, actor: string, pharmacy: string) {
  const { invoke } = await import('@tauri-apps/api/core');
  const response = await invoke<NativeReturnConfirmation | null>(
    'confirm_sales_return_native', {
      payload: {
        requestId: hint.requestId, invoiceId: hint.invoiceId,
        refundMethod: hint.rail, amountCents: hint.amountCents,
        lineSha256: hint.lineSha256,
      },
    },
  );
  if (!response || !response.id || response.requestId !== hint.requestId ||
    response.invoiceId !== hint.invoiceId || response.actorId !== actor ||
    response.pharmacyId !== pharmacy || response.refundMethod !== hint.rail ||
    response.amountCents !== hint.amountCents || response.lineSha256 !== hint.lineSha256) {
    throw new Error('Original 043 refund receipt is unverified; no new refund was sent');
  }
  // Native validates the actor at read time; the active UI session may still
  // switch WHILE that IPC read is unresolved. Never consume the old marker
  // under a different actor, tenant or subsequently revoked UI permission.
  await requireCurrentReturnSession(actor, pharmacy);
  const saved = readReturnHint();
  if (!saved || JSON.stringify(saved) !== JSON.stringify(hint)) {
    throw new Error('Refund recovery marker changed during confirmation');
  }
  returnStorage().removeItem(RETURN_RECOVERY_KEY);
  if (readReturnHint() !== null) throw new Error('Refund recovery marker could not be cleared');
  return response;
}

async function requireCurrentReturnSession(actor: string, pharmacy: string): Promise<void> {
  const current = await getLocalSession();
  if (!actor || !pharmacy || pharmacy === 'local_default' ||
    String(current?.id ?? '') !== actor ||
    String(current?.pharmacy_id ?? '') !== pharmacy ||
    !hasUserPermissionSync(current, 'can_view_returns')) {
    throw new Error('Native refund actor, tenant or permission changed; original receipt stays unresolved');
  }
}

async function matchesOriginalReturnIntent(
  hint: ReturnHint, data: NativeReturnInput, actor: string, pharmacy: string,
): Promise<boolean> {
  if (data.request_id !== hint.requestId ||
    data.invoice_id !== hint.invoiceId || data.refund_method !== hint.rail ||
    !Number.isFinite(data.expected_total_refund) ||
    Math.abs(Number(data.expected_total_refund) * 100 - hint.amountCents) > 0.0000001) {
    return false;
  }
  const lineSha256 = await returnDigest(canonicalReturnLines(data.items));
  if (lineSha256 !== hint.lineSha256) return false;
  const scopeSha256 = await returnDigest([
    actor, pharmacy, data.invoice_id, data.refund_method, hint.amountCents,
    lineSha256, data.shift_id || null,
    data.patient_id ? String(data.patient_id) : null, data.reason || '',
  ]);
  return scopeSha256 === hint.scopeSha256;
}

export async function confirmPendingSalesReturnAction() {
  if (!isTauri) return { success: false, error: 'Native return confirmation requires desktop' };
  if (nativeReturnInFlight) return { success: false, error: 'Original return verification is in progress' };
  nativeReturnInFlight = true;
  try {
    const hint = readReturnHint();
    if (!hint) return { success: true, recovered: false };
    const session = await getLocalSession();
    const actor = String(session?.id ?? '');
    const pharmacy = String(session?.pharmacy_id ?? '');
    if (!actor || !pharmacy || pharmacy === 'local_default' ||
      !hasUserPermissionSync(session, 'can_view_returns')) {
      throw new Error('Native return actor and tenant permission required');
    }
    const receipt = await confirmPendingNativeReturn(hint, actor, pharmacy);
    notifyInventoryChanged();
    return { success: true, recovered: true, returnId: receipt.id };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    nativeReturnInFlight = false;
  }
}

/**
 * Get sales invoices by date for return flow
 */
type ReturnableSaleInvoice = {
  id: string;
  patient_id: string | null;
  total_amount: number | null;
  created_at: string | null;
  status: string | null;
  user_name: string | null;
  patient_name: string | null;
  payment_method: string | null;
};

export async function getSalesInvoicesByDateAction(dateStr: string) {
  try {
    if (isTauri) {
      // Native IPC derives actor, permissions and pharmacy from the locked
      // authenticated session. Renderer values are only a date filter.
      const { invoke } = await import('@tauri-apps/api/core');
      const invoices = await invoke<ReturnableSaleInvoice[]>('list_returnable_sales_invoices_by_date', { date: dateStr });
      return { success: true, data: invoices };
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    const invoices = await db.prepare(`
       SELECT i.id, i.patient_id, i.total_amount, i.created_at, i.status, u.full_name as user_name,
             p.full_name as patient_name, i.payment_method
      FROM sales_invoices i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN patients p ON i.patient_id = p.id
      WHERE date(i.created_at, 'localtime') = ?
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (i.status IS NULL OR i.status = 'completed' OR i.status = 'approved' OR i.status = 'delivered' OR i.status = '')
        AND EXISTS (
          SELECT 1
          FROM sales_items si
          LEFT JOIN inventory inv ON inv.id = si.inventory_id
          LEFT JOIN master_drugs md ON md.id = si.drug_id
          WHERE si.invoice_id = i.id
            AND si.quantity_sold > COALESCE((
              SELECT SUM(
                (
                  CASE
                    WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), si.unit, 'large'))) IN ('medium', 'strip', '\u0634\u0631\u064a\u0637')
                      OR LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), si.unit, 'large'))) = LOWER(TRIM(COALESCE(md.medium_unit, '')))
                    THEN CAST(ri.quantity_returned AS REAL) / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(inv.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1)
                    WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), si.unit, 'large'))) IN ('small', 'unit', 'pill')
                      OR LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), si.unit, 'large'))) = LOWER(TRIM(COALESCE(md.small_unit, '')))
                    THEN CAST(ri.quantity_returned AS REAL)
                      / (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(inv.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1)
                        * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(inv.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1))
                    ELSE CAST(ri.quantity_returned AS REAL)
                  END
                ) * (
                  CASE
                    WHEN LOWER(TRIM(COALESCE(si.unit, 'large'))) IN ('medium', 'strip', '\u0634\u0631\u064a\u0637')
                      OR LOWER(TRIM(COALESCE(si.unit, 'large'))) = LOWER(TRIM(COALESCE(md.medium_unit, '')))
                    THEN COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(inv.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1)
                    WHEN LOWER(TRIM(COALESCE(si.unit, 'large'))) IN ('small', 'unit', 'pill')
                      OR LOWER(TRIM(COALESCE(si.unit, 'large'))) = LOWER(TRIM(COALESCE(md.small_unit, '')))
                    THEN COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(inv.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1)
                      * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(inv.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1)
                    ELSE 1
                  END
                )
              )
              FROM return_items ri
              JOIN returns r ON ri.return_id = r.id
              WHERE ri.sale_item_id = si.id
                AND r.invoice_id = i.id
                AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
            ), 0)
        )
      ORDER BY i.created_at DESC
    `).all(dateStr, pharmacyId, pharmacyId);
    return { success: true, data: invoices };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Create a return/refund request
 */
export async function createReturnAction(data: NativeReturnInput) {
  try {
    // Pin the complete request BEFORE the first await. The actor and payment
    // source checked/hashes must be the identical values sent to native even
    // if an old component changes its input object during async authorization.
    if (isTauri) data = { ...data, items: data.items.map(item => ({ ...item })) };
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    if (!isTauri && typeof window !== 'undefined') {
      return {
        success: false,
        error: 'إنشاء مرتجع من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب',
      };
    }
    if (!['cash', 'patient_account', 'wallet', 'bank'].includes(String(data.refund_method || ''))) {
      return { success: false, error: 'طريقة الاسترداد غير مدعومة' };
    }
    const pharmacyId = user.pharmacy_id || 'local_default';

    if (isTauri) {
      if (nativeReturnInFlight) throw new Error('Native refund recovery is already in progress');
      nativeReturnInFlight = true;
      try {
      const actor = String(user.id ?? '');
      const tenant = String(user.pharmacy_id ?? '');
      if (!actor || !tenant || tenant === 'local_default') {
        throw new Error('Verified native refund actor and pharmacy required');
      }
      // A persisted original intent is always resolved by an authenticated
      // read. No later caller can substitute a new nonce or reissue the write.
      const pending = readReturnHint();
      if (pending) {
        if (!await matchesOriginalReturnIntent(pending, data, actor, tenant)) {
          throw new Error('Current refund differs from the unresolved original; no receipt was consumed or reposted');
        }
        const receipt = await confirmPendingNativeReturn(pending, actor, tenant);
        notifyInventoryChanged();
        return { success: true, returnId: receipt.id, totalRefund: receipt.amountCents / 100 };
      }
      const requestId = data.request_id;
      if (typeof requestId !== 'string' || !RETURN_UUID_V4.test(requestId)) {
        throw new Error('Canonical UUIDv4 original refund request required');
      }
      if (!Number.isFinite(data.expected_total_refund) ||
        Number(data.expected_total_refund) < 0 ||
        Number(data.expected_total_refund) > 1_000_000_000_000) {
        throw new Error('Original native refund amount preview required');
      }
      const amountCents = Math.round(Number(data.expected_total_refund) * 100);
      if (!Number.isSafeInteger(amountCents) ||
        Math.abs(Number(data.expected_total_refund) * 100 - amountCents) > 0.0000001) {
        throw new Error('Native refund preview has fractional cents');
      }
      const lineSha256 = await returnDigest(canonicalReturnLines(data.items));
      const scopeSha256 = await returnDigest([
        actor, tenant, data.invoice_id, data.refund_method,
        amountCents, lineSha256, data.shift_id || null,
        data.patient_id ? String(data.patient_id) : null, data.reason || '',
      ]);
      const hint: ReturnHint = {
        version: 1, requestId, invoiceId: data.invoice_id,
        rail: data.refund_method, amountCents, lineSha256, scopeSha256,
      };
      if (readReturnHint()) throw new Error('Earlier refund requires native receipt confirmation');
      await requireCurrentReturnSession(actor, tenant);
      returnStorage().setItem(RETURN_RECOVERY_KEY, JSON.stringify(hint));
      if (JSON.stringify(readReturnHint()) !== JSON.stringify(hint)) {
        throw new Error('Original refund recovery marker could not be saved');
      }
      const { invoke } = await import('@tauri-apps/api/core');
      // Imports can suspend execution. Verify native session identity one more
      // time immediately before crossing the money-bearing IPC boundary.
      await requireCurrentReturnSession(actor, tenant);
      const result = await invoke('create_return_critical', {
        requestId,
        payload: {
          invoice_id: data.invoice_id,
          shift_id: data.shift_id || null,
          refund_method: data.refund_method || 'cash',
          reason: data.reason || '',
          patient_id: data.patient_id ? String(data.patient_id) : null,
          items: data.items.map(item => ({
            sale_item_id: item.sale_item_id || null,
            inventory_id: item.inventory_id || null,
            drug_name: item.drug_name || '',
            quantity: Number(item.quantity || 0),
            unit_price: Number(item.unit_price || 0),
            unit: item.unit || 'large',
          })),
        }
      }) as any;
      if (
        !result ||
        typeof result.return_id !== 'string' ||
        !result.return_id.trim() ||
        typeof result.total_refund !== 'number' ||
        !Number.isFinite(result.total_refund) ||
        result.total_refund < 0 ||
        Math.abs(result.total_refund * 100 - amountCents) > 0.00001
      ) {
        throw new Error('Refund amount or receipt is uncertain; inspect the original 043 receipt');
      }
      // A native writer may complete just before logout or a tenant switch.
      // Do not consume its nonce marker on an ACK seen by a different session.
      await requireCurrentReturnSession(actor, tenant);
      if (JSON.stringify(readReturnHint()) !== JSON.stringify(hint)) {
        throw new Error('Original refund recovery marker changed during posting');
      }
      returnStorage().removeItem(RETURN_RECOVERY_KEY);
      if (readReturnHint() !== null) {
        throw new Error('Original refund recovery marker could not be cleared');
      }
      revalidatePath('/returns');
      revalidatePath('/inventory');
      notifyInventoryChanged();
      return { success: true, returnId: result.return_id, totalRefund: result.total_refund };
      } finally {
        nativeReturnInFlight = false;
      }
    }

    const result = await dbTransaction(async (db) => {
    const dbHeader = await db.prepare(`
      SELECT *
      FROM sales_invoices
      WHERE id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(data.invoice_id, pharmacyId, pharmacyId) as any;
    if (!dbHeader) return { success: false, error: 'الفاتورة غير موجودة' };
    if (
      String(dbHeader.payment_method || '').toLowerCase() === 'delivery' &&
      String(dbHeader.status || '').toLowerCase() !== 'delivered'
    ) {
      return { success: false, error: 'يجب تسوية تحصيل فاتورة التوصيل قبل إجراء المرتجع' };
    }
    const patientLinkedRefund = data.refund_method === 'patient_account' || data.refund_method === 'wallet';
    if (patientLinkedRefund && !dbHeader.patient_id) {
      return { success: false, error: 'لا يمكن ترحيل المرتجع لحساب مريض لأن الفاتورة غير مرتبطة بمريض' };
    }
    if (
      patientLinkedRefund &&
      data.patient_id != null &&
      String(data.patient_id) !== String(dbHeader.patient_id)
    ) {
      return { success: false, error: 'يجب ترحيل المرتجع إلى حساب مريض الفاتورة نفسه' };
    }

    // 1. Validate: check for non-returnable drugs
    for (const item of data.items) {
      const drugCheck = await db.prepare(`
        SELECT md.no_return, md.trade_name, si.drug_id
        FROM sales_items si
        LEFT JOIN master_drugs md ON si.drug_id = md.id
        WHERE si.id = ? AND si.invoice_id = ?
      `).get(item.sale_item_id, data.invoice_id) as any;
      
      if (drugCheck?.no_return) {
        return { success: false, error: `الصنف "${drugCheck.trade_name}" غير قابل للارتجاع` };
      }
    }

    // 2. Validate: remaining quantity on invoice
    const invoiceItems = await db.prepare(`
      SELECT si.*, md.medium_unit, md.small_unit
      FROM sales_items si
      LEFT JOIN master_drugs md ON md.id = si.drug_id
      WHERE si.invoice_id = ?
    `).all(data.invoice_id) as any[];
    const unresolvedLegacyReturn = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.invoice_id = ?
        AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        AND ri.sale_item_id IS NULL
    `).get(data.invoice_id) as any;
    if (Number(unresolvedLegacyReturn?.count || 0) > 0) {
      return { success: false, error: 'لا يمكن إنشاء مرتجع إضافي لهذه الفاتورة القديمة لأن سجل المرتجع السابق غير مرتبط بسطر البيع الأصلي' };
    }
    const alreadyReturned = await db.prepare(`
      SELECT ri.sale_item_id, ri.quantity_returned, ri.unit
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.invoice_id = ?
        AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        AND ri.sale_item_id IS NOT NULL
    `).all(data.invoice_id) as any[];

    const requestedBySaleItem = new Map<number, number>();
    const preparedReturns: any[] = [];
    for (const returnItem of data.items) {
      const soldItem = invoiceItems.find(si => si.id === returnItem.sale_item_id);
      if (!soldItem) {
        return { success: false, error: `Sale item ${returnItem.sale_item_id} not found` };
      }
      const largeToMedium = Math.max(1, Number(soldItem.large_to_medium) || 1);
      const mediumToSmall = Math.max(1, Number(soldItem.medium_to_small) || 1);
      const restockQty = unitQuantityInLarge(
        Number(returnItem.quantity),
        returnItem.unit,
        largeToMedium,
        mediumToSmall,
        soldItem.medium_unit,
        soldItem.small_unit,
      );
      const returnedInSoldUnit = largeQuantityInUnit(
        restockQty,
        soldItem.unit,
        largeToMedium,
        mediumToSmall,
        soldItem.medium_unit,
        soldItem.small_unit,
      );
      const returned = alreadyReturned
        .filter(ar => Number(ar.sale_item_id) === Number(returnItem.sale_item_id))
        .reduce((sum, prior) => {
          const priorUnit = String(prior.unit || '').trim() || String(soldItem.unit || 'large');
          const priorLarge = unitQuantityInLarge(
            Number(prior.quantity_returned) || 0,
            priorUnit,
            largeToMedium,
            mediumToSmall,
            soldItem.medium_unit,
            soldItem.small_unit,
          );
          return sum + largeQuantityInUnit(
            priorLarge,
            soldItem.unit,
            largeToMedium,
            mediumToSmall,
            soldItem.medium_unit,
            soldItem.small_unit,
          );
        }, 0);
      const saleItemId = Number(returnItem.sale_item_id);
      const requested = (requestedBySaleItem.get(saleItemId) || 0) + returnedInSoldUnit;
      requestedBySaleItem.set(saleItemId, requested);
      if (requested > (Number(soldItem.quantity_sold) - returned + 0.000001)) {
        return { success: false, error: `كمية المرتجع تتجاوز الكمية المتبقية للصنف "${returnItem.drug_name}"` };
      }
      preparedReturns.push({
        item: returnItem,
        saleItem: soldItem,
        largeToMedium,
        mediumToSmall,
        restockQty,
        returnedInSoldUnit,
      });
    }

    const returnId = generateId();
    const grossRequestedRefund = preparedReturns.reduce(
      (sum, prepared) => sum + prepared.returnedInSoldUnit * Number(prepared.saleItem.unit_price || 0),
      0
    );
    const invoiceGross = invoiceItems.reduce(
      (sum, item) => sum + Number(item.quantity_sold || 0) * Number(item.unit_price || 0),
      0
    );
    const priorRefund = await db.prepare(`
      SELECT COALESCE(SUM(total_refund), 0) AS total
      FROM returns
      WHERE invoice_id = ? AND LOWER(COALESCE(status, '')) IN ('approved', 'completed')
    `).get(data.invoice_id) as any;
    const invoiceTotal = Number(dbHeader.total_amount || 0);
    const merchandiseTotal = Math.max(0, invoiceGross - Number(dbHeader.discount_amount || 0));
    const refundableInvoiceTotal =
      String(dbHeader.status || '').toLowerCase() === 'delivered' &&
      String(dbHeader.payment_method || '').toLowerCase() === 'delivery'
        ? Math.min(invoiceTotal, merchandiseTotal)
        : invoiceTotal;
    const priorGrossReturned = alreadyReturned.reduce((sum, prior) => {
      const soldItem = invoiceItems.find(si => Number(si.id) === Number(prior.sale_item_id));
      if (!soldItem) return sum;
      const largeToMedium = Math.max(1, Number(soldItem.large_to_medium) || 1);
      const mediumToSmall = Math.max(1, Number(soldItem.medium_to_small) || 1);
      const priorUnit = String(prior.unit || '').trim() || String(soldItem.unit || 'large');
      const priorLarge = unitQuantityInLarge(
        Number(prior.quantity_returned) || 0,
        priorUnit,
        largeToMedium,
        mediumToSmall,
        soldItem.medium_unit,
        soldItem.small_unit,
      );
      const priorInSoldUnit = largeQuantityInUnit(
        priorLarge,
        soldItem.unit,
        largeToMedium,
        mediumToSmall,
        soldItem.medium_unit,
        soldItem.small_unit,
      );
      return sum + priorInSoldUnit * Number(soldItem.unit_price || 0);
    }, 0);
    const paidRatio = invoiceGross > 0 ? refundableInvoiceTotal / invoiceGross : 0;
    const totalRefund = Math.min(
      grossRequestedRefund * paidRatio,
      Math.max(0, refundableInvoiceTotal - Number(priorRefund?.total || 0))
    );

      const shiftId = await requireOpenShiftId(String(user.id), data.shift_id, db);
      // 3. Create return header
      await db.prepare(`
        INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, shift_id, reason, total_refund, refund_method, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved')
      `).run(returnId, data.invoice_id, user.id, pharmacyId, shiftId, data.reason, totalRefund, data.refund_method);

      let totalCogsReversal = 0;

      // 4. Create return items and restock
      for (const prepared of preparedReturns) {
        const item = prepared.item;
        const saleItem = prepared.saleItem;
        let finalInventoryId = saleItem.inventory_id || null;
        let drugId = saleItem.drug_id;

        // If drugId is not found, we can query it
        if (!drugId && finalInventoryId) {
          const invRow = await db.prepare(`
            SELECT drug_id
            FROM inventory
            WHERE id = ?
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          `).get(finalInventoryId, pharmacyId, pharmacyId) as any;
          if (invRow) drugId = invRow.drug_id;
        }

        let inventoryExists = false;
        if (finalInventoryId) {
          const checkInv = await db.prepare(`
            SELECT 1
            FROM inventory
            WHERE id = ?
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          `).get(finalInventoryId, pharmacyId, pharmacyId);
          if (checkInv) inventoryExists = true;
        }

        if (!inventoryExists && drugId) {
          const newInvId = generateId();
          const batchNum = 'RET-' + generateId().substring(0, 8);
          await db.prepare(`
            INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, cost_price, strips_per_box, medium_to_small)
            VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)
          `).run(
            newInvId,
            pharmacyId,
            drugId,
            batchNum,
            saleItem.unit_price,
            Number(saleItem.cost_price || 0),
            prepared.largeToMedium,
            prepared.mediumToSmall
          );
          finalInventoryId = newInvId;
        }

        await db.prepare(`
          INSERT INTO return_items (return_id, inventory_id, drug_name, quantity_returned, unit_price, sale_item_id, unit)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          returnId,
          finalInventoryId,
          item.drug_name,
          prepared.returnedInSoldUnit,
          saleItem.unit_price,
          item.sale_item_id || null,
          saleItem.unit || 'large'
        );

        await db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(prepared.restockQty, finalInventoryId);
        
        // Calculate COGS reversal based on original cost
        totalCogsReversal += (saleItem.cost_price || 0) * prepared.restockQty;
      }

      // 5. Accounting Journal Entry. A patient-account refund reduces A/R;
      // wallet credit is a separate operation and must not be granted as well.
      const journalId = generateId();
      const returnDate = new Date().toLocaleDateString('en-CA');
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, returnDate, `مرتجع مبيعات فاتورة #${data.invoice_id.slice(0,8)}`, user.id, totalRefund + totalCogsReversal);

      const getAccountId = async (cat: string) => {
        const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
        return s?.account_id;
      };

      const accounts = {
        cash: await getAccountId('cash_drawer') || 6,
        receivable: await getAccountId('accounts_receivable') || 8,
        bank: await getAccountId('bank_clearing'),
        wallet: await getAccountId('patient_wallet_liability'),
        sales: await getAccountId('sales_revenue') || 9,
        inventory: await getAccountId('inventory_asset') || 10,
        cogs: await getAccountId('cogs_expense') || 11
      };

      // Reverse Revenue: Debit Sales Revenue, Credit Cash/AR
      if (data.refund_method === 'bank' && !accounts.bank) {
        throw new Error('Bank clearing account is not configured');
      }
      if (data.refund_method === 'wallet' && !accounts.wallet) {
        throw new Error('Patient wallet liability account is not configured');
      }
      const creditAccount = data.refund_method === 'patient_account'
        ? accounts.receivable
        : data.refund_method === 'bank'
          ? accounts.bank
          : data.refund_method === 'wallet'
            ? accounts.wallet
          : accounts.cash;
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.sales, 'debit', totalRefund);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, creditAccount, 'credit', totalRefund);

      // Reverse COGS: Debit Inventory, Credit COGS
      if (totalCogsReversal > 0) {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', totalCogsReversal);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cogs, 'credit', totalCogsReversal);
      }

      // ponytail: record refund in patient_transactions for customer ledger visibility
      const patientId = data.patient_id || dbHeader?.patient_id;
      if (data.refund_method === 'wallet' && patientId) {
        const walletUpdate = await db.prepare(
          'UPDATE patients SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?'
        ).run(totalRefund, String(patientId));
        if (walletUpdate.changes !== 1) {
          throw new Error('Invoice patient no longer exists');
        }
      }
      if (data.refund_method === 'patient_account' && patientId) {
        const txId = generateId();
        await db.prepare(`
          INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, payment_method, notes, date)
          VALUES (?, ?, ?, 'refund', ?, 'patient_account', ?, ?)
        `).run(
          txId,
          String(patientId),
          user.id,
          totalRefund,
          `مرتجع مبيعات فاتورة #${data.invoice_id.slice(0, 8)}`,
          returnDate
        );
      }

      const invoiceTotalForPoints = Number(dbHeader?.total_amount || 0);
      const pointsEarned = Math.max(0, Number(dbHeader?.points_earned || 0));
      if (patientId && invoiceTotalForPoints > 0 && pointsEarned > 0) {
        const targetReversed = (refunded: number) => refunded + 0.005 >= invoiceTotalForPoints
          ? pointsEarned
          : Math.floor(pointsEarned * (Math.max(0, refunded) / invoiceTotalForPoints));
        const refundedBefore = Number(priorRefund?.total || 0);
        const pointsToReverse = Math.max(
          0,
          targetReversed(refundedBefore + totalRefund) - targetReversed(refundedBefore)
        );
        if (pointsToReverse > 0) {
          // Earned points may already have been spent on a later sale. Preserve the
          // full clawback as loyalty debt instead of silently forgiving the spent portion.
          await db.prepare('UPDATE patients SET points_balance = COALESCE(points_balance, 0) - ? WHERE id = ?')
            .run(pointsToReverse, String(patientId));
        }
      }

      const pointsRedeemed = Math.max(0, Math.floor(Number(dbHeader?.points_redeemed || 0)));
      if (patientId && invoiceGross > 0 && pointsRedeemed > 0) {
        const targetRestored = (grossReturned: number) => grossReturned + 0.005 >= invoiceGross
          ? pointsRedeemed
          : Math.floor(pointsRedeemed * (Math.max(0, grossReturned) / invoiceGross));
        const pointsToRestore = Math.max(
          0,
          targetRestored(priorGrossReturned + grossRequestedRefund) - targetRestored(priorGrossReturned),
        );
        if (pointsToRestore > 0) {
          await db.prepare('UPDATE patients SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?')
            .run(pointsToRestore, String(patientId));
        }
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        user.id,
        'CREATE_RETURN',
        `مرتجع بقيمة ${totalRefund} ج.م للفاتورة ${data.invoice_id.slice(0,8)}`
      );

      return { success: true, returnId, totalRefund };
    });

    if (result.success) {
      revalidatePath('/returns');
      revalidatePath('/inventory');
      notifyInventoryChanged();
    }
    return result;
  } catch (error: any) {
    console.error('Create return error:', error);
    return { success: false, error: typeof error === 'string' && error.trim()
      ? error : error instanceof Error && error.message
        ? error.message : 'فشل إنشاء المرتجع' };
  }
}


type ReturnListOptions = {
  limit?: number;
  offset?: number;
  search?: string;
};

/**
 * Get a bounded page of returns.
 */
export async function getReturnsAction(options: ReturnListOptions = {}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = typeof user.pharmacy_id === 'string' ? user.pharmacy_id.trim() : '';
    if (isTauri && (!pharmacyId || pharmacyId === 'local_default')) {
      return { success: false, error: 'تعذر التحقق من ملكية سجل المرتجعات لهذه الصيدلية' };
    }
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 50)));
    const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
    const search = String(options.search || '').trim();
    if (isTauri) {
      if (!Number.isSafeInteger(offset) || offset > 50_000 || search.length > 128 ||
          [...search].some(char => /[\x00-\x1f\x7f]/.test(char))) {
        throw new Error('Invalid native return history paging or search');
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const page = await invoke<any[]>('db_read_scoped', {
        queryId: 'returns.list', recordId: null, limit: limit + 1,
        offset, search: search || null, drugId: null,
      });
      if (!Array.isArray(page) || page.length > limit + 1 ||
          page.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('Native return history page is invalid');
      }
      const hasMore = page.length > limit;
      const headers = page.slice(0, limit);
      const seen = new Set<string>();
      for (const ret of headers) {
        if (typeof ret.id !== 'string' || !ret.id.trim() || ret.id.length > 128 ||
            seen.has(ret.id) || ret.pharmacy_id !== pharmacyId ||
            typeof ret.invoice_id !== 'string' || !ret.invoice_id.trim() ||
            typeof ret.user_id !== 'string' || !ret.user_id.trim() ||
            !['approved', 'completed'].includes(String(ret.status || '').toLowerCase()) ||
            typeof ret.total_refund !== 'number' || !Number.isFinite(ret.total_refund) || ret.total_refund < 0 ||
            typeof ret.invoice_total !== 'number' || !Number.isFinite(ret.invoice_total) || ret.invoice_total < 0 ||
            !Number.isSafeInteger(ret.item_count) || ret.item_count < 1 || ret.item_count > 200 ||
            (ret.patient_id != null && typeof ret.patient_id !== 'string') ||
            (ret.patient_name != null && typeof ret.patient_name !== 'string') ||
            (ret.user_name != null && typeof ret.user_name !== 'string')) {
          throw new Error('Native return history header lacks verified tenant provenance');
        }
        seen.add(ret.id);
      }
      const data: any[] = [];
      for (const ret of headers) {
        const items: any[] = [];
        const seenItems = new Set<number>();
        for (let itemOffset = 0; itemOffset <= 50_000; itemOffset += 200) {
          const lines = await invoke<any[]>('db_read_scoped', {
            queryId: 'returns.list_items', recordId: ret.id,
            limit: 200, offset: itemOffset, search: null, drugId: null,
          });
          if (!Array.isArray(lines) || lines.length > 200) {
            throw new Error('Native return lines are incomplete');
          }
          for (const item of lines) {
            if (!item || typeof item !== 'object' || Array.isArray(item) ||
                !Number.isSafeInteger(item.id) || item.id <= 0 || seenItems.has(item.id) ||
                item.return_id !== ret.id || !Number.isSafeInteger(item.sale_item_id) || item.sale_item_id <= 0 ||
                typeof item.inventory_id !== 'string' || !item.inventory_id.trim() ||
                !Number.isSafeInteger(item.drug_id) || item.drug_id <= 0 ||
                typeof item.quantity_returned !== 'number' || !Number.isFinite(item.quantity_returned) ||
                item.quantity_returned <= 0 ||
                typeof item.unit !== 'string' || !item.unit.trim() ||
                typeof item.unit_price !== 'number' || !Number.isFinite(item.unit_price) || item.unit_price < 0 ||
                typeof item.total_price !== 'number' || !Number.isFinite(item.total_price) || item.total_price < 0) {
              throw new Error('Native return history line lacks linked sold-lot provenance');
            }
            seenItems.add(item.id);
            items.push(item);
          }
          if (lines.length < 200) break;
          if (itemOffset + 200 > 50_000) throw new Error('Native return lines exceed safe pagination');
        }
        if (items.length !== ret.item_count) throw new Error('Native return has incomplete posted lines');
        data.push({ ...ret, items });
      }
      return { success: true, data, hasMore };
    }
    const like = `%${search}%`;

    const params: any[] = [pharmacyId || 'local_default', pharmacyId || 'local_default'];
    let sql = `
      SELECT r.*, u.full_name as user_name, p.full_name as patient_name, si.total_amount as invoice_total, si.created_at as invoice_date
      FROM returns r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN sales_invoices si ON r.invoice_id = si.id
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))
    `;
    if (search) {
      sql += `
        AND (
          r.id LIKE ? OR r.invoice_id LIKE ? OR
          COALESCE(p.full_name, '') LIKE ? OR COALESCE(u.full_name, '') LIKE ?
        )
      `;
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);
    const fetched = await db.prepare(sql).all(...params) as any[];
    const hasMore = fetched.length > limit;
    const returns = fetched.slice(0, limit);

    const returnIds = returns.map(ret => String(ret.id));
    const items = returnIds.length
      ? await db.prepare(`
          SELECT ri.*, md.trade_name_en, md.trade_name AS trade_name_ar
          FROM return_items ri
          JOIN returns parent_return ON parent_return.id = ri.return_id
          LEFT JOIN sales_items sold ON sold.id = ri.sale_item_id
            AND sold.invoice_id = parent_return.invoice_id
          LEFT JOIN master_drugs md ON md.id = COALESCE(ri.drug_id, sold.drug_id)
          WHERE ri.return_id IN (${returnIds.map(() => '?').join(',')})
        `).all(...returnIds) as any[]
      : [];
    const itemsByReturn = new Map<string, any[]>();
    for (const item of items) {
      const key = String(item.return_id);
      const group = itemsByReturn.get(key) || [];
      group.push(item);
      itemsByReturn.set(key, group);
    }
    const returnsWithItems = returns.map(ret => ({
      ...ret,
      items: itemsByReturn.get(String(ret.id)) || [],
    }));

    return { success: true, data: returnsWithItems, hasMore };
  } catch (error) {
    console.error('getReturnsAction error:', error);
    if (isTauri && error instanceof Error &&
        error.message.includes('Native return history contains unverified tenant-owned records')) {
      return { success: false, error: 'يحتوي سجل المرتجعات على معاملات لم يتم التحقق من مصدرها أو ملكيتها' };
    }
    return { success: false, error: 'فشل جلب المرتجعات' };
  }
}

/**
 * Search for invoices based on multiple criteria
 */
export async function searchInvoicesForReturnAction(filters: {
  dateFrom?: string;
  dateTo?: string;
  patientName?: string;
  invoiceId?: string;
  drugId?: number;
  barcode?: string;
}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';

    let query = `
      SELECT DISTINCT si.id, si.total_amount, si.created_at, p.full_name as patient_name, u.full_name as user_name, si.payment_method
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      LEFT JOIN users u ON si.user_id = u.id
      LEFT JOIN sales_items sit ON sit.invoice_id = si.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      LEFT JOIN inventory inv ON sit.inventory_id = inv.id
      WHERE (si.status IS NULL OR si.status = 'completed' OR si.status = 'approved' OR si.status = 'delivered' OR si.status = '')
        AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))
    `;
    const params: any[] = [pharmacyId, pharmacyId];

    if (filters.dateFrom) {
      query += ` AND date(si.created_at, 'localtime') >= ?`;
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      query += ` AND date(si.created_at, 'localtime') <= ?`;
      params.push(filters.dateTo);
    }
    if (filters.patientName) {
      query += ` AND p.full_name LIKE ?`;
      params.push(`%${filters.patientName}%`);
    }
    if (filters.invoiceId) {
      query += ` AND si.id LIKE ?`;
      params.push(`%${filters.invoiceId}%`);
    }
    if (filters.drugId) {
      query += ` AND sit.drug_id = ?`;
      params.push(filters.drugId);
    }
    if (filters.barcode) {
      query += ` AND (md.barcode = ? OR inv.barcode = ? OR md.barcode LIKE ? OR inv.barcode LIKE ?)`;
      const bc = filters.barcode.trim();
      const bcWildcard = `%${bc}%`;
      params.push(bc, bc, bcWildcard, bcWildcard);
    }

    query += ` ORDER BY si.created_at DESC LIMIT 50`;

    const invoices = await db.prepare(query).all(...params) as any[];

    return { success: true, data: invoices };
  } catch (error) {
    console.error('Search invoices error:', error);
    return { success: false, error: 'فشل البحث عن الفواتير' };
  }
}

/**
 * Search return invoices across all receipts by barcode, drug name, invoice ID, or patient
 */
export async function searchRecentReturnInvoicesAction(searchTerm: string, days?: number) {
  try {
    const term = searchTerm.trim();
    if (!term) return { success: true, data: [] };
    if (isTauri) {
      // In strict desktop mode the renderer cannot read sales, inventory or
      // patient tables with arbitrary SQL. The authenticated native command
      // establishes the actor and tenant and rejects incomplete 043 sources.
      const { invoke } = await import('@tauri-apps/api/core');
      const recentDays = days && days > 0 ? Math.min(3650, Math.max(1, Math.floor(days))) : null;
      const invoices = await invoke<ReturnableSaleInvoice[]>('search_returnable_sales_invoices_native', {
        searchTerm: term, days: recentDays,
      });
      if (!Array.isArray(invoices) || invoices.some(invoice =>
        !invoice || typeof invoice.id !== 'string' || !invoice.id ||
        typeof invoice.total_amount !== 'number' || !Number.isFinite(invoice.total_amount) ||
        typeof invoice.created_at !== 'string' ||
        (invoice.patient_name != null && typeof invoice.patient_name !== 'string') ||
        (invoice.user_name != null && typeof invoice.user_name !== 'string')
      )) {
        throw new Error('Native return search returned an invalid invoice projection');
      }
      return { success: true, data: invoices };
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح', data: [] };
    const pharmacyId = user.pharmacy_id || 'local_default';

    let dateFilter = '';
    if (days && days > 0) {
      const recentDays = Math.min(3650, Math.max(1, Math.floor(days)));
      dateFilter = ` AND datetime(si.created_at) >= datetime('now', '-${recentDays} days')`;
    }

    const query = `
      SELECT DISTINCT 
        si.id, si.total_amount, si.created_at, si.payment_method,
        p.full_name AS patient_name,
        u.full_name AS user_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      LEFT JOIN users u ON si.user_id = u.id
      LEFT JOIN sales_items sit ON sit.invoice_id = si.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      LEFT JOIN inventory inv ON sit.inventory_id = inv.id
      WHERE (si.status IS NULL OR si.status = 'completed' OR si.status = 'approved' OR si.status = 'delivered' OR si.status = '')
        AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))
        ${dateFilter}
        AND EXISTS (
          SELECT 1
          FROM sales_items candidate
          LEFT JOIN inventory candidate_inv ON candidate_inv.id = candidate.inventory_id
          LEFT JOIN master_drugs candidate_md ON candidate_md.id = candidate.drug_id
          WHERE candidate.invoice_id = si.id
            AND candidate.quantity_sold > COALESCE((
              SELECT SUM(
                (
                  CASE
                    WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), candidate.unit, 'large'))) IN ('medium', 'strip', '\u0634\u0631\u064a\u0637')
                      OR LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), candidate.unit, 'large'))) = LOWER(TRIM(COALESCE(candidate_md.medium_unit, '')))
                    THEN CAST(ri.quantity_returned AS REAL) / COALESCE(NULLIF(candidate.large_to_medium, 0), NULLIF(candidate_inv.strips_per_box, 0), NULLIF(candidate_md.large_to_medium, 0), 1)
                    WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), candidate.unit, 'large'))) IN ('small', 'unit', 'pill')
                      OR LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit), ''), candidate.unit, 'large'))) = LOWER(TRIM(COALESCE(candidate_md.small_unit, '')))
                    THEN CAST(ri.quantity_returned AS REAL)
                      / (COALESCE(NULLIF(candidate.large_to_medium, 0), NULLIF(candidate_inv.strips_per_box, 0), NULLIF(candidate_md.large_to_medium, 0), 1)
                        * COALESCE(NULLIF(candidate.medium_to_small, 0), NULLIF(candidate_inv.medium_to_small, 0), NULLIF(candidate_md.medium_to_small, 0), 1))
                    ELSE CAST(ri.quantity_returned AS REAL)
                  END
                ) * (
                  CASE
                    WHEN LOWER(TRIM(COALESCE(candidate.unit, 'large'))) IN ('medium', 'strip', '\u0634\u0631\u064a\u0637')
                      OR LOWER(TRIM(COALESCE(candidate.unit, 'large'))) = LOWER(TRIM(COALESCE(candidate_md.medium_unit, '')))
                    THEN COALESCE(NULLIF(candidate.large_to_medium, 0), NULLIF(candidate_inv.strips_per_box, 0), NULLIF(candidate_md.large_to_medium, 0), 1)
                    WHEN LOWER(TRIM(COALESCE(candidate.unit, 'large'))) IN ('small', 'unit', 'pill')
                      OR LOWER(TRIM(COALESCE(candidate.unit, 'large'))) = LOWER(TRIM(COALESCE(candidate_md.small_unit, '')))
                    THEN COALESCE(NULLIF(candidate.large_to_medium, 0), NULLIF(candidate_inv.strips_per_box, 0), NULLIF(candidate_md.large_to_medium, 0), 1)
                      * COALESCE(NULLIF(candidate.medium_to_small, 0), NULLIF(candidate_inv.medium_to_small, 0), NULLIF(candidate_md.medium_to_small, 0), 1)
                    ELSE 1
                  END
                )
              )
              FROM return_items ri
              JOIN returns r ON ri.return_id = r.id
              WHERE ri.sale_item_id = candidate.id
                AND r.invoice_id = si.id
                AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
            ), 0)
        )
        AND (
          si.id LIKE ? OR
          p.full_name LIKE ? OR
          md.trade_name LIKE ? OR
          md.trade_name_en LIKE ? OR
          md.active_ingredient LIKE ? OR
          md.barcode = ? OR
          inv.barcode = ? OR
          md.barcode LIKE ? OR
          inv.barcode LIKE ? OR
          CAST(md.id AS TEXT) = ?
        )
      ORDER BY si.created_at DESC
      LIMIT 100
    `;
    const wildcard = `%${term}%`;
    const invoices = await db.prepare(query).all(
      pharmacyId, pharmacyId,
      wildcard, wildcard, wildcard, wildcard, wildcard, term, term, wildcard, wildcard, term
    ) as any[];
    return { success: true, data: invoices };
  } catch (error: any) {
    console.error('searchRecentReturnInvoicesAction error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error || 'فشل البحث في مرتجع المبيعات'), data: [] };
  }
}

/**
 * Get invoice details for return processing
 */
type NativeReturnDetailKey =
  'returns.invoice_header' | 'returns.invoice_items' |
  'returns.invoice_prior' | 'returns.invoice_refund';

async function nativeReturnInvoiceRead(queryId: NativeReturnDetailKey, invoiceId: string, single: boolean) {
  const { invoke } = await import('@tauri-apps/api/core');
  const limit = single ? 1 : 200;
  const rows: any[] = [];
  for (let offset = 0; offset <= 50_000; offset += limit) {
    const page = await invoke<any[]>('db_read_scoped', {
      queryId, recordId: invoiceId, limit, offset, search: null, drugId: null,
    });
    if (!Array.isArray(page) || page.length > limit ||
        page.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Invalid native return invoice detail result page');
    }
    rows.push(...page);
    if (single || page.length < limit) return rows;
  }
  throw new Error('Native return invoice detail exceeds safe pagination capacity');
}

async function ownedNativeInvoiceForReturn(invoiceId: string, pharmacyId: string) {
  const headers = await nativeReturnInvoiceRead('returns.invoice_header', invoiceId, true);
  if (headers.length !== 1) throw new Error('Return invoice not found or not owned');
  const invoice = headers[0];
  if (String(invoice.id) !== invoiceId || invoice.pharmacy_id !== pharmacyId ||
      ![null, '', 'completed', 'approved', 'delivered'].includes(invoice.status) ||
      typeof invoice.total_amount !== 'number' || !Number.isFinite(invoice.total_amount) ||
      invoice.total_amount < 0 ||
      (invoice.discount_amount != null &&
        (typeof invoice.discount_amount !== 'number' || !Number.isFinite(invoice.discount_amount)))) {
    throw new Error('Native return invoice header lacks ownership or amount provenance');
  }
  const items = await nativeReturnInvoiceRead('returns.invoice_items', invoiceId, false);
  if (!items.length) throw new Error('Return invoice has no tenant-proven sold items');
  const saleItems = new Map<number, any>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || saleItems.has(item.id) ||
        item.invoice_id !== invoiceId ||
        typeof item.inventory_id !== 'string' || !item.inventory_id.trim() ||
        !Number.isSafeInteger(item.drug_id) || item.drug_id <= 0 ||
        typeof item.quantity_sold !== 'number' || !Number.isFinite(item.quantity_sold) ||
        item.quantity_sold <= 0 || typeof item.unit_price !== 'number' ||
        !Number.isFinite(item.unit_price) || item.unit_price < 0 ||
        typeof item.large_to_medium !== 'number' ||
        !Number.isFinite(item.large_to_medium) || item.large_to_medium <= 0 ||
        typeof item.medium_to_small !== 'number' ||
        !Number.isFinite(item.medium_to_small) || item.medium_to_small <= 0) {
      throw new Error('Native return invoice line is detached or unproven');
    }
    saleItems.set(item.id, item);
  }
  const priorReturns = await nativeReturnInvoiceRead('returns.invoice_prior', invoiceId, false);
  const returnedBySaleItem = new Map<number, number>();
  for (const prior of priorReturns) {
    if (!Number.isSafeInteger(prior.sale_item_id) ||
        !saleItems.has(prior.sale_item_id) ||
        typeof prior.quantity_returned !== 'number' ||
        !Number.isFinite(prior.quantity_returned) || prior.quantity_returned <= 0 ||
        (prior.unit != null && typeof prior.unit !== 'string')) {
      throw new Error('Historic return line lacks original invoice linkage');
    }
    const sold = saleItems.get(prior.sale_item_id)!;
    const originalUnit = String(sold.unit || 'large');
    const priorUnit = String(prior.unit || '').trim() || originalUnit;
    const returnedLarge = unitQuantityInLarge(
      prior.quantity_returned, priorUnit,
      sold.large_to_medium, sold.medium_to_small, sold.medium_unit, sold.small_unit,
    );
    const returnedInSaleUnit = largeQuantityInUnit(
      returnedLarge, originalUnit,
      sold.large_to_medium, sold.medium_to_small, sold.medium_unit, sold.small_unit,
    );
    if (!Number.isFinite(returnedInSaleUnit) || returnedInSaleUnit < 0) {
      throw new Error('Prior return conversion is invalid');
    }
    returnedBySaleItem.set(
      sold.id, (returnedBySaleItem.get(sold.id) || 0) + returnedInSaleUnit,
    );
  }
  for (const item of items) {
    if ((returnedBySaleItem.get(item.id) || 0) > item.quantity_sold + 0.000001) {
      throw new Error('Prior returns exceed the original sold quantity');
    }
  }
  const refundRows = await nativeReturnInvoiceRead('returns.invoice_refund', invoiceId, true);
  if (refundRows.length !== 1 || typeof refundRows[0].total !== 'number' ||
      !Number.isFinite(refundRows[0].total) || refundRows[0].total < 0) {
    throw new Error('Finalized return totals lack native provenance');
  }
  const isPlaceholder = (name?: string) =>
    !name || /^Drug\s*#?\s*\d+$/i.test(String(name).trim());
  return {
    ...invoice,
    // The patient directory is globally unowned in legacy databases; native
    // header intentionally never returns private patient/staff names.
    patient_name: null,
    user_name: null,
    already_refunded: refundRows[0].total,
    items: items.map(item => {
      let name = item.trade_name;
      if (isPlaceholder(name)) {
        name = !isPlaceholder(item.trade_name_en) ? item.trade_name_en :
          !isPlaceholder(item.active_ingredient) ? item.active_ingredient : name;
      }
      return {
        id: item.id,
        inventory_id: item.inventory_id,
        drug_id: item.drug_id,
        drug_name: name || `صنف #${item.drug_id}`,
        drug_name_en: item.trade_name_en,
        quantity_sold: item.quantity_sold,
        returned_quantity: returnedBySaleItem.get(item.id) || 0,
        unit_price: item.unit_price,
        unit: item.unit,
        expiry_date: item.expiry_date,
        large_to_medium: item.large_to_medium,
        medium_to_small: item.medium_to_small,
        large_unit: item.large_unit,
        medium_unit: item.medium_unit,
        small_unit: item.small_unit,
      };
    }),
  };
}

export async function getInvoiceForReturnAction(invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = typeof user.pharmacy_id === 'string' ? user.pharmacy_id.trim() : '';
    if (!pharmacyId || pharmacyId === 'local_default') {
      return { success: false, error: 'تعذر التحقق من ملكية فاتورة المرتجع لهذه الصيدلية' };
    }
    if (typeof invoiceId !== 'string' || !invoiceId.trim() || invoiceId.length > 128 ||
        [...invoiceId].some(char => /[\x00-\x1f\x7f]/.test(char))) {
      return { success: false, error: 'رقم الفاتورة غير صالح' };
    }
    if (isTauri) {
      return { success: true, data: await ownedNativeInvoiceForReturn(invoiceId, pharmacyId) };
    }

    const invoice = await db.prepare(`
      SELECT si.*, NULL as patient_name, NULL as user_name
      FROM sales_invoices si
      WHERE si.id = ?
        AND si.pharmacy_id = ?
    `).get(invoiceId, pharmacyId) as any;

    if (!invoice) return { success: false, error: 'الفاتورة غير موجودة' };

    const items = await db.prepare(`
      SELECT 
        sit.*, 
        md.trade_name, 
        md.trade_name_en,
        md.active_ingredient,
        md.id as drug_id,
        md.large_unit,
        md.medium_unit,
        md.small_unit,
        COALESCE(NULLIF(sit.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
        COALESCE(NULLIF(sit.medium_to_small, 0), NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
        i.expiry_date
      FROM sales_items sit
      LEFT JOIN inventory i ON sit.inventory_id = i.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      WHERE sit.invoice_id = ?
    `).all(invoiceId) as any[];

    const priorReturns = await db.prepare(`
      SELECT ri.sale_item_id, ri.quantity_returned, ri.unit
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.invoice_id = ?
        AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        AND ri.sale_item_id IS NOT NULL
    `).all(invoiceId) as any[];
    const returnedQuantityBySaleItem = new Map<number, number>();
    for (const prior of priorReturns) {
      const saleItem = items.find(item => Number(item.id) === Number(prior.sale_item_id));
      if (!saleItem) continue;
      const largeToMedium = Math.max(1, Number(saleItem.large_to_medium) || 1);
      const mediumToSmall = Math.max(1, Number(saleItem.medium_to_small) || 1);
      const priorUnit = String(prior.unit || '').trim() || String(saleItem.unit || 'large');
      const priorLarge = unitQuantityInLarge(
        Number(prior.quantity_returned) || 0,
        priorUnit,
        largeToMedium,
        mediumToSmall,
        saleItem.medium_unit,
        saleItem.small_unit,
      );
      const priorInSaleUnit = largeQuantityInUnit(
        priorLarge,
        saleItem.unit,
        largeToMedium,
        mediumToSmall,
        saleItem.medium_unit,
        saleItem.small_unit,
      );
      const saleItemId = Number(saleItem.id);
      returnedQuantityBySaleItem.set(
        saleItemId,
        (returnedQuantityBySaleItem.get(saleItemId) || 0) + priorInSaleUnit,
      );
    }

    const priorRefund = await db.prepare(`
      SELECT COALESCE(SUM(total_refund), 0) AS total
      FROM returns
      WHERE invoice_id = ? AND LOWER(COALESCE(status, '')) IN ('approved', 'completed')
    `).get(invoiceId) as any;

    const isGenericPlaceholder = (name?: string) => !name || /^Drug\s*#?\s*\d+$/i.test(String(name).trim());

    return {
      success: true,
      data: {
        ...invoice,
        already_refunded: Number(priorRefund?.total || 0),
        items: items.map(i => {
          let resolvedName = i.trade_name;
          if (isGenericPlaceholder(resolvedName)) {
            if (i.trade_name_en && !isGenericPlaceholder(i.trade_name_en)) {
              resolvedName = i.trade_name_en;
            } else if (i.active_ingredient && !isGenericPlaceholder(i.active_ingredient)) {
              resolvedName = i.active_ingredient;
            }
          }
          return {
            id: i.id,
            inventory_id: i.inventory_id,
            drug_id: i.drug_id,
            drug_name: resolvedName || `صنف #${i.drug_id}`,
            drug_name_en: i.trade_name_en,
            quantity_sold: i.quantity_sold,
            returned_quantity: returnedQuantityBySaleItem.get(Number(i.id)) || 0,
            unit_price: i.unit_price,
            unit: i.unit,
            expiry_date: i.expiry_date,
            large_to_medium: i.large_to_medium,
            medium_to_small: i.medium_to_small,
            large_unit: i.large_unit,
            medium_unit: i.medium_unit,
            small_unit: i.small_unit,
          };
        })
      }
    };
  } catch (error) {
    console.error('Get invoice details error:', error);
    return { success: false, error: 'فشل جلب بيانات الفاتورة' };
  }
}
