'use client'

import React, { useState } from 'react'
import { toast } from 'react-hot-toast'
import ReceiptDetailsModal from './ReceiptDetailsModal'
import { generateReceiptHtml, generateWhatsAppMessage, printHtmlContent } from '@/lib/utils/printing'
import { getConfigAction } from '@/app/actions/config'

interface SaleItem {
  quantity_sold: number
  unit_price: number
  inventory: {
    master_drugs: {
      trade_name: string
    }
  }
}

interface Invoice {
  id: string
  total_amount: number
  created_at: string
  profiles: { full_name: string }
  patients: { full_name: string, phone: string } | null
  sales_items: SaleItem[]
}

interface Props {
  initialInvoices: Invoice[]
}

export default function ReceiptListClient({ initialInvoices }: Props) {
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [mounted, setMounted] = useState(false)
  const [pharmacyInfo, setPharmacyInfo] = useState({ name: 'صيدلية فارما تيك', phone: '', address: '' })

  React.useEffect(() => {
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

  const filteredInvoices = initialInvoices.filter(inv => {
    const term = searchTerm.toLowerCase();
    const idMatches = inv.id.toLowerCase().includes(term);
    const patientMatches = inv.patients?.full_name ? inv.patients.full_name.toLowerCase().includes(term) : false;
    const staffMatches = inv.profiles?.full_name ? inv.profiles.full_name.toLowerCase().includes(term) : false;
    return idMatches || patientMatches || staffMatches;
  })

  const formatDate = (dateStr: string) => {
    if (!mounted) return '' // Return empty or placeholder during SSR
    return new Date(dateStr).toLocaleString('ar-EG')
  }

  const handleDirectPrint = (inv: Invoice) => {
    const html = generateReceiptHtml(inv, pharmacyInfo);
    printHtmlContent(html);
  };

  const handleDirectWhatsApp = (inv: Invoice) => {
    if (!inv.patients?.phone) {
      toast.error('لا يوجد رقم هاتف مسجل لهذا العميل');
      return;
    }
    const message = generateWhatsAppMessage(inv, pharmacyInfo);
    const whatsappUrl = `https://wa.me/2${inv.patients.phone}?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank');
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
        <div className="relative flex-1">
          <span className="absolute inset-y-0 right-4 flex items-center text-slate-400">🔍</span>
          <input
            type="text"
            placeholder="بحث برقم الفاتورة أو اسم العميل..."
            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-12 pl-4 py-3 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-medium"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                <th className="px-8 py-5 text-sm font-bold text-slate-500">رقم الفاتورة</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500">التاريخ والوقت</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500">العميل</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500 text-center">الأصناف</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500">الإجمالي</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredInvoices.map((inv) => (
                <tr key={inv.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer" onClick={() => setSelectedInvoice(inv)}>
                  <td className="px-8 py-5 font-mono text-sm text-blue-600 font-bold">
                    #{inv.id.substring(0, 8)}
                  </td>
                  <td className="px-8 py-5 text-sm text-slate-600 dark:text-slate-400">
                    {formatDate(inv.created_at)}
                  </td>
                  <td className="px-8 py-5 text-sm font-bold">
                    {inv.patients?.full_name || 'عميل نقدي'}
                  </td>
                  <td className="px-8 py-5 text-center">
                    <span className="bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full text-xs font-bold">
                      {inv.sales_items.length} أصناف
                    </span>
                  </td>
                  <td className="px-8 py-5 font-black text-emerald-600">
                    {inv.total_amount.toLocaleString()} ج.م
                  </td>
                  <td className="px-8 py-5">
                    <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                       <button onClick={() => handleDirectPrint(inv)} className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-all" title="طباعة">🖨️</button>
                       <button onClick={() => handleDirectWhatsApp(inv)} className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-lg transition-all" title="واتساب">📱</button>
                    </div>
                  </td>
                </tr>
              ))}
              
              {filteredInvoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-16 text-center text-slate-400 font-bold">لم يتم العثور على فواتير.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedInvoice && (
        <ReceiptDetailsModal 
          invoice={selectedInvoice} 
          onClose={() => setSelectedInvoice(null)} 
        />
      )}
    </div>
  )
}
