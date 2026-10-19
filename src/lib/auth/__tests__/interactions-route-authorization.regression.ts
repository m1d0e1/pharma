import { getRoutePermission, PAGE_PERMISSIONS } from '@/lib/auth/roles';
import { DELEGATABLE_PERMISSION_KEYS } from '@/lib/auth/permission-catalog';

describe('separate patient and medicine-interaction permissions', () => {
  it('guards drug interaction pages with their own explicit permission, not patient-record access', () => {
    expect(PAGE_PERMISSIONS.can_view_interactions).toBe('/interactions');
    expect(getRoutePermission('/interactions')).toBe('can_view_interactions');
    expect(getRoutePermission('/interactions/history')).toBe('can_view_interactions');
    expect(getRoutePermission('/patients')).toBe('can_view_patients');
    expect(DELEGATABLE_PERMISSION_KEYS.has('can_view_interactions')).toBe(true);
  });
});
