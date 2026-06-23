import { Permission } from './roles';

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
  return user.permissions.includes(permission);
}

export function hasAnyPermission(user: User | null, permissions: Permission[]): boolean {
  if (!user) return false;
  return permissions.some(p => user.permissions.includes(p));
}

export function hasAllPermissions(user: User | null, permissions: Permission[]): boolean {
  if (!user) return false;
  return permissions.every(p => user.permissions.includes(p));
}

export function isOwner(user: User | null): boolean {
  return user?.role === 'owner' || user?.role === 'admin';
}

export function isManager(user: User | null): boolean {
  return user?.role === 'manager' || isOwner(user);
}
