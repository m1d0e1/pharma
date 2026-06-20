'use client';

import React, { useState, useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import DOMPurify from 'dompurify'
import { getConfigAction } from '@/app/actions/config'
import toast from 'react-hot-toast'
import { generateReceiptHtml, generateWhatsAppMessage, printHtmlContent } from '@/lib/utils/printing'

interface SaleItem {
  quantity_sold: number
  unit_price: number
  inventory: {
    master_drugs: {
      trade_name: string
      trade_name_en?: string
    }
  }
  trade_name?: string
  trade_name_en?: string
  unit?: string
  units?: any
}

interface Invoice {
  id: string
  total_amount: number
  created_at: string
  profiles: { full_name: string }
  patients: { full_name: string, phone: string } | null
  sales_items: SaleItem[]
  payment_method?: string
}

interface Props {
  invoice: Invoice
  onClose: () => void
}

interface PharmacyInfo {
  name: string
  phone: string
  address: string
}

// Helper function to escape HTML entities
const escapeHtml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export default function ReceiptDetailsModal({ invoice, onClose }: Props) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [pharmacyInfo, setPharmacyInfo] = useState<PharmacyInfo>({
    name: 'صيدلية فارما تيك',
    phone: '',
    address: ''
  })

  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    async function loadInfo() {
      const name = await getConfigAction('pharmacy_name')
      const phone = await getConfigAction('pharmacy_phone')
      const address = await getConfigAction('pharmacy_address')
      
      setPharmacyInfo({
        name: name.value || 'صيدلية فارما تيك',
        phone: phone.value || '',
        address: address.value || ''
      })
    }
    loadInfo()
  }, [])

  const formatDate = (dateStr: string) => {
    if (!mounted) return '---'
    try {
      return new Date(dateStr).toLocaleString('ar-EG', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    } catch (e) {
      return dateStr
    }
  }

  const handlePrint = () => {
    const html = generateReceiptHtml(invoice, pharmacyInfo);
    printHtmlContent(html);
  };

  const handleWhatsApp = () => {
    if (!invoice.patients?.phone) {
      toast.error('لا يوجد رقم هاتف مسجل لهذا العميل');
      return;
    }

    const message = generateWhatsAppMessage(invoice, pharmacyInfo);
    const whatsappUrl = `https://wa.me/2${invoice.patients.phone}?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank');
  };

  const subtotal = invoice.sales_items?.reduce((s, i) => s + (i.quantity_sold * i.unit_price), 0) || 0;
  const totalAmount = invoice.total_amount;
  const discount = Math.max(0, subtotal - totalAmount);

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[200]" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.3)] w-full max-w-2xl overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-500">
        
        {/* Header - Premium Professional Design */}
        <div className="bg-slate-950 p-10 text-white relative overflow-hidden">
          {/* Abstract background decorations */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl -mr-32 -mt-32"></div>
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-indigo-600/10 rounded-full blur-2xl -ml-24 -mb-24"></div>
          
          <div className="flex justify-between items-start relative z-10">
            <div>
              <div className="flex items-center gap-2 mb-4">
                 <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-xl shadow-lg shadow-blue-600/20">🏥</div>
                 <div>
                    <h2 className="text-2xl font-black leading-tight">فاتورة مبيعات</h2>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Sales Receipt Detail</p>
                 </div>
              </div>
              <p className="text-slate-400 font-mono text-sm tracking-tighter">REF: {invoice.id.toUpperCase()}</p>
            </div>
            <button 
              onClick={onClose} 
              className="p-4 hover:bg-white/10 rounded-2xl transition-all border border-transparent hover:border-white/10 text-slate-400 hover:text-white"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-12 mt-10 relative z-10">
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-black mb-1">العميل / Patient</p>
              <div className="flex items-center gap-3">
                 <div className="w-12 h-12 bg-slate-800 rounded-2xl flex items-center justify-center text-slate-400 border border-slate-700">👤</div>
                 <div>
                    <p className="font-black text-lg text-white leading-tight">{invoice.patients?.full_name || 'عميل نقدي (Cash)'}</p>
                    {invoice.patients?.phone && <p className="text-xs text-blue-400 font-bold">{invoice.patients.phone}</p>}
                 </div>
              </div>
            </div>
            <div className="text-left space-y-1">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-black mb-1">بيانات الإصدار</p>
              <p className="font-bold text-white leading-snug">{formatDate(invoice.created_at)}</p>
              <p className="text-xs text-slate-400 font-bold">المحاسب: {invoice.profiles?.full_name || 'System User'}</p>
            </div>
          </div>
        </div>

        {/* Items Section */}
        <div className="p-10">
          <div className="space-y-6">
            <div className="grid grid-cols-12 gap-4 pb-4 border-b border-slate-100 dark:border-slate-800 text-[10px] font-black text-slate-400 uppercase tracking-[0.1em]">
              <div className="col-span-6">وصف الصنف والمواصفات</div>
              <div className="col-span-2 text-center">الكمية</div>
              <div className="col-span-2 text-left">السعر</div>
              <div className="col-span-2 text-left">الإجمالي</div>
            </div>
            
            <div className="max-h-[300px] overflow-auto space-y-4 pr-2 custom-scrollbar">
              {invoice.sales_items?.map((item, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-4 items-center group">
                  <div className="col-span-6 flex items-center gap-4">
                    <div className="w-10 h-10 bg-slate-50 dark:bg-slate-800/50 rounded-xl flex items-center justify-center text-lg border border-slate-100 dark:border-slate-800 group-hover:scale-105 transition-transform">
                      💊
                    </div>
                    <div className="flex flex-col">
                      <span className="font-black text-slate-800 dark:text-white leading-tight">
                        {item.inventory?.master_drugs?.trade_name_en || item.trade_name_en || item.inventory?.master_drugs?.trade_name || item.trade_name || 'صنف دوائي'}
                      </span>
                      <span className="text-[9px] text-slate-400 font-black uppercase tracking-widest mt-0.5">Item Ref: MD-{idx + 100}</span>
                    </div>
                  </div>
                  <div className="col-span-2 text-center font-black text-slate-900 dark:text-white">
                    {item.quantity_sold} {item.unit ? (item.units?.[item.unit] || (item.unit === 'large' ? 'علبة' : item.unit === 'medium' ? 'شريط' : 'وحدة')) : ''}
                  </div>
                  <div className="col-span-2 text-left font-bold text-slate-500">{item.unit_price.toFixed(2)}</div>
                  <div className="col-span-2 text-left font-black text-slate-900 dark:text-white">{(item.quantity_sold * item.unit_price).toFixed(2)}</div>
                </div>
              ))}
              {(!invoice.sales_items || invoice.sales_items.length === 0) && (
                <div className="py-12 flex flex-col items-center justify-center text-slate-400 gap-4">
                  <div className="text-4xl opacity-20">📦</div>
                  <p className="font-bold italic">لا توجد أصناف مسجلة في هذه الفاتورة</p>
                </div>
              )}
            </div>
          </div>

          {/* Totals & Payment Section */}
          <div className="mt-10 pt-10 border-t-2 border-slate-100 dark:border-slate-800 grid grid-cols-1 lg:grid-cols-2 gap-10">
            <div className="space-y-6">
               <div className="flex items-center gap-4 p-5 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border border-slate-100 dark:border-slate-800">
                  <div className="w-12 h-12 bg-white dark:bg-slate-900 rounded-2xl flex items-center justify-center shadow-sm text-2xl">
                    {invoice.payment_method === 'cash' ? '💵' : 
                     invoice.payment_method === 'credit' ? '💳' :
                     invoice.payment_method === 'visa' ? '🏦' : '💸'}
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">نظام الدفع المعتمد</p>
                    <span className="font-black text-slate-900 dark:text-white">
                      {invoice.payment_method === 'cash' ? 'دفع نقدي (Cash)' : 
                       invoice.payment_method === 'credit' ? 'حساب آجل (Credit)' :
                       invoice.payment_method === 'visa' ? 'بطاقة بنكية (Visa/Card)' : 'طرق أخرى'}
                    </span>
                  </div>
               </div>
               <div className="px-5">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 italic">إقرار المراجعة</p>
                  <p className="text-[11px] text-slate-500 font-bold leading-relaxed">
                    تم صرف هذه الأدوية بناءً على طلب العميل وبعد مراجعة النشرة الداخلية والجرعات المحددة. 
                    يرجى الاحتفاظ بهذه الفاتورة للمراجعة أو الاستبدال خلال المدة القانونية.
                  </p>
               </div>
            </div>

            <div className="space-y-4">
              <div className="flex justify-between items-center text-sm px-2">
                <span className="text-slate-400 font-bold">المجموع الفرعي:</span>
                <span className="font-black text-slate-700 dark:text-slate-200">{subtotal.toFixed(2)} ج.م</span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between items-center text-sm px-2 text-rose-500">
                  <span className="font-bold">إجمالي الخصم:</span>
                  <span className="font-black">-{discount.toFixed(2)} ج.م</span>
                </div>
              )}
              <div className="flex justify-between items-center text-sm px-2 text-slate-500">
                <span className="font-bold">رسوم إضافية:</span>
                <span className="font-black">0.00 ج.م</span>
              </div>
              <div className="pt-6 mt-4 border-t-2 border-slate-100 dark:border-slate-800 flex justify-between items-end">
                <div>
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">المبلغ المطلوب سداده</p>
                   <p className="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">Total Due Amount</p>
                </div>
                <div className="text-left">
                  <h3 className="text-6xl font-black text-blue-600 tracking-tighter leading-none">
                    {invoice.total_amount.toLocaleString()}
                  </h3>
                  <p className="text-sm font-black text-slate-400 mt-2">جنيه مصري (EGP)</p>
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-5 mt-12">
             <button 
               onClick={handlePrint} 
               className="flex items-center justify-center gap-3 bg-slate-900 text-white py-5 rounded-[24px] font-black hover:bg-slate-800 transition-all shadow-xl shadow-slate-900/20 active:scale-95"
             >
               <Printer className="w-6 h-6 text-blue-400" /> 
               <span>طباعة حرارية</span>
             </button>
             <button 
               onClick={handleWhatsApp} 
               className="flex items-center justify-center gap-3 bg-emerald-500 text-white py-5 rounded-[24px] font-black hover:bg-emerald-600 transition-all shadow-xl shadow-emerald-500/20 active:scale-95"
             >
               <Phone className="w-6 h-6" /> 
               <span>إرسال واتساب</span>
             </button>
          </div>
        </div>
      </div>
    </div>
  )
}

import { Printer, X, Phone } from 'lucide-react'


