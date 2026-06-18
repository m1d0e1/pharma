import { dbExecute, dbSelect } from '@/lib/db/tauri';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export async function updatePharmacyClient(formData: any) {
  try {
    const isTauri = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

    // 1. Update Cloud (Supabase) if online
    const supabase = getSupabaseBrowserClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (user && !authError) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('pharmacy_id')
        .eq('id', user.id)
        .single();

      if (profile?.pharmacy_id) {
        const { error: updateError } = await supabase
          .from('pharmacies')
          .update({
            name: formData.name,
            name_en: formData.name_en,
            phone: formData.phone,
            address: formData.address,
            commercial_registry: formData.commercial_registry,
            tax_card: formData.tax_card,
            owner_name: formData.owner_name,
            owner_address: formData.owner_address,
            owner_phone: formData.owner_phone,
            owner_mobile: formData.owner_mobile,
            manager_name: formData.manager_name,
            manager_address: formData.manager_address,
            manager_phone: formData.manager_phone,
            manager_mobile: formData.manager_mobile,
          })
          .eq('id', profile.pharmacy_id);

        if (updateError) {
          console.error('Client cloud update pharmacy error:', updateError);
        }
      }
    }

    // 2. Update Local Enforcer (SQLite)
    await dbExecute(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, ['pharmacy_name', formData.name]);

    await dbExecute(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, ['pharmacy_phone', formData.phone]);

    await dbExecute(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, ['pharmacy_address', formData.address]);

    return { success: true };
  } catch (error) {
    console.error('Unexpected error in updatePharmacyClient:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء تحديث البيانات' };
  }
}

export async function runDatabaseMaintenanceClient() {
  try {
    await dbExecute('VACUUM');
    await dbExecute('ANALYZE');
    return { success: true, message: 'تم تحسين وضغط قاعدة البيانات وتحديث الفهارس بنجاح!' };
  } catch (error) {
    console.error('Failed to run database maintenance on client:', error);
    return { success: false, error: 'فشل تنفيذ عملية صيانة قاعدة البيانات' };
  }
}

export async function getLocalUsersClient() {
  try {
    const users = await dbSelect('SELECT id, username, full_name, role, (password_hash IS NOT NULL) as has_password FROM users');
    return { success: true, data: users };
  } catch (error) {
    console.error('Failed to fetch local users on client:', error);
    return { success: false, error: 'فشل تحميل مستخدمين الصيدلية المحلية' };
  }
}
