'use client';

import React, { useEffect, useRef, useState, Suspense } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getInventoryListAction } from '@/app/actions-client/inventory';
import InventoryTable from '@/components/inventory/InventoryTable';
import InventoryClientWrapper from '@/components/InventoryClientWrapper';
import { useSearchParams } from 'next/navigation';

function InventoryPageContent() {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const [selectedDrugId, setSelectedDrugId] = useState<number | undefined>(() => {
    const value = Number(searchParams.get('drugId'));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  });
  const [pharmacyId, setPharmacyId] = useState<string>('local_default');
  const [canManageInventory, setCanManageInventory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const hasLoadedRef = useRef(false);

  const refreshInventory = () => setRefreshTrigger(prev => prev + 1);

  useEffect(() => {
    let active = true;
    async function loadInventory() {
      setLoading(true);
      setLoadError('');
      setRefreshError('');
      try {
        const localUser = await getClientSession();
        if (localUser && active) {
          setPharmacyId(localUser.pharmacy_id || 'local_default');
          setCanManageInventory(hasUserPermissionSync(localUser, 'can_manage_inventory'));
        }

        const res = await getInventoryListAction(searchTerm, selectedDrugId);
        if (res.success && active) {
          setItems(res.data);
          hasLoadedRef.current = true;
        } else if (!res.success && active) {
          console.error('Failed to load inventory:', (res as any).error);
          if (hasLoadedRef.current) setRefreshError('تعذر تحديث بيانات المخزون');
          else setLoadError('تعذر تحميل بيانات المخزون');
        }
      } catch (err) {
        console.error('Failed to load inventory:', err);
        if (active) {
          if (hasLoadedRef.current) setRefreshError('تعذر تحديث بيانات المخزون');
          else setLoadError('تعذر تحميل بيانات المخزون');
        }
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
  }, [searchTerm, selectedDrugId, refreshTrigger]);

  const updateSearchTerm = (value: string) => {
    setSelectedDrugId(undefined);
    setSearchTerm(value);
  };

  if (loading && items.length === 0) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button type="button" onClick={refreshInventory} className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in slide-in-up" dir="rtl">
      {refreshError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-800">
          <span className="font-black">{refreshError}</span>
          <button type="button" onClick={refreshInventory} className="px-4 py-2 rounded-xl bg-amber-700 text-white text-xs font-black">
            إعادة تحميل المخزون
          </button>
        </div>
      )}
      <div className="page-header flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">المخزون الحالي</h1>
          <p className="text-slate-500 mt-1">تتبع الكميات، تواريخ الصلاحية، والأسعار لكل صنف دواء في الصيدلية</p>
        </div>
        <InventoryClientWrapper pharmacyId={pharmacyId} onSuccess={refreshInventory} canManageInventory={canManageInventory} />
      </div>
      <InventoryTable 
        items={items} 
        searchTerm={searchTerm} 
        setSearchTerm={updateSearchTerm}
        onRefresh={refreshInventory} 
        pharmacyId={pharmacyId}
        canManageInventory={canManageInventory}
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
