'use server';

import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
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




import { getLocalSession } from '@/lib/auth/local';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

/**
 * Create a return/refund request
 */
export async function createReturnAction(data: {
  invoice_id: string;
  shift_id?: string;
  refund_method: 'cash' | 'patient_account' | 'coupon';
  reason: string;
  items: { inventory_id: string | null; drug_name: string; quantity: number; unit_price: number }[];
}) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const dbHeader = await db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(data.invoice_id) as any;
    if (!dbHeader) return { success: false, error: 'الفاتورة غير موجودة' };

    // 1. Validate: check for non-returnable drugs
    for (const item of data.items) {
      const drugCheck = await db.prepare(`
        SELECT md.no_return, md.trade_name, si.drug_id
        FROM sales_items si
        LEFT JOIN master_drugs md ON si.drug_id = md.id
        WHERE si.invoice_id = ? AND si.inventory_id IS ? AND (md.trade_name = ? OR md.trade_name_en = ?)
      `).get(data.invoice_id, item.inventory_id, item.drug_name, item.drug_name) as any;
      
      if (drugCheck?.no_return) {
        return { success: false, error: `الصنف "${drugCheck.trade_name}" غير قابل للارتجاع` };
      }
    }

    // 2. Validate: remaining quantity on invoice
    const invoiceItems = await db.prepare(`
      SELECT si.*, md.trade_name, md.trade_name_en
      FROM sales_items si
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      WHERE si.invoice_id = ?
    `).all(data.invoice_id) as any[];

    const alreadyReturned = await db.prepare(`
      SELECT ri.inventory_id, ri.drug_name, SUM(ri.quantity_returned) as total
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.invoice_id = ? AND r.status = 'approved'
      GROUP BY ri.inventory_id, ri.drug_name
    `).all(data.invoice_id) as any[];

    for (const returnItem of data.items) {
      const soldItem = invoiceItems.find(si => 
        (si.inventory_id === returnItem.inventory_id || (!si.inventory_id && !returnItem.inventory_id)) && 
        (si.trade_name === returnItem.drug_name || si.trade_name_en === returnItem.drug_name)
      );
      if (!soldItem) continue;

      const returned = alreadyReturned.find(ar => 
        (ar.inventory_id === returnItem.inventory_id || (!ar.inventory_id && !returnItem.inventory_id)) && 
        ar.drug_name === returnItem.drug_name
      )?.total || 0;
      if (returnItem.quantity > (soldItem.quantity_sold - returned)) {
        return { success: false, error: `كمية المرتجع تتجاوز الكمية المتبقية للصنف "${returnItem.drug_name}"` };
      }
    }

    const returnId = generateId();
    const totalRefund = data.items.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);

    const transaction = db.transaction(async () => {
      // 3. Create return header
      await db.prepare(`
        INSERT INTO returns (id, invoice_id, user_id, shift_id, reason, total_refund, refund_method, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')
      `).run(returnId, data.invoice_id, user.id, data.shift_id || null, data.reason, totalRefund, data.refund_method);

      let totalCogsReversal = 0;

      // 4. Create return items and restock
      for (const item of data.items) {
        const saleItem = invoiceItems.find(si => 
          (si.inventory_id === item.inventory_id || (!si.inventory_id && !item.inventory_id)) && 
          (si.trade_name === item.drug_name || si.trade_name_en === item.drug_name)
        );
        let finalInventoryId = item.inventory_id;
        let drugId = saleItem ? saleItem.drug_id : null;

        // If drugId is not found, we can query it
        if (!drugId && item.drug_name) {
          const drugRow = await db.prepare('SELECT id FROM master_drugs WHERE trade_name = ? OR trade_name_en = ? LIMIT 1').get(item.drug_name, item.drug_name) as any;
          if (drugRow) drugId = drugRow.id;
        }

        if (!drugId && finalInventoryId) {
          const invRow = await db.prepare('SELECT drug_id FROM inventory WHERE id = ?').get(finalInventoryId) as any;
          if (invRow) drugId = invRow.drug_id;
        }

        let inventoryExists = false;
        if (finalInventoryId) {
          const checkInv = await db.prepare('SELECT 1 FROM inventory WHERE id = ?').get(finalInventoryId);
          if (checkInv) inventoryExists = true;
        }

        if (!inventoryExists && drugId) {
          // Try to find any inventory row for this drug
          const existingInventory = await db.prepare('SELECT id FROM inventory WHERE drug_id = ? LIMIT 1').get(drugId) as any;
          if (existingInventory?.id) {
            finalInventoryId = existingInventory.id;
          } else {
            const newInvId = generateId();
            const defaultExpiry = new Date();
            defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 2);
            const expiryStr = defaultExpiry.toISOString().split('T')[0];
            const batchNum = 'RET-' + generateId().substring(0, 8);
            
            await db.prepare(`
              INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, cost_price)
              VALUES (?, ?, ?, ?, ?, 0, ?, 0)
            `).run(newInvId, user?.pharmacy_id || 'local_default', drugId, batchNum, expiryStr, item.unit_price);
            
            finalInventoryId = newInvId;
          }
        }

        await db.prepare(`
          INSERT INTO return_items (return_id, inventory_id, drug_name, quantity_returned, unit_price)
          VALUES (?, ?, ?, ?, ?)
        `).run(returnId, finalInventoryId, item.drug_name, item.quantity, item.unit_price);

        if (saleItem && drugId) {
          const drugInfo = await db.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = ?').get(drugId) as any;
          
          let restockQty = item.quantity;
          if (saleItem.unit === 'medium') {
            restockQty = item.quantity / (drugInfo?.large_to_medium || 1);
          } else if (saleItem.unit === 'small') {
            restockQty = item.quantity / ((drugInfo?.large_to_medium || 1) * (drugInfo?.medium_to_small || 1));
          }

          await db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(restockQty, finalInventoryId);
          
          // Calculate COGS reversal based on original cost, fallback to average/recent cost if cost_price is 0/null
          let itemCost = saleItem.cost_price;
          if (!itemCost || itemCost === 0) {
            const costRow = await db.prepare('SELECT cost_price FROM inventory WHERE drug_id = ? AND cost_price > 0 ORDER BY created_at DESC LIMIT 1').get(drugId) as any;
            itemCost = costRow?.cost_price || 0;
          }
          totalCogsReversal += itemCost * restockQty;
        }
      }

      // 5. Update patient wallet/balance if applicable
      if (data.refund_method === 'patient_account' && dbHeader.patient_id) {
        await db.prepare('UPDATE patients SET wallet_balance = wallet_balance + ? WHERE id = ?').run(totalRefund, dbHeader.patient_id);
      }

      // 6. Accounting Journal Entry
      const journalId = generateId();
      const returnDate = new Date().toISOString().split('T')[0];
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

      logActivity(user.id, 'CREATE_RETURN', `مرتجع بقيمة ${totalRefund} ج.م للفاتورة ${data.invoice_id.slice(0,8)}`);
      return { returnId, totalRefund };
    });

    const result = await transaction();

    revalidatePath('/returns');
    revalidatePath('/inventory');
    return { success: true, ...result };
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
    if (!user) return { success: false, error: 'غير مصرح' };

    const returns = await db.prepare(`
      SELECT r.*, u.full_name as user_name
      FROM returns r
      JOIN users u ON r.user_id = u.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all() as any[];

    // Get items for each return
    const returnsWithItems = await Promise.all(returns.map(async ret => {
      const items = await db.prepare('SELECT * FROM return_items WHERE return_id = ?').all(ret.id);
      return { ...ret, items };
    }));

    return { success: true, data: returnsWithItems };
  } catch (error) {
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
    if (!user) return { success: false, error: 'غير مصرح' };

    let query = `
      SELECT DISTINCT si.id, si.total_amount, si.created_at, p.full_name as patient_name, si.payment_method
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      LEFT JOIN sales_items sit ON sit.invoice_id = si.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filters.dateFrom) {
      query += ` AND si.created_at >= ?`;
      params.push(filters.dateFrom + ' 00:00:00');
    }
    if (filters.dateTo) {
      query += ` AND si.created_at <= ?`;
      params.push(filters.dateTo + ' 23:59:59');
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
      query += ` AND md.barcode = ?`;
      params.push(filters.barcode);
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
 * Get invoice details for return processing
 */
export async function getInvoiceForReturnAction(invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const invoice = await db.prepare(`
      SELECT si.*, p.full_name as patient_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.id = ?
    `).get(invoiceId) as any;

    if (!invoice) return { success: false, error: 'الفاتورة غير موجودة' };

    const items = await db.prepare(`
      SELECT 
        sit.*, 
        md.trade_name, 
        md.trade_name_en,
        md.id as drug_id,
        md.large_to_medium,
        md.medium_to_small,
        i.expiry_date
      FROM sales_items sit
      LEFT JOIN inventory i ON sit.inventory_id = i.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      WHERE sit.invoice_id = ?
    `).all(invoiceId) as any[];

    return {
      success: true,
      data: {
        ...invoice,
        items: items.map(i => ({
          id: i.id,
          inventory_id: i.inventory_id,
          drug_id: i.drug_id,
          drug_name: i.trade_name,
          drug_name_en: i.trade_name_en,
          quantity_sold: i.quantity_sold,
          unit_price: i.unit_price,
          unit: i.unit,
          expiry_date: i.expiry_date,
          large_to_medium: i.large_to_medium,
          medium_to_small: i.medium_to_small
        }))
      }
    };
  } catch (error) {
    console.error('Get invoice details error:', error);
    return { success: false, error: 'فشل جلب بيانات الفاتورة' };
  }
}

/**
 * Create a general return (not linked to a specific invoice, or multiple)
 * Also handles exchanges (substitute items)
 */
export async function createGeneralReturnAction(data: {
  patient_id?: string;
  shift_id?: string;
  reason: string;
  returnItems: { 
    drug_id: number | string; 
    inventory_id?: string; 
    drug_name: string; 
    quantity: number; 
    unit_price: number;
    unit: string;
  }[];
  saleItems: {
    drug_id: number | string;
    inventory_id: string;
    drug_name: string;
    quantity: number;
    unit_price: number;
    unit: string;
  }[];
  paid_amount: number;
  refund_method: 'cash' | 'patient_account' | 'coupon';
}) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const returnId = generateId();
    const totalReturn = data.returnItems.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
    const totalSale = data.saleItems.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
    const netAmount = totalSale - totalReturn; // Positive if customer owes us, Negative if we owe customer

    const transaction = db.transaction(async () => {
      // 1. Create Return Header (marking it as General)
      await db.prepare(`
        INSERT INTO returns (id, invoice_id, user_id, shift_id, reason, total_refund, refund_method, status)
        VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, 'approved')
      `).run(returnId, user.id, data.shift_id || null, data.reason, totalReturn, data.refund_method);

      let totalReturnCogs = 0;
      let totalSaleCogs = 0;

      // 2. Process Return Items (Restock)
      for (const item of data.returnItems) {
        let finalInventoryId = item.inventory_id;

        let inventoryExists = false;
        if (finalInventoryId) {
          const checkInv = await db.prepare('SELECT 1 FROM inventory WHERE id = ?').get(finalInventoryId);
          if (checkInv) inventoryExists = true;
        }

        if (!inventoryExists && item.drug_id) {
          // Try to find any inventory row for this drug
          const existingInventory = await db.prepare('SELECT id FROM inventory WHERE drug_id = ? LIMIT 1').get(item.drug_id) as any;
          if (existingInventory?.id) {
            finalInventoryId = existingInventory.id;
          } else {
            const newInvId = generateId();
            const defaultExpiry = new Date();
            defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 2);
            const expiryStr = defaultExpiry.toISOString().split('T')[0];
            const batchNum = 'RET-' + generateId().substring(0, 8);
            
            await db.prepare(`
              INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, cost_price)
              VALUES (?, ?, ?, ?, ?, 0, ?, 0)
            `).run(newInvId, user?.pharmacy_id || 'local_default', item.drug_id, batchNum, expiryStr, item.unit_price);
            
            finalInventoryId = newInvId;
          }
        }

        await db.prepare(`
          INSERT INTO return_items (return_id, inventory_id, drug_name, quantity_returned, unit_price)
          VALUES (?, ?, ?, ?, ?)
        `).run(returnId, finalInventoryId, item.drug_name, item.quantity, item.unit_price);

        const drugInfo = await db.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = ?').get(item.drug_id) as any;
        
        let restockQty = item.quantity;
        if (item.unit === 'medium') {
          restockQty = item.quantity / (drugInfo?.large_to_medium || 1);
        } else if (item.unit === 'small') {
          restockQty = item.quantity / ((drugInfo?.large_to_medium || 1) * (drugInfo?.medium_to_small || 1));
        }

        await db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(restockQty, finalInventoryId);

        // Calculate returned item's COGS
        const costRow = await db.prepare('SELECT cost_price FROM inventory WHERE drug_id = ? AND cost_price > 0 ORDER BY created_at DESC LIMIT 1').get(item.drug_id) as any;
        const costPrice = costRow?.cost_price || 0;
        totalReturnCogs += costPrice * restockQty;
      }

      // 3. Process Sale Items (Exchanges) if any
      const saleInvoiceId = data.saleItems.length > 0 ? generateId() : null;
      if (saleInvoiceId && data.saleItems.length > 0) {
        await db.prepare(`
          INSERT INTO sales_invoices (id, pharmacy_id, user_id, patient_id, shift_id, total_amount, paid_amount, payment_method, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')
        `).run(
          saleInvoiceId,
          user?.pharmacy_id || 'local_default',
          user.id, 
          data.patient_id || null, 
          data.shift_id || null, 
          totalSale, 
          data.paid_amount, 
          data.refund_method === 'cash' ? 'cash' : 'credit'
        );

        for (const item of data.saleItems) {
          const invRow = await db.prepare('SELECT cost_price FROM inventory WHERE id = ?').get(item.inventory_id) as any;
          const costPrice = invRow?.cost_price || 0;

          await db.prepare(`
            INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, cost_price)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
          `).run(saleInvoiceId, item.inventory_id, item.drug_id, item.quantity, item.unit_price, item.unit, costPrice);

          // Restock logic should also be unit aware here if it was a return, but this is the SALE part
          // Deduct from inventory (unit aware)
          const drugInfo = await db.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = ?').get(item.drug_id) as any;
          let deductionQty = item.quantity;
          if (item.unit === 'medium') {
            deductionQty = item.quantity / (drugInfo.large_to_medium || 1);
          } else if (item.unit === 'small') {
            deductionQty = item.quantity / ((drugInfo.large_to_medium || 1) * (drugInfo.medium_to_small || 1));
          }

          await db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(deductionQty, item.inventory_id);

          totalSaleCogs += costPrice * deductionQty;
        }
        
        // Link the return to this new sale invoice if possible
        await db.prepare('UPDATE returns SET invoice_id = ? WHERE id = ?').run(saleInvoiceId, returnId);
      }

      // 4. Update Patient Balance if credit
      if (data.patient_id && data.refund_method === 'patient_account') {
         await db.prepare('UPDATE patients SET wallet_balance = wallet_balance - ? WHERE id = ?').run(netAmount, data.patient_id);
      }

      // 5. Double-entry Journal Entry
      if (totalReturn > 0 || totalSale > 0) {
        const journalId = generateId();
        const entryDate = new Date().toISOString().split('T')[0];
        
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          journalId, 
          entryDate, 
          `مرتجع مبيعات واستبدال عام رقم ${returnId.slice(0, 8)}`, 
          user.id, 
          totalReturn + totalSale + totalReturnCogs + totalSaleCogs
        );

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

        // Post Return Component
        if (totalReturn > 0) {
          const creditAccountForReturn = data.refund_method === 'patient_account' ? accounts.receivable : accounts.cash;
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.sales, 'debit', totalReturn);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, creditAccountForReturn, 'credit', totalReturn);
          
          if (totalReturnCogs > 0) {
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', totalReturnCogs);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cogs, 'credit', totalReturnCogs);
          }
        }

        // Post Sale (Exchange) Component
        if (totalSale > 0) {
          const debitAccountForSale = data.refund_method === 'cash' ? accounts.cash : accounts.receivable;
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, debitAccountForSale, 'debit', totalSale);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.sales, 'credit', totalSale);
          
          if (totalSaleCogs > 0) {
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cogs, 'debit', totalSaleCogs);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'credit', totalSaleCogs);
          }
        }
      }

      logActivity(user.id, 'GENERAL_RETURN', `مرتجع عام بقيمة ${totalReturn} ج.م ومبيعات بديلة بقيمة ${totalSale} ج.م`);
      return { returnId, netAmount };
    });

    const result = await transaction();

    revalidatePath('/returns');
    revalidatePath('/inventory');
    return { success: true, ...result };
  } catch (error: any) {
    console.error('General return error:', error);
    return { success: false, error: error.message || 'فشل تنفيذ المرتجع العام' };
  }
}

