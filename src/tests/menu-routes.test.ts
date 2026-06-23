const menuRouteMap: Record<string, string> = {
  pos: '/pos',
  purchases_new: '/purchases/new',
  purchases_new2: '/purchases/new',
  dashboard: '/',
  receipts: '/receipts',
  sales: '/sales',
  reports_sales: '/reports/sales',
  reports_sales2: '/reports/sales',
  sales_delivery: '/sales/delivery',
  sales_cogs: '/sales/cogs',
  sales_settlement: '/sales/settlement',
  inventory: '/inventory',
  inventory_low_stock: '/inventory/low-stock',
  stores_shortages: '/stores/shortages',
  inventory_item_movements: '/inventory/item-movements',
  restock: '/restock',
  inventory_settlement: '/inventory/settlement',
  inventory_opening_balances: '/inventory/opening-balances',
  purchases: '/purchases',
  purchase_orders: '/purchase-orders',
  purchases_suppliers: '/purchases/suppliers',
  purchases_returns: '/purchases/returns',
  purchases_general_returns: '/purchases/general-returns',
  returns: '/returns',
  stores_items: '/stores/items',
  stores_alternatives: '/stores/alternatives',
  stores_categories: '/stores/categories',
  stores_nature: '/stores/nature',
  stores_usage: '/stores/usage',
  stores_units: '/stores/units',
  stores_indications: '/stores/indications',
  stores_drug_indications: '/stores/drug-indications',
  stores_manufacturers: '/stores/manufacturers',
  stores_scientific_groups: '/stores/scientific-groups',
  stores_adjustments: '/stores/adjustments',
  stores_adjustment_reasons: '/stores/adjustment-reasons',
  stores_delete_items: '/stores/delete-items',
  accounts: '/accounts',
  accounts_cash_transactions: '/accounts/cash-transactions',
  finance_handover: '/finance/handover',
  finance_banks: '/finance/banks',
  finance_cards: '/finance/cards',
  finance_pos_management: '/finance/pos-management',
  finance_accounts: '/finance/accounts',
  accounts_settings_trial_balance: '/accounts/settings/trial-balance',
  reports: '/reports',
  reports_trial_balance: '/reports/trial-balance',
  reports_purchases: '/reports/purchases',
  expenses: '/expenses',
  shifts: '/shifts',
  shifts_report: '/shifts/report',
  patients: '/patients',
  interactions: '/interactions',
  staff: '/staff',
  staff_manage: '/staff/manage',
  staff_roles: '/staff/roles',
  audit: '/audit',
  settings: '/settings',
};

const menuActions = ['new_window', 'print', 'logout', 'update_program', 'help_shortcuts', 'help_about'];

const knownPageFiles: string[] = [
  '/pos',
  '/purchases/new',
  '/',
  '/receipts',
  '/sales',
  '/reports/sales',
  '/sales/delivery',
  '/sales/cogs',
  '/sales/settlement',
  '/inventory',
  '/inventory/low-stock',
  '/stores/shortages',
  '/inventory/item-movements',
  '/restock',
  '/inventory/settlement',
  '/inventory/opening-balances',
  '/purchases',
  '/purchase-orders',
  '/purchases/suppliers',
  '/purchases/returns',
  '/purchases/general-returns',
  '/returns',
  '/stores/items',
  '/stores/alternatives',
  '/stores/categories',
  '/stores/nature',
  '/stores/usage',
  '/stores/units',
  '/stores/indications',
  '/stores/drug-indications',
  '/stores/manufacturers',
  '/stores/scientific-groups',
  '/stores/adjustments',
  '/stores/adjustment-reasons',
  '/stores/delete-items',
  '/accounts',
  '/accounts/cash-transactions',
  '/finance/handover',
  '/finance/banks',
  '/finance/cards',
  '/finance/pos-management',
  '/finance/accounts',
  '/accounts/settings/trial-balance',
  '/reports',
  '/reports/trial-balance',
  '/reports/purchases',
  '/expenses',
  '/shifts',
  '/shifts/report',
  '/patients',
  '/interactions',
  '/staff',
  '/staff/manage',
  '/staff/roles',
  '/audit',
  '/settings',
];

describe('Tauri Menu Routing', () => {
  it('all route menu IDs return a non-empty string route', () => {
    const routeKeys = Object.keys(menuRouteMap);
    expect(routeKeys.length).toBeGreaterThan(0);
    for (const [id, route] of Object.entries(menuRouteMap)) {
      expect(route).toBeTruthy();
      expect(route).toMatch(/^\//);
    }
  });

  it('all route IDs return unique routes per logical group (no duplicates except aliases)', () => {
    const routes = Object.values(menuRouteMap);
    const duplicates = routes.filter((r, i) => routes.indexOf(r) !== i);
    const expectedAliases = ['/purchases/new', '/reports/sales'];
    for (const dup of duplicates) {
      expect(expectedAliases).toContain(dup);
    }
  });

  it('all menu routes map to known page files', () => {
    const routes = [...new Set(Object.values(menuRouteMap))];
    for (const route of routes) {
      expect(knownPageFiles).toContain(route);
    }
  });

  it('all known page files have a corresponding menu route', () => {
    const mappedRoutes = new Set(Object.values(menuRouteMap));
    for (const page of knownPageFiles) {
      expect(mappedRoutes).toContain(page);
    }
  });

  it('action menu items are not in the route map', () => {
    for (const action of menuActions) {
      expect(menuRouteMap).not.toHaveProperty(action);
    }
  });

  it('route strings use unified path format (no trailing slashes except root)', () => {
    for (const [id, route] of Object.entries(menuRouteMap)) {
      if (route === '/') continue;
      expect(route).not.toMatch(/\/$/);
    }
  });
});
