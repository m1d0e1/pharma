
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




const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local'

// Suppliers
export async function getSuppliersAction() {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const items = await db.prepare('SELECT * FROM suppliers ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addSupplierAction(data: { name_ar: string, name_en?: string, phone?: string, address?: string }) {
  try {
    const session = await getLocalSession();
    if (!session || (session.role !== 'owner' && session.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const stmt = await db.prepare('INSERT INTO suppliers (name_ar, name_en, phone, address) VALUES (?, ?, ?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null, data.phone || null, data.address || null);
    revalidatePath('/purchases/suppliers');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Purchase Invoices
export async function getPurchaseInvoicesAction() {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const items = await db.prepare(`
      SELECT i.*, s.name_ar as supplier_name 
      FROM purchase_invoices i
      JOIN suppliers s ON i.supplier_id = s.id
      ORDER BY i.created_at DESC
    `).all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function checkSupplierPendingInvoiceAction(supplierId: number) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const pending = await db.prepare('SELECT id, invoice_number FROM purchase_invoices WHERE supplier_id = ? AND status != ? LIMIT 1').get(supplierId, 'completed') as any;
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
  status?: string
}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const id = generateId();
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
      data.status || 'pending'
    );

    revalidatePath('/purchases');
    return { success: true, id };
  } catch (error: any) {
    console.error('Create purchase invoice error:', error);
    return { success: false, error: error.message };
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
  discount_percent?: number
}) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_purchases')) return { success: false, error: 'Unauthorized' };

    const stmt = await db.prepare(`
      INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    await stmt.run(
      invoiceId,
      item.drug_id,
      item.quantity,
      item.unit_id || null,
      item.expiry_date || null,
      item.cost_price,
      item.selling_price || null,
      item.bonus_quantity || 0,
      item.tax_percent || 0,
      item.discount_percent || 0
    );

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
        const itemDiscount = (itemSubtotal + itemTax) * (item.discount_percent / 100);
        const itemTotal = itemSubtotal + itemTax - itemDiscount;
        
        totalAmount += itemTotal;

        // 2. Add to inventory with batch number
        const invId = generateId();
        await db.prepare(`
          INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, batch_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          invId, 
          item.drug_id, 
          session.pharmacy_id, 
          item.quantity + (item.bonus_quantity || 0), 
          item.selling_price || 0, 
          item.cost_price, 
          item.expiry_date,
          invoice.invoice_number || 'BATCH-' + invoiceId.substring(0, 8)
        );
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

    const items = await db.prepare(`
      SELECT pi.invoice_date, pi.invoice_number, pii.quantity, pii.cost_price, s.name_ar as supplier_name
      FROM purchase_invoice_items pii
      JOIN purchase_invoices pi ON pii.invoice_id = pi.id
      JOIN suppliers s ON pi.supplier_id = s.id
      WHERE pii.drug_id = ? AND pi.status = 'completed'
      ORDER BY pi.invoice_date DESC, pi.created_at DESC
      LIMIT 5
    `).all(drugId);
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function createPurchaseOrderAction(data: { supplier_name: string; notes?: string; items: { drug_id: number; quantity: number; expected_price: number }[]; }) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'Unauthorized' };

    if (!data.items || data.items.length === 0) return { success: false, error: 'No items' };
    if (data.items.some(i => i.quantity <= 0)) return { success: false, error: 'Invalid quantity' };

    const po_id = 'PO-' + generateId().substring(0, 8).toUpperCase();
    const total_amount = data.items.reduce((sum, item) => sum + (item.quantity * item.expected_price), 0);

    const transaction = db.transaction(async () => {
      await db.prepare('INSERT INTO purchase_orders (id, user_id, supplier_name, total_amount, notes) VALUES (?, ?, ?, ?, ?)').run(po_id, user.id, data.supplier_name, total_amount, data.notes || null);
      const itemStmt = await db.prepare('INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price) VALUES (?, ?, ?, ?)');
      for (const item of data.items) { itemStmt.run(po_id, item.drug_id, item.quantity, item.expected_price); }
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'Create PO', 'PO created ' + po_id);
    });
    await transaction();
    
    // No next.js cache invalidation in client mode
    return { success: true, po_id };
  } catch (error) {
    return { success: false, error: 'Failed' };
  }
}

export async function getPurchaseOrdersAction() {
  try {
    const orders = await db.prepare('SELECT po.*, u.full_name as creator_name, (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) as item_count FROM purchase_orders po JOIN users u ON po.user_id = u.id ORDER BY po.created_at DESC').all();
    return { success: true, data: orders };
  } catch (error) {
    return { success: false, error: 'Failed' };
  }
}

export async function updatePurchaseOrderStatusAction(poId: string, status: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'Unauthorized' };
    await db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, poId);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed' };
  }
}

export async function getPurchasesReportsAction(filters: any = {}) {
  try {
    let sql = 'SELECT i.*, s.name_ar as supplier_name, u.full_name as staff_name FROM purchase_invoices i LEFT JOIN suppliers s ON i.supplier_id = s.id LEFT JOIN users u ON i.user_id = u.id WHERE 1=1';
    const params: any[] = [];
    if (filters.startDate) { sql += ' AND date(i.created_at) >= ?'; params.push(filters.startDate); }
    if (filters.endDate) { sql += ' AND date(i.created_at) <= ?'; params.push(filters.endDate); }
    if (filters.userId) { sql += ' AND i.user_id = ?'; params.push(filters.userId); }
    if (filters.paymentMethod) { sql += ' AND i.payment_method = ?'; params.push(filters.paymentMethod); }
    if (filters.supplierId) { sql += ' AND i.supplier_id = ?'; params.push(filters.supplierId); }
    if (filters.invoiceNumber) { sql += ' AND i.invoice_number LIKE ?'; params.push('%' + filters.invoiceNumber + '%'); }
    sql += ' ORDER BY i.created_at DESC';
    const items = await db.prepare(sql).all(...params) as any[];
    const totalCost = items.reduce((sum, inv) => sum + (inv.total_amount || 0), 0);
    return { success: true, data: items, totalCost, invoiceCount: items.length };
  } catch (error: any) { return { success: false, error: error.message }; }
}

export async function getPurchaseInvoiceDetailsAction(invoiceId: string) {
  try {
    const items = await db.prepare('SELECT pii.*, d.trade_name, d.barcode FROM purchase_invoice_items pii JOIN master_drugs d ON pii.drug_id = d.id WHERE pii.invoice_id = ?').all(invoiceId);
    return { success: true, data: items };
  } catch (error: any) { return { success: false, error: error.message }; }
}
