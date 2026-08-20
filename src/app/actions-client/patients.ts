
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



import { z } from 'zod';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';
import {
  patientOutstandingBalanceExpression,
  patientOutstandingBalanceQuery,
} from '@/lib/patients/balance';

const patientSchema = z.object({
  full_name: z.string().min(3, 'الاسم يجب أن يكون 3 أحرف على الأقل'),
  name_en: z.string().optional().nullable(),
  phone: z.preprocess(
    value => typeof value === 'string' && value.trim() === '' ? null : value,
    z.string().regex(/^01[0-9]{9}$/, 'رقم الهاتف يجب أن يكون رقم مصري صحيح (01xxxxxxxxx)').optional().nullable()
  ),
  mobile: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  area: z.string().optional().nullable(),
  birth_date: z.string().optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  insurance_number: z.string().optional().nullable(),
  car_number: z.string().optional().nullable(),
  credit_limit: z.number().nonnegative().default(0),
  opening_balance: z.number().default(0),
  points_balance: z.number().nonnegative().default(0),
  point_value: z.number().default(1),
  customer_type: z.string().default('individual'),
  payment_method: z.string().default('cash'),
  notes: z.string().optional().nullable(),
});

export type AddPatientInput = z.infer<typeof patientSchema>;

function canManagePatients(user: any): boolean {
  return !!user && hasUserPermissionSync(user, 'can_view_patients');
}

function canDeletePatients(user: any): boolean {
  return !!user && ['owner', 'admin'].includes(user.role);
}

function canSearchPatientsForPos(user: any): boolean {
  return canManagePatients(user) || (!!user && hasUserPermissionSync(user, 'can_view_sales'));
}

/**
 * Server Action to add a new patient (Local Enforcer)
 */
export async function addPatientAction(formData: AddPatientInput) {
  try {
    // 1. Validate input with Zod
    const validationResult = patientSchema.safeParse(formData);
    if (!validationResult.success) {
      console.error('Validation error:', validationResult.error);
      return {
        success: false,
        error: 'بيانات المريض غير صالحة. يرجى التحقق من المدخلات.',
      };
    }

    // 2. Check local session
    const localUser = await getLocalSession();
    if (!canManagePatients(localUser)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser) {
      return { success: false, error: 'غير مصرح. يرجى تسجيل الدخول محلياً.' };
    }

    const data = validationResult.data;
    const id = generateId();

    // 3. Insert the patient and opening receivable as one atomic operation.
    await dbTransaction(async () => {
      await db.prepare(`
        INSERT INTO patients (
          id, full_name, name_en, phone, mobile, address, area, birth_date,
          gender, insurance_number, car_number, credit_limit, opening_balance,
          points_balance, point_value, customer_type, payment_method, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, data.full_name, data.name_en || null, data.phone || null, data.mobile || null,
        data.address || null, data.area || null, data.birth_date || null,
        data.gender || null, data.insurance_number || null, data.car_number || null,
        data.credit_limit, data.opening_balance, data.points_balance,
        data.point_value, data.customer_type, data.payment_method, data.notes || null
      );

      if (Math.abs(data.opening_balance) > 0.000001) {
        const receivable = await db.prepare(
          "SELECT account_id FROM trial_balance_settings WHERE category = 'accounts_receivable' LIMIT 1"
        ).get() as any;
        const openingEquity = await db.prepare(
          "SELECT account_id FROM trial_balance_settings WHERE category = 'opening_balance_equity' LIMIT 1"
        ).get() as any;
        const receivableAccountId = Number(receivable?.account_id || 8);
        const equityAccountId = Number(openingEquity?.account_id || 15);
        const amount = Math.abs(data.opening_balance);
        const journalId = generateId();
        const date = new Date().toISOString().slice(0, 10);

        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, date, `رصيد افتتاحي للمريض: ${data.full_name}`, localUser.id, amount);

        const debitAccount = data.opening_balance > 0 ? receivableAccountId : equityAccountId;
        const creditAccount = data.opening_balance > 0 ? equityAccountId : receivableAccountId;
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, debitAccount, 'debit', amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, creditAccount, 'credit', amount);
      }
    });

    // 4. Revalidate pages
    revalidatePath('/patients');
    revalidatePath('/pos');

    return { success: true, id };
  } catch (error: any) {
    console.error('Local Patient Error:', error);
    return {
      success: false,
      error: 'حدث خطأ أثناء إضافة المريض محلياً.',
    };
  }
}

export async function searchPatientsAction(query: string, fetchAll: boolean = false) {
  try {
    const localUser = await getLocalSession();
    if (!canSearchPatientsForPos(localUser)) return { success: false, error: 'Unauthorized' };

    if (!fetchAll && (!query || query.length < 2)) return { success: true, data: [] };

    if (fetchAll || !query || query.trim() === '') {
      const patients = await db.prepare(`
        SELECT p.id, p.full_name, p.phone, p.credit_limit, p.wallet_balance, p.opening_balance, p.payment_method,
               CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
        FROM patients p
        ORDER BY p.full_name ASC
        LIMIT 100
      `).all() as any[];
      return { success: true, data: patients };
    }

    const searchPattern = `%${query}%`;
    const patients = await db.prepare(`
      SELECT p.id, p.full_name, p.phone, p.credit_limit, p.wallet_balance, p.opening_balance, p.payment_method,
             CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p
      WHERE (full_name LIKE ? OR phone LIKE ?)
      ORDER BY p.full_name ASC
      LIMIT 25
    `).all(searchPattern, searchPattern) as any[];
    
    return { success: true, data: patients };
  } catch (error) {
    console.error('Patient search error:', error);
    return { success: false, error: 'فشل البحث في قاعدة البيانات المحلية' };
  }
}

/**
 * Get full patient profile with allergies, conditions, and purchase history
 */
export async function getPatientProfileAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!canManagePatients(user)) return { success: false, error: 'غير مصرح' };

    const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'المريض غير موجود' };

    const allergies = await db.prepare('SELECT * FROM patient_allergies WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
    const conditions = await db.prepare('SELECT * FROM patient_conditions WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
    
    const purchaseHistory = await db.prepare(`
      SELECT si.id as invoice_id, si.total_amount, si.payment_method, si.created_at
      FROM sales_invoices si
      WHERE si.patient_id = ? AND si.status = 'completed'
      ORDER BY si.created_at DESC
      LIMIT 50
    `).all(patientId) as any[];

    if (purchaseHistory.length > 0) {
      const placeholders = purchaseHistory.map(() => '?').join(',');
      const invoiceIds = purchaseHistory.map(h => h.invoice_id);
      const items = await db.prepare(`
        SELECT sit.invoice_id, sit.drug_id,
               m.trade_name_en, m.trade_name
        FROM sales_items sit
        JOIN master_drugs m ON sit.drug_id = m.id
        WHERE sit.invoice_id IN (${placeholders})
      `).all(...invoiceIds) as any[];

      purchaseHistory.forEach(inv => {
        const invItems = items.filter(item => item.invoice_id === inv.invoice_id);
        inv.drugs = invItems.map(item => item.trade_name_en || item.trade_name).filter(Boolean).join('، ');
      });
    }

    const totalSpent = await db.prepare(`
      SELECT COALESCE(SUM(CAST(total_amount AS REAL)), 0) as total
      FROM sales_invoices WHERE patient_id = ? AND status = 'completed'
    `).get(patientId) as any;

    const payments = await db.prepare(`
      SELECT pt.*, u.full_name AS user_name
      FROM patient_transactions pt
      LEFT JOIN users u ON u.id = pt.user_id
      WHERE pt.patient_id = ? AND pt.type = 'payment'
      ORDER BY pt.date DESC, pt.created_at DESC
    `).all(patientId) as any[];

    const balance = await db.prepare(patientOutstandingBalanceQuery()).get(patientId) as any;
    const outstandingBalance = Number(balance?.outstanding_balance || 0);

    return {
      success: true,
      data: {
        ...patient,
        allergies,
        conditions,
        purchaseHistory,
        payments,
        totalSpent: totalSpent?.total || 0,
        visitCount: (purchaseHistory as any[]).length,
        outstandingBalance,
        availableCredit: Math.max(0, Number(patient.credit_limit || 0) - outstandingBalance),
      }
    };
  } catch (error) {
    return { success: false, error: 'فشل جلب ملف المريض' };
  }
}

/**
 * Add patient allergy
 */
export async function addPatientAllergyAction(data: { patient_id: string; allergen: string; severity: string; notes?: string }) {
  try {
    const user = await getLocalSession();
    if (!canManagePatients(user)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user) return { success: false, error: 'غير مصرح' };

    await db.prepare('INSERT INTO patient_allergies (patient_id, allergen, severity, notes) VALUES (?, ?, ?, ?)').run(data.patient_id, data.allergen, data.severity, data.notes || null);

    revalidatePath('/patients');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل إضافة الحساسية' };
  }
}

/**
 * Add patient chronic condition
 */
export async function addPatientConditionAction(data: { patient_id: string; condition_name: string; medications?: string; notes?: string }) {
  try {
    const user = await getLocalSession();
    if (!canManagePatients(user)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user) return { success: false, error: 'غير مصرح' };

    await db.prepare('INSERT INTO patient_conditions (patient_id, condition_name, medications, notes) VALUES (?, ?, ?, ?)').run(data.patient_id, data.condition_name, data.medications || null, data.notes || null);

    revalidatePath('/patients');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل إضافة الحالة الصحية' };
  }
}

/**
 * Delete patient allergy
 */
export async function deletePatientAllergyAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!canManagePatients(user)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user) return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM patient_allergies WHERE id = ?').run(id);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل حذف الحساسية' };
  }
}

/**
 * Server Action to update an existing patient
 */
export async function updatePatientAction(id: string, formData: AddPatientInput) {
  try {
    // 1. Validate input with Zod
    const validationResult = patientSchema.safeParse(formData);
    if (!validationResult.success) {
      return {
        success: false,
        error: 'بيانات المريض غير صالحة. يرجى التحقق من المدخلات.',
      };
    }

    // 2. Check local session
    const localUser = await getLocalSession();
    if (!canManagePatients(localUser)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser) {
      return { success: false, error: 'غير مصرح. يرجى تسجيل الدخول محلياً.' };
    }

    const {
      full_name, name_en, phone, mobile, address, area, birth_date,
      gender, insurance_number, car_number, credit_limit, points_balance,
      point_value, customer_type, payment_method, notes, opening_balance
    } = validationResult.data;

    // Opening balance is an accounted opening entry, not editable patient
    // metadata.  Changing it silently would desynchronise A/R from its journal;
    // later balance changes must use a debit/credit notice instead.
    await dbTransaction(async () => {
      const existing = await db.prepare(
        'SELECT CAST(COALESCE(opening_balance, 0) AS REAL) AS opening_balance FROM patients WHERE id = ?'
      ).get(id) as any;
      if (!existing) throw new Error('المريض غير موجود');
      if (Math.abs(Number(existing.opening_balance || 0) - Number(opening_balance || 0)) > 0.000001) {
        throw new Error('لا يمكن تعديل الرصيد الافتتاحي مباشرة؛ استخدم إشعار دائن أو مدين');
      }

      const updated = await db.prepare(`
        UPDATE patients
        SET
          full_name = ?, name_en = ?, phone = ?, mobile = ?, address = ?, area = ?,
          birth_date = ?, gender = ?, insurance_number = ?, car_number = ?,
          credit_limit = ?, points_balance = ?, point_value = ?,
          customer_type = ?, payment_method = ?, notes = ?
        WHERE id = ?
      `).run(
        full_name, name_en || null, phone || null, mobile || null, address || null, area || null,
        birth_date || null, gender || null, insurance_number || null, car_number || null,
        credit_limit, points_balance, point_value,
        customer_type, payment_method, notes || null,
        id
      );
      if (!updated.changes) throw new Error('تعذر تحديث بيانات المريض');
    });

    // 4. Revalidate pages
    revalidatePath('/patients');
    revalidatePath('/pos');

    return { success: true };
  } catch (error: any) {
    console.error('Update Patient Error:', error);
    return {
      success: false,
      error: error?.message || 'حدث خطأ أثناء تحديث بيانات المريض.',
    };
  }
}

export async function getPatientStatementAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const { hasUserPermissionSync, isOwnerOrAdmin } = await import('@/lib/auth/local');
    const allowed = isOwnerOrAdmin(user) ||
      hasUserPermissionSync(user, 'can_view_patients') ||
      hasUserPermissionSync(user, 'can_view_sales') ||
      hasUserPermissionSync(user, 'can_sell');
    if (!allowed) return { success: false, error: 'ليس لديك صلاحية عرض كشف الحساب' };

    // 1. Get Patient Details
    const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'العميل غير موجود' };

    // 2. Get all documents, with a separate effect on accounts receivable.
    const movements = await db.prepare(`
      SELECT 'فاتورة بيع' as type, id as doc_no, created_at as date,
             CAST(total_amount AS REAL) as value,
             CASE WHEN payment_method = 'credit' THEN CAST(total_amount AS REAL) ELSE 0 END as balance_effect,
             payment_method,
             NULL as notes,
             (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM sales_invoices
      WHERE patient_id = ? AND status = 'completed'
      
      UNION ALL
      
      SELECT 'مرتجع بيع' as type, id as doc_no, created_at as date,
             -CAST(total_refund AS REAL) as value,
             CASE WHEN refund_method = 'patient_account' THEN -CAST(total_refund AS REAL) ELSE 0 END as balance_effect,
             refund_method as payment_method,
             reason as notes,
             (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM returns
      WHERE status IN ('approved', 'completed')
        AND invoice_id IN (SELECT id FROM sales_invoices WHERE patient_id = ?)

      UNION ALL

      SELECT 
        CASE 
          WHEN type = 'payment' THEN 'توريد نقدية'
          WHEN type = 'adjustment' AND amount < 0 THEN 'إشعار دائن (خصم)'
          WHEN type = 'adjustment' AND amount >= 0 THEN 'إشعار مدين (إضافة)'
          ELSE type 
        END as type, 
        id as doc_no, date,
        CASE
          WHEN type = 'payment' THEN -ABS(CAST(amount AS REAL))
          WHEN type = 'adjustment' THEN CAST(amount AS REAL)
          ELSE 0
        END as value,
        CASE
          WHEN type = 'payment' THEN -ABS(CAST(amount AS REAL))
          WHEN type = 'adjustment' THEN CAST(amount AS REAL)
          ELSE 0
        END as balance_effect,
        payment_method,
        notes,
        (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM patient_transactions
      WHERE patient_id = ?

      UNION ALL

      SELECT
        CASE
          WHEN fn.type = 'debit' THEN 'إشعار مدين (إضافة)'
          WHEN fn.type = 'credit' THEN 'إشعار دائن (خصم)'
          ELSE 'إشعار مالي'
        END as type,
        fn.id as doc_no,
        COALESCE(fn.date, fn.created_at) as date,
        CASE
          WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL))
          WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL))
          ELSE 0
        END as value,
        CASE
          WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL))
          WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL))
          ELSE 0
        END as balance_effect,
        'notice' as payment_method,
        TRIM(COALESCE(fn.reason, '') || CASE
          WHEN COALESCE(fn.notes, '') <> '' THEN ' - ' || fn.notes
          ELSE ''
        END) as notes,
        (SELECT full_name FROM users WHERE id = fn.user_id) as user_name
      FROM financial_notices fn
      WHERE fn.target_type = 'customer'
        AND fn.target_id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM patient_transactions mirrored
          WHERE mirrored.patient_id = fn.target_id
            AND mirrored.type = 'adjustment'
            AND ABS(CAST(mirrored.amount AS REAL) - CASE
              WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL))
              WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL))
              ELSE 0
            END) < 0.000001
            AND COALESCE(mirrored.date, '') = COALESCE(fn.date, '')
            AND COALESCE(mirrored.user_id, '') = COALESCE(fn.user_id, '')
            AND COALESCE(mirrored.notes, '') = COALESCE(fn.reason, '')
        )
      
      ORDER BY date DESC
    `).all(patientId, patientId, patientId, patientId) as any[];

    // 3. Get Items purchased by this patient
    const rawItems = await db.prepare(`
      SELECT si.invoice_id, si.created_at as date, si.drug_id, NULL as fallback_name, si.quantity_sold, si.unit, si.unit_price,
             'بيع' as action
      FROM sales_items si
      JOIN sales_invoices sinv ON si.invoice_id = sinv.id
      WHERE sinv.patient_id = ? AND sinv.status = 'completed'
      
      UNION ALL
      
      SELECT r.id as invoice_id, r.created_at as date, ri.drug_id, ri.drug_name as fallback_name, -ri.quantity_returned as quantity_sold,
             COALESCE(ri.unit, 'large') as unit, ri.unit_price, 'مرتجع' as action
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      JOIN sales_invoices sinv ON r.invoice_id = sinv.id
      WHERE sinv.patient_id = ? AND r.status IN ('approved', 'completed')
      
      ORDER BY date DESC
    `).all(patientId, patientId) as any[];

    // Use direct SQL JOIN to get drug names instead of loading full 191K cache
    const drugIdList = rawItems.filter((item: any) => item.drug_id).map((item: any) => item.drug_id);
    const drugNameMap = new Map<number, string>();
    if (drugIdList.length > 0) {
      const uniqueIds = [...new Set(drugIdList)];
      const drugRows = await db.prepare(
        `SELECT id, trade_name, trade_name_en FROM master_drugs WHERE id IN (${uniqueIds.map(() => '?').join(',')})`
      ).all(...uniqueIds) as any[];
      drugRows.forEach((r: any) => drugNameMap.set(r.id, r.trade_name_en || r.trade_name || `صنف #${r.id}`));
    }

    const items = rawItems.map((item: any) => {
      if (item.drug_id) {
        return {
          invoice_id: item.invoice_id,
          date: item.date,
          trade_name: drugNameMap.get(item.drug_id) || `صنف #${item.drug_id}`,
          quantity_sold: item.quantity_sold,
          unit: item.unit,
          unit_price: item.unit_price,
          action: item.action
        };
      } else {
        return {
          invoice_id: item.invoice_id,
          date: item.date,
          trade_name: item.fallback_name || 'صنف غير معروف',
          quantity_sold: item.quantity_sold,
          unit: item.unit,
          unit_price: item.unit_price,
          action: item.action
        };
      }
    });

    // 4. Get Financial Notices for this patient
    let notices: any[] = [];
    try {
      notices = await db.prepare(`
        SELECT fn.id, fn.type, fn.amount, fn.reason, fn.notes, fn.date, fn.created_at,
               u.full_name as user_name
        FROM financial_notices fn
        LEFT JOIN users u ON u.id = fn.user_id
        WHERE fn.target_type = 'customer' AND fn.target_id = ?
        ORDER BY fn.date DESC, fn.created_at DESC
      `).all(patientId) as any[];
    } catch (noticeErr) {
      console.warn('financial_notices query skipped in statement:', noticeErr);
    }

    // 5. Use the same balance definition as POS and checkout validation.
    const balance = await db.prepare(patientOutstandingBalanceQuery()).get(patientId) as any;
    const currentBalance = Number(balance?.outstanding_balance || 0);

    return {
      success: true,
      data: {
        patient,
        movements,
        items,
        notices,
        currentBalance
      }
    };
  } catch (error: any) {
    console.error('Statement Error:', error);
    return { success: false, error: 'فشل جلب كشف الحساب' };
  }
}

export async function updatePatientWalletAction(patientId: string, amount: number, notes?: string) {
  try {
    const user = await getLocalSession();
    if (!canManagePatients(user)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'يجب أن يكون مبلغ شحن المحفظة أكبر من صفر' };
    }

    let newBalance = 0;
    await dbTransaction(async () => {
      const patient = await db.prepare('SELECT full_name, CAST(wallet_balance AS REAL) AS wallet_balance FROM patients WHERE id = ?')
        .get(patientId) as any;
      if (!patient) throw new Error('المريض غير موجود');

      const update = await db.prepare('UPDATE patients SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?')
        .run(amount, patientId);
      if (!update.changes) throw new Error('تعذر تحديث رصيد المحفظة');

      const cashMovementId = generateId();
      const journalId = generateId();
      const date = new Date().toISOString().slice(0, 10);
      await db.prepare(`
        INSERT INTO cash_movements (id, user_id, type, category, amount, source_type, target_name, notes, date)
        VALUES (?, ?, 'receipt', 'patient_wallet', ?, 'patient_wallet', ?, ?, ?)
      `).run(cashMovementId, user.id, amount, patientId, `شحن محفظة ${patient.full_name}: ${notes || ''}`, date);

      const cashSetting = await db.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'cash_drawer' LIMIT 1").get() as any;
      const walletSetting = await db.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'patient_wallet_liability' LIMIT 1").get() as any;
      const cashAccountId = Number(cashSetting?.account_id || 6);
      const walletAccountId = Number(walletSetting?.account_id || 7);

      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, date, `شحن محفظة المريض: ${patient.full_name}`, user.id, amount);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, cashAccountId, 'debit', amount);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, walletAccountId, 'credit', amount);

      newBalance = Number(patient.wallet_balance || 0) + amount;
    });

    revalidatePath('/patients');
    revalidatePath('/pos');
    return { success: true, balance: newBalance };
  } catch (error: any) {
    return { success: false, error: error?.message || 'فشل شحن محفظة المريض' };
  }
}

export async function getPatientsAction() {
  try {
    const localUser = await getLocalSession();
    if (!canManagePatients(localUser)) return { success: false, error: 'غير مصرح' };

    const patients = await db.prepare(`
      SELECT p.*, CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p
      ORDER BY p.full_name ASC
    `).all() as any[];
    return { success: true, data: patients };
  } catch (error) {
    return { success: false, error: 'فشل جلب قائمة المرضى' };
  }
}

export async function deletePatientAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!canDeletePatients(user)) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }

    await dbTransaction(async () => {
      // ponytail: validate and delete under the same BEGIN IMMEDIATE lock.
      const linked = await db.prepare(`
        SELECT
          p.id,
          CAST(COALESCE(p.opening_balance, 0) AS REAL) AS opening_balance,
          CAST(COALESCE(p.wallet_balance, 0) AS REAL) AS wallet_balance,
          CAST(COALESCE(p.points_balance, 0) AS REAL) AS points_balance,
          (SELECT COUNT(*) FROM sales_invoices WHERE patient_id = ?) +
          (SELECT COUNT(*) FROM patient_transactions WHERE patient_id = ?) +
          (SELECT COUNT(*) FROM refill_reminders WHERE patient_id = ?) +
          (SELECT COUNT(*) FROM financial_notices WHERE target_type = 'customer' AND target_id = ?) +
          (SELECT COUNT(*) FROM cash_movements WHERE target_name = ? AND source_type IN ('patient_wallet', 'patient_payment')) AS linked_count
        FROM patients p
        WHERE p.id = ?
      `).get(patientId, patientId, patientId, patientId, patientId, patientId) as any;

      if (!linked) throw new Error('المريض غير موجود');
      if (
        (Number(linked.linked_count) || 0) > 0 ||
        Math.abs(Number(linked.opening_balance) || 0) > 0.000001 ||
        Math.abs(Number(linked.wallet_balance) || 0) > 0.000001 ||
        Math.abs(Number(linked.points_balance) || 0) > 0.000001
      ) {
        throw new Error('لا يمكن حذف مريض له فواتير أو معاملات مرتبطة');
      }

      await db.prepare('DELETE FROM patient_allergies WHERE patient_id = ?').run(patientId);
      await db.prepare('DELETE FROM patient_conditions WHERE patient_id = ?').run(patientId);
      const deleted = await db.prepare('DELETE FROM patients WHERE id = ?').run(patientId);
      if (deleted.changes !== 1) throw new Error('المريض غير موجود');
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
        .run(user.id, 'PATIENT_DELETED', JSON.stringify({ patient_id: patientId }));
    });

    revalidatePath('/patients');
    revalidatePath('/pos');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || 'فشل حذف المريض' };
  }
}

export async function getReceiptDetailsAction(invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_patients') && !hasUserPermissionSync(user, 'can_view_receipts'))) {
      return { success: false, error: 'غير مصرح' };
    }

    const inv = await db.prepare(`
      SELECT si.id, si.total_amount, si.created_at, si.payment_method,
             u.full_name as user_name, p.full_name as patient_name, p.phone as patient_phone
      FROM sales_invoices si
      LEFT JOIN users u ON si.user_id = u.id
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.id = ?
    `).get(invoiceId) as any;

    if (!inv) return { success: false, error: 'الفاتورة غير موجودة' };

    const rawItems = await db.prepare(`
      SELECT sit.quantity_sold, sit.unit_price, sit.unit, md.trade_name, md.trade_name_en
      FROM sales_items sit
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      WHERE sit.invoice_id = ?
    `).all(invoiceId) as any[];

    const sales_items = rawItems.map(item => ({
      quantity_sold: item.quantity_sold,
      unit_price: item.unit_price,
      unit: item.unit,
      trade_name: item.trade_name || 'صنف',
      trade_name_en: item.trade_name_en,
      inventory: {
        master_drugs: {
          trade_name: item.trade_name || 'صنف',
          trade_name_en: item.trade_name_en,
        }
      }
    }));

    return {
      success: true,
      data: {
        id: inv.id,
        total_amount: inv.total_amount,
        created_at: inv.created_at,
        payment_method: inv.payment_method,
        profiles: { full_name: inv.user_name || 'المستخدم' },
        patients: inv.patient_name ? { full_name: inv.patient_name, phone: inv.patient_phone || '' } : null,
        sales_items
      }
    };
  } catch (error: any) {
    return { success: false, error: 'فشل جلب تفاصيل الفاتورة' };
  }
}
