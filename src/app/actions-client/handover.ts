
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




import { getLocalSession, verifyPassword } from '@/lib/auth/local';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

const HANDOVER_DETAILS_SQL = `
  SELECT
    s.id,
    s.user_id,
    s.start_time,
    s.end_time,
    CAST(COALESCE(s.starting_cash, 0) AS REAL) AS starting_cash,
    COALESCE(u.full_name, u.username, s.user_id) AS user_name,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'cash' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND (
          si.shift_id = s.id OR
          (
            (si.shift_id IS NULL OR TRIM(si.shift_id) = '') AND
            (CAST(si.user_id AS TEXT) = CAST(s.user_id AS TEXT) OR si.user_id IS NULL OR s.user_id IS NULL) AND
            (
              datetime(si.created_at) >= datetime(s.start_time, '-12 hours') OR
              si.created_at >= s.start_time OR
              date(si.created_at) = date(s.start_time)
            ) AND
            (s.end_time IS NULL OR datetime(si.created_at) <= datetime(s.end_time, '+12 hours') OR si.created_at <= s.end_time)
          )
        )
    ) AS cash_sales,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'visa' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND (
          si.shift_id = s.id OR
          (
            (si.shift_id IS NULL OR TRIM(si.shift_id) = '') AND
            (CAST(si.user_id AS TEXT) = CAST(s.user_id AS TEXT) OR si.user_id IS NULL OR s.user_id IS NULL) AND
            (
              datetime(si.created_at) >= datetime(s.start_time, '-12 hours') OR
              si.created_at >= s.start_time OR
              date(si.created_at) = date(s.start_time)
            ) AND
            (s.end_time IS NULL OR datetime(si.created_at) <= datetime(s.end_time, '+12 hours') OR si.created_at <= s.end_time)
          )
        )
    ) AS visa_sales,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'credit' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND (
          si.shift_id = s.id OR
          (
            (si.shift_id IS NULL OR TRIM(si.shift_id) = '') AND
            (CAST(si.user_id AS TEXT) = CAST(s.user_id AS TEXT) OR si.user_id IS NULL OR s.user_id IS NULL) AND
            (
              datetime(si.created_at) >= datetime(s.start_time, '-12 hours') OR
              si.created_at >= s.start_time OR
              date(si.created_at) = date(s.start_time)
            ) AND
            (s.end_time IS NULL OR datetime(si.created_at) <= datetime(s.end_time, '+12 hours') OR si.created_at <= s.end_time)
          )
        )
    ) AS credit_sales,
    (
      SELECT COALESCE(SUM(CAST(r.total_refund AS REAL)), 0)
      FROM returns r
      WHERE r.refund_method = 'cash'
        AND (r.status IS NULL OR r.status = '' OR r.status IN ('approved', 'completed'))
        AND (
          r.shift_id = s.id OR
          (
            (r.shift_id IS NULL OR TRIM(r.shift_id) = '') AND
            (CAST(r.user_id AS TEXT) = CAST(s.user_id AS TEXT) OR r.user_id IS NULL OR s.user_id IS NULL) AND
            (
              datetime(r.created_at) >= datetime(s.start_time, '-12 hours') OR
              r.created_at >= s.start_time OR
              date(r.created_at) = date(s.start_time)
            ) AND
            (s.end_time IS NULL OR datetime(r.created_at) <= datetime(s.end_time, '+12 hours') OR r.created_at <= s.end_time)
          )
        )
    ) AS returns,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('receipt', 'in') THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id OR
        (
          (cm.shift_id IS NULL OR TRIM(cm.shift_id) = '') AND
          (CAST(cm.user_id AS TEXT) = CAST(s.user_id AS TEXT) OR cm.user_id IS NULL OR s.user_id IS NULL) AND
          (
            datetime(cm.created_at) >= datetime(s.start_time, '-12 hours') OR
            cm.created_at >= s.start_time OR
            date(cm.created_at) = date(s.start_time)
          ) AND
          (s.end_time IS NULL OR datetime(cm.created_at) <= datetime(s.end_time, '+12 hours') OR cm.created_at <= s.end_time)
        )
    ) AS receipts,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('disbursement', 'out') THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id OR
        (
          (cm.shift_id IS NULL OR TRIM(cm.shift_id) = '') AND
          (CAST(cm.user_id AS TEXT) = CAST(s.user_id AS TEXT) OR cm.user_id IS NULL OR s.user_id IS NULL) AND
          (
            datetime(cm.created_at) >= datetime(s.start_time, '-12 hours') OR
            cm.created_at >= s.start_time OR
            date(cm.created_at) = date(s.start_time)
          ) AND
          (s.end_time IS NULL OR datetime(cm.created_at) <= datetime(s.end_time, '+12 hours') OR cm.created_at <= s.end_time)
        )
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
    if (!await getLocalSession()) return { success: false, error: 'غير مصرح' };
    return { success: true, data: await loadHandoverDetails(shiftId) };
  } catch (error) {
    console.error('Get handover details error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب تفاصيل التسليم' };
  }
}

export async function processHandoverAction(data: {
  shiftId: string;
  transferAmount: number;
  transferTargetId: string;
  transferTargetType: 'bank' | 'pos' | 'treasury';
  receiverUsername: string;
  receiverPasswordHash: string;
  notes?: string;
}) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };
    if (!Number.isFinite(data.transferAmount) || data.transferAmount < 0) {
      return { success: false, error: 'مبلغ التحويل غير صالح' };
    }

    const details = await loadHandoverDetails(data.shiftId);
    if (data.transferAmount > details.expected_cash + 0.005) {
      return { success: false, error: 'مبلغ التحويل أكبر من النقدية المتاحة في الدرج' };
    }

    // Validate receiver
    const receiver = await db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(data.receiverUsername) as any;
    if (!receiver) return { success: false, error: 'المستلم غير موجود' };
    if (!data.receiverPasswordHash || !receiver.password_hash || !await verifyPassword(data.receiverPasswordHash, receiver.password_hash)) {
      return { success: false, error: 'كلمة مرور المستلم غير صحيحة' };
    }
    
    const getAccount = async (cat: string) => {
      const setting = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
      return setting?.account_id;
    };

    const cashDrawerAcc = await getAccount('cash_drawer') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.1'").get() as any)?.id || 6;
    const bankAcc = await getAccount('bank_clearing') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.4'").get() as any)?.id;

    const transaction = db.transaction(async () => {
      // 1. Create a cash movement for the transfer
      const movementId = generateId();
      await db.prepare(`
        INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, target_name, notes, date)
        VALUES (?, ?, ?, 'disbursement', 'handover', ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(movementId, user.id, data.shiftId, data.transferAmount, data.receiverUsername, data.notes || 'تسليم درج');

      // 2. Update the target balance if it's a bank or POS
      if (data.transferTargetType === 'bank') {
        await db.prepare('UPDATE banks SET current_balance = current_balance + ? WHERE id = ?').run(data.transferAmount, data.transferTargetId);
      } else if (data.transferTargetType === 'pos') {
        await db.prepare('UPDATE points_of_sale SET current_balance = current_balance + ? WHERE id = ?').run(data.transferAmount, data.transferTargetId);
      }

      // 3. Mark the shift as handed over or just log it
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'HANDOVER', `Handed over ${data.transferAmount} to ${data.receiverUsername}`);

      // 4. Post double-entry journal entries for handover
      const journalId = generateId();
      const date = new Date().toISOString().split('T')[0];
      const targetText = data.transferTargetType === 'bank' ? 'البنك' : 'الخزينة الرئيسية';
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, date, `تسليم درج: تحويل إلى ${targetText}`, user.id, data.transferAmount);

      if (data.transferTargetType === 'bank' && !bankAcc) throw new Error('حساب البنك غير مهيأ');
      const targetAcc = data.transferTargetType === 'bank' ? bankAcc : cashDrawerAcc;
      
      // Debit the receiving account (Bank or Main Treasury), Credit the Cash Drawer (which represents the drawer cash)
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, targetAcc, 'debit', data.transferAmount);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, cashDrawerAcc, 'credit', data.transferAmount);
    });

    await transaction();

    revalidatePath('/finance');
    revalidatePath('/shifts');

    return { success: true };
  } catch (error) {
    console.error('Handover error:', error);
    return { success: false, error: 'فشل إتمام عملية التسليم' };
  }
}

export async function getOpenShiftHandoverAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح', data: null };
    let shift = await db.prepare(`
      SELECT id, user_id, start_time, starting_cash, status
      FROM shifts
      WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
      ORDER BY start_time DESC
      LIMIT 1
    `).get(user.id);
    if (!shift) {
      shift = await db.prepare(`
        SELECT id, user_id, start_time, starting_cash, status
        FROM shifts
        WHERE status = 'open'
        ORDER BY start_time DESC
        LIMIT 1
      `).get();
    }
    if (!shift) {
      const firstSale = await db.prepare(`
        SELECT created_at FROM sales_invoices 
        WHERE (CAST(user_id AS TEXT) = CAST(? AS TEXT) OR user_id IS NULL) 
          AND DATE(created_at) = DATE('now', 'localtime')
        ORDER BY created_at ASC LIMIT 1
      `).get(user.id) as any;

      const newShiftId = generateId();
      const startTime = firstSale?.created_at || new Date().toISOString().replace('T', ' ').substring(0, 19);

      await db.prepare(`
        INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
        VALUES (?, ?, ?, 0, 'open')
      `).run(newShiftId, user.id, startTime);

      shift = { id: newShiftId, user_id: user.id, start_time: startTime, starting_cash: 0, status: 'open' };
    }
    return { success: true, data: shift || null };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب الوردية المفتوحة', data: null };
  }
}
