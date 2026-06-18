
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

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function syncFromCloudAction() {
  try {
    // 1. Initialize Local DB if not already done
    initLocalDb();

    // 2. Get Supabase Client (The Cloud Admin)
    const supabase = await createClient();

    // 3. Verify Subscription (First check Cloud)
    console.log('Verifying cloud subscription...');
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.warn('Sync failed: User not logged in to cloud');
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

    // 4. Save Pharmacy Config Locally
    const configStmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    await configStmt.run('pharmacy_id', profile.pharmacy_id);
    await configStmt.run('pharmacy_name', profile.pharmacies?.name || '');

    // 5. Fetch and Sync Master Drugs (The Brain) - Dynamic Batching
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
      const insertDrug = db.prepare(`
        INSERT OR REPLACE INTO master_drugs 
        (id, trade_name, trade_name_en, generic_name, active_ingredient, strength, unit, category, manufacturer, base_price, official_price) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const transaction = db.transaction(async (drugList) => {
        for (const drug of drugList) {
          await insertDrug.run(
            drug.id,
            drug.trade_name || '',
            drug.trade_name_en || null,
            drug.generic_name || null,
            drug.active_ingredient || drug.generic_name || null,
            drug.strength || null,
            drug.unit || null,
            drug.category || null,
            drug.manufacturer || null,
            drug.base_price || drug.official_price || 0,
            drug.official_price || 0
          );
        }
      });

      await transaction(allDrugs);
    }

    // 6. Fetch all Pharmacists for this Pharmacy
    const { data: staffMembers } = await supabase
      .from('profiles')
      .select('*')
      .eq('pharmacy_id', profile.pharmacy_id);

    const syncedUsernames: string[] = [];

    // Clear existing users to ensure a clean sync of current cloud profiles
    await db.prepare('DELETE FROM users').run();

    if (staffMembers) {
      const insertUser = db.prepare(`
        INSERT OR REPLACE INTO users (id, username, role, full_name, pharmacy_id) 
        VALUES (?, ?, ?, ?, ?)
      `);

      const userTransaction = db.transaction(async (staff) => {
        for (const member of staff) {
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

    console.log(`Sync completed successfully. Synced ${allDrugs.length} drugs and ${staffMembers?.length || 0} users.`);
    console.log('Synced Usernames:', syncedUsernames);
    
    revalidatePath('/');

    return { 
      success: true, 
      message: `تمت المزامنة بنجاح. تم تحميل ${allDrugs.length} صنفاً.`,
      syncedUsernames: Array.from(new Set(syncedUsernames)) // Deduplicate just in case
    };

  } catch (error) {
    console.error('Sync error:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء المزامنة' };
  }
}
