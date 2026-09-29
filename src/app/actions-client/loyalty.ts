
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
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

function canUseLoyalty(user: any): boolean {
  return !!user && (
    hasUserPermissionSync(user, 'can_view_patients') ||
    hasUserPermissionSync(user, 'can_access_pos')
  );
}

// Points configuration
const POINTS_PER_EGP = 1;          // 1 point per 1 EGP spent
const EGP_PER_POINT_REDEEM = 0.1;  // Each point = 0.10 EGP discount
const MIN_REDEEM_POINTS = 100;     // Minimum points to redeem

/**
 * Award loyalty points after a completed sale
 */
export async function awardLoyaltyPointsAction(patientId: string, invoiceTotal: number, invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!canUseLoyalty(user)) return { success: false, error: 'غير مصرح' };

    const pointsEarned = Math.floor(invoiceTotal * POINTS_PER_EGP);
    if (pointsEarned <= 0) return { success: true, pointsEarned: 0 };

    const updated = await db.prepare('UPDATE patients SET points_balance = points_balance + ? WHERE id = ?').run(pointsEarned, patientId);
    if (!updated.changes) return { success: false, error: 'العميل غير موجود' };

    logActivity(user.id, 'AWARD_POINTS', `منح ${pointsEarned} نقطة للعميل ${patientId} - فاتورة #${invoiceId.substring(0, 8)}`);

    return { success: true, pointsEarned };
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

    if (pointsToRedeem < MIN_REDEEM_POINTS) {
      return { success: false, error: `الحد الأدنى للاسترداد ${MIN_REDEEM_POINTS} نقطة` };
    }

    const patient = await db.prepare('SELECT points_balance FROM patients WHERE id = ?').get(patientId) as any;
    if (!patient) return { success: false, error: 'العميل غير موجود' };
    if (patient.points_balance < pointsToRedeem) {
      return { success: false, error: `رصيد النقاط غير كافٍ (${patient.points_balance} نقطة متاحة)` };
    }

    const discountAmount = pointsToRedeem * EGP_PER_POINT_REDEEM;

    const updated = await db.prepare(`
      UPDATE patients
      SET points_balance = points_balance - ?
      WHERE id = ? AND COALESCE(points_balance, 0) >= ?
    `).run(pointsToRedeem, patientId, pointsToRedeem);
    if (!updated.changes) {
      const current = await db.prepare('SELECT points_balance FROM patients WHERE id = ?').get(patientId) as any;
      if (!current) return { success: false, error: 'العميل غير موجود' };
      return { success: false, error: `رصيد النقاط غير كافٍ (${current.points_balance || 0} نقطة متاحة)` };
    }

    logActivity(user.id, 'REDEEM_POINTS', `استرداد ${pointsToRedeem} نقطة = ${discountAmount} ج.م خصم`);

    revalidatePath('/patients');
    return { success: true, discountAmount, pointsRedeemed: pointsToRedeem };
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
        redeemable_value: Math.floor((patient.points_balance || 0) * EGP_PER_POINT_REDEEM * 100) / 100,
        can_redeem: (patient.points_balance || 0) >= MIN_REDEEM_POINTS,
        min_redeem: MIN_REDEEM_POINTS,
        points_per_egp: POINTS_PER_EGP,
        egp_per_point: EGP_PER_POINT_REDEEM,
      }
    };
  } catch (error) {
    return { success: false, error: 'فشل جلب بيانات الولاء' };
  }
}
