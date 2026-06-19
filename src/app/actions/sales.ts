'use server';
import db from '@/lib/db/local';
import { getLocalSession } from '@/lib/auth/local';
import { z } from 'zod';
import crypto from 'crypto';
import { secureCache } from '@/lib/cache/secure_cache';

const CheckoutItemSchema = z.object({
  drug_id: z.union([z.number(), z.string()]),
  quantity_sold: z.number().positive(),
  unit_price: z.number().nonnegative(),
  selected_unit: z.enum(['large', 'medium', 'small']).default('large'),
  is_negative: z.boolean().default(false),
});

const CheckoutRequestSchema = z.object({
  items: z.array(CheckoutItemSchema).min(1),
  patient_id: z.string().optional(),
  shift_id: z.string().optional(),
  payment_method: z.enum(['cash', 'credit', 'check', 'visa', 'delivery', 'wallet']).default('cash'),
  check_number: z.string().optional(),
  status: z.enum(['completed', 'draft']).default('completed'),
  total_discount: z.number().nonnegative().optional().default(0),
  additional_fees: z.number().nonnegative().optional().default(0),
});

export async function searchDrugsAction(searchTerm: string, limit = 20) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    if (!searchTerm || searchTerm.trim().length === 0) {
      return { success: true, data: [] };
    }

    let exactMatch = null;
    const searchLower = searchTerm.toLowerCase().trim();
    
    await secureCache.load();
    const allDrugs = secureCache.getAllDrugs();
    const cacheMatched = allDrugs.filter((d: any) => {
      const match = (d.trade_name && d.trade_name.toLowerCase().includes(searchLower)) || 
             (d.trade_name_en && d.trade_name_en.toLowerCase().includes(searchLower)) || 
             (d.generic_name && d.generic_name.toLowerCase().includes(searchLower)) ||
             (d.active_ingredient && d.active_ingredient.toLowerCase().includes(searchLower)) ||
             d.barcode === searchLower || 
             d.id.toString() === searchLower;
             
      if (d.barcode === searchLower || d.id.toString() === searchLower) exactMatch = d;
      return match;
    });

    // Search custom drugs in SQLite db
    const likePattern = `%${searchLower}%`;
    const dbMatched = await db.prepare(`
      SELECT * FROM master_drugs 
      WHERE (trade_name LIKE ? OR trade_name_en LIKE ? OR active_ingredient LIKE ? OR barcode = ?)
        AND (trade_name IS NULL OR trade_name != 'SECURE')
        AND (trade_name_en IS NULL OR trade_name_en != 'SECURE')
    `).all(likePattern, likePattern, likePattern, searchLower) as any[];

    // Combine both and remove duplicates
    const combinedMap = new Map<string, any>();
    
    // Find exact match in dbMatched
    let exactDbMatch = dbMatched.find((d: any) => d.barcode === searchLower || d.id.toString() === searchLower);

    if (exactMatch) {
      combinedMap.set(String(exactMatch.id), exactMatch);
    } else if (exactDbMatch) {
      combinedMap.set(String(exactDbMatch.id), exactDbMatch);
    }

    for (const item of cacheMatched) {
      if (!combinedMap.has(String(item.id))) {
        combinedMap.set(String(item.id), item);
      }
    }

    for (const item of dbMatched) {
      if (!combinedMap.has(String(item.id))) {
        combinedMap.set(String(item.id), item);
      }
    }

    const matchedDrugs = Array.from(combinedMap.values()).slice(0, limit);

    if (matchedDrugs.length === 0) return { success: true, data: [] };

    const matchedIds = matchedDrugs.map((d: any) => d.id);
    const placeholders = matchedIds.map(() => '?').join(',');

    const inventoryAgg = await db.prepare(`
      SELECT drug_id, 
             COALESCE(SUM(quantity), 0) as total_stock,
             MIN(local_selling_price) as min_price,
             AVG(cost_price) as avg_cost_price,
             MIN(expiry_date) as nearest_expiry,
             MAX(strips_per_box) as max_strips
      FROM inventory
      WHERE drug_id IN (${placeholders})
      GROUP BY drug_id
    `).all(...matchedIds) as any[];

    const today = new Date().toISOString().split('T')[0];

    const data = matchedDrugs.map((drug: any) => {
      const inv = inventoryAgg.find((i: any) => i.drug_id === drug.id) || {};
      return {
        id: drug.id,
        trade_name: drug.trade_name_en || drug.trade_name || 'بدون اسم تجاري',
        active_ingredient: drug.active_ingredient || drug.generic_name || '---',
        category: drug.category,
        official_price: drug.official_price,
        total_stock: inv.total_stock || 0,
        min_price: inv.min_price || drug.official_price,
        cost_price: inv.avg_cost_price || 0,
        nearest_expiry: inv.nearest_expiry,
        is_expired: inv.nearest_expiry ? inv.nearest_expiry < today : false,
        large_unit: drug.large_unit,
        medium_unit: drug.medium_unit,
        small_unit: drug.small_unit,
        large_to_medium: inv.max_strips > 1 ? inv.max_strips : (drug.large_to_medium || 1),
        medium_to_small: drug.medium_to_small || 1,
        reorder_point: drug.reorder_point || 0,
        profit_margin: (inv.min_price && inv.avg_cost_price > 0)
          ? Math.round(((inv.min_price - inv.avg_cost_price) / inv.min_price) * 100)
          : null,
        needs_reorder: drug.reorder_point ? (inv.total_stock || 0) <= drug.reorder_point : false,
        units: {
          large: drug.large_unit || 'علبة',
          medium: drug.medium_unit || 'شريط',
          small: drug.small_unit,
          large_to_medium: inv.max_strips > 1 ? inv.max_strips : (drug.large_to_medium || 1),
          medium_to_small: drug.medium_to_small || 1
        }
      };
    });
    return { success: true, data };
  } catch (error) {
    console.error('Drug search error:', error);
    return { success: false, error: 'فشل البحث' };
  }
}

export async function searchPatientsAction(query: string) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    if (!query || query.length < 2) {
      return { success: true, data: [] };
    }

    const searchPattern = `%${query}%`;
    const patients = db.prepare(`
      SELECT id, full_name, phone
      FROM patients
      WHERE (full_name LIKE ? OR phone LIKE ?)
      LIMIT 5
    `).all(searchPattern, searchPattern) as any[];

    return { success: true, data: patients };
  } catch (error: any) {
    console.error('Patient search action error:', error);
    return { success: false, error: 'فشل البحث عن المرضى' };
  }
}

export async function barcodeLookupAction(barcode: string) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    if (!barcode) {
      return { success: false, error: 'الباركود مطلوب' };
    }

    const drug = db.prepare(`
      SELECT
        md.id,
        md.trade_name,
        md.trade_name_en,
        md.generic_name,
        md.active_ingredient,
        md.category,
        md.official_price,
        md.large_unit,
        md.medium_unit,
        md.small_unit,
        md.large_to_medium,
        md.medium_to_small,
        md.reorder_point,
        i.local_selling_price as unit_price,
        i.cost_price as avg_cost_price,
        i.quantity,
        i.expiry_date as nearest_expiry,
        i.id as inventory_id
      FROM master_drugs md
      INNER JOIN inventory i ON md.id = i.drug_id
      WHERE i.barcode = ?
      LIMIT 1
    `).get(barcode) as any;

    if (!drug) {
      return { success: true, data: null };
    }

    const today = new Date().toISOString().split('T')[0];

    const data = {
      id: drug.id,
      trade_name: drug.trade_name_en || drug.trade_name || drug.generic_name || 'غير معروف',
      active_ingredient: drug.active_ingredient || drug.generic_name || '---',
      category: drug.category,
      official_price: drug.official_price,
      unit_price: drug.unit_price,
      quantity: drug.quantity,
      inventory_id: drug.inventory_id,
      cost_price: drug.avg_cost_price || 0,
      nearest_expiry: drug.nearest_expiry,
      is_expired: drug.nearest_expiry ? drug.nearest_expiry < today : false,
      reorder_point: drug.reorder_point || 0,
      needs_reorder: drug.reorder_point ? drug.quantity <= drug.reorder_point : false,
      profit_margin: drug.unit_price && drug.avg_cost_price > 0 
        ? Math.round(((drug.unit_price - drug.avg_cost_price) / drug.unit_price) * 100) 
        : null,
      units: {
        large: drug.large_unit || 'علبة',
        medium: drug.medium_unit,
        small: drug.small_unit,
        large_to_medium: drug.large_to_medium || 1,
        medium_to_small: drug.medium_to_small || 1
      }
    };

    return { success: true, data };
  } catch (error: any) {
    console.error('Barcode lookup action error:', error);
    return { success: false, error: 'فشل البحث بالباركود' };
  }
}

export async function fetchDraftsAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const pharmacyId = localUser.pharmacy_id || 'local_default';

    // Fetch draft invoices with their items and patient info
    const drafts = db.prepare(`
      SELECT 
        si.id,
        si.total_amount,
        si.created_at,
        p.full_name as patient_name,
        si.patient_id,
        si.payment_method,
        si.discount_amount
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.pharmacy_id = ? AND si.status = 'draft'
      ORDER BY si.created_at DESC
    `).all(pharmacyId) as any[];

    // Prepare item fetch query once
    const getDraftItemsStmt = db.prepare(`
      SELECT 
        si.drug_id,
        si.quantity_sold as qty,
        si.unit_price as price,
        si.unit as selectedUnit,
        si.is_negative,
        md.trade_name,
        md.trade_name_en,
        md.active_ingredient,
        md.large_unit,
        md.medium_unit,
        md.small_unit,
        md.large_to_medium,
        md.medium_to_small,
        md.official_price,
        md.reorder_point,
        IFNULL((SELECT SUM(quantity) FROM inventory WHERE drug_id = si.drug_id AND pharmacy_id = ?), 0) as total_stock
      FROM sales_items si
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      WHERE si.invoice_id = ?
    `);

    // For each draft, fetch items
    const draftsWithItems = await Promise.all(drafts.map(async draft => {
      const items = getDraftItemsStmt.all(pharmacyId, draft.id) as any[];

      return {
        ...draft,
        items: items.map(item => ({
          ...item,
          trade_name: item.trade_name_en || item.trade_name,
          units: {
            large: item.large_unit || 'علبة',
            medium: item.medium_unit,
            small: item.small_unit,
            large_to_medium: item.large_to_medium || 1,
            medium_to_small: item.medium_to_small || 1
          },
          basePrice: item.official_price,
          total_stock: item.total_stock,
          reorder_point: item.reorder_point || 0
        }))
      };
    }));

    return { success: true, data: draftsWithItems };
  } catch (error: any) {
    console.error('Fetch drafts action error:', error);
    return { success: false, error: 'فشل جلب المسودات' };
  }
}

export async function processCheckoutAction(data: any) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const pharmacyId = localUser.pharmacy_id || 'local_default';
    const userId = localUser.id;

    const validatedData = CheckoutRequestSchema.parse(data);

    // Pre-compiled prepared statements for POS checkout performance
    const getPatientStmt = db.prepare('SELECT credit_limit, wallet_balance, loyalty_level FROM patients WHERE id = ?');
    
    const getOutstandingBalanceStmt = db.prepare(`
      SELECT (
        (SELECT COALESCE(opening_balance, 0) FROM patients WHERE id = ?) +
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales_invoices WHERE patient_id = ? AND payment_method = 'credit' AND status = 'completed') -
        (SELECT COALESCE(SUM(r.total_refund), 0) FROM returns r JOIN sales_invoices si ON r.invoice_id = si.id WHERE si.patient_id = ?) -
        (SELECT COALESCE(SUM(amount), 0) FROM patient_transactions WHERE patient_id = ? AND type IN ('payment', 'adjustment'))
      ) as outstanding_balance
    `);

    const getDrugInfoStmt = db.prepare(`
      SELECT m.trade_name, m.large_to_medium, m.medium_to_small, m.has_expiry,
             COALESCE((SELECT MAX(strips_per_box) FROM inventory WHERE drug_id = m.id), 1) as max_strips
      FROM master_drugs m
      WHERE m.id = ?
    `);

    const insertSalesItemStmt = db.prepare(`
      INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, cost_price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const getValidStockStmt = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as total
      FROM inventory
      WHERE drug_id = ? AND (expiry_date IS NULL OR expiry_date >= ?)
    `);

    const getBatchesStmt = db.prepare(`
      SELECT id, quantity, cost_price, expiry_date
      FROM inventory
      WHERE drug_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= ?)
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
    `);

    const updateInventoryStockStmt = db.prepare(
      'UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );

    const insertInvoiceStmt = db.prepare(`
      INSERT INTO sales_invoices (id, pharmacy_id, user_id, patient_id, shift_id, total_amount, payment_method, check_number, status, discount_amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const insertDailyJournalStmt = db.prepare(`
      INSERT INTO daily_journals (id, date, description, created_by, total_amount)
      VALUES (?, ?, ?, ?, ?)
    `);

    const getAccountIdStmt = db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?');

    const insertJournalEntryStmt = db.prepare(
      'INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)'
    );

    const updatePatientWalletStmt = db.prepare(
      'UPDATE patients SET wallet_balance = wallet_balance - ? WHERE id = ?'
    );

    const insertRefillReminderStmt = db.prepare(`
      INSERT INTO refill_reminders (id, patient_id, drug_id, last_sold_date, next_refill_date, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const updatePatientPointsStmt = db.prepare(
      'UPDATE patients SET points_balance = points_balance + ? WHERE id = ?'
    );

    // Patient Financial Validation
    if (validatedData.patient_id && validatedData.status === 'completed') {
      const patient = getPatientStmt.get(validatedData.patient_id) as any;
      if (patient) {
        const subTotal = validatedData.items.reduce((sum, item) => sum + (item.unit_price * item.quantity_sold), 0) - (validatedData.total_discount || 0);

        if (validatedData.payment_method === 'credit') {
           const balanceRow = getOutstandingBalanceStmt.get(validatedData.patient_id, validatedData.patient_id, validatedData.patient_id, validatedData.patient_id) as any;
           const currentDebt = balanceRow?.outstanding_balance || 0;

           if ((currentDebt + subTotal) > (patient.credit_limit || 0)) {
             return { success: false, error: `تجاوز العميل الحد الائتماني المسموح به (${patient.credit_limit} ج.م)` };
           }
        }

        if (validatedData.payment_method === 'wallet') {
          if (subTotal > (patient.wallet_balance || 0)) {
            return { success: false, error: `رصيد المحفظة غير كافٍ (${patient.wallet_balance} ج.م)` };
          }
        }
      }
    } else if (validatedData.payment_method === 'credit' || validatedData.payment_method === 'wallet') {
      return { success: false, error: 'يجب اختيار مريض للبيع بالأجل أو باستخدام المحفظة' };
    }

    const saleId = crypto.randomUUID();
    let totalAmount = 0;

    try {
      db.exec('BEGIN TRANSACTION');

      const today = new Date().toISOString().split('T')[0];
      let totalCogs = 0;

      for (const item of validatedData.items) {
        const drugInfo = getDrugInfoStmt.get(item.drug_id) as any;
        const drugName = drugInfo?.trade_name || `Drug #${item.drug_id}`;
        
        let deductionQty = item.quantity_sold;
        const actualLargeToMedium = drugInfo?.max_strips > 1 ? drugInfo.max_strips : (drugInfo?.large_to_medium || 1);
        
        if (item.selected_unit === 'medium') {
          deductionQty = item.quantity_sold / actualLargeToMedium;
        } else if (item.selected_unit === 'small') {
          deductionQty = item.quantity_sold / (actualLargeToMedium * (drugInfo?.medium_to_small || 1));
        }

        if (validatedData.status === 'completed') {
          if (item.is_negative) {
             insertSalesItemStmt.run(saleId, null, item.drug_id, item.quantity_sold, item.unit_price, item.selected_unit, 1, 0);
             continue;
          }

          const validStock = getValidStockStmt.get(item.drug_id, today) as any;
          if (validStock.total < deductionQty) {
            throw new Error(`الكمية غير كافية للصنف "${drugName}" (المتاح: ${validStock.total.toFixed(2)})`);
          }

          let remainingToDeduct = deductionQty;
          const batches = getBatchesStmt.all(item.drug_id, today) as any[];

          for (const batch of batches) {
            if (remainingToDeduct <= 0) break;

            const deductFromThisBatch = Math.min(batch.quantity, remainingToDeduct);
            const batchProp = deductFromThisBatch / deductionQty;
            const quantityInSelectedUnit = item.quantity_sold * batchProp;

            updateInventoryStockStmt.run(deductFromThisBatch, batch.id);
            insertSalesItemStmt.run(saleId, batch.id, item.drug_id, quantityInSelectedUnit, item.unit_price, item.selected_unit, 0, batch.cost_price || 0);

            totalCogs += (batch.cost_price || 0) * deductFromThisBatch;
            remainingToDeduct -= deductFromThisBatch;
          }
        } else {
          insertSalesItemStmt.run(saleId, null, item.drug_id, item.quantity_sold, item.unit_price, item.selected_unit, item.is_negative ? 1 : 0, 0);
        }
      }

      totalAmount = validatedData.items.reduce(
        (sum, item) => sum + (item.unit_price * item.quantity_sold),
        0
      ) - (validatedData.total_discount || 0) + (validatedData.additional_fees || 0);

      insertInvoiceStmt.run(
        saleId, pharmacyId, userId, 
        validatedData.patient_id || null, 
        validatedData.shift_id || null, 
        totalAmount, 
        validatedData.payment_method,
        validatedData.check_number || null,
        validatedData.status,
        validatedData.total_discount || 0
      );

      if (validatedData.status === 'completed') {
        const journalId = crypto.randomUUID();
        const saleDate = new Date().toISOString().split('T')[0];
        
        insertDailyJournalStmt.run(journalId, saleDate, `فاتورة مبيعات رقم ${saleId.slice(0, 8)}`, userId, totalAmount + totalCogs);

        const getAccountId = (cat: string) => {
          const s = getAccountIdStmt.get(cat) as any;
          return s?.account_id;
        };

        const accounts = {
          cash: getAccountId('cash_drawer') || 6,
          receivable: getAccountId('accounts_receivable') || 8,
          sales: getAccountId('sales_revenue') || 9,
          inventory: getAccountId('inventory_asset') || 10,
          cogs: getAccountId('cogs_expense') || 11
        };

        let debitAccount = accounts.cash;
        if (validatedData.payment_method === 'credit') debitAccount = accounts.receivable;
        if (validatedData.payment_method === 'wallet') debitAccount = accounts.receivable;

        insertJournalEntryStmt.run(journalId, debitAccount, 'debit', totalAmount);
        insertJournalEntryStmt.run(journalId, accounts.sales, 'credit', totalAmount);

        if (validatedData.payment_method === 'wallet' && validatedData.patient_id) {
          updatePatientWalletStmt.run(totalAmount, validatedData.patient_id);
        }

        if (totalCogs > 0) {
          insertJournalEntryStmt.run(journalId, accounts.cogs, 'debit', totalCogs);
          insertJournalEntryStmt.run(journalId, accounts.inventory, 'credit', totalCogs);
        }
      }

      if (validatedData.status === 'completed' && validatedData.patient_id) {
        const patient = getPatientStmt.get(validatedData.patient_id) as any;
        const multiplier = patient?.loyalty_level === 'platinum' ? 2 : patient?.loyalty_level === 'gold' ? 1.5 : patient?.loyalty_level === 'silver' ? 1.2 : 1;

        for (const item of validatedData.items) {
          const reminderId = crypto.randomUUID();
          const nextRefillDate = new Date();
          const days = item.selected_unit === 'large' ? 30 : item.selected_unit === 'medium' ? 10 : 3;
          nextRefillDate.setDate(nextRefillDate.getDate() + (days * item.quantity_sold));

          insertRefillReminderStmt.run(reminderId, validatedData.patient_id, item.drug_id, today, nextRefillDate.toISOString().split('T')[0]);
        }

        const pointsEarned = Math.floor(totalAmount * multiplier);
        if (pointsEarned > 0) {
          updatePatientPointsStmt.run(pointsEarned, validatedData.patient_id);
        }
      }

      db.exec('COMMIT');

      return {
        success: true,
        data: {
          sale_id: saleId,
          total_amount: totalAmount,
          points_earned: validatedData.patient_id ? Math.floor(totalAmount) : 0
        }
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error: any) {
    console.error('Checkout error:', error);
    return { success: false, error: error.message || 'فشلت معالجة عملية البيع' };
  }
}

export async function getSalesDashboardStatsAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    // Today's Sales
    const todaySalesRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total 
      FROM sales_invoices 
      WHERE DATE(created_at) = DATE('now', 'localtime') AND status IN ('completed', 'delivered')
    `).get() as any;
    const todaySales = todaySalesRow?.total || 0;

    // Yesterday's Sales
    const yesterdaySalesRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total 
      FROM sales_invoices 
      WHERE DATE(created_at) = DATE('now', '-1 day', 'localtime') AND status IN ('completed', 'delivered')
    `).get() as any;
    const yesterdaySales = yesterdaySalesRow?.total || 0;

    let salesChangeText = 'استقرار المبيعات مقارنة بالمساء';
    if (yesterdaySales > 0) {
      const pctDiff = ((todaySales - yesterdaySales) / yesterdaySales) * 100;
      if (pctDiff >= 0) {
        salesChangeText = `بزيادة ${pctDiff.toFixed(0)}% عن يوم أمس`;
      } else {
        salesChangeText = `بانخفاض ${Math.abs(pctDiff).toFixed(0)}% عن يوم أمس`;
      }
    } else if (todaySales > 0) {
      salesChangeText = 'مبيعات أولية اليوم';
    }

    // Delivery Stats
    const deliveryCountRow = db.prepare(`
      SELECT COUNT(*) as total 
      FROM sales_invoices 
      WHERE payment_method = 'delivery' AND DATE(created_at) = DATE('now', 'localtime')
    `).get() as any;
    const deliveryCount = deliveryCountRow?.total || 0;

    const pendingDeliveryRow = db.prepare(`
      SELECT COUNT(*) as pending 
      FROM sales_invoices 
      WHERE payment_method = 'delivery' AND status = 'completed'
    `).get() as any;
    const pendingDeliveryCount = pendingDeliveryRow?.pending || 0;
    const pendingDeliveryCountText = `يوجد ${pendingDeliveryCount} طلبات قيد الانتظار`;

    // Average Invoice
    const todayAvgInvoiceRow = db.prepare(`
      SELECT COALESCE(AVG(total_amount), 0) as avg_val 
      FROM sales_invoices 
      WHERE DATE(created_at) = DATE('now', 'localtime') AND status IN ('completed', 'delivered')
    `).get() as any;
    const averageInvoice = Math.round(todayAvgInvoiceRow?.avg_val || 0);

    const yesterdayAvgInvoiceRow = db.prepare(`
      SELECT COALESCE(AVG(total_amount), 0) as avg_val 
      FROM sales_invoices 
      WHERE DATE(created_at) = DATE('now', '-1 day', 'localtime') AND status IN ('completed', 'delivered')
    `).get() as any;
    const yesterdayAverageInvoice = Math.round(yesterdayAvgInvoiceRow?.avg_val || 0);

    let averageInvoiceChangeText = 'أداء مستقر للموظفين';
    if (averageInvoice > 0 && yesterdayAverageInvoice > 0) {
      const avgPct = ((averageInvoice - yesterdayAverageInvoice) / yesterdayAverageInvoice) * 100;
      if (avgPct >= 5) {
        averageInvoiceChangeText = 'تحسن ملحوظ في سلة المشتريات';
      } else if (avgPct <= -5) {
        averageInvoiceChangeText = 'انخفاض طفيف في متوسط الفاتورة';
      }
    }

    return {
      success: true,
      data: {
        todaySales,
        salesChangeText,
        deliveryCount,
        pendingDeliveryCountText,
        averageInvoice,
        averageInvoiceChangeText
      }
    };
  } catch (error: any) {
    console.error('Error fetching sales stats:', error);
    return { success: false, error: error.message || 'فشل جلب إحصائيات المبيعات' };
  }
}


