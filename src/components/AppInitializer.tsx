'use client';

import { useEffect } from 'react';
import { secureCache } from '@/lib/cache/secure_cache';
import { isTauri } from '@/lib/env';

export default function AppInitializer({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (isTauri) {
      const log = (m: string) => (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });
      log('APPINIT: starting secureCache.load()');
      secureCache.load().then(() => {
        log('APPINIT: secureCache loaded OK');
        console.log('SecureCache loaded on client');
        
        // Auto-fix bad dates (DD/MM/YYYY to YYYY-MM-DD)
        import('@/lib/db/tauri').then(({ dbExecute }) => {
          const sqlInv = `UPDATE inventory SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2) WHERE expiry_date LIKE '__/__/____'`;
          const sqlPur = `UPDATE purchase_invoice_items SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2) WHERE expiry_date LIKE '__/__/____'`;
          dbExecute(sqlInv).catch(() => {});
          dbExecute(sqlPur).catch(() => {});
        });
      }).catch(err => {
        console.error('Failed to load SecureCache on client', err);
      });
    }
  }, []);

  return <>{children}</>;
}
