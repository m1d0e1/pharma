
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
import { patientOutstandingBalanceQuery } from '@/lib/patients/balance';
import { ensurePermanentShiftForUser } from './shifts';

const hasAnyFinancePermission = (user: any, ...permissions: string[]) =>
  !!user && permissions.some(permission => hasUserPermissionSync(user, permission));

export async function requireOpenShiftId(userId: string, requestedShiftId?: string) {
  const requestedShift = requestedShiftId
    ? await db.prepare(`
        SELECT id FROM shifts
        WHERE id = ? AND CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
      `).get(requestedShiftId, userId) as any
    : null;
  if (requestedShift?.id) return String(requestedShift.id);

  // A stale shift id can remain in an already-open POS after another user logs in.
  // Always resolve the permanent session from the acting user id.
  const shift = await ensurePermanentShiftForUser(userId);
  return String(shift.id);
}

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
    if (!hasAnyFinancePermission(user, 'acc_can_view_notifications')) return { success: false, error: 'غير مصرح' };

    if (data.target_type !== 'pharmacy' && !data.target_id) {
      return { success: false, error: 'يجب اختيار الحساب المستهدف' };
    }

    const id = generateId();
    await dbTransaction(async () => {
      if (data.target_type === 'customer') {
        const patient = await db.prepare('SELECT id FROM patients WHERE id = ?').get(data.target_id) as any;
        if (!patient) throw new Error('المريض غير موجود');
      } else if (data.target_type === 'supplier') {
        const supplier = await db.prepare('SELECT id FROM suppliers WHERE CAST(id AS TEXT) = ?').get(data.target_id) as any;
        if (!supplier) throw new Error('المورد غير موجود');
      }

      await db.prepare(`
        INSERT INTO financial_notices (id, user_id, target_type, target_id, type, amount, reason, notes, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, user.id, data.target_type, data.target_id || null, data.type, data.amount, data.reason, data.notes || null, data.date);

      // A positive adjustment is a debit (more owed); a negative one is a credit.
      if (data.target_type === 'customer' && data.target_id) {
        const signedAmount = data.type === 'credit' ? -data.amount : data.amount;
        await db.prepare(`
          INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, notes, date)
          VALUES (?, ?, ?, 'adjustment', ?, ?, ?)
        `).run(generateId(), data.target_id, user.id, signedAmount, data.reason, data.date);
      } else if (data.target_type === 'supplier' && data.target_id) {
        const signedAmount = data.type === 'credit' ? -data.amount : data.amount;
        try {
          await db.prepare(`
            INSERT INTO supplier_transactions (id, supplier_id, user_id, type, amount, notes, date)
            VALUES (?, ?, ?, 'adjustment', ?, ?, ?)
          `).run(generateId(), data.target_id, user.id, signedAmount, data.reason, data.date);
        } catch {}
        try {
          await db.prepare(`
            UPDATE suppliers 
            SET current_balance = COALESCE(current_balance, 0) + ?
            WHERE CAST(id AS TEXT) = ?
          `).run(signedAmount, data.target_id);
        } catch {}
      }

      const getAccount = async (category: string, fallback: number) => {
        const setting = await db.prepare(
          'SELECT account_id FROM trial_balance_settings WHERE category = ? LIMIT 1'
        ).get(category) as any;
        return Number(setting?.account_id || fallback);
      };
      const targetCategory = data.target_type === 'customer'
        ? 'accounts_receivable'
        : data.target_type === 'supplier'
          ? 'accounts_payable'
          : 'cash_drawer';
      const targetFallback = data.target_type === 'customer' ? 8 : data.target_type === 'supplier' ? 7 : 6;
      const targetAccountId = await getAccount(targetCategory, targetFallback);
      const adjustmentAccountId = await getAccount('customer_adjustments', 14); // 4.2 Customer Adjustments
      const journalId = generateId();

      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, data.date, `إشعار ${data.type === 'credit' ? 'دائن' : 'مدين'}: ${data.reason}`, user.id, data.amount);

      if (data.type === 'credit') {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, adjustmentAccountId, 'debit', data.amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, targetAccountId, 'credit', data.amount);
      } else {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, targetAccountId, 'debit', data.amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, adjustmentAccountId, 'credit', data.amount);
      }
    });

    revalidatePath('/patients');
    return { success: true, id };
  } catch (error) {
    console.error('Add notice error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل إضافة الإشعار' };
  }
}

const paymentSchema = z.object({
  patient_id: z.string().min(1),
  shift_id: z.string().optional(),
  amount: z.number().positive(),
  payment_method: z.enum(['cash', 'bank']),
  notes: z.string().optional(),
  date: z.string(),
});

export async function addPatientPaymentAction(rawData: z.infer<typeof paymentSchema>) {
  try {
    const data = paymentSchema.parse(rawData);
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };
    if (!hasUserPermissionSync(user, 'rep_can_view_financial') && !hasUserPermissionSync(user, 'can_view_patients')) {
      return { success: false, error: 'غير مصرح' };
    }

    const id = generateId();
    let remainingBalance = 0;
    await dbTransaction(async () => {
      const patient = await db.prepare('SELECT id, full_name FROM patients WHERE id = ?').get(data.patient_id) as any;
      if (!patient) throw new Error('المريض غير موجود');

      const balanceRow = await db.prepare(patientOutstandingBalanceQuery()).get(data.patient_id) as any;
      const outstanding = Number(balanceRow?.outstanding_balance || 0);

      if (data.amount > outstanding + 0.005) {
        throw new Error('مبلغ السداد يتجاوز المديونية الحالية للمريض');
      }

      await db.prepare(`
        INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, payment_method, notes, date)
        VALUES (?, ?, ?, 'payment', ?, ?, ?, ?)
      `).run(id, data.patient_id, user.id, data.amount, data.payment_method, data.notes || null, data.date);

      if (data.payment_method === 'cash') {
        const shiftId = await requireOpenShiftId(user.id, data.shift_id);
        await db.prepare(`
          INSERT INTO cash_movements (
            id, user_id, shift_id, type, category, amount, source_type, target_name, notes, date
          ) VALUES (?, ?, ?, 'receipt', 'accounts_receivable', ?, 'patient_payment', ?, ?, ?)
        `).run(generateId(), user.id, shiftId, data.amount, data.patient_id, `دفعة من المريض ${patient.full_name}: ${data.notes || ''}`, data.date);
      }

      const getAccount = async (category: string, fallback: number) => {
        const setting = await db.prepare(
          'SELECT account_id FROM trial_balance_settings WHERE category = ? LIMIT 1'
        ).get(category) as any;
        return Number(setting?.account_id || fallback);
      };
      const debitAccountId = data.payment_method === 'bank'
        ? await getAccount('bank_clearing', 6)
        : await getAccount('cash_drawer', 6);
      const receivableAccountId = await getAccount('accounts_receivable', 8);
      const journalId = generateId();
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, data.date, `تحصيل من المريض: ${patient.full_name}`, user.id, data.amount);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, debitAccountId, 'debit', data.amount);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, receivableAccountId, 'credit', data.amount);
      await db.prepare("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'PATIENT_PAYMENT', ?)")
        .run(user.id, `Patient ${data.patient_id} paid ${data.amount} via ${data.payment_method}`);

      remainingBalance = Math.max(0, outstanding - data.amount);
    });

    revalidatePath('/patients');
    revalidatePath('/pos');
    return { success: true, id, remainingBalance };
  } catch (error) {
    console.error('Add payment error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل إضافة الدفعة' };
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
    if (!user || !hasUserPermissionSync(user, 'acc_can_process_cash_flow')) return { success: false, error: 'غير مصرح' };

    const cashMovementId = generateId();
    const transaction = db.transaction(async () => {
      const shiftId = await requireOpenShiftId(user.id, data.shift_id);
      await db.prepare(`
        INSERT INTO cash_movements (
          id, user_id, shift_id, type, category, sub_category, 
          amount, source_type, target_name, notes, date, actual_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cashMovementId, user.id, shiftId, data.type, data.category, data.sub_category || null,
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
      const categoryAccountId = await getAccount(data.category, data.target_name) || 11;



      const debitAccountId = data.type === 'receipt' ? mainCashAccountId : categoryAccountId;
      const creditAccountId = data.type === 'receipt' ? categoryAccountId : mainCashAccountId;

      try {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, debitAccountId, 'debit', data.amount);
      } catch (e) {
        console.error("debit journal_entries INSERT failed for account:", debitAccountId, e);
        throw e;
      }

      try {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, creditAccountId, 'credit', data.amount);
      } catch (e) {
        console.error("credit journal_entries INSERT failed for account:", creditAccountId, e);
        throw e;
      }
    });

    await transaction();

    revalidatePath('/finance');
    return { success: true, id: cashMovementId };
  } catch (error) {
    console.error('Create cash movement error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل تنفيذ حركة النقدية' };
  }
}

export async function getCashMovementsAction(filters?: {
  type?: 'disbursement' | 'receipt';
  dateFrom?: string;
  dateTo?: string;
}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'acc_can_process_cash_flow')) return { success: false, error: 'غير مصرح' };

    let query = `
      SELECT cm.*, COALESCE(u.full_name, u.username, cm.user_id) AS user_name,
             s.status AS shift_status
      FROM cash_movements cm
      LEFT JOIN users u ON u.id = cm.user_id
      LEFT JOIN shifts s ON s.id = cm.shift_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filters?.type) {
      query += ` AND cm.type = ?`;
      params.push(filters.type);
    }
    if (filters?.dateFrom) {
      query += ` AND cm.date >= ?`;
      params.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
      query += ` AND cm.date <= ?`;
      params.push(filters.dateTo);
    }

    query += ` ORDER BY cm.created_at DESC`;
    const results = await db.prepare(query).all(...params);
    return { success: true, data: results };
  } catch (error) {
    console.error('Get cash movements error:', error);
    return { success: false, error: 'فشل جلب سجل النقدية' };
  }
}

export async function getPointsOfSaleAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_pos', 'acc_can_view_general', 'can_select_pos_financial')) return { success: false, error: 'غير مصرح' };
    const results = await db.prepare(`SELECT * FROM points_of_sale ORDER BY id ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get POS error:', error);
    return { success: false, error: 'فشل جلب نقاط البيع' };
  }
}

const DEFAULT_EXPENSE_DEFINITIONS = [
  { code: '501', name_ar: 'كهرباء وإنارة', name_en: 'Electricity' },
  { code: '502', name_ar: 'مياه ومرافق', name_en: 'Water & Utilities' },
  { code: '503', name_ar: 'إيجار المقر', name_en: 'Rent' },
  { code: '504', name_ar: 'مرتبات وأجور العاملين', name_en: 'Salaries & Wages' },
  { code: '505', name_ar: 'صيانة ونظافة', name_en: 'Maintenance & Cleaning' },
  { code: '506', name_ar: 'بوفيه وضيافة', name_en: 'Hospitality & Buffet' },
  { code: '507', name_ar: 'إنترنت واتصالات', name_en: 'Internet & Communications' },
  { code: '508', name_ar: 'أدوات ومستلزمات مكتبية', name_en: 'Office Supplies' },
  { code: '509', name_ar: 'نقل وشحن ومواصلات', name_en: 'Transportation & Logistics' },
  { code: '510', name_ar: 'تسويق ودعاية وإعلانات', name_en: 'Marketing & Advertising' },
  { code: '511', name_ar: 'رسوم وتراخيص حكومية', name_en: 'Government Fees & Licenses' },
  { code: '512', name_ar: 'مصروفات وعمولات بنكية', name_en: 'Bank Fees & Charges' },
  { code: '599', name_ar: 'مصاريف نثرية وأخرى', name_en: 'Other Miscellaneous' },
];

export async function getExpenseDefinitionsAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_define_expenses', 'can_view_expenses', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    const countRes = await db.prepare(`SELECT COUNT(*) as count FROM expense_definitions`).get() as any;
    if (!countRes || countRes.count === 0) {
      const insertStmt = db.prepare(`INSERT INTO expense_definitions (code, name_ar, name_en) VALUES (?, ?, ?)`);
      for (const def of DEFAULT_EXPENSE_DEFINITIONS) {
        await insertStmt.run(def.code, def.name_ar, def.name_en);
      }
    }

    const results = await db.prepare(`SELECT * FROM expense_definitions ORDER BY CAST(code AS INTEGER) ASC, code ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get expense definitions error:', error);
    return { success: false, error: 'فشل جلب تعريفات المصروفات' };
  }
}

const expenseDefinitionSchema = z.object({
  code: z.string().min(1, 'كود المصروف مطلوب'),
  name_ar: z.string().min(1, 'اسم المصروف بالعربي مطلوب'),
  name_en: z.string().optional(),
});

export async function addExpenseDefinitionAction(rawData: z.infer<typeof expenseDefinitionSchema>) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_define_expenses', 'acc_can_view_general')) {
      return { success: false, error: 'غير مصرح بإضافة تعريفات المصروفات' };
    }

    const val = expenseDefinitionSchema.parse(rawData);

    const existingCode = await db.prepare('SELECT id FROM expense_definitions WHERE code = ?').get(val.code) as any;
    if (existingCode) {
      return { success: false, error: 'كود المصروف مستخدم بالفعل' };
    }

    const res = await db.prepare(`
      INSERT INTO expense_definitions (code, name_ar, name_en)
      VALUES (?, ?, ?)
    `).run(val.code, val.name_ar, val.name_en || null);

    return { success: true, id: res.lastInsertRowid };
  } catch (error: any) {
    console.error('Add expense definition error:', error);
    return { success: false, error: error.message || 'فشل إضافة تعريف المصروف' };
  }
}

export async function updateExpenseDefinitionAction(id: number, rawData: z.infer<typeof expenseDefinitionSchema>) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_define_expenses', 'acc_can_view_general')) {
      return { success: false, error: 'غير مصرح بتعديل تعريفات المصروفات' };
    }

    const val = expenseDefinitionSchema.parse(rawData);

    const existingCode = await db.prepare('SELECT id FROM expense_definitions WHERE code = ? AND id != ?').get(val.code, id) as any;
    if (existingCode) {
      return { success: false, error: 'كود المصروف مستخدم في تعريف آخر' };
    }

    await db.prepare(`
      UPDATE expense_definitions 
      SET code = ?, name_ar = ?, name_en = ?
      WHERE id = ?
    `).run(val.code, val.name_ar, val.name_en || null, id);

    return { success: true };
  } catch (error: any) {
    console.error('Update expense definition error:', error);
    return { success: false, error: error.message || 'فشل تعديل تعريف المصروف' };
  }
}

export async function deleteExpenseDefinitionAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_define_expenses', 'acc_can_view_general')) {
      return { success: false, error: 'غير مصرح بحذف تعريفات المصروفات' };
    }

    const def = await db.prepare('SELECT * FROM expense_definitions WHERE id = ?').get(id) as any;
    if (!def) {
      return { success: false, error: 'تعريف المصروف غير موجود' };
    }

    const expenseUsage = await db.prepare(`
      SELECT COUNT(*) as count FROM expenses 
      WHERE category = ? OR category = ?
    `).get(def.code, def.name_ar) as any;

    if (expenseUsage && expenseUsage.count > 0) {
      return { success: false, error: 'لا يمكن حذف هذا المصروف لوجود إيصالات مصروفات مسجلة عليه' };
    }

    const movementUsage = await db.prepare(`
      SELECT COUNT(*) as count FROM cash_movements 
      WHERE category = ? OR category = ?
    `).get(def.code, def.name_ar) as any;

    if (movementUsage && movementUsage.count > 0) {
      return { success: false, error: 'لا يمكن حذف هذا المصروف لوجود حركات نقدية مسجلة عليه' };
    }

    await db.prepare('DELETE FROM expense_definitions WHERE id = ?').run(id);
    return { success: true };
  } catch (error: any) {
    console.error('Delete expense definition error:', error);
    return { success: false, error: error.message || 'فشل حذف تعريف المصروف' };
  }
}

export async function getBanksAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_bank_accounts', 'acc_can_view_handover', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    const results = await db.prepare(`SELECT * FROM banks ORDER BY name_ar ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get banks error:', error);
    return { success: false, error: 'فشل جلب البيانات البنكية' };
  }
}

export async function getPapersAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_securities')) return { success: false, error: 'غير مصرح' };
    const results = await db.prepare(`SELECT * FROM commercial_papers ORDER BY due_date ASC`).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get papers error:', error);
    return { success: false, error: 'فشل جلب الأوراق المالية' };
  }
}

export async function getCardsAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_collect_credit_cards')) return { success: false, error: 'غير مصرح' };
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
    if (!hasAnyFinancePermission(user, 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

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
    const codeMap = new Map(accounts.map(acc => [acc.code, acc]));
    const sortedAccounts = [...accounts].sort((a, b) => b.code.length - a.code.length);
    
    sortedAccounts.forEach(acc => {
      let parent = acc.parent_id ? accountsMap.get(acc.parent_id) : null;
      if (!parent) {
        if (acc.code.includes('.')) {
          const parentCode = acc.code.split('.').slice(0, -1).join('.');
          parent = codeMap.get(parentCode);
        } else if (acc.code.length > 1) {
          parent = codeMap.get(acc.code.slice(0, -1)) || codeMap.get(acc.code.charAt(0));
        }
      }
      if (parent && parent.id !== acc.id) {
        parent.balance = (parent.balance || 0) + (acc.balance || 0);
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
    if (!hasAnyFinancePermission(user, 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

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
  code: z.string().optional(),
  name_ar: z.string().optional(),
  name_en: z.string().optional(),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']).optional(),
  is_group: z.number().int().min(0).max(1).optional(),
});

export async function updateAccountAction(id: number, rawData: z.infer<typeof updateAccountSchema>) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    const data = updateAccountSchema.parse(rawData);
    
    const ALLOWED_ACCOUNT_FIELDS: Record<string, true> = {
      name_ar: true, name_en: true, type: true, is_group: true,
    };
    const keys = Object.keys(data).filter(k => ALLOWED_ACCOUNT_FIELDS[k]);
    if (keys.length === 0) return { success: true };
    
    const fields = keys.map(k => `${k} = ?`).join(', ');
    const params = [...keys.map(k => data[k as keyof typeof data]), id];
    
    await db.prepare(`UPDATE accounts SET ${fields} WHERE id = ?`).run(...params);
    
    revalidatePath('/finance');
    return { success: true };
  } catch (error) {
    console.error('Update account error:', error);
    return { success: false, error: 'فشل تحديث الحساب' };
  }
}

export async function deleteAccountAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    const account = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as any;
    if (!account) return { success: false, error: 'الحساب غير موجود' };

    // 1. Check child sub-accounts
    const childrenCount = await db.prepare('SELECT COUNT(*) as count FROM accounts WHERE parent_id = ?').get(id) as any;
    if (childrenCount?.count > 0) {
      return { success: false, error: 'لا يمكن حذف حساب رئيسي يحتوي على حسابات فرعية. يرجى حذف الحسابات الفرعية أولاً.' };
    }

    // 2. Check journal entries
    const entriesCount = await db.prepare('SELECT COUNT(*) as count FROM journal_entries WHERE account_id = ?').get(id) as any;
    if (entriesCount?.count > 0) {
      return { success: false, error: 'لا يمكن حذف حساب مرتبط بحركات وقيود مالية مسجلة.' };
    }

    // 3. Check system trial_balance_settings
    const settingCount = await db.prepare('SELECT COUNT(*) as count FROM trial_balance_settings WHERE account_id = ?').get(id) as any;
    if (settingCount?.count > 0) {
      return { success: false, error: 'لا يمكن حذف حساب أساسي مرتبط بإعدادات ميزان المراجعة.' };
    }

    await db.prepare('DELETE FROM accounts WHERE id = ?').run(id);

    revalidatePath('/finance');
    return { success: true };
  } catch (error: any) {
    console.error('Delete account error:', error);
    return { success: false, error: error?.message || 'فشل حذف الحساب' };
  }
}


export async function getJournalsAction(filters?: { dateFrom?: string; dateTo?: string }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_make_daily_entries', 'acc_can_view_reports')) return { success: false, error: 'غير مصرح' };

    let sql = `SELECT * FROM daily_journals WHERE 1=1`;
    const params: any[] = [];
    if (filters?.dateFrom) {
      sql += ` AND date(date) >= date(?)`;
      params.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
      sql += ` AND date(date) <= date(?)`;
      params.push(filters.dateTo);
    }
    sql += ` ORDER BY date DESC, created_at DESC`;
    const results = await db.prepare(sql).all(...params);
    return { success: true, data: results };
  } catch (error) {
    console.error('Get journals error:', error);
    return { success: false, error: 'فشل جلب القيود اليومية' };
  }
}

export async function getJournalDetailsAction(journalId: string) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_make_daily_entries', 'acc_can_view_reports')) return { success: false, error: 'غير مصرح' };
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
    const user = await getLocalSession();
    if (user?.role !== 'owner') return { success: false, error: 'غير مصرح' };
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
    const date = targetDate || format(new Date(), 'yyyy-MM-dd');
    
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
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
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
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    // INSERT OR REPLACE leverages the UNIQUE constraint on `category`
    await db.prepare(`
      INSERT INTO trial_balance_settings (category, target_type, target_id, target_name, account_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(category) DO UPDATE SET
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        target_name = excluded.target_name,
        account_id = excluded.account_id
    `).run(data.category, data.target_type || null, data.target_id || null, data.target_name || null, data.account_id);

    revalidatePath('/accounts/settings/trial-balance');
    return { success: true };
  } catch (error) {
    console.error('Save trial balance setting error:', error);
    return { success: false, error: 'فشل حفظ الإعداد' };
  }
}


export async function getPatientStatementAction(patientId: string) {
  // Keep the legacy export, but route it through the canonical patient ledger.
  const patients = await import('./patients');
  return patients.getPatientStatementAction(patientId);
}

export async function getTrialBalanceAction(startDate?: string, endDate?: string) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_reports')) return { success: false, error: 'غير مصرح' };

    const cleanStart = startDate && startDate.trim().length > 0 ? startDate.trim() : null;
    const cleanEnd = endDate && endDate.trim().length > 0 ? endDate.trim() : null;

    const balances = await db.prepare(`
      WITH RawEntries AS (
        SELECT 
          je.account_id,
          je.type,
          je.amount,
          date(COALESCE(dj.date, dj.created_at, '1970-01-01')) as entry_date
        FROM journal_entries je
        LEFT JOIN daily_journals dj ON je.journal_id = dj.id
      )
      SELECT 
        a.id,
        a.code,
        a.name_ar,
        a.name_en,
        a.type,
        a.parent_id,
        a.is_group,
        -- Opening movements (before startDate)
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND re.entry_date < ? AND re.type = 'debit' THEN re.amount ELSE 0 END), 0) as opening_debit,
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND re.entry_date < ? AND re.type = 'credit' THEN re.amount ELSE 0 END), 0) as opening_credit,
        -- Period movements (between startDate and endDate)
        COALESCE(SUM(CASE 
          WHEN (? IS NULL OR re.entry_date >= ?) AND (? IS NULL OR re.entry_date <= ?) AND re.type = 'debit' 
          THEN re.amount ELSE 0 END), 0) as period_debit,
        COALESCE(SUM(CASE 
          WHEN (? IS NULL OR re.entry_date >= ?) AND (? IS NULL OR re.entry_date <= ?) AND re.type = 'credit' 
          THEN re.amount ELSE 0 END), 0) as period_credit,
        -- Total cumulative movements up to endDate
        COALESCE(SUM(CASE 
          WHEN (? IS NULL OR re.entry_date <= ?) AND re.type = 'debit' 
          THEN re.amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE 
          WHEN (? IS NULL OR re.entry_date <= ?) AND re.type = 'credit' 
          THEN re.amount ELSE 0 END), 0) as total_credit
      FROM accounts a
      LEFT JOIN RawEntries re ON a.id = re.account_id
      GROUP BY a.id
      ORDER BY a.code ASC
    `).all(
      cleanStart, cleanStart,
      cleanStart, cleanStart,
      cleanStart, cleanStart, cleanEnd, cleanEnd,
      cleanStart, cleanStart, cleanEnd, cleanEnd,
      cleanEnd, cleanEnd,
      cleanEnd, cleanEnd
    ) as any[];

    // Calculate Net Balances
    const results = balances.map(acc => {
      const openingNetDebit = acc.opening_debit > acc.opening_credit ? acc.opening_debit - acc.opening_credit : 0;
      const openingNetCredit = acc.opening_credit > acc.opening_debit ? acc.opening_credit - acc.opening_debit : 0;
      const netDebit = acc.total_debit > acc.total_credit ? acc.total_debit - acc.total_credit : 0;
      const netCredit = acc.total_credit > acc.total_debit ? acc.total_credit - acc.total_debit : 0;
      return { 
        ...acc, 
        opening_net_debit: openingNetDebit,
        opening_net_credit: openingNetCredit,
        net_debit: netDebit, 
        net_credit: netCredit 
      };
    });

    return { success: true, data: results };
  } catch (error) {
    console.error('Trial balance error:', error);
    return { success: false, error: 'فشل جلب ميزان المراجعة' };
  }
}

export async function getFinancialNoticesAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_notifications')) return { success: false, error: 'غير مصرح' };
    const results = await db.prepare(`
      SELECT n.*, u.full_name as user_name,
        CASE 
          WHEN n.target_type = 'customer' THEN COALESCE(p.name, 'عميل')
          WHEN n.target_type = 'supplier' THEN COALESCE(s.name, 'مورد')
          ELSE 'الصيدلية / عام'
        END as target_name
      FROM financial_notices n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN patients p ON n.target_type = 'customer' AND n.target_id = p.id
      LEFT JOIN suppliers s ON n.target_type = 'supplier' AND CAST(n.target_id AS TEXT) = CAST(s.id AS TEXT)
      ORDER BY n.created_at DESC LIMIT 200
    `).all();
    return { success: true, data: results };
  } catch (error) {
    console.error('Get financial notices error:', error);
    return { success: false, error: 'فشل جلب الإشعارات المالية' };
  }
}

export async function getActivityLogsAction() {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'can_view_audit')) return { success: false, error: 'غير مصرح' };
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

// -------------------------------------------------------------
// 1. Bank Accounts CRUD
// -------------------------------------------------------------
export async function addBankAction(data: { name_ar: string; name_en?: string; account_number?: string; branch?: string; current_balance?: number }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_bank_accounts', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.name_ar?.trim()) return { success: false, error: 'اسم البنك بالعربي مطلوب' };

    const res = await db.prepare(`
      INSERT INTO banks (name_ar, name_en, account_number, branch, current_balance)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.name_ar.trim(),
      data.name_en?.trim() || null,
      data.account_number?.trim() || null,
      data.branch?.trim() || null,
      Number(data.current_balance) || 0
    );

    await logActivity(user?.id, 'ADD_BANK', `إضافة حساب بنكي: ${data.name_ar}`);
    return { success: true, id: res.lastInsertId };
  } catch (error: any) {
    console.error('Add bank error:', error);
    return { success: false, error: error.message || 'فشل إضافة الحساب البنكي' };
  }
}

export async function updateBankAction(id: number, data: { name_ar: string; name_en?: string; account_number?: string; branch?: string; current_balance?: number }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_bank_accounts', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.name_ar?.trim()) return { success: false, error: 'اسم البنك بالعربي مطلوب' };

    await db.prepare(`
      UPDATE banks 
      SET name_ar = ?, name_en = ?, account_number = ?, branch = ?, current_balance = COALESCE(?, current_balance)
      WHERE id = ?
    `).run(
      data.name_ar.trim(),
      data.name_en?.trim() || null,
      data.account_number?.trim() || null,
      data.branch?.trim() || null,
      data.current_balance !== undefined ? Number(data.current_balance) : null,
      id
    );

    await logActivity(user?.id, 'UPDATE_BANK', `تعديل حساب بنكي #${id}: ${data.name_ar}`);
    return { success: true };
  } catch (error: any) {
    console.error('Update bank error:', error);
    return { success: false, error: error.message || 'فشل تعديل الحساب البنكي' };
  }
}

export async function deleteBankAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_bank_accounts', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    const cardUsage = await db.prepare('SELECT COUNT(*) as count FROM credit_cards WHERE bank_id = ?').get(id) as any;
    if (cardUsage && cardUsage.count > 0) {
      return { success: false, error: 'لا يمكن حذف هذا البنك لوجود بطاقات ائتمان مرتبطة به' };
    }

    const paperUsage = await db.prepare('SELECT COUNT(*) as count FROM commercial_papers WHERE bank_id = ?').get(id) as any;
    if (paperUsage && paperUsage.count > 0) {
      return { success: false, error: 'لا يمكن حذف هذا البنك لوجود أوراق مالية مرتبطة به' };
    }

    await db.prepare('DELETE FROM banks WHERE id = ?').run(id);
    await logActivity(user?.id, 'DELETE_BANK', `حذف حساب بنكي #${id}`);
    return { success: true };
  } catch (error: any) {
    console.error('Delete bank error:', error);
    return { success: false, error: error.message || 'فشل حذف الحساب البنكي' };
  }
}

// -------------------------------------------------------------
// 2. Credit Cards / Terminals CRUD
// -------------------------------------------------------------
export async function addCardAction(data: { name_ar: string; name_en?: string; bank_id?: number | null; commission_pct?: number; current_balance?: number }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_collect_credit_cards', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.name_ar?.trim()) return { success: false, error: 'اسم الماكينة / البطاقة مطلوب' };

    const res = await db.prepare(`
      INSERT INTO credit_cards (name_ar, name_en, bank_id, commission_pct, current_balance)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.name_ar.trim(),
      data.name_en?.trim() || null,
      data.bank_id || null,
      Number(data.commission_pct) || 0,
      Number(data.current_balance) || 0
    );

    await logActivity(user?.id, 'ADD_CARD', `إضافة ماكينة دفع: ${data.name_ar}`);
    return { success: true, id: res.lastInsertId };
  } catch (error: any) {
    console.error('Add card error:', error);
    return { success: false, error: error.message || 'فشل إضافة ماكينة الدفع' };
  }
}

export async function updateCardAction(id: number, data: { name_ar: string; name_en?: string; bank_id?: number | null; commission_pct?: number; current_balance?: number }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_collect_credit_cards', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.name_ar?.trim()) return { success: false, error: 'اسم الماكينة / البطاقة مطلوب' };

    await db.prepare(`
      UPDATE credit_cards 
      SET name_ar = ?, name_en = ?, bank_id = ?, commission_pct = ?, current_balance = COALESCE(?, current_balance)
      WHERE id = ?
    `).run(
      data.name_ar.trim(),
      data.name_en?.trim() || null,
      data.bank_id || null,
      Number(data.commission_pct) || 0,
      data.current_balance !== undefined ? Number(data.current_balance) : null,
      id
    );

    await logActivity(user?.id, 'UPDATE_CARD', `تعديل ماكينة دفع #${id}: ${data.name_ar}`);
    return { success: true };
  } catch (error: any) {
    console.error('Update card error:', error);
    return { success: false, error: error.message || 'فشل تعديل ماكينة الدفع' };
  }
}

export async function deleteCardAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_collect_credit_cards', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM credit_cards WHERE id = ?').run(id);
    await logActivity(user?.id, 'DELETE_CARD', `حذف ماكينة دفع #${id}`);
    return { success: true };
  } catch (error: any) {
    console.error('Delete card error:', error);
    return { success: false, error: error.message || 'فشل حذف ماكينة الدفع' };
  }
}

// -------------------------------------------------------------
// 3. Points of Sale (POS) CRUD
// -------------------------------------------------------------
export async function addPointOfSaleAction(data: { name_ar: string; name_en?: string; location?: string; computer_name?: string; current_balance?: number }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_pos', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.name_ar?.trim()) return { success: false, error: 'اسم نقطة البيع بالعربي مطلوب' };

    const res = await db.prepare(`
      INSERT INTO points_of_sale (name_ar, name_en, location, computer_name, current_balance, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(
      data.name_ar.trim(),
      data.name_en?.trim() || null,
      data.location?.trim() || null,
      data.computer_name?.trim() || null,
      Number(data.current_balance) || 0
    );

    await logActivity(user?.id, 'ADD_POS', `إضافة نقطة بيع: ${data.name_ar}`);
    return { success: true, id: res.lastInsertId };
  } catch (error: any) {
    console.error('Add point of sale error:', error);
    return { success: false, error: error.message || 'فشل إضافة نقطة البيع' };
  }
}

export async function updatePointOfSaleAction(id: number, data: { name_ar: string; name_en?: string; location?: string; computer_name?: string; current_balance?: number; status?: string }) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_pos', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.name_ar?.trim()) return { success: false, error: 'اسم نقطة البيع بالعربي مطلوب' };

    await db.prepare(`
      UPDATE points_of_sale 
      SET name_ar = ?, name_en = ?, location = ?, computer_name = ?, current_balance = COALESCE(?, current_balance), status = COALESCE(?, status)
      WHERE id = ?
    `).run(
      data.name_ar.trim(),
      data.name_en?.trim() || null,
      data.location?.trim() || null,
      data.computer_name?.trim() || null,
      data.current_balance !== undefined ? Number(data.current_balance) : null,
      data.status || 'active',
      id
    );

    await logActivity(user?.id, 'UPDATE_POS', `تعديل نقطة بيع #${id}: ${data.name_ar}`);
    return { success: true };
  } catch (error: any) {
    console.error('Update point of sale error:', error);
    return { success: false, error: error.message || 'فشل تعديل نقطة البيع' };
  }
}

export async function deletePointOfSaleAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_pos', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM points_of_sale WHERE id = ?').run(id);
    await logActivity(user?.id, 'DELETE_POS', `حذف نقطة بيع #${id}`);
    return { success: true };
  } catch (error: any) {
    console.error('Delete point of sale error:', error);
    return { success: false, error: error.message || 'فشل حذف نقطة البيع' };
  }
}

// -------------------------------------------------------------
// 4. Commercial Papers (Checks / Notes) CRUD & Lifecycle
// -------------------------------------------------------------
export async function addPaperAction(data: {
  type: 'check' | 'promissory_note';
  direction: 'in' | 'out';
  paper_number: string;
  bank_id?: number | null;
  amount: number;
  due_date: string;
  target_name: string;
  notes?: string;
}) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_securities', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };
    if (!data.paper_number?.trim()) return { success: false, error: 'رقم الورقة / الشيك مطلوب' };
    if (!data.amount || data.amount <= 0) return { success: false, error: 'المبلغ يجب أن يكون أكبر من صفر' };
    if (!data.target_name?.trim()) return { success: false, error: 'اسم الجهة / الساحب مطلوب' };

    const id = generateId();
    await db.prepare(`
      INSERT INTO commercial_papers (id, type, direction, paper_number, bank_id, amount, due_date, status, target_name, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      data.type || 'check',
      data.direction || 'in',
      data.paper_number.trim(),
      data.bank_id || null,
      Number(data.amount),
      data.due_date,
      data.target_name.trim(),
      data.notes?.trim() || null
    );

    await logActivity(user?.id, 'ADD_COMMERCIAL_PAPER', `تسجيل ورقة مالية (${data.type === 'check' ? 'شيك' : 'كمبيالة'} ${data.direction === 'in' ? 'وارد' : 'صادر'}) رقم: ${data.paper_number} بقيمة: ${data.amount}`);
    return { success: true, id };
  } catch (error: any) {
    console.error('Add commercial paper error:', error);
    return { success: false, error: error.message || 'فشل تسجيل الورقة المالية' };
  }
}

export async function updatePaperStatusAction(id: string, newStatus: 'pending' | 'cashed' | 'bounced' | 'cancelled', actionDate?: string) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_securities', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    const paper = await db.prepare('SELECT * FROM commercial_papers WHERE id = ?').get(id) as any;
    if (!paper) return { success: false, error: 'الورقة المالية غير موجودة' };

    await db.prepare('UPDATE commercial_papers SET status = ? WHERE id = ?').run(newStatus, id);

    // If status transitioned to 'cashed', dynamically record treasury cash movement & journal
    if (newStatus === 'cashed' && paper.status !== 'cashed') {
      const movementType = paper.direction === 'in' ? 'receipt' : 'disbursement';
      const movementCategory = paper.direction === 'in' ? 'collection' : 'supplier_payment';
      const date = actionDate || new Date().toISOString().split('T')[0];
      const note = `تحصيل/صرف ${paper.type === 'check' ? 'شيك' : 'كمبيالة'} رقم ${paper.paper_number} - ${paper.target_name}`;

      await createCashMovementAction({
        type: movementType,
        category: movementCategory,
        amount: paper.amount,
        notes: note,
        date: date
      });
    }

    await logActivity(user?.id, 'UPDATE_PAPER_STATUS', `تحديث حالة الورقة المالية #${id} إلى: ${newStatus}`);
    return { success: true };
  } catch (error: any) {
    console.error('Update paper status error:', error);
    return { success: false, error: error.message || 'فشل تحديث حالة الورقة المالية' };
  }
}

export async function deletePaperAction(id: string) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_view_securities', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM commercial_papers WHERE id = ?').run(id);
    await logActivity(user?.id, 'DELETE_PAPER', `حذف ورقة مالية #${id}`);
    return { success: true };
  } catch (error: any) {
    console.error('Delete paper error:', error);
    return { success: false, error: error.message || 'فشل حذف الورقة المالية' };
  }
}

// -------------------------------------------------------------
// 5. Manual Daily Journal Voucher Creation
// -------------------------------------------------------------
export async function createManualJournalAction(data: {
  date: string;
  description: string;
  entries: Array<{ account_id: number; type: 'debit' | 'credit'; amount: number; notes?: string }>;
}) {
  try {
    const user = await getLocalSession();
    if (!hasAnyFinancePermission(user, 'acc_can_make_daily_entries', 'acc_can_view_general')) return { success: false, error: 'غير مصرح' };

    if (!data.entries || data.entries.length < 2) {
      return { success: false, error: 'القيد اليومي يجب أن يتضمن طرفين على الأقل (طرف مدين وطرف دائن)' };
    }

    let totalDebit = 0;
    let totalCredit = 0;
    for (const ent of data.entries) {
      const amt = Number(ent.amount) || 0;
      if (amt <= 0) return { success: false, error: 'يجب أن تكون جميع المبالغ في القيد أكبر من صفر' };
      if (ent.type === 'debit') totalDebit += amt;
      else if (ent.type === 'credit') totalCredit += amt;
    }

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return { success: false, error: `القيد غير متزن: مجموع المدين (${totalDebit.toFixed(2)}) لا يساوي مجموع الدائن (${totalCredit.toFixed(2)})` };
    }

    const journalId = generateId();
    await db.prepare(`
      INSERT INTO daily_journals (id, date, description, created_by, total_amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      journalId,
      data.date || new Date().toISOString().split('T')[0],
      data.description?.trim() || 'قيد تسوية يدوي',
      user?.id || 'admin',
      totalDebit
    );

    for (const ent of data.entries) {
      await db.prepare(`
        INSERT INTO journal_entries (journal_id, account_id, type, amount, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        journalId,
        ent.account_id,
        ent.type,
        Number(ent.amount),
        ent.notes?.trim() || data.description?.trim() || null
      );
    }

    await logActivity(user?.id, 'CREATE_MANUAL_JOURNAL', `إنشاء قيد يومي يدوي #${journalId.slice(0, 8)} بمبلغ ${totalDebit.toFixed(2)} ج.م`);
    return { success: true, id: journalId };
  } catch (error: any) {
    console.error('Create manual journal error:', error);
    return { success: false, error: error.message || 'فشل إنشاء القيد اليومي' };
  }
}
