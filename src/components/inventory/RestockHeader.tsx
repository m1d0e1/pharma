'use client';

import React, { useState } from 'react';
import PurchaseOrderModal from './PurchaseOrderModal';

interface Props {
  initialItems: any[];
}

export default function RestockHeader({ initialItems }: Props) {
  const [showPO, setShowPO] = useState(false);

  return (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">إعادة التموين الآلي</h1>
          <p className="text-slate-500 mt-1">يتم عرض الأدوية التي وصلت للحد الأدنى للمخزون تلقائياً.</p>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => setShowPO(true)}
            className="bg-emerald-600 text-white px-8 py-3 rounded-2xl font-black shadow-lg shadow-emerald-500/20 hover:bg-emerald-700 transition-all flex items-center gap-2"
          >
            <span>📝</span> إنشاء أمر شراء
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
