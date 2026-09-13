import { Permission } from './roles';
import { isOwnerOnlyStaffPermission, isStaffOwner } from './staff-policy';

export interface User {
  id: string;
  username: string;
  pharmacyId: string;
  role: 'owner' | 'admin' | 'manager' | 'pharmacist' | 'cashier';
  permissions: Permission[];
  fullName?: string;
}

export function hasPermission(user: User | null, permission: Permission): boolean {
  if (!user) return false;
  if (isOwnerOnlyStaffPermission(permission)) return isStaffOwner(user);
  return user.permissions.includes(permission);
}

export function hasAnyPermission(user: User | null, permissions: Permission[]): boolean {
  if (!user) return false;
  return permissions.some(p => hasPermission(user, p));
}

export function hasAllPermissions(user: User | null, permissions: Permission[]): boolean {
  if (!user) return false;
  return permissions.every(p => hasPermission(user, p));
}

export function isOwner(user: User | null): boolean {
  return user?.role === 'owner' || user?.role === 'admin';
}

export function isManager(user: User | null): boolean {
  return user?.role === 'manager' || isOwner(user);
}
