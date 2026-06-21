'use client';

import React, { useState, useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook';
import { X, FileText, History, Package, Printer, Search, Loader2, ArrowUpRight, ArrowDownLeft, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPatientStatementAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

interface CustomerStatementModalProps {
  patientId: string;
  onClose: () => void;
}

export default function CustomerStatementModal({ patientId, onClose }: CustomerStatementModalProps) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [activeTab, setActiveTab] = useState<'movements' | 'items' | 'report'>('movements');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);

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

  const { patient, movements, items, currentBalance } = data;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
      <div className="bg-slate-50 dark:bg-slate-900 w-full max-w-6xl h-[90vh] rounded-[40px] shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden animate-in zoom-in duration-300" dir="rtl">
        
        {/* Header (Image 3/4 Header Style) */}
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
        </div>

        {/* Tab Selection */}
        <div className="flex bg-white dark:bg-slate-950 p-2 gap-2 border-b border-slate-200 dark:border-slate-800 shrink-0 no-print">
           <TabButton active={activeTab === 'movements'} onClick={() => setActiveTab('movements')} icon={History} label="حركات" />
           <TabButton active={activeTab === 'items'} onClick={() => setActiveTab('items')} icon={Package} label="أصناف" />
           <TabButton active={activeTab === 'report'} onClick={() => setActiveTab('report')} icon={FileText} label="تقرير" />
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-8">
           {activeTab === 'movements' && (
             <div className="bg-white dark:bg-slate-950 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm animate-in fade-in slide-in-from-bottom-4">
                <table className="w-full text-right">
                  <thead className="bg-slate-50 dark:bg-slate-900/50">
                    <tr>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الحركة</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">رقم المستند</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">التاريخ</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المبلغ</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">طريقة الدفع</th>
                       <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">المستخدم</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {movements.map((mov: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors">
                         <td className="px-6 py-4">
                            <span className={cn(
                              "px-3 py-1 rounded-full text-[10px] font-bold flex items-center gap-2 w-fit",
                              mov.value > 0 ? "bg-blue-100 text-blue-600" : "bg-rose-100 text-rose-600"
                            )}>
                               {mov.value > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownLeft className="w-3 h-3" />}
                               {mov.type}
                            </span>
                         </td>
                         <td className="px-6 py-4 font-bold text-slate-500">#{mov.doc_no.slice(0, 8)}</td>
                         <td className="px-6 py-4 font-bold">{new Date(mov.date).toLocaleString('ar-EG')}</td>
                         <td className={cn("px-6 py-4 font-black text-lg", mov.value > 0 ? "text-blue-600" : "text-rose-600")}>
                            {mov.value.toLocaleString()} ج.م
                         </td>
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

           {activeTab === 'items' && (
             <div className="bg-white dark:bg-slate-950 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm animate-in fade-in slide-in-from-bottom-4">
                <table className="w-full text-right">
                   <thead className="bg-slate-50 dark:bg-slate-900/50">
                      <tr>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الحركة</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">التاريخ</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">إسم الصنف</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الكمية</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الوحدة</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">سعر البيع</th>
                        <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase">الإجمالي</th>
                      </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {items.map((item: any, i: number) => (
                        <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors">
                           <td className="px-6 py-4">
                             <span className={cn(
                               "px-2 py-1 rounded-lg text-[10px] font-black",
                               item.action === 'بيع' ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
                             )}>{item.action}</span>
                           </td>
                           <td className="px-6 py-4 text-xs font-bold text-slate-400">{new Date(item.date).toLocaleDateString('ar-EG')}</td>
                           <td className="px-6 py-4 font-black text-slate-800 dark:text-white">{item.trade_name}</td>
                           <td className="px-6 py-4 font-black text-blue-600">{item.quantity_sold}</td>
                           <td className="px-6 py-4 text-slate-500 font-bold text-xs">{item.unit}</td>
                           <td className="px-6 py-4 font-bold">{item.unit_price} ج.م</td>
                           <td className="px-6 py-4 font-black text-slate-800 dark:text-white text-left">{(item.quantity_sold * item.unit_price).toLocaleString()} ج.م</td>
                        </tr>
                      ))}
                   </tbody>
                </table>
             </div>
           )}

           {activeTab === 'report' && (
             <div className="bg-white dark:bg-white p-20 rounded-3xl border border-slate-200 shadow-2xl max-w-4xl mx-auto text-slate-900 font-sans" dir="rtl" id="print-report">
                <div className="text-center mb-10 border-b-2 border-slate-900 pb-8">
                   <h2 className="text-4xl font-black mb-2">كشف حساب العميل: {patient.full_name}</h2>
                   <p className="text-xl font-bold">عن الفترة من بداية التعامل إلى {new Date().toLocaleDateString('ar-EG')}</p>
                </div>

                <div className="grid grid-cols-2 gap-10 mb-12">
                   <div className="space-y-2">
                      <p className="text-lg font-black border-b border-slate-200 pb-2">بيانات العميل</p>
                      <p className="font-bold">الكود: {patient.id.slice(0, 8)}</p>
                      <p className="font-bold">العنوان: {patient.address || 'غير محدد'}</p>
                      <p className="font-bold">الهاتف: {patient.phone}</p>
                   </div>
                   <div className="text-left space-y-2">
                      <p className="text-lg font-black border-b border-slate-200 pb-2 text-right">الملخص المالي</p>
                      <div className="flex justify-between items-center py-1">
                         <span className="font-bold">رصيد أول المدة:</span>
                         <span className="font-black">{(patient.opening_balance || 0).toLocaleString()} ج.م</span>
                      </div>
                      <div className="flex justify-between items-center py-1">
                         <span className="font-bold">إجمالي المبيعات الآجلة:</span>
                         <span className="font-black text-rose-600">{movements.filter(m => m.type === 'فاتورة بيع' && m.payment_method === 'credit').reduce((s, m) => s + m.value, 0).toLocaleString()} ج.م</span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-t-2 border-slate-900 mt-2 pt-2">
                         <span className="text-xl font-black">الرصيد المستحق:</span>
                         <span className="text-2xl font-black text-blue-600">{currentBalance.toLocaleString()} ج.م</span>
                      </div>
                   </div>
                </div>

                <table className="w-full border-collapse border-2 border-slate-900 text-right">
                   <thead>
                      <tr className="bg-slate-100 border-b-2 border-slate-900">
                         <th className="p-3 border-l-2 border-slate-900 font-black">التاريخ</th>
                         <th className="p-3 border-l-2 border-slate-900 font-black">البيان</th>
                         <th className="p-3 border-l-2 border-slate-900 font-black">مدين</th>
                         <th className="p-3 border-l-2 border-slate-900 font-black">دائن</th>
                         <th className="p-3 font-black">الرصيد</th>
                      </tr>
                   </thead>
                   <tbody>
                      <tr className="border-b border-slate-300">
                         <td className="p-3 border-l border-slate-300 font-bold">{new Date(patient.created_at).toLocaleDateString()}</td>
                         <td className="p-3 border-l border-slate-300 font-bold">رصيد أول المدة</td>
                         <td className="p-3 border-l border-slate-300">0.00</td>
                         <td className="p-3 border-l border-slate-300">0.00</td>
                         <td className="p-3 font-black">{(patient.opening_balance || 0).toLocaleString()}</td>
                      </tr>
                      {movements.map((mov, i) => (
                        <tr key={i} className="border-b border-slate-300">
                           <td className="p-3 border-l border-slate-300 font-bold">{new Date(mov.date).toLocaleDateString()}</td>
                           <td className="p-3 border-l border-slate-300 font-bold">{mov.type} (#{mov.doc_no.slice(0, 6)})</td>
                           <td className="p-3 border-l border-slate-300">{mov.value > 0 ? mov.value.toLocaleString() : '0.00'}</td>
                           <td className="p-3 border-l border-slate-300">{mov.value < 0 ? Math.abs(mov.value).toLocaleString() : '0.00'}</td>
                           <td className="p-3 font-black">---</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 border-t-2 border-slate-900">
                         <td colSpan={4} className="p-4 text-xl font-black text-left border-l-2 border-slate-900">الرصيد النهائي</td>
                         <td className="p-4 text-2xl font-black text-blue-600">{currentBalance.toLocaleString()} ج.م</td>
                      </tr>
                   </tbody>
                </table>
             </div>
           )}
        </div>

        {/* Footer */}
        <div className="p-8 bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center shrink-0 no-print">
           <div className="flex gap-4">
              <button 
                onClick={() => window.print()}
                className="px-8 py-4 bg-slate-800 text-white rounded-2xl font-black hover:bg-slate-700 transition-all flex items-center gap-2"
              >
                 <Printer className="w-5 h-5" /> طباعة (P)
              </button>
              <button 
                onClick={onClose}
                className="px-10 py-4 bg-white dark:bg-slate-800 text-slate-500 rounded-2xl font-black border border-slate-200 dark:border-slate-700 hover:bg-slate-50 transition-all"
              >
                 إغلاق (C)
              </button>
           </div>
           
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center text-blue-600">
                 <User className="w-5 h-5" />
              </div>
              <div>
                 <p className="text-[10px] font-black text-slate-400 uppercase">المسؤول الحالي</p>
                 <p className="font-bold text-sm">مدير الصيدلية</p>
              </div>
           </div>
        </div>
      </div>

      <style jsx global>{`
        @media print {
          .no-print, button { display: none !important; }
          .bg-slate-50, .dark\\:bg-slate-900 { background: white !important; border: none !important; box-shadow: none !important; }
          body { background: white !important; overflow: auto !important; }
          .fixed { position: absolute !important; }
          #print-report { margin: 0 !important; max-width: 100% !important; border: none !important; box-shadow: none !important; padding: 0 !important; }
        }
      `}</style>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label }: any) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-8 py-4 rounded-2xl font-black text-sm transition-all",
        active ? "bg-slate-100 dark:bg-slate-800 text-blue-600 shadow-sm" : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900"
      )}
    >
       <Icon className="w-4 h-4" />
       {label}
    </button>
  );
}
