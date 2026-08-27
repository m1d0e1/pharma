'use client';

import React, { useState, useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { getConfigAction } from '@/app/actions-client/config'
import toast from 'react-hot-toast'
import { generateReceiptHtml, generateWhatsAppMessage, printHtmlContent } from '@/lib/utils/printing'
import { Printer, X, Phone } from 'lucide-react'

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
  active_ingredient?: string
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
  autoPrint?: boolean
}

interface PharmacyInfo {
  name: string
  phone: string
  address: string
}

export default function ReceiptDetailsModal({ invoice, onClose, autoPrint = false }: Props) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [pharmacyInfo, setPharmacyInfo] = useState<PharmacyInfo>({
    name: 'صيدلية فارما تيك',
    phone: '',
    address: ''
  })

  const [mounted, setMounted] = useState(false)
  const autoPrintDone = React.useRef(false)

  useEffect(() => {
    setMounted(true)
    async function loadInfo() {
      const name = await getConfigAction('pharmacy_name')
      const phone = await getConfigAction('pharmacy_phone')
      const address = await getConfigAction('pharmacy_address')
      
      const info = {
        name: name.value || 'صيدلية فارما تيك',
        phone: phone.value || '',
        address: address.value || ''
      }
      setPharmacyInfo(info)
      if (autoPrint && !autoPrintDone.current) {
        autoPrintDone.current = true
        printHtmlContent(generateReceiptHtml(invoice, info))
      }
    }
    loadInfo()
  }, [autoPrint, invoice])

  const formatDate = (dateStr: string) => {
    if (!mounted) return '---'
    try {
      return new Date(dateStr).toLocaleString('ar-EG-u-nu-latn', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
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
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 z-[200]" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 duration-200">
        
        {/* Header - Compact Design */}
        <div className="bg-slate-950 p-4 text-white relative overflow-hidden">
          <div className="flex justify-between items-start relative z-10">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-sm shadow-md shadow-blue-600/20">🏥</div>
              <div>
                <h2 className="text-sm font-black leading-tight">فاتورة مبيعات</h2>
                <p className="text-[9px] text-slate-400 font-mono">REF: {invoice.id.slice(0, 10).toUpperCase()}</p>
              </div>
            </div>
            <button 
              onClick={onClose} 
              className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-slate-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-3 mt-3 pt-2 border-t border-slate-800/80 relative z-10 text-xs">
            <div>
              <p className="text-[9px] uppercase tracking-wider text-slate-500 font-black mb-0.5">العميل / Patient</p>
              <p className="font-bold text-white text-xs truncate">{invoice.patients?.full_name || 'عميل نقدي (Cash)'}</p>
              {invoice.patients?.phone && <p className="text-[10px] text-blue-400 font-bold">{invoice.patients.phone}</p>}
            </div>
            <div className="text-left">
              <p className="text-[9px] uppercase tracking-wider text-slate-500 font-black mb-0.5">بيانات الإصدار</p>
              <p className="font-bold text-white text-[11px]">{formatDate(invoice.created_at)}</p>
              <p className="text-[10px] text-slate-400 font-medium truncate">المحاسب: {invoice.profiles?.full_name || 'System User'}</p>
            </div>
          </div>
        </div>

        {/* Items Section */}
        <div className="p-4 space-y-3">
          <div>
            <div className="grid grid-cols-12 gap-2 pb-1.5 border-b border-slate-100 dark:border-slate-800 text-[10px] font-black text-slate-400 uppercase tracking-wider">
              <div className="col-span-6">الصنف</div>
              <div className="col-span-2 text-center">الكمية</div>
              <div className="col-span-2 text-left">السعر</div>
              <div className="col-span-2 text-left">الإجمالي</div>
            </div>
            
            <div className="max-h-[200px] overflow-auto space-y-1.5 pt-2 pr-1 custom-scrollbar">
              {invoice.sales_items?.map((item, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center text-xs">
                  <div className="col-span-6 font-bold text-slate-800 dark:text-white truncate">
                    {(() => {
                      const names = [
                        item.inventory?.master_drugs?.trade_name_en,
                        item.trade_name_en,
                        item.inventory?.master_drugs?.trade_name,
                        item.trade_name,
                        item.active_ingredient,
                      ].filter(Boolean) as string[];
                      const valid = names.find(n => !/^Drug\s*#?\s*\d+$/i.test(n.trim()));
                      return valid || names[0] || 'صنف دوائي';
                    })()}
                  </div>
                  <div className="col-span-2 text-center font-bold text-slate-700 dark:text-slate-200 text-xs">
                    {item.quantity_sold} {item.unit ? (item.units?.[item.unit] || (item.unit === 'large' ? 'علبة' : item.unit === 'medium' ? 'شريط' : 'وحدة')) : ''}
                  </div>
                  <div className="col-span-2 text-left font-semibold text-slate-500">{item.unit_price.toFixed(2)}</div>
                  <div className="col-span-2 text-left font-black text-slate-900 dark:text-white">{(item.quantity_sold * item.unit_price).toFixed(2)}</div>
                </div>
              ))}
              {(!invoice.sales_items || invoice.sales_items.length === 0) && (
                <div className="py-4 flex flex-col items-center justify-center text-slate-400 gap-1 text-xs">
                  <p className="font-bold italic">لا توجد أصناف مسجلة</p>
                </div>
              )}
            </div>
          </div>

          {/* Totals & Payment Section */}
          <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-3 items-end">
            <div>
              <div className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-100 dark:border-slate-800">
                <span className="text-sm">
                  {invoice.payment_method === 'cash' ? '💵' : 
                   invoice.payment_method === 'credit' ? '💳' :
                   invoice.payment_method === 'visa' ? '🏦' : '💸'}
                </span>
                <div>
                  <p className="text-[8px] font-black text-slate-400 uppercase">طريقة الدفع</p>
                  <span className="font-bold text-slate-800 dark:text-white text-xs">
                    {invoice.payment_method === 'cash' ? 'نقدي (Cash)' : 
                     invoice.payment_method === 'credit' ? 'حساب أجل (Credit)' :
                     invoice.payment_method === 'visa' ? 'فيزا (Visa)' : 'طرق أخرى'}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1 text-xs">
              <div className="flex justify-between items-center px-1 text-slate-500">
                <span className="font-bold text-[10px]">المجموع الفرعي:</span>
                <span className="font-bold text-[11px]">{subtotal.toFixed(2)} ج.م</span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between items-center px-1 text-rose-500 text-[10px]">
                  <span className="font-bold">إجمالي الخصم:</span>
                  <span className="font-bold">-{discount.toFixed(2)} ج.م</span>
                </div>
              )}
              <div className="pt-1.5 border-t border-slate-200 dark:border-slate-700 flex justify-between items-baseline">
                <span className="font-black text-slate-700 dark:text-slate-200 text-xs">المطلبوب:</span>
                <span className="text-xl font-black text-blue-600 dark:text-blue-400 tracking-tight">
                  {invoice.total_amount.toLocaleString()} <span className="text-[10px] text-slate-400 font-bold">ج.م</span>
                </span>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">
             <button 
               onClick={handlePrint} 
               className="flex items-center justify-center gap-2 bg-slate-900 text-white py-2.5 rounded-xl font-bold text-xs hover:bg-slate-800 transition-all shadow-md active:scale-95"
             >
               <Printer className="w-4 h-4 text-blue-400" /> 
               <span>طباعة حرارية</span>
             </button>
             <button 
               onClick={handleWhatsApp} 
               className="flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-xl font-bold text-xs hover:bg-emerald-700 transition-all shadow-md active:scale-95"
             >
               <Phone className="w-4 h-4" /> 
               <span>إرسال واتساب</span>
             </button>
          </div>
        </div>
      </div>
    </div>
  )
}
