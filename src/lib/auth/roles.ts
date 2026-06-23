// Legacy Permission type — used by service.ts and users/service.ts
export type Permission = string;

export interface RolePermissions {
  role: string;
  permissions: string[];
  description: string;
}

export type PagePermission = keyof typeof PAGE_PERMISSIONS;

export const PAGE_PERMISSIONS = {
  can_view_stores: '/stores/items',
  can_view_patients: '/patients',
  can_view_delivery: '/sales/delivery',
  can_view_cogs: '/sales/cogs',
  can_view_receipts: '/receipts',
  can_view_returns: '/returns',
  can_view_purchases: '/purchases',
  can_view_shifts: '/shifts',
  can_view_restock: '/restock',
  can_view_audit: '/audit',
  can_view_settings: '/settings',
  can_view_expenses: '/expenses',
  can_view_staff_manage: '/staff/manage',
  can_view_staff_roles: '/staff/roles',
  can_view_low_stock: '/inventory/low-stock',
  can_view_opening_balances: '/inventory/opening-balances',
  can_view_settlement: '/inventory/settlement',
  can_manage_inventory: '/stores/items',
  acc_can_view_handover: '/finance/handover',
  rep_can_view_sales: '/reports/sales',
  rep_can_view_financial: '/accounts',

  // Additional menu routes that need permission mapping
  can_view_sales: '/sales',
  can_view_inventory: '/inventory',
  can_view_item_movements: '/inventory/item-movements',
  can_view_shortages: '/stores/shortages',
  can_view_purchase_orders: '/purchase-orders',
  can_view_suppliers: '/purchases/suppliers',
  can_view_purchase_returns: '/purchases/returns',
  can_view_general_returns: '/purchases/general-returns',
  can_view_cash_transactions: '/accounts/cash-transactions',
  can_view_banks: '/finance/banks',
  can_view_cards: '/finance/cards',
  can_view_pos_management: '/finance/pos-management',
  can_view_accounts_tree: '/finance/accounts',
  can_view_trial_balance: '/accounts/settings/trial-balance',
  can_view_trial_balance_report: '/reports/trial-balance',
  can_view_purchase_reports: '/reports/purchases',
  can_view_shift_report: '/shifts/report',
  can_view_interactions: '/interactions',
  can_view_staff_performance: '/staff',
  can_view_reports_dashboard: '/reports',
  can_view_alternatives: '/stores/alternatives',
  can_view_categories: '/stores/categories',
  can_view_nature: '/stores/nature',
  can_view_usage: '/stores/usage',
  can_view_units: '/stores/units',
  can_view_indications: '/stores/indications',
  can_view_drug_indications: '/stores/drug-indications',
  can_view_manufacturers: '/stores/manufacturers',
  can_view_scientific_groups: '/stores/scientific-groups',
  can_view_adjustments: '/stores/adjustments',
  can_view_adjustment_reasons: '/stores/adjustment-reasons',
  can_view_delete_items: '/stores/delete-items',
  can_view_purchases_new: '/purchases/new',
  can_view_sales_settlement: '/sales/settlement',
} as const;

export function findUnprotectedRoutes(): string[] {
  const permittedRoutes = new Set(Object.values(PAGE_PERMISSIONS));
  const allMenuRoutes = [
    '/', '/pos', '/purchases/new', '/receipts', '/sales',
    '/sales/delivery', '/sales/cogs', '/sales/settlement',
    '/inventory', '/inventory/low-stock', '/stores/shortages',
    '/inventory/item-movements', '/restock', '/inventory/settlement',
    '/inventory/opening-balances', '/purchases', '/purchase-orders',
    '/purchases/suppliers', '/purchases/returns', '/purchases/general-returns',
    '/returns', '/stores/items', '/stores/alternatives',
    '/stores/categories', '/stores/nature', '/stores/usage',
    '/stores/units', '/stores/indications', '/stores/drug-indications',
    '/stores/manufacturers', '/stores/scientific-groups',
    '/stores/adjustments', '/stores/adjustment-reasons',
    '/stores/delete-items', '/accounts', '/accounts/cash-transactions',
    '/finance/handover', '/finance/banks', '/finance/cards',
    '/finance/pos-management', '/finance/accounts',
    '/accounts/settings/trial-balance', '/reports', '/reports/trial-balance',
    '/reports/purchases', '/reports/sales', '/expenses', '/shifts',
    '/shifts/report', '/patients', '/interactions', '/staff',
    '/staff/manage', '/staff/roles', '/audit', '/settings',
  ];
  return allMenuRoutes.filter(r => !permittedRoutes.has(r as any) && r !== '/' && r !== '/pos');
}

// ACTION_PERMISSIONS maps each actions-client file to its permission check
// Verifies that calling an action without the permission returns error
export const ACTION_PERMISSIONS: Record<string, string> = {
  inventory: 'can_manage_inventory',
  purchases: 'can_view_purchases',
  'master-drugs': 'can_manage_inventory',
  patients: 'can_view_patients',
  returns: 'can_view_returns',
  shifts: 'can_view_shifts',
  shortages: 'can_view_restock',
  delivery: 'can_view_delivery',
  cogs: 'can_view_cogs',
  settlement: 'can_view_settlement',
  'sales-reports': 'rep_can_view_sales',
  reports: 'rep_can_view_sales',
  finance: 'rep_can_view_financial',
  settings: 'can_view_settings',
  audit: 'can_view_audit',
  expenses: 'can_view_expenses',
};

// Keep the role-based structure for backward compatibility
// Maps roles to page-level view permissions
const ALL_PAGE_PERMS = Object.keys(PAGE_PERMISSIONS);

const buildRole = (role: string, perms: string[], desc: string): RolePermissions => ({ role, permissions: perms, description: desc });

export const ROLE_PERMISSIONS: Record<string, RolePermissions> = {
  owner: buildRole('owner', [...ALL_PAGE_PERMS], 'Full access to all features'),
  admin: buildRole('admin', [...ALL_PAGE_PERMS], 'Full access to all features'),
  manager: buildRole('manager', [
    'can_view_stores', 'can_view_patients', 'can_view_delivery',
    'can_view_cogs', 'can_view_receipts', 'can_view_returns',
    'can_view_purchases', 'can_view_shifts', 'can_view_restock',
    'can_view_audit', 'can_view_settings', 'can_view_expenses',
    'can_view_staff_roles', 'can_manage_inventory',
    'can_view_low_stock', 'can_view_settlement',
    'can_view_sales', 'can_view_inventory',
    'rep_can_view_sales', 'rep_can_view_financial',
    'can_view_cash_transactions', 'can_view_suppliers',
    'can_view_reports_dashboard', 'can_view_alternatives',
    'can_view_categories', 'can_view_usage', 'can_view_units',
    'can_view_indications', 'can_view_manufacturers',
    'can_view_interactions',
  ], 'Can manage inventory, staff, and view reports'),
  pharmacist: buildRole('pharmacist', [
    'can_view_patients', 'can_view_receipts', 'can_view_returns',
    'can_view_shifts', 'can_view_restock', 'can_view_delivery',
    'can_view_low_stock', 'can_view_shortages',
    'can_view_inventory', 'can_view_sales',
    'can_view_interactions', 'can_view_staff_performance',
  ], 'Can process sales and manage patients'),
  cashier: buildRole('cashier', [
    'can_view_receipts', 'can_view_returns',
    'can_view_shifts', 'can_view_delivery',
    'can_view_sales',
  ], 'Limited to sales operations'),
};
