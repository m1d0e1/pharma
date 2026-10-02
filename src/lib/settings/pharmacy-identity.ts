const PHARMACY_IDENTITY_CONFIG_KEYS = new Set([
  'pharmacy_name',
  'pharmacy_name_en',
  'pharmacy_phone',
  'pharmacy_address',
  'pharmacy_commercial_registry',
  'pharmacy_tax_card',
  'pharmacy_owner_name',
  'pharmacy_owner_address',
  'pharmacy_owner_phone',
  'pharmacy_owner_mobile',
  'pharmacy_manager_name',
  'pharmacy_manager_address',
  'pharmacy_manager_phone',
  'pharmacy_manager_mobile',
]);

export function normalizePharmacyId(pharmacyId: unknown): string {
  const normalized = typeof pharmacyId === 'string' ? pharmacyId.trim() : '';
  return normalized || 'local_default';
}

export function isPharmacyIdentityConfigKey(key: string): boolean {
  return PHARMACY_IDENTITY_CONFIG_KEYS.has(key);
}

export function pharmacyIdentityConfigKey(key: string, pharmacyId: unknown): string {
  const normalizedPharmacyId = normalizePharmacyId(pharmacyId);
  if (!isPharmacyIdentityConfigKey(key) || normalizedPharmacyId === 'local_default') return key;
  return `pharmacy:${normalizedPharmacyId}:${key}`;
}
