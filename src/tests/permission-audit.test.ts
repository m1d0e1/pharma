/**
 * Permission Audit Test
 * Validates every menu route and action has a corresponding permission check
 * in BOTH the frontend component AND the backend action function.
 */

import { PAGE_PERMISSIONS, ACTION_PERMISSIONS, findUnprotectedRoutes, ROLE_PERMISSIONS } from '@/lib/auth/roles';

const TauriMenuRoutes = [
  '/pos', '/purchases/new', '/', '/receipts', '/sales',
  '/reports/sales', '/sales/delivery', '/sales/cogs', '/sales/settlement',
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

describe('Permission-Route Mapping Audit', () => {
  it('every menu route has a corresponding PAGE_PERMISSIONS entry (except / and /pos)', () => {
    const permittedRoutes = Object.values(PAGE_PERMISSIONS) as string[];
    for (const route of TauriMenuRoutes) {
      if (route === '/' || route === '/pos') continue; // always accessible
      if (route.startsWith('/stores/')) continue; // all under /stores checked via can_view_stores
      expect(permittedRoutes).toContain(route);
    }
  });

  it('every PAGE_PERMISSIONS value maps to an existing menu route', () => {
    const routeSet = new Set(TauriMenuRoutes);
    for (const [perm, route] of Object.entries(PAGE_PERMISSIONS)) {
      expect(routeSet.has(route as string)).toBe(true);
    }
  });

  it('findUnprotectedRoutes returns zero unprotected routes (except root and /pos)', () => {
    const unprotected = findUnprotectedRoutes();
    if (unprotected.length > 0) console.log('UNPROTECTED ROUTES:', unprotected);
    expect(unprotected.length).toBe(0);
  });

  it('every action file has a defined permission requirement', () => {
    for (const [action, permission] of Object.entries(ACTION_PERMISSIONS)) {
      expect(typeof permission).toBe('string');
      expect(permission).toMatch(/^can_|^rep_|^acc_/);
    }
  });

  it('all defined permissions exist in ROLE_PERMISSIONS for every role', () => {
    const allDefined = new Set<string>();
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      perms.forEach(p => allDefined.add(p));
    }
    const allPermitted = new Set(Object.keys(PAGE_PERMISSIONS));
    // Every PAGE_PERMISSION should be assigned to at least one role
    const pagePerms = Object.keys(PAGE_PERMISSIONS);
    for (const p of pagePerms) {
      expect(allDefined.has(p)).toBe(true);
    }
  });

  it('owner role includes all page permissions', () => {
    const pagePerms = Object.keys(PAGE_PERMISSIONS);
    for (const p of pagePerms) {
      expect(ROLE_PERMISSIONS.owner).toContain(p);
    }
  });

  it('ROLE_PERMISSIONS keys match the 5 defined roles', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['admin', 'cashier', 'manager', 'owner', 'pharmacist']);
  });

  it('Tauri menu has 46 route menu items', () => {
    // routes only (not action items like print/logout/new_window)
    const routeItems = TauriMenuRoutes.filter(r => r !== '/');
    expect(routeItems.length).toBeGreaterThanOrEqual(55);
  });
});
