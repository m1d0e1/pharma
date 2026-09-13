// Staff administration is a fixed owner capability, never a delegable checkbox.
export const OWNER_ONLY_STAFF_PERMISSIONS = [
  'can_view_staff_manage',
  'can_view_staff_roles',
  'can_view_staff_performance',
  'rep_can_view_activity',
  'manage_staff',
  'can_manage_users',
];

export function isStaffOwner(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'owner';
}

export function isOwnerOnlyStaffPermission(key: string): boolean {
  return OWNER_ONLY_STAFF_PERMISSIONS.includes(key);
}

export function isOwnerOnlyStaffRoute(pathname: string): boolean {
  return pathname === '/staff' || pathname.startsWith('/staff/');
}
