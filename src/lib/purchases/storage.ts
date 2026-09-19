export function purchaseShortageHandoffStorageKey() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const user = JSON.parse(localStorage.getItem('pharma_session_user') || 'null');
    return user?.id
      ? `pharma_shortages_to_purchase_v2:${JSON.stringify([user.pharmacy_id || 'local_default', user.id])}`
      : null;
  } catch {
    return null;
  }
}
