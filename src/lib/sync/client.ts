import { getSupabaseBrowserClient } from '@/lib/supabase';
import { dbExecute, dbGet } from '@/lib/db/tauri';
import { syncMasterDrugsToLocal } from '@/app/actions-client/sync';

export async function syncFromCloudClient() {
  try {
    const supabase = getSupabaseBrowserClient();

    // --- INCREMENTAL SYNC LOGIC ---
    
    // Ensure table exists (self-healing if migrations haven't run/restarted yet)
    await dbExecute(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        table_name TEXT PRIMARY KEY,
        last_synced_at TEXT
      )
    `);
    
    // Get last sync timestamps
    const drugsSyncRow = await dbGet('SELECT last_synced_at FROM sync_metadata WHERE table_name = ?', ['cloud_drugs']) as any;
    const intSyncRow = await dbGet('SELECT last_synced_at FROM sync_metadata WHERE table_name = ?', ['cloud_drug_interactions']) as any;
    
    const lastDrugsSync = drugsSyncRow?.last_synced_at || '1970-01-01T00:00:00Z';
    const lastIntSync = intSyncRow?.last_synced_at || '1970-01-01T00:00:00Z';
    
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
    await dbExecute('INSERT OR REPLACE INTO sync_metadata (table_name, last_synced_at) VALUES (?, ?)', ['cloud_drugs', nowSyncTime]);

    // 4. Fetch and Sync Drug Interactions (Incremental)
    console.log(`Fetching interactions updated after ${lastIntSync}...`);
    let allInteractions: any[] = [];
    let intFrom = 0;
    let intHasMore = true;

    while (intHasMore) {
      const { data: intBatch, error: intError } = await supabase
        .from('cloud_drug_interactions')
        .select('*')
        .gt('updated_at', lastIntSync)
        .order('id', { ascending: true })
        .range(intFrom, intFrom + batchSize - 1);

      if (intError) {
        console.error('Interactions fetch error:', intError);
        return { success: false, error: 'فشل في جلب تداخلات الأدوية من السحابة' };
      }

      if (intBatch && intBatch.length > 0) {
        allInteractions = [...allInteractions, ...intBatch];
        intFrom += batchSize;
        if (intBatch.length < batchSize) intHasMore = false;
      } else {
        intHasMore = false;
      }
    }

    console.log(`Fetched ${allInteractions.length} new/updated interactions.`);

    if (allInteractions.length > 0) {
      console.log(`Inserting ${allInteractions.length} interactions in batches...`);
      const batchSize = 200;
      for (let i = 0; i < allInteractions.length; i += batchSize) {
        const chunk = allInteractions.slice(i, i + batchSize);
        const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
        const sql = `
          INSERT INTO drug_interactions 
          (ingredient_a, ingredient_b, description_en) 
          VALUES ${placeholders}
          ON CONFLICT(ingredient_a, ingredient_b) DO UPDATE SET
            description_en = excluded.description_en
        `;
        const params: any[] = [];
        for (const inter of chunk) {
          params.push(
            inter.drug_1,
            inter.drug_2,
            inter.interaction_description
          );
        }
        await dbExecute(sql, params);
      }
    }

    // Update last sync time for interactions
    await dbExecute('INSERT OR REPLACE INTO sync_metadata (table_name, last_synced_at) VALUES (?, ?)', ['cloud_drug_interactions', nowSyncTime]);

    const syncedUsernames: string[] = [];

    console.log(`Sync completed successfully on client. Synced ${allDrugs.length} drugs.`);

    return { 
      success: true, 
      message: `تمت مزامنة ${allDrugs.length} صنفاً مع الحفاظ على بيانات الأصناف المرجعية المحلية.`,
      syncedUsernames: Array.from(new Set(syncedUsernames))
    };

  } catch (error) {
    console.error('Client Sync error:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء المزامنة' };
  }
}
