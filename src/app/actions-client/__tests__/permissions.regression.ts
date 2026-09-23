import Database from 'better-sqlite3';
import { hasUserPermissionSync, isOwnerOrAdmin } from '@/lib/auth/local';

describe('Permissions Logic & Authorization Matrix', () => {
  describe('hasUserPermissionSync', () => {
    it('grants unconditional access only to the owner and applies admin checkboxes', () => {
      const ownerUser = { id: '1', role: 'owner', permissions: '{}' };
      const adminUser = { id: '2', role: 'admin', permissions: '{"can_view_audit":true}' };

      expect(hasUserPermissionSync(ownerUser, 'any_random_permission')).toBe(true);
      expect(hasUserPermissionSync(adminUser, 'can_view_audit')).toBe(true);
      expect(hasUserPermissionSync(adminUser, 'can_view_settings')).toBe(false);
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

    it('keeps v0.2.91 granular finance permissions explicit when legacy payload keys are missing', () => {
      const legacyPayload = {
        id: 'legacy-finance-user',
        role: 'pharmacist',
        permissions: JSON.stringify({
          can_view_patients: true,
          can_view_shifts: true,
          acc_can_view_general: true,
        }),
      };

      expect(hasUserPermissionSync(legacyPayload, 'acc_can_process_cash_flow')).toBe(false);
      expect(hasUserPermissionSync(legacyPayload, 'acc_can_make_daily_entries')).toBe(false);
      expect(hasUserPermissionSync(legacyPayload, 'acc_can_view_handover')).toBe(false);

      expect(hasUserPermissionSync({
        ...legacyPayload,
        permissions: JSON.stringify({
          acc_can_process_cash_flow: true,
          acc_can_view_handover: true,
        }),
      }, 'acc_can_process_cash_flow')).toBe(true);
      expect(hasUserPermissionSync({
        id: 'legacy-admin',
        role: 'admin',
        permissions: JSON.stringify({ acc_can_make_daily_entries: true }),
      }, 'acc_can_make_daily_entries')).toBe(true);
    });

    it('fails closed for stored malformed, array, or keyless permission payloads', () => {
      const cashier = { id: '7', role: 'cashier' };

      // Role defaults apply only to legacy users with no permission column value.
      expect(hasUserPermissionSync(cashier, 'can_access_pos')).toBe(true);
      expect(hasUserPermissionSync({ ...cashier, permissions: '{invalid json' }, 'can_access_pos')).toBe(false);
      expect(hasUserPermissionSync({ ...cashier, permissions: [] }, 'can_access_pos')).toBe(false);
      expect(hasUserPermissionSync({ ...cashier, permissions: {} }, 'can_access_pos')).toBe(false);
      expect(hasUserPermissionSync({ ...cashier, permissions: '' }, 'can_access_pos')).toBe(false);
      expect(hasUserPermissionSync({ ...cashier, permissions: { can_access_pos: false } }, 'can_access_pos')).toBe(false);
    });
  });
});
