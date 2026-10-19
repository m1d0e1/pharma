import { getSupabaseBrowserClient } from '@/lib/supabase';
import { dbGet } from '@/lib/db/tauri';
import { syncMasterDrugsToLocal } from '@/app/actions-client/sync';
import { setSyncWatermark } from '@/lib/sync/watermark';
import { syncDrugInteractionsClient } from './interactions';

export async function syncFromCloudClient() {
  try {
    const supabase = getSupabaseBrowserClient();

    // sync_metadata is migration-owned (Tauri migration 003 / canonical local schema).
    // Runtime schema mutation is intentionally not exposed through the renderer.

    // Get last sync timestamps
    const drugsSyncRow = await dbGet('SELECT last_synced_at FROM sync_metadata WHERE table_name = ?', ['cloud_drugs']) as any;
    
    const lastDrugsSync = drugsSyncRow?.last_synced_at || '1970-01-01T00:00:00Z';
    
    const nowSyncTime = new Date().toISOString();

    // 3. Fetch and Sync Master Drugs (Incremental)
    console.log(`Fetching master drugs updated after ${lastDrugsSync}...`);
    let allDrugs: any[] = [];
    let from = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data: batch, error: drugsError } = await supabase
        .from('cloud_drugs')
        .select('*')
        .gt('updated_at', lastDrugsSync)
        .order('id', { ascending: true })
        .range(from, from + batchSize - 1);

      if (drugsError) {
        console.error('Drugs fetch error:', drugsError);
        return { success: false, error: 'فشل في جلب قائمة الأدوية من السحابة' };
      }

      if (batch && batch.length > 0) {
        allDrugs = [...allDrugs, ...batch];
        from += batchSize;
        if (batch.length < batchSize) hasMore = false;
      } else {
        hasMore = false;
      }
    }

    console.log(`Fetched ${allDrugs.length} new/updated drugs.`);

    if (allDrugs.length > 0) await syncMasterDrugsToLocal(allDrugs);

    // Update last sync time for drugs
    await setSyncWatermark('cloud_drugs', nowSyncTime);

    const interactions = await syncDrugInteractionsClient();
    if ('error' in interactions) return { success: false, error: interactions.error };

    console.log(`Sync completed successfully on client. Synced ${allDrugs.length} drugs.`);

    return { 
      success: true, 
      message: `تمت مزامنة ${allDrugs.length} صنفاً مع الحفاظ على بيانات الأصناف المرجعية المحلية.`,
      syncedUsernames: []
    };

  } catch (error) {
    console.error('Client Sync error:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء المزامنة' };
  }
}
