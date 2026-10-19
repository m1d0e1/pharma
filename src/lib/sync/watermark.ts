import { dbExecute } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';

export type SyncWatermarkTable = 'cloud_drugs' | 'cloud_drug_interactions';

export async function setSyncWatermark(
  tableName: SyncWatermarkTable,
  lastSyncedAt: string,
): Promise<void> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_sync_watermark', { tableName, lastSyncedAt });
    return;
  }
  await dbExecute(
    'INSERT OR REPLACE INTO sync_metadata (table_name, last_synced_at) VALUES (?, ?)',
    [tableName, lastSyncedAt],
  );
}
