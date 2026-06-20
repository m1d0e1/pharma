'use client';
import React, { useEffect, useState } from 'react';
import TrialBalanceReport from '@/components/reports/TrialBalanceReport';
import { getClientSession } from '@/lib/auth/local';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';
import { Printer } from 'lucide-react';

export default function TrialBalanceReportPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      const sessionUser = await getClientSession();
      if (!sessionUser) {
        router.push('/login');
      } else {
        setUser(sessionUser);
        setLoading(false);
      }
    }
    checkAuth();
  }, [router]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (user.role !== 'owner' && user.role !== 'admin') {
    return <AccessDenied />;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">ميزان المراجعة</h1>
        <button onClick={() => window.print()} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl font-bold shadow-sm hover:bg-blue-700 transition-all no-print">
          <Printer className="w-5 h-5" />
          طباعة التقرير
        </button>
      </div>
      <TrialBalanceReport userRole={user.role} />
    </div>
  );
}