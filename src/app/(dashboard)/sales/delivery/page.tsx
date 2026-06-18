'use client';

import React, { useEffect, useState } from 'react';
import DeliveryManagementClient from '@/components/sales/DeliveryManagementClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';

export default function DeliveryPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkPermission() {
      try {
        const localUser = await getClientSession();
        if (localUser) {
          setUser(localUser);

          const isAllowed = hasUserPermissionSync(localUser, 'can_view_delivery');

          if (isAllowed) {
            setAllowed(true);
          }
        }
      } catch (err) {
        console.error('Failed to load delivery permission:', err);
      } finally {
        setLoading(false);
      }
    }

    checkPermission();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return (
    <div className="container mx-auto py-8">
      <DeliveryManagementClient />
    </div>
  );
}
