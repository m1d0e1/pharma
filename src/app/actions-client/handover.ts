
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




import { getLocalSession, hasUserPermissionSync, verifyPassword } from '@/lib/auth/local';
import { ensurePermanentShiftForUser } from './shifts';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

const HANDOVER_DETAILS_SQL = `
  SELECT
    s.id,
    s.user_id,
    s.start_time,
    s.end_time,
    s.status,
    CAST(COALESCE(s.starting_cash, 0) AS REAL) AS starting_cash,
    COALESCE(u.full_name, u.username, s.user_id) AS user_name,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'cash' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = s.id
    ) AS cash_sales,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'visa' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = s.id
    ) AS visa_sales,
    (
      SELECT COALESCE(SUM(
        CASE
          WHEN (si.remaining_amount IS NOT NULL AND CAST(si.remaining_amount AS REAL) > 0) THEN CAST(si.remaining_amount AS REAL)
          WHEN si.payment_method = 'credit' THEN MAX(CAST(si.total_amount AS REAL) - CAST(COALESCE(si.paid_amount, 0) AS REAL), 0)
          ELSE 0
        END
      ), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = s.id
    ) AS credit_sales,
    (
      SELECT COALESCE(SUM(CAST(r.total_refund AS REAL)), 0)
      FROM returns r
      WHERE r.refund_method = 'cash'
        AND (r.status IS NULL OR r.status = '' OR r.status IN ('approved', 'completed'))
        AND r.shift_id = s.id
    ) AS returns,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('receipt', 'in') THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id
    ) AS receipts,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('disbursement', 'out') THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id
    ) AS disbursements
  FROM shifts s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE s.id = ?
`;

async function loadHandoverDetails(shiftId: string) {
  const row = await db.prepare(HANDOVER_DETAILS_SQL).get(shiftId) as any;
  if (!row) throw new Error('الوردية غير موجودة');

  const data = {
    ...row,
    starting_cash: Number(row.starting_cash || 0),
    cash_sales: Number(row.cash_sales || 0),
    visa_sales: Number(row.visa_sales || 0),
    credit_sales: Number(row.credit_sales || 0),
    returns: Number(row.returns || 0),
    receipts: Number(row.receipts || 0),
    disbursements: Number(row.disbursements || 0),
  };

  return {
    ...data,
    expected_cash: data.starting_cash + data.cash_sales + data.receipts - data.disbursements - data.returns,
  };
}

export async function getHandoverDetailsAction(shiftId: string) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'acc_can_view_handover') && !hasUserPermissionSync(user, 'can_view_shifts'))) {
      return { success: false, error: 'غير مصرح' };
    }
    return { success: true, data: await loadHandoverDetails(shiftId) };
  } catch (error) {
    console.error('Get handover details error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب تفاصيل التسليم' };
  }
}

export async function processHandoverAction(data: {
  shiftId: string;
  actualCash: number;
  transferAmount: number;
  transferTargetId: string;
  transferTargetType: 'bank' | 'pos' | 'treasury' | 'next_shift';
  receiverUsername: string;
  receiverPasswordHash: string;
  notes?: string;
  autoOpenNewShift?: boolean;
  closeOnly?: boolean;
  managedUserId?: string;
  deactivateManagedUser?: boolean;
  authorizerPassword?: string;
}) {
  try {
    const user = await getLocalSession();
    const managedUserId = data.closeOnly ? data.managedUserId : undefined;
    const isManagedClosure = Boolean(managedUserId);
    const canManageStaff = user?.role === 'owner'
      || (user?.role === 'admin' && hasUserPermissionSync(user, 'can_view_staff_manage'));
    if (!user || (isManagedClosure ? !canManageStaff : !hasUserPermissionSync(user, 'acc_can_view_handover'))) {
      return { success: false, error: 'غير مصرح' };
    }
    if (managedUserId && String(managedUserId) === String(user.id)) {
      return { success: false, error: 'لا يمكنك تعطيل حسابك الخاص' };
    }
    if (!Number.isFinite(data.actualCash) || data.actualCash < 0) {
      return { success: false, error: 'النقدية الفعلية غير صالحة' };
    }
    if (!Number.isFinite(data.transferAmount) || data.transferAmount < 0) {
      return { success: false, error: 'مبلغ التحويل غير صالح' };
    }
    if (data.transferAmount > data.actualCash + 0.005) {
      return { success: false, error: 'مبلغ التحويل أكبر من النقدية الفعلية في الدرج' };
    }

    let managedUser: any = null;
    let receiver: any = null;
    if (managedUserId) {
      managedUser = await db.prepare('SELECT id, username, role FROM users WHERE id = ? AND is_active = 1').get(managedUserId) as any;
      if (!managedUser) return { success: false, error: 'المستخدم غير موجود أو الحساب معطل بالفعل' };
      if (managedUser.role === 'owner' && user.role !== 'owner') {
        return { success: false, error: 'لا يمكنك تعطيل حساب المالك' };
      }
      const authorizer = await db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(user.id) as any;
      if (!data.authorizerPassword || !authorizer?.password_hash || !await verifyPassword(data.authorizerPassword, authorizer.password_hash)) {
        return { success: false, error: 'كلمة مرور المسؤول غير صحيحة' };
      }
    } else {
      // Validate receiver for a normal handover.
      receiver = await db.prepare('SELECT id, password_hash FROM users WHERE username = ? AND is_active = 1').get(data.receiverUsername) as any;
      if (!receiver) return { success: false, error: 'المستلم غير موجود' };
      if (!data.receiverPasswordHash || !receiver.password_hash || !await verifyPassword(data.receiverPasswordHash, receiver.password_hash)) {
        return { success: false, error: 'كلمة مرور المستلم غير صحيحة' };
      }
    }
    
    const getAccount = async (cat: string) => {
      const setting = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
      return setting?.account_id;
    };

    const cashDrawerAcc = await getAccount('cash_drawer') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.1'").get() as any)?.id || 6;
    const bankAcc = await getAccount('bank_clearing') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.4'").get() as any)?.id;
    let cashDifferenceAcc = await getAccount('cash_difference') || (await db.prepare("SELECT id FROM accounts WHERE code = '4.3' OR name_ar LIKE '%عجز%' LIMIT 1").get() as any)?.id;
    if (!cashDifferenceAcc) {
      try {
        const ins = await db.prepare("INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES ('4.3', 'عجز وزيادة الخزينة', 'Cash Shortage/Overage', 'expense', 0)").run();
        cashDifferenceAcc = (await db.prepare("SELECT id FROM accounts WHERE code = '4.3' LIMIT 1").get() as any)?.id || ins.lastInsertRowid;
      } catch {}
    }

    const transaction = db.transaction(async () => {
      const details = await loadHandoverDetails(data.shiftId);
      const shiftOwnerId = managedUserId || user.id;
      if (String(details.user_id) !== String(shiftOwnerId) || details.status !== 'open') {
        throw new Error('الوردية غير مفتوحة أو لا تخص المستخدم الحالي');
      }

      const difference = data.actualCash - details.expected_cash;
      const remainingCash = Math.max(0, data.actualCash - data.transferAmount);
      const shiftStatus = managedUserId
        ? (Math.abs(difference) > 5 ? 'discrepancy' : 'closed')
        : 'open';

      // Keep a permanent drawer mathematically aligned with the physical count.
      // After this adjustment and the transfer its balance is exactly remainingCash.
      if (!managedUserId && Math.abs(difference) > 0.005) {
        await db.prepare(`
          INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, target_name, notes, date)
          VALUES (?, ?, ?, ?, 'cash_adjustment', ?, 'تسوية الجرد', ?, datetime('now', 'localtime'))
        `).run(
          generateId(), shiftOwnerId, data.shiftId,
          difference > 0 ? 'receipt' : 'disbursement', Math.abs(difference),
          `تسوية تسليم: ${difference.toFixed(2)} ج.م`
        );
      }

      if (data.transferAmount > 0) {
        const movementId = generateId();
        await db.prepare(`
          INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, target_name, notes, date)
          VALUES (?, ?, ?, 'disbursement', 'handover', ?, ?, ?, datetime('now', 'localtime'))
        `).run(movementId, shiftOwnerId, data.shiftId, data.transferAmount, managedUserId ? 'الخزينة الرئيسية - إغلاق حساب مستخدم' : data.receiverUsername, data.notes || 'تسليم درج');
      }

      let receiverShiftId: string | null = null;
      if (!managedUserId && data.transferAmount > 0 && data.transferTargetType === 'next_shift' && receiver?.id) {
        const candidateId = generateId();
        await db.prepare(`
          INSERT INTO shifts (id, user_id, starting_cash, notes, status)
          SELECT ?, ?, 0, 'جلسة نقدية دائمة للمستلم', 'open'
          WHERE NOT EXISTS (
            SELECT 1 FROM shifts WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
          )
        `).run(candidateId, receiver.id, receiver.id);
        const receiverShift = await db.prepare(`
          SELECT id FROM shifts
          WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
          ORDER BY start_time DESC LIMIT 1
        `).get(receiver.id) as any;
        if (!receiverShift?.id) throw new Error('تعذر تحديد الجلسة النقدية للمستلم');
        receiverShiftId = String(receiverShift.id);

        await db.prepare(`
          INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, target_name, notes, date)
          VALUES (?, ?, ?, 'receipt', 'handover_received', ?, ?, ?, datetime('now', 'localtime'))
        `).run(
          generateId(), receiver.id, receiverShiftId, data.transferAmount,
          details.user_name, data.notes || `استلام درج من ${details.user_name}`
        );
      }

      if (data.transferAmount > 0 && data.transferTargetType === 'bank') {
        const bankUpdate = await db.prepare('UPDATE banks SET current_balance = current_balance + ? WHERE id = ?').run(data.transferAmount, data.transferTargetId);
        if (bankUpdate.changes !== 1) throw new Error('الحساب البنكي المحدد غير موجود');
      } else if (data.transferAmount > 0 && data.transferTargetType === 'pos') {
        const posUpdate = await db.prepare('UPDATE points_of_sale SET current_balance = current_balance + ? WHERE id = ?').run(data.transferAmount, data.transferTargetId);
        if (posUpdate.changes !== 1) throw new Error('نقطة البيع المحددة غير موجودة');
      }

      // A treasury or next shift handover remains in the cash drawer or main treasury, so only bank transfers need a ledger transfer.
      if (data.transferTargetType === 'bank' && data.transferAmount > 0) {
        if (bankAcc && cashDrawerAcc) {
          try {
            const journalId = generateId();
            await db.prepare(`
              INSERT INTO daily_journals (id, date, description, created_by, total_amount)
              VALUES (?, date('now', 'localtime'), 'تسليم درج: تحويل إلى البنك', ?, ?)
            `).run(journalId, user.id, data.transferAmount);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, bankAcc, 'debit', data.transferAmount);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, cashDrawerAcc, 'credit', data.transferAmount);
          } catch (bErr) {
            console.warn('Could not post bank transfer journal entry:', bErr);
          }
        }
      }

      if (Math.abs(difference) > 0.01 && cashDifferenceAcc && cashDrawerAcc) {
        try {
          const journalId = generateId();
          await db.prepare(`
            INSERT INTO daily_journals (id, date, description, created_by, total_amount)
            VALUES (?, date('now', 'localtime'), 'تسوية وردية: عجز/زيادة نقدية', ?, ?)
          `).run(journalId, user.id, Math.abs(difference));
          const debitAccount = difference > 0 ? cashDrawerAcc : cashDifferenceAcc;
          const creditAccount = difference > 0 ? cashDifferenceAcc : cashDrawerAcc;
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, debitAccount, 'debit', Math.abs(difference));
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, creditAccount, 'credit', Math.abs(difference));
        } catch (dErr) {
          console.warn('Could not post difference journal entry:', dErr);
        }
      }

      const shiftUpdate = managedUserId
        ? await db.prepare(`
            UPDATE shifts
            SET end_time = CURRENT_TIMESTAMP, ending_cash = ?, actual_cash = ?,
                transfer_amount = ?, transfer_target = ?, cash_difference = ?,
                receiver_id = NULL, notes = ?, status = ?
            WHERE id = ? AND CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
          `).run(
            remainingCash, data.actualCash, data.transferAmount,
            data.transferTargetType || 'treasury', difference,
            data.notes || null, shiftStatus, data.shiftId, shiftOwnerId
          )
        : await db.prepare(`
            UPDATE shifts
            SET end_time = NULL, ending_cash = ?, actual_cash = ?,
                transfer_amount = COALESCE(transfer_amount, 0) + ?, transfer_target = ?,
                cash_difference = ?, receiver_id = ?, notes = ?, status = 'open'
            WHERE id = ? AND CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
          `).run(
            remainingCash, data.actualCash, data.transferAmount,
            data.transferTargetType || 'treasury', difference, receiver?.id || null,
            data.notes || null, data.shiftId, shiftOwnerId
          );
      if (shiftUpdate.changes !== 1) throw new Error('تم إغلاق الوردية أو تعديلها بالفعل');

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        user.id,
        managedUserId ? 'CLOSE_USER_SHIFT_AND_DEACTIVATE' : 'HANDOVER',
        managedUserId
          ? `Closed shift ${data.shiftId} and deactivated ${managedUser.username}; cash ${data.actualCash}; difference ${difference.toFixed(2)}`
          : `Handed over ${data.transferAmount} to ${data.receiverUsername}; difference ${difference.toFixed(2)}`
      );

      if (managedUserId && data.deactivateManagedUser) {
        const deactivated = await db.prepare('UPDATE users SET is_active = 0 WHERE id = ? AND is_active = 1').run(managedUserId);
        if (deactivated.changes !== 1) throw new Error('تعذر تعطيل حساب المستخدم');
      }

      const nextShiftCash = remainingCash;
      const nextShiftId = managedUserId ? null : data.shiftId;

      return { 
        difference, 
        remainingCash, 
        status: shiftStatus,
        newShiftId: receiverShiftId || nextShiftId,
        startingCash: nextShiftCash,
        receiverId: receiver?.id || null,
        transferTargetType: data.transferTargetType
      };
    });

    const result = await transaction();

    revalidatePath('/');
    revalidatePath('/pos');
    revalidatePath('/finance');
    revalidatePath('/shifts');

    return { success: true, ...result };
  } catch (error) {
    console.error('Handover error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل إتمام عملية التسليم' };
  }
}

export async function getOpenShiftHandoverAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح', data: null };
    const shift = await ensurePermanentShiftForUser(user.id);
    return { success: true, data: shift };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب الوردية المفتوحة', data: null };
  }
}

export async function getShiftCreditSalesAction(shiftId?: string) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'acc_can_view_handover') && !hasUserPermissionSync(user, 'can_view_shifts'))) {
      return { success: false, error: 'غير مصرح', data: [] };
    }

    let targetShiftId = shiftId;
    if (!targetShiftId) {
      targetShiftId = String((await ensurePermanentShiftForUser(user.id)).id);
    }

    if (!targetShiftId) return { success: true, data: [] };

    const shift = await db.prepare(`
      SELECT id
      FROM shifts
      WHERE id = ?
        AND CAST(user_id AS TEXT) = CAST(? AS TEXT)
        AND status = 'open'
    `).get(targetShiftId, user.id) as any;
    if (!shift) return { success: false, error: 'الوردية غير مفتوحة أو لا تخص المستخدم الحالي', data: [] };

    const items = await db.prepare(`
      SELECT 
        si.id,
        si.id as invoice_number,
        CAST(si.total_amount AS REAL) as total_amount,
        CAST(COALESCE(si.paid_amount, 0) AS REAL) as paid_amount,
        CASE 
          WHEN (si.remaining_amount IS NOT NULL AND CAST(si.remaining_amount AS REAL) > 0) THEN CAST(si.remaining_amount AS REAL)
          ELSE MAX(CAST(si.total_amount AS REAL) - CAST(COALESCE(si.paid_amount, 0) AS REAL), 0)
        END as credit_amount,
        si.created_at,
        si.check_number as notes,
        si.patient_id,
        COALESCE(p.full_name, 'عميل آجل') as patient_name,
        p.phone as patient_phone
      FROM sales_invoices si
      LEFT JOIN patients p ON CAST(si.patient_id AS TEXT) = CAST(p.id AS TEXT)
      WHERE (si.payment_method = 'credit' OR (si.remaining_amount IS NOT NULL AND CAST(si.remaining_amount AS REAL) > 0))
        AND (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = ?
      ORDER BY si.created_at DESC
    `).all(shift.id) as any[];

    return { success: true, data: items || [] };
  } catch (error) {
    console.error('getShiftCreditSalesAction error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب تفاصيل الآجل', data: [] };
  }
}
