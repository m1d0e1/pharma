'use client';

import React, { useState, useMemo } from 'react';
import { 
  Truck, Plus, Search, DollarSign, CreditCard, 
  Trash2, Edit, X, Save, Phone, MapPin, 
  CheckCircle2, Clock, FileText, ArrowDownLeft, 
  Wallet, RefreshCw, AlertTriangle, ChevronRight
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { 
  addSupplierPaymentAction, 
  getSupplierTransactionsAction 
} from '@/app/actions-client/purchases';

export interface SupplierItem {
  id: number;
  name_ar: string;
  name_en?: string;
  phone?: string;
  address?: string;
  balance: number;
  purchase_count?: number;
  transaction_count?: number;
  created_at?: string;
}

interface Props {
  initialData: SupplierItem[];
  onAdd: (data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => Promise<{ success: boolean; id?: any; error?: string }>;
  onUpdate: (id: number, data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => Promise<{ success: boolean; error?: string }>;
  onDelete: (id: number) => Promise<{ success: boolean; error?: string }>;
  onRefresh: () => Promise<void>;
}

export default function SuppliersManagementClient({
  initialData,
  onAdd,
  onUpdate,
  onDelete,
  onRefresh
}: Props) {
  const [suppliers, setSuppliers] = useState<SupplierItem[]>(initialData);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'debit' | 'clear'>('all');
  
  // Modals
  const [isAddEditOpen, setIsAddEditOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<SupplierItem | null>(null);
  const [formData, setFormData] = useState({ name_ar: '', name_en: '', phone: '', address: '' });
  const [isSavingSupplier, setIsSavingSupplier] = useState(false);

  // Payment Modal
  const [paymentSupplier, setPaymentSupplier] = useState<SupplierItem | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank' | 'check'>('cash');
  const [checkNumber, setCheckNumber] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);

  // Statement / History Modal
  const [statementSupplier, setStatementSupplier] = useState<SupplierItem | null>(null);
  const [statementTransactions, setStatementTransactions] = useState<any[]>([]);
  const [isLoadingStatement, setIsLoadingStatement] = useState(false);

  React.useEffect(() => {
    setSuppliers(initialData);
  }, [initialData]);

  // Statistics
  const totalSuppliers = suppliers.length;
  const totalDebit = useMemo(() => {
    return suppliers.reduce((sum, s) => sum + Math.max(0, Number(s.balance || 0)), 0);
  }, [suppliers]);
  const suppliersWithDebit = useMemo(() => {
    return suppliers.filter(s => Number(s.balance || 0) > 0).length;
  }, [suppliers]);

  // Filtered Suppliers
  const filteredSuppliers = useMemo(() => {
    return suppliers.filter(s => {
      const matchesSearch = 
        s.name_ar.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (s.name_en && s.name_en.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (s.phone && s.phone.includes(searchTerm)) ||
        (s.address && s.address.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      const balance = Number(s.balance || 0);
      if (filterType === 'debit') return balance > 0;
      if (filterType === 'clear') return balance <= 0;
      return true;
    });
  }, [suppliers, searchTerm, filterType]);

  // Add / Edit Handlers
  const handleOpenAdd = () => {
    setEditingSupplier(null);
    setFormData({ name_ar: '', name_en: '', phone: '', address: '' });
    setIsAddEditOpen(true);
  };

  const handleOpenEdit = (s: SupplierItem) => {
    setEditingSupplier(s);
    setFormData({ 
      name_ar: s.name_ar, 
      name_en: s.name_en || '', 
      phone: s.phone || '', 
      address: s.address || '' 
    });
    setIsAddEditOpen(true);
  };

  const handleSaveSupplier = async () => {
    if (!formData.name_ar.trim()) {
      toast.error('يرجى إدخال اسم المورد بالعربي');
      return;
    }
    setIsSavingSupplier(true);
    try {
      if (editingSupplier) {
        const res = await onUpdate(editingSupplier.id, formData);
        if (res.success) {
          toast.success('تم تحديث بيانات المورد بنجاح');
          setIsAddEditOpen(false);
          await onRefresh();
        } else {
          toast.error(res.error || 'فشل التحديث');
        }
      } else {
        const res = await onAdd(formData);
        if (res.success) {
          toast.success('تمت إضافة المورد بنجاح');
          setIsAddEditOpen(false);
          await onRefresh();
        } else {
          toast.error(res.error || 'فشل إضافة المورد');
        }
      }
    } catch {
      toast.error('حدث خطأ أثناء الحفظ');
    } finally {
      setIsSavingSupplier(false);
    }
  };

  const handleDeleteSupplier = async (id: number) => {
    if (!confirm('هل أنت متأكد من رغبتك في حذف هذا المورد؟')) return;
    try {
      const res = await onDelete(id);
      if (res.success) {
        toast.success('تم حذف المورد بنجاح');
        await onRefresh();
      } else {
        toast.error(res.error || 'فشل حذف المورد');
      }
    } catch {
      toast.error('حدث خطأ أثناء الحذف');
    }
  };

  // Payment Handlers
  const handleOpenPayment = (s: SupplierItem) => {
    setPaymentSupplier(s);
    const balance = Math.max(0, Number(s.balance || 0));
    setPaymentAmount(balance > 0 ? String(balance) : '');
    setPaymentMethod('cash');
    setCheckNumber('');
    setPaymentNotes('');
    setPaymentDate(new Date().toISOString().split('T')[0]);
  };

  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentSupplier) return;

    const amount = Number(paymentAmount);
    if (!amount || amount <= 0) {
      toast.error('يرجى إدخال مبلغ دفع صحيح أكبر من الصفر');
      return;
    }

    setIsProcessingPayment(true);
    try {
      const res = await addSupplierPaymentAction({
        supplier_id: paymentSupplier.id,
        amount,
        payment_method: paymentMethod,
        check_number: checkNumber,
        notes: paymentNotes,
        date: paymentDate
      });

      if (res.success) {
        toast.success(`تم سداد ${amount.toLocaleString()} ج.م للمورد ${paymentSupplier.name_ar} بنجاح`);
        setPaymentSupplier(null);
        await onRefresh();
      } else {
        toast.error(res.error || 'فشل تسجيل الدفعة');
      }
    } catch {
      toast.error('حدث خطأ أثناء تنفيذ عملية السداد');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  // Statement / History Handlers
  const handleOpenStatement = async (s: SupplierItem) => {
    setStatementSupplier(s);
    setIsLoadingStatement(true);
    try {
      const res = await getSupplierTransactionsAction(s.id);
      if (res.success) {
        setStatementTransactions(res.data || []);
      } else {
        toast.error(res.error || 'فشل جلب كشف الحساب');
      }
    } catch {
      toast.error('حدث خطأ أثناء جلب كشف الحساب');
    } finally {
      setIsLoadingStatement(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500" dir="rtl">
      {/* Header & KPI Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">إجمالي الموردين</p>
            <h3 className="text-3xl font-black text-slate-900 dark:text-white mt-1">{totalSuppliers}</h3>
            <p className="text-xs text-slate-400 font-bold mt-1">موردين مسجلين بالنظام</p>
          </div>
          <div className="w-14 h-14 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center text-2xl">
            <Truck className="w-7 h-7" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center justify-between border-r-8 border-r-rose-500">
          <div>
            <p className="text-xs font-black text-rose-500 uppercase tracking-widest">إجمالي مديونية الموردين</p>
            <h3 className="text-3xl font-black text-rose-600 dark:text-rose-400 mt-1">
              {totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm font-bold">ج.م</span>
            </h3>
            <p className="text-xs text-rose-400 font-bold mt-1">{suppliersWithDebit} موردين لهم مستحقات</p>
          </div>
          <div className="w-14 h-14 bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 rounded-2xl flex items-center justify-center">
            <DollarSign className="w-7 h-7" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center justify-between border-r-8 border-r-emerald-500">
          <div>
            <p className="text-xs font-black text-emerald-600 uppercase tracking-widest">حسابات خالصة</p>
            <h3 className="text-3xl font-black text-emerald-600 dark:text-emerald-400 mt-1">
              {totalSuppliers - suppliersWithDebit}
            </h3>
            <p className="text-xs text-emerald-500 font-bold mt-1">موردين بدون مديونيات معلقة</p>
          </div>
          <div className="w-14 h-14 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-2xl flex items-center justify-center">
            <CheckCircle2 className="w-7 h-7" />
          </div>
        </div>
      </div>

      {/* Control Bar: Search, Filters, Add Button */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between bg-white dark:bg-slate-900 p-4 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="w-5 h-5 absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="البحث بالاسم، الهاتف، أو العنوان..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pr-12 pl-4 py-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 transition-all"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto shrink-0">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl">
            <button
              onClick={() => setFilterType('all')}
              className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                filterType === 'all' 
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' 
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              الكل ({suppliers.length})
            </button>
            <button
              onClick={() => setFilterType('debit')}
              className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                filterType === 'debit' 
                  ? 'bg-rose-500 text-white shadow-sm' 
                  : 'text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30'
              }`}
            >
              مديونيات ({suppliersWithDebit})
            </button>
            <button
              onClick={() => setFilterType('clear')}
              className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                filterType === 'clear' 
                  ? 'bg-emerald-500 text-white shadow-sm' 
                  : 'text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
              }`}
            >
              خالصة ({suppliers.length - suppliersWithDebit})
            </button>
          </div>

          <button
            onClick={handleOpenAdd}
            className="px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-black text-xs rounded-2xl shadow-lg shadow-primary-500/20 flex items-center gap-2 transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة مورد جديد</span>
          </button>
        </div>
      </div>

      {/* Suppliers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredSuppliers.map((supplier) => {
          const balance = Number(supplier.balance || 0);
          const hasDebit = balance > 0;
          const isCredit = balance < 0;

          return (
            <div
              key={supplier.id}
              className={`bg-white dark:bg-slate-900 rounded-[32px] p-6 border transition-all duration-300 hover:shadow-xl flex flex-col justify-between relative overflow-hidden group ${
                hasDebit 
                  ? 'border-slate-100 dark:border-slate-800 border-t-8 border-t-rose-500' 
                  : 'border-slate-100 dark:border-slate-800 border-t-8 border-t-emerald-500'
              }`}
            >
              <div>
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg ${
                      hasDebit 
                        ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/30' 
                        : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30'
                    }`}>
                      <Truck className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="font-black text-lg text-slate-900 dark:text-white leading-tight">
                        {supplier.name_ar}
                      </h4>
                      {supplier.name_en && (
                        <p className="text-xs text-slate-400 font-bold tracking-wide" dir="ltr text-right">
                          {supplier.name_en}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleOpenEdit(supplier)}
                      className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-all"
                      title="تعديل"
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteSupplier(supplier.id)}
                      className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl transition-all"
                      title="حذف"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Contact details */}
                <div className="space-y-1.5 mb-6 text-xs text-slate-500 dark:text-slate-400">
                  {supplier.phone && (
                    <div className="flex items-center gap-2 font-bold">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      <span dir="ltr">{supplier.phone}</span>
                    </div>
                  )}
                  {supplier.address && (
                    <div className="flex items-center gap-2 font-bold">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      <span className="truncate">{supplier.address}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Debit & Action Bar */}
              <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-wider">
                    {hasDebit ? 'المديونية المستحقة للمورد' : isCredit ? 'رصيد لصالحنا' : 'الحساب'}
                  </span>
                  <div className={`px-4 py-1.5 rounded-xl font-black text-sm ${
                    hasDebit 
                      ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400' 
                      : isCredit 
                        ? 'bg-cyan-50 dark:bg-cyan-950/30 text-cyan-600 dark:text-cyan-400'
                        : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400'
                  }`}>
                    {Math.abs(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleOpenPayment(supplier)}
                    className="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs shadow-md shadow-emerald-500/10 flex items-center justify-center gap-1.5 transition-all active:scale-95"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>سداد دفعة</span>
                  </button>

                  <button
                    onClick={() => handleOpenStatement(supplier)}
                    className="w-full py-2.5 px-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 transition-all active:scale-95"
                  >
                    <FileText className="w-4 h-4" />
                    <span>كشف الحساب</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {filteredSuppliers.length === 0 && (
          <div className="col-span-full py-16 text-center text-slate-400">
            <Truck className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-black text-lg">لم يتم العثور على موردين مطابقة للبحث</p>
          </div>
        )}
      </div>

      {/* Add / Edit Supplier Modal */}
      {isAddEditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-[32px] max-w-lg w-full p-8 border border-slate-100 dark:border-slate-800 shadow-2xl space-y-6">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-xl font-black text-slate-900 dark:text-white">
                {editingSupplier ? 'تعديل بيانات المورد' : 'إضافة مورد جديد'}
              </h3>
              <button
                onClick={() => setIsAddEditOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-xl"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-black text-slate-400 mb-1">اسم المورد (بالعربي) *</label>
                <input
                  type="text"
                  value={formData.name_ar}
                  onChange={(e) => setFormData({ ...formData, name_ar: e.target.value })}
                  placeholder="مثال: شركة ابن سينا فارما"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-400 mb-1">اسم المورد (بالإنجليزي)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={formData.name_en}
                  onChange={(e) => setFormData({ ...formData, name_en: e.target.value })}
                  placeholder="e.g. Ibnsina Pharma"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 text-right"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-400 mb-1">رقم الهاتف</label>
                <input
                  type="text"
                  dir="ltr"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="01000000000"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 text-right"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-400 mb-1">العنوان</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  placeholder="عنوان أو فرع المورد..."
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => setIsAddEditOpen(false)}
                className="px-6 py-3 rounded-2xl text-sm font-black text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveSupplier}
                disabled={isSavingSupplier}
                className="px-8 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-2xl text-sm font-black shadow-lg shadow-primary-500/20 transition-all active:scale-95 disabled:opacity-50"
              >
                {isSavingSupplier ? 'جاري الحفظ...' : 'حفظ البيانات'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Supplier Payment Modal */}
      {paymentSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-[32px] max-w-lg w-full p-8 border border-slate-100 dark:border-slate-800 shadow-2xl space-y-6">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-white">سداد دفعة للمورد</h3>
                <p className="text-xs font-bold text-slate-400 mt-0.5">{paymentSupplier.name_ar}</p>
              </div>
              <button
                onClick={() => setPaymentSupplier(null)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-xl"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Current Balance Display */}
            <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/30 flex items-center justify-between">
              <div>
                <p className="text-xs font-black text-rose-500">المديونية الحالية المستحقة للمورد</p>
                <p className="text-2xl font-black text-rose-600 dark:text-rose-400 mt-1">
                  {Number(paymentSupplier.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} ج.م
                </p>
              </div>
              <Wallet className="w-8 h-8 text-rose-500 opacity-70" />
            </div>

            <form onSubmit={handleSubmitPayment} className="space-y-4">
              <div>
                <label className="block text-xs font-black text-slate-400 mb-1">مبلغ السداد (ج.م) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-lg font-black text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 text-left"
                />

                {/* Quick percentage helper buttons */}
                {Number(paymentSupplier.balance || 0) > 0 && (
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() => setPaymentAmount(String(Number(paymentSupplier.balance)))}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold transition-all"
                    >
                      كامل المبلغ ({Number(paymentSupplier.balance).toLocaleString()})
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentAmount(String(Math.round(Number(paymentSupplier.balance) * 0.5 * 100) / 100))}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold transition-all"
                    >
                      50%
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentAmount(String(Math.round(Number(paymentSupplier.balance) * 0.25 * 100) / 100))}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold transition-all"
                    >
                      25%
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-slate-400 mb-1">طريقة الدفع</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as any)}
                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="cash">نقدي (الخزينة)</option>
                    <option value="bank">تحويل بنكي / فيزا</option>
                    <option value="check">شيك</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-black text-slate-400 mb-1">تاريخ السداد</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {paymentMethod === 'check' && (
                <div>
                  <label className="block text-xs font-black text-slate-400 mb-1">رقم الشيك</label>
                  <input
                    type="text"
                    value={checkNumber}
                    onChange={(e) => setCheckNumber(e.target.value)}
                    placeholder="رقم الشيك البنكي..."
                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-black text-slate-400 mb-1">ملاحظات / البيان</label>
                <input
                  type="text"
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  placeholder="ملاحظات حول الدفعة أو رقم الإيصال..."
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Remaining balance preview */}
              {Number(paymentAmount) > 0 && (
                <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-black flex justify-between items-center">
                  <span className="text-slate-400">الرصيد المتبقي بعد السداد:</span>
                  <span className="text-slate-900 dark:text-white font-bold">
                    {(Number(paymentSupplier.balance || 0) - Number(paymentAmount)).toLocaleString(undefined, { minimumFractionDigits: 2 })} ج.م
                  </span>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setPaymentSupplier(null)}
                  className="px-6 py-3 rounded-2xl text-sm font-black text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isProcessingPayment}
                  className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-sm font-black shadow-lg shadow-emerald-500/20 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isProcessingPayment ? 'جاري السداد...' : 'تأكيد السداد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Supplier Statement Modal */}
      {statementSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 rounded-[32px] max-w-3xl w-full p-8 border border-slate-100 dark:border-slate-800 shadow-2xl space-y-6 max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-white">كشف حساب المورد</h3>
                <p className="text-xs font-bold text-slate-400 mt-0.5">{statementSupplier.name_ar} (الرصيد: {Number(statementSupplier.balance || 0).toLocaleString()} ج.م)</p>
              </div>
              <button
                onClick={() => setStatementSupplier(null)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-xl"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 custom-scrollbar">
              {isLoadingStatement ? (
                <div className="py-16 text-center text-slate-400 font-bold">جاري تحميل كشف الحساب...</div>
              ) : statementTransactions.length === 0 ? (
                <div className="py-16 text-center text-slate-400 font-bold">لا توجد حركات مسجلة لهذا المورد حتى الآن</div>
              ) : (
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0 text-slate-400 font-black uppercase">
                    <tr>
                      <th className="p-3 rounded-r-xl">التاريخ</th>
                      <th className="p-3">نوع الحركة</th>
                      <th className="p-3">المبلغ</th>
                      <th className="p-3">البيان / الملاحظات</th>
                      <th className="p-3 rounded-l-xl">المرجع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {statementTransactions.map((tx) => (
                      <tr key={tx.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="p-3 text-slate-500 font-bold">{tx.created_at ? new Date(tx.created_at).toLocaleDateString('ar-EG') : '-'}</td>
                        <td className="p-3">
                          <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black ${
                            tx.type === 'payment' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30' :
                            tx.type === 'invoice' ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/30' :
                            tx.type === 'return' ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/30' :
                            'bg-slate-50 text-slate-600 dark:bg-slate-800'
                          }`}>
                            {tx.type === 'payment' ? 'سداد دفعة' : tx.type === 'invoice' ? 'فاتورة شراء' : tx.type === 'return' ? 'مرتجع شراء' : tx.type}
                          </span>
                        </td>
                        <td className={`p-3 font-black ${tx.type === 'payment' || tx.type === 'return' ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {Number(tx.amount || 0).toLocaleString()} ج.م
                        </td>
                        <td className="p-3 font-bold text-slate-600 dark:text-slate-300">{tx.notes || '-'}</td>
                        <td className="p-3 font-mono text-slate-400">{tx.reference_id ? tx.reference_id.slice(0, 10) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end shrink-0">
              <button
                onClick={() => setStatementSupplier(null)}
                className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-black"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
