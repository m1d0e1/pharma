'use client';

import React, { useState } from 'react';
import PurchaseOrderModal from './PurchaseOrderModal';
import { FilePlus2 } from 'lucide-react';

interface Props {
  initialItems: any[];
}

export default function RestockHeader({ initialItems }: Props) {
  const [showPO, setShowPO] = useState(false);

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">إعادة التموين</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">الأصناف التي وصلت إلى حد إعادة الطلب.</p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setShowPO(true)}
            className="bg-emerald-700 text-white px-4 py-2.5 rounded-lg font-semibold shadow-sm hover:bg-emerald-800 transition-colors flex items-center gap-2"
          >
            <FilePlus2 className="w-4 h-4" aria-hidden="true" /> إنشاء أمر شراء
          </button>
        </div>
      </div>

      {showPO && (
        <PurchaseOrderModal 
          initialItems={initialItems} 
          onClose={() => setShowPO(false)} 
        />
      )}
    </>
  );
}
