'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import SuppliersManagementClient from '@/components/purchases/SuppliersManagementClient';
import {
  addSupplierAction,
  deleteSupplierAction,
  getSuppliersAction,
  updateSupplierAction,
} from '@/app/actions-client/purchases';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isTauri } from '@/lib/env';

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [canPay, setCanPay] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const hasLoadedRef = useRef(false);

  const loadSuppliers = useCallback(async () => {
    const isInitialLoad = !hasLoadedRef.current;
    if (isInitialLoad) setLoading(true);
    try {
      const [result, session] = await Promise.all([getSuppliersAction(), getClientSession()]);
      if (!result.success) throw new Error(result.error || 'فشل تحميل الموردين');
      setSuppliers(result.data || []);
      setLoadError('');
      setRefreshError('');
      // Creation alone now has a typed native writer. Generic edits/deletes
      // remain blocked; native session/permission/tenant proof is authoritative.
      setCanCreate(isTauri && !!session
        && ['owner', 'admin'].includes(String(session.role || '').trim().toLowerCase())
        && Boolean(session.pharmacy_id)
        && session.pharmacy_id !== 'local_default'
        && hasUserPermissionSync(session, 'can_view_suppliers'));
      setCanPay(isTauri && !!session
        && typeof session.pharmacy_id === 'string'
        && !!session.pharmacy_id.trim()
        && session.pharmacy_id !== 'local_default'
        && hasUserPermissionSync(session, 'can_view_suppliers')
        && hasUserPermissionSync(session, 'acc_can_process_cash_flow'));
      hasLoadedRef.current = true;
    } catch (err) {
      console.error('Failed to load suppliers:', err);
      if (isInitialLoad) {
        const reason = err instanceof Error ? err.message : '';
        setLoadError(reason.includes('Legacy purchasing ownership needs independent tenant verification')
          ? 'تعذر التحقق من ملكية بيانات الموردين. يلزم إثبات تبعية فواتير المشتريات للصيدلية قبل عرض دليل الموردين وأرصدتهم.'
          : (reason || 'فشل تحميل الموردين'));
      } else {
        setRefreshError('تعذر تحديث قائمة الموردين');
      }
    } finally {
      if (isInitialLoad) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  const handleAdd = async (data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => {
    return addSupplierAction(data);
  };

  const handleUpdate = async (id: number, data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => {
    return updateSupplierAction(id, data);
  };

  const handleDelete = async (id: number) => {
    return deleteSupplierAction(id);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-red-200 bg-red-50 p-6 text-center font-bold text-red-700" dir="rtl">
        <p role="alert">{loadError}</p>
        <button type="button" onClick={() => void loadSuppliers()}
          className="rounded-xl bg-white px-5 py-2.5 font-bold text-red-800 shadow-sm ring-1 ring-red-200">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {refreshError && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800" dir="rtl">
          <span className="font-bold">{refreshError}</span>
          <button
            type="button"
            onClick={() => void loadSuppliers()}
            className="rounded-xl bg-white px-4 py-2 text-xs font-black shadow-sm ring-1 ring-amber-200"
          >
            إعادة تحميل الموردين
          </button>
        </div>
      )}
      <div className="flex justify-between items-center" dir="rtl">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">دليل الموردين والحسابات</h1>
          <p className="text-slate-500 font-bold mt-1">{isTauri
            ? 'متابعة مديونيات الموردين، كشوف الحسابات، وسداد الدفعات النقدية والبنكية.'
            : 'متابعة مديونيات الموردين وكشوف الحسابات.'}</p>
        </div>
      </div>

      <SuppliersManagementClient
        initialData={suppliers}
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onRefresh={loadSuppliers}
        canMutate={false}
        canCreate={canCreate}
        canPay={canPay}
      />
    </div>
  );
}
