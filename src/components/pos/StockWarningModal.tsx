'use client';
import { useHotkeys } from 'react-hotkeys-hook';;

import React, { useState, useEffect } from 'react';
import { X, PlusCircle } from 'lucide-react';

interface StockWarningModalProps {
  isOpen: boolean;
  onClose: () => void;
  drug: any;
  onNewPurchaseOrder: (drugId: number) => void;
  onNegativeSale: (drug: any) => void;
}

export default function StockWarningModal({
  isOpen,
  onClose,
  drug,
  onNewPurchaseOrder,
  onNegativeSale
}: StockWarningModalProps) {
  
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
if (!isOpen || !drug) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-[40px] p-10 max-w-lg w-full shadow-2xl border border-slate-100 dark:border-slate-800 text-center space-y-6">
        <div className="w-20 h-20 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center mx-auto text-rose-600">
          <X className="w-10 h-10" />
        </div>
        <h3 className="text-2xl font-black text-slate-950 dark:text-white">نفد المخزون!</h3>
        <p className="text-slate-500 font-bold text-sm">
          لا يوجد كميات متوفرة من "{drug.trade_name}" حالياً. كيف ترغب في المتابعة؟
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex gap-4">
            <button 
              onClick={() => onNewPurchaseOrder(drug.id)}
              className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black text-lg hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
            >
              <PlusCircle className="w-5 h-5" /> فاتورة شراء جديدة
            </button>
            <button 
              onClick={onClose}
              className="flex-1 py-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl font-black text-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
            >
              إلغاء
            </button>
          </div>
          <button 
            onClick={() => onNegativeSale(drug)}
            className="w-full py-4 bg-amber-500 text-white rounded-2xl font-black text-lg hover:bg-amber-600 transition-all shadow-lg shadow-amber-500/20 mt-2"
          >
            بيع بدون رصيد (تسوية لاحقاً)
          </button>
        </div>
      </div>
    </div>
  );
}
