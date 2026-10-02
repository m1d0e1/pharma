import { dbExecute, dbSelect, dbTransaction } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isStaffOwner } from '@/lib/auth/staff-policy';
import { normalizePharmacyId, pharmacyIdentityConfigKey } from '@/lib/settings/pharmacy-identity';

const LOCAL_PHARMACY_FIELDS: Record<string, string> = {
  name: 'pharmacy_name',
  name_en: 'pharmacy_name_en',
  phone: 'pharmacy_phone',
  address: 'pharmacy_address',
  commercial_registry: 'pharmacy_commercial_registry',
  tax_card: 'pharmacy_tax_card',
  owner_name: 'pharmacy_owner_name',
  owner_address: 'pharmacy_owner_address',
  owner_phone: 'pharmacy_owner_phone',
  owner_mobile: 'pharmacy_owner_mobile',
  manager_name: 'pharmacy_manager_name',
  manager_address: 'pharmacy_manager_address',
  manager_phone: 'pharmacy_manager_phone',
  manager_mobile: 'pharmacy_manager_mobile',
};

export async function getLocalPharmacySettingsClient() {
  const user = await getLocalSession();
  const pharmacyId = normalizePharmacyId(user?.pharmacy_id);
  const scopedKeys = Object.values(LOCAL_PHARMACY_FIELDS).map(key => pharmacyIdentityConfigKey(key, pharmacyId));
  const rows = await dbSelect(
    `SELECT key, value FROM config WHERE key IN (${Object.keys(LOCAL_PHARMACY_FIELDS).map(() => '?').join(',')})`,
    scopedKeys
  );
  const byKey = Object.fromEntries((rows || []).map((row: any) => [row.key, row.value]));
  return Object.fromEntries(
    Object.entries(LOCAL_PHARMACY_FIELDS)
      .map(([field, key]) => [field, pharmacyIdentityConfigKey(key, pharmacyId)] as const)
      .filter(([, key]) => Object.prototype.hasOwnProperty.call(byKey, key))
      .map(([field, key]) => [field, byKey[key] ?? ''])
  );
}

export async function updatePharmacyClient(formData: any) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_settings')) {
      return { success: false, error: 'غير مصرح' };
    }
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);
    // Pharmacy identity is local-first; cloud sync is read-only public catalog data.
    await dbTransaction(async (db) => {
      for (const [field, key] of Object.entries(LOCAL_PHARMACY_FIELDS)) {
        const scopedKey = pharmacyIdentityConfigKey(key, pharmacyId);
        await db.execute(`
          INSERT INTO config (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `, [scopedKey, formData[field] == null ? '' : String(formData[field])]);
      }
    });
    return { success: true };
  } catch (error) {
    console.error('Unexpected error in updatePharmacyClient:', error);
    return { success: false, error: 'حدث خطأ غير متوقع أثناء تحديث البيانات' };
  }
}

export async function runDatabaseMaintenanceClient() {
  try {
    if (!isStaffOwner(await getLocalSession())) {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }
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
    const user = await getLocalSession();
    if (!isStaffOwner(user)) return { success: false, error: 'غير مصرح - للمالك فقط' };
    const pharmacyId = user.pharmacy_id || 'local_default';
    const users = await dbSelect(
      `SELECT id, username, full_name, role, (password_hash IS NOT NULL) as has_password
       FROM users
       WHERE is_active = 1
         AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))`,
      [pharmacyId, pharmacyId]
    );
    return { success: true, data: users };
  } catch (error) {
    console.error('Failed to fetch local users on client:', error);
    return { success: false, error: 'فشل تحميل مستخدمين الصيدلية المحلية' };
  }
}
