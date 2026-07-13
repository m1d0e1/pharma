import { getSupabaseBrowserClient } from '@/lib/supabase';
import { dbExecute, dbTransaction, dbGet } from '@/lib/db/tauri';

export async function syncFromCloudClient() {
  try {
    const supabase = getSupabaseBrowserClient();

    // 1. Check Cloud User (Optional for public data sync)
    console.log('Checking cloud auth...');
    const { data, error: authError } = await supabase.auth.getUser();
    const user = data?.user;
    const isLoggedIn = !!user && !authError;

    let profile: any = null;
    if (isLoggedIn && user) {
      const { data: p } = await supabase
        .from('profiles')
        .select('*, pharmacies(*)')
        .eq('id', user.id)
        .single();
      profile = p;

      if (profile?.pharmacy_id) {
        // Save Pharmacy Config Locally
        await dbExecute(`
          INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
        `, ['pharmacy_id', profile.pharmacy_id]);
        
        await dbExecute(`
          INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
        `, ['pharmacy_name', profile.pharmacies?.name || '']);
      }
    }

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

    if (allDrugs.length > 0) {
      console.log(`Inserting ${allDrugs.length} drugs in batches...`);
      const batchSize = 100;
      for (let i = 0; i < allDrugs.length; i += batchSize) {
        const chunk = allDrugs.slice(i, i + batchSize);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const sql = `
          INSERT INTO master_drugs 
          (id, trade_name, trade_name_en, generic_name, active_ingredient, category, manufacturer, official_price) 
          VALUES ${placeholders}
          ON CONFLICT(id) DO UPDATE SET
            trade_name = excluded.trade_name,
            trade_name_en = excluded.trade_name_en,
            generic_name = excluded.generic_name,
            active_ingredient = excluded.active_ingredient,
            category = excluded.category,
            manufacturer = excluded.manufacturer,
            official_price = excluded.official_price
        `;
        const params: any[] = [];
        for (const drug of chunk) {
          params.push(
            drug.id,
            drug.trade_name || '',
            null, // trade_name_en not in csv
            null, // generic_name not in csv
            drug.active_ingredient || null,
            drug.category || null,
            drug.manufacturer || null,
            drug.price || 0
          );
        }
        await dbExecute(sql, params);
      }
    }

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

    // 4. Fetch all Pharmacists for this Pharmacy (only if logged in)
    let staffMembers: any[] | null = null;
    const syncedUsernames: string[] = [];
    
    if (profile?.pharmacy_id) {
      const { data: staff } = await supabase
        .from('profiles')
        .select('*')
        .eq('pharmacy_id', profile.pharmacy_id);
      staffMembers = staff;

      if (staffMembers) {
        await dbTransaction(async () => {
          const activeIds: string[] = [];

          for (const member of staffMembers) {
            let username = member.email || member.username;
            
            if (member.id === user.id) {
              username = user.email || username;
            }

            if (!username) {
              username = `user_${member.id.substring(0, 8)}`;
            }

            syncedUsernames.push(username);
            activeIds.push(member.id);

            await dbExecute(`
              INSERT INTO users (id, username, role, full_name, pharmacy_id) 
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                username = excluded.username,
                role = excluded.role,
                full_name = excluded.full_name,
                pharmacy_id = excluded.pharmacy_id
            `, [
              member.id,
              username,
              member.role || 'pharmacist',
              member.full_name || 'Pharmacist',
              member.pharmacy_id
            ]);
          }

          // Optional: deactivate users that are no longer in the cloud rather than deleting to preserve logs
          if (activeIds.length > 0) {
            const placeholders = activeIds.map(() => '?').join(',');
            await dbExecute(`UPDATE users SET is_active = 0 WHERE id NOT IN (${placeholders})`, activeIds);
            await dbExecute(`UPDATE users SET is_active = 1 WHERE id IN (${placeholders})`, activeIds);
          }
        });
      }
    }

    console.log(`Sync completed successfully on client. Synced ${allDrugs.length} drugs.`);

    return { 
      success: true, 
      message: `تمت المزامنة بنجاح. تم تحميل ${allDrugs.length} صنفاً جديداً/محدثاً.`,
      syncedUsernames: Array.from(new Set(syncedUsernames))
    };

  } catch (error) {
    console.error('Client Sync error:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء المزامنة' };
  }
}
