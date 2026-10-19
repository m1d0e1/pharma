
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';

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




import { getLocalSession, hasUserPermissionSync, verifyPassword } from '@/lib/auth/local';
import { isTauri } from '@/lib/env';
import { ensurePermanentShiftForUser, getShiftForPharmacy } from './shifts';

const revalidatePath = (...args: any[]) => {};

// Shared with the treasury card so a handover and its displayed cash cannot diverge.
import { loadHandoverDetails } from '@/lib/finance/drawer';

export async function getHandoverDetailsAction(shiftId: string) {
  try {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const response = await invoke<{actorId:string;pharmacyId:string;data:any}>(
        'get_handover_details_native', {payload:{shiftId}});
      const row=response?.data;
      if (!response?.actorId || !response?.pharmacyId ||
          !row || row.id !== shiftId || typeof row.status !== 'string' ||
          !Number.isFinite(row.expected_cash) || !Number.isFinite(row.starting_cash)) {
        throw new Error('Incomplete native handover details');
      }
      return {success:true,data:row};
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'acc_can_view_handover')) {
      return { success: false, error: 'غير مصرح' };
    }
    if (!await getShiftForPharmacy(shiftId, user.pharmacy_id)) {
      return { success: false, error: 'الوردية غير موجودة أو لا تخص هذه الصيدلية' };
    }
    return { success: true, data: await loadHandoverDetails(shiftId) };
  } catch (error) {
    console.error('Get handover details error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب تفاصيل التسليم' };
  }
}

// ponytail: one handover per renderer; SQLite serializes handovers across windows.
let handoverInProgress = false;
export async function processHandoverAction(data: {
  shiftId: string;
  actualCash: number;
  transferAmount: number;
  transferTargetId: string;
  transferTargetType: 'bank' | 'pos' | 'treasury' | 'next_shift';
  receiverUsername: string;
  receiverPasswordHash: string;
  notes?: string;
  autoOpenNewShift?: boolean; // Legacy clients may send false; normal handover always rotates the shared shift.
  closeOnly?: boolean;
  managedUserId?: string;
  deactivateManagedUser?: boolean;
  authorizerPassword?: string;
}) {
  if (handoverInProgress) return { success:false, error:'جاري تنفيذ تسليم آخر؛ انتظر انتهاء العملية' };
  handoverInProgress = true;
  try {
    if (isTauri) {
      if (data.closeOnly || data.managedUserId || data.deactivateManagedUser ||
          data.authorizerPassword || data.autoOpenNewShift === false) {
        throw new Error('Managed closure requires a separate native owner-authorized transaction');
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<any>('process_handover_native', { payload: {
        shiftId: data.shiftId, actualCash: data.actualCash,
        transferAmount: data.transferAmount,
        transferTargetType: data.transferTargetType,
        transferTargetId: data.transferTargetId || null,
        receiverUsername: data.receiverUsername,
        receiverPassword: data.receiverPasswordHash,
        notes: data.notes ?? null,
        requestId: generateId(),
      } });
      if (!result || !Number.isFinite(result.difference) ||
          !Number.isFinite(result.remainingCash) ||
          !Number.isFinite(result.startingCash) ||
          !['closed','discrepancy'].includes(result.status) ||
          typeof result.newShiftId !== 'string' || !result.newShiftId) {
        throw new Error('Incomplete native handover confirmation');
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('shift-updated'));
        try { localStorage.setItem('pharma:shift-updated', result.newShiftId); } catch {}
      }
      return { success:true, ...result };
    }
    const user = await getLocalSession();
    const managedUserId = data.closeOnly ? data.managedUserId : undefined;
    const isManagedClosure = Boolean(managedUserId);
    const canManageStaff = user?.role === 'owner';
    if (!user || (isManagedClosure ? !canManageStaff : !hasUserPermissionSync(user, 'acc_can_view_handover'))) {
      return { success: false, error: 'غير مصرح' };
    }
    const pharmacyId = user.pharmacy_id && String(user.pharmacy_id).trim()
      ? String(user.pharmacy_id).trim()
      : 'local_default';
    if (!await getShiftForPharmacy(data.shiftId, pharmacyId, true)) {
      return { success: false, error: 'الوردية غير موجودة أو لا تخص هذه الصيدلية' };
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
    if (!['bank','pos','treasury','next_shift'].includes(data.transferTargetType)) return { success:false, error:'جهة التحويل غير صالحة' };

    let managedUser: any = null;
    let receiver: any = null;
    if (managedUserId) {
      managedUser = await db.prepare('SELECT id, username, role, pharmacy_id FROM users WHERE id = ? AND is_active = 1').get(managedUserId) as any;
      if (!managedUser) return { success: false, error: 'المستخدم غير موجود أو الحساب معطل بالفعل' };
      const managedPharmacyId = managedUser.pharmacy_id && String(managedUser.pharmacy_id).trim()
        ? String(managedUser.pharmacy_id).trim()
        : 'local_default';
      if (managedPharmacyId !== pharmacyId) return { success: false, error: 'المستخدم يتبع صيدلية أخرى' };
      if (managedUser.role === 'owner' && user.role !== 'owner') {
        return { success: false, error: 'لا يمكنك تعطيل حساب المالك' };
      }
      const ownerCredentialOk = isTauri
        ? await (await import('@tauri-apps/api/core')).invoke<string | null>('verify_handover_credentials', {
            kind: 'authorizer', username: null, password: data.authorizerPassword || '',
          }) === String(user.id)
        : await (async () => {
            const authorizer = await db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(user.id) as any;
            return Boolean(data.authorizerPassword && authorizer?.password_hash &&
              await verifyPassword(data.authorizerPassword, authorizer.password_hash));
          })();
      if (!ownerCredentialOk) {
        return { success: false, error: 'كلمة مرور المسؤول غير صحيحة' };
      }
    } else {
      // Validate receiver for a normal handover.
      receiver = await db.prepare(isTauri
        ? 'SELECT id, pharmacy_id FROM users WHERE username = ? AND is_active = 1'
        : 'SELECT id, password_hash, pharmacy_id FROM users WHERE username = ? AND is_active = 1'
      ).get(data.receiverUsername) as any;
      if (!receiver) return { success: false, error: 'المستلم غير موجود' };
      const receiverPharmacyId = receiver.pharmacy_id && String(receiver.pharmacy_id).trim()
        ? String(receiver.pharmacy_id).trim()
        : 'local_default';
      if (receiverPharmacyId !== pharmacyId) return { success: false, error: 'المستلم يتبع صيدلية أخرى' };
      const receiverCredentialOk = isTauri
        ? await (await import('@tauri-apps/api/core')).invoke<string | null>('verify_handover_credentials', {
            kind: 'receiver', username: data.receiverUsername, password: data.receiverPasswordHash || '',
          }) === String(receiver.id)
        : Boolean(data.receiverPasswordHash && receiver.password_hash &&
            await verifyPassword(data.receiverPasswordHash, receiver.password_hash));
      if (!receiverCredentialOk) {
        return { success: false, error: 'كلمة مرور المستلم غير صحيحة' };
      }
    }
    
    const getAccount = async (cat: string) => {
      const setting = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
      return setting?.account_id;
    };

    const cashDrawerAcc = await getAccount('cash_drawer') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.1'").get() as any)?.id || 6;
    const bankAcc = (data.transferTargetType === 'bank' && data.transferTargetId
      ? await getAccount(`bank:${data.transferTargetId}`)
      : null) || await getAccount('bank_clearing') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.4'").get() as any)?.id;
    let cashDifferenceAcc = await getAccount('cash_difference') || (await db.prepare("SELECT id FROM accounts WHERE code = '4.3' OR name_ar LIKE '%عجز%' LIMIT 1").get() as any)?.id;
    if (!cashDifferenceAcc) {
      try {
        const ins = await db.prepare("INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES ('4.3', 'عجز وزيادة الخزينة', 'Cash Shortage/Overage', 'expense', 0)").run();
        cashDifferenceAcc = (await db.prepare("SELECT id FROM accounts WHERE code = '4.3' LIMIT 1").get() as any)?.id || ins.lastInsertRowid;
      } catch {}
    }

    const transaction = db.transaction(async (db) => {
      // Serialize the cash snapshot with checkout and other handovers before reading it.
      const locked = await db.prepare("UPDATE shifts SET status=status WHERE id=? AND status='open'").run(data.shiftId);
      if (locked.changes !== 1) throw new Error('تم تسليم أو إغلاق هذه الوردية بالفعل؛ حدّث الشاشة');
      const details = await loadHandoverDetails(data.shiftId, db);
      const shiftOwnerId = managedUserId || user.id;
      if (details.status !== 'open') {
        throw new Error('الوردية المشتركة غير مفتوحة');
      }
      if (managedUserId && String(details.user_id) !== String(managedUserId)) {
        throw new Error('المستخدم ليس مالك سجل الوردية المطلوب إغلاقه');
      }

      const difference = data.actualCash - details.expected_cash;
      const isInternalHandover = data.transferTargetType === 'next_shift';
      // transferAmount is always the amount sent to the selected destination.
      // For a next-shift handover, that amount becomes the new drawer float and
      // everything else counted in the old drawer is retained in main treasury.
      const carriedCash = isInternalHandover
        ? data.transferAmount
        : Math.max(0, data.actualCash - data.transferAmount);
      const treasuryRetainedCash = data.transferTargetType === 'treasury'
        ? data.transferAmount
        : isInternalHandover
          ? Math.max(0, data.actualCash - data.transferAmount)
          : 0;
      const remainingCash = carriedCash;
      const shiftStatus = Math.abs(difference) > 5 ? 'discrepancy' : 'closed';
      const nextShiftId = managedUserId ? null : generateId();

      // Reconcile the old drawer before carrying its residual cash to the next shift.
      if (!managedUserId && Math.abs(difference) > 0.005) {
        await db.prepare(`
          INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, target_name, notes, date)
          VALUES (?, ?, ?, ?, 'cash_adjustment', ?, 'تسوية الجرد', ?, date('now', 'localtime'))
        `).run(
          generateId(), user.id, data.shiftId,
          difference > 0 ? 'receipt' : 'disbursement', Math.abs(difference),
          `تسوية تسليم: ${difference.toFixed(2)} ج.م`
        );
      }

      if (data.transferAmount > 0) {
        const movementId = generateId();
        await db.prepare(`
          INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, source_type, target_name, notes, date)
          VALUES (?, ?, ?, 'disbursement', 'handover', ?, 'user_drawer', ?, ?, date('now', 'localtime'))
        `).run(movementId, user.id, data.shiftId, data.transferAmount, managedUserId ? 'الخزينة الرئيسية - إغلاق حساب مستخدم' : data.receiverUsername, data.notes || 'تسليم درج');
      }

      let receiverShiftId: string | null = null;

      if (data.transferAmount > 0 && data.transferTargetType === 'bank') {
        const bankUpdate = await db.prepare(`
          UPDATE banks SET current_balance = current_balance + ?
          WHERE id = ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `).run(data.transferAmount, data.transferTargetId, pharmacyId, pharmacyId);
        if (bankUpdate.changes !== 1) throw new Error('الحساب البنكي المحدد غير موجود');
      } else if (data.transferAmount > 0 && data.transferTargetType === 'pos') {
        const posUpdate = await db.prepare(`
          UPDATE points_of_sale SET current_balance = current_balance + ?
          WHERE id = ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `).run(data.transferAmount, data.transferTargetId, pharmacyId, pharmacyId);
        if (posUpdate.changes !== 1) throw new Error('نقطة البيع المحددة غير موجودة');
      }

      // A treasury or next shift handover remains in the cash drawer or main treasury, so only bank transfers need a ledger transfer.
      if (data.transferTargetType === 'bank' && data.transferAmount > 0) {
        if (!bankAcc || !cashDrawerAcc) throw new Error('يلزم ضبط حساب البنك والخزينة قبل التسليم');
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
            throw new Error('تعذر تسجيل قيد التحويل البنكي؛ تم إلغاء التسليم');
          }
        }
      }

      if (Math.abs(difference) > 0.005) {
        if (!cashDifferenceAcc || !cashDrawerAcc) throw new Error('يلزم ضبط حساب فروق النقدية والخزينة قبل التسليم');
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
          throw new Error('تعذر تسجيل قيد فرق النقدية؛ تم إلغاء التسليم');
        }
      }

      const shiftUpdate = managedUserId
        ? await db.prepare(`
            UPDATE shifts
            SET end_time = CURRENT_TIMESTAMP, ending_cash = ?, actual_cash = ?,
                transfer_amount = ?, transfer_target = ?, treasury_retained_cash = ?, cash_difference = ?,
                receiver_id = NULL, notes = ?, status = ?
            WHERE id = ? AND CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
          `).run(
            remainingCash, data.actualCash, data.transferAmount,
            data.transferTargetType || 'treasury', treasuryRetainedCash, difference,
            data.notes || null, shiftStatus, data.shiftId, shiftOwnerId
          )
        : await db.prepare(`
            UPDATE shifts
            SET end_time = CURRENT_TIMESTAMP, ending_cash = ?, actual_cash = ?,
                transfer_amount = COALESCE(transfer_amount, 0) + ?, transfer_target = ?,
                treasury_retained_cash = ?, cash_difference = ?, receiver_id = ?, notes = ?, status = ?
            WHERE id = ? AND status = 'open'
          `).run(
            carriedCash, data.actualCash, data.transferAmount,
            data.transferTargetType || 'treasury', treasuryRetainedCash, difference, receiver?.id || null,
            data.notes || null, shiftStatus, data.shiftId
          );
      if (shiftUpdate.changes !== 1) throw new Error('تم إغلاق الوردية أو تعديلها بالفعل');
      if (nextShiftId) {
        const opened = await db.prepare(`
          INSERT INTO shifts(id,user_id,pharmacy_id,starting_cash,notes,status)
          SELECT ?,?,?,?,?, 'open'
          WHERE NOT EXISTS(
            SELECT 1
            FROM shifts s
            WHERE LOWER(COALESCE(s.status, '')) = 'open'
              AND COALESCE(NULLIF(TRIM(s.pharmacy_id), ''), 'local_default') = ?
          )
        `).run(nextShiftId,user.id,pharmacyId,carriedCash,`وردية مشتركة بعد تسليم ${data.shiftId}`,pharmacyId);
        if (opened.changes !== 1) throw new Error('توجد وردية أخرى مفتوحة؛ لم يتم التسليم. راجع إدارة الورديات');
        if (isInternalHandover) receiverShiftId = nextShiftId;
        await db.prepare('INSERT INTO activity_log(user_id,action,details) VALUES (?,\'START_SHIFT\',?)').run(user.id,`Opened shared shift ${nextShiftId} after ${data.shiftId}; opening float ${carriedCash}`);
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
        user.id,
        managedUserId ? 'CLOSE_USER_SHIFT_AND_DEACTIVATE' : 'HANDOVER',
        managedUserId
          ? `Closed shift ${data.shiftId} and deactivated ${managedUser.username}; cash ${data.actualCash}; difference ${difference.toFixed(2)}`
          : JSON.stringify({ shiftId:data.shiftId, newShiftId:nextShiftId, actorId:user.id, receiverId:receiver?.id, actualCash:data.actualCash, expectedCash:details.expected_cash, transferAmount:data.transferAmount, transferTargetType:data.transferTargetType, transferTargetId:data.transferTargetId, difference, carriedCash, treasuryRetainedCash, notes:data.notes || '' })
      );

      if (managedUserId && data.deactivateManagedUser) {
        const deactivated = await db.prepare(`
          UPDATE users SET is_active = 0
          WHERE id = ? AND is_active = 1
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            AND (
              role <> 'owner' OR EXISTS (
                SELECT 1 FROM users other
                WHERE other.id <> users.id AND other.role = 'owner' AND other.is_active = 1
                  AND (other.pharmacy_id = ? OR (other.pharmacy_id IS NULL AND ? = 'local_default'))
              )
            )
        `).run(managedUserId, pharmacyId, pharmacyId, pharmacyId, pharmacyId);
        if (deactivated.changes !== 1) {
          if (managedUser?.role === 'owner') {
            throw new Error('لا يمكن تعطيل المالك الوحيد؛ أضف مالكاً آخر أولاً');
          }
          throw new Error('تعذر تعطيل حساب المستخدم؛ أعد تحميل البيانات وحاول مرة أخرى');
        }
      }

      const nextShiftCash = carriedCash;

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
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('shift-updated'));
      try { localStorage.setItem('pharma:shift-updated', result.newShiftId || data.shiftId); } catch { /* Focus refresh still works when storage is unavailable. */ }
    }

    revalidatePath('/');
    revalidatePath('/pos');
    revalidatePath('/finance');
    revalidatePath('/shifts');

    return { success: true, ...result };
  } catch (error) {
    console.error('Handover error:', error);
    // Tauri commands reject with a string, rather than Error. Preserve only
    // explicitly safe native business denials; never expose raw SQLite errors.
    const safeNativeReasons = new Set([
      'Receiver authentication failed or account is not active in this pharmacy',
      'Shift was closed, replaced or belongs to another pharmacy',
      'Shared pharmacy shift state is ambiguous',
      'Unowned legacy shared shift cannot be handed over without reconciliation',
      'Shift contains foreign or unowned payment history',
      'Shift contains malformed accounting history',
      'Old shift contains unresolved prior transfers',
      'Native normal handover permission required',
    ]);
    return { success: false, error: typeof error === 'string' && safeNativeReasons.has(error)
      ? error : error instanceof Error ? error.message : 'فشل إتمام عملية التسليم' };
  } finally {
    handoverInProgress = false;
  }
}

export async function getOpenShiftHandoverAction() {
  try {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const shift = await invoke<{
        id: string; user_id: string; start_time: string | null;
        starting_cash: number | null; status: string;
      }>('ensure_handover_shift_native');
      if (!shift || typeof shift.id !== 'string' || !shift.id ||
          typeof shift.user_id !== 'string' || !shift.user_id ||
          shift.status !== 'open' ||
          (shift.starting_cash != null && !Number.isFinite(shift.starting_cash))) {
        throw new Error('Incomplete native handover shift confirmation');
      }
      return { success: true, data: shift };
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'acc_can_view_handover')) {
      return { success: false, error: 'غير مصرح', data: null };
    }
    const shift = await ensurePermanentShiftForUser(user.id);
    return { success: true, data: shift };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'فشل جلب الوردية المفتوحة', data: null };
  }
}

export async function getShiftCreditSalesAction(shiftId?: string) {
  try {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const response = await invoke<{
        actorId:string;pharmacyId:string;shiftId:string|null;rows:any[];
      }>('get_shift_credit_sales_native', {payload:{shiftId:shiftId ?? null}});
      const rows=response?.rows;
      if (!response?.actorId || !response?.pharmacyId ||
          (shiftId && response.shiftId !== shiftId) ||
          !Array.isArray(rows) || rows.length > 1000 || rows.some(row =>
        !row || typeof row.id !== 'string' && typeof row.id !== 'number' ||
        !Number.isFinite(row.credit_amount))) {
        throw new Error('Incomplete native credit-sales projection');
      }
      return {success:true,data:rows};
    }
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'acc_can_view_handover')) {
      return { success: false, error: 'غير مصرح', data: [] };
    }

    let targetShiftId = shiftId;
    if (!targetShiftId) {
      targetShiftId = String((await ensurePermanentShiftForUser(user.id)).id);
    }

    if (!targetShiftId) return { success: true, data: [] };

    const shift = await getShiftForPharmacy(targetShiftId, user.pharmacy_id, true);
    if (!shift) return { success: false, error: 'الوردية المشتركة غير مفتوحة', data: [] };

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
