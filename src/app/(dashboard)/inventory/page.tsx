'use client';

import React, { useEffect, useRef, useState, Suspense } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getInventoryListAction } from '@/app/actions-client/inventory';
import InventoryTable from '@/components/inventory/InventoryTable';
import InventoryClientWrapper from '@/components/InventoryClientWrapper';
import { useSearchParams } from 'next/navigation';
import { subscribeInventoryChanges } from '@/lib/inventory/refresh';

function InventoryPageContent() {
  const searchParams = useSearchParams();
  const requestedSearch = searchParams.get('search') || '';
  const rawDrugId = Number(searchParams.get('drugId'));
  const requestedDrugId = Number.isSafeInteger(rawDrugId) && rawDrugId > 0 ? rawDrugId : undefined;
  const [items, setItems] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState(requestedSearch);
  const [selectedDrugId, setSelectedDrugId] = useState<number | undefined>(requestedDrugId);
  const [pharmacyId, setPharmacyId] = useState<string>('local_default');
  const [canManageInventory, setCanManageInventory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const hasLoadedRef = useRef(false);
  // Reading every inventory lot can take multiple native pages. Keep only one
  // expensive scan in flight and let the latest requested refresh follow it.
  const inventoryReadRef = useRef<Promise<void> | null>(null);

  const refreshInventory = () => setRefreshTrigger(prev => prev + 1);

  // Next.js preserves this page instance when only the query string changes.
  // Keep deep links to a different drug or search term from showing old rows.
  // Local typing is unaffected because this effect runs only on URL changes.
  useEffect(() => {
    setSearchTerm(requestedSearch);
    setSelectedDrugId(requestedDrugId);
  }, [requestedSearch, requestedDrugId]);

  useEffect(() => subscribeInventoryChanges((event?: Event) => {
    // Focusing the app while its first scan is already running does not
    // indicate changed stock. Explicit inventory/storage notifications below
    // still request a fresh snapshot once that scan finishes.
    if (event?.type === 'focus' && inventoryReadRef.current) return;
    setRefreshTrigger(prev => prev + 1);
  }), []);

  useEffect(() => {
    let active = true;
    async function loadInventory() {
      // A new filter or inventory notification supersedes the prior result.
      // Wait for that read to settle instead of issuing overlapping full scans.
      const previousRead = inventoryReadRef.current;
      if (previousRead) {
        await previousRead;
        if (!active) return;
      }

      setLoading(true);
      setLoadError('');
      setRefreshError('');
      const read = (async () => {
        try {
          const localUser = await getClientSession();
          // Avoid launching a multi-page native read after tab navigation.
          if (!active) return;
          if (localUser) {
            setPharmacyId(localUser.pharmacy_id || 'local_default');
            setCanManageInventory(hasUserPermissionSync(localUser, 'can_manage_inventory'));
          }

          const res = await getInventoryListAction(searchTerm, selectedDrugId);
          if (res.success && active) {
            setItems(res.data);
            hasLoadedRef.current = true;
            setHasLoaded(true);
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
      })();
      inventoryReadRef.current = read;
      await read;
      if (inventoryReadRef.current === read) inventoryReadRef.current = null;
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

  if (loading && items.length === 0 && !hasLoaded) {
    return (
      <div role="status" aria-live="polite" className="flex justify-center items-center gap-3 py-24 text-slate-500" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        <span className="text-sm font-medium">جاري تحميل المخزون...</span>
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
      <div role="status" aria-live="polite" className="flex justify-center items-center gap-3 py-24 text-slate-500" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        <span className="text-sm font-medium">جاري تحميل المخزون...</span>
      </div>
    }>
      <InventoryPageContent />
    </Suspense>
  );
}
