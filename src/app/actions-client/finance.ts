
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

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { format } from 'date-fns';
import { z } from 'zod';

const noticeSchema = z.object({
  target_type: z.enum(['customer', 'supplier', 'pharmacy']),
  target_id: z.string().optional(),
  type: z.enum(['credit', 'debit']),
  amount: z.number().positive(),
  reason: z.string().min(1),
  notes: z.string().optional(),
  date: z.string(),
});

export async function addFinancialNoticeAction(rawData: z.infer<typeof noticeSchema>) {
  try {
    const data = noticeSchema.parse(rawData);
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const id = generateId();
    
    await db.prepare(`
      INSERT INTO financial_notices (id, user_id, target_type, target_id, type, amount, reason, notes, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, data.target_type, data.target_id || null, data.type, data.amount, data.reason, data.notes || null, data.date);

    // If it's a customer, also add to patient_transactions for statement visibility
    if (data.target_type === 'customer' && data.target_id) {
       const transId = generateId();
       const sign = data.type === 'credit' ? -1 : 1;
       await db.prepare(`
         INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, notes, date)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       `).run(transId, data.target_id, user.id, 'adjustment', data.amount * sign, data.reason, data.date);
    }

    revalidatePath('/patients');
    return { success: true };
  } catch (error) {
    console.error('Add notice error:', error);
    return { success: false, error: 'فشل إضافة الإشعار' };
  }
}

const paymentSchema = z.object({
  patient_id: z.string().min(1),
  amount: z.number().positive(),
  payment_method: z.string().min(1),
  notes: z.string().optional(),
  date: z.string(),
});

export async function addPatientPaymentAction(rawData: z.infer<typeof paymentSchema>) {
  try {
    const data = paymentSchema.parse(rawData);
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const id = generateId();
    
    await db.prepare(`
      INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, payment_method, notes, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.patient_id, user.id, 'payment', data.amount, data.payment_method, data.notes || null, data.date);

    revalidatePath('/patients');
    return { success: true };
  } catch (error) {
    console.error('Add payment error:', error);
    return { success: false, error: 'فشل إضافة الدفعة' };
  }
}

const cashMovementSchema = z.object({
  type: z.enum(['disbursement', 'receipt']),
  category: z.string().min(1),
  sub_category: z.string().optional(),
  amount: z.number().positive(),
  source_type: z.string().optional(),
  target_name: z.string().optional(),
  notes: z.string().optional(),
  date: z.string(),
  actual_date: z.string().optional(),
  shift_id: z.string().optional(),
});

export async function createCashMovementAction(rawData: z.infer<typeof cashMovementSchema>) {
  try {
    const data = cashMovementSchema.parse(rawData);
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const movementId = generateId();
    const transaction = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO cash_movements (
          id, user_id, shift_id, type, category, sub_category, 
          amount, source_type, target_name, notes, date, actual_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        movementId, user.id, data.shift_id || null, data.type, data.category, data.sub_category || null,
        data.amount, data.source_type || null, data.target_name || null, data.notes || null, 
        data.date, data.actual_date || null
      );

      // Create Daily Journal Entry
      const journalId = generateId();
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, data.date, `${data.type === 'receipt' ? 'قبض' : 'صرف'} نقدية: ${data.category} - ${data.notes || ''}`, user.id, data.amount);

      // Determine Accounts Dynamically
      const getAccount = async (cat: string, targetName?: string) => {
        let sql = 'SELECT account_id FROM trial_balance_settings WHERE category = ?';
        const params = [cat];
        if (targetName) {
          sql += ' AND (target_name = ? OR target_type = ?)';
          params.push(targetName, targetName);
        }
        const setting = await db.prepare(sql).get(...params) as any;
        return setting?.account_id;
      };

      const mainCashAccountId = await getAccount('cash_drawer', 'Main Treasury') || 6; 
      let categoryAccountId = await getAccount(data.category, data.target_name) || 11; 
      
      if (data.type === 'receipt') {
        // Debit Cash, Credit Category
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, mainCashAccountId, 'debit', data.amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, categoryAccountId, 'credit', data.amount);
      } else {
        // Debit Category, Credit Cash
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, categoryAccountId, 'debit', data.amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, mainCashAccountId, 'credit', data.amount);
      }
    });

    await transaction();

    revalidatePath('/finance');
    return { success: true, id: movementId };
  } catch (error) {
    console.error('Create cash movement error:', error);
    return { success: false, error: 'فشل تنفيذ حركة النقدية' };
  }
}

export async function getCashMovementsAction(filters?: {
  type?: 'disbursement' | 'receipt';
  dateFrom?: string;
  dateTo?: string;
}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    let query = `SELECT * FROM cash_movements WHERE 1=1`;
    const params: any[] = [];

    if (filters?.type) {
      query += ` AND type = ?`;
      params.push(filters.type);
    }
    if (filters?.dateFrom) {
      query += ` AND date >= ?`;
      params.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
      query += ` AND date <= ?`;
      params.push(filters.dateTo);
    }

    query += ` ORDER BY created_at DESC`;
    const results = await db.prepare(query).all(...params);
    return { success: true, data: results };
  } catch (error) {
    console.error('Get cash movements error:', error);
    return { success: false, error: 'فشل جلب سجل النقدية' };
  }
}

export async function getPointsOfSaleAction() {
  try {
    const results = await db.prepare(`SELECT * FROM points_of_sale ORDER BY id ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get POS error:', error);
    return { success: false, error: 'فشل جلب نقاط البيع' };
  }
}

export async function getExpenseDefinitionsAction() {
  try {
    const results = await db.prepare(`SELECT * FROM expense_definitions ORDER BY code ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get expense definitions error:', error);
    return { success: false, error: 'فشل جلب تعريفات المصروفات' };
  }
}

export async function getBanksAction() {
  try {
    const results = await db.prepare(`SELECT * FROM banks ORDER BY name_ar ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get banks error:', error);
    return { success: false, error: 'فشل جلب البيانات البنكية' };
  }
}

export async function getPapersAction() {
  try {
    const results = await db.prepare(`SELECT * FROM commercial_papers ORDER BY due_date ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get papers error:', error);
    return { success: false, error: 'فشل جلب الأوراق المالية' };
  }
}

export async function getCardsAction() {
  try {
    const results = await db.prepare(`SELECT * FROM credit_cards ORDER BY name_ar ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get cards error:', error);
    return { success: false, error: 'فشل جلب بيانات البطاقات' };
  }
}

export async function getAccountsAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const accounts = await db.prepare(`SELECT * FROM accounts ORDER BY code ASC`).all() as any[];

    // Fetch total debits and credits for each account from journal entries
    const entries = await db.prepare(`
      SELECT 
        account_id,
        COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) as debit,
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) as credit
      FROM journal_entries
      GROUP BY account_id
    `).all() as any[];

    // Map account_id -> {debit, credit}
    const entriesMap = new Map();
    entries.forEach(e => {
      entriesMap.set(e.account_id, { debit: e.debit, credit: e.credit });
    });

    // Initialize/calculate leaf balances
    accounts.forEach(acc => {
      if (acc.is_group) {
        acc.balance = 0;
      } else {
        const entry = entriesMap.get(acc.id) || { debit: 0, credit: 0 };
        if (acc.type === 'asset' || acc.type === 'expense') {
          acc.balance = entry.debit - entry.credit;
        } else {
          acc.balance = entry.credit - entry.debit;
        }
      }
    });

    // Aggregate balances bottom-up to parent groups (process children before parents by sorting by code length descending)
    const accountsMap = new Map(accounts.map(acc => [acc.id, acc]));
    const sortedAccounts = [...accounts].sort((a, b) => b.code.length - a.code.length);
    
    sortedAccounts.forEach(acc => {
      if (acc.parent_id && accountsMap.has(acc.parent_id)) {
        const parent = accountsMap.get(acc.parent_id);
        parent.balance = (parent.balance || 0) + acc.balance;
      }
    });

    return { success: true, data: accounts };
  } catch (error) {
    console.error('Get accounts error:', error);
    return { success: false, error: 'فشل جلب شجرة الحسابات' };
  }
}

const addAccountSchema = z.object({
  code: z.string().min(1),
  name_ar: z.string().min(1),
  name_en: z.string().optional(),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  is_group: z.number().int().min(0).max(1),
  parent_id: z.number().int().nullable().optional(),
});

export async function addAccountAction(rawData: z.infer<typeof addAccountSchema>) {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const data = addAccountSchema.parse(rawData);
    const res = await db.prepare(`
      INSERT INTO accounts (code, name_ar, name_en, type, is_group, parent_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(data.code, data.name_ar, data.name_en || null, data.type, data.is_group, data.parent_id || null);
    
    revalidatePath('/finance');
    return { success: true, id: res.lastInsertRowid };
  } catch (error) {
    console.error('Add account error:', error);
    return { success: false, error: 'فشل إضافة الحساب. تأكد من عدم تكرار الكود.' };
  }
}

const updateAccountSchema = z.object({
  name_ar: z.string().optional(),
  name_en: z.string().optional(),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']).optional(),
  is_group: z.number().int().min(0).max(1).optional(),
});

export async function updateAccountAction(id: number, rawData: z.infer<typeof updateAccountSchema>) {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const data = updateAccountSchema.parse(rawData);
    
    // Build SQL safely
    const keys = Object.keys(data) as Array<keyof typeof data>;
    if (keys.length === 0) return { success: true };
    
    const fields = keys.map(k => `${k} = ?`).join(', ');
    const params = [...keys.map(k => data[k]), id];
    
    await db.prepare(`UPDATE accounts SET ${fields} WHERE id = ?`).run(...params);
    
    revalidatePath('/finance');
    return { success: true };
  } catch (error) {
    console.error('Update account error:', error);
    return { success: false, error: 'فشل تحديث الحساب' };
  }
}

export async function getJournalsAction() {
  try {
    const results = await db.prepare(`SELECT * FROM daily_journals ORDER BY date DESC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get journals error:', error);
    return { success: false, error: 'فشل جلب القيود اليومية' };
  }
}

export async function getJournalDetailsAction(journalId: string) {
  try {
    const entries = await db.prepare(`
      SELECT e.*, a.name_ar as account_name, a.code as account_code,
             dj.description, dj.date,
             CASE WHEN e.type = 'debit' THEN e.amount ELSE 0 END as debit,
             CASE WHEN e.type = 'credit' THEN e.amount ELSE 0 END as credit
      FROM journal_entries e
      JOIN daily_journals dj ON e.journal_id = dj.id
      JOIN accounts a ON e.account_id = a.id
      WHERE e.journal_id = ?
      ORDER BY e.type DESC, e.amount DESC
    `).all(journalId);
    return { success: true, data: entries };
  } catch (error) {
    console.error('Get journal details error:', error);
    return { success: false, error: 'فشل جلب تفاصيل القيد' };
  }
}

export async function seedFinanceTestDataAction() {
  try {
    // 1. Seed POS
    const posCount = await db.prepare('SELECT COUNT(*) as count FROM points_of_sale').get() as any;
    if (posCount.count === 0) {
      const posStmt = db.prepare(`
        INSERT INTO points_of_sale (name_ar, name_en, location, computer_name, current_balance)
        VALUES (?, ?, ?, ?, ?)
      `);
      await posStmt.run('نقطة البيع الرئيسية', 'Main POS', 'المحل', 'PC-01', 2057.80);
      await posStmt.run('نقطة بيع الفرع', 'Branch POS', 'الفرع', 'PC-02', 1500.00);
    }

    // 2. Seed Expense Definitions
    const expCount = await db.prepare('SELECT COUNT(*) as count FROM expense_definitions').get() as any;
    if (expCount.count === 0) {
      const expStmt = db.prepare(`INSERT INTO expense_definitions (code, name_ar, name_en) VALUES (?, ?, ?)`);
      await expStmt.run('50', 'كازينو', 'CASINO');
      await expStmt.run('51', 'خصم عميل', 'Customer Discount');
      await expStmt.run('15', 'كهرباء', 'Electricity');
      await expStmt.run('16', 'تليفون وفاكس', 'Telephone & Fax');
      await expStmt.run('17', 'الرقم الموحد', 'Unified Number');
      await expStmt.run('18', 'محمول', 'Mobile');
      await expStmt.run('19', 'إنترنت', 'Internet');
      await expStmt.run('26', 'إكراميات', 'Tips');
      await expStmt.run('33', 'اصلاح وصيانة', 'Maintenance');
    }

    // 3. Seed Banks
    const bankCount = await db.prepare('SELECT COUNT(*) as count FROM banks').get() as any;
    if (bankCount.count === 0) {
       const bankStmt = db.prepare(`INSERT INTO banks (name_ar, name_en, account_number, branch, current_balance) VALUES (?, ?, ?, ?, ?)`);
       await bankStmt.run('البنك التجاري الدولي', 'CIB', '100012345678', 'فرع المهندسين', 125000.00);
       await bankStmt.run('بنك مصر', 'Banque Misr', '200098765432', 'فرع الدقي', 45000.00);
    }

    // 4. Seed Credit Cards / Terminals
    const cardCount = await db.prepare('SELECT COUNT(*) as count FROM credit_cards').get() as any;
    if (cardCount.count === 0) {
       const cardStmt = db.prepare(`INSERT INTO credit_cards (name_ar, name_en, bank_id, commission_pct, current_balance) VALUES (?, ?, ?, ?, ?)`);
       await cardStmt.run('ماكينة فوري', 'Fawry Terminal', 1, 1.5, 3200.00);
       await cardStmt.run('فيزا بنك مصر', 'BM Visa', 2, 2.0, 1500.00);
    }

    // 5. Seed some Cash Movements
    const moveCount = await db.prepare('SELECT COUNT(*) as count FROM cash_movements').get() as any;
    if (moveCount.count === 0) {
      const user = await getLocalSession();
      if (user) {
        const moveStmt = db.prepare(`
          INSERT INTO cash_movements (id, user_id, type, category, amount, date, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        await moveStmt.run(generateId(), user.id, 'receipt', 'patient', 150.00, format(new Date(), 'yyyy-MM-dd'), 'توريد من عميل #123');
        await moveStmt.run(generateId(), user.id, 'disbursement', 'operating_expenses', 50.00, format(new Date(), 'yyyy-MM-dd'), 'دفع فاتورة انترنت');
      }
    }

    // 6. Seed Chart of Accounts
    const accCount = await db.prepare('SELECT COUNT(*) as count FROM accounts').get() as any;
    if (accCount.count === 0) {
      const accStmt = db.prepare(`
        INSERT INTO accounts (code, name_ar, name_en, type, is_group, parent_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      // Top level groups
      const assetsId = (await accStmt.run('1', 'الأصول', 'Assets', 'asset', 1, null)).lastInsertRowid;
      const liabId = (await accStmt.run('2', 'الخصوم', 'Liabilities', 'liability', 1, null)).lastInsertRowid;
      const equityId = (await accStmt.run('3', 'حقوق الملكية', 'Equity', 'equity', 1, null)).lastInsertRowid;
      const incomeId = (await accStmt.run('4', 'الإيرادات', 'Income', 'income', 1, null)).lastInsertRowid;
      const expenseId = (await accStmt.run('5', 'المصروفات', 'Expenses', 'expense', 1, null)).lastInsertRowid;

      // Assets sub-groups
      const curAssetsId = (await accStmt.run('11', 'الأصول المتداولة', 'Current Assets', 'asset', 1, assetsId)).lastInsertRowid;
      const cashAccountId = (await accStmt.run('111', 'الخزينة الرئيسية', 'Main Treasury', 'asset', 0, curAssetsId)).lastInsertRowid;
      await accStmt.run('112', 'البنوك', 'Banks', 'asset', 0, curAssetsId);
      const customersAccountId = (await accStmt.run('113', 'العملاء', 'Customers', 'asset', 0, curAssetsId)).lastInsertRowid;
      const inventoryAccountId = (await accStmt.run('114', 'مخزون الأدوية', 'Drug Inventory', 'asset', 0, curAssetsId)).lastInsertRowid;

      // Liabilities sub-groups
      const curLiabId = (await accStmt.run('21', 'الخصوم المتداولة', 'Current Liabilities', 'liability', 1, liabId)).lastInsertRowid;
      const suppliersAccountId = (await accStmt.run('211', 'الموردين', 'Suppliers (Accounts Payable)', 'liability', 0, curLiabId)).lastInsertRowid;

      // Income sub-groups
      const salesAccountId = (await accStmt.run('41', 'مبيعات الأدوية', 'Drug Sales', 'income', 0, incomeId)).lastInsertRowid;

      // Expenses sub-groups
      const opExpId = (await accStmt.run('51', 'مصروفات تشغيلية', 'Operating Expenses', 'expense', 1, expenseId)).lastInsertRowid;
      await accStmt.run('511', 'إيجار', 'Rent', 'expense', 0, opExpId);
      await accStmt.run('512', 'كهرباء', 'Electricity', 'expense', 0, opExpId);
      await accStmt.run('513', 'أجور ومرتبات', 'Salaries', 'expense', 0, opExpId);
      const cogsAccountId = (await accStmt.run('514', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'expense', 0, opExpId)).lastInsertRowid;
      const adjustmentAccountId = (await accStmt.run('515', 'تسويات مخزنية (عجز وزيادة)', 'Inventory Adjustments', 'expense', 0, opExpId)).lastInsertRowid;
      const cashDiffAccountId = (await accStmt.run('516', 'عجز وزيادة الخزينة', 'Cash Shortage/Overage', 'expense', 0, opExpId)).lastInsertRowid;

      // 7. Seed Trial Balance Settings
      const tbStmt = db.prepare(`INSERT INTO trial_balance_settings (category, account_id) VALUES (?, ?)`);
      await tbStmt.run('cash_drawer', cashAccountId);
      await tbStmt.run('sales_revenue', salesAccountId);
      await tbStmt.run('inventory_asset', inventoryAccountId);
      await tbStmt.run('cogs_expense', cogsAccountId);
      await tbStmt.run('accounts_receivable', customersAccountId);
      await tbStmt.run('accounts_payable', suppliersAccountId);
      await tbStmt.run('inventory_adjustment', adjustmentAccountId);
      await tbStmt.run('cash_difference', cashDiffAccountId);
    }

    revalidatePath('/finance');
    return { success: true };
  } catch (error) {
    console.error('Seed finance error:', error);
    return { success: false, error: 'فشل تهيئة البيانات' };
  }
}

export async function generateDailySnapshotAction(targetDate?: string) {
  try {
    const date = targetDate || new Date().toISOString().split('T')[0];
    
    const sales = await db.prepare('SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_invoices WHERE date(created_at) = ? AND status = ?').get(date, 'completed') as any;
    const returns = await db.prepare('SELECT COALESCE(SUM(total_refund), 0) as total FROM returns WHERE date(created_at) = ? AND status = ?').get(date, 'approved') as any;
    const movements = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END), 0) as net FROM cash_movements WHERE date(date) = ?").get(date) as any;
    
    // Simple net calculation for the dashboard pulse
    const net = (sales.total || 0) - (returns.total || 0) + (movements.net || 0);

    await db.prepare(`
      INSERT INTO daily_financial_snapshots (date, total_sales, total_returns, total_cash_movements, net_profit)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        total_sales = excluded.total_sales,
        total_returns = excluded.total_returns,
        total_cash_movements = excluded.total_cash_movements,
        net_profit = excluded.net_profit
    `).run(date, sales.total, returns.total, movements.net, net);

    return { success: true, data: { date, net } };
  } catch (error) {
    console.error('Snapshot error:', error);
    return { success: false, error: 'فشل تحديث ملخص اليوم' };
  }
}

export async function getTrialBalanceSettingsAction() {
  try {
    const results = await db.prepare(`
      SELECT s.*, a.name_ar as account_name, a.code as account_code
      FROM trial_balance_settings s
      LEFT JOIN accounts a ON s.account_id = a.id
      ORDER BY s.category ASC
    `).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get trial balance settings error:', error);
    return { success: false, error: 'فشل جلب إعدادات ميزان المراجعة' };
  }
}

export async function saveTrialBalanceSettingAction(data: {
  category: string;
  target_type?: string;
  target_id?: string;
  target_name?: string;
  account_id: number;
}) {
  try {
    // Check if exists based on category and target identification
    let existing;
    if (data.target_id) {
      existing = await db.prepare(`
        SELECT id FROM trial_balance_settings 
        WHERE category = ? AND target_id = ?
      `).get(data.category, data.target_id) as any;
    } else {
      existing = await db.prepare(`
        SELECT id FROM trial_balance_settings 
        WHERE category = ? AND target_name = ?
      `).get(data.category, data.target_name) as any;
    }

    if (existing) {
      await db.prepare('UPDATE trial_balance_settings SET account_id = ? WHERE id = ?').run(data.account_id, existing.id);
    } else {
      await db.prepare(`
        INSERT INTO trial_balance_settings (category, target_type, target_id, target_name, account_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(data.category, data.target_type || null, data.target_id || null, data.target_name || null, data.account_id);
    }

    revalidatePath('/accounts/settings/trial-balance');
    return { success: true };
  } catch (error) {
    console.error('Save trial balance setting error:', error);
    return { success: false, error: 'فشل حفظ الإعداد' };
  }
}

export async function getPatientStatementAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const transactions = await db.prepare(`
      SELECT 
        'invoice' as type, 
        id, 
        total_amount as debit, 
        0 as credit, 
        created_at as date,
        'فاتورة مبيعات' as description
      FROM sales_invoices
      WHERE patient_id = ? AND status = 'completed'
      
      UNION ALL
      
      SELECT 
        type as type, 
        id, 
        CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END as debit,
        CASE WHEN amount > 0 THEN amount ELSE 0 END as credit,
        date,
        notes as description
      FROM patient_transactions
      WHERE patient_id = ?
      
      ORDER BY date ASC
    `).all(patientId, patientId) as any[];

    let runningBalance = 0;
    const history = transactions.map(t => {
      runningBalance += (t.debit - t.credit);
      return { ...t, balance: runningBalance };
    });

    return { success: true, data: history };
  } catch (error) {
    console.error('Statement error:', error);
    return { success: false, error: 'فشل جلب كشف الحساب' };
  }
}

export async function getTrialBalanceAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_financial')) return { success: false, error: 'غير مصرح' };

    const balances = await db.prepare(`
      SELECT 
        a.id,
        a.code,
        a.name_ar,
        a.type,
        a.parent_id,
        COALESCE(SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN je.type = 'credit' THEN je.amount ELSE 0 END), 0) as total_credit
      FROM accounts a
      LEFT JOIN journal_entries je ON a.id = je.account_id
      GROUP BY a.id
      ORDER BY a.code ASC
    `).all() as any[];

    // Calculate Net Balances
    const results = balances.map(acc => {
      const netDebit = acc.total_debit > acc.total_credit ? acc.total_debit - acc.total_credit : 0;
      const netCredit = acc.total_credit > acc.total_debit ? acc.total_credit - acc.total_debit : 0;
      return { ...acc, net_debit: netDebit, net_credit: netCredit };
    });

    return { success: true, data: results };
  } catch (error) {
    console.error('Trial balance error:', error);
    return { success: false, error: 'فشل جلب ميزان المراجعة' };
  }
}

export async function getFinancialNoticesAction() {
  try {
    const results = await db.prepare(`
      SELECT n.*, u.full_name as user_name
      FROM financial_notices n
      LEFT JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC LIMIT 100
    `).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get financial notices error:', error);
    return { success: false, error: 'فشل جلب الإشعارات المالية' };
  }
}

export async function getActivityLogsAction() {
  try {
    const logs = await db.prepare(`
      SELECT a.*, u.full_name as user_name
      FROM activity_log a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT 200
    `).all();
    return { success: true, data: logs };
  } catch (error) {
    console.error('Get activity logs error:', error);
    return { success: false, error: 'فشل جلب سجل الرقابة' };
  }
}
