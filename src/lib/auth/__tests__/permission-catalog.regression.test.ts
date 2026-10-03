import {
  DELEGATABLE_PERMISSION_KEYS,
  PERMISSION_MODULES,
  sanitizeStaffPermissions,
} from '@/lib/auth/permission-catalog';
import { hasUserPermissionSync } from '@/lib/auth/local';
import { ACTION_PERMISSIONS, ROUTE_PERMISSIONS } from '@/lib/auth/roles';

describe('module permission catalog', () => {
  it('contains each editable permission once and exposes enforced missing keys', () => {
    const keys = PERMISSION_MODULES.flatMap(module => module.permissions.map(permission => permission.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining([
      'can_access_pos',
      'can_view_suppliers',
      'rep_can_view_shifts',
      'can_delete_patients',
      'can_change_price_sale',
      'preview_item_movements',
      'can_view_sales',
    ]));
  });

  it('does not present legacy flags which have no implemented behavior', () => {
    expect(DELEGATABLE_PERMISSION_KEYS.has('can_change_price_purchase')).toBe(false);
    expect(DELEGATABLE_PERMISSION_KEYS.has('show_sales_report_invoice')).toBe(false);
    expect(DELEGATABLE_PERMISSION_KEYS.has('suspended_can_delete')).toBe(false);
    expect(DELEGATABLE_PERMISSION_KEYS.has('show_own_financial_only')).toBe(false);
  });

  it('contains every permission enforced by route and action maps', () => {
    const enforced = [
      ...Object.values(ROUTE_PERMISSIONS).flatMap(permission => Array.isArray(permission) ? permission : [permission]),
      ...Object.values(ACTION_PERMISSIONS),
    ];
    for (const permission of enforced) {
      expect(DELEGATABLE_PERMISSION_KEYS.has(permission)).toBe(true);
    }
  });

  it('sanitizes saved permissions and constrains numeric policy values', () => {
    expect(sanitizeStaffPermissions({
      can_access_pos: 'true',
      max_invoice_discount_percent: 250,
      national_id: '123',
      can_view_sales: false,
      injected_permission: true,
      can_change_price_purchase: true,
    })).toEqual({
      can_access_pos: true,
      max_invoice_discount_percent: 100,
      national_id: '123',
      can_view_sales: false,
    });
  });

  it('honors stored permission payloads and limits legacy POS and sales access to absent values', () => {
    expect(hasUserPermissionSync({ role: 'pharmacist' }, 'can_access_pos')).toBe(true);
    expect(hasUserPermissionSync({ role: 'pharmacist', permissions: null }, 'can_access_pos')).toBe(true);
    expect(hasUserPermissionSync({ role: 'pharmacist', permissions: {} }, 'can_access_pos')).toBe(false);
    expect(hasUserPermissionSync({ role: 'pharmacist', permissions: { can_access_pos: false } }, 'can_access_pos')).toBe(false);
    expect(hasUserPermissionSync({ role: 'cashier', permissions: JSON.stringify({ can_access_pos: true }) }, 'can_access_pos')).toBe(true);

    for (const role of ['admin', 'manager', 'pharmacist', 'cashier']) {
      expect(hasUserPermissionSync({ role }, 'can_view_sales')).toBe(true);
      expect(hasUserPermissionSync({ role, permissions: {} }, 'can_view_sales')).toBe(false);
      expect(hasUserPermissionSync({ role, permissions: { can_view_sales: false } }, 'can_view_sales')).toBe(false);
    }
  });

  it('keeps COGS owner-only even when an admin has the legacy view flag', () => {
    expect(hasUserPermissionSync({ role: 'admin', permissions: { can_view_cogs: true } }, 'can_view_cogs')).toBe(false);
    expect(hasUserPermissionSync({ role: 'owner', permissions: { can_view_cogs: false } }, 'can_view_cogs')).toBe(true);
  });
});
