import { Permission } from './roles';

export interface User {
  id: string;
  username: string;
  pharmacyId: string;
  role: 'owner' | 'admin' | 'manager' | 'pharmacist' | 'cashier';
  permissions: Permission[];
  fullName?: string;
}

// Current user context (will be set by auth middleware)
let currentUser: User | null = null;

export function setCurrentUser(user: User | null): void {
  currentUser = user;
}

export function getCurrentUser(): User | null {
  return currentUser;
}

export function hasPermission(permission: Permission): boolean {
  if (!currentUser) {
    return false;
  }

  return currentUser.permissions.includes(permission);
}

export function hasAnyPermission(permissions: Permission[]): boolean {
  if (!currentUser) {
    return false;
  }

  return permissions.some((permission) =>
    currentUser.permissions.includes(permission)
  );
}

export function hasAllPermissions(permissions: Permission[]): boolean {
  if (!currentUser) {
    return false;
  }

  return permissions.every((permission) =>
    currentUser.permissions.includes(permission)
  );
}

export function requirePermission(permission: Permission): void {
  if (!hasPermission(permission)) {
    throw new Error(
      `Permission denied: Required permission '${permission}' not granted`
    );
  }
}

export function requireAnyPermission(permissions: Permission[]): void {
  if (!hasAnyPermission(permissions)) {
    throw new Error(
      `Permission denied: Required one of permissions [${permissions.join(', ')}] not granted`
    );
  }
}

export function requireAllPermissions(permissions: Permission[]): void {
  if (!hasAllPermissions(permissions)) {
    throw new Error(
      `Permission denied: Required all permissions [${permissions.join(', ')}] not granted`
    );
  }
}

export function isOwner(): boolean {
  return currentUser?.role === 'owner' || currentUser?.role === 'admin';
}

export function isManager(): boolean {
  return currentUser?.role === 'manager' || currentUser?.role === 'owner' || currentUser?.role === 'admin';
}

export function canManageStaff(): boolean {
  return hasPermission('manage_staff');
}

export function canViewReports(): boolean {
  return hasPermission('view_reports');
}

export function canManageInventory(): boolean {
  return hasPermission('manage_inventory');
}

export function canProcessSales(): boolean {
  return hasPermission('process_sales');
}

export function canManagePatients(): boolean {
  return hasPermission('manage_patients');
}

export function canVoidTransactions(): boolean {
  return hasPermission('void_transactions');
}

export function canManageShifts(): boolean {
  return hasPermission('manage_shifts');
}

export function canManageSettings(): boolean {
  return hasPermission('manage_settings');
}

export function canManagePharmacy(): boolean {
  return hasPermission('manage_pharmacy');
}

