
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';

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



import { z } from 'zod';
import { format } from 'date-fns';

const revalidatePath = (...args: any[]) => {};

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';
import {
  patientOutstandingBalanceExpression,
  patientOutstandingBalanceQuery,
} from '@/lib/patients/balance';
import { requireOpenShiftId } from './finance';

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
  // System-owned loyalty debt can make this negative after returning a sale
  // whose earned points were already spent. Add/update actions never write it.
  points_balance: z.number().default(0),
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
  return !!user && hasUserPermissionSync(user, 'can_delete_patients');
}

function canSearchPatientsForPos(user: any): boolean {
  return canManagePatients(user) || (!!user && hasUserPermissionSync(user, 'can_access_pos'));
}

const PATIENT_OWNERSHIP_ERROR = 'Legacy patient ownership needs independent tenant verification';

function patientTenant(user: any): string | null {
  const pharmacyId = typeof user?.pharmacy_id === 'string' ? user.pharmacy_id.trim() : '';
  return pharmacyId && pharmacyId !== 'local_default' ? pharmacyId : null;
}

// The patient table itself is global and has no pharmacy column. Only a
// prospective native creation witness can establish independent ownership.
// Global patient transactions/notices and other-branch sales make balances
// ambiguous, so exclude those records until a scoped ledger can prove them.
function ownedPatientSql(alias = 'p'): string {
  return `EXISTS (SELECT 1 FROM native_patient_directory_ownership owner
                 WHERE owner.patient_id = ${alias}.id AND owner.pharmacy_id = ?)
    AND NOT EXISTS (SELECT 1 FROM sales_invoices other
       WHERE other.patient_id = ${alias}.id
         AND COALESCE(NULLIF(TRIM(other.pharmacy_id),''),'local_default') <> ?)
    AND NOT EXISTS (SELECT 1 FROM patient_transactions pt WHERE pt.patient_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM financial_notices fn
       WHERE fn.target_type='customer' AND fn.target_id = ${alias}.id)`;
}

async function ownedPatientExists(patientId: string, pharmacyId: string): Promise<boolean> {
  const owned = await db.prepare(`SELECT 1 AS owned FROM patients p
    WHERE p.id = ? AND ${ownedPatientSql('p')} LIMIT 1`)
    .get(patientId, pharmacyId, pharmacyId) as any;
  return Boolean(owned);
}

async function assertPatientFinancialProvenance(pharmacyId: string, patientId?: string): Promise<void> {
  const uncertain = await db.prepare(`SELECT 1 AS uncertain
    FROM native_patient_directory_ownership owned
    WHERE owned.pharmacy_id = ?
      AND (? IS NULL OR owned.patient_id = ?)
      AND (
        EXISTS (SELECT 1 FROM sales_invoices si WHERE si.patient_id = owned.patient_id
          AND COALESCE(NULLIF(TRIM(si.pharmacy_id), ''),'local_default') <> ?)
        OR EXISTS (SELECT 1 FROM patient_transactions pt WHERE pt.patient_id = owned.patient_id)
        OR EXISTS (SELECT 1 FROM financial_notices fn WHERE fn.target_type='customer'
          AND fn.target_id = owned.patient_id)
      ) LIMIT 1`)
    .get(pharmacyId, patientId ?? null, patientId ?? null, pharmacyId);
  if (uncertain) throw new Error('Owned patient financial provenance is incomplete');
}

async function nativePatientRead(
  queryId: 'patients.directory' | 'patients.pos_search' | 'patients.pos_get' | 'patients.profile',
  options: { recordId?: string; search?: string; limit?: number } = {},
): Promise<any[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const rows: any[] = [];
  const pageSize = options.limit ?? 200;
  for (let offset = 0; offset <= 50_000; offset += pageSize) {
    const page = await invoke<any[]>('db_read_scoped', {
      queryId,
      recordId: options.recordId ?? null,
      search: options.search ?? null,
      drugId: null,
      limit: pageSize,
      offset,
    });
    if (!Array.isArray(page) || page.length > pageSize
      || page.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Invalid native patient read response');
    }
    rows.push(...page);
    if (page.length < pageSize || options.recordId) return rows;
  }
  throw new Error('Native patient directory exceeds bounded paging capacity');
}

/**
 * Server Action to add a new patient (Local Enforcer)
 */
export async function addPatientAction(formData: AddPatientInput & { request_id?: string }, requestId?: string) {
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
    const pharmacyId = patientTenant(localUser);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };

    const data = validationResult.data;
    const id = requestId || formData.request_id || generateId();
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(id)) {
      return { success: false, error: 'معرف طلب إنشاء المريض غير صالح' };
    }
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const receipt = await invoke<{ id: string }>('create_patient_owned_native', {
          payload: {
            requestId: id,
            fullName: data.full_name,
            nameEn: data.name_en || null,
            phone: data.phone || null,
            mobile: data.mobile || null,
            address: data.address || null,
            area: data.area || null,
            birthDate: data.birth_date || null,
            gender: data.gender || null,
            insuranceNumber: data.insurance_number || null,
            carNumber: data.car_number || null,
            creditLimit: data.credit_limit,
            openingBalance: data.opening_balance,
            pointValue: data.point_value,
            customerType: data.customer_type,
            paymentMethod: data.payment_method,
            notes: data.notes || null,
          },
        });
        if (!receipt || receipt.id !== id) throw new Error('Native patient creation receipt mismatch');
        revalidatePath('/patients');
        revalidatePath('/pos');
        return { success: true, id };
      } catch {
        return { success: false, error: 'تعذر إنشاء المريض مع إثبات ملكية الصيدلية' };
      }
    }

    // Browser fallback must not create globally unowned patient records.
    return { success: false, error: 'إنشاء المرضى يتطلب التحقق الأصلي من ملكية الصيدلية' };
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
    const pharmacyId = patientTenant(localUser);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };

    if (!fetchAll && (!query || query.length < 2)) return { success: true, data: [] };
    if (isTauri) {
      try {
        const patients = await nativePatientRead('patients.pos_search', {
          search: fetchAll ? undefined : query,
        });
        return { success: true, data: fetchAll ? patients.slice(0, 100) : patients.slice(0, 25) };
      } catch {
        return { success: false, error: 'تعذر إثبات ملكية سجلات المرضى' };
      }
    }
    await assertPatientFinancialProvenance(pharmacyId);

    if (fetchAll || !query || query.trim() === '') {
      const patients = await db.prepare(`
        SELECT p.id, p.full_name, p.phone, p.credit_limit, p.wallet_balance, p.opening_balance, p.payment_method,
               CAST(COALESCE(p.points_balance, 0) AS REAL) AS points_balance,
               CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
        FROM patients p
        WHERE ${ownedPatientSql('p')}
        ORDER BY p.full_name ASC
        LIMIT 100
      `).all(pharmacyId, pharmacyId) as any[];
      return { success: true, data: patients };
    }

    const searchPattern = `%${query}%`;
    const patients = await db.prepare(`
      SELECT p.id, p.full_name, p.phone, p.credit_limit, p.wallet_balance, p.opening_balance, p.payment_method,
             CAST(COALESCE(p.points_balance, 0) AS REAL) AS points_balance,
             CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p
      WHERE ${ownedPatientSql('p')}
        AND (p.full_name LIKE ? OR p.phone LIKE ?)
      ORDER BY p.full_name ASC
      LIMIT 25
    `).all(pharmacyId, pharmacyId, searchPattern, searchPattern) as any[];
    
    return { success: true, data: patients };
  } catch (error) {
    console.error('Patient search error:', error);
    return { success: false, error: 'فشل البحث في قاعدة البيانات المحلية' };
  }
}

/**
 * Read the checkout-safe patient fields needed by POS.
 *
 * POS access is intentionally sufficient here even when the user cannot open
 * the full patient profile. This keeps persisted/draft POS selections fresh
 * without exposing medical history or branch-scoped patient documents.
 */
export async function getPatientForPosAction(patientId: string) {
  try {
    const localUser = await getLocalSession();
    if (!canSearchPatientsForPos(localUser)) return { success: false, error: 'Unauthorized' };
    const pharmacyId = patientTenant(localUser);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    if (isTauri) {
      try {
        const result = await nativePatientRead('patients.pos_get', { recordId: patientId, limit: 1 });
        return result.length === 1
          ? { success: true, data: result[0] }
          : { success: false, error: 'المريض غير موجود أو لا يمكن إثبات ملكيته' };
      } catch {
        return { success: false, error: 'تعذر إثبات ملكية ملف المريض' };
      }
    }
    await assertPatientFinancialProvenance(pharmacyId, patientId);

    const patient = await db.prepare(`
      SELECT p.id, p.full_name, p.phone, p.credit_limit, p.wallet_balance, p.opening_balance, p.payment_method,
             CAST(COALESCE(p.points_balance, 0) AS REAL) AS points_balance,
             CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p
      WHERE p.id = ? AND ${ownedPatientSql('p')}
      LIMIT 1
    `).get(patientId, pharmacyId, pharmacyId) as any;

    if (!patient) return { success: false, error: 'المريض غير موجود' };
    return { success: true, data: patient };
  } catch (error) {
    console.error('Patient POS lookup error:', error);
    return { success: false, error: 'فشل تحميل بيانات المريض' };
  }
}

/**
 * Get full patient profile with allergies, conditions, and purchase history
 */
export async function getPatientProfileAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!canManagePatients(user)) return { success: false, error: 'غير مصرح' };
    const pharmacyId = patientTenant(user);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    if (isTauri) {
      try {
        const rows = await nativePatientRead('patients.profile', { recordId: patientId, limit: 1 });
        if (rows.length !== 1 || rows[0]?.id !== patientId ||
            typeof rows[0].full_name !== 'string' || !rows[0].full_name.trim()) {
          return { success: false, error: 'المريض غير موجود أو لا يمكن إثبات ملكيته' };
        }
        // patients.profile is tenant-witnessed by 061 but has no authenticated
        // complete medical or finance history. Show only owned identity fields;
        // never infer the wallet, debt or old clinical record from p.*.
        const { id, full_name, name_en, phone, mobile, address, area, birth_date,
          gender, insurance_number, car_number, credit_limit, customer_type,
          payment_method, notes } = rows[0];
        return { success: true, data: {
          id, full_name, name_en, phone, mobile, address, area, birth_date,
          gender, insurance_number, car_number,
          credit_limit: typeof credit_limit === 'number' && Number.isFinite(credit_limit) && credit_limit >= 0 ? credit_limit : null,
          customer_type, payment_method, notes,
          wallet_balance: null, opening_balance: null, points_balance: null,
          outstandingBalance: null, availableCredit: null,
          profileScope: 'owned_basics_only',
        } };
      } catch {
        return { success: false, error: 'تعذر إثبات ملكية ملف المريض' };
      }
    }
    await assertPatientFinancialProvenance(pharmacyId, patientId);

    const patient = await db.prepare(`SELECT p.* FROM patients p
      WHERE p.id = ? AND ${ownedPatientSql('p')}`)
      .get(patientId, pharmacyId, pharmacyId) as any;
    if (!patient) return { success: false, error: 'المريض غير موجود' };

    const allergies = await db.prepare('SELECT * FROM patient_allergies WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
    const conditions = await db.prepare('SELECT * FROM patient_conditions WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
    
    const purchaseHistory = await db.prepare(`
      SELECT si.id as invoice_id, si.total_amount, si.payment_method, si.created_at
      FROM sales_invoices si
      WHERE si.patient_id = ? AND (si.status IS NULL OR si.status = '' OR LOWER(si.status) IN ('completed', 'approved', 'delivered'))
        AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY si.created_at DESC
      LIMIT 50
    `).all(patientId, pharmacyId, pharmacyId) as any[];

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
      FROM sales_invoices
      WHERE patient_id = ? AND (status IS NULL OR status = '' OR LOWER(status) IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(patientId, pharmacyId, pharmacyId) as any;

    const payments = await db.prepare(`
      SELECT pt.*, u.full_name AS user_name
      FROM patient_transactions pt
      LEFT JOIN users u ON u.id = pt.user_id
      WHERE pt.patient_id = ? AND pt.type IN ('payment', 'refund')
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
    const pharmacyId = patientTenant(user);
    if (!pharmacyId || isTauri || !await ownedPatientExists(data.patient_id, pharmacyId)) {
      return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    }

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
    const pharmacyId = patientTenant(user);
    if (!pharmacyId || isTauri || !await ownedPatientExists(data.patient_id, pharmacyId)) {
      return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    }

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
    const pharmacyId = patientTenant(user);
    if (!pharmacyId || isTauri) return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    const owned = await db.prepare(`SELECT 1 FROM patient_allergies allergy
       JOIN patients p ON p.id=allergy.patient_id
       WHERE allergy.id=? AND ${ownedPatientSql('p')}`).get(id, pharmacyId, pharmacyId);
    if (!owned) return { success: false, error: PATIENT_OWNERSHIP_ERROR };

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
    const pharmacyId = patientTenant(localUser);
    if (!pharmacyId || isTauri || !await ownedPatientExists(id, pharmacyId)) {
      return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    }

    const {
      full_name, name_en, phone, mobile, address, area, birth_date,
      gender, insurance_number, car_number, credit_limit,
      point_value, customer_type, payment_method, notes, opening_balance
    } = validationResult.data;

    // Opening balance is an accounted opening entry, not editable patient
    // metadata.  Changing it silently would desynchronise A/R from its journal;
    // later balance changes must use a debit/credit notice instead.
    await dbTransaction(async (db) => {
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
          credit_limit = ?, point_value = ?,
          customer_type = ?, payment_method = ?, notes = ?
        WHERE id = ?
      `).run(
        full_name, name_en || null, phone || null, mobile || null, address || null, area || null,
        birth_date || null, gender || null, insurance_number || null, car_number || null,
        credit_limit, point_value,
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
    const pharmacyId = patientTenant(user);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };

    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    const allowed = hasUserPermissionSync(user, 'can_view_patients') ||
      hasUserPermissionSync(user, 'can_access_pos');
    if (!allowed) return { success: false, error: 'ليس لديك صلاحية عرض كشف الحساب' };
    if (typeof patientId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(patientId)) {
      return { success: false, error: 'معرف المريض غير صالح' };
    }
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const native = await invoke<any>('read_patient_statement_native', { patientId });
        if (!native || Array.isArray(native) || typeof native !== 'object' ||
          native.scope !== 'verified_subset' ||
          !native.patient || native.patient.id !== patientId ||
          typeof native.patient.full_name !== 'string' ||
          native.patient.opening_balance !== null || native.currentBalance !== null ||
          !Array.isArray(native.movements) || native.movements.length > 200 ||
          !Array.isArray(native.unsupported_categories) || native.unsupported_categories.length === 0 ||
          !Array.isArray(native.items) || native.items.length !== 0 ||
          !Array.isArray(native.notices) || native.notices.length !== 0 ||
          native.movements.some((movement: any) =>
            !movement || typeof movement.doc_no !== 'string' || !movement.doc_no ||
            typeof movement.date !== 'string' || !movement.date ||
            typeof movement.value !== 'number' || !Number.isFinite(movement.value) ||
            movement.balance_effect !== null ||
            !['فاتورة بيع', 'مرتجع بيع', 'شحن محفظة'].includes(movement.type))) {
          throw new Error('Native patient statement projection is invalid');
        }
        return { success: true, data: native };
      } catch {
        return { success: false, error: 'تعذر التحقق من مصادر كشف حساب المريض أو ملكيته' };
      }
    }
    if (!await ownedPatientExists(patientId, pharmacyId)) {
      return { success: false, error: 'تعذر إثبات ملكية كشف حساب المريض' };
    }

    // 1. Get Patient Details
    const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'العميل غير موجود' };

    // 2. Get all documents, with a separate effect on accounts receivable.
    const rawMovements = await db.prepare(`
      SELECT 'فاتورة بيع' as type, id as doc_no, created_at as occurred_at,
             CAST(total_amount AS REAL) as value,
             CASE WHEN payment_method = 'credit' THEN CAST(total_amount AS REAL) ELSE 0 END as balance_effect,
             payment_method,
             NULL as notes,
             (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM sales_invoices
      WHERE patient_id = ? AND (status IS NULL OR status = '' OR LOWER(status) IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      
      UNION ALL
      
      SELECT 'مرتجع بيع' as type, id as doc_no, created_at as occurred_at,
             -CAST(total_refund AS REAL) as value,
             CASE WHEN refund_method = 'patient_account' THEN -CAST(total_refund AS REAL) ELSE 0 END as balance_effect,
             refund_method as payment_method,
             reason as notes,
             (SELECT full_name FROM users WHERE id = user_id) as user_name
      FROM returns r
      WHERE LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        AND (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))
        AND r.invoice_id IN (
          SELECT id FROM sales_invoices
          WHERE patient_id = ?
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        )

      UNION ALL

      SELECT 
        CASE 
          WHEN pt.type = 'payment' THEN 'توريد نقدية'
          WHEN pt.type = 'adjustment' AND pt.amount < 0 THEN 'إشعار دائن (خصم)'
          WHEN pt.type = 'adjustment' AND pt.amount >= 0 THEN 'إشعار مدين (إضافة)'
          ELSE pt.type
        END as type, 
        pt.id as doc_no, pt.date as occurred_at,
        CASE
          WHEN pt.type = 'payment' THEN -ABS(CAST(pt.amount AS REAL))
          WHEN pt.type = 'adjustment' THEN CAST(pt.amount AS REAL)
          ELSE 0
        END as value,
        CASE
          WHEN pt.type = 'payment' THEN -ABS(CAST(pt.amount AS REAL))
          WHEN pt.type = 'adjustment' THEN CAST(pt.amount AS REAL)
          ELSE 0
        END as balance_effect,
        pt.payment_method,
        COALESCE((
          SELECT TRIM(COALESCE(fn.reason, '') || CASE
            WHEN COALESCE(fn.notes, '') <> '' THEN ' - ' || fn.notes
            ELSE ''
          END)
          FROM financial_notices fn
          WHERE pt.type = 'adjustment'
            AND fn.target_type = 'customer'
            AND fn.target_id = pt.patient_id
            AND (fn.pharmacy_id = ? OR (fn.pharmacy_id IS NULL AND ? = 'local_default'))
            AND ABS(CAST(pt.amount AS REAL) - CASE WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL)) ELSE -ABS(CAST(fn.amount AS REAL)) END) < 0.000001
            AND COALESCE(pt.date, '') = COALESCE(fn.date, '')
            AND COALESCE(pt.user_id, '') = COALESCE(fn.user_id, '')
            AND COALESCE(pt.notes, '') = COALESCE(fn.reason, '')
          LIMIT 1
        ), pt.notes) as notes,
        (SELECT full_name FROM users WHERE id = pt.user_id) as user_name
      FROM patient_transactions pt
      WHERE pt.patient_id = ? AND pt.type != 'refund'

      UNION ALL

      SELECT
        CASE
          WHEN fn.type = 'debit' THEN 'إشعار مدين (إضافة)'
          WHEN fn.type = 'credit' THEN 'إشعار دائن (خصم)'
          ELSE 'إشعار مالي'
        END as type,
        fn.id as doc_no,
        COALESCE(fn.date, fn.created_at) as occurred_at,
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
        AND (fn.pharmacy_id = ? OR (fn.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (
          SELECT COUNT(*)
          FROM financial_notices ranked_notice
          WHERE ranked_notice.target_type = 'customer'
            AND ranked_notice.target_id = fn.target_id
            AND ranked_notice.type = fn.type
            AND ABS(CAST(ranked_notice.amount AS REAL) - CAST(fn.amount AS REAL)) < 0.000001
            AND COALESCE(ranked_notice.date, '') = COALESCE(fn.date, '')
            AND COALESCE(ranked_notice.user_id, '') = COALESCE(fn.user_id, '')
            AND COALESCE(ranked_notice.reason, '') = COALESCE(fn.reason, '')
            AND ranked_notice.rowid <= fn.rowid
        ) > (
          SELECT COUNT(*)
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
      
      ORDER BY occurred_at DESC
    `).all(
      patientId, pharmacyId, pharmacyId,
      pharmacyId, pharmacyId, patientId, pharmacyId, pharmacyId,
      pharmacyId, pharmacyId, patientId,
      patientId, pharmacyId, pharmacyId,
    ) as any[];
    const movements = rawMovements.map(({ occurred_at, ...movement }: any) => ({
      ...movement,
      date: occurred_at,
    }));

    // 3. Get Items purchased by this patient
    const rawItems = await db.prepare(`
      SELECT si.invoice_id, si.created_at as occurred_at, si.drug_id,
             COALESCE(NULLIF(md.trade_name_en, ''), NULLIF(md.trade_name, ''), 'صنف #' || si.drug_id) as trade_name,
             si.quantity_sold, si.unit, si.unit_price, 'بيع' as action
      FROM sales_items si
      JOIN sales_invoices sinv ON si.invoice_id = sinv.id
      LEFT JOIN master_drugs md ON md.id = si.drug_id
      WHERE sinv.patient_id = ? AND (sinv.status IS NULL OR sinv.status = '' OR LOWER(sinv.status) IN ('completed', 'approved', 'delivered'))
        AND (sinv.pharmacy_id = ? OR (sinv.pharmacy_id IS NULL AND ? = 'local_default'))
      
      UNION ALL
      
      SELECT r.id as invoice_id, r.created_at as occurred_at, ri.drug_id,
             COALESCE(NULLIF(md.trade_name_en, ''), NULLIF(md.trade_name, ''), NULLIF(ri.drug_name, ''), 'صنف #' || ri.drug_id, 'صنف غير معروف') as trade_name,
             -ri.quantity_returned as quantity_sold, COALESCE(ri.unit, 'large') as unit, ri.unit_price, 'مرتجع' as action
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      JOIN sales_invoices sinv ON r.invoice_id = sinv.id
      LEFT JOIN master_drugs md ON md.id = ri.drug_id
      WHERE sinv.patient_id = ? AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        AND (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))
        AND (sinv.pharmacy_id = ? OR (sinv.pharmacy_id IS NULL AND ? = 'local_default'))
      
      ORDER BY occurred_at DESC
    `).all(
      patientId, pharmacyId, pharmacyId,
      patientId, pharmacyId, pharmacyId, pharmacyId, pharmacyId,
    ) as any[];

    const items = rawItems.map((item: any) => ({
      invoice_id: item.invoice_id,
      date: item.occurred_at,
      trade_name: item.trade_name || (item.drug_id ? `صنف #${item.drug_id}` : 'صنف غير معروف'),
      quantity_sold: item.quantity_sold,
      unit: item.unit,
      unit_price: item.unit_price,
      action: item.action,
    }));

    // 4. Get Financial Notices for this patient
    let notices: any[] = [];
    try {
      notices = await db.prepare(`
        SELECT fn.id, fn.type, fn.amount, fn.reason, fn.notes, fn.date, fn.created_at,
               u.full_name as user_name
        FROM financial_notices fn
        LEFT JOIN users u ON u.id = fn.user_id
        WHERE fn.target_type = 'customer' AND fn.target_id = ?
          AND (fn.pharmacy_id = ? OR (fn.pharmacy_id IS NULL AND ? = 'local_default'))
        ORDER BY fn.date DESC, fn.created_at DESC
      `).all(patientId, pharmacyId, pharmacyId) as any[];
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

// This is a NON-AUTHORITATIVE, opaque renderer recovery hint, not a wallet
// balance or a patient/actor/tenant ownership claim. A single unresolved wallet
// intent blocks all new top-ups in this renderer profile until its ORIGINAL
// request is confirmed by the authenticated native read-only command.
// Store no patient identifier, patient name, staff identifier or tenant name.
const NATIVE_WALLET_PENDING_KEY = 'pharma.patient.wallet.pending.v1';
const NATIVE_WALLET_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type PendingWalletTopUp = {
  version: 1;
  requestId: string;
  scopeSha256: string;
  amountCents: number;
};
let walletTopUpInFlight = false;

function nativeWalletStorage(): Storage {
  // Access to localStorage itself may throw when browser storage is disabled.
  // A volatile nonce is not adequate proof of an unacknowledged cash payment.
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('Wallet recovery storage unavailable; no cash top-up was attempted');
  }
  return globalThis.localStorage;
}

function storedWalletIntent(): PendingWalletTopUp | null {
  const raw = nativeWalletStorage().getItem(NATIVE_WALLET_PENDING_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('Stored wallet cash intent is invalid; reconcile the original receipt manually');
  }
  const value = parsed as Partial<PendingWalletTopUp> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'amountCents,requestId,scopeSha256,version' ||
      value.version !== 1 || typeof value.requestId !== 'string' ||
      !NATIVE_WALLET_UUID_V4.test(value.requestId) ||
      typeof value.scopeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.scopeSha256) ||
      !Number.isSafeInteger(value.amountCents) || (value.amountCents as number) <= 0) {
    throw new Error('Stored wallet cash intent is invalid; reconcile the original receipt manually');
  }
  return value as PendingWalletTopUp;
}

async function walletIntentScope(
  actor: string, pharmacy: string, patientId: string, cents: number,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure wallet intent recovery is unavailable; no cash top-up was attempted');
  }
  const bytes = new TextEncoder().encode(JSON.stringify([actor, pharmacy, patientId, cents]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function saveWalletIntent(value: PendingWalletTopUp): void {
  const storage = nativeWalletStorage();
  if (storedWalletIntent()) {
    throw new Error('Unresolved wallet cash intent exists; verify the original receipt first');
  }
  storage.setItem(NATIVE_WALLET_PENDING_KEY, JSON.stringify(value));
  const saved = storedWalletIntent();
  if (saved?.requestId !== value.requestId || saved.scopeSha256 !== value.scopeSha256 ||
      saved.amountCents !== value.amountCents) {
    throw new Error('Wallet cash intent could not be durably saved; no top-up was attempted');
  }
}

function clearWalletIntent(value: PendingWalletTopUp): void {
  // Once the real native writer/reader has confirmed a receipt, a failed
  // cleanup leaves the original nonce for read-only recovery on next reload.
  try {
    if (storedWalletIntent()?.requestId === value.requestId) {
      nativeWalletStorage().removeItem(NATIVE_WALLET_PENDING_KEY);
    }
  } catch { /* independently verified receipt is already final */ }
}

export async function updatePatientWalletAction(patientId: string, amount: number, notes?: string, requestId?: string) {
  try {
    if (isTauri) {
      // Patient identities are historically global. Only the native command
      // can certify tenant-owned sales, reconcile wallet provenance, and post
      // the cash receipt, wallet liability and balance atomically.
      if (walletTopUpInFlight) {
        throw new Error('Wallet cash intent is already being verified; no second top-up was attempted');
      }
      walletTopUpInFlight = true;
      try {
      const cents = Math.round(amount * 100);
      if (typeof patientId !== 'string' || !patientId.trim() || patientId.length > 128 ||
          !Number.isFinite(amount) || amount <= 0 || amount > 1e12 ||
          !Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 0.0000001) {
        throw new Error('Invalid native wallet top-up amount or patient');
      }
      // Reauthenticate against the NATIVE session, not cached localStorage
      // identity. This is an early UI guard; native writer/read reauthorize too.
      const nativeActor = await getLocalSession();
      const actor = String(nativeActor?.id ?? '');
      const pharmacy = String(nativeActor?.pharmacy_id ?? '');
      if (!actor || !pharmacy || pharmacy === 'local_default' ||
          !canManagePatients(nativeActor) ||
          !hasUserPermissionSync(nativeActor, 'acc_can_process_cash_flow')) {
        throw new Error('Native wallet cash permission or tenant authentication required');
      }
      const scopeSha256 = await walletIntentScope(actor, pharmacy, patientId, cents);
      const pending = storedWalletIntent();
      if (pending && (pending.scopeSha256 !== scopeSha256 || pending.amountCents !== cents)) {
        throw new Error('Different actor, pharmacy, patient or amount has unresolved wallet cash; verify original receipt');
      }
      const id = pending?.requestId ?? requestId ?? generateId();
      if (!NATIVE_WALLET_UUID_V4.test(id)) {
        throw new Error('Wallet top-up requires a canonical original UUIDv4 request ID');
      }
      const intent: PendingWalletTopUp = pending ?? { version: 1, requestId: id, scopeSha256, amountCents: cents };
      const payload = { patientId, amount, notes: notes || null, requestId: intent.requestId };
      type WalletReceipt = { id: string; balance: number };
      type WalletConfirmation = WalletReceipt & {
        patientId: string; actorId: string; pharmacyId: string; amountCents: number;
      };
      const validWrite = (value: WalletReceipt | null): value is WalletReceipt =>
        value?.id === intent.requestId && Number.isFinite(value.balance) && value.balance >= 0;
      const validConfirmation = (value: WalletConfirmation | null): value is WalletConfirmation =>
        validWrite(value) && value.patientId === patientId &&
        value.actorId === actor && value.pharmacyId === pharmacy && value.amountCents === cents;
      const { invoke } = await import('@tauri-apps/api/core');
      if (pending) {
        // This may already have committed before a reload. Confirm the ORIGINAL
        // nonce, actor, tenant, patient and exact cents FIRST. A null/malformed
        // reply never licenses a new financial write or a new request nonce.
        let existing: WalletConfirmation | null;
        try {
          existing = await invoke<WalletConfirmation | null>('confirm_patient_wallet_top_up_native', { payload });
        } catch {
          throw new Error('Original wallet cash receipt could not be confirmed; no new top-up was attempted');
        }
        if (!validConfirmation(existing)) {
          throw new Error('Original wallet cash receipt remains unverified; do not repost or change the request ID');
        }
        clearWalletIntent(intent);
        return { success: true, balance: existing.balance };
      }
      // Block if account or permission changed while waiting for crypto/module
      // imports. The native action independently owns final authorization.
      const latestActor = await getLocalSession();
      if (String(latestActor?.id ?? '') !== actor ||
          String(latestActor?.pharmacy_id ?? '') !== pharmacy ||
          !canManagePatients(latestActor) ||
          !hasUserPermissionSync(latestActor, 'acc_can_process_cash_flow')) {
        throw new Error('Native wallet actor or permissions changed before cash posting');
      }
      saveWalletIntent(intent);
      let writeError: unknown;
      try {
        const result = await invoke<WalletReceipt>('top_up_patient_wallet_native', { payload });
        if (validWrite(result)) {
          clearWalletIntent(intent);
          return { success: true, balance: result.balance };
        }
        writeError = new Error('Native wallet top-up receipt was incomplete');
      } catch (error) {
        writeError = error;
      }
      // The write may have committed before IPC failed. Only an independently
      // authenticated native, read-only lookup can resolve this uncertainty.
      // Never retry the money-bearing command or treat "already processed" as success.
      try {
        const confirmed = await invoke<WalletConfirmation | null>(
          'confirm_patient_wallet_top_up_native', { payload }
        );
        if (validConfirmation(confirmed)) {
          clearWalletIntent(intent);
          return { success: true, balance: confirmed.balance };
        }
      } catch {
        // Denial, missing witness and transport failures all preserve uncertainty.
      }
      throw writeError;
      } finally {
        walletTopUpInFlight = false;
      }
    }
    const user = await getLocalSession();
    if (!canManagePatients(user) || !hasUserPermissionSync(user, 'acc_can_process_cash_flow')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'يجب أن يكون مبلغ شحن المحفظة أكبر من صفر' };
    }
    const pharmacyId = patientTenant(user);
    if (!pharmacyId || !await ownedPatientExists(patientId, pharmacyId)) {
      return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    }

    let newBalance = 0;
    await dbTransaction(async (db) => {
      const shiftId = await requireOpenShiftId(user.id, undefined, db);
      const patient = await db.prepare('SELECT full_name, CAST(wallet_balance AS REAL) AS wallet_balance FROM patients WHERE id = ?')
        .get(patientId) as any;
      if (!patient) throw new Error('المريض غير موجود');

      const update = await db.prepare('UPDATE patients SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?')
        .run(amount, patientId);
      if (!update.changes) throw new Error('تعذر تحديث رصيد المحفظة');

      const cashMovementId = generateId();
      const journalId = generateId();
      const date = format(new Date(), 'yyyy-MM-dd');
      await db.prepare(`
        INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, source_type, target_name, notes, date)
        VALUES (?, ?, ?, 'receipt', 'patient_wallet', ?, 'patient_wallet', ?, ?, ?)
      `).run(cashMovementId, user.id, shiftId, amount, patientId, `شحن محفظة ${patient.full_name}: ${notes || ''}`, date);

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

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
        .run(
          user.id,
          'PATIENT_WALLET_TOPUP',
          JSON.stringify({ patient_id: patientId, amount, notes: notes || null })
        );

      newBalance = Number(patient.wallet_balance || 0) + amount;
    });

    revalidatePath('/patients');
    revalidatePath('/pos');
    return { success: true, balance: newBalance };
  } catch (error: any) {
    return { success: false, error:
      typeof error === 'string' && error.trim() ? error
        : error instanceof Error && error.message ? error.message : 'فشل شحن محفظة المريض' };
  }
}

export async function getPatientsAction(options: { reportScope?: boolean } = {}) {
  try {
    const localUser = await getLocalSession();
    if (options.reportScope) {
      if (!localUser || (
        !hasUserPermissionSync(localUser, 'rep_can_view_sales')
        && !canManagePatients(localUser)
      )) {
        return { success: false, error: 'غير مصرح' };
      }
      const pharmacyId = patientTenant(localUser);
      if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };
      if (isTauri) {
        // Only names already linked to a completed sale in the current
        // native tenant are eligible. This is NOT an assertion that the
        // historical patient record belongs exclusively to that branch.
        const { invoke } = await import('@tauri-apps/api/core');
        const patients: any[] = [];
        for (let offset = 0; offset <= 50_000; offset += 200) {
          const page = await invoke<any[]>('db_read_scoped', {
            queryId: 'patients.report_picker', recordId: null,
            search: null, drugId: null, limit: 200, offset,
          });
          if (!Array.isArray(page) || page.length > 200) throw new Error('Invalid native patient page');
          patients.push(...page);
          if (page.length < 200) return { success: true, data: patients };
        }
        throw new Error('Patient picker exceeds bounded native paging capacity');
      }
      const patients = await db.prepare(`
        SELECT DISTINCT p.id, p.full_name, p.name_en
        FROM patients p
        JOIN sales_invoices si ON si.patient_id = p.id
        WHERE si.pharmacy_id = ?
          AND (si.status IS NULL OR si.status = '' OR si.status IN ('completed', 'approved', 'delivered'))
        ORDER BY p.full_name ASC
      `).all(pharmacyId) as any[];
      return { success: true, data: patients };
    }
    if (!canManagePatients(localUser)) return { success: false, error: 'غير مصرح' };
    const pharmacyId = patientTenant(localUser);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    if (isTauri) {
      try {
        return { success: true, data: await nativePatientRead('patients.directory') };
      } catch {
        return { success: false, error: 'تعذر إثبات ملكية سجلات المرضى' };
      }
    }
    await assertPatientFinancialProvenance(pharmacyId);

    const patients = await db.prepare(`
      SELECT p.*, CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p
      WHERE ${ownedPatientSql('p')}
      ORDER BY p.full_name ASC
    `).all(pharmacyId, pharmacyId) as any[];
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
    const pharmacyId = patientTenant(user);
    if (!pharmacyId || isTauri || !await ownedPatientExists(patientId, pharmacyId)) {
      return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    }
    // Witnessed IDs are immutable by migration 061. Deletion requires an
    // independently reviewed native lifecycle command, not generic SQL.
    return { success: false, error: 'لا يمكن حذف المريض قبل مراجعة إثبات ملكيته' };
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
    const pharmacyId = patientTenant(user);
    if (!pharmacyId) return { success: false, error: PATIENT_OWNERSHIP_ERROR };
    if (isTauri) return { success: false, error: 'تعذر إثبات ملكية تفاصيل الإيصال' };

    const inv = await db.prepare(`
      SELECT si.id, si.total_amount, si.created_at, si.payment_method,
             u.full_name as user_name, p.full_name as patient_name, p.phone as patient_phone
      FROM sales_invoices si
      LEFT JOIN users u ON si.user_id = u.id
      LEFT JOIN patients p ON si.patient_id = p.id AND ${ownedPatientSql('p')}
      WHERE si.id = ?
        AND si.pharmacy_id = ?
    `).get(pharmacyId, pharmacyId, invoiceId, pharmacyId) as any;

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
