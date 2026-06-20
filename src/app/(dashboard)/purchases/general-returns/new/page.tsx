'use client';

import React from 'react';

export default function NewGeneralReturnPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center" dir="rtl">
      <div className="w-24 h-24 bg-orange-100 rounded-full flex items-center justify-center mb-6">
        <span className="text-4xl">🚧</span>
      </div>
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">جاري العمل على هذه الصفحة</h1>
      <p className="text-slate-500 max-w-md">
        شاشة مرتجعات المشتريات العامة قيد التطوير حالياً. سيتم إضافتها في التحديث القادم قريباً.
      </p>
    </div>
  );
}
