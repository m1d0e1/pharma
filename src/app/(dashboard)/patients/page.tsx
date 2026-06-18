'use client';

import React, { useEffect, useState } from 'react';
import PatientListClient from '@/components/patients/PatientListClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { dbSelect } from '@/lib/db/tauri';
import AccessDenied from '@/components/AccessDenied';

export default function PatientsPage() {
  const [patients, setPatients] = useState<any[]>([]);
  const [pharmacyId, setPharmacyId] = useState<string>('local_default');
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function loadPatients() {
      try {
        const userObj = await getClientSession();
        if (userObj) {
          setUser(userObj);
          setPharmacyId(userObj.pharmacy_id || 'local_default');

          const isAllowed = hasUserPermissionSync(userObj, 'can_view_patients');

          if (isAllowed) {
            setAllowed(true);
            const data = await dbSelect(`
              SELECT * FROM patients
              ORDER BY created_at DESC
              LIMIT 200
            `);
            setPatients(data);
          }
        }
      } catch (err) {
        console.error('Failed to load patients:', err);
      } finally {
        setLoading(false);
      }
    }

    loadPatients();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
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

      <PatientListClient initialPatients={patients || []} pharmacyId={pharmacyId} />
    </div>
  );
}
