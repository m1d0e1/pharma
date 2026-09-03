
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
const clearAuditLogs = async () => {
  try {
    await dbExecute('DELETE FROM activity_log');
    return true;
  } catch (e) {
    console.error('Failed to clear activity logs:', e);
    return false;
  }
};

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async () => await cb(...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};



import { createClient } from '@/utils/supabase/client';
import { getLocalSession, isOwnerOrAdmin } from '@/lib/auth/local';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

const normalizeCatalogName = (value: unknown) => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ')
  .toUpperCase();

/** Merge cloud catalog fields without replacing local-only drug data or IDs. */
export async function syncMasterDrugsToLocal(drugList: any[]) {
  const existing = await dbSelect<any>('SELECT id, trade_name, trade_name_en FROM master_drugs');
  const mappings = await dbSelect<any>('SELECT cloud_id, local_drug_id FROM cloud_drug_mappings');
  const byId = new Map(existing.map(drug => [Number(drug.id), drug]));
  const byName = new Map<string, number[]>();
  const mappedLocalIds = new Set(mappings.map(mapping => Number(mapping.local_drug_id)));
  const mappedCloudIds = new Map(mappings.map(mapping => [Number(mapping.cloud_id), Number(mapping.local_drug_id)]));

  const addName = (value: unknown, id: number) => {
    const name = normalizeCatalogName(value);
    if (!name) return;
    const ids = byName.get(name) || [];
    if (!ids.includes(id)) ids.push(id);
    byName.set(name, ids);
  };
  for (const drug of existing) {
    addName(drug.trade_name, Number(drug.id));
    addName(drug.trade_name_en, Number(drug.id));
  }

  const upsertWithId = db.prepare(`
    INSERT INTO master_drugs (id, trade_name, active_ingredient, category, manufacturer, official_price)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      trade_name = COALESCE(NULLIF(TRIM(excluded.trade_name), ''), master_drugs.trade_name),
      active_ingredient = COALESCE(NULLIF(TRIM(excluded.active_ingredient), ''), master_drugs.active_ingredient),
      category = COALESCE(NULLIF(TRIM(excluded.category), ''), master_drugs.category),
      manufacturer = COALESCE(NULLIF(TRIM(excluded.manufacturer), ''), master_drugs.manufacturer),
      official_price = CASE WHEN excluded.official_price > 0 THEN excluded.official_price ELSE master_drugs.official_price END
  `);
  const insertWithoutId = db.prepare(`
    INSERT INTO master_drugs (trade_name, active_ingredient, category, manufacturer, official_price)
    VALUES (?, ?, ?, ?, ?)
  `);
  const saveMapping = db.prepare(`
    INSERT INTO cloud_drug_mappings (cloud_id, local_drug_id, last_cloud_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cloud_id) DO UPDATE SET
      local_drug_id = excluded.local_drug_id,
      last_cloud_name = excluded.last_cloud_name,
      updated_at = CURRENT_TIMESTAMP
  `);

  let synced = 0;
  let skipped = 0;
  await dbTransaction(async () => {
    for (const drug of drugList) {
      const cloudId = Number(drug.id);
      const tradeName = String(drug.trade_name ?? '').trim();
      if (!Number.isSafeInteger(cloudId) || cloudId <= 0 || !tradeName) {
        skipped++;
        continue;
      }

      const normalizedName = normalizeCatalogName(tradeName);
      let localId = mappedCloudIds.get(cloudId);
      if (localId && !byId.has(localId)) localId = undefined;

      if (!localId) {
        const sameId = byId.get(cloudId);
        const sameIdentity = sameId && [sameId.trade_name, sameId.trade_name_en]
          .some(value => normalizeCatalogName(value) === normalizedName);
        const nameMatches = (byName.get(normalizedName) || [])
          .filter(id => !mappedLocalIds.has(id));

        if (sameIdentity) localId = cloudId;
        else if (nameMatches.length === 1) localId = nameMatches[0];
        else if (!sameId) localId = cloudId;
      }

      const price = Number(drug.price);
      const values = [
        tradeName,
        String(drug.active_ingredient ?? '').trim() || null,
        String(drug.category ?? '').trim() || null,
        String(drug.manufacturer ?? '').trim() || null,
        Number.isFinite(price) && price >= 0 ? price : 0,
      ];

      if (localId) {
        await upsertWithId.run(localId, ...values);
      } else {
        const inserted = await insertWithoutId.run(...values);
        localId = Number(inserted.lastInsertRowid);
      }

      const localDrug = { id: localId, trade_name: tradeName, trade_name_en: byId.get(localId)?.trade_name_en };
      byId.set(localId, localDrug);
      addName(tradeName, localId);
      mappedLocalIds.add(localId);
      mappedCloudIds.set(cloudId, localId);
      await saveMapping.run(cloudId, localId, tradeName);
      synced++;
    }
  });

  return { synced, skipped };
}

export async function syncFromCloudAction() {
  try {
    const localUser = await getLocalSession();
    const canSyncStaff = isOwnerOrAdmin(localUser);

    // 1. Initialize Local DB if not already done
    initLocalDb();

    // 2. Get Supabase Client (The Cloud Admin)
    const supabase = await createClient();

    // 3. Check Cloud User (Optional for public data sync)
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
        const configStmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
        await configStmt.run('pharmacy_id', profile.pharmacy_id);
        await configStmt.run('pharmacy_name', profile.pharmacies?.name || '');
      }
    }

    // --- INCREMENTAL SYNC LOGIC ---
    
    // Ensure table exists (self-healing if migrations haven't run/restarted yet)
    await db.exec(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        table_name TEXT PRIMARY KEY,
        last_synced_at TEXT
      )
    `);
    
    // Get last sync timestamps
    const drugsSyncRow = db.prepare('SELECT last_synced_at FROM sync_metadata WHERE table_name = ?').get('cloud_drugs') as any;
    const intSyncRow = db.prepare('SELECT last_synced_at FROM sync_metadata WHERE table_name = ?').get('cloud_drug_interactions') as any;
    
    const lastDrugsSync = drugsSyncRow?.last_synced_at || '1970-01-01T00:00:00Z';
    const lastIntSync = intSyncRow?.last_synced_at || '1970-01-01T00:00:00Z';
    
    const nowSyncTime = new Date().toISOString();

    // 5. Fetch and Sync Master Drugs (Incremental)
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
    const updateSyncMeta = db.prepare('INSERT OR REPLACE INTO sync_metadata (table_name, last_synced_at) VALUES (?, ?)');
    await updateSyncMeta.run('cloud_drugs', nowSyncTime);

    // 5b. Fetch and Sync Drug Interactions (Incremental)
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
      const insertInter = db.prepare(`
        INSERT INTO drug_interactions 
        (ingredient_a, ingredient_b, description_en) 
        VALUES (?, ?, ?)
        ON CONFLICT(ingredient_a, ingredient_b) DO UPDATE SET
          description_en = excluded.description_en
      `);

      const intTransaction = db.transaction(async (intList) => {
        for (const inter of intList) {
          await insertInter.run(
            inter.drug_1,
            inter.drug_2,
            inter.interaction_description
          );
        }
      });

      await intTransaction(allInteractions);
    }

    // Update last sync time for interactions
    await updateSyncMeta.run('cloud_drug_interactions', nowSyncTime);

    // 6. Fetch all Pharmacists for this Pharmacy (only if logged in)
    let staffMembers: any[] | null = null;
    const syncedUsernames: string[] = [];
    
    if (profile?.pharmacy_id && canSyncStaff) {
      const { data: staff } = await supabase
        .from('profiles')
        .select('*')
        .eq('pharmacy_id', profile.pharmacy_id);
      staffMembers = staff;

      // Clear existing users to ensure a clean sync of current cloud profiles
      await db.prepare('DELETE FROM users').run();

      if (staffMembers) {
        const insertUser = db.prepare(`
          INSERT OR REPLACE INTO users (id, username, role, full_name, pharmacy_id) 
          VALUES (?, ?, ?, ?, ?)
        `);

        const userTransaction = db.transaction(async (staffList) => {
          for (const member of staffList) {
            let username = member.email || member.username;
            
            if (member.id === user.id) {
              username = user.email || username;
            }

            if (!username) {
              username = `user_${member.id.substring(0, 8)}`;
            }

            syncedUsernames.push(username);

            await insertUser.run(
              member.id,
              username,
              member.role || 'pharmacist',
              member.full_name || 'Pharmacist',
              member.pharmacy_id
            );
          }
        });
        await userTransaction(staffMembers);
      }
    }

    console.log(`Sync completed successfully. Synced ${allDrugs.length} drugs.`);
    console.log('Synced Usernames:', syncedUsernames);
    
    revalidatePath('/');

    return { 
      success: true, 
      message: `تمت المزامنة بنجاح. تم تحميل ${allDrugs.length} صنفاً جديداً/محدثاً.`,
      syncedUsernames: Array.from(new Set(syncedUsernames)) // Deduplicate just in case
    };

  } catch (error) {
    console.error('Sync error:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء المزامنة' };
  }
}
