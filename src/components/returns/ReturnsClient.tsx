'use client';

import React, { useState } from 'react';
import { Search, Plus, FileText, ArrowRightLeft, Clock } from 'lucide-react';
import Link from 'next/link';

export default function ReturnsClient({ title }: { title: string }) {
  const [searchTerm, setSearchTerm] = useState('');

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{title}</h1>
          <p className="text-slate-500 text-sm mt-1">سجل المرتجعات وإدارتها</p>
        </div>
        
        <Link href="/purchases/returns/new" className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl transition-colors font-bold text-sm">
          <Plus className="w-4 h-4" />
          إضافة مرتجع
        </Link>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap gap-4 items-center justify-between">
          <div className="relative w-full md:w-96">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text"
              placeholder="بحث برقم المرتجع أو المورد..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl focus:ring-2 focus:ring-primary-500 transition-all"
            />
          </div>
        </div>

        <div className="p-12 text-center flex flex-col items-center justify-center">
          <div className="w-20 h-20 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
            <ArrowRightLeft className="w-10 h-10 text-slate-400" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">لا توجد مرتجعات</h3>
          <p className="text-slate-500 max-w-sm mx-auto mb-6">
            لم تقم بإنشاء أي مرتجعات بعد. يمكنك البدء بإضافة أول مرتجع.
          </p>
        </div>
      </div>
    </div>
  );
}
