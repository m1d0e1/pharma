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



import { z } from 'zod';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

import { getLocalSession } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';

const patientSchema = z.object({
  full_name: z.string().min(3, 'الاسم يجب أن يكون 3 أحرف على الأقل'),
  name_en: z.string().optional().nullable(),
  phone: z.string().regex(/^01[0-9]{9}$/, 'رقم الهاتف يجب أن يكون رقم مصري صحيح (01xxxxxxxxx)'),
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
  wallet_balance: z.number().default(0),
  loyalty_level: z.enum(['bronze', 'silver', 'gold', 'platinum']).default('bronze'),
  customer_type: z.string().default('individual'),
  payment_method: z.string().default('cash'),
  notes: z.string().optional().nullable(),
});

export type AddPatientInput = z.infer<typeof patientSchema>;

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
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser) {
      return { success: false, error: 'غير مصرح. يرجى تسجيل الدخول محلياً.' };
    }

    const data = validationResult.data;
    const id = generateId();

    // 3. Insert the patient locally
    await db.prepare(`
      INSERT INTO patients (
        id, full_name, name_en, phone, mobile, address, area, birth_date, 
        gender, insurance_number, car_number, credit_limit, opening_balance, 
        points_balance, point_value, customer_type, payment_method, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.full_name, data.name_en || null, data.phone, data.mobile || null,
      data.address || null, data.area || null, data.birth_date || null,
      data.gender || null, data.insurance_number || null, data.car_number || null,
      data.credit_limit, data.opening_balance, data.points_balance,
      data.point_value, data.customer_type, data.payment_method, data.notes || null
    );

    // 4. Revalidate pages
    revalidatePath('/patients');
    revalidatePath('/pos');

    return { success: true };
  } catch (error: any) {
    console.error('Local Patient Error:', error);
    return {
      success: false,
      error: 'حدث خطأ أثناء إضافة المريض محلياً.',
    };
  }
}

export async function searchPatientsAction(query: string) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'Unauthorized' };

    if (!query || query.length < 2) return { success: true, data: [] };
    
    const searchPattern = `%${query}%`;
    const patients = await db.prepare(`
      SELECT id, full_name, phone
      FROM patients
      WHERE (full_name LIKE ? OR phone LIKE ?)
      LIMIT 5
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
    if (!user) return { success: false, error: 'غير مصرح' };

    const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'المريض غير موجود' };

    const allergies = await db.prepare('SELECT * FROM patient_allergies WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
    const conditions = await db.prepare('SELECT * FROM patient_conditions WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
    
    const purchaseHistory = await db.prepare(`
      SELECT si.id as invoice_id, si.total_amount, si.created_at
      FROM sales_invoices si
      WHERE si.patient_id = ?
      ORDER BY si.created_at DESC
      LIMIT 50
    `).all(patientId) as any[];

    if (purchaseHistory.length > 0) {
      const invoiceIds = purchaseHistory.map(h => `'${h.invoice_id}'`).join(',');
      // JOIN master_drugs directly to get trade names (avoids loading 191K cache)
      const items = await db.prepare(`
        SELECT sit.invoice_id, sit.drug_id,
               m.trade_name_en, m.trade_name
        FROM sales_items sit
        JOIN master_drugs m ON sit.drug_id = m.id
        WHERE sit.invoice_id IN (${invoiceIds})
      `).all() as any[];

      purchaseHistory.forEach(inv => {
        const invItems = items.filter(item => item.invoice_id === inv.invoice_id);
        inv.drugs = invItems.map(item => item.trade_name_en || item.trade_name).filter(Boolean).join('، ');
      });
    }

    const totalSpent = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total 
      FROM sales_invoices WHERE patient_id = ?
    `).get(patientId) as any;

    return {
      success: true,
      data: {
        ...patient,
        allergies,
        conditions,
        purchaseHistory,
        totalSpent: totalSpent?.total || 0,
        visitCount: (purchaseHistory as any[]).length,
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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
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
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser) {
      return { success: false, error: 'غير مصرح. يرجى تسجيل الدخول محلياً.' };
    }

    const { 
      full_name, name_en, phone, address, birth_date, 
      gender, insurance_number, credit_limit, points_balance, 
      wallet_balance, loyalty_level,
      customer_type, notes 
    } = validationResult.data;

    // 3. Update the patient locally
    await db.prepare(`
      UPDATE patients 
      SET 
        full_name = ?, name_en = ?, phone = ?, address = ?, 
        birth_date = ?, gender = ?, insurance_number = ?, 
        credit_limit = ?, points_balance = ?, 
        wallet_balance = ?, loyalty_level = ?,
        customer_type = ?, notes = ?
      WHERE id = ?
    `).run(
      full_name, name_en || null, phone, address || null, 
      birth_date || null, gender || null, insurance_number || null, 
      credit_limit, points_balance, 
      wallet_balance, loyalty_level,
      customer_type, notes || null,
      id
    );

    // 4. Revalidate pages
    revalidatePath('/patients');
    revalidatePath('/pos');

    return { success: true };
  } catch (error: any) {
    console.error('Update Patient Error:', error);
    return {
      success: false,
      error: 'حدث خطأ أثناء تحديث بيانات المريض.',
    };
  }
}

export async function getPatientStatementAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    // 1. Get Patient Details
    const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'العميل غير موجود' };

    // 2. Get Movements (Sales and Returns)
    const movements = await db.prepare(`
      SELECT 'فاتورة بيع' as type, id as doc_no, created_at as date, total_amount as value, payment_method, 
             (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM sales_invoices
      WHERE patient_id = ?
      
      UNION ALL
      
      SELECT 'مرتجع بيع' as type, id as doc_no, created_at as date, -total_refund as value, refund_method as payment_method,
             (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM returns
      WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE patient_id = ?)

      UNION ALL

      SELECT 
        CASE 
          WHEN type = 'payment' THEN 'توريد نقدية'
          WHEN type = 'adjustment' THEN 'إشعار'
          ELSE type 
        END as type, 
        id as doc_no, date, -amount as value, payment_method,
        (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM patient_transactions
      WHERE patient_id = ?
      
      ORDER BY date DESC
    `).all(patientId, patientId, patientId) as any[];

    // 3. Get Items purchased by this patient
    const rawItems = await db.prepare(`
      SELECT si.invoice_id, si.created_at as date, si.drug_id, NULL as fallback_name, si.quantity_sold, si.unit, si.unit_price,
             'بيع' as action
      FROM sales_items si
      JOIN sales_invoices sinv ON si.invoice_id = sinv.id
      WHERE sinv.patient_id = ?
      
      UNION ALL
      
      SELECT r.id as invoice_id, r.created_at as date, NULL as drug_id, ri.drug_name as fallback_name, -ri.quantity_returned as quantity_sold, 
             'وحدة' as unit, ri.unit_price, 'مرتجع' as action
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      JOIN sales_invoices sinv ON r.invoice_id = sinv.id
      WHERE sinv.patient_id = ?
      
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

    // 4. Calculate Current Balance (Opening + Sum of all movements)
    // We treat 'فاتورة بيع' as positive (increase debt), 'مرتجع بيع' as negative, and transactions as already signed in the query
    // Actually, it's easier to just sum the movements if we adjust signs
    const totalMovements = movements.reduce((acc, mov) => {
      // For credit invoices, value is positive (debt)
      // For payments, value is negative in the query above (reduces debt)
      // For returns, value is negative (reduces debt)
      return acc + (mov.payment_method === 'credit' || mov.type === 'توريد نقدية' || mov.type === 'إشعار' || mov.type === 'مرتجع بيع' ? mov.value : 0);
    }, 0);
    const currentBalance = (patient.opening_balance || 0) + totalMovements;

    return { 
      success: true, 
      data: {
        patient,
        movements,
        items,
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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user) return { success: false, error: 'Unauthorized' };

    await db.prepare('UPDATE patients SET wallet_balance = wallet_balance + ? WHERE id = ?').run(amount, patientId);
    
    // Log as a transaction for statements
    await db.prepare(`
      INSERT INTO cash_movements (id, user_id, type, category, amount, notes, date)
      VALUES (?, ?, 'receipt', 'patient_wallet', ?, ?, date('now'))
    `).run(generateId(), user.id, Math.abs(amount), `شحن محفظة: ${notes || ''}`);

    revalidatePath('/patients');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getPatientsAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const patients = await db.prepare('SELECT * FROM patients ORDER BY full_name ASC').all() as any[];
    return { success: true, data: patients };
  } catch (error) {
    return { success: false, error: 'فشل جلب قائمة المرضى' };
  }
}
