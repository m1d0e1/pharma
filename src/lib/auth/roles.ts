// Permission definitions for the pharmacy management system

export type Permission =
  | 'view_dashboard'
  | 'view_reports'
  | 'manage_inventory'
  | 'manage_staff'
  | 'process_sales'
  | 'manage_patients'
  | 'view_all_sales'
  | 'manage_settings'
  | 'void_transactions'
  | 'manage_shifts'
  | 'manage_pharmacy'
  | 'export_data'
  | 'import_data'
  | 'view_audit_logs';

export interface RolePermissions {
  role: 'owner' | 'manager' | 'pharmacist' | 'cashier';
  permissions: Permission[];
  description: string;
}

// Role-based permission definitions
export const ROLE_PERMISSIONS: Record<string, RolePermissions> = {
  owner: {
    role: 'owner',
    permissions: [
      'view_dashboard',
      'view_reports',
      'manage_inventory',
      'manage_staff',
      'process_sales',
      'manage_patients',
      'view_all_sales',
      'manage_settings',
      'void_transactions',
      'manage_shifts',
      'manage_pharmacy',
      'export_data',
      'import_data',
      'view_audit_logs',
    ],
    description: 'Full access to all features',
  },
  manager: {
    role: 'manager',
    permissions: [
      'view_dashboard',
      'view_reports',
      'manage_inventory',
      'manage_staff',
      'process_sales',
      'manage_patients',
      'view_all_sales',
      'manage_settings',
      'void_transactions',
      'manage_shifts',
      'export_data',
    ],
    description: 'Can manage inventory, staff, and view reports',
  },
  pharmacist: {
    role: 'pharmacist',
    permissions: [
      'view_dashboard',
      'process_sales',
      'manage_patients',
      'view_all_sales',
      'manage_shifts',
    ],
    description: 'Can process sales and manage patients',
  },
  cashier: {
    role: 'cashier',
    permissions: ['process_sales', 'view_dashboard'],
    description: 'Limited to sales operations',
  },
};

// Permission descriptions for UI
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  view_dashboard: 'View main dashboard',
  view_reports: 'View sales and inventory reports',
  manage_inventory: 'Add, edit, and delete inventory items',
  manage_staff: 'Create and manage staff accounts',
  process_sales: 'Process sales transactions',
  manage_patients: 'Add and manage patient records',
  view_all_sales: 'View all sales transactions',
  manage_settings: 'Configure pharmacy settings',
  void_transactions: 'Void sales transactions',
  manage_shifts: 'Open and close shift registers',
  manage_pharmacy: 'Edit pharmacy information',
  export_data: 'Export data to files',
  import_data: 'Import data from files',
  view_audit_logs: 'View system audit logs',
};

// Check if a role has a specific permission
export function roleHasPermission(role: string, permission: Permission): boolean {
  const roleConfig = ROLE_PERMISSIONS[role];
  return roleConfig?.permissions.includes(permission) || false;
}

// Get all permissions for a role
export function getRolePermissions(role: string): Permission[] {
  const roleConfig = ROLE_PERMISSIONS[role];
  return roleConfig?.permissions || [];
}

// Check if user has any of the required permissions
export function hasAnyPermission(
  userPermissions: Permission[],
  requiredPermissions: Permission[]
): boolean {
  return requiredPermissions.some((permission) =>
    userPermissions.includes(permission)
  );
}

// Check if user has all required permissions
export function hasAllPermissions(
  userPermissions: Permission[],
  requiredPermissions: Permission[]
): boolean {
  return requiredPermissions.every((permission) =>
    userPermissions.includes(permission)
  );
}

// Get available roles
export function getAvailableRoles(): Array<{
  value: string;
  label: string;
  description: string;
}> {
  return Object.values(ROLE_PERMISSIONS).map((role) => ({
    value: role.role,
    label: role.role.charAt(0).toUpperCase() + role.role.slice(1),
    description: role.description,
  }));
}

// Get available permissions
export function getAvailablePermissions(): Array<{
  value: Permission;
  label: string;
  description: string;
}> {
  return Object.entries(PERMISSION_DESCRIPTIONS).map(([value, description]) => ({
    value: value as Permission,
    label: value
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
    description,
  }));
}
