'use client';

import React from 'react';
import { Edit3, Search, LockKeyhole } from 'lucide-react';

// The action layer refuses correction candidates and writes in every runtime.
// Do not render an optimistic search result, editable sale row, or Save handler
// until source-verified append-only native posting and return reversal exist.
export default function CogsAdjustmentClient() {
  return (
    <div className="space-y-6 pb-20" dir="rtl">
      <section className="rounded-[40px] border border-slate-100 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-8">
        <h1 className="flex items-center gap-4 text-2xl font-black text-slate-800 dark:text-white sm:text-3xl">
          <Edit3 aria-hidden="true" className="h-9 w-9 shrink-0 text-blue-500" />
          تعديل تكلفة الأصناف المباعة
        </h1>
        <p className="mt-2 text-sm font-bold text-slate-500 dark:text-slate-400">
          تصحيح تكلفة الأصناف بعد البيع يتطلب إثباتاً محاسبياً أصلياً مستقلاً، ولا يُنفَّذ بتغيير تكلفة سطر البيع.
        </p>

        <p
          id="cogs-unavailable-notice"
          role="alert"
          className="mt-5 rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm font-bold leading-7 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
        >
          تصحيح تكلفة المبيعات غير متاح حالياً في التطبيق الأصلي أو المتصفح حتى التحقق من مصدر تكلفة الاقتناء
          وإثبات البيع والمرتجعات الأصلي، وتوفير تصحيح إضافي موثق بقيد مستقل غير قابل للتعديل وطلب يمنع التكرار،
          مع تسوية قيود المرتجعات اللاحقة والتقارير. لا يجوز إعادة كتابة تكلفة سطر بيع أو مرتجع مُرحّل أو تغيير
          قيده الأصلي. لا يعني تعطيل البحث عدم وجود مبيعات مسجلة؛ راجع تقرير المبيعات وميزان المراجعة.
        </p>

        <div
          role="group"
          aria-label="البحث وتصحيح تكلفة المبيعات غير متاح"
          className="mt-6 grid gap-5"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                aria-label="بحث باسم الصنف أو رقم الفاتورة"
                aria-describedby="cogs-unavailable-notice"
                placeholder="ابحث باسم الصنف أو رقم الفاتورة..."
                disabled
                readOnly
                className="w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-100 py-3 pl-4 pr-12 font-bold text-slate-500 opacity-70 dark:border-slate-700 dark:bg-slate-800"
              />
            </div>
            <button
              type="button"
              disabled
              aria-describedby="cogs-unavailable-notice"
              className="cursor-not-allowed rounded-2xl bg-slate-400 px-8 py-3 font-black text-white opacity-60"
            >
              بحث
            </button>
          </div>

          <div className="flex flex-col gap-3 border-t border-slate-200 pt-5 dark:border-slate-700 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-sm font-bold text-slate-600 dark:text-slate-300">
              التكلفة الجديدة
              <input
                type="number"
                aria-label="التكلفة الجديدة"
                aria-describedby="cogs-unavailable-notice"
                disabled
                readOnly
                className="mt-2 w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 opacity-60 dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
            <button
              type="button"
              disabled
              aria-describedby="cogs-unavailable-notice"
              className="flex cursor-not-allowed items-center justify-center gap-2 rounded-2xl bg-slate-400 px-8 py-3 font-black text-white opacity-60"
            >
              <LockKeyhole aria-hidden="true" className="h-5 w-5" />
              حفظ التكلفة
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
