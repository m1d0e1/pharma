'use client';

import React, { useState } from 'react';
import { 
  Users, 
  ShieldCheck, 
  Edit3, 
  Trash2, 
  X, 
  Save, 
  ChevronRight,
  ShoppingCart,
  Package,
  Wallet,
  Settings as SettingsIcon,
  Search,
  Lock,
  UserPlus,
  Info,
  Key,
  User as UserIcon,
  Box,
  BarChart3
} from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';

interface PermissionSet {
  // Personal Data
  national_id: string;
  address: string;
  birth_date: string;
  qualification: string;
  mobile: string;
  gender: string;
  social_status: string;
  is_delivery_rep: boolean;

  // Sales
  max_invoice_discount_percent: number;
  can_change_price_sale: boolean;
  can_exceed_max_sale_limit: boolean;
  can_view_stock_sale: boolean;
  can_sell_no_stock: boolean;
  can_give_total_discount: boolean;
  show_sales_report_invoice: boolean;
  show_suspended_invoices: boolean;
  can_change_price_return: boolean;
  preview_last_n_invoices: number;
  show_sale_price_return: boolean;
  can_sell_credit: boolean;
  show_contract_discounts: boolean;
  can_make_exchanges: boolean;
  can_change_contract_discounts: boolean;
  max_exchange_discount_percent: number;

  // Suspended
  suspended_can_add_item: boolean;
  suspended_can_delete: boolean;
  suspended_can_discount_item: boolean;
  suspended_can_modify_discount: boolean;
  suspended_can_pay_credit: boolean;
  suspended_can_change_delivery: boolean;
  suspended_can_save_invoice: boolean;

  // Purchases
  can_change_price_purchase: boolean;
  can_purchase_above_master_price: boolean;
  can_purchase_from_individuals: boolean;

  // Other
  can_change_pos_device: boolean;
  can_settle_multiple_lines: boolean;

  // Inventory (new tab)
  can_manage_inventory: boolean;
  show_stock_periodic_inventory: boolean;
  preview_item_movements: boolean;
  show_cost_price: boolean;
  can_modify_unit_conversion: boolean;

  // Reports (new tab)
  rep_can_view_sales: boolean;
  rep_can_view_purchases: boolean;
  rep_can_view_inventory: boolean;
  rep_can_view_financial: boolean;
  rep_can_view_activity: boolean;

  // Accounts
  can_select_pos_financial: boolean;
  show_own_financial_only: boolean;
  preview_drawer_details: boolean;
  hide_total_points_balance: boolean;
  
  // Detailed Accounts Permissions (from legacy)
  acc_can_view_general: boolean;
  acc_can_view_pos: boolean;
  acc_can_view_bank_accounts: boolean;
  acc_can_define_expenses: boolean;
  acc_can_process_cash_flow: boolean;
  acc_can_view_securities: boolean;
  acc_can_make_daily_entries: boolean;
  acc_can_view_notifications: boolean;
  acc_can_collect_credit_cards: boolean;
  acc_can_view_reports: boolean;
  show_total_sales_report: boolean;

  // Page level permissions
  can_view_low_stock: boolean;
  can_view_opening_balances: boolean;
  can_view_settlement: boolean;
  can_view_stores: boolean;
  can_view_patients: boolean;
  can_view_delivery: boolean;
  can_view_cogs: boolean;
  can_view_receipts: boolean;
  can_view_returns: boolean;
  can_view_purchases: boolean;
  can_view_shifts: boolean;
  can_view_restock: boolean;
  can_view_audit: boolean;
  can_view_settings: boolean;
  acc_can_view_handover: boolean;
  can_view_expenses: boolean;
  can_view_staff_manage: boolean;
  can_view_staff_roles: boolean;
}

const defaultPermissions: PermissionSet = {
  national_id: '',
  address: '',
  birth_date: '',
  qualification: '',
  mobile: '',
  gender: 'ذكر',
  social_status: 'أعزب',
  is_delivery_rep: false,

  max_invoice_discount_percent: 0,
  can_change_price_sale: false,
  can_exceed_max_sale_limit: false,
  can_view_stock_sale: true,
  can_sell_no_stock: false,
  can_give_total_discount: false,
  show_sales_report_invoice: false,
  show_suspended_invoices: true,
  can_change_price_return: false,
  preview_last_n_invoices: 1,
  show_sale_price_return: true,
  can_sell_credit: false,
  show_contract_discounts: false,
  can_make_exchanges: false,
  can_change_contract_discounts: false,
  max_exchange_discount_percent: 0,
  suspended_can_add_item: true,
  suspended_can_delete: true,
  suspended_can_discount_item: true,
  suspended_can_modify_discount: true,
  suspended_can_pay_credit: false,
  suspended_can_change_delivery: true,
  suspended_can_save_invoice: true,
  can_change_price_purchase: false,
  can_purchase_above_master_price: false,
  can_purchase_from_individuals: false,
  can_change_pos_device: false,
  can_settle_multiple_lines: false,
  can_manage_inventory: false,
  show_cost_price: false,
  show_stock_periodic_inventory: true,
  can_modify_unit_conversion: false,
  preview_item_movements: true,

  rep_can_view_sales: true,
  rep_can_view_purchases: true,
  rep_can_view_inventory: true,
  rep_can_view_financial: false,
  rep_can_view_activity: false,

  can_select_pos_financial: false,
  show_own_financial_only: true,
  preview_drawer_details: false,
  hide_total_points_balance: false,

  acc_can_view_general: true,
  acc_can_view_pos: true,
  acc_can_view_bank_accounts: false,
  acc_can_define_expenses: false,
  acc_can_process_cash_flow: true,
  acc_can_view_securities: false,
  acc_can_make_daily_entries: false,
  acc_can_view_notifications: true,
  acc_can_collect_credit_cards: true,
  acc_can_view_reports: true,
  show_total_sales_report: false,

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
  can_view_staff_roles: false,
};

const getOwnerPermissions = (): PermissionSet => {
  const perms = { ...defaultPermissions };
  Object.keys(perms).forEach(k => {
    const key = k as keyof PermissionSet;
    if (typeof perms[key] === 'boolean') {
      (perms as any)[key] = true;
    }
  });
  perms.max_invoice_discount_percent = 100;
  perms.max_exchange_discount_percent = 100;
  perms.preview_last_n_invoices = 999999;
  perms.show_own_financial_only = false;
  perms.hide_total_points_balance = false;
  perms.is_delivery_rep = false;
  return perms;
};

interface User {
  id: string;
  username: string;
  full_name: string;
  role: string;
  permissions: string; // JSON
  job_id?: number;
  qualification?: string;
  hire_date?: string;
  shift?: string;
  code?: string;
  job_name_ar?: string;
}

interface Props {
  users: User[];
  jobs: any[];
  onUpdatePermissions: (userId: string, permissions: PermissionSet) => Promise<{ success: boolean; error?: string }>;
  onAddUser: (data: any) => Promise<{ success: boolean; error?: string }>;
  onDeleteUser: (userId: string) => Promise<{ success: boolean; error?: string }>;
  onUpdateUser: (userId: string, data: any) => Promise<{ success: boolean; error?: string }>;
  onResetPassword: (userId: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
}

export default function StaffManagementClient({ users, jobs, onUpdatePermissions, onAddUser, onDeleteUser, onUpdateUser, onResetPassword }: Props) {
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState<User | null>(null);
  const [newTempPassword, setNewTempPassword] = useState('');
  const [newUser, setNewUser] = useState({ 
    username: '', 
    full_name: '', 
    role: 'pharmacist', 
    password: '',
    job_id: undefined as number | undefined,
    qualification: '',
    hire_date: '',
    shift: '',
    code: ''
  });
  const [editUser, setEditUser] = useState({ 
    username: '', 
    full_name: '', 
    role: '', 
    password: '',
    job_id: undefined as number | undefined,
    qualification: '',
    hire_date: '',
    shift: '',
    code: ''
  });
  const [editPermissions, setEditPermissions] = useState<PermissionSet>(defaultPermissions);
  const [activeTab, setActiveTab] = useState<'info' | 'personal' | 'sales' | 'suspended' | 'purchases' | 'inventory' | 'accounts' | 'reports' | 'other'>('info');
  const [isSaving, setIsSaving] = useState(false);

  const handleEdit = (user: User) => {
    setSelectedUser(user);
    setEditUser({ 
      username: user.username, 
      full_name: user.full_name, 
      role: user.role, 
      password: '',
      job_id: user.job_id,
      qualification: user.qualification || '',
      hire_date: user.hire_date || '',
      shift: user.shift || '',
      code: user.code || ''
    });
    try {
      if (user.role === 'owner') {
        const ownerPerms = getOwnerPermissions();
        let perms = {};
        try {
          perms = JSON.parse(user.permissions) || {};
        } catch (e) {}
        setEditPermissions({ ...ownerPerms, ...perms });
      } else {
        const perms = JSON.parse(user.permissions);
        setEditPermissions({ ...defaultPermissions, ...perms });
      }
    } catch (e) {
      setEditPermissions(user.role === 'owner' ? getOwnerPermissions() : defaultPermissions);
    }
    setActiveTab('info');
  };

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const editUserId = params.get('edit') || params.get('userId');
      const addParam = params.get('add');
      
      if (editUserId && users.length > 0) {
        const userToEdit = users.find(u => u.id === editUserId);
        if (userToEdit) {
          handleEdit(userToEdit);
          
          // Clear query params to prevent re-opening on reload/navigation
          const newUrl = window.location.pathname;
          window.history.replaceState({}, '', newUrl);
        }
      } else if (addParam === 'true') {
        setShowAddModal(true);
        
        // Clear query params to prevent re-opening on reload/navigation
        const newUrl = window.location.pathname;
        window.history.replaceState({}, '', newUrl);
      }
    }
  }, [users]);

  const handleToggle = (key: keyof PermissionSet) => {
    setEditPermissions(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const handleNumberChange = (key: keyof PermissionSet, value: string) => {
    setEditPermissions(prev => ({
      ...prev,
      [key]: parseInt(value) || 0
    }));
  };

  const saveAll = async () => {
    if (!selectedUser) return;
    setIsSaving(true);
    
    try {
      // Always save user info (role, username, password, etc.)
      const infoRes = await onUpdateUser(selectedUser.id, editUser);
      if (!infoRes.success) {
        toast.error(infoRes.error || 'فشل تحديث بيانات المستخدم');
        setIsSaving(false);
        return;
      }

      // Always save permissions too
      const permRes = await onUpdatePermissions(selectedUser.id, editPermissions);
      if (!permRes.success) {
        toast.error(permRes.error || 'فشل تحديث الصلاحيات');
        setIsSaving(false);
        return;
      }

      toast.success('تم حفظ جميع التغييرات بنجاح');
      setSelectedUser(null);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('حدث خطأ أثناء الحفظ');
    }
    
    setIsSaving(false);
  };

  const handleAddUser = async () => {
    if (!newUser.username || !newUser.full_name) {
      toast.error('يرجى ملء جميع البيانات الأساسية');
      return;
    }
    setIsSaving(true);
    const res = await onAddUser(newUser);
    if (res.success) {
      toast.success('تم إضافة الموظف بنجاح');
      setShowAddModal(false);
      setNewUser({ 
        username: '', 
        full_name: '', 
        role: 'pharmacist', 
        password: '',
        job_id: 0,
        qualification: '',
        hire_date: '',
        shift: '',
        code: ''
      });
    } else {
      toast.error(res.error || 'فشل إضافة الموظف');
    }
    setIsSaving(false);
  };

  const handleDelete = async (userId: string, name: string) => {
    if (!confirm(`هل أنت متأكد من حذف الموظف "${name}"؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    setIsSaving(true);
    const res = await onDeleteUser(userId);
    if (res.success) {
      toast.success('تم حذف الموظف بنجاح');
    } else {
      toast.error(res.error || 'فشل حذف الموظف');
    }
    setIsSaving(false);
  };

  const handleResetPassword = async () => {
    if (!showResetModal || !newTempPassword) return;
    setIsSaving(true);
    const res = await onResetPassword(showResetModal.id, newTempPassword);
    if (res.success) {
      toast.success('تم إعادة تعيين كلمة المرور بنجاح');
      setShowResetModal(null);
      setNewTempPassword('');
    } else {
      toast.error(res.error || 'فشل إعادة تعيين كلمة المرور');
    }
    setIsSaving(false);
  };

  const renderPermissionItem = (key: keyof PermissionSet, label: string) => (
    <label className="flex items-center gap-3 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-100 dark:border-slate-800/60 cursor-pointer hover:bg-white dark:hover:bg-slate-800 transition-all group hover:shadow-lg hover:shadow-primary-500/5">
      <div className={cn(
        "w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all",
        editPermissions[key] 
          ? 'bg-primary-600 border-primary-600 shadow-lg shadow-primary-500/20' 
          : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900'
      )}>
        {editPermissions[key] && <div className="w-2.5 h-2.5 bg-white rounded-full animate-in zoom-in" />}
      </div>
      <input 
        type="checkbox" 
        className="hidden" 
        checked={!!editPermissions[key]} 
        onChange={() => handleToggle(key)} 
      />
      <span className="text-sm font-bold text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-white">{label}</span>
    </label>
  );

  return (
    <div className="space-y-8" dir="rtl">
      {/* Premium Header Card */}
      <div className="bg-gradient-to-r from-primary-600 to-primary-800 dark:from-slate-800 dark:to-slate-900 p-8 rounded-[40px] shadow-2xl shadow-primary-500/10 flex flex-col md:flex-row justify-between items-center gap-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl" />
        <div className="relative z-10 flex items-center gap-6">
          <div className="w-16 h-16 bg-white/10 backdrop-blur-xl rounded-3xl flex items-center justify-center text-white border border-white/20">
            <Users className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-3xl font-black text-white tracking-tight">إدارة الكادر</h2>
            <p className="text-primary-100 dark:text-slate-400 font-bold">إدارة بيانات وصلاحيات فريق العمل في الصيدلية</p>
          </div>
        </div>
        <button 
          onClick={() => setShowAddModal(true)}
          className="relative z-10 px-10 py-5 bg-white text-primary-700 dark:bg-primary-600 dark:text-white rounded-[24px] font-black shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3 group"
        >
          <UserPlus className="w-6 h-6 group-hover:rotate-12 transition-transform" />
          إضافة موظف جديد
        </button>
      </div>

      {/* User Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {users.map(user => (
          <div key={user.id} className="bg-white dark:bg-slate-900/60 backdrop-blur-xl p-8 rounded-[40px] border border-slate-100 dark:border-slate-800/80 shadow-soft hover:shadow-hard hover:-translate-y-2 transition-all duration-500 group relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary-500/5 rounded-full -mr-16 -mt-16 group-hover:scale-150 transition-all duration-1000" />
            
            <div className="relative z-10 flex flex-col items-center">
              <div className="w-20 h-20 bg-gradient-to-br from-primary-100 to-primary-55 dark:from-primary-900/30 dark:to-primary-800/10 rounded-[28px] flex items-center justify-center text-primary-600 dark:text-primary-400 font-black text-3xl mb-4 border border-primary-100 dark:border-primary-900/30 shadow-lg group-hover:rotate-3 transition-transform">
                {user.full_name?.[0] || user.username[0].toUpperCase()}
              </div>
              
              <h3 className="font-black text-xl text-slate-900 dark:text-white mb-1">{user.full_name || user.username}</h3>
              <div className="flex items-center gap-2 mb-6">
                <span className="text-[10px] px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-full font-black text-slate-500 uppercase tracking-widest border border-slate-200 dark:border-slate-700">
                  {user.role}
                </span>
                <span className="text-[10px] px-3 py-1 bg-primary-50 dark:bg-primary-900/20 rounded-full font-black text-primary-600 dark:text-primary-400 border border-primary-100 dark:border-primary-800/30">
                  @{user.username}
                </span>
              </div>

              <div className="w-full flex gap-3">
                <button 
                  onClick={() => handleEdit(user)}
                  className="flex-1 py-4 bg-slate-900 dark:bg-primary-600 text-white rounded-[20px] font-black text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-primary-500/30 transition-all active:scale-95"
                >
                  <Edit3 className="w-4 h-4" />
                  تعديل
                </button>
                <button 
                  onClick={() => handleDelete(user.id, user.full_name || user.username)}
                  className="p-4 bg-rose-50 dark:bg-rose-900/10 text-rose-600 dark:text-rose-400 rounded-[20px] hover:bg-rose-600 hover:text-white dark:hover:bg-rose-500 dark:hover:text-white transition-all active:scale-95 group/del"
                  title="حذف الموظف"
                >
                  <Trash2 className="w-5 h-5 group-hover/del:scale-110 transition-transform" />
                </button>
                <button 
                  onClick={() => setShowResetModal(user)}
                  className="p-4 bg-amber-50 dark:bg-amber-900/10 text-amber-600 dark:text-amber-400 rounded-[20px] hover:bg-amber-600 hover:text-white dark:hover:bg-amber-500 dark:hover:text-white transition-all active:scale-95 group/key"
                  title="إعادة تعيين كلمة المرور"
                >
                  <Key className="w-5 h-5 group-hover/key:rotate-12 transition-transform" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Edit User/Permissions Modal */}
      {selectedUser && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[100] p-4 animate-in fade-in duration-300">
          <div className="bg-white dark:bg-slate-900 w-full max-w-5xl h-[85vh] rounded-[50px] shadow-hard border border-slate-100 dark:border-slate-800 flex flex-col overflow-hidden animate-in zoom-in duration-500">
            {/* Modal Header */}
            <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/30">
              <div className="flex items-center gap-5">
                <div className="p-5 bg-gradient-to-br from-primary-600 to-primary-700 rounded-[28px] text-white shadow-xl shadow-primary-500/20">
                  <Lock className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة الموظف</h2>
                  <p className="text-slate-500 font-bold flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    {selectedUser.full_name || selectedUser.username}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setSelectedUser(null)} 
                className="p-4 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-2xl hover:bg-rose-50 dark:hover:bg-rose-900/20 text-slate-400 hover:text-rose-500 transition-all"
              >
                <X className="w-7 h-7" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex flex-1 overflow-hidden">
              {/* Tabs Sidebar */}
              <div className="w-72 border-l border-slate-100 dark:border-slate-800 p-8 space-y-3 bg-slate-50/30 dark:bg-slate-900/50">
                {[
                  { id: 'info', label: 'حساب المستخدم', icon: Lock },
                  { id: 'personal', label: 'بيانات شخصية', icon: UserIcon },
                  { id: 'sales', label: 'المبيعات', icon: ShoppingCart },
                  { id: 'suspended', label: 'الفواتير المعلقة', icon: Edit3 },
                  { id: 'purchases', label: 'المشتريات', icon: Package },
                  { id: 'inventory', label: 'المخازن والمنتجات', icon: Box },
                  { id: 'accounts', label: 'الحسابات المادية', icon: Wallet },
                  { id: 'reports', label: 'التقارير والإحصاءات', icon: BarChart3 },
                  { id: 'other', label: 'خيارات أخرى', icon: SettingsIcon },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={cn(
                      "w-full flex items-center gap-4 px-6 py-4 rounded-[20px] font-black text-sm transition-all relative overflow-hidden",
                      activeTab === tab.id 
                        ? 'bg-primary-600 text-white shadow-xl shadow-primary-500/20' 
                        : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 dark:text-slate-400'
                    )}
                  >
                    <tab.icon className={cn("w-5 h-5 transition-transform", activeTab === tab.id && "scale-110")} />
                    {tab.label}
                    {activeTab === tab.id && (
                      <div className="absolute right-0 top-0 bottom-0 w-1.5 bg-white/20" />
                    )}
                  </button>
                ))}
              </div>

              {/* Content Area */}
              <div className="flex-1 overflow-auto p-10 bg-white dark:bg-slate-900 custom-scrollbar">
                {activeTab === 'info' && (
                  <div className="max-w-2xl mx-auto space-y-8 animate-in slide-in-from-left-4 duration-500">
                    <div className="bg-primary-50/50 dark:bg-primary-900/10 p-8 rounded-[32px] border border-primary-100/50 dark:border-primary-800/20 flex items-center gap-6 mb-8">
                       <div className="w-16 h-16 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 shadow-sm">
                          <Lock className="w-8 h-8" />
                       </div>
                       <div>
                          <h4 className="font-black text-slate-900 dark:text-white text-lg">صلاحيات دخول البرنامج</h4>
                          <p className="text-slate-500 text-sm font-bold">اسم المستخدم وكلمة المرور والدور الوظيفي</p>
                       </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الاسم الكامل</label>
                        <input 
                          type="text" 
                          value={editUser.full_name}
                          onChange={(e) => setEditUser(p => ({ ...p, full_name: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">اسم المستخدم</label>
                        <input 
                          type="text" 
                          value={editUser.username}
                          onChange={(e) => setEditUser(p => ({ ...p, username: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">كلمة المرور الجديدة</label>
                        <div className="relative">
                          <Key className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                          <input 
                            type="password" 
                            placeholder="اتركها فارغة لعدم التغيير"
                            value={editUser.password}
                            onChange={(e) => setEditUser(p => ({ ...p, password: e.target.value }))}
                            className="w-full pr-12 pl-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الدور الوظيفي</label>
                        <select 
                          value={editUser.role}
                          onChange={(e) => {
                            const newRole = e.target.value;
                            setEditUser(p => ({ ...p, role: newRole }));
                            if (newRole === 'owner') {
                              setEditPermissions(getOwnerPermissions());
                            }
                          }}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none appearance-none"
                        >
                          <option value="pharmacist">صيدلي (Pharmacist)</option>
                          <option value="admin">مدير نظام (Admin)</option>
                          <option value="owner">مالك (Owner)</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الوظيفة</label>
                        <select 
                          value={editUser.job_id || ''}
                          onChange={(e) => setEditUser(p => ({ ...p, job_id: parseInt(e.target.value) || undefined }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none appearance-none"
                        >
                          <option value="">بدون وظيفة</option>
                          {jobs.map(job => (
                            <option key={job.id} value={job.id}>{job.name_ar}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">كود الموظف</label>
                        <input 
                          type="text" 
                          value={editUser.code}
                          onChange={(e) => setEditUser(p => ({ ...p, code: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'personal' && (
                  <div className="max-w-4xl mx-auto space-y-10 animate-in slide-in-from-left-4 duration-500">
                    <div className="bg-emerald-50/50 dark:bg-emerald-900/10 p-8 rounded-[32px] border border-emerald-100/50 dark:border-emerald-800/20 flex items-center gap-6 mb-8">
                       <div className="w-16 h-16 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-emerald-600 shadow-sm">
                          <UserIcon className="w-8 h-8" />
                       </div>
                       <div>
                          <h4 className="font-black text-slate-900 dark:text-white text-lg">البيانات الشخصية والوظيفية</h4>
                          <p className="text-slate-500 text-sm font-bold">المعلومات الإدارية للموظف في الصيدلية</p>
                       </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الرقم القومي</label>
                        <input 
                          type="text" 
                          value={editPermissions.national_id}
                          onChange={(e) => setEditPermissions(p => ({ ...p, national_id: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">تاريخ الميلاد</label>
                        <input 
                          type="date" 
                          value={editPermissions.birth_date}
                          onChange={(e) => setEditPermissions(p => ({ ...p, birth_date: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">المؤهل الدراسي</label>
                        <input 
                          type="text" 
                          value={editUser.qualification}
                          onChange={(e) => setEditUser(p => ({ ...p, qualification: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">تاريخ التعيين</label>
                        <input 
                          type="date" 
                          value={editUser.hire_date}
                          onChange={(e) => setEditUser(p => ({ ...p, hire_date: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الوردية (Shift)</label>
                        <input 
                          type="text" 
                          value={editUser.shift}
                          onChange={(e) => setEditUser(p => ({ ...p, shift: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                          placeholder="مثال: وردية 1"
                        />
                      </div>
                      <div className="space-y-2 lg:col-span-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">العنوان الحالي</label>
                        <input 
                          type="text" 
                          value={editPermissions.address}
                          onChange={(e) => setEditPermissions(p => ({ ...p, address: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الموبايل</label>
                        <input 
                          type="text" 
                          value={editPermissions.mobile}
                          onChange={(e) => setEditPermissions(p => ({ ...p, mobile: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">النوع</label>
                        <select 
                          value={editPermissions.gender}
                          onChange={(e) => setEditPermissions(p => ({ ...p, gender: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        >
                          <option value="ذكر">ذكر</option>
                          <option value="أنثى">أنثى</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">الحالة الاجتماعية</label>
                        <select 
                          value={editPermissions.social_status}
                          onChange={(e) => setEditPermissions(p => ({ ...p, social_status: e.target.value }))}
                          className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-primary-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                        >
                          <option value="أعزب">أعزب</option>
                          <option value="متزوج">متزوج</option>
                          <option value="مطلق">مطلق</option>
                          <option value="أرمل">أرمل</option>
                        </select>
                      </div>
                      <div className="lg:col-span-3 pt-4">
                        {renderPermissionItem('is_delivery_rep', 'هذا الموظف يعمل كمندوب توصيل (Delivery)')}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab !== 'info' && activeTab !== 'personal' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-in slide-in-from-right-4 duration-500">
                    {activeTab === 'sales' && (
                      <>
                        <div className="col-span-2 p-8 bg-gradient-to-br from-primary-50 to-white dark:from-slate-800/40 dark:to-slate-900 rounded-[32px] border border-primary-100/50 dark:border-primary-900/20 flex justify-between items-center mb-4">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-primary-100 dark:bg-primary-900/30 rounded-2xl flex items-center justify-center text-primary-600">
                               <ShoppingCart className="w-6 h-6" />
                            </div>
                            <span className="font-black text-slate-900 dark:text-white">أقصى خصم مسموح به للفاتورة (%)</span>
                          </div>
                          <input 
                            type="number" 
                            value={editPermissions.max_invoice_discount_percent}
                            onChange={(e) => handleNumberChange('max_invoice_discount_percent', e.target.value)}
                            className="w-24 p-4 text-center bg-white dark:bg-slate-800 border-2 border-primary-100 dark:border-primary-800 rounded-2xl font-black text-primary-600 outline-none focus:border-primary-500 shadow-sm"
                          />
                        </div>
                        {renderPermissionItem('can_change_price_sale', 'تغيير الأسعار أثناء البيع')}
                        {renderPermissionItem('can_exceed_max_sale_limit', 'تجاوز الحد الأقصى للبيع')}
                        {renderPermissionItem('can_view_stock_sale', 'رؤية رصيد الصنف أثناء البيع')}
                        {renderPermissionItem('can_sell_no_stock', 'بيع أصناف ليس لها رصيد')}
                        {renderPermissionItem('can_give_total_discount', 'إعطاء خصومات على الإجمالي')}
                        {renderPermissionItem('show_sales_report_invoice', 'إظهار تقرير المبيعات في الفاتورة')}
                        {renderPermissionItem('show_suspended_invoices', 'إظهار الفواتير المعلقة')}
                        {renderPermissionItem('can_change_price_return', 'تغيير السعر في المرتجع')}
                        {renderPermissionItem('show_sale_price_return', 'إظهار سعر البيع في المرتجع')}
                        {renderPermissionItem('can_sell_credit', 'البيع بالأجل')}
                        {renderPermissionItem('show_contract_discounts', 'إظهار خصومات التعاقدات')}
                        {renderPermissionItem('can_make_exchanges', 'عمل استبدالات في الفاتورة')}
                        {renderPermissionItem('can_change_contract_discounts', 'تغيير خصومات التعاقدات')}
                        {renderPermissionItem('can_view_delivery', 'معاينة وإدارة التوصيل المنزلي')}
                        {renderPermissionItem('can_view_cogs', 'معاينة وتعديل تكلفة المبيعات')}
                        {renderPermissionItem('can_view_receipts', 'معاينة سجل الفواتير والتقارير')}
                        {renderPermissionItem('can_view_returns', 'معاينة وإجراء المرتجعات')}
                      </>
                    )}

                    {activeTab === 'suspended' && (
                      <>
                        {renderPermissionItem('suspended_can_add_item', 'إضافة صنف للفاتورة المعلقة')}
                        {renderPermissionItem('suspended_can_delete', 'حذف الفاتورة المعلقة')}
                        {renderPermissionItem('suspended_can_discount_item', 'عمل خصم على صنف معلق')}
                        {renderPermissionItem('suspended_can_modify_discount', 'تعديل خصم صنف معلق')}
                        {renderPermissionItem('suspended_can_pay_credit', 'سداد الفاتورة المعلقة آجل')}
                        {renderPermissionItem('suspended_can_change_delivery', 'تغيير مندوب التوصيل')}
                        {renderPermissionItem('suspended_can_save_invoice', 'حفظ الفواتير المعلقة')}
                      </>
                    )}

                    {activeTab === 'purchases' && (
                      <>
                        {renderPermissionItem('can_change_price_purchase', 'تغيير الأسعار أثناء الشراء')}
                        {renderPermissionItem('can_purchase_above_master_price', 'الشراء بسعر أعلى من المحدد')}
                        {renderPermissionItem('can_purchase_from_individuals', 'الشراء من أفراد')}
                        {renderPermissionItem('can_view_purchases', 'الوصول لصفحة المشتريات الرئيسية')}
                      </>
                    )}

                    {activeTab === 'inventory' && (
                      <>
                        <div className="col-span-2 mb-6">
                           <div className="flex items-center gap-4 p-6 bg-slate-50 dark:bg-slate-800/40 rounded-[28px] border border-slate-100 dark:border-slate-800/60">
                              <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 shadow-sm">
                                 <Box className="w-6 h-6" />
                              </div>
                              <div>
                                 <h4 className="font-black text-slate-900 dark:text-white">إدارة المخازن والأصناف</h4>
                                 <p className="text-slate-500 text-xs font-bold mt-0.5">التحكم في بيانات الأدوية والمخزون والجرد</p>
                              </div>
                           </div>
                        </div>
                        {renderPermissionItem('can_manage_inventory', 'إمكانية إدارة الأصناف (إضافة/تعديل)')}
                        {renderPermissionItem('show_stock_periodic_inventory', 'إمكانية جرد المخزون')}
                        {renderPermissionItem('preview_item_movements', 'معاينة حركات الأصناف')}
                        {renderPermissionItem('show_cost_price', 'رؤية سعر التكلفة')}
                        {renderPermissionItem('can_modify_unit_conversion', 'إمكانية تعديل معاملات التحويل')}
                        {renderPermissionItem('can_view_low_stock', 'معاينة النواقص (Low Stock)')}
                        {renderPermissionItem('can_view_opening_balances', 'معاينة الأرصدة الإفتتاحية')}
                        {renderPermissionItem('can_view_settlement', 'معاينة تسوية المخزون')}
                        {renderPermissionItem('can_view_stores', 'معاينة شاشة المخازن الرئيسية')}
                        {renderPermissionItem('can_view_restock', 'معاينة شاشة إعادة التموين')}
                      </>
                    )}

                    {activeTab === 'accounts' && (
                      <>
                        <div className="col-span-2 mb-6">
                           <div className="flex items-center gap-4 p-6 bg-slate-50 dark:bg-slate-800/40 rounded-[28px] border border-slate-100 dark:border-slate-800/60">
                              <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 shadow-sm">
                                 <Wallet className="w-6 h-6" />
                              </div>
                              <div>
                                 <h4 className="font-black text-slate-900 dark:text-white">صلاحيات النظام المالي والحسابات</h4>
                                 <p className="text-slate-500 text-xs font-bold mt-0.5">التحكم في الوصول للعمليات المالية والتقارير المحاسبية</p>
                              </div>
                           </div>
                        </div>
                        {renderPermissionItem('acc_can_view_general', 'الوصول للحسابات العامة')}
                        {renderPermissionItem('acc_can_view_pos', 'نقطة البيع (المالية)')}
                        {renderPermissionItem('acc_can_view_bank_accounts', 'الحسابات البنكية')}
                        {renderPermissionItem('acc_can_define_expenses', 'تعريف المصروفات')}
                        {renderPermissionItem('acc_can_process_cash_flow', 'صرف وتوريد نقدية')}
                        {renderPermissionItem('acc_can_view_securities', 'حركة الأوراق المالية')}
                        {renderPermissionItem('acc_can_make_daily_entries', 'القيود اليومية')}
                        {renderPermissionItem('acc_can_view_notifications', 'الإشعارات المالية')}
                        {renderPermissionItem('acc_can_collect_credit_cards', 'تحصيل بطاقات إئتمان')}
                        {renderPermissionItem('acc_can_view_reports', 'تقارير الحسابات المحاسبية')}
                        
                        <div className="col-span-2 h-px bg-slate-100 dark:bg-slate-800 my-4" />
                        
                        {renderPermissionItem('can_select_pos_financial', 'إختيار نقطة البيع في الحسابات')}
                        {renderPermissionItem('show_own_financial_only', 'رؤية الحركات المالية الخاصة فقط')}
                        {renderPermissionItem('preview_drawer_details', 'معاينة تفاصيل تسليم الدرج')}
                        {renderPermissionItem('hide_total_points_balance', 'إخفاء الإجمالي ورصيد النقاط')}
                        {renderPermissionItem('acc_can_view_handover', 'معاينة وإجراء تسليم الدرج')}
                      </>
                    )}

                    {activeTab === 'reports' && (
                      <>
                        <div className="col-span-2 mb-6">
                           <div className="flex items-center gap-4 p-6 bg-slate-50 dark:bg-slate-800/40 rounded-[28px] border border-slate-100 dark:border-slate-800/60">
                              <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 shadow-sm">
                                 <BarChart3 className="w-6 h-6" />
                              </div>
                              <div>
                                 <h4 className="font-black text-slate-900 dark:text-white">نظام التقارير والإحصائيات</h4>
                                 <p className="text-slate-500 text-xs font-bold mt-0.5">تحديد التقارير المسموح للموظف بالاطلاع عليها</p>
                              </div>
                           </div>
                        </div>
                        {renderPermissionItem('rep_can_view_sales', 'تقارير المبيعات')}
                        {renderPermissionItem('rep_can_view_purchases', 'تقارير المشتريات')}
                        {renderPermissionItem('rep_can_view_inventory', 'تقارير المخازن')}
                        {renderPermissionItem('rep_can_view_financial', 'تقارير الحسابات والمالية')}
                        {renderPermissionItem('rep_can_view_activity', 'تقارير مراقبة النشاط')}
                        {renderPermissionItem('show_sales_report_invoice', 'إظهار تقرير المبيعات في الفاتورة')}
                        {renderPermissionItem('show_total_sales_report', 'تقرير إجمالي المبيعات')}
                      </>
                    )}

                    {activeTab === 'other' && (
                      <>
                        <div className="col-span-2 mb-6">
                           <div className="flex items-center gap-4 p-6 bg-slate-50 dark:bg-slate-800/40 rounded-[28px] border border-slate-100 dark:border-slate-800/60">
                              <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center text-primary-600 shadow-sm">
                                 <SettingsIcon className="w-6 h-6" />
                              </div>
                              <div>
                                 <h4 className="font-black text-slate-900 dark:text-white">خيارات إضافية ونظام التشغيل</h4>
                                 <p className="text-slate-500 text-xs font-bold mt-0.5">إعدادات متفرقة تخص طريقة عمل البرنامج</p>
                              </div>
                           </div>
                        </div>
                        {renderPermissionItem('can_change_pos_device', 'تغيير نقطة البيع للجهاز')}
                        {renderPermissionItem('can_settle_multiple_lines', 'تسوية بنود متعددة')}
                        {renderPermissionItem('can_view_shifts', 'معاينة الشفتات النقدية')}
                        {renderPermissionItem('can_view_audit', 'معاينة سجل المراقبة')}
                        {renderPermissionItem('can_view_settings', 'معاينة وإدارة الإعدادات')}
                        {renderPermissionItem('can_view_patients', 'معاينة وإدارة دليل المرضى')}
                        {renderPermissionItem('can_view_expenses', 'معاينة شاشة المصروفات والأرباح')}
                        {renderPermissionItem('can_view_staff_manage', 'معاينة وإدارة الموظفين')}
                        {renderPermissionItem('can_view_staff_roles', 'معاينة وإدارة المسمى الوظيفي والوظائف')}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-10 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex justify-end gap-5">
              <button 
                onClick={() => setSelectedUser(null)}
                className="px-10 py-5 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-[24px] font-black text-slate-700 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-700 transition-all active:scale-95"
              >
                إلغاء
              </button>
              <button 
                onClick={saveAll}
                disabled={isSaving}
                className="px-14 py-5 bg-primary-600 text-white rounded-[24px] font-black shadow-2xl shadow-primary-500/30 hover:bg-primary-700 hover:-translate-y-1 transition-all flex items-center gap-3 disabled:bg-slate-400 active:scale-95"
              >
                {isSaving ? 'جاري الحفظ...' : <><Save className="w-6 h-6" /> حفظ التغييرات</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add User Modal - Updated with Premium Styling */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[100] p-4 animate-in fade-in duration-300">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[50px] shadow-hard border border-slate-100 dark:border-slate-800 flex flex-col overflow-hidden animate-in zoom-in duration-500">
            <div className="p-10 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex justify-between items-center">
              <div className="flex items-center gap-4">
                <div className="p-4 bg-primary-600 rounded-2xl text-white">
                  <UserPlus className="w-6 h-6" />
                </div>
                <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">إضافة موظف</h2>
              </div>
              <button onClick={() => setShowAddModal(false)} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl transition-all">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <div className="p-10 space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase tracking-widest">الاسم الكامل</label>
                <input 
                  type="text" 
                  value={newUser.full_name}
                  onChange={(e) => setNewUser(p => ({ ...p, full_name: e.target.value }))}
                  className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500 rounded-[20px] font-bold outline-none transition-all dark:text-white"
                  placeholder="مثال: د. محمد علي"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase tracking-widest">اسم المستخدم</label>
                <input 
                  type="text" 
                  value={newUser.username}
                  onChange={(e) => setNewUser(p => ({ ...p, username: e.target.value }))}
                  className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500 rounded-[20px] font-bold outline-none transition-all dark:text-white"
                  placeholder="m_ali"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase tracking-widest">كلمة المرور</label>
                <input 
                  type="password" 
                  value={newUser.password}
                  onChange={(e) => setNewUser(p => ({ ...p, password: e.target.value }))}
                  className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500 rounded-[20px] font-bold outline-none transition-all dark:text-white"
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase tracking-widest">الدور الوظيفي</label>
                <select 
                  value={newUser.role}
                  onChange={(e) => setNewUser(p => ({ ...p, role: e.target.value }))}
                  className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-primary-500 rounded-[20px] font-bold outline-none transition-all dark:text-white appearance-none"
                >
                  <option value="pharmacist">صيدلي (Pharmacist)</option>
                  <option value="admin">مدير نظام (Admin)</option>
                  <option value="owner">مالك (Owner)</option>
                </select>
              </div>
            </div>
            <div className="p-10 bg-slate-50/50 dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-800 flex gap-4">
              <button 
                onClick={() => setShowAddModal(false)}
                className="flex-1 py-5 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-[24px] font-black transition-all active:scale-95 dark:text-white"
              >
                إلغاء
              </button>
              <button 
                onClick={handleAddUser}
                disabled={isSaving}
                className="flex-1 py-5 bg-primary-600 text-white rounded-[24px] font-black shadow-xl shadow-primary-500/20 hover:bg-primary-700 disabled:bg-slate-400 transition-all active:scale-95"
              >
                {isSaving ? 'جاري الحفظ...' : 'حفظ الموظف'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Reset Password Modal */}
      {showResetModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[110] p-4 animate-in fade-in duration-300">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in duration-500">
            <div className="p-8 border-b border-slate-100 dark:border-slate-800 bg-amber-50/50 dark:bg-amber-900/10 flex justify-between items-center">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center text-amber-600">
                  <Key className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-black text-xl text-slate-900 dark:text-white">إعادة تعيين المرور</h3>
                  <p className="text-amber-600 text-xs font-bold">{showResetModal.full_name || showResetModal.username}</p>
                </div>
              </div>
              <button onClick={() => setShowResetModal(null)} className="text-slate-400 hover:text-rose-500 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 mr-4 uppercase tracking-widest">كلمة المرور الجديدة</label>
                <input 
                  type="text" 
                  value={newTempPassword}
                  onChange={(e) => setNewTempPassword(e.target.value)}
                  placeholder="أدخل كلمة المرور الجديدة"
                  className="w-full px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-2 border-transparent focus:border-amber-500 rounded-2xl font-bold dark:text-white transition-all outline-none"
                  autoFocus
                />
                <p className="text-[10px] text-slate-400 font-bold px-4 mt-2">يجب أن تكون كلمة المرور 6 أحرف على الأقل وتكون قوية.</p>
              </div>

              <div className="flex gap-4">
                <button 
                  onClick={handleResetPassword}
                  disabled={isSaving || newTempPassword.length < 6}
                  className="flex-1 py-4 bg-amber-600 text-white rounded-[20px] font-black hover:bg-amber-700 shadow-lg shadow-amber-500/20 disabled:opacity-50 transition-all active:scale-95"
                >
                  {isSaving ? 'جاري الحفظ...' : 'تأكيد التغيير'}
                </button>
                <button 
                  onClick={() => setShowResetModal(null)}
                  className="flex-1 py-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-[20px] font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
