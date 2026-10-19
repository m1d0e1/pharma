'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { secureCache } from '@/lib/cache/secure_cache';
import { isTauri } from '@/lib/env';
import { getLocalSession } from '@/lib/auth/local';
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
  const pathname = usePathname();
  const initialized = useRef(false);

  useEffect(() => {
    if (isTauri && !initialized.current) {
      const log = (m: string) => (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });
      void getLocalSession().then(user => {
        if (!user || initialized.current) return;
        initialized.current = true;
        log('APPINIT: starting secureCache.load()');
        return secureCache.load().then(() => {
          log('APPINIT: secureCache loaded OK');
          console.log('SecureCache loaded on client');
          // Native legacy placeholder repair is explicitly restricted to an
          // audited local_default owner (inventory_repair.rs). A tenant-owned
          // pharmacy may never adopt placeholder/NULL history. Avoid retrying
          // a guaranteed-denied mutation on every QA/branch window mount.
          if (typeof user.pharmacy_id === 'string' && user.pharmacy_id.trim()
              && user.pharmacy_id.trim() !== 'local_default') return;
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
        });
      }).catch(err => {
        initialized.current = false;
        console.error('App initialization repair failed', err);
        log(`APPINIT: startup repair failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }, [pathname]);

  return <>{children}</>;
}
