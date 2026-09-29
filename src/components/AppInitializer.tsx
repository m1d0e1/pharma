'use client';

import { useEffect } from 'react';
import { toast } from 'react-hot-toast';
import { secureCache } from '@/lib/cache/secure_cache';
import { isTauri } from '@/lib/env';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import type { OrphanedInventoryItem } from '@/lib/inventory/placeholder-migration';

function showRestoredItemsNotification(items: OrphanedInventoryItem[]) {
  const count = items.length;
  toast.success(
    () => (
      <div className="flex flex-col gap-1 text-right" dir="rtl">
        <span className="text-sm font-bold">📦 تم استعادة وتنشيط {count} صنفاً في المخزون</span>
        <span className="text-xs text-slate-600 dark:text-slate-300">
          تم تصحيح فرع الدفعات القديمة ونقلها للفرع المحلي الافتراضي لتظهر في مخزونه.
        </span>
        {count <= 5 ? (
          <ul className="mt-1 list-inside list-disc text-xs text-slate-500">
            {items.map(item => (
              <li key={item.id}>
                {item.trade_name} ({Number(item.quantity).toFixed(2)} وحدة)
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-slate-500">
            أمثلة: {items.slice(0, 3).map(item => item.trade_name).join('، ')} وغيرها...
          </span>
        )}
      </div>
    ),
    { duration: 10000, position: 'top-center' },
  );
}

export default function AppInitializer({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (isTauri) {
      const log = (m: string) => (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });
      log('APPINIT: starting secureCache.load()');
      secureCache.load().then(() => {
        log('APPINIT: secureCache loaded OK');
        console.log('SecureCache loaded on client');
        return import('@/lib/inventory/placeholder-migration').then(async ({ migrateLegacyPlaceholderInventoryScope }) => {
          const migration = await migrateLegacyPlaceholderInventoryScope();
          if (migration.changed) {
            await secureCache.reload();
            notifyInventoryChanged();
          }
          if (migration.affectedItems.length > 0) {
            showRestoredItemsNotification(migration.affectedItems);
          }
        });
      }).then(() => {
        // Auto-fix bad dates (DD/MM/YYYY to YYYY-MM-DD)
        return import('@/lib/db/tauri').then(async ({ dbExecute }) => {
          const sqlInv = `UPDATE inventory SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2) WHERE expiry_date LIKE '__/__/____'`;
          const sqlPur = `UPDATE purchase_invoice_items SET expiry_date = substr(expiry_date, 7, 4) || '-' || substr(expiry_date, 4, 2) || '-' || substr(expiry_date, 1, 2) WHERE expiry_date LIKE '__/__/____'`;
          await Promise.all([dbExecute(sqlInv), dbExecute(sqlPur)]);
        });
      }).catch(err => {
        console.error('App initialization repair failed', err);
        log(`APPINIT: startup repair failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }, []);

  return <>{children}</>;
}
