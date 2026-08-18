'use client';

import React, { useState, useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { X, FileText, History, Package, Printer, Search, Loader2, ArrowUpRight, ArrowDownLeft, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPatientStatementAction, getReceiptDetailsAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';
import ReceiptDetailsModal from '../receipts/ReceiptDetailsModal';

interface CustomerStatementModalProps {
  patientId: string;
  onClose: () => void;
}

export default function CustomerStatementModal({ patientId, onClose }: CustomerStatementModalProps) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [activeTab, setActiveTab] = useState<'movements' | 'items' | 'notices'>('movements');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const [loadingReceipt, setLoadingReceipt] = useState(false);

  useEffect(() => {
    async function loadStatement() {
      setLoading(true);
      const res = await getPatientStatementAction(patientId);
      if (res.success) {
        setData(res.data);
      } else {
        toast.error(res.error || 'فشل تحميل كشف الحساب');
      }
      setLoading(false);
    }
    loadStatement();
  }, [patientId]);

  const handleOpenReceipt = async (invoiceId: string) => {
    try {
      setLoadingReceipt(true);
      const res = await getReceiptDetailsAction(invoiceId);
      setLoadingReceipt(false);
      if (res.success && res.data) {
        setSelectedReceipt(res.data);
      } else {
        toast.error(res.error || 'فشل تحميل تفاصيل الفاتورة');
      }
    } catch {
      setLoadingReceipt(false);
      toast.error('حدث خطأ أثناء تحميل الفاتورة');
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center">
         <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl flex flex-col items-center gap-4 shadow-2xl">
            <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
            <p className="font-black text-slate-500">جاري تحميل كشف حساب العميل...</p>
         </div>
      </div>
    );
  }

  if (!data || !data.patient) {
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl flex flex-col items-center gap-4 shadow-2xl border border-slate-200 dark:border-slate-800">
          <p className="font-black text-rose-500 text-lg">فشل تحميل كشف حساب العميل</p>
          <button onClick={onClose} className="px-6 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-xl font-bold transition-all">
            إغلاق
          </button>
        </div>
      </div>
    );
  }

  const { patient, movements, items, notices, currentBalance } = data;
  let runningBalance = Number(patient.opening_balance || 0);
  const statementMovements = [...(movements || [])]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map(movement => {
      const balanceEffect = Number(movement.balance_effect ?? 0);
      runningBalance += balanceEffect;
      return { ...movement, balanceEffect, runningBalance };
    });

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
      <div className="bg-slate-50 dark:bg-slate-900 w-full max-w-6xl h-[90vh] rounded-[40px] shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden animate-in zoom-in duration-300" dir="rtl">
        
        {/* Header */}
        <div className="p-8 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 shrink-0">
           <div className="flex justify-between items-start mb-6">
              <div>
                <h3 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                   <FileText className="w-8 h-8 text-blue-600" /> كشف حساب عميل
                </h3>
                <p className="text-slate-500 font-bold mt-1">عرض جميع الحركات المالية والأصناف للعميل</p>
              </div>
              <button onClick={onClose} className="p-3 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl transition-all no-print">
                 <X className="w-6 h-6" />
              </button>
           </div>

           <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-2xl border border-slate-100 dark:border-slate-800">
                 <p className="text-[10px] font-black text-slate-400 uppercase mb-1">إسم العميل</p>
                 <p className="font-black text-slate-800 dark:text-white">{patient.full_name}</p>
              </div>
              <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-2xl border border-slate-100 dark:border-slate-800">
                 <p className="text-[10px] font-black text-slate-400 uppercase mb-1">كود العميل</p>
                 <p className="font-black text-slate-800 dark:text-white">#{patient.id.slice(0, 8)}</p>
              </div>
              <div className="bg-blue-50 dark:bg-blue-900/10 p-4 rounded-2xl border border-blue-100 dark:border-blue-900/20">
                 <p className="text-[10px] font-black text-blue-400 uppercase mb-1">الرصيد الحالي</p>
                 <p className="text-2xl font-black text-blue-600">{currentBalance.toLocaleString()} ج.م</p>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-900/10 p-4 rounded-2xl border border-emerald-100 dark:border-emerald-900/20">
                 <p className="text-[10px] font-black text-emerald-400 uppercase mb-1">رصيد أول المدة</p>
                 <p className="text-2xl font-black text-emerald-600">{(patient.opening_balance || 0).toLocaleString()} ج.م</p>
              </div>
           </div>

           {patient.notes && (
             <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-2xl flex items-center gap-3">
               <span className="text-xl">📌</span>
               <div>
                 <p className="text-xs font-black text-amber-800 dark:text-amber-300">ملاحظات العميل:</p>
                 <p className="text-sm font-bold text-amber-900 dark:text-amber-200">{patient.notes}</p>
               </div>
             </div>
           )}
        </div>

        {/* Tab Selection */}
        <div className="flex bg-white dark:bg-slate-950 p-2 gap-2 border-b border-slate-200 dark:border-slate-800 shrink-0 no-print">
           <TabButton active={activeTab === 'movements'} onClick={() => setActiveTab('movements')} icon={History} label="حركات وكشف الحساب" />
           <TabButton active={activeTab === 'items'} onClick={() => setActiveTab('items')} icon={Package} label="أصناف المبيعات" />
           <TabButton 
             active={activeTab === 'notices'} 
             onClick={() => setActiveTab('notices')} 
             icon={FileText} 
             label={`إشعارات وتعديلات (${(notices || []).length})`} 
           />
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-8">
           {activeTab === 'movements' && (
             <div className="bg-white dark:bg-slate-950 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm animate-in fade-in slide-in-from-bottom-4">
                <table className="w-full text-right">
                  <thead className="bg-slate-50 dark:bg-slate-900/50">
                    <tr>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الحركة</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">البيان / الملاحظات</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">رقم المستند</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">التاريخ</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المبلغ</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الرصيد</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">طريقة الدفع</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المستخدم</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {statementMovements.map((mov: any, i: number) => (
                      <tr 
                        key={i} 
                        onClick={() => {
                          if (mov.type === 'فاتورة بيع' || mov.doc_no) {
                            handleOpenReceipt(mov.doc_no);
                          }
                        }}
                        className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors cursor-pointer"
                      >
                         <td className="px-6 py-4">
                            <span className={cn(
                               "px-3 py-1 rounded-full text-[10px] font-bold flex items-center gap-2 w-fit",
                               mov.balanceEffect > 0 ? "bg-blue-100 text-blue-600" : "bg-emerald-100 text-emerald-600"
                            )}>
                               {mov.balanceEffect > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownLeft className="w-3 h-3" />}
                               {mov.type}
                            </span>
                         </td>
                         <td className="px-6 py-4">
                            <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
                               {mov.notes || '---'}
                            </span>
                         </td>
                         <td className="px-6 py-4 font-bold text-slate-500 hover:text-blue-600 underline">
                           #{mov.doc_no.slice(0, 8)}
                         </td>
                         <td className="px-6 py-4 font-bold">{new Date(mov.date).toLocaleString('ar-EG')}</td>
                         <td className={cn("px-6 py-4 font-black text-lg", mov.balanceEffect > 0 ? "text-blue-600" : "text-emerald-600")}>
                            {mov.value.toLocaleString()} ج.م
                         </td>
                         <td className="px-6 py-4 font-black text-slate-800 dark:text-white">{mov.runningBalance.toLocaleString()} ج.م</td>
                         <td className="px-6 py-4">
                            <span className="bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-lg text-[10px] font-black">
                               {mov.payment_method === 'cash' ? 'نقدي' : mov.payment_method === 'credit' ? 'آجل' : mov.payment_method}
                            </span>
                         </td>
                         <td className="px-6 py-4 text-slate-500 font-bold text-sm">{mov.user_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
             </div>
           )}

           {activeTab === 'notices' && (
             <div className="bg-white dark:bg-slate-950 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm animate-in fade-in slide-in-from-bottom-4">
                {(notices || []).length === 0 ? (
                  <div className="p-16 text-center text-slate-400 font-bold">
                    لا توجد إشعارات مالية مسجلة لهذا العميل
                  </div>
                ) : (
                  <table className="w-full text-right">
                    <thead className="bg-slate-50 dark:bg-slate-900/50">
                      <tr>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">نوع الإشعار</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المبلغ</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">السبب / البيان</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">ملاحظات</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">التاريخ</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المستخدم</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {(notices || []).map((notice: any, i: number) => (
                        <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors">
                          <td className="px-6 py-4">
                            <span className={cn(
                              "px-3 py-1 rounded-full text-xs font-bold",
                              notice.type === 'debit' ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"
                            )}>
                              {notice.type === 'debit' ? 'إشعار مدين (إضافة على الحساب)' : 'إشعار دائن (خصم من الحساب)'}
                            </span>
                          </td>
                          <td className={cn("px-6 py-4 font-black text-lg", notice.type === 'debit' ? "text-blue-600" : "text-emerald-600")}>
                            {notice.amount.toLocaleString()} ج.م
                          </td>
                          <td className="px-6 py-4 font-bold text-slate-800 dark:text-white">{notice.reason || '---'}</td>
                          <td className="px-6 py-4 text-slate-500 font-medium text-sm">{notice.notes || '---'}</td>
                          <td className="px-6 py-4 font-bold text-sm text-slate-600 dark:text-slate-400">{new Date(notice.date || notice.created_at).toLocaleDateString('ar-EG')}</td>
                          <td className="px-6 py-4 text-slate-500 font-bold text-sm">{notice.user_name || 'النظام'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
             </div>
           )}

           {activeTab === 'items' && (
             <div className="bg-white dark:bg-slate-950 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm animate-in fade-in slide-in-from-bottom-4">
                <table className="w-full text-right">
                  <thead className="bg-slate-50 dark:bg-slate-900/50">
                    <tr>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الصنف</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">العملية</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الكمية</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الوحدة</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">السعر</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(items || []).map((item: any, i: number) => (
                      <tr 
                        key={i} 
                        onClick={() => { if (item.invoice_id) handleOpenReceipt(item.invoice_id); }}
                        className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors cursor-pointer"
                      >
                         <td className="px-6 py-4 font-bold text-slate-900 dark:text-white">{item.trade_name}</td>
                         <td className="px-6 py-4 font-bold">
                           <span className={cn("px-3 py-1 rounded-full text-[10px]", item.action === 'مرتجع' ? "bg-rose-100 text-rose-600" : "bg-blue-100 text-blue-600")}>
                             {item.action}
                           </span>
                         </td>
                         <td className="px-6 py-4 font-black">{item.quantity_sold}</td>
                         <td className="px-6 py-4 text-slate-500 font-bold">{item.unit || 'وحدة'}</td>
                         <td className="px-6 py-4 font-black text-blue-600">{item.unit_price} ج.م</td>
                         <td className="px-6 py-4 text-slate-500 text-sm">{new Date(item.date).toLocaleString('ar-EG')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
             </div>
           )}
        </div>

        {selectedReceipt && (
          <ReceiptDetailsModal
            invoice={selectedReceipt}
            onClose={() => setSelectedReceipt(null)}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label }: any) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl font-black text-sm transition-all",
        active ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-900"
      )}
    >
       <Icon className="w-4 h-4" />
       {label}
    </button>
  );
}
