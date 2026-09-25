
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
import { requireOpenShiftId } from './finance';
import { localDate } from '@/lib/time';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
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




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

async function ensureReturnItemsSchema() {
  for (const sql of [
    'ALTER TABLE return_items ADD COLUMN sale_item_id INTEGER',
    "ALTER TABLE return_items ADD COLUMN unit TEXT DEFAULT 'large'",
    'ALTER TABLE return_items ADD COLUMN drug_id INTEGER',
    'ALTER TABLE return_items ADD COLUMN total_price REAL',
  ]) await dbExecute(sql).catch(() => {});
  await dbExecute('ALTER TABLE returns ADD COLUMN pharmacy_id TEXT').catch(() => {});
}

function unitQuantityInLarge(
  quantity: number,
  unit: string | undefined,
  largeToMedium: number,
  mediumToSmall: number,
  mediumUnit?: string,
  smallUnit?: string,
) {
  const l2m = Math.max(1, Number(largeToMedium) || 1);
  const m2s = Math.max(1, Number(mediumToSmall) || 1);
  const value = String(unit || 'large').trim().toLowerCase();
  const configuredMedium = String(mediumUnit || '').trim().toLowerCase();
  const configuredSmall = String(smallUnit || '').trim().toLowerCase();
  if (value === 'medium' || value === 'strip' || value === 'شريط' || (configuredMedium && value === configuredMedium)) return quantity / l2m;
  if (value === 'small' || value === 'unit' || value === 'pill' || (configuredSmall && value === configuredSmall)) return quantity / (l2m * m2s);
  return quantity;
}

function largeQuantityInUnit(
  quantity: number,
  unit: string | undefined,
  largeToMedium: number,
  mediumToSmall: number,
  mediumUnit?: string,
  smallUnit?: string,
) {
  const l2m = Math.max(1, Number(largeToMedium) || 1);
  const m2s = Math.max(1, Number(mediumToSmall) || 1);
  const value = String(unit || 'large').trim().toLowerCase();
  const configuredMedium = String(mediumUnit || '').trim().toLowerCase();
  const configuredSmall = String(smallUnit || '').trim().toLowerCase();
  if (value === 'medium' || value === 'strip' || value === 'شريط' || (configuredMedium && value === configuredMedium)) return quantity * l2m;
  if (value === 'small' || value === 'unit' || value === 'pill' || (configuredSmall && value === configuredSmall)) return quantity * l2m * m2s;
  return quantity;
}

/**
 * Get sales invoices by date for return flow
 */
export async function getSalesInvoicesByDateAction(dateStr: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    await ensureReturnItemsSchema();
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
          LEFT JOIN (
            SELECT sale_item_id, SUM(quantity_returned) as returned
            FROM return_items ri
            JOIN returns r ON ri.return_id = r.id
            WHERE r.status = 'approved' OR r.status = 'completed'
            GROUP BY sale_item_id
          ) ret ON si.id = ret.sale_item_id
          WHERE si.invoice_id = i.id 
            AND si.quantity_sold > COALESCE(ret.returned, 0)
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
export async function createReturnAction(data: {
  invoice_id: string;
  shift_id?: string;
  refund_method: 'cash' | 'patient_account' | 'coupon';
  reason: string;
  patient_id?: string | number;
  items: { sale_item_id?: number; inventory_id: string; drug_name: string; quantity: number; unit_price: number; unit?: string }[];
}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    if (!isTauri && typeof window !== 'undefined') {
      return {
        success: false,
        error: 'إنشاء مرتجع من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب',
      };
    }
    const shiftId = await requireOpenShiftId(String(user.id), data.shift_id);
    const pharmacyId = user.pharmacy_id || 'local_default';

    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke('create_return_critical', {
        payload: {
          invoice_id: data.invoice_id,
          user_id: user.id,
          pharmacy_id: user.pharmacy_id || null,
          shift_id: shiftId,
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
      revalidatePath('/returns');
      revalidatePath('/inventory');
      notifyInventoryChanged();
      return { success: true, returnId: result.return_id, totalRefund: result.total_refund };
    }

    await ensureReturnItemsSchema();
    try {
      await db.exec('ALTER TABLE sales_invoices ADD COLUMN points_earned INTEGER DEFAULT 0');
    } catch(e) {}

    const result = await dbTransaction(async () => {
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
    if (data.refund_method === 'patient_account' && !dbHeader.patient_id) {
      return { success: false, error: 'لا يمكن ترحيل المرتجع لحساب مريض لأن الفاتورة غير مرتبطة بمريض' };
    }
    if (
      data.refund_method === 'patient_account' &&
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
    const alreadyReturned = await db.prepare(`
      SELECT ri.sale_item_id, ri.quantity_returned, COALESCE(ri.unit, 'large') AS unit
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.invoice_id = ?
        AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        AND ri.sale_item_id IS NOT NULL
    `).all(data.invoice_id) as any[];

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
          const priorLarge = unitQuantityInLarge(
            Number(prior.quantity_returned) || 0,
            prior.unit,
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
      if (returnedInSoldUnit > (Number(soldItem.quantity_sold) - returned + 0.000001)) {
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
    const paidRatio = invoiceGross > 0 ? refundableInvoiceTotal / invoiceGross : 0;
    const totalRefund = Math.min(
      grossRequestedRefund * paidRatio,
      Math.max(0, refundableInvoiceTotal - Number(priorRefund?.total || 0))
    );

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
        let finalInventoryId = item.inventory_id;
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
          const existingInventory = await db.prepare(`
            SELECT id
            FROM inventory
            WHERE drug_id = ?
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            LIMIT 1
          `).get(drugId, pharmacyId, pharmacyId) as any;
          if (existingInventory?.id) {
            finalInventoryId = existingInventory.id;
          } else {
            const newInvId = generateId();
            const defaultExpiry = new Date();
            defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 2);
            const expiryStr = localDate(defaultExpiry);
            const batchNum = 'RET-' + generateId().substring(0, 8);
            
            await db.prepare(`
              INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, cost_price, strips_per_box, medium_to_small)
              VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
            `).run(
              newInvId,
              pharmacyId,
              drugId,
              batchNum,
              expiryStr,
              saleItem.unit_price,
              prepared.largeToMedium,
              prepared.mediumToSmall
            );
            finalInventoryId = newInvId;
          }
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
        sales: await getAccountId('sales_revenue') || 9,
        inventory: await getAccountId('inventory_asset') || 10,
        cogs: await getAccountId('cogs_expense') || 11
      };

      // Reverse Revenue: Debit Sales Revenue, Credit Cash/AR
      const creditAccount = data.refund_method === 'patient_account' ? accounts.receivable : accounts.cash;
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.sales, 'debit', totalRefund);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, creditAccount, 'credit', totalRefund);

      // Reverse COGS: Debit Inventory, Credit COGS
      if (totalCogsReversal > 0) {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', totalCogsReversal);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cogs, 'credit', totalCogsReversal);
      }

      // ponytail: record refund in patient_transactions for customer ledger visibility
      const patientId = data.patient_id || dbHeader?.patient_id;
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
          await db.prepare('UPDATE patients SET points_balance = MAX(0, COALESCE(points_balance, 0) - ?) WHERE id = ?')
            .run(pointsToReverse, String(patientId));
        }
      }

      return { success: true, returnId, totalRefund };
    });

    if (result.success) {
      logActivity(user.id, 'CREATE_RETURN', `مرتجع بقيمة ${result.totalRefund} ج.م للفاتورة ${data.invoice_id.slice(0,8)}`);
      revalidatePath('/returns');
      revalidatePath('/inventory');
      notifyInventoryChanged();
    }
    return result;
  } catch (error: any) {
    console.error('Create return error:', error);
    return { success: false, error: error.message || 'فشل إنشاء المرتجع' };
  }
}


/**
 * Get all returns
 */
export async function getReturnsAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';

    await ensureReturnItemsSchema();

    const returns = await db.prepare(`
      SELECT r.*, u.full_name as user_name, p.full_name as patient_name, si.total_amount as invoice_total, si.created_at as invoice_date
      FROM returns r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN sales_invoices si ON r.invoice_id = si.id
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all(pharmacyId, pharmacyId) as any[];

    // Get items for each return
    const returnsWithItems = await Promise.all(returns.map(async ret => {
      const items = await db.prepare('SELECT ri.*, md.trade_name_en, md.trade_name AS trade_name_ar FROM return_items ri LEFT JOIN master_drugs md ON ri.drug_id = md.id WHERE ri.return_id = ?').all(ret.id);
      return { ...ret, items };
    }));

    return { success: true, data: returnsWithItems };
  } catch (error) {
    console.error('getReturnsAction error:', error);
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
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح', data: [] };
    const pharmacyId = user.pharmacy_id || 'local_default';

    await ensureReturnItemsSchema();
    const term = searchTerm.trim();
    if (!term) return { success: true, data: [] };

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
    return { success: false, error: error.message || 'فشل البحث في مرتجع المبيعات', data: [] };
  }
}

/**
 * Get invoice details for return processing
 */
export async function getInvoiceForReturnAction(invoiceId: string) {
  try {
    await ensureReturnItemsSchema();
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_returns')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';

    const invoice = await db.prepare(`
      SELECT si.*, p.full_name as patient_name, u.full_name as user_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      LEFT JOIN users u ON si.user_id = u.id
      WHERE si.id = ?
        AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(invoiceId, pharmacyId, pharmacyId) as any;

    if (!invoice) return { success: false, error: 'الفاتورة غير موجودة' };

    const items = await db.prepare(`
      SELECT 
        sit.*, 
        md.trade_name, 
        md.trade_name_en,
        md.active_ingredient,
        md.id as drug_id,
        md.medium_unit,
        md.small_unit,
        COALESCE(NULLIF(sit.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
        COALESCE(NULLIF(sit.medium_to_small, 0), NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
        i.expiry_date,
        COALESCE((
          SELECT SUM(ri.quantity_returned)
          FROM return_items ri
          JOIN returns r ON ri.return_id = r.id
          WHERE r.invoice_id = ? AND (r.status = 'approved' OR r.status = 'completed') AND ri.sale_item_id = sit.id
        ), 0) as returned_quantity
      FROM sales_items sit
      LEFT JOIN inventory i ON sit.inventory_id = i.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      WHERE sit.invoice_id = ?
    `).all(invoiceId, invoiceId) as any[];

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
            returned_quantity: i.returned_quantity,
            unit_price: i.unit_price,
            unit: i.unit,
            expiry_date: i.expiry_date,
            large_to_medium: i.large_to_medium,
            medium_to_small: i.medium_to_small,
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
