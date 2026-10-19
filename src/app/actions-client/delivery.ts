
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';

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
import { format } from 'date-fns';
import { requireOpenShiftId } from './finance';
import { isTauri } from '@/lib/env';
const revalidatePath = (...args: any[]) => {};

// The renderer has no trusted financial state. This untrusted, minimal browser
// hint only preserves a request UUID across a reload so that the *native*,
// tenant/actor/sale/fee-bound receipt can be confirmed. Persist BEFORE invoking
// a write, or refuse to write at all. Never store patient data, actor or tenant.
const DELIVERY_PENDING_PREFIX = 'pharma.delivery.collection.pending.v1:';
type PendingDeliveryIntent = {
  version: 1;
  saleId: string;
  feeCents: number;
  requestId: string;
};
type DeliveryResult = { success: boolean; error?: string };
const nativeDeliveryRequests = new Map<string, PendingDeliveryIntent>();
const nativeDeliveryRecoveredPending = new Set<string>();
const nativeDeliveryInFlight = new Map<string, { feeCents: number; promise: Promise<DeliveryResult> }>();
const canonicalRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validDeliveryFeeCents(fee: number): number {
  if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000_000) {
    throw new Error('رسوم التوصيل غير صالحة');
  }
  const cents = Math.round(fee * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(fee * 100 - cents) > 0.0000001) {
    throw new Error('رسوم التوصيل يجب أن تكون بقروش صحيحة');
  }
  return cents;
}

function pendingDeliveryKey(saleId: string): string {
  if (!saleId || saleId.length > 128 || saleId.trim() !== saleId ||
      Array.from(saleId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('معرف فاتورة التوصيل غير صالح');
  }
  return DELIVERY_PENDING_PREFIX + encodeURIComponent(saleId);
}

function pendingDeliveryStorage(): Storage {
  // Accessing localStorage (not just setItem) can throw when offline storage is
  // blocked. A volatile nonce is unsafe across a reload after a lost write ACK.
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('لا يمكن حفظ هوية تحصيل التوصيل للاسترداد؛ التحصيل موقوف');
  }
  return globalThis.localStorage;
}

function loadPendingDeliveryIntent(saleId: string): PendingDeliveryIntent | null {
  const raw = pendingDeliveryStorage().getItem(pendingDeliveryKey(saleId));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('هوية تحصيل التوصيل المحفوظة غير قابلة للتحقق؛ راجع الإيصال قبل المتابعة');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('هوية تحصيل التوصيل المحفوظة غير قابلة للتحقق؛ راجع الإيصال قبل المتابعة');
  }
  const intent = value as Partial<PendingDeliveryIntent>;
  if (Object.keys(intent).sort().join(',') !== 'feeCents,requestId,saleId,version' ||
      intent.version !== 1 || intent.saleId !== saleId ||
      !Number.isSafeInteger(intent.feeCents) || (intent.feeCents as number) < 0 ||
      (intent.feeCents as number) > 100_000_000_000 ||
      typeof intent.requestId !== 'string' || !canonicalRequestId.test(intent.requestId)) {
    throw new Error('هوية تحصيل التوصيل المحفوظة غير قابلة للتحقق؛ راجع الإيصال قبل المتابعة');
  }
  return intent as PendingDeliveryIntent;
}

function savePendingDeliveryIntent(intent: PendingDeliveryIntent): void {
  const key = pendingDeliveryKey(intent.saleId);
  const storage = pendingDeliveryStorage();
  storage.setItem(key, JSON.stringify(intent));
  // A storage race must not silently replace a pending original nonce before
  // a native call. The native UNIQUE sale/nonce constraints remain authoritative
  // for true cross-tab contention; localStorage is not a transactional lock.
  const saved = loadPendingDeliveryIntent(intent.saleId);
  if (!saved || saved.requestId !== intent.requestId || saved.feeCents !== intent.feeCents) {
    throw new Error('تضارب هوية تحصيل التوصيل المحفوظة؛ راجع الإيصال قبل المتابعة');
  }
}

function clearPendingDeliveryIntent(intent: PendingDeliveryIntent): void {
  nativeDeliveryRequests.delete(intent.saleId);
  nativeDeliveryRecoveredPending.delete(intent.saleId);
  // A failed cleanup after a proven native success must not be represented as
  // a failed posting. A leftover hint is read-only confirmed on next reload.
  try {
    const stored = loadPendingDeliveryIntent(intent.saleId);
    if (stored?.requestId === intent.requestId) {
      pendingDeliveryStorage().removeItem(pendingDeliveryKey(intent.saleId));
    }
  } catch {
    // The native receipt is already confirmed; keep the recoverable nonce.
  }
}

async function closeNativeDeliveryCollection(invoiceId: string, deliveryFee: number,
  feeCents: number): Promise<DeliveryResult> {
  const previous = loadPendingDeliveryIntent(invoiceId);
  const inMemory = nativeDeliveryRequests.get(invoiceId);
  if (!previous && inMemory) {
    throw new Error('هوية تحصيل التوصيل السابقة غير محفوظة؛ تحقق من الإيصال قبل أي إعادة');
  }
  if (previous && previous.feeCents !== feeCents) {
    // Do not replace an ambiguous request by changing its fee. The only way
    // to settle uncertainty is its original actor/tenant/nonce/sale/fee proof.
    throw new Error('يوجد تحصيل توصيل سابق غير محسوم برسوم مختلفة؛ راجع إيصال الطلب الأصلي');
  }
  if (previous && inMemory && previous.requestId !== inMemory.requestId) {
    throw new Error('تضارب في هوية تحصيل التوصيل؛ راجع الإيصال قبل المتابعة');
  }
  const recoveredAfterReload = Boolean(previous && (!inMemory || nativeDeliveryRecoveredPending.has(invoiceId)));
  if (recoveredAfterReload) nativeDeliveryRecoveredPending.add(invoiceId);
  let intent = previous;
  if (!intent) {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      throw new Error('Secure collection request IDs are unavailable');
    }
    const requestId = crypto.randomUUID();
    if (!canonicalRequestId.test(requestId)) throw new Error('Invalid secure collection request ID');
    intent = { version: 1, saleId: invoiceId, feeCents, requestId };
    savePendingDeliveryIntent(intent);
  }
  nativeDeliveryRequests.set(invoiceId, intent);
  const payload = { saleId: invoiceId, deliveryFee, requestId: intent.requestId };
  const { invoke } = await import('@tauri-apps/api/core');
  const matchesRequest = (posted: NativeDeliveryReceipt | null): boolean =>
    posted?.id === `delivery-${intent.requestId}` && posted.saleId === invoiceId &&
    Number.isFinite(posted.deliveryFee) &&
    Math.abs(posted.deliveryFee * 100 - feeCents) < 0.0000001 &&
    Number.isFinite(posted.collectedAmount) && posted.collectedAmount > 0 &&
    posted.collectedAmount * 100 >= feeCents &&
    Math.abs(posted.collectedAmount * 100 - Math.round(posted.collectedAmount * 100)) < 0.0000001;

  if (recoveredAfterReload) {
    // Restart-safe reconciliation: never reissue a possibly committed financial
    // mutation until an ORIGINAL-nonce, read-only, native proof is checked.
    // If IPC cannot provide that proof, stop; offline reads prove no outcome.
    let existing: NativeDeliveryReceipt | null;
    try {
      existing = await invoke<NativeDeliveryReceipt | null>('confirm_delivery_collection_native', { payload });
    } catch {
      throw new Error('تعذر تأكيد تحصيل التوصيل السابق؛ احتفظ برقم الطلب وأعد محاولة التحقق');
    }
    if (existing !== null) {
      if (!matchesRequest(existing)) throw new Error('إيصال التحصيل السابق غير مطابق؛ يلزم التحقق قبل إعادة المحاولة');
      clearPendingDeliveryIntent(intent);
      revalidatePath('/sales/delivery');
      return { success: true };
    }
    // A null native receipt cannot prove the original actor/tenant has never
    // committed. A different logged-in actor must not turn an old browser hint
    // into a new cash movement. Reconciliation must be explicit and read-only.
    throw new Error('لم يثبت إيصال تحصيل الطلب السابق؛ يلزم مراجعة التحصيل قبل إعادة التسجيل');
  }

  // Check the persisted request identity once more after async native import or
  // confirmation. Another tab can change this untrusted hint at any moment;
  // SQLite's nonce and per-sale uniqueness are the final cross-window guard.
  const ready = loadPendingDeliveryIntent(invoiceId);
  if (!ready || ready.requestId !== intent.requestId || ready.feeCents !== feeCents) {
    throw new Error('هوية تحصيل التوصيل تغيرت أثناء التحقق؛ لا يمكن إعادة التسجيل');
  }
  try {
    const posted = await invoke<NativeDeliveryReceipt>('collect_delivery_native', { payload });
    if (!matchesRequest(posted)) throw new Error('Native delivery collection confirmation was incomplete');
  } catch (writeError) {
    // A failed IPC write may actually have COMMITTED. Only the existing strict
    // native proof can decide. Never claim success from a queue/Chromium read.
    let confirmed: NativeDeliveryReceipt | null = null;
    try {
      confirmed = await invoke<NativeDeliveryReceipt | null>('confirm_delivery_collection_native', { payload });
    } catch {
      // Preserve the nonce, not a new write or a fabricated success.
    }
    if (!matchesRequest(confirmed)) throw writeError;
  }
  clearPendingDeliveryIntent(intent);
  revalidatePath('/sales/delivery');
  return { success: true };
}

function closeNativeDeliverySingleFlight(invoiceId: string, fee: number): Promise<DeliveryResult> {
  let feeCents: number;
  try {
    feeCents = validDeliveryFeeCents(fee);
    pendingDeliveryKey(invoiceId);
  } catch (error) {
    return Promise.resolve({ success: false, error: error instanceof Error ? error.message : 'بيانات تحصيل غير صالحة' });
  }
  const running = nativeDeliveryInFlight.get(invoiceId);
  if (running) {
    if (running.feeCents !== feeCents) {
      return Promise.resolve({ success: false, error: 'يجري تحصيل فاتورة التوصيل برسوم أخرى؛ لا يمكن تقديم طلب ثانٍ' });
    }
    return running.promise;
  }
  const promise = closeNativeDeliveryCollection(invoiceId, fee, feeCents).catch(error => ({
    success: false, error: error instanceof Error ? error.message : 'تعذر التحقق من تحصيل التوصيل',
  }));
  nativeDeliveryInFlight.set(invoiceId, { feeCents, promise });
  void promise.finally(() => {
    if (nativeDeliveryInFlight.get(invoiceId)?.promise === promise) {
      nativeDeliveryInFlight.delete(invoiceId);
    }
  });
  return promise;
}

export type DeliveryQueueCursor = { createdAt: string; id: string };
type NativeDeliveryPage = { rows: any[]; hasMore: boolean; nextCursor: DeliveryQueueCursor | null };
type NativeDeliveryReceipt = { id: string; saleId: string; deliveryFee: number; collectedAmount: number };

export async function getPendingDeliveriesAction(cursor?: DeliveryQueueCursor | null) {
  try {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const page = await invoke<NativeDeliveryPage>('list_pending_deliveries_native', { cursor: cursor ?? null });
      if (!Array.isArray(page?.rows) || typeof page.hasMore !== 'boolean' ||
          (page.hasMore && (!page.nextCursor?.id || typeof page.nextCursor?.createdAt !== 'string'))) {
        throw new Error('Incomplete native delivery page');
      }
      return { success: true, data: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    const pharmacyId = user.pharmacy_id || 'local_default';
    const pharmacyClause = ` AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))`;
    const invoices = await db.prepare(`
      SELECT 
        si.*, 
        p.full_name as patient_name,
        p.address as patient_address,
        p.phone as patient_phone
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.payment_method = 'delivery' AND si.status = 'completed'${pharmacyClause}
      ORDER BY si.created_at DESC
    `).all(pharmacyId, pharmacyId) as any[];

    return { success: true, data: invoices, hasMore: false, nextCursor: null };
  } catch (error) {
    return { success: false, error: 'فشل جلب فواتير التوصيل' };
  }
}

export async function closeDeliveryInvoiceAction(invoiceId: string, deliveryFee: number) {
  try {
    if (isTauri) {
      return await closeNativeDeliverySingleFlight(invoiceId, deliveryFee);
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) return { success: false, error: 'رسوم التوصيل غير صالحة' };

    const transaction = db.transaction(async (db) => {
      const pharmacyId = user.pharmacy_id || 'local_default';
      const pharmacyClause = ` AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))`;
      const invoiceParams = [invoiceId, pharmacyId, pharmacyId];
      // 1. Fetch invoice info to get total
      const invoice = await db.prepare(`SELECT total_amount FROM sales_invoices WHERE id = ? AND payment_method = 'delivery' AND status = 'completed'${pharmacyClause}`).get(...invoiceParams) as any;
      if (!invoice) throw new Error('فاتورة التوصيل غير موجودة أو تم تحصيلها بالفعل');
      const shiftId = await requireOpenShiftId(user.id, undefined, db);
      const totalCollected = Number(invoice.total_amount || 0) + deliveryFee;
      const originalTotal = Number(invoice.total_amount || 0);

      // 2. Update invoice status and total
      const updated = await db.prepare(`UPDATE sales_invoices SET status = 'delivered', total_amount = ? WHERE id = ? AND status = 'completed'${pharmacyClause}`).run(totalCollected, invoiceId, pharmacyId, pharmacyId);
      if (updated.changes !== 1) throw new Error('تم تحصيل فاتورة التوصيل بالفعل');

      // 3. Automatically record cash receipt (Handover from driver)
      const receiptId = generateId();
      await db.prepare(`
        INSERT INTO cash_movements (
          id, user_id, shift_id, type, category, amount, notes, date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId, user.id, shiftId, 'receipt', 'delivery',
        totalCollected, `Delivery Closed: Invoice #${invoiceId.substring(0, 8)} (incl. Fee: ${deliveryFee})`,
        format(new Date(), 'yyyy-MM-dd')
      );

      const getAccountId = async (category: string, fallback: number) => {
        const setting = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ? LIMIT 1').get(category) as any;
        return Number(setting?.account_id || fallback);
      };
      const cashAccount = await getAccountId('cash_drawer', 6);
      const receivableAccount = await getAccountId('accounts_receivable', 8);
      const salesAccount = await getAccountId('sales_revenue', 9);
      const originalPosting = await db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN je.account_id = ? AND je.type = 'debit' THEN je.amount ELSE 0 END), 0) AS cash_debit,
          COALESCE(SUM(CASE WHEN je.account_id = ? AND je.type = 'debit' THEN je.amount ELSE 0 END), 0) AS receivable_debit
        FROM journal_entries je
        JOIN daily_journals dj ON dj.id = je.journal_id
        WHERE dj.description LIKE ?
          AND (dj.pharmacy_id = ? OR (dj.pharmacy_id IS NULL AND ? = 'local_default'))
      `).get(cashAccount, receivableAccount, `%${invoiceId.substring(0, 8)}%`, pharmacyId, pharmacyId) as any;
      const legacyCashPosting = originalTotal > 0.000001
        && Number(originalPosting?.cash_debit || 0) + 0.005 >= originalTotal
        && Number(originalPosting?.receivable_debit || 0) + 0.005 < originalTotal;

      if (legacyCashPosting) {
        const correctionId = generateId();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(correctionId, format(new Date(), 'yyyy-MM-dd'), `تصحيح محاسبة توصيل قديم #${invoiceId.substring(0, 8)}`, user.id, originalTotal);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(correctionId, receivableAccount, 'debit', originalTotal);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(correctionId, cashAccount, 'credit', originalTotal);
        await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
          .run(user.id, 'LEGACY_DELIVERY_ACCOUNTING_CORRECTED', `Reclassified legacy delivery invoice ${invoiceId} from cash to receivable before collection`);
      }

      const journalId = generateId();
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, format(new Date(), 'yyyy-MM-dd'), `تحصيل توصيل فاتورة #${invoiceId.substring(0, 8)}`, user.id, totalCollected);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, cashAccount, 'debit', totalCollected);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, receivableAccount, 'credit', originalTotal);
      if (deliveryFee > 0.000001) {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, salesAccount, 'credit', deliveryFee);
      }

      // 4. Log Activity
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'DELIVERY_CLOSED', `Closed delivery invoice ${invoiceId} with fee ${deliveryFee}. Total collected: ${totalCollected}`);
    });

    await transaction();
    revalidatePath('/sales/delivery');
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'فشل إغلاق فاتورة التوصيل' };
  }
}

export async function getRepresentativeCashStatementAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    // Get all pending delivery invoices (completed but not yet handed over)
    const pharmacyId = user.pharmacy_id || 'local_default';
    const pharmacyClause = ` AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))`;
    const pharmacyParams = [pharmacyId, pharmacyId];
    const pending = await db.prepare(`
      SELECT 
        si.id, 
        si.total_amount, 
        si.created_at, 
        p.full_name as patient_name,
        u.full_name as created_by_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      JOIN users u ON si.user_id = u.id
      WHERE si.payment_method = 'delivery' AND si.status = 'completed'${pharmacyClause}
    `).all(...pharmacyParams) as any[];

    const history = await db.prepare(`
      SELECT 
        si.id, 
        si.total_amount, 
        si.created_at, 
        p.full_name as patient_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.payment_method = 'delivery' AND si.status = 'delivered'${pharmacyClause}
      ORDER BY si.created_at DESC LIMIT 20
    `).all(...pharmacyParams) as any[];

    const totalPending = pending.reduce((sum, inv) => sum + inv.total_amount, 0);

    return { 
      success: true, 
      data: {
        pending,
        history,
        total_pending_amount: totalPending
      } 
    };
  } catch (error) {
    console.error('Rep statement error:', error);
    return { success: false, error: 'فشل جلب كشف حساب المناديب' };
  }
}
