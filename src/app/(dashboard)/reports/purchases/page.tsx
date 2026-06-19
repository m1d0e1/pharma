'use client';
import React, { useEffect, useState } from 'react';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import { getClientSession } from '@/lib/auth/local';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';

export default function PurchasesReportsPage() {
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
    <div className="container mx-auto py-8">
      <PurchasesReportsClient userRole={user.role} />
    </div>
  );
}