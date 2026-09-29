import { secureCache } from '@/lib/cache/secure_cache';
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId, type TransactionDb } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
import { purchaseReturnRemainingLargeQuantity } from '@/lib/purchases/return-units';
import { buildPurchaseAccountingPlan } from '@/lib/purchases/accounting-policy';
import {
  assertCompletedPurchaseExpiryPolicy,
  assertNoDuplicatePurchaseLots,
  assertPurchaseItemsPolicy,
  assertPurchaseLifecyclePolicy,
  calculatePurchaseAllocation,
  normalizePurchaseDateToYMD as normalizeDateToYMD,
  purchaseLotIdentity,
} from '@/lib/purchases/policy';
import { format } from 'date-fns';
import { requireOpenShiftId } from './finance';
import { isBusinessDate, localDate } from '@/lib/time';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { hasRecoveredStock } from '@/lib/inventory/reorder-state';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
let migrationDone = false;
async function ensureBarcodeColumn() {
  if (migrationDone) return;
  try {
    const cols = await dbSelect("PRAGMA table_info(purchase_invoice_items)");
    const hasBarcode = cols.some((c: any) => c.name === 'barcode');
    if (!hasBarcode) {
      await dbExecute("ALTER TABLE purchase_invoice_items ADD COLUMN barcode TEXT");
    }
  } catch (e) {
    // ponytail: migration safe fallback
  }
  migrationDone = true;
}
const clearAuditLogs = async () => {
  try {
    await dbExecute('DELETE FROM activity_log');
    return true;
  } catch (e) {
    console.error('Failed to clear activity logs:', e);
    return false;
  }
};

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

async function getOwnedPurchaseInvoice(invoiceId: string, pharmacyId: string, scopedDb: PurchaseDb = db) {
  return scopedDb.prepare(`
    SELECT *
    FROM purchase_invoices
    WHERE id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
  `).get(invoiceId, pharmacyId, pharmacyId) as Promise<any>;
}

type PurchaseDb = Pick<TransactionDb, 'prepare'>;

async function assertPurchaseConversionPermission(
  user: any,
  items: any[],
  scopedDb: PurchaseDb = db,
) {
  if (hasUserPermissionSync(user, 'can_modify_unit_conversion')) return;

  const requested = items
    .map(item => ({
      drugId: Number(item?.id ?? item?.drug_id),
      // Match the effective factor used by both the JS fallback and the
      // native payload. An omitted/zero factor is normalized to 1 downstream,
      // so it must be permission-checked as 1 here instead of being skipped.
      conversion: Number(item?.strips_per_box || item?.large_to_medium || 1),
    }))
    .filter(item => Number.isSafeInteger(item.drugId) && item.drugId > 0);
  if (requested.length === 0) return;

  const ids = [...new Set(requested.map(item => item.drugId))];
  const currentRows = await scopedDb.prepare(`
    SELECT id, COALESCE(NULLIF(large_to_medium, 0), 1) AS large_to_medium
    FROM master_drugs
    WHERE id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as any[];
  const currentById = new Map(currentRows.map(row => [Number(row.id), Number(row.large_to_medium || 1)]));

  for (const item of requested) {
    const current = currentById.get(item.drugId);
    if (current !== undefined && Number(item.conversion) !== current) {
      throw new Error('غير مصرح بتعديل معاملات التحويل');
    }
  }
}

async function resolveShortageIfStockRecovered(
  scopedDb: PurchaseDb,
  drugId: number,
  pharmacyId: string | null | undefined,
) {
  const pharmacyScope = pharmacyId || 'local_default';
  if (!await hasRecoveredStock(scopedDb, drugId, pharmacyScope)) return;
  await scopedDb.prepare(`
    UPDATE shortages
    SET status = 'received'
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND (status IN ('pending', 'ordered') OR status IS NULL OR status = '')
  `).run(drugId, pharmacyScope, pharmacyScope);
}

async function markPendingShortageQuantityOrdered(
  scopedDb: PurchaseDb,
  drugId: number,
  pharmacyId: string,
  orderedQuantity: number,
) {
  let remaining = Math.max(0, Number(orderedQuantity) || 0);
  if (remaining <= 0) return;

  const pendingRows = await scopedDb.prepare(`
    SELECT id, requested_quantity, priority, notes
    FROM shortages
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND status = 'pending'
    ORDER BY created_at ASC, id ASC
  `).all(drugId, pharmacyId, pharmacyId) as any[];

  for (const row of pendingRows) {
    if (remaining <= 0) break;
    const requested = Math.max(0, Number(row.requested_quantity) || 0);
    if (requested <= 0) continue;

    if (remaining >= requested) {
      await scopedDb.prepare(`
        UPDATE shortages SET status = 'ordered'
        WHERE id = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          AND status = 'pending'
      `).run(row.id, pharmacyId, pharmacyId);
      remaining -= requested;
      continue;
    }

    const orderedPart = remaining;
    const pendingRemainder = requested - orderedPart;
    await scopedDb.prepare(`
      UPDATE shortages
      SET requested_quantity = ?, status = 'ordered'
      WHERE id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        AND status = 'pending'
    `).run(orderedPart, row.id, pharmacyId, pharmacyId);
    await scopedDb.prepare(`
      INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status, priority, notes)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(drugId, pharmacyId, pendingRemainder, row.priority || 'normal', row.notes || null);
    remaining = 0;
  }
}

async function coalescePendingShortageDemand(
  scopedDb: PurchaseDb,
  drugId: number,
  pharmacyId: string,
) {
  const pendingRows = await scopedDb.prepare(`
    SELECT id, requested_quantity
    FROM shortages
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND status = 'pending'
    ORDER BY created_at ASC, id ASC
  `).all(drugId, pharmacyId, pharmacyId) as Array<{ id: number | string; requested_quantity: number }>;
  if (pendingRows.length <= 1) return;

  const totalRequested = pendingRows.reduce(
    (sum, row) => sum + Math.max(0, Number(row.requested_quantity) || 0),
    0,
  );
  const keepId = pendingRows[0].id;
  await scopedDb.prepare(`
    UPDATE shortages
    SET requested_quantity = ?
    WHERE id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND status = 'pending'
  `).run(totalRequested, keepId, pharmacyId, pharmacyId);
  await scopedDb.prepare(`
    DELETE FROM shortages
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND status = 'pending'
      AND id != ?
  `).run(drugId, pharmacyId, pharmacyId, keepId);
}

async function resolvePurchaseAccountId(
  category: string,
  canonicalCode: string,
  scopedDb: PurchaseDb = db,
) {
  const configured = await scopedDb.prepare(`
    SELECT a.id
    FROM trial_balance_settings t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.category = ? AND a.code = ?
    ORDER BY t.id
    LIMIT 1
  `).get(category, canonicalCode) as any;
  if (configured?.id) return Number(configured.id);

  const fallback = await scopedDb.prepare('SELECT id FROM accounts WHERE code = ? LIMIT 1').get(canonicalCode) as any;
  if (!fallback?.id) throw new Error(`Missing accounting mapping: ${category}`);
  return Number(fallback.id);
}

async function addToInventory(data: {
  drugId: number | string;
  pharmacyId: string | null | undefined;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  expiryDate: string | null;
  batchNumber: string;
  stripsPerBox: number;
  barcode?: string | null;
}, scopedDb: PurchaseDb = db) {
  const pharmacyId = data.pharmacyId || 'local_default';
  const conversion = await scopedDb.prepare(
    'SELECT COALESCE(NULLIF(medium_to_small, 0), 1) AS medium_to_small FROM master_drugs WHERE id = ?'
  ).get(data.drugId) as any;
  const mediumToSmall = Math.max(1, Number(conversion?.medium_to_small) || 1);
  const existing = await scopedDb.prepare(`
    SELECT id
    FROM inventory
    WHERE drug_id = ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND (expiry_date = ? OR (expiry_date IS NULL AND ? IS NULL))
      AND batch_number = ?
    ORDER BY created_at ASC
    LIMIT 1
  `).get(
    data.drugId,
    pharmacyId,
    pharmacyId,
    data.expiryDate,
    data.expiryDate,
    data.batchNumber
  ) as any;

  if (existing) {
    await scopedDb.prepare(`
      UPDATE inventory
      SET quantity = quantity + ?,
          local_selling_price = ?,
          cost_price = ?,
          expiry_date = ?,
          batch_number = ?,
          strips_per_box = ?,
          medium_to_small = ?,
          barcode = CASE
            WHEN (barcode IS NULL OR TRIM(barcode) = '') AND ? != '' THEN ?
            ELSE barcode
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.quantity,
      data.sellingPrice,
      data.costPrice,
      data.expiryDate,
      data.batchNumber,
      data.stripsPerBox,
      mediumToSmall,
      data.barcode?.trim() || '',
      data.barcode?.trim() || '',
      existing.id
    );
    return String(existing.id);
  }

  const inventoryId = generateId();
  await scopedDb.prepare(`
    INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, batch_number, strips_per_box, medium_to_small, barcode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inventoryId,
    data.drugId,
    pharmacyId,
    data.quantity,
    data.sellingPrice,
    data.costPrice,
    data.expiryDate,
    data.batchNumber,
    data.stripsPerBox,
    mediumToSmall,
    data.barcode?.trim() || null
  );
  return inventoryId;
}

async function purchaseMediumToSmall(drugId: number | string, scopedDb: PurchaseDb = db) {
  const row = await scopedDb.prepare(
    'SELECT COALESCE(NULLIF(medium_to_small, 0), 1) AS medium_to_small FROM master_drugs WHERE id = ?'
  ).get(drugId) as any;
  return Math.max(1, Number(row?.medium_to_small) || 1);
}

function purchaseBatchKey(invoiceId: string) {
  return `PURCHASE-${invoiceId}`;
}

function purchaseJournalDescription(invoiceId: string) {
  return `Purchase invoice [id=${invoiceId}]`;
}

function browserPurchaseMutationUnsupported() {
  return !isTauri && typeof window !== 'undefined';
}

async function assertPurchaseBarcodesAvailable(cart: any[] = [], scopedDb: PurchaseDb = db) {
  const owners = new Map<string, string>();
  for (const item of cart) {
    const state = await scopedDb.prepare('SELECT stop_dealing FROM master_drugs WHERE id=?').get(item.id || item.drug_id) as any;
    if (!state) throw new Error('الصنف غير موجود؛ أزله من الفاتورة وأضفه من جديد');
    if (Number(state?.stop_dealing) === 1) throw new Error('هذا الصنف مؤرشف أو متوقف؛ أزله من الفاتورة أو أعد تفعيله من إدارة الأصناف');
    const barcode = String(item.barcode || '').trim();
    if (!barcode) continue;
    const drugId = String(item.id || item.drug_id);
    const cartOwner = owners.get(barcode.toLowerCase());
    if (cartOwner && cartOwner !== drugId) throw new Error('الباركود مستخدم لصنف آخر');
    owners.set(barcode.toLowerCase(), drugId);

    const conflict = await scopedDb.prepare(`
      SELECT id AS drug_id FROM master_drugs
      WHERE id != ? AND barcode IS NOT NULL AND TRIM(barcode) = ? COLLATE NOCASE
      UNION ALL
      SELECT drug_id FROM inventory
      WHERE drug_id != ? AND barcode IS NOT NULL AND TRIM(barcode) = ? COLLATE NOCASE
        AND (quantity IS NULL OR quantity != 0)
      LIMIT 1
    `).get(item.id || item.drug_id, barcode, item.id || item.drug_id, barcode) as any;
    if (conflict) throw new Error('الباركود مستخدم لصنف آخر');
  }
}


const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local'

// Suppliers
type SupplierInput = {
  name_ar: string;
  name_en?: string;
  phone?: string;
  address?: string;
};

const SUPPLIER_PERMISSION_ERROR = 'غير مصرح لك بإدارة الموردين';
const SUPPLIER_NAME_ERROR = 'يجب إدخال اسم المورد';
const SUPPLIER_LINKED_RECORDS_ERROR = 'لا يمكن حذف المورد لوجود فواتير شراء أو مرتجعات أو حركات مالية مرتبطة به';

function canViewSuppliers(session: any): boolean {
  return !!session && (
    hasUserPermissionSync(session, 'can_view_suppliers')
    || hasUserPermissionSync(session, 'can_view_purchases')
  );
}

function canMutateSuppliers(session: any): boolean {
  return !!session
    && (session.role === 'owner' || session.role === 'admin')
    && hasUserPermissionSync(session, 'can_view_suppliers');
}

function normalizeSupplierInput(data: SupplierInput) {
  const nameAr = typeof data?.name_ar === 'string' ? data.name_ar.trim() : '';
  if (!nameAr) return null;

  const optionalText = (value?: string) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  };

  return {
    name_ar: nameAr,
    name_en: optionalText(data.name_en),
    phone: optionalText(data.phone),
    address: optionalText(data.address),
  };
}

export async function getSuppliersAction() {
  try {
    const session = await getLocalSession();
    if (!canViewSuppliers(session)) return { success: false, error: SUPPLIER_PERMISSION_ERROR };

    const items = await db.prepare(`
      SELECT 
        s.*,
        COALESCE(s.balance, 0) AS balance,
        (SELECT COUNT(*) FROM purchase_invoices WHERE supplier_id = s.id) AS purchase_count,
        (SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id = s.id) AS transaction_count
      FROM suppliers s
      ORDER BY s.name_ar ASC
    `).all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getSupplierTransactionsAction(supplierId: number) {
  try {
    const session = await getLocalSession();
    if (!canViewSuppliers(session)) return { success: false, error: SUPPLIER_PERMISSION_ERROR };

    const id = Number(supplierId);
    if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'معرف المورد غير صحيح' };

    const items = await db.prepare(`
      SELECT * FROM supplier_transactions 
      WHERE supplier_id = ? 
      ORDER BY datetime(COALESCE(created_at, CURRENT_TIMESTAMP)) DESC, id DESC
      LIMIT 100
    `).all(id);

    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addSupplierPaymentAction(rawData: {
  supplier_id: number;
  amount: number;
  payment_method?: 'cash' | 'bank' | 'check';
  check_number?: string;
  notes?: string;
  date?: string;
}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_suppliers') || !hasUserPermissionSync(session, 'acc_can_process_cash_flow')) {
      return { success: false, error: SUPPLIER_PERMISSION_ERROR };
    }

    const supplierId = Number(rawData.supplier_id);
    const amount = Number(rawData.amount);
    if (!Number.isInteger(supplierId) || supplierId <= 0) return { success: false, error: 'معرف المورد غير صحيح' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'يرجى إدخال مبلغ صحيح أكبر من الصفر' };

    const paymentMethod = rawData.payment_method || 'cash';
    const checkNumber = String(rawData.check_number || '').trim();
    if (paymentMethod === 'check' && !checkNumber) return { success: false, error: 'يرجى إدخال رقم الشيك' };
    const paymentDate = rawData.date || localDate();
    if (!isBusinessDate(paymentDate)) return { success: false, error: 'تاريخ سداد المورد غير صالح' };
    const notes = rawData.notes ? String(rawData.notes).trim() : '';

    let remainingBalance = 0;
    const refId = `sup-pay-${Date.now()}`;

    await dbTransaction(async (db) => {
      const supplier = await db.prepare('SELECT id, name_ar, balance FROM suppliers WHERE id = ?').get(supplierId) as any;
      if (!supplier) throw new Error('المورد غير موجود');

      const currentBalance = Number(supplier.balance || 0);

      // 1. Decrease supplier balance
      await db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id = ?').run(amount, supplierId);

      // 2. Record in supplier_transactions
      const transactionNote = notes 
        ? `سداد دفعة (${paymentMethod === 'check' ? `شيك ${checkNumber}` : paymentMethod === 'bank' ? 'تحويل بنكي' : 'نقدي'}): ${notes}`
        : `سداد دفعة للمورد (${paymentMethod === 'check' ? `شيك ${checkNumber}` : paymentMethod === 'bank' ? 'تحويل بنكي' : 'نقدي'})`;

      await db.prepare(`
        INSERT INTO supplier_transactions (supplier_id, user_id, type, amount, reference_id, payment_method, notes, date, created_at)
        VALUES (?, ?, 'payment', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(supplierId, session.id, amount, refId, paymentMethod, transactionNote, paymentDate);

      // 3. Record in cash_movements if cash
      if (paymentMethod === 'cash') {
        const shiftId = await requireOpenShiftId(session.id, undefined, db);
        const movementId = generateId();
        await db.prepare(`
          INSERT INTO cash_movements (
            id, user_id, shift_id, type, category, amount, source_type, target_name, notes, date
          ) VALUES (?, ?, ?, 'disbursement', 'accounts_payable', ?, 'supplier_payment', ?, ?, ?)
        `).run(
          movementId,
          session.id,
          shiftId,
          amount,
          String(supplierId),
          `سداد دفعة للمورد ${supplier.name_ar}: ${notes}`,
          paymentDate
        );
      }

      // 4. Accounting entries
      try {
        const payableAccountId = await resolvePurchaseAccountId('accounts_payable', '2.1', db);
        const creditAccountId = paymentMethod === 'cash'
          ? await resolvePurchaseAccountId('cash_drawer', '1.1.1', db)
          : await resolvePurchaseAccountId('bank_clearing', '1.1.4', db);

        const journalId = generateId();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, paymentDate, `سداد دفعة للمورد: ${supplier.name_ar}`, session.id, amount);

        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, payableAccountId, 'debit', amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, creditAccountId, 'credit', amount);
      } catch (accErr) {
        throw new Error('تعذر تسجيل القيد المحاسبي لدفعة المورد؛ تم إلغاء العملية');
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        session.id,
        'SUPPLIER_PAYMENT',
        `Paid ${amount} to supplier #${supplierId} (${supplier.name_ar}) via ${paymentMethod}`
      );
      remainingBalance = currentBalance - amount;
    });

    revalidatePath('/purchases/suppliers');
    revalidatePath('/purchases');
    return { success: true, remainingBalance };
  } catch (error: any) {
    console.error('Supplier payment error:', error?.message || error);
    return { success: false, error: error.message || 'فشل تسجيل الدفعة للمورد' };
  }
}

export async function addSupplierAction(data: SupplierInput) {
  try {
    const session = await getLocalSession();
    if (!canMutateSuppliers(session)) return { success: false, error: SUPPLIER_PERMISSION_ERROR };
    const supplier = normalizeSupplierInput(data);
    if (!supplier) return { success: false, error: SUPPLIER_NAME_ERROR };

    const stmt = await db.prepare('INSERT INTO suppliers (name_ar, name_en, phone, address) VALUES (?, ?, ?, ?)');
    const result = await stmt.run(supplier.name_ar, supplier.name_en, supplier.phone, supplier.address);
    revalidatePath('/purchases/suppliers');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateSupplierAction(id: number, data: SupplierInput) {
  try {
    const session = await getLocalSession();
    if (!canMutateSuppliers(session)) return { success: false, error: SUPPLIER_PERMISSION_ERROR };

    const supplierId = Number(id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return { success: false, error: 'معرف المورد غير صحيح' };
    }
    const supplier = normalizeSupplierInput(data);
    if (!supplier) return { success: false, error: SUPPLIER_NAME_ERROR };

    const result = await db.prepare(`
      UPDATE suppliers
      SET name_ar = ?,
          name_en = CASE WHEN ? = 1 THEN ? ELSE name_en END,
          phone = CASE WHEN ? = 1 THEN ? ELSE phone END,
          address = CASE WHEN ? = 1 THEN ? ELSE address END
      WHERE id = ?
    `).run(
      supplier.name_ar,
      data.name_en === undefined ? 0 : 1,
      supplier.name_en,
      data.phone === undefined ? 0 : 1,
      supplier.phone,
      data.address === undefined ? 0 : 1,
      supplier.address,
      supplierId
    );
    if (result.changes !== 1) return { success: false, error: 'المورد غير موجود' };

    revalidatePath('/purchases/suppliers');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteSupplierAction(id: number) {
  try {
    const session = await getLocalSession();
    if (!canMutateSuppliers(session)) return { success: false, error: SUPPLIER_PERMISSION_ERROR };

    const supplierId = Number(id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return { success: false, error: 'معرف المورد غير صحيح' };
    }

    const linkedRecords = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_invoices WHERE supplier_id = ?) AS purchase_count,
        (SELECT COUNT(*) FROM purchase_returns WHERE supplier_id = ?) AS return_count,
        (SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id = ?) AS transaction_count,
        (
          SELECT COUNT(*) FROM financial_notices
          WHERE target_type = 'supplier' AND CAST(target_id AS TEXT) = CAST(? AS TEXT)
        ) AS notice_count
    `).get(supplierId, supplierId, supplierId, supplierId) as any;

    if (
      Number(linkedRecords?.purchase_count || 0) > 0
      || Number(linkedRecords?.return_count || 0) > 0
      || Number(linkedRecords?.transaction_count || 0) > 0
      || Number(linkedRecords?.notice_count || 0) > 0
    ) {
      return { success: false, error: SUPPLIER_LINKED_RECORDS_ERROR };
    }

    // Repeat the checks in the DELETE so a concurrent purchase cannot turn a
    // safe preflight into an unsafe deletion.
    const result = await db.prepare(`
      DELETE FROM suppliers
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM purchase_invoices WHERE supplier_id = ?)
        AND NOT EXISTS (SELECT 1 FROM purchase_returns WHERE supplier_id = ?)
        AND NOT EXISTS (SELECT 1 FROM supplier_transactions WHERE supplier_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM financial_notices
          WHERE target_type = 'supplier' AND CAST(target_id AS TEXT) = CAST(? AS TEXT)
        )
    `).run(supplierId, supplierId, supplierId, supplierId, supplierId);
    if (result.changes !== 1) {
      const supplier = await db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
      return {
        success: false,
        error: supplier ? SUPPLIER_LINKED_RECORDS_ERROR : 'المورد غير موجود',
      };
    }

    revalidatePath('/purchases/suppliers');
    return { success: true };
  } catch (error: any) {
    const message = String(error?.message || error || '');
    if (message.includes('FOREIGN KEY constraint failed')) {
      return { success: false, error: SUPPLIER_LINKED_RECORDS_ERROR };
    }
    return { success: false, error: message || 'فشل حذف المورد' };
  }
}

// Purchase Invoices
export async function getPurchaseInvoicesAction() {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const pharmacyId = session.pharmacy_id || 'local_default';
    const items = await db.prepare(`
      SELECT i.*, s.name_ar as supplier_name, s.phone as supplier_phone,
             u.full_name as user_name,
             (
               SELECT GROUP_CONCAT(md.trade_name, ' ')
               FROM purchase_invoice_items pii
               JOIN master_drugs md ON pii.drug_id = md.id
               WHERE pii.invoice_id = i.id
             ) as drug_names
      FROM purchase_invoices i
      JOIN suppliers s ON i.supplier_id = s.id
      LEFT JOIN users u ON i.user_id = u.id
      WHERE i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default')
      ORDER BY i.created_at DESC
    `).all(pharmacyId, pharmacyId);
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function checkSupplierPendingInvoiceAction(supplierId: number) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const pharmacyId = session.pharmacy_id || 'local_default';
    const pending = await db.prepare(`
      SELECT id, invoice_number, invoice_date, payment_method, notes, check_number,
             expenses, discount_value, discount_percent, tax_percent
      FROM purchase_invoices
      WHERE supplier_id = ? AND status = 'draft'
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY created_at DESC
      LIMIT 1
    `).get(supplierId, pharmacyId, pharmacyId) as any;
    return { success: true, hasPending: !!pending, invoice: pending };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function createPurchaseInvoiceAction(data: { 
  supplier_id: number, 
  invoice_number?: string, 
  invoice_date?: string,
  payment_method?: string,
  notes?: string,
  check_number?: string,
  expenses?: number,
  discount_value?: number,
  discount_percent?: number,
  tax_percent?: number,
  status?: string,
  cart?: any[],
  id?: string
}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    if (browserPurchaseMutationUnsupported()) return { success: false, error: 'تعديل المشتريات من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب' };
    assertPurchaseLifecyclePolicy(data);
    assertPurchaseItemsPolicy(data.cart || [], data.status || 'completed');
    if (data.invoice_date && !isBusinessDate(data.invoice_date)) return { success: false, error: 'تاريخ فاتورة الشراء غير صالح' };
    if ((data.cart || []).some(item => item.expiry_date && !normalizeDateToYMD(item.expiry_date))) {
      return { success: false, error: 'يوجد تاريخ صلاحية غير صالح في أصناف الفاتورة' };
    }
    assertNoDuplicatePurchaseLots(data.cart || []);
    if ((data.status || 'completed') !== 'draft') {
      assertCompletedPurchaseExpiryPolicy(data.cart || []);
    }
    await assertPurchaseConversionPermission(session, data.cart || []);

    await ensureBarcodeColumn();
    if (!isTauri) await assertPurchaseBarcodesAvailable(data.cart || []);
    if (data.id) {
      const pharmacyId = session.pharmacy_id || 'local_default';
      const ownedDraft = await db.prepare(`
        SELECT id FROM purchase_invoices
        WHERE id = ? AND status = 'draft'
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      `).get(data.id, pharmacyId, pharmacyId);
      if (!ownedDraft) return { success: false, error: 'Purchase draft not found in this pharmacy' };
    }

    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke('save_purchase_invoice_critical', {
        payload: {
          ...data,
          pharmacy_id: session.pharmacy_id || null,
          user_id: String(session.id || 'admin'),
          supplier_id: Number(data.supplier_id),
          status: data.status || 'completed',
          cart: (data.cart || []).map(item => ({
            ...item,
            id: Number(item.id || item.drug_id),
            quantity: Number(item.quantity || 0),
            unit_id: item.unit_id ? Number(item.unit_id) : null,
            cost_price: Number(item.cost_price || 0),
            selling_price: item.selling_price != null ? Number(item.selling_price) : null,
            bonus_quantity: Number(item.bonus_quantity || 0),
            tax_percent: Number(item.tax_percent || 0),
            discount_percent: Number(item.discount_percent || 0),
            strips_per_box: Number(item.strips_per_box || item.large_to_medium || 1),
            barcode: item.barcode || null
          }))
        }
      }) as any;
      if ((data.status || 'completed') !== 'draft') notifyInventoryChanged();
      revalidatePath('/purchases');
      revalidatePath('/inventory');
      revalidatePath('/inventory/low-stock');
      revalidatePath('/stores/shortages');
      revalidatePath('/purchases/suppliers');
      revalidatePath('/');
      return { success: true, id: result?.id };
    }

    const cacheUpdates: Array<{ drugId: number; patch: Record<string, unknown> }> = [];
    const transaction = db.transaction(async (db) => {
      await assertPurchaseConversionPermission(session, data.cart || [], db);
      await assertPurchaseBarcodesAvailable(data.cart || [], db);
      const id = data.id || generateId();
      if (data.id) {
        await db.prepare('DELETE FROM purchase_invoice_items WHERE invoice_id = ?').run(id);
        await db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(id);
      }
      const finalStatus = data.status === 'draft' ? 'draft' : 'completed';

      const stmt = await db.prepare(`
        INSERT INTO purchase_invoices (
          id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date, 
          payment_method, notes, check_number, expenses, discount_value, 
          discount_percent, tax_percent, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      await stmt.run(
        id, 
        data.supplier_id, 
        session.pharmacy_id, 
        session.id, 
        data.invoice_number || null, 
        data.invoice_date || localDate(),
        data.payment_method || 'credit',
        data.notes || null,
        data.check_number || null,
        data.expenses || 0,
        data.discount_value || 0,
        data.discount_percent || 0,
        data.tax_percent || 0,
        finalStatus
      );

      const allocation = finalStatus === 'completed' ? calculatePurchaseAllocation(data.cart || [], data) : null;

      if (data.cart && data.cart.length > 0) {
        const itemStmt = await db.prepare(`
          INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, medium_to_small, barcode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [index, item] of data.cart.entries()) {
          const normExpiry = normalizeDateToYMD(item.expiry_date);
          const mediumToSmall = await purchaseMediumToSmall(item.id, db);
          const purchaseItemResult = await itemStmt.run(
            id,
            item.id,
            item.quantity,
            item.unit_id || null,
            normExpiry,
            item.cost_price,
            item.selling_price || null,
            item.bonus_quantity || 0,
            item.tax_percent || 0,
            item.discount_percent || 0,
            item.strips_per_box || 1,
            mediumToSmall,
            item.barcode || null
          );

          if (item.strips_per_box) {
            await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.id);
            cacheUpdates.push({ drugId: Number(item.id), patch: { large_to_medium: item.strips_per_box } });
          }

          if (item.barcode) {
            const masterUpdate = await db.prepare("UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = '')").run(item.barcode.trim(), item.id);
            if (masterUpdate.changes > 0) {
              cacheUpdates.push({ drugId: Number(item.id), patch: { barcode: item.barcode.trim() } });
            }
          }

          if (finalStatus === 'completed') {
            const totalReceivedQty = Number(item.quantity) + Number(item.bonus_quantity || 0);
            const netUnitCost = allocation!.netUnitCosts[index];

            const inventoryId = await addToInventory({
              drugId: item.id,
              pharmacyId: session.pharmacy_id,
              quantity: totalReceivedQty,
              sellingPrice: item.selling_price || 0,
              costPrice: netUnitCost,
              expiryDate: normExpiry,
              batchNumber: purchaseBatchKey(id),
              stripsPerBox: item.strips_per_box || 1,
              barcode: item.barcode,
            }, db);
            await db.prepare('UPDATE purchase_invoice_items SET inventory_id = ? WHERE id = ?').run(
              inventoryId,
              purchaseItemResult.lastInsertRowid
            );

            const drugId = Number(item.id || item.drug_id);
            await resolveShortageIfStockRecovered(db, drugId, session.pharmacy_id);
          }
        }
      }

      if (finalStatus === 'completed') {
        const finalTotal = allocation!.finalTotal;
        const paymentMethod = data.payment_method || 'credit';
        const accountingPlan = buildPurchaseAccountingPlan(paymentMethod, finalTotal);

        await db.prepare('UPDATE purchase_invoices SET total_amount = ? WHERE id = ?').run(finalTotal, id);

        const journalId = generateId();
        const purchaseDate = data.invoice_date || localDate();
        
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, purchaseDate, purchaseJournalDescription(id), session.id, finalTotal);

        const accounts = {
          cash: await resolvePurchaseAccountId('cash_drawer', '1.1.1', db),
          payable: await resolvePurchaseAccountId('accounts_payable', '2.1', db),
          inventory: await resolvePurchaseAccountId('inventory_asset', '1.1.3', db),
        };

        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', finalTotal);

        if (accountingPlan.supplierBalanceDelta !== 0) {
          await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(accountingPlan.supplierBalanceDelta, data.supplier_id);
        }
        const typeLabel = paymentMethod === 'check' ? 'شيك' : paymentMethod === 'credit' ? 'آجل' : 'نقدي';
        const supplierNote = `فاتورة شراء (${typeLabel}) رقم ${data.invoice_number || id}`;
        for (const supplierTransaction of accountingPlan.supplierTransactions) {
          await db.prepare('INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, ?, ?, ?, ?)').run(
            data.supplier_id,
            supplierTransaction.type,
            supplierTransaction.amount,
            id,
            supplierTransaction.type === 'payment' ? `سداد نقدي لـ ${supplierNote}` : supplierNote,
          );
        }
        const settlementAccountId = accountingPlan.settlementAccount === 'payable' ? accounts.payable : accounts.cash;
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, settlementAccountId, 'credit', finalTotal);

        if (accountingPlan.cashMovement) {
          const shiftId = await requireOpenShiftId(String(session.id), undefined, db);
          await db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
            generateId(), session.id, shiftId, accountingPlan.cashMovement.type, accountingPlan.cashMovement.amount, 'purchases', purchaseJournalDescription(id), localDate()
          );
        }

        await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
          session.id,
          'COMPLETE_PURCHASE',
          `أكمل فاتورة شراء بقيمة: ${finalTotal.toFixed(2)}`
        );
      }

      return id;
    });

    const invoiceId = await transaction();
    for (const update of cacheUpdates) {
      secureCache.updateDrug(update.drugId, update.patch);
    }

    if (data.status !== 'draft') notifyInventoryChanged();
    revalidatePath('/purchases');
    revalidatePath('/inventory');
    revalidatePath('/inventory/low-stock');
    revalidatePath('/stores/shortages');
    revalidatePath('/purchases/suppliers');
    revalidatePath('/');
    
    return { success: true, id: invoiceId };
  } catch (error: any) {
    console.error('createPurchaseInvoiceAction error:', error?.message || error);
    return { success: false, error: error?.message || String(error) || 'فشل تسجيل الفاتورة' };
  }
}

export async function addPurchaseInvoiceItemAction(invoiceId: string, item: {
  drug_id: number | string,
  quantity: number,
  unit_id?: number,
  expiry_date?: string,
  cost_price: number,
  selling_price?: number,
  bonus_quantity?: number,
  tax_percent?: number,
  discount_percent?: number,
  strips_per_box?: number
}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = session.pharmacy_id || 'local_default';
    let conversionToCache: number | null = null;
    await dbTransaction(async (scopedDb) => {
      const ownedInvoice = await getOwnedPurchaseInvoice(invoiceId, pharmacyId, scopedDb);
      if (!ownedInvoice) throw new Error('Purchase invoice not found in this pharmacy');
      if (ownedInvoice.status !== 'draft') throw new Error('Only draft purchase invoices can accept new items');
      await assertPurchaseConversionPermission(session, [{ ...item, id: item.drug_id }], scopedDb);

      const normExpiry = normalizeDateToYMD(item.expiry_date);
      const mediumToSmall = await purchaseMediumToSmall(item.drug_id, scopedDb);
      await scopedDb.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, medium_to_small)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invoiceId,
        item.drug_id,
        item.quantity,
        item.unit_id || null,
        normExpiry,
        item.cost_price,
        item.selling_price || null,
        item.bonus_quantity || 0,
        item.tax_percent || 0,
        item.discount_percent || 0,
        item.strips_per_box || 1,
        mediumToSmall
      );

      if (item.strips_per_box) {
        await scopedDb.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.drug_id);
        conversionToCache = item.strips_per_box;
      }
    });
    if (conversionToCache !== null) {
      secureCache.updateDrug(Number(item.drug_id), { large_to_medium: conversionToCache });
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function completePurchaseInvoiceAction(invoiceId: string) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    if (browserPurchaseMutationUnsupported()) return { success: false, error: 'تعديل المشتريات من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب' };
    const pharmacyId = session.pharmacy_id || 'local_default';
    const ownedInvoice = await getOwnedPurchaseInvoice(invoiceId, pharmacyId);
    if (!ownedInvoice) return { success: false, error: 'Purchase invoice not found in this pharmacy' };
    if (ownedInvoice.status !== 'draft') return { success: false, error: 'Only draft purchase invoices can be completed' };
    if (ownedInvoice.payment_method === 'check' && !String(ownedInvoice.check_number || '').trim()) {
      return { success: false, error: 'رقم الشيك مطلوب قبل إكمال فاتورة الشراء' };
    }

    const cacheUpdates: Array<{ drugId: number; largeToMedium: number }> = [];
    const transaction = db.transaction(async (db) => {
      const claimed = await db.prepare(`
        UPDATE purchase_invoices
        SET status = 'processing'
        WHERE id = ? AND status = 'draft'
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          AND (payment_method <> 'check' OR NULLIF(TRIM(check_number), '') IS NOT NULL)
      `).run(invoiceId, pharmacyId, pharmacyId);
      if (claimed.changes !== 1) {
        throw new Error('Only an unclaimed draft with complete payment details can be completed');
      }

      // Re-read after the atomic claim so stock and accounting use the exact
      // header version that was claimed, not a stale pre-transaction snapshot.
      const invoice = await db.prepare('SELECT * FROM purchase_invoices WHERE id = ? AND status = ?').get(invoiceId, 'processing') as any;
      if (!invoice) throw new Error('Claimed purchase invoice could not be reloaded');
      if (!['cash', 'credit', 'check'].includes(String(invoice.payment_method || ''))) {
        throw new Error('Invalid purchase payment method');
      }
      if (invoice.payment_method === 'check' && !String(invoice.check_number || '').trim()) {
        throw new Error('رقم الشيك مطلوب قبل إكمال فاتورة الشراء');
      }
      const items = await db.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id = ?').all(invoiceId) as any[];
      assertPurchaseItemsPolicy(items, 'completed');
      assertNoDuplicatePurchaseLots(items.map(item => ({ ...item, id: item.drug_id })));
      assertCompletedPurchaseExpiryPolicy(items);
      await assertPurchaseConversionPermission(session, items.map(item => ({ ...item, id: item.drug_id })), db);
      await assertPurchaseBarcodesAvailable(items.map(item => ({ ...item, id: item.drug_id })), db);

      const allocation = calculatePurchaseAllocation(items, invoice);
      for (const [index, item] of items.entries()) {

        const totalReceivedQty = Number(item.quantity) + Number(item.bonus_quantity || 0);
        const netUnitCost = allocation.netUnitCosts[index];

        const inventoryId = await addToInventory({
          drugId: item.drug_id,
          pharmacyId: session.pharmacy_id,
          quantity: totalReceivedQty,
          sellingPrice: item.selling_price || 0,
          costPrice: netUnitCost,
          expiryDate: item.expiry_date,
          batchNumber: purchaseBatchKey(invoiceId),
          stripsPerBox: item.strips_per_box || 1,
          barcode: item.barcode,
        }, db);
        await db.prepare('UPDATE purchase_invoice_items SET inventory_id = ? WHERE id = ?').run(inventoryId, item.id);

        if (item.strips_per_box) {
          await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.drug_id);
          cacheUpdates.push({ drugId: Number(item.drug_id), largeToMedium: Number(item.strips_per_box) });
        }

        const drugId = Number(item.drug_id || item.id);
        await resolveShortageIfStockRecovered(db, drugId, session.pharmacy_id);
      }

      const finalTotal = allocation.finalTotal;
      const accountingPlan = buildPurchaseAccountingPlan(invoice.payment_method || 'credit', finalTotal);

      // 4. Update invoice total and status
      const completed = await db.prepare(`
        UPDATE purchase_invoices SET total_amount = ?, status = 'completed'
        WHERE id = ? AND status = 'processing'
      `).run(finalTotal, invoiceId);
      if (completed.changes !== 1) throw new Error('Purchase invoice completion state changed unexpectedly');

      // 5. Update supplier balance or record cash payment
      const journalId = generateId();
      const purchaseDate = invoice.invoice_date || localDate();
      
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, purchaseDate, purchaseJournalDescription(invoiceId), session.id, finalTotal);

      const accounts = {
        cash: await resolvePurchaseAccountId('cash_drawer', '1.1.1', db),
        payable: await resolvePurchaseAccountId('accounts_payable', '2.1', db),
        inventory: await resolvePurchaseAccountId('inventory_asset', '1.1.3', db),
      };

      // Inventory Entry: Debit Inventory Asset, Credit Cash/Payable
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', finalTotal);

      if (accountingPlan.supplierBalanceDelta !== 0) {
        const supplierUpdate = await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(accountingPlan.supplierBalanceDelta, invoice.supplier_id);
        if (supplierUpdate.changes !== 1) throw new Error('Purchase invoice supplier no longer exists');
      }
      const typeLabel = invoice.payment_method === 'check' ? 'شيك' : invoice.payment_method === 'credit' ? 'آجل' : 'نقدي';
      const supplierNote = `فاتورة شراء (${typeLabel}) رقم ${invoice.invoice_number || invoiceId}`;
      for (const supplierTransaction of accountingPlan.supplierTransactions) {
        await db.prepare('INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, ?, ?, ?, ?)').run(
          invoice.supplier_id,
          supplierTransaction.type,
          supplierTransaction.amount,
          invoiceId,
          supplierTransaction.type === 'payment' ? `سداد نقدي لـ ${supplierNote}` : supplierNote,
        );
      }
      const settlementAccountId = accountingPlan.settlementAccount === 'payable' ? accounts.payable : accounts.cash;
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, settlementAccountId, 'credit', finalTotal);

      if (accountingPlan.cashMovement) {
        const shiftId = await requireOpenShiftId(String(session.id), undefined, db);
        await db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          generateId(), session.id, shiftId, accountingPlan.cashMovement.type, accountingPlan.cashMovement.amount, 'purchases', purchaseJournalDescription(invoiceId), localDate()
        );
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        session.id,
        'COMPLETE_PURCHASE',
        `أكمل فاتورة شراء بقيمة: ${finalTotal.toFixed(2)}`
      );
      return { finalTotal };
    });

    const { finalTotal } = await transaction();
    for (const update of cacheUpdates) {
      secureCache.updateDrug(update.drugId, { large_to_medium: update.largeToMedium });
    }
    notifyInventoryChanged();
    revalidatePath('/purchases');
    revalidatePath('/inventory');
    revalidatePath('/inventory/low-stock');
    revalidatePath('/stores/shortages');
    revalidatePath('/purchases/suppliers');
    revalidatePath('/');
    
    return { success: true };
  } catch (error: any) {
    console.error('Complete purchase error:', error);
    return { success: false, error: error.message };
  }
}

export async function getDrugPurchaseHistoryAction(drugId: number) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = session.pharmacy_id || 'local_default';

    const items = await db.prepare(`
      SELECT pi.invoice_date, pi.invoice_number, pii.quantity, pii.cost_price, s.name_ar as supplier_name
      FROM purchase_invoice_items pii
      JOIN purchase_invoices pi ON pii.invoice_id = pi.id
      JOIN suppliers s ON pi.supplier_id = s.id
      WHERE pii.drug_id = ? AND pi.status = 'completed'
        AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY pi.invoice_date DESC, pi.created_at DESC
      LIMIT 5
    `).all(drugId, pharmacyId, pharmacyId);
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function createPurchaseOrderAction(data: { supplier_name: string; notes?: string; items: { drug_id: number; quantity: number; expected_price: number }[]; }) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_purchases') && !hasUserPermissionSync(user, 'can_view_restock'))) {
      return { success: false, error: 'Unauthorized' };
    }
    const pharmacyId = user.pharmacy_id || 'local_default';

    if (!data.supplier_name?.trim()) return { success: false, error: 'Supplier name is required' };
    if (!data.items || data.items.length === 0) return { success: false, error: 'لا توجد أصناف في الطلب' };
    if (data.items.some(i => !Number.isFinite(i.quantity) || i.quantity <= 0 || !Number.isFinite(i.expected_price) || i.expected_price < 0)) {
      return { success: false, error: 'Invalid purchase order quantity or expected price' };
    }
    const drugIds = [...new Set(data.items.map(item => Number(item.drug_id)))];
    if (drugIds.some(id => !Number.isInteger(id) || id <= 0)) return { success: false, error: 'Invalid purchase order drug' };
    const existingDrugs = await db.prepare(`
      SELECT id FROM master_drugs WHERE id IN (${drugIds.map(() => '?').join(',')})
    `).all(...drugIds) as any[];
    if (existingDrugs.length !== drugIds.length) return { success: false, error: 'One or more purchase order drugs do not exist' };

    const po_id = 'PO-' + generateId().substring(0, 8).toUpperCase();
    const total_amount = data.items.reduce((sum, item) => sum + (item.quantity * item.expected_price), 0);

    await dbTransaction(async (db) => {
      await db.execute('INSERT INTO purchase_orders (id, user_id, pharmacy_id, supplier_name, total_amount, notes) VALUES (?, ?, ?, ?, ?, ?)', [
        po_id,
        user.id,
        pharmacyId,
        data.supplier_name.trim(),
        total_amount,
        data.notes || null
      ]);

      for (const item of data.items) {
        await db.execute('INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price) VALUES (?, ?, ?, ?)', [
          po_id,
          item.drug_id,
          item.quantity,
          item.expected_price
        ]);
      }

      // Mark only the quantity actually placed on the PO as ordered. A smaller
      // operator-adjusted PO must leave the uncovered shortage remainder pending.
      for (const item of data.items) {
        await markPendingShortageQuantityOrdered(db, Number(item.drug_id), pharmacyId, Number(item.quantity));
      }

      await db.execute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [
        user.id,
        'Create PO',
        'PO created ' + po_id
      ]);
    });
    
    revalidatePath('/stores/shortages');
    revalidatePath('/purchase-orders');
    return { success: true, po_id };
  } catch (error: any) {
    console.error('createPurchaseOrderAction error:', error);
    return { success: false, error: error?.message || 'فشل إنشاء أمر الشراء' };
  }
}

export async function getPurchaseOrdersAction() {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_purchases') && !hasUserPermissionSync(user, 'can_view_restock'))) {
      return { success: false, error: 'Unauthorized' };
    }
    const pharmacyId = user.pharmacy_id || 'local_default';
    const orders = await db.prepare(`
      SELECT po.*, u.full_name as creator_name, COUNT(pii.id) as item_count 
      FROM purchase_orders po 
      LEFT JOIN users u ON po.user_id = u.id 
      LEFT JOIN purchase_order_items pii ON pii.po_id = po.id 
      WHERE po.pharmacy_id = ? OR (po.pharmacy_id IS NULL AND ? = 'local_default')
      GROUP BY po.id 
      ORDER BY po.created_at DESC
    `).all(pharmacyId, pharmacyId);
    return { success: true, data: orders };
  } catch (error: any) {
    console.error('getPurchaseOrdersAction error:', error);
    return { success: false, error: error.message };
  }
}

export async function updatePurchaseOrderStatusAction(poId: string, status: string) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_purchases') && !hasUserPermissionSync(user, 'can_view_restock'))) {
      return { success: false, error: 'Unauthorized' };
    }
    if (!['completed', 'cancelled'].includes(status)) return { success: false, error: 'Invalid purchase order status' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    const updated = await dbTransaction(async (scopedDb) => {
      const result = await scopedDb.prepare(`
        UPDATE purchase_orders
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      `).run(status, poId, pharmacyId, pharmacyId);
      if (result.changes !== 1) return false;

      if (status === 'cancelled') {
        const cancelledItems = await scopedDb.prepare(
          'SELECT DISTINCT drug_id FROM purchase_order_items WHERE po_id = ?'
        ).all(poId) as Array<{ drug_id: number }>;
        await scopedDb.prepare(`
          UPDATE shortages
          SET status = 'pending'
          WHERE status = 'ordered'
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            AND drug_id IN (
              SELECT drug_id FROM purchase_order_items WHERE po_id = ?
            )
            AND NOT EXISTS (
              SELECT 1
              FROM purchase_order_items other_item
              JOIN purchase_orders other_order ON other_order.id = other_item.po_id
              WHERE other_item.drug_id = shortages.drug_id
                AND other_order.id <> ?
                AND other_order.status = 'pending'
                AND (other_order.pharmacy_id = ? OR (other_order.pharmacy_id IS NULL AND ? = 'local_default'))
            )
        `).run(pharmacyId, pharmacyId, poId, poId, pharmacyId, pharmacyId);
        for (const item of cancelledItems) {
          const otherPendingOrder = await scopedDb.prepare(`
            SELECT 1
            FROM purchase_order_items other_item
            JOIN purchase_orders other_order ON other_order.id = other_item.po_id
            WHERE other_item.drug_id = ?
              AND other_order.id <> ?
              AND other_order.status = 'pending'
              AND (other_order.pharmacy_id = ? OR (other_order.pharmacy_id IS NULL AND ? = 'local_default'))
            LIMIT 1
          `).get(Number(item.drug_id), poId, pharmacyId, pharmacyId);
          if (!otherPendingOrder) {
            await coalescePendingShortageDemand(scopedDb, Number(item.drug_id), pharmacyId);
          }
          await resolveShortageIfStockRecovered(scopedDb, Number(item.drug_id), pharmacyId);
        }
      }
      return true;
    });
    if (!updated) return { success: false, error: 'Purchase order is missing or no longer pending' };

    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed' };
  }
}

export async function getPurchasesReportsAction(filters: any = {}) {
  try {
    const session = await getLocalSession();
    if (!session || (!hasUserPermissionSync(session, 'can_view_purchases') && !hasUserPermissionSync(session, 'rep_can_view_purchases'))) {
      return { success: false, error: 'Unauthorized' };
    }
    const pharmacyId = session.pharmacy_id || 'local_default';
    let sql = `
      SELECT DISTINCT i.*,
             s.name_ar as supplier_name,
             COALESCE(u.full_name, u.username, i.user_id, 'غير محدد') as staff_name,
             COALESCE((
               SELECT SUM(pii.quantity * COALESCE(pii.selling_price, md.official_price, 0))
               FROM purchase_invoice_items pii
               JOIN master_drugs md ON pii.drug_id = md.id
               WHERE pii.invoice_id = i.id
             ), 0) as total_selling_amount,
             COALESCE((
               SELECT SUM(
                 CAST(pii.quantity AS REAL) * CAST(pii.cost_price AS REAL)
                 * (1 + CAST(COALESCE(pii.tax_percent, 0) AS REAL) / 100.0)
                 * (1 + CAST(COALESCE(i.tax_percent, 0) AS REAL) / 100.0)
               )
               FROM purchase_invoice_items pii
               WHERE pii.invoice_id = i.id
             ), 0) + CAST(COALESCE(i.expenses, 0) AS REAL) AS gross_amount,
             MAX(0,
               COALESCE((
                 SELECT SUM(
                   CAST(pii.quantity AS REAL) * CAST(pii.cost_price AS REAL)
                   * (1 + CAST(COALESCE(pii.tax_percent, 0) AS REAL) / 100.0)
                   * (1 + CAST(COALESCE(i.tax_percent, 0) AS REAL) / 100.0)
                 )
                 FROM purchase_invoice_items pii
                 WHERE pii.invoice_id = i.id
               ), 0) + CAST(COALESCE(i.expenses, 0) AS REAL)
               - CAST(COALESCE(i.total_amount, 0) AS REAL)
             ) AS discount_amount
      FROM purchase_invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      LEFT JOIN users u ON i.user_id = u.id
    `;
    const params: any[] = [pharmacyId, pharmacyId];

    if (filters.drugName && filters.drugName.trim()) {
      sql += ` JOIN purchase_invoice_items pii_search ON pii_search.invoice_id = i.id JOIN master_drugs md_search ON pii_search.drug_id = md_search.id`;
    }

    sql += " WHERE (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))";
    if (filters.startDate) { sql += ' AND date(i.invoice_date) >= ?'; params.push(filters.startDate); }
    if (filters.endDate) { sql += ' AND date(i.invoice_date) <= ?'; params.push(filters.endDate); }
    if (filters.userId && filters.userId !== 'all') { sql += ' AND i.user_id = ?'; params.push(filters.userId); }
    if (filters.paymentMethod && filters.paymentMethod !== 'all') { sql += ' AND i.payment_method = ?'; params.push(filters.paymentMethod); }
    if (filters.supplierId && filters.supplierId !== 'all') { sql += ' AND i.supplier_id = ?'; params.push(filters.supplierId); }
    if (filters.status && filters.status !== 'all') {
      sql += ' AND i.status = ?'; params.push(filters.status);
    } else {
      sql += " AND i.status = 'completed'";
    }
    if (filters.invoiceNumber) { sql += ' AND i.invoice_number LIKE ?'; params.push('%' + filters.invoiceNumber + '%'); }
    if (filters.drugName && filters.drugName.trim()) {
      sql += ' AND (md_search.trade_name LIKE ? OR md_search.trade_name_en LIKE ? OR md_search.active_ingredient LIKE ?)';
      const term = '%' + filters.drugName.trim() + '%';
      params.push(term, term, term);
    }
    sql += ' ORDER BY date(i.invoice_date) DESC, i.created_at DESC';
    const items = await db.prepare(sql).all(...params) as any[];
    const totalCost = items.reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);
    const totalSelling = items.reduce((sum, inv) => sum + Number(inv.total_selling_amount || 0), 0);
    return { success: true, data: items, totalCost, totalSelling, invoiceCount: items.length };
  } catch (error: any) { return { success: false, error: error.message }; }
}

/**
 * Search purchase invoices across all suppliers and history by barcode, drug name, invoice number, or supplier name
 */
export async function searchPurchaseInvoicesForReturnAction(searchTerm: string) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized', data: [] };
    await ensureBarcodeColumn();
    const pharmacyId = session.pharmacy_id || 'local_default';
    const term = searchTerm.trim();
    if (!term) return { success: true, data: [] };

    const query = `
      SELECT DISTINCT 
        i.id, i.invoice_number, i.supplier_id, i.total_amount, i.invoice_date, i.created_at, i.status,
        s.name_ar as supplier_name
      FROM purchase_invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      LEFT JOIN purchase_invoice_items pii ON pii.invoice_id = i.id
      LEFT JOIN master_drugs md ON pii.drug_id = md.id
      WHERE (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (i.status = 'completed')
        AND (
          i.id LIKE ? OR
          i.invoice_number LIKE ? OR
          s.name_ar LIKE ? OR
          md.trade_name LIKE ? OR
          md.trade_name_en LIKE ? OR
          md.active_ingredient LIKE ? OR
          md.barcode = ? OR
          pii.barcode = ? OR
          md.barcode LIKE ? OR
          pii.barcode LIKE ? OR
          CAST(md.id AS TEXT) = ?
        )
      ORDER BY date(i.invoice_date) DESC, i.created_at DESC
      LIMIT 100
    `;
    const wildcard = `%${term}%`;
    const invoices = await db.prepare(query).all(
      pharmacyId, pharmacyId,
      wildcard, wildcard, wildcard, wildcard, wildcard, wildcard,
      term, term,
      wildcard, wildcard,
      term
    ) as any[];
    return { success: true, data: invoices };
  } catch (error: any) {
    console.error('searchPurchaseInvoicesForReturnAction error:', error);
    return { success: false, error: error.message || 'فشل البحث في فواتير المشتريات', data: [] };
  }
}

export async function getPurchaseInvoiceDetailsAction(invoiceId: string) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    await ensureBarcodeColumn();
    const pharmacyId = session.pharmacy_id || 'local_default';
    let invoice = await db.prepare(`
      SELECT * FROM purchase_invoices
      WHERE id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(invoiceId, pharmacyId, pharmacyId) as any;

    if (!invoice) {
      const matches = await db.prepare(`
        SELECT * FROM purchase_invoices
        WHERE invoice_number = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        ORDER BY created_at DESC
        LIMIT 2
      `).all(invoiceId, pharmacyId, pharmacyId) as any[];
      if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous purchase invoice number' : 'Purchase invoice not found');
      invoice = matches[0];
    }

    const loadItems = (itemInvoiceId: string) => db.prepare(`
      SELECT pii.*,
             COALESCE(
               NULLIF(NULLIF(d.trade_name, ''), 'Drug ' || d.id),
               NULLIF(NULLIF(d.trade_name_en, ''), 'Drug ' || d.id),
               d.trade_name,
               d.trade_name_en,
               'صنف #' || pii.drug_id
             ) AS trade_name,
             COALESCE(
               NULLIF(NULLIF(d.trade_name_en, ''), 'Drug ' || d.id),
               NULLIF(NULLIF(d.trade_name, ''), 'Drug ' || d.id),
               d.trade_name_en,
               d.trade_name,
               'صنف #' || pii.drug_id
             ) AS trade_name_en,
             COALESCE(NULLIF(pii.barcode, ''), NULLIF(lot.barcode, ''), d.barcode) AS barcode,
             d.large_to_medium,
             COALESCE(NULLIF(pii.medium_to_small, 0), NULLIF(d.medium_to_small, 0), 1) AS medium_to_small,
             d.official_price as base_price, u.name_en as unit,
             COALESCE(pii.selling_price, d.official_price, 0) as selling_price,
             lot.expiry_date AS inventory_expiry_date,
             lot.batch_number,
             lot.pharmacy_id AS inventory_pharmacy_id
      FROM purchase_invoice_items pii
      JOIN master_drugs d ON pii.drug_id = d.id
      LEFT JOIN units u ON pii.unit_id = u.id
      LEFT JOIN inventory lot ON lot.id = pii.inventory_id
        AND (lot.pharmacy_id = ? OR (lot.pharmacy_id IS NULL AND ? = 'local_default'))
      WHERE pii.invoice_id = ?
      ORDER BY pii.id
    `).all(pharmacyId, pharmacyId, itemInvoiceId) as Promise<any[]>;

    let items = await loadItems(String(invoice.id));
    if (!items.length && invoice.invoice_number) {
      const duplicateNumber = await db.prepare(`
        SELECT COUNT(*) AS count FROM purchase_invoices
        WHERE invoice_number = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      `).get(invoice.invoice_number, pharmacyId, pharmacyId) as any;
      if (Number(duplicateNumber?.count || 0) === 1) items = await loadItems(String(invoice.invoice_number));
    }

    const rawItemsTotal = items.reduce((sum, item) => sum
      + Number(item.quantity || 0) * Number(item.cost_price || 0)
      * (1 + Number(item.tax_percent || 0) / 100), 0);
    const invoiceTax = Number(invoice.tax_percent || 0);
    const taxedItemsTotal = rawItemsTotal * (1 + invoiceTax / 100);
    const paidFactor = taxedItemsTotal > Number.EPSILON
      ? (Math.max(0, taxedItemsTotal + Number(invoice.expenses || 0) - Number(invoice.discount_value || 0)) / taxedItemsTotal)
        * (1 - Number(invoice.discount_percent || 0) / 100)
      : 1;

    const priorReturns = await db.prepare(`
      SELECT pri.purchase_invoice_item_id, pri.inventory_id, pri.drug_id,
             pri.quantity_returned, COALESCE(pri.unit, 'large') AS unit
      FROM purchase_return_items pri
      JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
      WHERE pr.purchase_invoice_id = ? AND pr.status = 'completed'
    `).all(String(invoice.id)) as any[];

    const data = items.map(item => {
      const largeToMedium = Math.max(1, Number(item.strips_per_box || item.large_to_medium || 1));
      const mediumToSmall = Math.max(1, Number(item.medium_to_small || 1));
      const matchingReturns = priorReturns
        .filter(previous => Number(previous.purchase_invoice_item_id) === Number(item.id)
          || (!previous.purchase_invoice_item_id
            && String(previous.inventory_id || '') === String(item.inventory_id || '')
            && Number(previous.drug_id) === Number(item.drug_id)))
        .map(previous => ({
          quantity: Number(previous.quantity_returned || 0),
          unit: normalizePurchaseReturnUnit(previous.unit) || 'large' as const,
        }));
      const remainingLarge = purchaseReturnRemainingLargeQuantity(
        Number(item.quantity || 0), matchingReturns, largeToMedium, mediumToSmall
      );
      const returnedLarge = Math.max(0, Number(item.quantity || 0) - remainingLarge);
      const refundableLargeUnitPrice = Number(item.cost_price || 0)
        * (1 + Number(item.tax_percent || 0) / 100)
        * (1 + invoiceTax / 100)
        * paidFactor;
      const lineGrossAmount = Number(item.quantity || 0)
        * Number(item.cost_price || 0)
        * (1 + Number(item.tax_percent || 0) / 100)
        * (1 + invoiceTax / 100);
      const lineNetAmount = lineGrossAmount * paidFactor;
      return {
        ...item,
        returned_large_quantity: returnedLarge,
        remaining_large_quantity: remainingLarge,
        refundable_large_unit_price: refundableLargeUnitPrice,
        line_gross_amount: lineGrossAmount,
        line_discount_amount: Math.max(0, lineGrossAmount - lineNetAmount),
        line_net_amount: lineNetAmount,
      };
    });
    return { success: true, data };
  } catch (error: any) { return { success: false, error: error.message }; }
}

type PurchaseReturnRequest = {
  purchase_invoice_id: string;
  supplier_id: number;
  reason: string;
  items: {
    inventory_id?: string;
    purchase_invoice_item_id?: number;
    drug_id: number;
    drug_name: string;
    quantity: number;
    unit_price: number;
    unit?: string;
  }[];
  refund_method: 'cash' | 'credit';
};

type ValidatedPurchaseReturnLine = {
  id: number;
  drug_id: number;
  drug_name: string;
  quantity: number;
  bonus_quantity: number;
  refundable_large_unit_price: number;
  inventory_id: string | null;
  large_to_medium: number;
  medium_to_small: number;
};

function purchaseReturnQuantityInLargeUnits(
  quantity: number,
  unit: string | undefined,
  largeToMedium: number,
  mediumToSmall: number
) {
  if (unit === 'medium') return quantity / Math.max(1, largeToMedium);
  if (unit === 'small') return quantity / (Math.max(1, largeToMedium) * Math.max(1, mediumToSmall));
  return quantity;
}

function normalizePurchaseReturnUnit(unit: string | undefined): 'large' | 'medium' | 'small' | null {
  switch ((unit || 'large').trim().toLowerCase()) {
    case 'large': case 'box': return 'large';
    case 'medium': case 'strip': return 'medium';
    case 'small': case 'unit': case 'pill': return 'small';
    default: return null;
  }
}

async function validatePurchaseReturnRequest(
  data: PurchaseReturnRequest,
  session: { pharmacy_id?: string | null },
  scopedDb?: Pick<TransactionDb, 'get' | 'select'>,
) {
  const invoice = scopedDb
    ? await scopedDb.get<any>('SELECT * FROM purchase_invoices WHERE id = ?', [data.purchase_invoice_id])
    : await dbGet<any>('SELECT * FROM purchase_invoices WHERE id = ?', [data.purchase_invoice_id]);
  if (!invoice || invoice.status !== 'completed') {
    throw new Error('Completed purchase invoice not found');
  }
  if (Number(invoice.supplier_id) !== Number(data.supplier_id)) {
    throw new Error('Purchase invoice does not belong to the selected supplier');
  }

  const invoicePharmacy = invoice.pharmacy_id || 'local_default';
  const sessionPharmacy = session.pharmacy_id || 'local_default';
  if (invoicePharmacy !== sessionPharmacy) {
    throw new Error('Purchase invoice belongs to another pharmacy');
  }
  const allInvoiceLines = scopedDb
    ? await scopedDb.select<any>('SELECT * FROM purchase_invoice_items WHERE invoice_id = ? ORDER BY id', [data.purchase_invoice_id])
    : await dbSelect<any>('SELECT * FROM purchase_invoice_items WHERE invoice_id = ? ORDER BY id', [data.purchase_invoice_id]);
  const allocation = calculatePurchaseAllocation(allInvoiceLines, invoice);
  const allocationByLine = new Map(allInvoiceLines.map((line, index) => [Number(line.id), allocation.netUnitCosts[index]]));

  const itemIds = data.items.map(item => Number(item.purchase_invoice_item_id));
  if (itemIds.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error('Every returned item must reference its purchase invoice line');
  }
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error('Duplicate purchase invoice lines are not allowed in one return');
  }

  const placeholders = itemIds.map(() => '?').join(',');
  const invoiceLines = scopedDb ? await scopedDb.select<any>(`
    SELECT pii.id, pii.drug_id, pii.quantity, pii.bonus_quantity, pii.inventory_id, md.trade_name AS drug_name,
           COALESCE(NULLIF(pii.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
           COALESCE(NULLIF(pii.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small
    FROM purchase_invoice_items pii
    JOIN master_drugs md ON md.id = pii.drug_id
    WHERE pii.invoice_id = ? AND pii.id IN (${placeholders})
  `, [data.purchase_invoice_id, ...itemIds]) : await dbSelect<any>(`
    SELECT pii.id, pii.drug_id, pii.quantity, pii.bonus_quantity, pii.inventory_id, md.trade_name AS drug_name,
           COALESCE(NULLIF(pii.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
           COALESCE(NULLIF(pii.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small
    FROM purchase_invoice_items pii
    JOIN master_drugs md ON md.id = pii.drug_id
    WHERE pii.invoice_id = ? AND pii.id IN (${placeholders})
  `, [data.purchase_invoice_id, ...itemIds]);

  if (invoiceLines.length !== itemIds.length) {
    throw new Error('One or more return lines do not belong to the selected purchase invoice');
  }

  const linesById = new Map<number, ValidatedPurchaseReturnLine>(invoiceLines.map((line: any) => [
    Number(line.id),
    {
      id: Number(line.id),
      drug_id: Number(line.drug_id),
      drug_name: String(line.drug_name || line.drug_id),
      quantity: Number(line.quantity),
      bonus_quantity: Number(line.bonus_quantity || 0),
      refundable_large_unit_price: Number(allocationByLine.get(Number(line.id)))
        * (Number(line.quantity) + Number(line.bonus_quantity || 0)) / Number(line.quantity),
      inventory_id: line.inventory_id ? String(line.inventory_id) : null,
      large_to_medium: Math.max(1, Number(line.large_to_medium) || 1),
      medium_to_small: Math.max(1, Number(line.medium_to_small) || 1),
    }
  ]));

  const previousReturns = scopedDb ? await scopedDb.select<any>(`
    SELECT pri.purchase_invoice_item_id, pri.quantity_returned, COALESCE(pri.unit, 'large') AS unit
    FROM purchase_return_items pri
    JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
    WHERE pr.purchase_invoice_id = ?
      AND pr.status = 'completed'
      AND pri.purchase_invoice_item_id IN (${placeholders})
  `, [data.purchase_invoice_id, ...itemIds]) : await dbSelect<any>(`
    SELECT pri.purchase_invoice_item_id, pri.quantity_returned, COALESCE(pri.unit, 'large') AS unit
    FROM purchase_return_items pri
    JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
    WHERE pr.purchase_invoice_id = ?
      AND pr.status = 'completed'
      AND pri.purchase_invoice_item_id IN (${placeholders})
  `, [data.purchase_invoice_id, ...itemIds]);

  const previouslyReturned = new Map<number, number>();
  for (const previous of previousReturns) {
    const lineId = Number(previous.purchase_invoice_item_id);
    const line = linesById.get(lineId);
    if (!line) continue;
    const quantity = purchaseReturnQuantityInLargeUnits(
      Number(previous.quantity_returned) || 0,
      previous.unit,
      line.large_to_medium,
      line.medium_to_small
    );
    previouslyReturned.set(lineId, (previouslyReturned.get(lineId) || 0) + quantity);
  }

  for (const item of data.items) {
    const lineId = Number(item.purchase_invoice_item_id);
    const line = linesById.get(lineId)!;
    if (Number(item.drug_id) !== line.drug_id) {
      throw new Error('Returned drug does not match its purchase invoice line');
    }
    if (line.inventory_id && item.inventory_id && String(item.inventory_id) !== line.inventory_id) {
      throw new Error('Returned inventory batch does not match its purchase invoice line');
    }

    const requested = purchaseReturnQuantityInLargeUnits(
      Number(item.quantity),
      normalizePurchaseReturnUnit(item.unit)!,
      line.large_to_medium,
      line.medium_to_small
    );
    if (!line.inventory_id) throw new Error('Historical purchase line has no linked batch; use the desktop app');
    const sharedBatch = scopedDb
      ? await scopedDb.get<{ count: number }>('SELECT COUNT(*) AS count FROM purchase_invoice_items WHERE inventory_id = ? AND id <> ?', [line.inventory_id, lineId])
      : await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM purchase_invoice_items WHERE inventory_id = ? AND id <> ?', [line.inventory_id, lineId]);
    if (Number(sharedBatch?.count || 0) > 0) throw new Error('Purchase batch is shared by multiple invoice lines; use the desktop app');
    const prior = previouslyReturned.get(lineId) || 0;
    if (prior + requested > line.quantity + 0.000001) {
      const remaining = Math.max(0, line.quantity - prior);
      throw new Error(`Return quantity exceeds the invoice remainder (${remaining.toFixed(2)} large units available)`);
    }
  }

  return linesById;
}

export async function createPurchaseReturnAction(data: PurchaseReturnRequest) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) {
      return { success: false, error: 'Unauthorized' };
    }
    if (browserPurchaseMutationUnsupported()) return { success: false, error: 'تعديل المشتريات من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب' };
    const invalidItem = data.items?.some(item =>
      !Number.isFinite(Number(item.quantity))
      || Number(item.quantity) <= 0
      || !Number.isInteger(Number(item.purchase_invoice_item_id))
      || Number(item.purchase_invoice_item_id) <= 0
      || !normalizePurchaseReturnUnit(item.unit)
    );
    if (
      !data.purchase_invoice_id
      || !Number.isInteger(Number(data.supplier_id))
      || Number(data.supplier_id) <= 0
      || !data.items?.length
      || invalidItem
      || !['cash', 'credit'].includes(data.refund_method)
    ) {
      return { success: false, error: 'Invalid purchase return data' };
    }

    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<any>('create_purchase_return_critical', {
        payload: {
          purchase_invoice_id: data.purchase_invoice_id,
          supplier_id: Number(data.supplier_id),
          user_id: String(session.id),
          pharmacy_id: session.pharmacy_id || 'local_default',
          reason: data.reason || null,
          refund_method: data.refund_method,
          items: data.items.map(item => ({
            purchase_invoice_item_id: Number(item.purchase_invoice_item_id),
            quantity: Number(item.quantity),
            unit: normalizePurchaseReturnUnit(item.unit),
          })),
        },
      });
      notifyInventoryChanged();
      revalidatePath('/purchases/returns');
      revalidatePath('/inventory');
      return { success: true, id: result.return_id };
    }

    await dbExecute('ALTER TABLE purchase_return_items ADD COLUMN purchase_invoice_item_id INTEGER').catch(() => {});
    await dbExecute("ALTER TABLE purchase_return_items ADD COLUMN unit TEXT DEFAULT 'large'").catch(() => {});

    const transaction = db.transaction(async (db) => {
      const returnId = generateId();
      let totalAmount = 0;
      const validatedLines = await validatePurchaseReturnRequest(data, session, db);

      for (const item of data.items) {
        const line = validatedLines.get(Number(item.purchase_invoice_item_id))!;
        const unit = normalizePurchaseReturnUnit(item.unit)!;
        totalAmount += purchaseReturnQuantityInLargeUnits(Number(item.quantity), unit, line.large_to_medium, line.medium_to_small)
          * line.refundable_large_unit_price;
      }

      await db.prepare(`
        INSERT INTO purchase_returns (id, purchase_invoice_id, supplier_id, user_id, reason, total_amount, refund_method, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')
      `).run(returnId, data.purchase_invoice_id, data.supplier_id, session.id, data.reason || null, totalAmount, data.refund_method);

      const itemStmt = await db.prepare(`
        INSERT INTO purchase_return_items (purchase_return_id, purchase_invoice_item_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, total_price, unit, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of data.items) {
        const sourceLine = validatedLines.get(Number(item.purchase_invoice_item_id))!;
        const returnUnit = normalizePurchaseReturnUnit(item.unit)!;
        const returnedPaidLarge = purchaseReturnQuantityInLargeUnits(
          Number(item.quantity),
          returnUnit,
          sourceLine.large_to_medium,
          sourceLine.medium_to_small
        );
        const deductQty = returnedPaidLarge * (sourceLine.quantity + sourceLine.bonus_quantity) / sourceLine.quantity;
        const lineTotal = returnedPaidLarge * sourceLine.refundable_large_unit_price;
        const unitPrice = lineTotal / Number(item.quantity);
        const requestedInventoryId = sourceLine.inventory_id || item.inventory_id;
        const pharmacyId = session.pharmacy_id || 'local_default';

        const inventory = requestedInventoryId
          ? await db.prepare(`
              SELECT id, drug_id, quantity
              FROM inventory
              WHERE id = ? AND drug_id = ?
                AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            `).get(requestedInventoryId, sourceLine.drug_id, pharmacyId, pharmacyId) as any
          : await db.prepare(`
              SELECT id, drug_id, quantity
              FROM inventory
              WHERE drug_id = ?
                AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                AND quantity + 0.000001 >= ?
              ORDER BY expiry_date ASC
              LIMIT 1
            `).get(sourceLine.drug_id, pharmacyId, pharmacyId, deductQty) as any;
        if (!inventory || Number(inventory.drug_id) !== sourceLine.drug_id || Number(inventory.quantity) + 0.000001 < deductQty) {
          throw new Error(`Insufficient inventory for ${item.drug_name}`);
        }
        await itemStmt.run(returnId, item.purchase_invoice_item_id || null, inventory.id, sourceLine.drug_id, sourceLine.drug_name, item.quantity, unitPrice, lineTotal, returnUnit, data.reason || null);
        const stockUpdate = await db.prepare(`
          UPDATE inventory
          SET quantity = CASE WHEN quantity - ? < 0 THEN 0 ELSE quantity - ? END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND drug_id = ?
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            AND quantity + 0.000001 >= ?
        `).run(deductQty, deductQty, inventory.id, sourceLine.drug_id, pharmacyId, pharmacyId, deductQty);
        if (stockUpdate.changes !== 1) throw new Error(`Inventory changed for ${item.drug_name}; please retry`);
      }

      // Financial impact
      if (data.refund_method === 'credit') {
        // We returned items, so our debt to supplier decreases
        await db.prepare(`
          INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
          VALUES (?, 'return', ?, ?, ?)
        `).run(data.supplier_id, totalAmount, returnId, data.reason || 'مرتجع مشتريات');
        // Decrease supplier balance
        await db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id = ?').run(totalAmount, data.supplier_id);
      } else if (data.refund_method === 'cash') {
        const shiftId = await requireOpenShiftId(String(session.id), undefined, db);
        await db.prepare(`
          INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, notes, date)
          VALUES (?, ?, ?, 'receipt', 'purchase_return', ?, ?, ?)
        `).run(generateId(), session.id, shiftId, totalAmount, `مرتجع مشتريات نقدي للمورد رقم ${data.supplier_id}`, new Date().toLocaleDateString('en-CA'));
        
        await db.prepare(`
          INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
          VALUES (?, 'return', ?, ?, ?)
        `).run(data.supplier_id, totalAmount, returnId, data.reason || 'مرتجع نقدي');
        
        await db.prepare(`
          INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
          VALUES (?, 'payment', ?, ?, ?)
        `).run(data.supplier_id, -totalAmount, returnId, 'استرداد نقدي للمرتجع');
      }

      const journalId = generateId();
      await db.prepare('INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, ?, ?, ?, ?)').run(
        journalId, localDate(), `Purchase return [id=${returnId}] [invoice=${data.purchase_invoice_id}]`, session.id, totalAmount
      );
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(
        journalId,
        data.refund_method === 'cash'
          ? await resolvePurchaseAccountId('cash_drawer', '1.1.1', db)
          : await resolvePurchaseAccountId('accounts_payable', '2.1', db),
        'debit', totalAmount
      );
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(
        journalId, await resolvePurchaseAccountId('inventory_asset', '1.1.3', db), 'credit', totalAmount
      );

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        session.id,
        'PURCHASE_RETURN',
        `إضافة مرتجع مشتريات للمورد ${data.supplier_id} بقيمة ${totalAmount}`
      );
      return returnId;
    });

    const result = await transaction();
    notifyInventoryChanged();
    return { success: true, id: result };
  } catch (err: any) {
    console.error('createPurchaseReturnAction error:', err);
    return { success: false, error: err.message || (typeof err === 'string' ? err : 'Unknown error') };
  }
}

export async function getPurchaseReturnsAction(options: { limit?: number; offset?: number; search?: string } = {}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = session.pharmacy_id || 'local_default';
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit) || 50)));
    const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
    const search = String(options.search || '').trim();
    const like = `%${search}%`;

    const params: any[] = [pharmacyId, pharmacyId];
    let sql = `
      SELECT pr.*, s.name_ar as supplier_name, u.full_name as user_name,
        pi.invoice_number, pi.invoice_date
      FROM purchase_returns pr
      LEFT JOIN suppliers s ON s.id = pr.supplier_id
      LEFT JOIN users u ON u.id = pr.user_id
      JOIN purchase_invoices pi ON pi.id = pr.purchase_invoice_id
      WHERE (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
    `;
    if (search) {
      sql += `
        AND (
          pr.id LIKE ? OR pr.purchase_invoice_id LIKE ? OR
          COALESCE(pi.invoice_number, '') LIKE ? OR COALESCE(s.name_ar, '') LIKE ? OR
          COALESCE(u.full_name, '') LIKE ?
        )
      `;
      params.push(like, like, like, like, like);
    }
    sql += ' ORDER BY pr.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);
    const fetched = await db.prepare(sql).all(...params) as any[];
    const hasMore = fetched.length > limit;
    const rows = fetched.slice(0, limit);
    const returnIds = rows.map(row => String(row.id));
    const counts = returnIds.length
      ? await db.prepare(`
          SELECT purchase_return_id, COUNT(*) AS items_count
          FROM purchase_return_items
          WHERE purchase_return_id IN (${returnIds.map(() => '?').join(',')})
          GROUP BY purchase_return_id
        `).all(...returnIds) as Array<{ purchase_return_id: string; items_count: number }>
      : [];
    const countByReturn = new Map(counts.map(row => [String(row.purchase_return_id), Number(row.items_count || 0)]));
    return {
      success: true,
      data: rows.map(row => ({ ...row, items_count: countByReturn.get(String(row.id)) || 0 })),
      hasMore,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deletePurchaseInvoiceAction(invoiceId: string, removeInventory: boolean) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = session.pharmacy_id || 'local_default';
    const invoice = await db.prepare(`
      SELECT id FROM purchase_invoices
      WHERE id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(invoiceId, pharmacyId, pharmacyId);
    if (!invoice) return { success: false, error: 'Purchase invoice not found in this pharmacy' };
    if (!isTauri) return { success: false, error: 'Purchase deletion is available in the offline desktop app' };
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_purchase_invoice_critical', {
      payload: {
        invoice_id: invoiceId,
        remove_inventory: removeInventory,
        user_id: String(session.id),
        pharmacy_id: session.pharmacy_id || 'local_default',
      }
    });
    if (removeInventory) notifyInventoryChanged();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function getDrugInventoryQuantityAction(drugId: number) {
  const user = await getLocalSession();
  if (!user || (!hasUserPermissionSync(user, 'can_view_purchases') && !hasUserPermissionSync(user, 'can_view_restock'))) {
    return { success: false, error: 'Unauthorized' };
  }
  const pharmacyId = user.pharmacy_id || 'local_default';
  const row = await db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as quantity
    FROM inventory
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      AND (expiry_date IS NULL OR expiry_date >= date('now', 'localtime'))
  `).get(drugId, pharmacyId, pharmacyId) as any;
  return { success: true, data: Number(row?.quantity || 0) };
}

export async function getPurchaseReturnDetailsAction(returnId: string) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = session.pharmacy_id || 'local_default';

    const header = await db.prepare(`
      SELECT pr.*, s.name_ar as supplier_name, s.phone as supplier_phone,
             u.full_name as user_name, pi.invoice_number, pi.invoice_date,
             pi.total_amount as invoice_total, pi.payment_method as invoice_payment_method
      FROM purchase_returns pr
      LEFT JOIN suppliers s ON s.id = pr.supplier_id
      LEFT JOIN users u ON u.id = pr.user_id
      JOIN purchase_invoices pi ON pi.id = pr.purchase_invoice_id
      WHERE pr.id = ?
        AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(returnId, pharmacyId, pharmacyId) as any;
    if (!header) return { success: false, error: 'Purchase return not found' };

    const items = await db.prepare(`
      SELECT pri.*, COALESCE(pri.drug_name, md.trade_name) as drug_name,
             md.trade_name_en, i.batch_number, i.expiry_date
      FROM purchase_return_items pri
      LEFT JOIN master_drugs md ON md.id = pri.drug_id
      LEFT JOIN inventory i ON i.id = pri.inventory_id
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
      WHERE pri.purchase_return_id = ?
      ORDER BY pri.id
    `).all(pharmacyId, pharmacyId, returnId) as any[];
    return { success: true, data: { ...header, items } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getPurchaseInvoiceAction(invoiceId: string) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const pharmacyId = session.pharmacy_id || 'local_default';
    const invoice = await db.prepare(`
      SELECT * FROM purchase_invoices
      WHERE id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(invoiceId, pharmacyId, pharmacyId) as any;
    return { success: true, data: invoice };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getDraftPurchaseInvoicesAction() {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const pharmacyId = session.pharmacy_id || 'local_default';
    const drafts = await db.prepare(`
      SELECT pi.id, pi.invoice_number, pi.invoice_date, pi.supplier_id, s.name_ar as supplier_name, pi.total_amount
      FROM purchase_invoices pi
      JOIN suppliers s ON pi.supplier_id = s.id
      WHERE pi.status = 'draft'
        AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY pi.created_at DESC
    `).all(pharmacyId, pharmacyId) as any[];
    return { success: true, data: drafts };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateCompletedPurchaseInvoiceAction(data: {
  id: string,
  supplier_id: number,
  invoice_number?: string,
  invoice_date?: string,
  payment_method?: string,
  notes?: string,
  check_number?: string,
  expenses?: number,
  discount_value?: number,
  discount_percent?: number,
  tax_percent?: number,
  cart: any[]
}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) {
      return { success: false, error: 'Unauthorized' };
    }
    if (browserPurchaseMutationUnsupported()) return { success: false, error: 'تعديل المشتريات من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب' };
    if (data.invoice_date && !isBusinessDate(data.invoice_date)) return { success: false, error: 'تاريخ فاتورة الشراء غير صالح' };
    if (data.cart.some(item => item.expiry_date && !normalizeDateToYMD(item.expiry_date))) {
      return { success: false, error: 'يوجد تاريخ صلاحية غير صالح في أصناف الفاتورة' };
    }
    assertPurchaseItemsPolicy(data.cart, 'completed');
    assertNoDuplicatePurchaseLots(data.cart);
    assertCompletedPurchaseExpiryPolicy(data.cart);

    await ensureBarcodeColumn();
    const pharmacyId = session.pharmacy_id || 'local_default';
    const ownedInvoice = await db.prepare(`
      SELECT id FROM purchase_invoices
      WHERE id = ? AND status = 'completed'
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(data.id, pharmacyId, pharmacyId);
    if (!ownedInvoice) return { success: false, error: 'Completed purchase invoice not found in this pharmacy' };
    if (!isTauri) await assertPurchaseBarcodesAvailable(data.cart || []);

    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_purchase_invoice_critical', {
        payload: {
          ...data,
          pharmacy_id: session.pharmacy_id || null,
          user_id: String(session.id || 'admin'),
          supplier_id: Number(data.supplier_id),
          status: 'completed',
          cart: (data.cart || []).map(item => ({
            ...item,
            id: Number(item.id || item.drug_id),
            quantity: Number(item.quantity || 0),
            unit_id: item.unit_id ? Number(item.unit_id) : null,
            cost_price: Number(item.cost_price || 0),
            selling_price: item.selling_price != null ? Number(item.selling_price) : null,
            bonus_quantity: Number(item.bonus_quantity || 0),
            tax_percent: Number(item.tax_percent || 0),
            discount_percent: Number(item.discount_percent || 0),
            strips_per_box: Number(item.strips_per_box || item.large_to_medium || 1),
            barcode: item.barcode || null
          }))
        }
      });
      notifyInventoryChanged();
      revalidatePath('/purchases');
      revalidatePath('/inventory');
      revalidatePath('/purchases/suppliers');
      return { success: true };
    }

    const cacheUpdates: Array<{ drugId: number; patch: Record<string, unknown> }> = [];
    const transaction = db.transaction(async (db) => {
      await assertPurchaseBarcodesAvailable(data.cart || [], db);
      // 1. Get existing completed invoice and items
      const invoice = await db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(data.id) as any;
      if (!invoice) throw new Error('فاتورة الشراء غير موجودة');
      if (invoice.status !== 'completed') throw new Error('هذه الفاتورة ليست مكتملة');
      if ((data.payment_method || 'credit') !== invoice.payment_method) {
        throw new Error('Changing purchase payment method requires the desktop app');
      }
      const existingReturn = await db.prepare(`
        SELECT id
        FROM purchase_returns
        WHERE purchase_invoice_id = ?
          AND LOWER(COALESCE(status, '')) IN ('completed', 'approved')
        LIMIT 1
      `).get(data.id);
      if (existingReturn) throw new Error('Cannot edit a completed purchase after a return');

      const oldItems = await db.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id = ?').all(data.id) as any[];
      if (new Set(oldItems.map(purchaseLotIdentity)).size !== oldItems.length) {
        throw new Error('لا يمكن تعديل فاتورة مكتملة تحتوي على أسطر مكررة لنفس الصنف والصلاحية حتى يتم ربط كل سطر بالدفعة');
      }
      for (const oldItem of oldItems) {
        if (!oldItem.inventory_id) throw new Error('Historical purchase line has no linked batch; use the desktop app');
        const shared = await db.prepare('SELECT COUNT(*) AS count FROM purchase_invoice_items WHERE inventory_id = ? AND id <> ?').get(oldItem.inventory_id, oldItem.id) as any;
        if (Number(shared?.count || 0) > 0) throw new Error('Purchase batch is shared by multiple invoice lines; use the desktop app');
      }
      const allocation = calculatePurchaseAllocation(data.cart, data);
      const allocatedCostByLot = new Map(data.cart.map((item, index) => [purchaseLotIdentity(item), allocation.netUnitCosts[index]]));

      // 2. Fetch current inventory rows for the old invoice drugs
      const oldDrugIds = [...new Set(oldItems.map((item: any) => item.drug_id))];
      const oldInvItems = oldDrugIds.length
        ? await db.prepare(`
            SELECT *
            FROM inventory
            WHERE drug_id IN (${oldDrugIds.map(() => '?').join(',')})
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          `).all(...oldDrugIds, session.pharmacy_id || 'local_default', session.pharmacy_id || 'local_default') as any[]
        : [];
      const findOldInventory = (oldItem: any) => oldInvItems.find((inventory: any) => {
        return String(inventory.id) === String(oldItem.inventory_id)
          && String(inventory.drug_id) === String(oldItem.drug_id);
      });

      // A consumed lot is historical: its original purchase posting, supplier rows and
      // (especially) cash movement must never be reversed into a later shift.  This
      // narrowly-scoped path keeps the lot and purchase-line identities stable and
      // records only the incremental carrying value as a new adjustment.
      const lotIds = oldItems.map((item: any) => String(item.inventory_id));
      const salesForLots = lotIds.length
        ? await db.prepare(`SELECT COUNT(*) AS count FROM sales_items WHERE inventory_id IN (${lotIds.map(() => '?').join(',')})`).get(...lotIds) as any
        : { count: 0 };
      const priorAdjustment = await db.prepare(
        'SELECT id FROM daily_journals WHERE description = ? LIMIT 1'
      ).get(`Purchase edit [id=${data.id}]`) as any;
      const consumedLot = oldItems.some((oldItem: any) => {
        const inv = findOldInventory(oldItem);
        const received = Number(oldItem.quantity) + Number(oldItem.bonus_quantity || 0);
        return !inv || Number(inv.quantity) + 0.000001 < received;
      });
      const protectedInvoice = consumedLot || Number(salesForLots?.count || 0) > 0 || !!priorAdjustment;

      if (protectedInvoice) {
        const nearlyEqual = (left: unknown, right: unknown) =>
          Math.abs(Number(left || 0) - Number(right || 0)) <= 0.000001;
        const text = (value: unknown) => value == null ? '' : String(value).trim();
        const incomingByLine = new Map<number, any>();
        for (const item of data.cart) {
          const lineId = Number(item.purchase_invoice_item_id);
          if (!Number.isInteger(lineId) || lineId <= 0 || incomingByLine.has(lineId)) {
            throw new Error('Protected purchase edits require each original purchase line exactly once');
          }
          incomingByLine.set(lineId, item);
        }
        if (incomingByLine.size !== oldItems.length) {
          throw new Error('Cannot add or remove lines from a purchase with consumed inventory');
        }
        for (const oldItem of oldItems) {
          if (!incomingByLine.has(Number(oldItem.id))) {
            throw new Error('Unknown or missing purchase invoice line in protected edit');
          }
        }

        const oldDate = normalizeDateToYMD(invoice.invoice_date) || text(invoice.invoice_date);
        const requestedDate = data.invoice_date == null
          ? oldDate
          : (normalizeDateToYMD(data.invoice_date) || text(data.invoice_date));
        if (Number(data.supplier_id) !== Number(invoice.supplier_id)
          || text(data.payment_method || invoice.payment_method) !== text(invoice.payment_method)
          || requestedDate !== oldDate
          || text(data.check_number == null ? invoice.check_number : data.check_number) !== text(invoice.check_number)
          || !nearlyEqual(data.expenses == null ? invoice.expenses : data.expenses, invoice.expenses)
          || !nearlyEqual(data.discount_value == null ? invoice.discount_value : data.discount_value, invoice.discount_value)
          || !nearlyEqual(data.discount_percent == null ? invoice.discount_percent : data.discount_percent, invoice.discount_percent)
          || !nearlyEqual(data.tax_percent == null ? invoice.tax_percent : data.tax_percent, invoice.tax_percent)) {
          throw new Error('Supplier, payment, date, check and purchase valuation fields are immutable after lot consumption');
        }

        const oldAllocation = calculatePurchaseAllocation(oldItems, invoice);
        if (!nearlyEqual(oldAllocation.finalTotal, invoice.total_amount)) {
          throw new Error('Stored purchase total no longer matches its original allocation; reconcile it before editing');
        }
        const protectedAllocation = calculatePurchaseAllocation(oldItems.map((item: any) => incomingByLine.get(Number(item.id))), {
          ...invoice,
          expenses: data.expenses == null ? invoice.expenses : data.expenses,
          discount_value: data.discount_value == null ? invoice.discount_value : data.discount_value,
          discount_percent: data.discount_percent == null ? invoice.discount_percent : data.discount_percent,
          tax_percent: data.tax_percent == null ? invoice.tax_percent : data.tax_percent,
        });
        let inventoryDeltaValue = 0;
        const auditChanges: any[] = [];
        for (const [index, oldItem] of oldItems.entries()) {
          const item = incomingByLine.get(Number(oldItem.id));
          const inv = findOldInventory(oldItem);
          if (item.selling_price != null && (!Number.isFinite(Number(item.selling_price)) || Number(item.selling_price) < 0)) {
            throw new Error('Invalid protected purchase selling price');
          }
          if (!inv
            || !Number.isFinite(Number(inv.quantity)) || Number(inv.quantity) < 0
            || Number(item.id || item.drug_id) !== Number(oldItem.drug_id)
            || normalizeDateToYMD(item.expiry_date) !== normalizeDateToYMD(oldItem.expiry_date)
            || normalizeDateToYMD(inv.expiry_date) !== normalizeDateToYMD(oldItem.expiry_date)
            || !nearlyEqual(item.unit_id, oldItem.unit_id)
            || !nearlyEqual(item.strips_per_box || 1, oldItem.strips_per_box || 1)
            || !nearlyEqual(inv.strips_per_box || 1, oldItem.strips_per_box || 1)
            || !nearlyEqual(inv.medium_to_small || 1, oldItem.medium_to_small || 1)
            || !nearlyEqual(item.bonus_quantity || 0, oldItem.bonus_quantity || 0)
            || !nearlyEqual(item.cost_price, oldItem.cost_price)
            || !nearlyEqual(item.tax_percent || 0, oldItem.tax_percent || 0)
            || !nearlyEqual(item.discount_percent || 0, oldItem.discount_percent || 0)
            || text(item.barcode) !== text(oldItem.barcode || inv.barcode)
            || !nearlyEqual(inv.cost_price, oldAllocation.netUnitCosts[index])
            || !nearlyEqual(protectedAllocation.netUnitCosts[index], oldAllocation.netUnitCosts[index])) {
            throw new Error('Drug, lot, conversion, bonus, cost, tax, discount and barcode are immutable after lot consumption');
          }
          const oldQty = Number(oldItem.quantity);
          const newQty = Number(item.quantity);
          if (!Number.isFinite(newQty) || newQty <= 0) throw new Error('Invalid protected purchase quantity');
          const quantityDelta = newQty - oldQty;
          if (Number(inv.quantity) + quantityDelta < -0.000001) {
            throw new Error('The available quantity is insufficient for this protected purchase reduction');
          }
          const netUnitCost = oldAllocation.netUnitCosts[index];
          inventoryDeltaValue += quantityDelta * netUnitCost;
          auditChanges.push({ line_id: oldItem.id, quantity_before: oldQty, quantity_after: newQty,
            selling_price_before: oldItem.selling_price, selling_price_after: item.selling_price ?? oldItem.selling_price ?? inv.local_selling_price });
        }

        const newTotal = Number(invoice.total_amount || 0) + inventoryDeltaValue;
        if (newTotal < -0.000001) throw new Error('Protected purchase total cannot be negative');
        if (!nearlyEqual(protectedAllocation.finalTotal, newTotal)) {
          throw new Error('Protected purchase quantity change would alter its allocated unit cost');
        }
        for (const oldItem of oldItems) {
          const item = incomingByLine.get(Number(oldItem.id));
          const inv = findOldInventory(oldItem);
          const quantityDelta = Number(item.quantity) - Number(oldItem.quantity);
          const sellingPrice = item.selling_price ?? oldItem.selling_price ?? inv.local_selling_price;
          if (Math.abs(quantityDelta) > 0.000001 || !nearlyEqual(sellingPrice, oldItem.selling_price)) {
            const updated = await db.prepare(`
              UPDATE inventory
              SET quantity = CASE WHEN quantity + ? < 0 THEN 0 ELSE quantity + ? END,
                  local_selling_price = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND quantity + ? >= -0.000001
            `).run(quantityDelta, quantityDelta, sellingPrice, inv.id, quantityDelta);
            if (updated.changes !== 1) throw new Error('Inventory changed while applying protected purchase edit');
            await db.prepare(`
              UPDATE purchase_invoice_items SET quantity = ?, selling_price = ? WHERE id = ? AND invoice_id = ?
            `).run(Number(item.quantity), sellingPrice, oldItem.id, data.id);
            if (quantityDelta > 0 && Number(inv.quantity) + quantityDelta > 0) {
              await resolveShortageIfStockRecovered(db, Number(oldItem.drug_id), session.pharmacy_id);
            }
          }
        }
        await db.prepare(`UPDATE purchase_invoices SET invoice_number = ?, notes = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(data.invoice_number == null ? invoice.invoice_number : data.invoice_number || null,
            data.notes == null ? invoice.notes : data.notes || null, newTotal, data.id);

        if (Math.abs(inventoryDeltaValue) > 0.000001) {
          const journalId = generateId();
          const positive = inventoryDeltaValue > 0;
          const amount = Math.abs(inventoryDeltaValue);
          const accounts = {
            cash: await resolvePurchaseAccountId('cash_drawer', '1.1.1', db),
            payable: await resolvePurchaseAccountId('accounts_payable', '2.1', db),
            inventory: await resolvePurchaseAccountId('inventory_asset', '1.1.3', db),
          };
          await db.prepare('INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, ?, ?, ?, ?)')
            .run(journalId, localDate(), `Purchase edit [id=${data.id}]`, session.id, amount);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
            .run(journalId, accounts.inventory, positive ? 'debit' : 'credit', amount);
          if (invoice.payment_method === 'credit' || invoice.payment_method === 'check') {
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
              .run(journalId, accounts.payable, positive ? 'credit' : 'debit', amount);
            await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(inventoryDeltaValue, invoice.supplier_id);
            await db.prepare("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'invoice', ?, ?, ?)")
              .run(invoice.supplier_id, inventoryDeltaValue, data.id, `Purchase edit delta [id=${data.id}]`);
          } else {
            const shiftId = await requireOpenShiftId(String(session.id), undefined, db);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
              .run(journalId, accounts.cash, positive ? 'credit' : 'debit', amount);
            await db.prepare("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'invoice', ?, ?, ?)")
              .run(invoice.supplier_id, inventoryDeltaValue, data.id, `Purchase edit delta [id=${data.id}]`);
            await db.prepare("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'payment', ?, ?, ?)")
              .run(invoice.supplier_id, -inventoryDeltaValue, data.id, `Purchase edit cash delta [id=${data.id}]`);
            await db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, 'purchases', ?, ?)")
              .run(generateId(), session.id, shiftId, positive ? 'disbursement' : 'receipt', amount, `Purchase edit [id=${data.id}]`, localDate());
          }
        }
        await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
          .run(session.id, 'EDIT_CONSUMED_PURCHASE', JSON.stringify({ invoice_id: data.id, before_total: invoice.total_amount,
            after_total: newTotal, delta: inventoryDeltaValue, changes: auditChanges,
            before_number: invoice.invoice_number, after_number: data.invoice_number ?? invoice.invoice_number,
            before_notes: invoice.notes, after_notes: data.notes ?? invoice.notes }));
        return data.id;
      }

      // Protected edits above retain the historical factor and never change the master.
      await assertPurchaseConversionPermission(session, data.cart || [], db);

      // 3. Validation: check if any reduction in quantity is safe (not sold yet)
      for (const oldItem of oldItems) {
        const inv = findOldInventory(oldItem);
        const oldQty = Number(oldItem.quantity) + (Number(oldItem.bonus_quantity) || 0);
        if (!inv || Number(inv.quantity) + 0.000001 < oldQty) {
          throw new Error('لا يمكن تعديل فاتورة مكتملة بعد استهلاك أو فقدان دفعتها المرتبطة');
        }

        const newItem = data.cart.find((c: any) => purchaseLotIdentity(c) === purchaseLotIdentity(oldItem));
        
        if (!newItem) {
          // Item was removed from the cart
          if (inv && inv.quantity < oldQty) {
            const soldAmount = oldQty - inv.quantity;
            const drugInfo = await db.prepare('SELECT trade_name FROM master_drugs WHERE id = ?').get(oldItem.drug_id) as any;
            throw new Error(`لا يمكن حذف الصنف "${drugInfo?.trade_name || oldItem.drug_id}" لأنه تم بيع جزء منه (الكمية المباعة: ${soldAmount.toFixed(2)})`);
          }
        } else {
          // Item exists in the new cart, check if quantity decreased
          const newQty = Number(newItem.quantity) + (Number(newItem.bonus_quantity) || 0);
          if (newQty < oldQty) {
            const reduction = oldQty - newQty;
            if (!inv || inv.quantity < reduction) {
              const soldAmount = oldQty - (inv ? inv.quantity : 0);
              const drugInfo = await db.prepare('SELECT trade_name FROM master_drugs WHERE id = ?').get(oldItem.drug_id) as any;
              throw new Error(`الكمية المتاحة في المخزن للصنف "${drugInfo?.trade_name || oldItem.drug_id}" غير كافية لتقليل الكمية (الكمية المباعة: ${soldAmount.toFixed(2)})`);
            }
          }
        }
      }

      // 4. Verification passed! Let's update inventory and invoice items.
      const newBatchNumber = purchaseBatchKey(data.id);
      const inventoryIdsByLot = new Map<string, string>();
      
      // We will first handle updates/deletions of old items
      for (const oldItem of oldItems) {
        const inv = findOldInventory(oldItem);
        const oldQty = Number(oldItem.quantity) + (Number(oldItem.bonus_quantity) || 0);
        
        const newItem = data.cart.find((c: any) => purchaseLotIdentity(c) === purchaseLotIdentity(oldItem));

        if (!newItem) {
          // Item removed
          if (inv) {
            await db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(oldQty, inv.id);
          }
        } else {
          // Item updated
          const newQty = Number(newItem.quantity) + (Number(newItem.bonus_quantity) || 0);
          
          // Calculate item subtotal, tax, discount for unit cost
          const lotKey = purchaseLotIdentity(newItem);
          const netUnitCost = allocatedCostByLot.get(lotKey) ?? newItem.cost_price;

          if (inv) {
            const newInvQty = inv.quantity - (oldQty - newQty);
            await db.prepare(`
              UPDATE inventory 
              SET quantity = ?, 
                  local_selling_price = ?, 
                  cost_price = ?, 
                  expiry_date = ?, 
                  batch_number = ?, 
                  strips_per_box = ?, 
                  barcode = CASE WHEN ? != '' THEN ? ELSE barcode END,
                  updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).run(
              newInvQty,
              newItem.selling_price || 0,
              netUnitCost,
              normalizeDateToYMD(newItem.expiry_date),
              newBatchNumber,
              newItem.strips_per_box || 1,
              String(newItem.barcode || '').trim(),
              String(newItem.barcode || '').trim(),
              inv.id
            );
            inventoryIdsByLot.set(lotKey, String(inv.id));
          } else {
            const inventoryId = await addToInventory({
              drugId: newItem.id,
              pharmacyId: session.pharmacy_id,
              quantity: newQty,
              sellingPrice: newItem.selling_price || 0,
              costPrice: netUnitCost,
              expiryDate: normalizeDateToYMD(newItem.expiry_date),
              batchNumber: newBatchNumber,
              stripsPerBox: newItem.strips_per_box || 1,
              barcode: newItem.barcode,
            }, db);
            inventoryIdsByLot.set(lotKey, inventoryId);
          }
        }
      }

      // Add entirely new items (that weren't in old items)
      for (const newItem of data.cart) {
        const lotKey = purchaseLotIdentity(newItem);
        const isNew = !oldItems.some((o: any) => purchaseLotIdentity(o) === lotKey);
        if (isNew) {
          const newQty = Number(newItem.quantity) + (Number(newItem.bonus_quantity) || 0);
          const netUnitCost = allocatedCostByLot.get(lotKey) ?? newItem.cost_price;

          const inventoryId = await addToInventory({
            drugId: newItem.id,
            pharmacyId: session.pharmacy_id,
            quantity: newQty,
            sellingPrice: newItem.selling_price || 0,
            costPrice: netUnitCost,
            expiryDate: normalizeDateToYMD(newItem.expiry_date),
            batchNumber: newBatchNumber,
            stripsPerBox: newItem.strips_per_box || 1,
            barcode: newItem.barcode,
          }, db);
          inventoryIdsByLot.set(lotKey, inventoryId);
        }
      }

      // Now clear old items and insert all new ones from data.cart into purchase_invoice_items
      await db.prepare('DELETE FROM purchase_invoice_items WHERE invoice_id = ?').run(data.id);
      
      let totalAmount = 0;
      const itemStmt = await db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, medium_to_small, barcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const item of data.cart) {
        const normExpiry = normalizeDateToYMD(item.expiry_date);
        const mediumToSmall = await purchaseMediumToSmall(item.id, db);
        const purchaseItemResult = await itemStmt.run(
          data.id,
          item.id,
          item.quantity,
          item.unit_id || null,
          normExpiry,
          item.cost_price,
          item.selling_price || null,
          item.bonus_quantity || 0,
          item.tax_percent || 0,
          item.discount_percent || 0,
          item.strips_per_box || 1,
          mediumToSmall,
          item.barcode || null
        );
        const inventoryId = inventoryIdsByLot.get(purchaseLotIdentity(item));
        if (inventoryId) {
          await db.prepare('UPDATE purchase_invoice_items SET inventory_id = ? WHERE id = ?').run(
            inventoryId,
            purchaseItemResult.lastInsertRowid
          );
        }

        if (item.strips_per_box) {
          await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.id);
          cacheUpdates.push({ drugId: Number(item.id), patch: { large_to_medium: item.strips_per_box } });
        }

        if (item.barcode) {
          const masterUpdate = await db.prepare("UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = '')").run(item.barcode.trim(), item.id);
          if (masterUpdate.changes > 0) {
            cacheUpdates.push({ drugId: Number(item.id), patch: { barcode: item.barcode.trim() } });
          }
        }

        totalAmount += Number(item.quantity || 0) * Number(item.cost_price || 0);

        // Resolve only after stock actually recovers above the configured threshold.
        const drugId = Number(item.id || item.drug_id);
        await resolveShortageIfStockRecovered(db, drugId, session.pharmacy_id);
      }

      // Calculate new invoice total
      const newTotal = allocation.finalTotal;

      const oldTotal = invoice.total_amount || 0;
      const diff = newTotal - oldTotal;

      // Update invoice total_amount
      await db.prepare(`
        UPDATE purchase_invoices 
        SET supplier_id = ?, 
            invoice_number = ?, 
            invoice_date = ?, 
            payment_method = ?, 
            notes = ?, 
            check_number = ?, 
            expenses = ?, 
            discount_value = ?, 
            discount_percent = ?, 
            tax_percent = ?, 
            total_amount = ?, 
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        data.supplier_id,
        data.invoice_number || null,
        data.invoice_date || localDate(),
        data.payment_method || 'credit',
        data.notes || null,
        data.check_number || null,
        data.expenses || 0,
        data.discount_value || 0,
        data.discount_percent || 0,
        data.tax_percent || 0,
        newTotal,
        data.id
      );

      // Adjust supplier balance and supplier transaction
      await db.prepare('DELETE FROM supplier_transactions WHERE reference_id = ?').run(data.id);

      // If supplier changed
      if (invoice.supplier_id !== data.supplier_id) {
        // Old supplier refund
        if (invoice.payment_method === 'credit' || invoice.payment_method === 'check') {
          await db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id = ?').run(oldTotal, invoice.supplier_id);
        }
        // New supplier charge
        if (data.payment_method === 'credit' || data.payment_method === 'check') {
          await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(newTotal, data.supplier_id);
          const typeLabel = data.payment_method === 'credit' ? 'آجل' : 'شيك';
          await db.prepare('INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, ?, ?, ?, ?)').run(
            data.supplier_id,
            'invoice',
            newTotal,
            data.id,
            `فاتورة شراء معدلة (${typeLabel}) رقم ${data.invoice_number || data.id}`
          );
        }
      } else {
        // Supplier is the same, just adjust by the diff
        if (data.payment_method === 'credit' || data.payment_method === 'check') {
          await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(diff, data.supplier_id);
          const typeLabel = data.payment_method === 'credit' ? 'آجل' : 'شيك';
          await db.prepare('INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, ?, ?, ?, ?)').run(
            data.supplier_id,
            'invoice',
            newTotal,
            data.id,
            `فاتورة شراء معدلة (${typeLabel}) رقم ${data.invoice_number || data.id}`
          );
        }
      }

      // Cash Drawer / Movements Adjustment
      if (data.payment_method === 'cash') {
        const shiftId = await requireOpenShiftId(String(session.id), undefined, db);
        if (diff !== 0) {
          const type = diff > 0 ? 'disbursement' : 'receipt';
          await db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
            generateId(), session.id, shiftId, type, Math.abs(diff), 'purchases', `Edit ${purchaseJournalDescription(data.id)}`, localDate()
          );
        }
      }

      // Accounting / Journal Entries update
      const legacyReference = invoice.invoice_number || invoice.id.slice(0, 8);
      const legacyDescription = `فاتورة شراء رقم ${legacyReference}`;
      const legacyEnglishDescription = `Purchase invoice ${legacyReference}`;
      const legacyMatch = await db.prepare('SELECT id FROM daily_journals WHERE description IN (?, ?)').all(legacyDescription, legacyEnglishDescription) as any[];
      if (legacyMatch.length) {
        const sameReference = await db.prepare('SELECT COUNT(*) AS count FROM purchase_invoices WHERE id <> ? AND (invoice_number = ? OR SUBSTR(id, 1, 8) = ?)').get(data.id, legacyReference, legacyReference) as any;
        if (Number(sameReference?.count || 0) > 0) throw new Error('Legacy purchase journal reference is ambiguous; use the desktop app');
      }
      const oldJournals = await db.prepare('SELECT id FROM daily_journals WHERE description IN (?, ?, ?)').all(purchaseJournalDescription(data.id), legacyDescription, legacyEnglishDescription) as any[];
      for (const j of oldJournals) {
        await db.prepare('DELETE FROM journal_entries WHERE journal_id = ?').run(j.id);
        await db.prepare('DELETE FROM daily_journals WHERE id = ?').run(j.id);
      }

      const journalId = generateId();
      const purchaseDate = data.invoice_date || localDate();
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, purchaseDate, purchaseJournalDescription(data.id), session.id, newTotal);

      const accounts = {
        cash: await resolvePurchaseAccountId('cash_drawer', '1.1.1', db),
        payable: await resolvePurchaseAccountId('accounts_payable', '2.1', db),
        inventory: await resolvePurchaseAccountId('inventory_asset', '1.1.3', db),
      };

      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', newTotal);

      if (data.payment_method === 'credit' || data.payment_method === 'check') {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.payable, 'credit', newTotal);
      } else {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cash, 'credit', newTotal);
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        session.id,
        'EDIT_COMPLETED_PURCHASE',
        `تعديل فاتورة شراء مكتملة بقيمة جديدة: ${newTotal.toFixed(2)}`
      );
      return data.id;
    });

    await transaction();
    for (const update of cacheUpdates) {
      secureCache.updateDrug(update.drugId, update.patch);
    }

    notifyInventoryChanged();
    revalidatePath('/purchases');
    revalidatePath('/inventory');
    revalidatePath('/inventory/low-stock');
    revalidatePath('/stores/shortages');
    revalidatePath('/purchases/suppliers');
    revalidatePath('/');
    
    return { success: true };
  } catch (error: any) {
    console.error('updateCompletedPurchaseInvoiceAction error:', error?.message || error);
    return { success: false, error: error?.message || String(error) || 'فشل تعديل الفاتورة' };
  }
}
