'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hashPassword } from '@/lib/auth/local';
import StaffManagementClient from '@/components/admin/StaffManagementClient';
import { 
  updateUserPermissionsAction, 
  addUserAction, 
  deleteUserAction, 
  updateUserAction, 
  resetUserPasswordAction,
  getStaffManagementDataAction
} from '@/app/actions/users';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import AccessDenied from '@/components/AccessDenied';
import { dbSelect, dbExecute } from '@/lib/db/tauri';
import { hasUserPermissionSync } from '@/lib/auth/local';

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

export default function StaffManagePage() {
  const [user, setUser] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

  async function loadData() {
    try {
      if (isTauri) {
        const u = await dbSelect(`
          SELECT u.*, ej.name_ar as job_name_ar 
          FROM users u
          LEFT JOIN employee_jobs ej ON u.job_id = ej.id
        `);
        setUsers(u || []);

        const j = await dbSelect('SELECT * FROM employee_jobs ORDER BY name_ar ASC');
        setJobs(j || []);
      } else {
        const res = await getStaffManagementDataAction();
        if (res.success) {
          setUsers((res as any).users || []);
          setJobs((res as any).jobs || []);
        } else {
          console.error((res as any).error);
        }
      }
    } catch (err) {
      console.error('Failed to load users management data:', err);
    }
  }

  useEffect(() => {
    async function initPage() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        const isAllowed = hasUserPermissionSync(localUser, 'can_view_staff_manage');
        if (isAllowed) {
          await loadData();
        }
      } catch (err) {
        console.error('Failed to initialize manage page:', err);
      } finally {
        setLoading(false);
      }
    }

    initPage();
  }, []);

  const handleUpdatePermissions = async (userId: string, permissions: any) => {
    if (isTauri) {
      try {
        let permissionsToSave = permissions;
        const targetUserObj = await dbSelect('SELECT role FROM users WHERE id = ?', [userId]);
        await dbExecute('UPDATE users SET permissions = ? WHERE id = ?', [JSON.stringify(permissionsToSave), userId]);
        await dbExecute("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'UPDATE_PERMISSIONS', ?)", 
          [user.id, `حدث صلاحيات المستخدم: ${userId}`]);
        await loadData();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    const res = await updateUserPermissionsAction(userId, permissions);
    if (res.success) await loadData();
    return res;
  };

  const handleAddUser = async (formData: any) => {
    if (isTauri) {
      try {
        const existing = await dbSelect('SELECT id FROM users WHERE username = ?', [formData.username]);
        if (existing.length > 0) return { success: false, error: 'اسم المستخدم موجود مسبقاً' };

        const id = crypto.randomUUID();
        const passwordHash = formData.password ? await hashPassword(formData.password) : null;
        
        // Default permissions based on role
        const defaultPerms = formData.role === 'pharmacist' ? {
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
          acc_can_view_handover: true
        } : formData.role === 'admin' ? {
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
          acc_can_view_handover: true
        } : formData.role === 'owner' ? defaultOwnerPerms : {};

        await dbExecute(`
          INSERT INTO users (id, username, full_name, role, password_hash, permissions, job_id, qualification, hire_date, shift, code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id, 
          formData.username, 
          formData.full_name, 
          formData.role, 
          passwordHash, 
          JSON.stringify(defaultPerms), 
          formData.job_id || null, 
          formData.qualification || null, 
          formData.hire_date || null, 
          formData.shift || null, 
          formData.code || null
        ]);

        await dbExecute("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'ADD_USER', ?)",
          [user.id, `أضاف مستخدماً جديداً: ${formData.username} (${formData.role})`]);

        await loadData();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    const res = await addUserAction(formData);
    if (res.success) await loadData();
    return res;
  };

  const handleDeleteUser = async (userId: string) => {
    if (isTauri) {
      if (user.id === userId) return { success: false, error: 'لا يمكنك حذف حسابك الخاص' };
      try {
        await dbExecute('DELETE FROM users WHERE id = ?', [userId]);
        await dbExecute("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'DELETE_USER', ?)",
          [user.id, `حذف المستخدم: ${userId}`]);
        await loadData();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    const res = await deleteUserAction(userId);
    if (res.success) await loadData();
    return res;
  };

  const handleUpdateUser = async (userId: string, data: any) => {
    if (isTauri) {
      try {
        const existing = await dbSelect('SELECT id FROM users WHERE username = ? AND id != ?', [data.username, userId]);
        if (existing.length > 0) return { success: false, error: 'اسم المستخدم موجود مسبقاً' };

        // Only update user profile fields — permissions are saved separately by handleUpdatePermissions
        if (data.password) {
          const passwordHash = await hashPassword(data.password);
          await dbExecute(`
            UPDATE users 
            SET username = ?, full_name = ?, role = ?, password_hash = ?, job_id = ?, qualification = ?, hire_date = ?, shift = ?, code = ? 
            WHERE id = ?
          `, [
            data.username, 
            data.full_name, 
            data.role, 
            passwordHash, 
            data.job_id || null, 
            data.qualification || null, 
            data.hire_date || null, 
            data.shift || null, 
            data.code || null, 
            userId
          ]);
        } else {
          await dbExecute(`
            UPDATE users 
            SET username = ?, full_name = ?, role = ?, job_id = ?, qualification = ?, hire_date = ?, shift = ?, code = ? 
            WHERE id = ?
          `, [
            data.username, 
            data.full_name, 
            data.role, 
            data.job_id || null, 
            data.qualification || null, 
            data.hire_date || null, 
            data.shift || null, 
            data.code || null, 
            userId
          ]);
        }

        await dbExecute("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'UPDATE_USER', ?)",
          [user.id, `حدث بيانات المستخدم: ${data.username}`]);

        await loadData();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    const res = await updateUserAction(userId, data);
    if (res.success) await loadData();
    return res;
  };

  const handleResetPassword = async (userId: string, newPassword: string) => {
    if (isTauri) {
      try {
        const passwordHash = await hashPassword(newPassword);
        await dbExecute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
        await dbExecute("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'PASSWORD_RESET', ?)",
          [user.id, `إعادة تعيين كلمة مرور المستخدم: ${userId}`]);
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    return await resetUserPasswordAction(userId, newPassword);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !hasUserPermissionSync(user, 'can_view_staff_manage')) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <Link href="/staff" className="p-3 bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 transition-all">
            <ArrowRight className="w-6 h-6 text-slate-600" />
          </Link>
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة الموظفين</h1>
            <p className="text-slate-500 font-bold">التحكم في صلاحيات الوصول والمهام.</p>
          </div>
        </div>
      </div>

      <StaffManagementClient 
        users={users} 
        jobs={jobs}
        onUpdatePermissions={handleUpdatePermissions} 
        onAddUser={handleAddUser}
        onDeleteUser={handleDeleteUser}
        onUpdateUser={handleUpdateUser}
        onResetPassword={handleResetPassword}
      />
    </div>
  );
}
