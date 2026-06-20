'use client';

import { useEffect, useState } from 'react';
import { secureCache } from '@/lib/cache/secure_cache';

export default function AppInitializer({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Determine if we are in Tauri
    const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
    
    if (isTauri) {
      secureCache.load().then(() => {
        console.log('SecureCache loaded on client');
        
        // Auto-fix bad dates (DD/MM/YYYY to YYYY-MM-DD)
        import('@/lib/db/tauri').then(({ dbExecute }) => {
          const sqlInv = `UPDATE inventory SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2) WHERE expiry_date LIKE '__/__/____'`;
          const sqlPur = `UPDATE purchase_invoice_items SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2) WHERE expiry_date LIKE '__/__/____'`;
          dbExecute(sqlInv).catch(() => {});
          dbExecute(sqlPur).catch(() => {});
        });

        setLoaded(true);
      }).catch(err => {
        console.error('Failed to load SecureCache on client', err);
        setLoaded(true); // Proceed anyway to avoid blocking the whole app
      });
    } else {
      // In web browser / Next.js Server, it loads synchronously on the server
      setLoaded(true);
    }
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center flex flex-col items-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-slate-600 font-medium">جاري تهيئة قاعدة البيانات الآمنة...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
