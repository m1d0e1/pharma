'use client'

import React, { useRef } from 'react'
import Barcode from 'react-barcode'
import { useReactToPrint } from 'react-to-print'
import { Printer, X } from 'lucide-react'

interface BarcodeItem {
  id: number | string
  trade_name: string
  trade_name_en: string
  barcode: string
  selling_price: number | string
  expiry_date: string
}

interface Props {
  items: BarcodeItem[]
  onClose: () => void
}

export default function BarcodePrinter({ items, onClose }: Props) {
  const componentRef = useRef<HTMLDivElement>(null)

  const handlePrint = useReactToPrint({
    contentRef: componentRef,
    documentTitle: 'Barcodes',
  })

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-4 z-[120] animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-hard w-full max-w-4xl overflow-hidden border border-slate-200 dark:border-slate-800 transform animate-in zoom-in duration-500 max-h-[90vh] flex flex-col">
        
        {/* Header */}
        <div className="p-8 border-b border-slate-50 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/20">
          <div>
            <h2 className="text-2xl font-black text-slate-900 dark:text-white">طباعة الباركود</h2>
            <p className="text-slate-500 text-xs font-bold mt-1">توليد ملصقات احترافية للأصناف المشتراة</p>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={() => handlePrint()}
              className="bg-primary-600 hover:bg-primary-700 text-white px-6 py-3 rounded-2xl font-black flex items-center gap-2 shadow-lg shadow-primary-500/20 transition-all active:scale-95"
            >
              <Printer className="w-5 h-5" />
              طباعة الكل
            </button>
            <button onClick={onClose} className="p-3 bg-slate-200 dark:bg-slate-800 rounded-2xl hover:rotate-90 transition-transform">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-12">
          <div 
            ref={componentRef} 
            className="grid grid-cols-3 gap-8 p-4 bg-white text-black"
            style={{ direction: 'rtl' }}
          >
            {items.map((item, idx) => (
              <div 
                key={`${item.id}-${idx}`} 
                className="border-2 border-slate-200 p-4 rounded-xl flex flex-col items-center justify-center text-center space-y-2 bg-white"
                style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}
              >
                <p className="font-black text-[14px] leading-tight line-clamp-1">{item.trade_name_en || item.trade_name}</p>
                <div className="scale-75 origin-center">
                  <Barcode 
                    value={item.barcode || `MD-${item.id}`} 
                    width={1.5}
                    height={50}
                    fontSize={12}
                    margin={0}
                  />
                </div>
                <div className="flex justify-between w-full text-[10px] font-black border-t border-slate-100 pt-1 mt-1">
                  <span>Price: {Number(item.selling_price).toFixed(2)}</span>
                  <span>Exp: {item.expiry_date || 'N/A'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Empty State */}
        {items.length === 0 && (
          <div className="p-20 text-center flex flex-col items-center opacity-30">
            <Printer className="w-20 h-20 mb-4" />
            <p className="font-black text-xl">لا توجد أصناف للطباعة</p>
          </div>
        )}
      </div>
    </div>
  )
}
