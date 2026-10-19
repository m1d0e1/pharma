// The installed desktop app is the only supported runtime for reference-data sync.
import { isTauri } from '@/lib/env';

interface ReferenceSyncResult {
  success: boolean;
  error?: string;
  message?: string;
  syncedUsernames?: string[];
}

export async function syncFromCloud(): Promise<ReferenceSyncResult> {
  if (!isTauri) {
    return { success: false, error: 'تحديث الأدوية والتفاعلات متاح فقط داخل تطبيق سطح المكتب.' };
  }
  const { syncFromCloudClient } = await import('./client');
  return syncFromCloudClient();
}
