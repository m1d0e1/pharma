'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { getClientSession } from '@/lib/auth/local';
import { getInventoryListAction } from '@/app/actions/inventory';
import InventoryTable from '@/components/inventory/InventoryTable';
import InventoryClientWrapper from '@/components/InventoryClientWrapper';
import { useSearchParams } from 'next/navigation';

function InventoryPageContent() {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const [pharmacyId, setPharmacyId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const refreshInventory = () => setRefreshTrigger(prev => prev + 1);

  useEffect(() => {
    let active = true;
    async function loadInventory() {
      try {
        const localUser = await getClientSession();
        if (localUser && active) {
          setPharmacyId(localUser.pharmacy_id || '');
        }

        const res = await getInventoryListAction(searchTerm);
        if (res.success && active) {
          setItems(res.data);
        } else if (!res.success && active) {
          console.error('Failed to load inventory:', (res as any).error);
        }
      } catch (err) {
        console.error('Failed to load inventory:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    const delayDebounceFn = setTimeout(() => {
      loadInventory();
    }, searchTerm ? 300 : 0);

    return () => {
      active = false;
      clearTimeout(delayDebounceFn);
    };
  }, [searchTerm, refreshTrigger]);

  if (loading && items.length === 0) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in slide-in-up" dir="rtl">
      <div className="page-header flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">المخزون الحالي</h1>
          <p className="text-slate-500 mt-1">تتبع الكميات، تواريخ الصلاحية، والأسعار لكل صنف دواء في الصيدلية</p>
        </div>
        <InventoryClientWrapper pharmacyId={pharmacyId} onSuccess={refreshInventory} />
      </div>
      <InventoryTable 
        items={items} 
        searchTerm={searchTerm} 
        setSearchTerm={setSearchTerm} 
        onRefresh={refreshInventory} 
      />
    </div>
  );
}

export default function InventoryPage() {
  return (
    <Suspense fallback={
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    }>
      <InventoryPageContent />
    </Suspense>
  );
}
