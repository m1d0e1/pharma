'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import PatientListClient from '@/components/patients/PatientListClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { getPatientsAction } from '@/app/actions-client/patients';

export default function PatientsPage() {
  const [patients, setPatients] = useState<any[]>([]);
  const [pharmacyId, setPharmacyId] = useState<string>('local_default');
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadRequestRef = useRef(0);

  const loadPatients = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(false);
    setUser(null);
    setAllowed(false);
    try {
      const userObj = await getClientSession();
      if (requestId !== loadRequestRef.current) return;
      if (userObj) {
        setUser(userObj);
        setPharmacyId(userObj.pharmacy_id || 'local_default');

        const isAllowed = hasUserPermissionSync(userObj, 'can_view_patients');
        setAllowed(isAllowed);

        if (isAllowed) {
          const result = await getPatientsAction();
          if (requestId !== loadRequestRef.current) return;
          if (result.success) {
            setPatients((result.data || []).slice(0, 200));
          } else {
            setLoadError(true);
          }
        }
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load patients:', err);
      setLoadError(true);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPatients();
  }, [loadPatients]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center py-12 gap-4" dir="rtl">
        <p className="font-black text-slate-700 dark:text-slate-200">تعذر تحميل بيانات المرضى</p>
        <button type="button" onClick={() => void loadPatients()} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">دليل المرضى</h1>
          <p className="text-slate-500 mt-1">إدارة بيانات المرضى وتاريخهم الصحي.</p>
        </div>
      </div>

      <PatientListClient
        initialPatients={patients || []}
        pharmacyId={pharmacyId}
        canDeletePatients={hasUserPermissionSync(user, 'can_delete_patients')}
      />
    </div>
  );
}
