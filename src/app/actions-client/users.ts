
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




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { processHandoverAction } from '@/app/actions-client/handover';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

const defaultOwnerPerms = {
  national_id: '', address: '', birth_date: '', qualification: '', mobile: '', gender: 'ذكر', social_status: 'أعزب', is_delivery_rep: false,
  can_view_stock_sale: true,
  show_suspended_invoices: true,
  show_sale_price_return: true,
  suspended_can_add_item: true,
  suspended_can_delete: true,
  suspended_can_discount_item: true,
  suspended_can_modify_discount: true,
  suspended_can_change_delivery: true,
  suspended_can_save_invoice: true,
  show_stock_periodic_inventory: true,
  show_total_sales_report: true,
  preview_item_movements: true,
  show_own_financial_only: false,
  can_manage_inventory: true,
  can_change_price_sale: true,
  max_invoice_discount_percent: 100,
  max_exchange_discount_percent: 100,
  preview_last_n_invoices: 999999,
  acc_can_view_general: true,
  acc_can_view_pos: true,
  acc_can_process_cash_flow: true,
  acc_can_view_notifications: true,
  acc_can_collect_credit_cards: true,
  acc_can_view_reports: true,
  rep_can_view_sales: true,
  rep_can_view_inventory: true,
  can_exceed_max_sale_limit: true,
  can_sell_no_stock: true,
  can_give_total_discount: true,
  show_sales_report_invoice: true,
  can_change_price_return: true,
  can_sell_credit: true,
  show_contract_discounts: true,
  can_make_exchanges: true,
  can_change_contract_discounts: true,
  suspended_can_pay_credit: true,
  can_change_price_purchase: true,
  can_purchase_above_master_price: true,
  can_purchase_from_individuals: true,
  can_change_pos_device: true,
  can_settle_multiple_lines: true,
  show_cost_price: true,
  can_modify_unit_conversion: true,
  rep_can_view_purchases: true,
  rep_can_view_financial: true,
  rep_can_view_activity: true,
  can_select_pos_financial: true,
  preview_drawer_details: true,
  hide_total_points_balance: false,
  acc_can_view_bank_accounts: true,
  acc_can_define_expenses: true,
  acc_can_view_securities: true,
  acc_can_make_daily_entries: true,

  // New Page level permissions
  can_view_low_stock: true,
  can_view_opening_balances: true,
  can_view_settlement: true,
  can_view_stores: true,
  can_view_patients: true,
  can_view_delivery: true,
  can_view_cogs: true,
  can_view_receipts: true,
  can_view_returns: true,
  can_view_purchases: true,
  can_view_shifts: true,
  can_view_restock: true,
  can_view_audit: true,
  can_view_settings: true,
  acc_can_view_handover: true,
  can_view_expenses: true,
  can_view_staff_manage: true,
  can_view_staff_roles: true
};

export async function updateUserPermissionsAction(userId: string, permissions: any) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && !(localUser.role === 'admin' && hasUserPermissionSync(localUser, 'can_view_staff_manage')))) {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    let permissionsToSave = permissions;
    const targetUser = await db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId) as { username: string; role: string };

    if (targetUser?.role === 'owner' && localUser.role !== 'owner') {
      return { success: false, error: 'لا يمكنك تعديل صلاحيات المالك' };
    }

    const permissionsJson = JSON.stringify(permissionsToSave);

    await db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(permissionsJson, userId);

    // Log the activity
    logActivity(localUser.id, 'UPDATE_PERMISSIONS', `حدث صلاحيات المستخدم: ${targetUser?.username || userId}`);

    revalidatePath('/staff/manage');
    revalidatePath('/staff');
    
    return { success: true };
  } catch (error) {
    console.error('Update user permissions error:', error);
    return { success: false, error: 'فشل تحديث الصلاحيات' };
  }
}

export async function addUserAction(formData: { 
  username: string; 
  full_name: string; 
  role: string; 
  password?: string;
  job_id?: number;
  qualification?: string;
  hire_date?: string;
  shift?: string;
  code?: string;
}) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    const { username, full_name, role, password, job_id, qualification, hire_date, shift, code } = formData;
    
    // Check if user exists
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return { success: false, error: 'اسم المستخدم موجود مسبقاً' };

    const id = generateId();
    const bcrypt = {
      hash: async (pw: any, ...args: any[]) => {
        const { hashPassword } = await import('@/lib/auth/local');
        return await hashPassword(pw);
      },
      compare: async (pw, hash) => {
        const { verifyPassword } = await import('@/lib/auth/local');
        return await verifyPassword(pw, hash);
      }
    };
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    
    // Default permissions based on role
    const defaultPerms = role === 'pharmacist' ? {
      national_id: '', address: '', birth_date: '', qualification: '', mobile: '', gender: 'ذكر', social_status: 'أعزب', is_delivery_rep: false,
      can_view_stock_sale: true,
      show_suspended_invoices: true,
      show_sale_price_return: true,
      suspended_can_add_item: true,
      suspended_can_delete: true,
      suspended_can_discount_item: true,
      suspended_can_modify_discount: true,
      suspended_can_change_delivery: true,
      suspended_can_save_invoice: true,
      show_stock_periodic_inventory: true,
      show_total_sales_report: true,
      preview_item_movements: true,
      show_own_financial_only: true,
      can_manage_inventory: false,
      can_change_price_sale: false,
      max_invoice_discount_percent: 5,
      max_exchange_discount_percent: 0,
      preview_last_n_invoices: 1,
      acc_can_view_general: true,
      acc_can_view_pos: true,
      acc_can_process_cash_flow: true,
      acc_can_view_notifications: true,
      acc_can_collect_credit_cards: true,
      acc_can_view_reports: true,
      rep_can_view_sales: true,
      rep_can_view_inventory: true,

      // New Page level permissions
      can_view_low_stock: true,
      can_view_opening_balances: false,
      can_view_settlement: true,
      can_view_stores: false,
      can_view_patients: true,
      can_view_delivery: true,
      can_view_cogs: false,
      can_view_receipts: true,
      can_view_returns: true,
      can_view_purchases: false,
      can_view_shifts: true,
      can_view_restock: false,
      can_view_audit: false,
      can_view_settings: false,
      acc_can_view_handover: true,
      can_view_expenses: false,
      can_view_staff_manage: false,
      can_view_staff_roles: false
    } : role === 'admin' ? {
      national_id: '', address: '', birth_date: '', qualification: '', mobile: '', gender: 'ذكر', social_status: 'أعزب', is_delivery_rep: false,
      can_view_stock_sale: true,
      can_manage_inventory: true,
      can_change_price_sale: true,
      show_cost_price: true,
      max_invoice_discount_percent: 15,
      max_exchange_discount_percent: 10,
      preview_last_n_invoices: 5,
      acc_can_view_general: true,
      acc_can_view_pos: true,
      acc_can_view_bank_accounts: true,
      acc_can_define_expenses: true,
      acc_can_process_cash_flow: true,
      acc_can_view_securities: true,
      acc_can_make_daily_entries: true,
      acc_can_view_notifications: true,
      acc_can_collect_credit_cards: true,
      acc_can_view_reports: true,
      rep_can_view_sales: true,
      rep_can_view_purchases: true,
      rep_can_view_inventory: true,
      rep_can_view_financial: true,
      rep_can_view_activity: true,

      // New Page level permissions
      can_view_low_stock: true,
      can_view_opening_balances: true,
      can_view_settlement: true,
      can_view_stores: true,
      can_view_patients: true,
      can_view_delivery: true,
      can_view_cogs: true,
      can_view_receipts: true,
      can_view_returns: true,
      can_view_purchases: true,
      can_view_shifts: true,
      can_view_restock: true,
      can_view_audit: false,
      can_view_settings: true,
      acc_can_view_handover: true,
      can_view_expenses: true,
      can_view_staff_manage: true,
      can_view_staff_roles: true
    } : (role === 'owner' || role === 'admin') ? defaultOwnerPerms : {};

    await db.prepare(`
      INSERT INTO users (id, username, full_name, role, password_hash, permissions, job_id, qualification, hire_date, shift, code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, username, full_name, role, passwordHash, JSON.stringify(defaultPerms), job_id || null, qualification || null, hire_date || null, shift || null, code || null);

    logActivity(localUser.id, 'ADD_USER', `أضاف مستخدماً جديداً: ${username} (${role})`);

    revalidatePath('/staff/manage');
    revalidatePath('/staff');
    
    return { success: true };
  } catch (error) {
    console.error('Add user error:', error);
    return { success: false, error: 'فشل إضافة المستخدم' };
  }
}

export async function deleteUserAction(userId: string) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && !(localUser.role === 'admin' && hasUserPermissionSync(localUser, 'can_view_staff_manage')))) {
      return { success: false, error: 'غير مصرح بإدارة المستخدمين' };
    }

    // Don't allow deleting self
    if (localUser.id === userId) {
      return { success: false, error: 'لا يمكنك حذف حسابك الخاص' };
    }

    const targetUser = await db.prepare('SELECT username, role, is_active FROM users WHERE id = ?').get(userId) as { username: string; role: string; is_active: number };
    if (!targetUser) return { success: false, error: 'المستخدم غير موجود' };
    
    if (targetUser?.role === 'owner' && localUser.role !== 'owner') {
      return { success: false, error: 'لا يمكنك حذف حساب المالك' };
    }
    
    const openShift = await db.prepare(`
      SELECT s.id, s.start_time,
        CAST(COALESCE(s.starting_cash, 0) AS REAL)
        + CAST(COALESCE((SELECT SUM(si.total_amount) FROM sales_invoices si
            WHERE si.shift_id = s.id AND si.payment_method = 'cash'
              AND (si.status IS NULL OR si.status = '' OR si.status IN ('completed', 'approved'))), 0) AS REAL)
        + CAST(COALESCE((SELECT SUM(CASE WHEN cm.type IN ('receipt', 'in') THEN cm.amount ELSE 0 END)
            FROM cash_movements cm WHERE cm.shift_id = s.id), 0) AS REAL)
        - CAST(COALESCE((SELECT SUM(CASE WHEN cm.type IN ('disbursement', 'out') THEN cm.amount ELSE 0 END)
            FROM cash_movements cm WHERE cm.shift_id = s.id), 0) AS REAL)
        - CAST(COALESCE((SELECT SUM(r.total_refund) FROM returns r
            WHERE r.shift_id = s.id AND r.refund_method = 'cash'
              AND (r.status IS NULL OR r.status = '' OR r.status IN ('approved', 'completed'))), 0) AS REAL)
        AS expected_cash
      FROM shifts s
      WHERE CAST(s.user_id AS TEXT) = CAST(? AS TEXT) AND s.status = 'open'
      ORDER BY s.start_time DESC LIMIT 1
    `).get(userId) as { id: string; start_time: string; expected_cash: number } | undefined;
    if (openShift) {
      return {
        success: false,
        code: 'OPEN_SHIFT' as const,
        error: 'لدى المستخدم وردية مفتوحة ويجب تسويتها قبل تعطيل الحساب',
        openShift: { ...openShift, expected_cash: Number(openShift.expected_cash || 0) },
      };
    }

    await db.prepare('UPDATE users SET is_active = 0 WHERE id = ? AND is_active = 1').run(userId);
    
    logActivity(localUser.id, 'DEACTIVATE_USER', `تعطيل المستخدم مع الاحتفاظ بسجلاته: ${targetUser.username}`);

    revalidatePath('/staff/manage');
    revalidatePath('/staff');
    
    return { success: true };
  } catch (error) {
    console.error('Delete user error:', error);
    return { success: false, error: 'فشل حذف المستخدم' };
  }
}

export async function closeUserShiftAndDeactivateAction(data: {
  userId: string;
  shiftId: string;
  actualCash: number;
  authorizerPassword: string;
  notes?: string;
}) {
  return processHandoverAction({
    shiftId: data.shiftId,
    actualCash: data.actualCash,
    transferAmount: data.actualCash,
    transferTargetId: '',
    transferTargetType: 'treasury',
    receiverUsername: '',
    receiverPasswordHash: '',
    notes: data.notes || 'إغلاق الوردية وتعطيل حساب المستخدم',
    closeOnly: true,
    managedUserId: data.userId,
    deactivateManagedUser: true,
    authorizerPassword: data.authorizerPassword,
  });
}

export async function updateUserAction(userId: string, data: { 
  username: string; 
  full_name: string; 
  role: string; 
  password?: string;
  job_id?: number;
  qualification?: string;
  hire_date?: string;
  shift?: string;
  code?: string;
}) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    const { username, full_name, role, password, job_id, qualification, hire_date, shift, code } = data;

    const targetUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string };
    if (targetUser?.role === 'owner' && localUser.role !== 'owner') {
      return { success: false, error: 'لا يمكنك تعديل حساب المالك' };
    }

    // Only update user profile fields here — permissions are saved separately by updateUserPermissionsAction
    if (password) {
      const bcrypt = {
      hash: async (pw: any, ...args: any[]) => {
        const { hashPassword } = await import('@/lib/auth/local');
        return await hashPassword(pw);
      },
      compare: async (pw, hash) => {
        const { verifyPassword } = await import('@/lib/auth/local');
        return await verifyPassword(pw, hash);
      }
    };
      const passwordHash = await bcrypt.hash(password, 10);
      await db.prepare('UPDATE users SET username = ?, full_name = ?, role = ?, password_hash = ?, job_id = ?, qualification = ?, hire_date = ?, shift = ?, code = ? WHERE id = ?').run(username, full_name, role, passwordHash, job_id || null, qualification || null, hire_date || null, shift || null, code || null, userId);
    } else {
      await db.prepare('UPDATE users SET username = ?, full_name = ?, role = ?, job_id = ?, qualification = ?, hire_date = ?, shift = ?, code = ? WHERE id = ?').run(username, full_name, role, job_id || null, qualification || null, hire_date || null, shift || null, code || null, userId);
    }

    logActivity(localUser.id, 'UPDATE_USER', `حدث بيانات المستخدم: ${username}`);
    revalidatePath('/staff/manage');
    
    return { success: true };
  } catch (error) {
    console.error('Update user error:', error);
    return { success: false, error: 'فشل تحديث بيانات المطلب' };
  }
}

export async function getStaffAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'Unauthorized' };

    const staff = await db.prepare(`
      SELECT 
        u.id,
        u.username,
        u.full_name,
        u.role,
        u.is_active,
        ej.name_ar as job_name_ar, 
        ej.name_en as job_name_en
      FROM users u
      LEFT JOIN employee_jobs ej ON u.job_id = ej.id
      WHERE u.is_active = 1
      ORDER BY u.full_name ASC, u.username ASC
    `).all() as any[];
    return { success: true, data: staff || [] };
  } catch (error) {
    return { success: false, error: 'فشل جلب قائمة الموظفين' };
  }
}

export async function getJobsAction() {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) return { success: false, error: 'Unauthorized' };

    const jobs = await db.prepare('SELECT * FROM employee_jobs ORDER BY name_ar ASC').all() as any[];
    return { success: true, data: jobs || [] };
  } catch (error) {
    return { success: false, error: 'فشل جلب قائمة الوظائف' };
  }
}

export async function addJobAction(data: { name_ar: string; name_en?: string; min_salary?: number; max_salary?: number }) {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) return { success: false, error: 'Unauthorized' };

    await db.prepare('INSERT INTO employee_jobs (name_ar, name_en, min_salary, max_salary) VALUES (?, ?, ?, ?)').run(data.name_ar, data.name_en || null, data.min_salary || 0, data.max_salary || 0);

    revalidatePath('/staff/roles');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل إضافة الوظيفة' };
  }
}

export async function deleteJobAction(jobId: number) {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) return { success: false, error: 'Unauthorized' };

    await db.prepare('DELETE FROM employee_jobs WHERE id = ?').run(jobId);
    revalidatePath('/staff/roles');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل حذف الوظيفة' };
  }
}

/**
 * Administrative Password Reset
 * Allows Owner/Admin to set a new password for a staff member
 */
export async function resetUserPasswordAction(userId: string, newPassword: string) {
  try {
    const localUser = await getLocalSession();
    // Only Owners can reset passwords for others
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    if (!newPassword || newPassword.length < 6) {
      return { success: false, error: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل' };
    }

    const targetUser = await db.prepare('SELECT role, username FROM users WHERE id = ?').get(userId) as { role: string, username: string };
    if (targetUser?.role === 'owner' && localUser.role !== 'owner') {
      return { success: false, error: 'لا يمكنك إعادة تعيين كلمة مرور المالك' };
    }

    const bcrypt = {
      hash: async (pw: any, ...args: any[]) => {
        const { hashPassword } = await import('@/lib/auth/local');
        return await hashPassword(pw);
      },
      compare: async (pw, hash) => {
        const { verifyPassword } = await import('@/lib/auth/local');
        return await verifyPassword(pw, hash);
      }
    };
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);

    const target = await db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
    logActivity(localUser.id, 'PASSWORD_RESET', `إعادة تعيين كلمة مرور المستخدم: ${target?.username || userId}`);

    return { success: true };
  } catch (error) {
    console.error('Password reset error:', error);
    return { success: false, error: 'فشل إعادة تعيين كلمة المرور' };
  }
}

export async function getStaffManagementDataAction() {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    const users = await db.prepare(`
      SELECT u.*, ej.name_ar as job_name_ar 
      FROM users u
      LEFT JOIN employee_jobs ej ON u.job_id = ej.id
      ORDER BY u.full_name ASC, u.username ASC
    `).all() as any[];

    const jobs = await db.prepare('SELECT * FROM employee_jobs ORDER BY name_ar ASC').all() as any[];

    return { success: true, users: users || [], jobs: jobs || [] };
  } catch (error) {
    return { success: false, error: 'فشل جلب بيانات الموظفين' };
  }
}

export async function getStaffPerformanceAction() {
  try {
    const { hasUserPermissionSync, isOwnerOrAdmin } = await import('@/lib/auth/local');
    const user = await getLocalSession();
    if (!user || (!isOwnerOrAdmin(user) && !hasUserPermissionSync(user, 'rep_can_view_activity'))) {
      return { success: false, error: 'غير مصرح' };
    }

    const metrics = await db.prepare(`
      SELECT 
        u.id, 
        u.username, 
        u.full_name, 
        u.role,
        COUNT(DISTINCT si.id) as transactions,
        COALESCE(SUM(si.total_amount), 0) as total_revenue,
        (SELECT COUNT(*) FROM returns r WHERE r.user_id = u.id) as returns_count,
        (SELECT COUNT(*) FROM shifts s WHERE s.user_id = u.id) as shifts_count
      FROM users u
      LEFT JOIN sales_invoices si ON u.id = si.user_id AND (si.status IS NULL OR si.status != 'cancelled')
      WHERE u.is_active = 1
      GROUP BY u.id
      ORDER BY total_revenue DESC
    `).all() as any[];

    const mapped = (metrics || []).map((member: any) => {
      const transactions = Number(member.transactions || 0);
      const totalRevenue = Number(member.total_revenue || 0);
      const shiftsCount = Number(member.shifts_count || 0);
      const returnsCount = Number(member.returns_count || 0);
      const transactionsPerShift = shiftsCount > 0 ? (transactions / shiftsCount) : transactions;
      const avgBasket = transactions > 0 ? totalRevenue / transactions : 0;
      const returnRate = transactions > 0 ? (returnsCount / transactions) * 100 : 0;

      return {
        id: member.id,
        name: member.full_name || member.username,
        role: member.role,
        transactionsPerShift,
        avgBasket,
        returnRate,
        totalRevenue
      };
    });

    return { success: true, data: mapped };
  } catch (error: any) {
    console.error('Failed to get staff performance data:', error);
    return { success: false, error: 'فشل جلب بيانات أداء الموظفين' };
  }
}
