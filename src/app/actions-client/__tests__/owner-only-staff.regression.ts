import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockUser: any;
jest.mock('@/lib/auth/local', () => ({
  ...jest.requireActual('@/lib/auth/local'),
  getLocalSession: jest.fn(async () => mockUser),
  hashPassword: jest.fn(async () => 'test-password-hash'),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: any[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: any[] = []) => mockDb.prepare(sql).get(...params)),
  dbExecute: jest.fn(async (sql: string, params: any[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: result.lastInsertRowid };
  }),
  dbTransaction: jest.fn(async (callback: any) => callback()),
  generateId: () => 'new-staff',
}));

import * as staff from '../users';
import { dbSelect, dbGet, dbExecute } from '@/lib/db/tauri';
import { hasUserPermissionSync } from '@/lib/auth/local';
import { OWNER_ONLY_STAFF_PERMISSIONS } from '@/lib/auth/staff-policy';

const protectedActions = [
  () => staff.getStaffManagementDataAction(),
  () => staff.getStaffPerformanceAction(),
  () => staff.getJobsAction(),
  () => staff.addJobAction({ name_ar: 'test' }),
  () => staff.deleteJobAction(1),
  () => staff.addUserAction({ username: 'new', full_name: 'New', role: 'admin', password: 'secret123' }),
  () => staff.updateUserAction('staff', { username: 'other', full_name: 'Other', role: 'owner' }),
  () => staff.updateUserPermissionsAction('staff', { can_view_staff_manage: true }),
  () => staff.resetUserPasswordAction('staff', 'secret123'),
  () => staff.deleteUserAction('staff'),
  () => staff.closeUserShiftAndDeactivateAction({ userId: 'staff', shiftId: 'shift', actualCash: 0, authorizerPassword: 'secret' }),
];

beforeEach(() => {
  mockDb = new Database(':memory:');
  mockDb.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, pharmacy_id TEXT, is_active INTEGER DEFAULT 1,
      password_hash TEXT, permissions TEXT, job_id INTEGER, qualification TEXT, hire_date TEXT, shift TEXT, code TEXT);
    CREATE TABLE employee_jobs (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT, min_salary REAL, max_salary REAL);
    CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);
    CREATE TABLE shifts (id TEXT, user_id TEXT, status TEXT, start_time TEXT);
    CREATE TABLE sales_invoices (id TEXT, user_id TEXT, total_amount REAL, status TEXT);
    CREATE TABLE returns (id TEXT, user_id TEXT);
    INSERT INTO users (id, username, role, password_hash) VALUES ('owner', 'owner', 'owner', 'private-hash'), ('staff', 'staff', 'admin', 'private-hash');
    INSERT INTO shifts VALUES ('shift', 'staff', 'open', '2026-08-31 09:00:00');
    INSERT INTO sales_invoices VALUES ('sale', 'staff', 125, 'completed');
    INSERT INTO sales_invoices VALUES ('draft-sale', 'staff', 60, 'draft');
  `);
  mockUser = { id: 'owner', role: 'owner', permissions: {} };
  jest.clearAllMocks();
});
afterEach(() => mockDb.close());

it.each(['admin', 'manager', 'pharmacist', 'cashier', null])('blocks every staff action for %s before reading/writing data', async role => {
  mockUser = role ? { id: 'staff', role, permissions: Object.fromEntries(OWNER_ONLY_STAFF_PERMISSIONS.map(key => [key, true])) } : null;
  for (const action of protectedActions) expect((await action()).success).toBe(false);
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
});

it('lets the owner administer staff and jobs, read performance, and requires reconciliation before deactivating an open shift', async () => {
  expect((await staff.addUserAction({ username: 'new', full_name: 'New', role: 'pharmacist', password: 'secret123' })).success).toBe(true);
  expect((await staff.updateUserAction('new-staff', { username: 'updated', full_name: 'Updated', role: 'admin' })).success).toBe(true);
  expect((await staff.updateUserPermissionsAction('new-staff', { can_view_purchases: true })).success).toBe(true);
  expect((await staff.resetUserPasswordAction('new-staff', 'secret123')).success).toBe(true);
  expect(mockDb.prepare('SELECT username, role, permissions FROM users WHERE id = ?').get('new-staff')).toEqual({ username: 'updated', role: 'admin', permissions: '{"can_view_purchases":true}' });
  expect((await staff.addJobAction({ name_ar: 'صيدلي', min_salary: 10, max_salary: 20 })).success).toBe(true);
  expect((await staff.getJobsAction()).data).toHaveLength(1);
  expect((await staff.deleteJobAction(1)).success).toBe(true);
  const management = await staff.getStaffManagementDataAction();
  expect(management.success).toBe(true);
  expect(management.users?.[0]).not.toHaveProperty('password_hash');
  const performance = await staff.getStaffPerformanceAction();
  expect(performance.success).toBe(true);
  expect(performance.data?.find((row: any) => row.id === 'staff')?.totalRevenue).toBe(125);
  expect(await staff.deleteUserAction('staff')).toEqual(expect.objectContaining({ success: false, code: 'OPEN_SHIFT', openShift: expect.objectContaining({ id: 'shift' }) }));
  expect(mockDb.prepare("SELECT is_active FROM users WHERE id = 'staff'").get()).toEqual({ is_active: 1 });
  expect(mockDb.prepare('SELECT user_id FROM shifts').get()).toEqual({ user_id: 'staff' });
  expect(mockDb.prepare('SELECT user_id FROM sales_invoices').get()).toEqual({ user_id: 'staff' });
});

it('deactivates directly when the user has no open shift', async () => {
  mockDb.prepare("UPDATE shifts SET status = 'closed' WHERE user_id = 'staff'").run();
  expect((await staff.deleteUserAction('staff')).success).toBe(true);
  expect(mockDb.prepare("SELECT is_active FROM users WHERE id = 'staff'").get()).toEqual({ is_active: 0 });
});

it('keeps the basic active-staff selector available for shared-shift workflows', async () => {
  mockUser = { id: 'staff', role: 'pharmacist', permissions: {} };
  const result = await staff.getStaffAction();
  expect(result.success).toBe(true);
  expect(result.data).toHaveLength(2);
  expect(result.data?.[0]).not.toHaveProperty('permissions');
  expect(result.data?.[0]).not.toHaveProperty('password_hash');
});

it('prevents the last owner from removing owner access and rechecks the role on each action', async () => {
  expect((await staff.updateUserAction('owner', { username: 'owner', full_name: 'Owner', role: 'admin' })).success).toBe(false);
  expect((await staff.deleteUserAction('owner')).success).toBe(false);
  expect(mockDb.prepare("SELECT role FROM users WHERE id = 'owner'").get()).toEqual({ role: 'owner' });
  expect((await staff.getJobsAction()).success).toBe(true);
  mockUser = { id: 'owner', role: 'admin', permissions: { can_view_staff_roles: true } };
  expect((await staff.addJobAction({ name_ar: 'denied after role change' })).success).toBe(false);
  expect(mockDb.prepare('SELECT * FROM employee_jobs').all()).toHaveLength(0);
});

it.each(['admin', 'manager', 'pharmacist', 'cashier'])('ignores legacy staff grants for %s in every saved format', role => {
  const keys = OWNER_ONLY_STAFF_PERMISSIONS;
  for (const permissions of [keys, JSON.stringify(keys), Object.fromEntries(keys.map(key => [key, true])), JSON.stringify(Object.fromEntries(keys.map(key => [key, 'true'])))]) {
    for (const key of keys) {
      expect(hasUserPermissionSync({ role, permissions }, key)).toBe(false);
      expect(hasUserPermissionSync({ role: 'owner', permissions: {} }, key)).toBe(true);
    }
  }
});
