'use client';


import React, { useState, useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook';
import { AlertTriangle, Info, X, ShieldAlert, HeartPulse } from 'lucide-react';

interface Alert {
  type: 'interaction' | 'allergy' | 'condition';
  severity: string;
  // Interaction fields
  ingredient_a?: string;
  ingredient_b?: string;
  description_ar?: string;
  description_en?: string;
  recommendation?: string;
  // Allergy/Condition fields
  message_ar?: string;
  message_en?: string;
}

interface Props {
  alerts: Alert[];
  onClose: () => void;
  onConfirm?: () => void;
}

export default function ClinicalAlertModal({ alerts, onClose, onConfirm }: Props) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[150]" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-300">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-red-50 dark:bg-red-900/20">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-red-600 w-6 h-6" />
            <h2 className="text-xl font-black text-red-900 dark:text-red-200">تحذير: سلامة المريض</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-full transition-colors text-red-900 dark:text-red-200">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 max-h-[60vh] overflow-auto space-y-4">
          {alerts.map((alert, idx) => (
            <div key={idx} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700">
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                  {alert.type === 'interaction' ? (
                     <div className="flex items-center gap-2 font-black text-slate-900 dark:text-white">
                        <span className="px-2 py-1 bg-red-100 dark:bg-red-900/40 text-red-600 rounded-lg text-xs">{alert.ingredient_a}</span>
                        <span className="text-slate-400">+</span>
                        <span className="px-2 py-1 bg-red-100 dark:bg-red-900/40 text-red-600 rounded-lg text-xs">{alert.ingredient_b}</span>
                     </div>
                  ) : alert.type === 'allergy' ? (
                     <div className="flex items-center gap-2 text-amber-600 font-black">
                        <ShieldAlert className="w-5 h-5" />
                        <span>حساسية دواء</span>
                     </div>
                  ) : (
                    <div className="flex items-center gap-2 text-rose-600 font-black">
                        <HeartPulse className="w-5 h-5" />
                        <span>موانع استخدام مرضية</span>
                     </div>
                  )}
                </div>
                <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${
                  alert.severity === 'critical' || alert.severity === 'high' ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
                }`}>
                  {alert.severity === 'critical' || alert.severity === 'high' ? 'خطير جداً' : 'تنبيه'}
                </span>
              </div>
              
              <p className="text-slate-700 dark:text-slate-300 font-bold mb-3">
                {alert.type === 'interaction' ? (alert.description_ar || alert.description_en) : (alert.message_ar || alert.message_en)}
              </p>

              {alert.recommendation && (
                <div className="flex items-start gap-2 text-sm bg-blue-50 dark:bg-blue-900/20 p-3 rounded-xl border border-blue-100 dark:border-blue-900/40">
                  <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-black text-blue-900 dark:text-blue-200">التوصية الطبية:</p>
                    <p className="text-blue-800 dark:text-blue-300">{alert.recommendation}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="p-6 bg-slate-50 dark:bg-slate-800 flex gap-4">
          <button 
            onClick={onClose}
            className="flex-1 px-6 py-4 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl font-bold hover:bg-slate-50 dark:hover:bg-slate-600 transition-all"
          >
            إلغاء وتعديل السلة
          </button>
          {onConfirm && (
            <button 
              onClick={onConfirm}
              className="flex-1 px-6 py-4 bg-red-600 text-white rounded-2xl font-black hover:bg-red-700 transition-all shadow-lg shadow-red-500/20"
            >
              استمرار على أي حال
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
