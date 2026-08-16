import { secureCache } from '@/lib/cache/secure_cache';
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
import { purchaseReturnRemainingLargeQuantity } from '@/lib/purchases/return-units';
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
    return (...args) => dbTransaction(async () => await cb(...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};

function normalizeDateToYMD(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  let match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = dateStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = dateStr.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[2]}-${match[1].padStart(2, '0')}-01`;
  return dateStr;
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
}) {
  const pharmacyId = data.pharmacyId || 'local_default';
  const existing = await db.prepare(`
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
    await db.prepare(`
      UPDATE inventory
      SET quantity = quantity + ?,
          local_selling_price = ?,
          cost_price = ?,
          expiry_date = ?,
          batch_number = ?,
          strips_per_box = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      data.quantity,
      data.sellingPrice,
      data.costPrice,
      data.expiryDate,
      data.batchNumber,
      data.stripsPerBox,
      existing.id
    );
    return String(existing.id);
  }

  const inventoryId = generateId();
  await db.prepare(`
    INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, batch_number, strips_per_box)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    inventoryId,
    data.drugId,
    pharmacyId,
    data.quantity,
    data.sellingPrice,
    data.costPrice,
    data.expiryDate,
    data.batchNumber,
    data.stripsPerBox
  );
  return inventoryId;
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
  return canViewSuppliers(session) && (session.role === 'owner' || session.role === 'admin');
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
    if (!session || (!hasUserPermissionSync(session, 'can_view_suppliers') && !hasUserPermissionSync(session, 'can_view_purchases') && !hasUserPermissionSync(session, 'rep_can_view_financial'))) {
      return { success: false, error: SUPPLIER_PERMISSION_ERROR };
    }

    const supplierId = Number(rawData.supplier_id);
    const amount = Number(rawData.amount);
    if (!Number.isInteger(supplierId) || supplierId <= 0) return { success: false, error: 'معرف المورد غير صحيح' };
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'يرجى إدخال مبلغ صحيح أكبر من الصفر' };

    const paymentMethod = rawData.payment_method || 'cash';
    const paymentDate = rawData.date || new Date().toISOString().split('T')[0];
    const notes = rawData.notes ? String(rawData.notes).trim() : '';

    let remainingBalance = 0;
    const refId = `sup-pay-${Date.now()}`;

    await dbTransaction(async () => {
      const supplier = await db.prepare('SELECT id, name_ar, balance FROM suppliers WHERE id = ?').get(supplierId) as any;
      if (!supplier) throw new Error('المورد غير موجود');

      const currentBalance = Number(supplier.balance || 0);

      // 1. Decrease supplier balance
      await db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id = ?').run(amount, supplierId);

      // 2. Record in supplier_transactions
      const transactionNote = notes 
        ? `سداد دفعة (${paymentMethod === 'check' ? `شيك ${rawData.check_number || ''}` : paymentMethod === 'bank' ? 'تحويل بنكي' : 'نقدي'}): ${notes}`
        : `سداد دفعة للمورد (${paymentMethod === 'check' ? `شيك ${rawData.check_number || ''}` : paymentMethod === 'bank' ? 'تحويل بنكي' : 'نقدي'})`;

      await db.prepare(`
        INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes, created_at)
        VALUES (?, 'payment', ?, ?, ?, ?)
      `).run(supplierId, amount, refId, transactionNote, `${paymentDate} ${new Date().toTimeString().split(' ')[0]}`);

      // 3. Record in cash_movements if cash
      if (paymentMethod === 'cash') {
        const movementId = generateId();
        await db.prepare(`
          INSERT INTO cash_movements (
            id, user_id, type, category, amount, source_type, target_name, notes, date
          ) VALUES (?, ?, 'disbursement', 'accounts_payable', ?, 'supplier_payment', ?, ?, ?)
        `).run(
          movementId,
          session.id,
          amount,
          String(supplierId),
          `سداد دفعة للمورد ${supplier.name_ar}: ${notes}`,
          paymentDate
        );
      }

      // 4. Accounting entries
      try {
        const getAccount = async (category: string, fallback: number) => {
          const setting = await db.prepare(
            'SELECT account_id FROM trial_balance_settings WHERE category = ? ORDER BY id LIMIT 1'
          ).get(category) as any;
          return Number(setting?.account_id || fallback);
        };
        const payableAccountId = await getAccount('accounts_payable', 8);
        const creditAccountId = paymentMethod === 'bank'
          ? await getAccount('bank_clearing', 6)
          : await getAccount('cash_drawer', 6);

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
        console.warn('Accounting entry for supplier payment failed gracefully:', accErr);
      }

      await logActivity(session.id, 'SUPPLIER_PAYMENT', `Paid ${amount} to supplier #${supplierId} (${supplier.name_ar}) via ${paymentMethod}`);
      remainingBalance = currentBalance - amount;
    });

    revalidatePath('/purchases/suppliers');
    revalidatePath('/purchases');
    return { success: true, remainingBalance };
  } catch (error: any) {
    console.error('Supplier payment error:', error);
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

    await ensureBarcodeColumn();
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
      revalidatePath('/purchases');
      revalidatePath('/inventory');
      revalidatePath('/purchases/suppliers');
      return { success: true, id: result?.id };
    }

    const transaction = db.transaction(async () => {
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
        data.invoice_date || new Date().toISOString().split('T')[0],
        data.payment_method || 'credit',
        data.notes || null,
        data.check_number || null,
        data.expenses || 0,
        data.discount_value || 0,
        data.discount_percent || 0,
        data.tax_percent || 0,
        finalStatus
      );

      let totalAmount = 0;

      if (data.cart && data.cart.length > 0) {
        const itemStmt = await db.prepare(`
          INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, barcode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of data.cart) {
          const normExpiry = normalizeDateToYMD(item.expiry_date);
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
            item.barcode || null
          );

          if (item.strips_per_box) {
            await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.id);
            secureCache.updateDrug(Number(item.id), { large_to_medium: item.strips_per_box });
          }

          if (item.barcode) {
            await db.prepare('UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = "")').run(item.barcode, item.id);
            await db.prepare('UPDATE inventory SET barcode = ? WHERE drug_id = ? AND (barcode IS NULL OR barcode = "")').run(item.barcode, item.id);
            secureCache.updateDrug(Number(item.id), { barcode: item.barcode });
          }

          if (finalStatus === 'completed') {
            const itemSubtotal = (item.quantity * item.cost_price);
            const itemTax = itemSubtotal * (item.tax_percent / 100);
            const itemTotal = itemSubtotal + itemTax;
            
            totalAmount += itemTotal;

            const totalReceivedQty = Number(item.quantity) + Number(item.bonus_quantity || 0);
            const netUnitCost = totalReceivedQty > 0 ? (itemTotal / totalReceivedQty) : item.cost_price;

            const inventoryId = await addToInventory({
              drugId: item.id,
              pharmacyId: session.pharmacy_id,
              quantity: totalReceivedQty,
              sellingPrice: item.selling_price || 0,
              costPrice: netUnitCost,
              expiryDate: normExpiry,
              batchNumber: data.invoice_number || 'BATCH-' + id.substring(0, 8),
              stripsPerBox: item.strips_per_box || 1,
            });
            await db.prepare('UPDATE purchase_invoice_items SET inventory_id = ? WHERE id = ?').run(
              inventoryId,
              purchaseItemResult.lastInsertRowid
            );
          }
        }
      }

      if (finalStatus === 'completed') {
        const invoiceExpenses = data.expenses || 0;
        const invoiceDiscountVal = data.discount_value || 0;
        const invoiceDiscountPct = (totalAmount + invoiceExpenses - invoiceDiscountVal) * ((data.discount_percent || 0) / 100);
        
        const finalTotal = totalAmount + invoiceExpenses - invoiceDiscountVal - invoiceDiscountPct;

        await db.prepare('UPDATE purchase_invoices SET total_amount = ? WHERE id = ?').run(finalTotal, id);

        const journalId = generateId();
        const purchaseDate = data.invoice_date || new Date().toISOString().split('T')[0];
        
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, purchaseDate, `فاتورة شراء رقم ${data.invoice_number || id.slice(0, 8)}`, session.id, finalTotal);

        const getAccountId = async (cat: string) => {
          const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
          return s?.account_id;
        };

        const accounts = {
          cash: await getAccountId('cash_drawer') || 6,
          payable: await getAccountId('accounts_payable') || 7,
          inventory: await getAccountId('inventory_asset') || 10
        };

        try {
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', finalTotal);
        } catch (e) {
          console.warn('Accounting missing: could not insert inventory journal entry', e);
        }

        if (data.payment_method === 'credit' || data.payment_method === 'check') {
          await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(finalTotal, data.supplier_id);
          
          const typeLabel = data.payment_method === 'credit' ? 'آجل' : 'شيك';
          await db.prepare('INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, ?, ?, ?, ?)').run(data.supplier_id, 'invoice', finalTotal, id, `فاتورة شراء (${typeLabel}) رقم ${data.invoice_number || id}`);

          try {
            if (accounts.payable) await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.payable, 'credit', finalTotal);
          } catch (e) {
            console.warn('Accounting missing: could not insert payable journal entry', e);
          }
        } else {
          try {
            if (accounts.cash) await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cash, 'credit', finalTotal);
            const openShift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(session.id) as any;
            if (openShift) {
              await db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
                generateId(), session.id, openShift.id, 'disbursement', finalTotal, 'purchases', `فاتورة شراء رقم ${data.invoice_number || id.slice(0, 8)}`, new Date().toISOString().split('T')[0]
              );
            }
          } catch (e) {
            console.warn('Accounting missing: could not insert cash journal entry', e);
          }
        }

        logActivity(session.id, 'COMPLETE_PURCHASE', `أكمل فاتورة شراء بقيمة: ${finalTotal.toFixed(2)}`);
      }

      return id;
    });

    const invoiceId = await transaction();

    revalidatePath('/purchases');
    revalidatePath('/inventory');
    revalidatePath('/purchases/suppliers');
    
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

    const stmt = await db.prepare(`
      INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const normExpiry = normalizeDateToYMD(item.expiry_date);
    await stmt.run(
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
      item.strips_per_box || 1
    );

    if (item.strips_per_box) {
      await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.drug_id);
      secureCache.updateDrug(Number(item.drug_id), { large_to_medium: item.strips_per_box });
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

    const transaction = db.transaction(async () => {
      // 1. Get invoice and items
      const invoice = await db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(invoiceId) as any;
      const items = await db.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id = ?').all(invoiceId) as any[];

      let totalAmount = 0;
      for (const item of items) {
        // Base calculation
        const itemSubtotal = (item.quantity * item.cost_price);
        const itemTax = itemSubtotal * (item.tax_percent / 100);
        const itemTotal = itemSubtotal + itemTax;
        
        totalAmount += itemTotal;

        const totalReceivedQty = Number(item.quantity) + Number(item.bonus_quantity || 0);
        const netUnitCost = totalReceivedQty > 0 ? (itemTotal / totalReceivedQty) : item.cost_price;

        await addToInventory({
          drugId: item.drug_id,
          pharmacyId: session.pharmacy_id,
          quantity: totalReceivedQty,
          sellingPrice: item.selling_price || 0,
          costPrice: netUnitCost,
          expiryDate: item.expiry_date,
          batchNumber: invoice.invoice_number || 'BATCH-' + invoiceId.substring(0, 8),
          stripsPerBox: item.strips_per_box || 1,
        });

        if (item.strips_per_box) {
          await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.drug_id);
          secureCache.updateDrug(Number(item.drug_id), { large_to_medium: item.strips_per_box });
        }
      }

      // 3. Apply global invoice discounts and expenses
      const invoiceExpenses = invoice.expenses || 0;
      const invoiceDiscountVal = invoice.discount_value || 0;
      const invoiceDiscountPct = (totalAmount + invoiceExpenses - invoiceDiscountVal) * (invoice.discount_percent / 100);
      
      const finalTotal = totalAmount + invoiceExpenses - invoiceDiscountVal - invoiceDiscountPct;

      // 4. Update invoice total and status
      await db.prepare('UPDATE purchase_invoices SET total_amount = ?, status = ? WHERE id = ?').run(finalTotal, 'completed', invoiceId);

      // 5. Update supplier balance or record cash payment
      const journalId = generateId();
      const purchaseDate = new Date().toISOString().split('T')[0];
      
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, purchaseDate, `فاتورة شراء رقم ${invoice.invoice_number || invoiceId.slice(0, 8)}`, session.id, finalTotal);

      const getAccountId = async (cat: string) => {
        const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
        return s?.account_id;
      };

      const accounts = {
        cash: await getAccountId('cash_drawer') || 6,
        payable: await getAccountId('accounts_payable') || 7, // Need to ensure 7 exists or is generic liability
        inventory: await getAccountId('inventory_asset') || 10
      };

      // Inventory Entry: Debit Inventory Asset, Credit Cash/Payable
      try {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', finalTotal);
      } catch (e) {
        console.warn('Accounting missing: could not insert inventory journal entry', e);
      }

      if (invoice.payment_method === 'credit' || invoice.payment_method === 'check') {
        await db.prepare('UPDATE suppliers SET balance = balance + ? WHERE id = ?').run(finalTotal, invoice.supplier_id);
        
        const typeLabel = invoice.payment_method === 'credit' ? 'آجل' : 'شيك';
        await db.prepare('INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, ?, ?, ?, ?)').run(invoice.supplier_id, 'invoice', finalTotal, invoiceId, `فاتورة شراء (${typeLabel}) رقم ${invoice.invoice_number || invoiceId}`);

        // Credit Accounts Payable
        try {
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.payable, 'credit', finalTotal);
        } catch (e) {
          console.warn('Accounting missing: could not insert payable journal entry', e);
        }
      } else {
        // Credit Cash
        try {
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cash, 'credit', finalTotal);
        } catch (e) {
          console.warn('Accounting missing: could not insert cash journal entry', e);
        }
      }

      logActivity(session.id, 'COMPLETE_PURCHASE', `أكمل فاتورة شراء بقيمة: ${finalTotal.toFixed(2)}`);
      return { finalTotal, paymentMethod: invoice.payment_method, supplierId: invoice.supplier_id, invoiceNum: invoice.invoice_number };
    });

    const { finalTotal, paymentMethod, supplierId, invoiceNum } = await transaction();

    revalidatePath('/purchases');
    revalidatePath('/inventory');
    revalidatePath('/purchases/suppliers');
    
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
    if (!user || !hasUserPermissionSync(user, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

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

    await dbTransaction(async () => {
      await dbExecute('INSERT INTO purchase_orders (id, user_id, supplier_name, total_amount, notes) VALUES (?, ?, ?, ?, ?)', [
        po_id,
        user.id,
        data.supplier_name.trim(),
        total_amount,
        data.notes || null
      ]);

      for (const item of data.items) {
        await dbExecute('INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price) VALUES (?, ?, ?, ?)', [
          po_id,
          item.drug_id,
          item.quantity,
          item.expected_price
        ]);
      }

      await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [
        user.id,
        'Create PO',
        'PO created ' + po_id
      ]);
    });
    
    return { success: true, po_id };
  } catch (error: any) {
    console.error('createPurchaseOrderAction error:', error);
    return { success: false, error: error?.message || 'فشل إنشاء أمر الشراء' };
  }
}

export async function getPurchaseOrdersAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    const orders = await db.prepare(`
      SELECT po.*, u.full_name as creator_name, COUNT(pii.id) as item_count 
      FROM purchase_orders po 
      LEFT JOIN users u ON po.user_id = u.id 
      LEFT JOIN purchase_order_items pii ON pii.po_id = po.id 
      WHERE u.pharmacy_id = ? OR (u.pharmacy_id IS NULL AND ? = 'local_default')
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
    if (!user || !hasUserPermissionSync(user, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    if (!['completed', 'cancelled'].includes(status)) return { success: false, error: 'Invalid purchase order status' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    const result = await db.prepare(`
      UPDATE purchase_orders
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM users creator
          WHERE creator.id = purchase_orders.user_id
            AND (creator.pharmacy_id = ? OR (creator.pharmacy_id IS NULL AND ? = 'local_default'))
        )
    `).run(status, poId, pharmacyId, pharmacyId);
    if (result.changes !== 1) return { success: false, error: 'Purchase order is missing or no longer pending' };
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed' };
  }
}

export async function getPurchasesReportsAction(filters: any = {}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
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
    if (filters.status && filters.status !== 'all') { sql += ' AND i.status = ?'; params.push(filters.status); }
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
             d.large_to_medium, d.medium_to_small,
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
  quantity: number;
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
  session: { pharmacy_id?: string | null }
) {
  const invoice = await dbGet<any>(
    'SELECT id, supplier_id, pharmacy_id, status FROM purchase_invoices WHERE id = ?',
    [data.purchase_invoice_id]
  );
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

  const itemIds = data.items.map(item => Number(item.purchase_invoice_item_id));
  if (itemIds.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error('Every returned item must reference its purchase invoice line');
  }
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error('Duplicate purchase invoice lines are not allowed in one return');
  }

  const placeholders = itemIds.map(() => '?').join(',');
  const invoiceLines = await dbSelect<any>(`
    SELECT pii.id, pii.drug_id, pii.quantity, pii.inventory_id,
           COALESCE(NULLIF(pii.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
           COALESCE(md.medium_to_small, 1) AS medium_to_small
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
      quantity: Number(line.quantity),
      inventory_id: line.inventory_id ? String(line.inventory_id) : null,
      large_to_medium: Math.max(1, Number(line.large_to_medium) || 1),
      medium_to_small: Math.max(1, Number(line.medium_to_small) || 1),
    }
  ]));

  const previousReturns = await dbSelect<any>(`
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
      item.unit,
      line.large_to_medium,
      line.medium_to_small
    );
    const prior = previouslyReturned.get(lineId) || 0;
    if (prior + requested > line.quantity + 0.005) {
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
      revalidatePath('/purchases/returns');
      revalidatePath('/inventory');
      return { success: true, id: result.return_id };
    }

    await dbExecute('ALTER TABLE purchase_return_items ADD COLUMN purchase_invoice_item_id INTEGER').catch(() => {});
    await dbExecute("ALTER TABLE purchase_return_items ADD COLUMN unit TEXT DEFAULT 'large'").catch(() => {});

    const transaction = db.transaction(async () => {
      const returnId = generateId();
      let totalAmount = 0;
      const validatedLines = await validatePurchaseReturnRequest(data, session);

      for (const item of data.items) {
        totalAmount += item.quantity * item.unit_price;
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
        const lineTotal = item.quantity * item.unit_price;
        const sourceLine = validatedLines.get(Number(item.purchase_invoice_item_id))!;
        const returnUnit = item.unit || 'large';
        const deductQty = purchaseReturnQuantityInLargeUnits(
          Number(item.quantity),
          returnUnit,
          sourceLine.large_to_medium,
          sourceLine.medium_to_small
        );
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
                AND quantity + 0.005 >= ?
              ORDER BY expiry_date ASC
              LIMIT 1
            `).get(sourceLine.drug_id, pharmacyId, pharmacyId, deductQty) as any;
        if (!inventory || Number(inventory.drug_id) !== sourceLine.drug_id || Number(inventory.quantity) + 0.005 < deductQty) {
          throw new Error(`Insufficient inventory for ${item.drug_name}`);
        }
        await itemStmt.run(returnId, item.purchase_invoice_item_id || null, inventory.id, item.drug_id, item.drug_name, item.quantity, item.unit_price, lineTotal, returnUnit, data.reason || null);
        const stockUpdate = await db.prepare(`
          UPDATE inventory
          SET quantity = CASE WHEN quantity - ? < 0.0001 THEN 0 ELSE quantity - ? END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND drug_id = ?
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            AND quantity + 0.005 >= ?
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
        const openShift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(session.id) as any;
        if (openShift) {
          await db.prepare(`
            INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, notes, date)
            VALUES (?, ?, ?, 'in', 'purchase_return', ?, ?, ?)
          `).run(generateId(), session.id, openShift.id, totalAmount, `مرتجع مشتريات نقدي للمورد رقم ${data.supplier_id}`, new Date().toISOString().split('T')[0]);
        }
        
        await db.prepare(`
          INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
          VALUES (?, 'return', ?, ?, ?)
        `).run(data.supplier_id, totalAmount, returnId, data.reason || 'مرتجع نقدي');
        
        await db.prepare(`
          INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
          VALUES (?, 'payment', ?, ?, ?)
        `).run(data.supplier_id, -totalAmount, returnId, 'استرداد نقدي للمرتجع');
      }

      await logActivity(session.id, 'create_purchase_return', `إضافة مرتجع مشتريات للمورد ${data.supplier_id} بقيمة ${totalAmount}`);
      return returnId;
    });

    const result = await transaction();
    return { success: true, id: result };
  } catch (err: any) {
    console.error('createPurchaseReturnAction error:', err);
    return { success: false, error: err.message || (typeof err === 'string' ? err : 'Unknown error') };
  }
}

export async function getPurchaseReturnsAction() {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
    const pharmacyId = session.pharmacy_id || 'local_default';

    const rows = await db.prepare(`
      SELECT pr.*, s.name_ar as supplier_name, u.full_name as user_name,
        pi.invoice_number, pi.invoice_date,
        (SELECT COUNT(*) FROM purchase_return_items pri WHERE pri.purchase_return_id = pr.id) as items_count
      FROM purchase_returns pr
      LEFT JOIN suppliers s ON s.id = pr.supplier_id
      LEFT JOIN users u ON u.id = pr.user_id
      JOIN purchase_invoices pi ON pi.id = pr.purchase_invoice_id
      WHERE pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default')
      ORDER BY pr.created_at DESC
      LIMIT 100
    `).all(pharmacyId, pharmacyId) as any[];
    return { success: true, data: rows };
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
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function getDrugInventoryQuantityAction(drugId: number) {
  const user = await getLocalSession();
  if (!user || !hasUserPermissionSync(user, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };
  const pharmacyId = user.pharmacy_id || 'local_default';
  const row = await db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as quantity
    FROM inventory
    WHERE drug_id = ?
      AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
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

    await ensureBarcodeColumn();
    const pharmacyId = session.pharmacy_id || 'local_default';
    const ownedInvoice = await db.prepare(`
      SELECT id FROM purchase_invoices
      WHERE id = ? AND status = 'completed'
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(data.id, pharmacyId, pharmacyId);
    if (!ownedInvoice) return { success: false, error: 'Completed purchase invoice not found in this pharmacy' };

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
      revalidatePath('/purchases');
      revalidatePath('/inventory');
      revalidatePath('/purchases/suppliers');
      return { success: true };
    }

    const transaction = db.transaction(async () => {
      // 1. Get existing completed invoice and items
      const invoice = await db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(data.id) as any;
      if (!invoice) throw new Error('فاتورة الشراء غير موجودة');
      if (invoice.status !== 'completed') throw new Error('هذه الفاتورة ليست مكتملة');

      const oldItems = await db.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id = ?').all(data.id) as any[];

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
      const oldBatchNumber = invoice.invoice_number || 'BATCH-' + data.id.substring(0, 8);
      const findOldInventory = (oldItem: any) => oldInvItems.find((inventory: any) => {
        if (oldItem.inventory_id && String(inventory.id) === String(oldItem.inventory_id)) return true;
        return String(inventory.drug_id) === String(oldItem.drug_id)
          && normalizeDateToYMD(inventory.expiry_date) === normalizeDateToYMD(oldItem.expiry_date)
          && String(inventory.batch_number || '') === String(oldBatchNumber);
      });

      // 3. Validation: check if any reduction in quantity is safe (not sold yet)
      for (const oldItem of oldItems) {
        const inv = findOldInventory(oldItem);
        const oldQty = Number(oldItem.quantity) + (Number(oldItem.bonus_quantity) || 0);

        const newItem = data.cart.find((c: any) => String(c.id) === String(oldItem.drug_id));
        
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
      const newBatchNumber = data.invoice_number || 'BATCH-' + data.id.substring(0, 8);
      const inventoryIdsByDrug = new Map<string, string>();
      
      // We will first handle updates/deletions of old items
      for (const oldItem of oldItems) {
        const inv = findOldInventory(oldItem);
        const oldQty = Number(oldItem.quantity) + (Number(oldItem.bonus_quantity) || 0);
        
        const newItem = data.cart.find((c: any) => String(c.id) === String(oldItem.drug_id));

        if (!newItem) {
          // Item removed
          if (inv) {
            await db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(oldQty, inv.id);
          }
        } else {
          // Item updated
          const newQty = Number(newItem.quantity) + (Number(newItem.bonus_quantity) || 0);
          
          // Calculate item subtotal, tax, discount for unit cost
          const itemSubtotal = (newItem.quantity * newItem.cost_price);
          const itemTax = itemSubtotal * (newItem.tax_percent / 100);
          const itemTotal = itemSubtotal + itemTax;
          const netUnitCost = newQty > 0 ? (itemTotal / newQty) : newItem.cost_price;

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
                  updated_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).run(
              newInvQty,
              newItem.selling_price || 0,
              netUnitCost,
              normalizeDateToYMD(newItem.expiry_date),
              newBatchNumber,
              newItem.strips_per_box || 1,
              inv.id
            );
            inventoryIdsByDrug.set(String(newItem.id), String(inv.id));
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
            });
            inventoryIdsByDrug.set(String(newItem.id), inventoryId);
          }
        }
      }

      // Add entirely new items (that weren't in old items)
      for (const newItem of data.cart) {
        const isNew = !oldItems.some((o: any) => String(o.drug_id) === String(newItem.id));
        if (isNew) {
          const newQty = Number(newItem.quantity) + (Number(newItem.bonus_quantity) || 0);
          const itemSubtotal = (newItem.quantity * newItem.cost_price);
          const itemTax = itemSubtotal * (newItem.tax_percent / 100);
          const itemTotal = itemSubtotal + itemTax;
          const netUnitCost = newQty > 0 ? (itemTotal / newQty) : newItem.cost_price;

          const inventoryId = await addToInventory({
            drugId: newItem.id,
            pharmacyId: session.pharmacy_id,
            quantity: newQty,
            sellingPrice: newItem.selling_price || 0,
            costPrice: netUnitCost,
            expiryDate: normalizeDateToYMD(newItem.expiry_date),
            batchNumber: newBatchNumber,
            stripsPerBox: newItem.strips_per_box || 1,
          });
          inventoryIdsByDrug.set(String(newItem.id), inventoryId);
        }
      }

      // Now clear old items and insert all new ones from data.cart into purchase_invoice_items
      await db.prepare('DELETE FROM purchase_invoice_items WHERE invoice_id = ?').run(data.id);
      
      let totalAmount = 0;
      const itemStmt = await db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, barcode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const item of data.cart) {
        const normExpiry = normalizeDateToYMD(item.expiry_date);
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
          item.barcode || null
        );
        const inventoryId = inventoryIdsByDrug.get(String(item.id));
        if (inventoryId) {
          await db.prepare('UPDATE purchase_invoice_items SET inventory_id = ? WHERE id = ?').run(
            inventoryId,
            purchaseItemResult.lastInsertRowid
          );
        }

        if (item.strips_per_box) {
          await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(item.strips_per_box, item.id);
          secureCache.updateDrug(Number(item.id), { large_to_medium: item.strips_per_box });
        }

        if (item.barcode) {
          await db.prepare('UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = "")').run(item.barcode, item.id);
          await db.prepare('UPDATE inventory SET barcode = ? WHERE drug_id = ? AND (barcode IS NULL OR barcode = "")').run(item.barcode, item.id);
          secureCache.updateDrug(Number(item.id), { barcode: item.barcode });
        }

        const itemSubtotal = (item.quantity * item.cost_price);
        const itemTax = itemSubtotal * (item.tax_percent / 100);
        const itemTotal = itemSubtotal + itemTax;
        totalAmount += itemTotal;
      }

      // Calculate new invoice total
      const invoiceExpenses = data.expenses || 0;
      const invoiceDiscountVal = data.discount_value || 0;
      const invoiceDiscountPct = (totalAmount + invoiceExpenses - invoiceDiscountVal) * ((data.discount_percent || 0) / 100);
      const newTotal = totalAmount + invoiceExpenses - invoiceDiscountVal - invoiceDiscountPct;

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
        data.invoice_date || new Date().toISOString().split('T')[0],
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
        const openShift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(session.id) as any;
        if (openShift && diff !== 0) {
          const type = diff > 0 ? 'disbursement' : 'receipt';
          await db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
            generateId(), session.id, openShift.id, type, Math.abs(diff), 'purchases', `تعديل فاتورة شراء رقم ${data.invoice_number || data.id.slice(0, 8)}`, new Date().toISOString().split('T')[0]
          );
        }
      }

      // Accounting / Journal Entries update
      const oldJournals = await db.prepare("SELECT id FROM daily_journals WHERE description LIKE ?").all(`%فاتورة شراء%${invoice.invoice_number || invoice.id.slice(0, 8)}%`) as any[];
      for (const j of oldJournals) {
        await db.prepare('DELETE FROM journal_entries WHERE journal_id = ?').run(j.id);
        await db.prepare('DELETE FROM daily_journals WHERE id = ?').run(j.id);
      }

      const journalId = generateId();
      const purchaseDate = data.invoice_date || new Date().toISOString().split('T')[0];
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, purchaseDate, `فاتورة شراء رقم ${data.invoice_number || data.id.slice(0, 8)}`, session.id, newTotal);

      const getAccountId = async (cat: string) => {
        const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
        return s?.account_id;
      };

      const accounts = {
        cash: await getAccountId('cash_drawer') || 6,
        payable: await getAccountId('accounts_payable') || 7,
        inventory: await getAccountId('inventory_asset') || 10
      };

      try {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', newTotal);
      } catch (e) {
        console.warn('Accounting missing: could not insert inventory journal entry', e);
      }

      if (data.payment_method === 'credit' || data.payment_method === 'check') {
        try {
          if (accounts.payable) await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.payable, 'credit', newTotal);
        } catch (e) {
          console.warn('Accounting missing: could not insert payable journal entry', e);
        }
      } else {
        try {
          if (accounts.cash) await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cash, 'credit', newTotal);
        } catch (e) {
          console.warn('Accounting missing: could not insert cash journal entry', e);
        }
      }

      logActivity(session.id, 'EDIT_COMPLETED_PURCHASE', `تعديل فاتورة شراء مكتملة بقيمة جديدة: ${newTotal.toFixed(2)}`);
      return data.id;
    });

    await transaction();

    revalidatePath('/purchases');
    revalidatePath('/inventory');
    revalidatePath('/purchases/suppliers');
    
    return { success: true };
  } catch (error: any) {
    console.error('updateCompletedPurchaseInvoiceAction error:', error?.message || error);
    return { success: false, error: error?.message || String(error) || 'فشل تعديل الفاتورة' };
  }
}
