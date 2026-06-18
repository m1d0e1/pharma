import { getSupabaseBrowserClient } from '@/lib/supabase';
import { dbExecute, dbTransaction } from '@/lib/db/tauri';

export async function syncFromCloudClient() {
  try {
    const supabase = getSupabaseBrowserClient();

    // 1. Verify Cloud Subscription (Check Cloud User)
    console.log('Verifying cloud subscription from client...');
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.warn('Client sync failed: User not logged in to cloud');
      return { success: false, error: 'يجب تسجيل الدخول للسحابة للتحقق من الاشتراك' };
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('*, pharmacies(*)')
      .eq('id', user.id)
      .single();

    if (!profile?.pharmacy_id) {
      return { success: false, error: 'لم يتم العثور على صيدلية مرتبطة بهذا الحساب' };
    }

    // 2. Save Pharmacy Config Locally
    await dbExecute(`
      INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
    `, ['pharmacy_id', profile.pharmacy_id]);
    
    await dbExecute(`
      INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
    `, ['pharmacy_name', profile.pharmacies?.name || '']);

    // 3. Fetch and Sync Master Drugs (The Brain) - Dynamic Batching
    console.log('Fetching master drugs from cloud...');
    let allDrugs: any[] = [];
    let from = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data: batch, error: drugsError } = await supabase
        .from('master_drugs')
        .select('*')
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

    console.log(`Total drugs fetched: ${allDrugs.length}`);

    if (allDrugs.length > 0) {
      // In Tauri mode, we do transactions by using BEGIN / COMMIT. 
      // Let's run inserts inside a transaction.
      await dbTransaction(async () => {
        // To speed up, we can execute the insertions.
        for (const drug of allDrugs) {
          await dbExecute(`
            INSERT INTO master_drugs 
            (id, trade_name, trade_name_en, generic_name, active_ingredient, category, manufacturer, official_price) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              trade_name = excluded.trade_name,
              trade_name_en = excluded.trade_name_en,
              generic_name = excluded.generic_name,
              active_ingredient = excluded.active_ingredient,
              category = excluded.category,
              manufacturer = excluded.manufacturer,
              official_price = excluded.official_price
          `, [
            drug.id,
            drug.trade_name || '',
            drug.trade_name_en || null,
            drug.generic_name || null,
            drug.active_ingredient || drug.generic_name || null,
            drug.category || null,
            drug.manufacturer || null,
            drug.official_price || 0
          ]);
        }
      });
    }

    // 4. Fetch all Pharmacists for this Pharmacy
    const { data: staffMembers } = await supabase
      .from('profiles')
      .select('*')
      .eq('pharmacy_id', profile.pharmacy_id);

    const syncedUsernames: string[] = [];

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

    console.log(`Sync completed successfully on client. Synced ${allDrugs.length} drugs and ${staffMembers?.length || 0} users.`);

    return { 
      success: true, 
      message: `تمت المزامنة بنجاح. تم تحميل ${allDrugs.length} صنفاً.`,
      syncedUsernames: Array.from(new Set(syncedUsernames))
    };

  } catch (error) {
    console.error('Client Sync error:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء المزامنة' };
  }
}
