import { isOwnerOnlyStaffRoute } from '@/lib/auth/staff-policy';

describe('middleware permission routing policy', () => {
  it.each(['/reports', '/settings', '/audit', '/sales/cogs', '/accounts/settings/trial-balance'])(
    'leaves %s to the shared permission guard and backend action checks',
    path => expect(isOwnerOnlyStaffRoute(path)).toBe(false),
  );

  it.each(['/staff', '/staff/manage', '/staff/roles'])(
    'keeps %s owner-only',
    path => expect(isOwnerOnlyStaffRoute(path)).toBe(true),
  );

  it('does not accidentally capture unrelated staff-like paths', () => {
    expect(isOwnerOnlyStaffRoute('/staffing')).toBe(false);
  });
});
