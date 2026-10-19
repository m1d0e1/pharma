import { isTauri } from '@/lib/env';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { dbExecute, dbGet } from '@/lib/db/tauri';
import { setSyncWatermark } from './watermark';

type SyncResult =
  | { success: true; count: number }
  | { success: false; error: string };

/**
 * Only public drug-interaction reference data is downloaded. Local writes are
 * idempotent, and the watermark moves only after every write has succeeded.
 */
export async function syncDrugInteractionsClient(): Promise<SyncResult> {
  if (!isTauri) {
    return { success: false, error: 'تحديث الأدوية والتفاعلات متاح فقط داخل تطبيق سطح المكتب.' };
  }

  try {
    const supabase = getSupabaseBrowserClient();
    const lastSync = await dbGet<{ last_synced_at: string }>(
      'SELECT last_synced_at FROM sync_metadata WHERE table_name = ?',
      ['cloud_drug_interactions'],
    );
    const lastSyncedAt = lastSync?.last_synced_at || '1970-01-01T00:00:00Z';
    const syncStartedAt = new Date().toISOString();

    const interactions: Array<{
      drug_1: string;
      drug_2: string;
      interaction_description: string;
    }> = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase
        .from('cloud_drug_interactions')
        .select('*')
        .gt('updated_at', lastSyncedAt)
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) return { success: false, error: 'فشل في جلب التفاعلات من السحابة' };
      const page = data || [];
      interactions.push(...page);
      if (page.length < pageSize) break;
    }

    for (let offset = 0; offset < interactions.length; offset += 200) {
      const chunk = interactions.slice(offset, offset + 200);
      const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
      const sql = `
        INSERT INTO drug_interactions (ingredient_a, ingredient_b, description_en)
        VALUES ${placeholders}
        ON CONFLICT(ingredient_a, ingredient_b) DO UPDATE SET
          description_en = excluded.description_en
      `;
      const params = chunk.flatMap(interaction => [
        interaction.drug_1,
        interaction.drug_2,
        interaction.interaction_description,
      ]);
      await dbExecute(sql, params);
    }

    await setSyncWatermark('cloud_drug_interactions', syncStartedAt);
    return { success: true, count: interactions.length };
  } catch (error) {
    console.error('Public interactions sync failed:', error);
    return { success: false, error: 'خطأ في مزامنة التفاعلات' };
  }
}
