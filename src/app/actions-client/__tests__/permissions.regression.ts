import Database from 'better-sqlite3';
import { hasUserPermissionSync, isOwnerOrAdmin } from '@/lib/auth/local';

describe('Permissions Logic & Authorization Matrix', () => {
  describe('hasUserPermissionSync', () => {
    it('grants full access to owner and admin roles regardless of permissions payload', () => {
      const ownerUser = { id: '1', role: 'owner', permissions: '{}' };
      const adminUser = { id: '2', role: 'admin', permissions: '[]' };

      expect(hasUserPermissionSync(ownerUser, 'any_random_permission')).toBe(true);
      expect(hasUserPermissionSync(adminUser, 'can_view_audit')).toBe(true);
      expect(isOwnerOrAdmin(ownerUser)).toBe(true);
      expect(isOwnerOrAdmin(adminUser)).toBe(true);
    });

    it('denies access when user is null or undefined', () => {
      expect(hasUserPermissionSync(null, 'can_view_patients')).toBe(false);
      expect(hasUserPermissionSync(undefined, 'can_view_patients')).toBe(false);
    });

    it('correctly evaluates object format permissions', () => {
      const pharmacist = {
        id: '3',
        role: 'pharmacist',
        permissions: {
          can_view_patients: true,
          can_view_sales: false,
          can_view_opening_balances: 1,
          can_view_delivery: 'true'
        }
      };

      expect(hasUserPermissionSync(pharmacist, 'can_view_patients')).toBe(true);
      expect(hasUserPermissionSync(pharmacist, 'can_view_opening_balances')).toBe(true);
      expect(hasUserPermissionSync(pharmacist, 'can_view_delivery')).toBe(true);
      expect(hasUserPermissionSync(pharmacist, 'can_view_sales')).toBe(false);
      expect(hasUserPermissionSync(pharmacist, 'can_view_audit')).toBe(false);
    });

    it('correctly evaluates JSON string object format permissions', () => {
      const pharmacist = {
        id: '4',
        role: 'pharmacist',
        permissions: JSON.stringify({
          can_view_patients: true,
          can_view_sales: false,
          can_manage_inventory: true
        })
      };

      expect(hasUserPermissionSync(pharmacist, 'can_view_patients')).toBe(true);
      expect(hasUserPermissionSync(pharmacist, 'can_manage_inventory')).toBe(true);
      expect(hasUserPermissionSync(pharmacist, 'can_view_sales')).toBe(false);
      expect(hasUserPermissionSync(pharmacist, 'can_view_settings')).toBe(false);
    });

    it('correctly evaluates array format permissions (legacy and seed formats)', () => {
      const cashier = {
        id: '5',
        role: 'cashier',
        permissions: ['can_view_receipts', 'can_view_returns', 'can_view_shifts']
      };

      expect(hasUserPermissionSync(cashier, 'can_view_receipts')).toBe(true);
      expect(hasUserPermissionSync(cashier, 'can_view_returns')).toBe(true);
      expect(hasUserPermissionSync(cashier, 'can_view_shifts')).toBe(true);
      expect(hasUserPermissionSync(cashier, 'can_view_audit')).toBe(false);
      expect(hasUserPermissionSync(cashier, 'can_manage_inventory')).toBe(false);
    });

    it('correctly evaluates JSON string array format permissions', () => {
      const staffUser = {
        id: '6',
        role: 'pharmacist',
        permissions: JSON.stringify(['can_view_low_stock', 'can_view_restock', 'acc_can_view_general'])
      };

      expect(hasUserPermissionSync(staffUser, 'can_view_low_stock')).toBe(true);
      expect(hasUserPermissionSync(staffUser, 'can_view_restock')).toBe(true);
      expect(hasUserPermissionSync(staffUser, 'acc_can_view_general')).toBe(true);
      expect(hasUserPermissionSync(staffUser, 'can_view_audit')).toBe(false);
    });

    it('gracefully handles malformed JSON string or invalid types', () => {
      const brokenUser1 = { id: '7', role: 'pharmacist', permissions: '{invalid json' };
      const brokenUser2 = { id: '8', role: 'pharmacist', permissions: 12345 };

      expect(hasUserPermissionSync(brokenUser1, 'can_view_patients')).toBe(false);
      expect(hasUserPermissionSync(brokenUser2, 'can_view_patients')).toBe(false);
    });
  });
});
