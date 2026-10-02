
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
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
    return (...args) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { BASE_POINTS_PER_EGP, calculateLoyaltyPoints, EGP_PER_REDEEMED_POINT, MIN_REDEEM_POINTS } from '@/lib/loyalty/policy';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

function canUseLoyalty(user: any): boolean {
  return !!user && (
    hasUserPermissionSync(user, 'can_view_patients') ||
    hasUserPermissionSync(user, 'can_access_pos')
  );
}

/**
 * Award loyalty points after a completed sale
 */
export async function awardLoyaltyPointsAction(patientId: string, invoiceTotal: number, invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!canUseLoyalty(user)) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    void invoiceTotal; // Kept for API compatibility; the database invoice is authoritative.
    if (!patientId || !invoiceId) return { success: false, error: 'بيانات الفاتورة غير مكتملة' };

    const result = await dbTransaction(async (transactionDb) => {
      const invoice = await transactionDb.prepare(`
        SELECT patient_id, pharmacy_id, CAST(total_amount AS REAL) AS total_amount,
               status, CAST(COALESCE(points_earned, 0) AS REAL) AS points_earned
        FROM sales_invoices
        WHERE id = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      `).get(invoiceId, pharmacyId, pharmacyId) as any;
      if (!invoice) throw new Error('الفاتورة غير موجودة');
      if (String(invoice.patient_id || '') !== patientId) throw new Error('الفاتورة لا تخص هذا العميل');
      const normalizedStatus = String(invoice.status || '').trim().toLowerCase();
      if (normalizedStatus && !['completed', 'approved', 'delivered'].includes(normalizedStatus)) {
        throw new Error('لا يمكن منح نقاط لفاتورة غير مكتملة');
      }

      const existingPoints = Number(invoice.points_earned || 0);
      if (!Number.isFinite(existingPoints) || existingPoints < 0) throw new Error('رصيد نقاط الفاتورة غير صالح');
      if (existingPoints > 0) return { pointsEarned: existingPoints, alreadyAwarded: true };

      const authoritativeTotal = Number(invoice.total_amount);
      if (!Number.isFinite(authoritativeTotal) || authoritativeTotal < 0) throw new Error('إجمالي الفاتورة غير صالح');
      const patient = await transactionDb.prepare('SELECT loyalty_level FROM patients WHERE id = ?').get(patientId) as any;
      if (!patient) throw new Error('العميل غير موجود');
      const pointsEarned = calculateLoyaltyPoints(authoritativeTotal, patient.loyalty_level);
      if (pointsEarned <= 0) return { pointsEarned: 0, alreadyAwarded: false };

      const claim = await transactionDb.prepare(`
        UPDATE sales_invoices
        SET points_earned = ?
        WHERE id = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          AND COALESCE(points_earned, 0) = 0
      `).run(pointsEarned, invoiceId, pharmacyId, pharmacyId);
      if (!claim.changes) {
        const current = await transactionDb.prepare(`
          SELECT CAST(COALESCE(points_earned, 0) AS REAL) AS points_earned
          FROM sales_invoices
          WHERE id = ?
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `).get(invoiceId, pharmacyId, pharmacyId) as any;
        return { pointsEarned: Number(current?.points_earned || 0), alreadyAwarded: true };
      }

      const updated = await transactionDb.prepare('UPDATE patients SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?')
        .run(pointsEarned, patientId);
      if (!updated.changes) throw new Error('العميل غير موجود');

      await transactionDb.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
        .run(user.id, 'AWARD_POINTS', `منح ${pointsEarned} نقطة للعميل ${patientId} - فاتورة #${invoiceId.substring(0, 8)}`);

      return { pointsEarned, alreadyAwarded: false };
    });

    revalidatePath('/patients');
    return { success: true, ...result };
  } catch (error) {
    console.error('Award points error:', error);
    return { success: false, error: 'فشل منح النقاط' };
  }
}

/**
 * Redeem loyalty points as a discount
 */
export async function redeemLoyaltyPointsAction(patientId: string, pointsToRedeem: number) {
  try {
    const user = await getLocalSession();
    if (!canUseLoyalty(user)) return { success: false, error: 'غير مصرح' };

    if (!Number.isFinite(pointsToRedeem) || !Number.isInteger(pointsToRedeem) || pointsToRedeem < MIN_REDEEM_POINTS) {
      return { success: false, error: `الحد الأدنى للاسترداد ${MIN_REDEEM_POINTS} نقطة` };
    }

    const discountAmount = pointsToRedeem * EGP_PER_REDEEMED_POINT;
    const result = await dbTransaction(async (transactionDb) => {
      const patient = await transactionDb.prepare('SELECT points_balance FROM patients WHERE id = ?').get(patientId) as any;
      if (!patient) return { success: false, error: 'العميل غير موجود' };
      if (Number(patient.points_balance || 0) < pointsToRedeem) {
        return { success: false, error: `رصيد النقاط غير كافٍ (${patient.points_balance || 0} نقطة متاحة)` };
      }

      const updated = await transactionDb.prepare(`
        UPDATE patients
        SET points_balance = points_balance - ?
        WHERE id = ? AND COALESCE(points_balance, 0) >= ?
      `).run(pointsToRedeem, patientId, pointsToRedeem);
      if (!updated.changes) {
        const current = await transactionDb.prepare('SELECT points_balance FROM patients WHERE id = ?').get(patientId) as any;
        if (!current) return { success: false, error: 'العميل غير موجود' };
        return { success: false, error: `رصيد النقاط غير كافٍ (${current.points_balance || 0} نقطة متاحة)` };
      }

      await transactionDb.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
        .run(user.id, 'REDEEM_POINTS', `استرداد ${pointsToRedeem} نقطة = ${discountAmount} ج.م خصم`);

      return { success: true, discountAmount, pointsRedeemed: pointsToRedeem };
    });

    if (result.success) revalidatePath('/patients');
    return result;
  } catch (error) {
    console.error('Redeem points error:', error);
    return { success: false, error: 'فشل استرداد النقاط' };
  }
}

/**
 * Get patient loyalty info
 */
export async function getPatientLoyaltyAction(patientId: string) {
  try {
    const user = await getLocalSession();
    if (!canUseLoyalty(user)) return { success: false, error: 'غير مصرح' };
    const patient = await db.prepare('SELECT id, full_name, points_balance FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'العميل غير موجود' };

    return {
      success: true,
      data: {
        points_balance: patient.points_balance || 0,
        redeemable_value: Math.floor((patient.points_balance || 0) * EGP_PER_REDEEMED_POINT * 100) / 100,
        can_redeem: (patient.points_balance || 0) >= MIN_REDEEM_POINTS,
        min_redeem: MIN_REDEEM_POINTS,
        points_per_egp: BASE_POINTS_PER_EGP,
        egp_per_point: EGP_PER_REDEEMED_POINT,
      }
    };
  } catch (error) {
    return { success: false, error: 'فشل جلب بيانات الولاء' };
  }
}
