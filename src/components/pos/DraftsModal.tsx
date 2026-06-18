'use client';
import { useHotkeys } from 'react-hotkeys-hook';;

import React, { useState, useEffect } from 'react';
import { X, Loader2, FileText, Clock } from 'lucide-react';

interface DraftsModalProps {
  isOpen: boolean;
  onClose: () => void;
  drafts: any[];
  isLoadingDrafts: boolean;
  onLoadDraft: (draft: any) => void;
}

export default function DraftsModal({
  isOpen,
  onClose,
  drafts,
  isLoadingDrafts,
  onLoadDraft
}: DraftsModalProps) {
  
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-[40px] w-full max-w-2xl shadow-2xl border border-slate-100 dark:border-slate-800 flex flex-col max-h-[80vh]">
        <div className="p-8 border-b border-slate-50 dark:border-slate-800 flex justify-between items-center">
          <div>
            <h3 className="text-2xl font-black text-slate-950 dark:text-white">📁 المسودات المحفوظة</h3>
            <p className="text-slate-500 font-bold text-sm">اختر مسودة لاستكمال عملية البيع</p>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl transition-all">
            <X className="w-6 h-6 text-slate-700 dark:text-slate-300" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-4">
          {isLoadingDrafts ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-slate-400">
              <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
              <p className="font-bold">جاري تحميل المسودات...</p>
            </div>
          ) : drafts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-slate-400">
              <FileText className="w-16 h-16 opacity-20" />
              <p className="font-bold text-lg">لا يوجد مسودات حالياً</p>
            </div>
          ) : (
            drafts.map(draft => (
              <div 
                key={draft.id}
                className="group bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 hover:border-blue-500 transition-all cursor-pointer"
                onClick={() => onLoadDraft(draft)}
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <p className="font-black text-lg text-slate-800 dark:text-white">
                      {draft.patient_name || 'عميل عام'}
                    </p>
                    <div className="flex items-center gap-2 text-slate-400 text-xs font-bold mt-1">
                      <Clock className="w-3 h-3" />
                      {new Date(draft.created_at).toLocaleString('ar-EG')}
                    </div>
                  </div>
                  <div className="text-left">
                    <p className="text-xl font-black text-blue-600">{draft.total_amount} ج.م</p>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{draft.payment_method}</p>
                  </div>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  {draft.items.map((item: any, idx: number) => (
                    <span key={idx} className="bg-white dark:bg-slate-700 px-3 py-1 rounded-full text-[10px] font-bold border border-slate-100 dark:border-slate-600 text-slate-900 dark:text-slate-200">
                      {item.qty} x {item.trade_name_en || item.trade_name}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="p-8 bg-slate-50 dark:bg-slate-800/50 rounded-b-[40px] text-center">
          <button 
            onClick={onClose}
            className="px-10 py-4 bg-slate-800 text-white rounded-2xl font-black hover:bg-slate-700 transition-all"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
