/** @jest-environment node */

import Database from 'better-sqlite3';

const mockInvoke = jest.fn();
const mockSelect = jest.fn();
let mockIsTauri = true;
let mockSession: any;
let testDb: Database.Database;

jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
}));

import { getStaffAction } from '@/app/actions-client/users';

const nativeRows = [
  {
    id: 'owner-a', username: 'owner-a', full_name: 'Alpha Owner',
    role: 'owner', is_active: 1, job_name_ar: null, job_name_en: null,
  },
  {
    id: 'cashier-a', username: 'cashier-a', full_name: 'Bravo Cashier',
    role: 'cashier', is_active: 1, job_name_ar: 'كاشير', job_name_en: 'Cashier',
  },
];

describe('native staff directory boundary and legacy web parity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    mockSession = { id: 'cashier-a', role: 'cashier', pharmacy_id: 'ph-a' };
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE employee_jobs (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT, full_name TEXT, role TEXT,
        job_id INTEGER, pharmacy_id TEXT, is_active INTEGER, password_hash TEXT
      );
      INSERT INTO employee_jobs VALUES (1, 'صيدلي', 'Pharmacist'), (2, 'كاشير', 'Cashier');
      INSERT INTO users VALUES
        ('owner-a','owner-a','Alpha Owner','owner',NULL,'ph-a',1,'secret-owner'),
        ('cashier-a','cashier-a','Bravo Cashier','cashier',2,'ph-a',1,'secret-cashier'),
        ('inactive-a','inactive-a','Inactive Cashier','cashier',2,'ph-a',0,'secret-inactive'),
        ('owner-b','owner-b','Foreign Owner','owner',1,'ph-b',1,'secret-foreign'),
        ('default-owner','default-owner','Default Owner','owner',NULL,NULL,1,'secret-default'),
        ('default-staff','default-staff','Default Staff','cashier',2,NULL,1,'secret-default'),
        ('explicit-default','explicit-default','Explicit Default','cashier',1,'local_default',1,'secret-default');
    `);
    mockSelect.mockImplementation(async (sql: string, args: unknown[] = []) =>
      testDb.prepare(sql).all(...args));
    mockInvoke.mockResolvedValue(nativeRows);
  });

  afterEach(() => testDb.close());

  it.each(['owner', 'admin', 'manager', 'pharmacist', 'cashier'])(
    'uses the native session-derived command for %s without renderer SQL or identity arguments',
    async role => {
      mockSession.role = role;
      expect(await getStaffAction()).toEqual({ success: true, data: nativeRows });
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('list_staff_directory');
      expect(mockSelect).not.toHaveBeenCalled();
      expect(Object.keys(nativeRows[0])).toEqual([
        'id', 'username', 'full_name', 'role', 'is_active', 'job_name_ar', 'job_name_en',
      ]);
      expect(JSON.stringify(nativeRows)).not.toContain('password_hash');
      expect(JSON.stringify(nativeRows)).not.toContain('secret-');
    },
  );

  it('preserves the old web projection, active filter, job join, tenant filter and ordering', async () => {
    const desktop = await getStaffAction();
    mockIsTauri = false;
    const web = await getStaffAction();
    expect(web).toEqual(desktop);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSelect.mock.calls[0];
    expect(params).toEqual(['ph-a', 'ph-a']);
    expect(sql).toContain('LEFT JOIN employee_jobs ej ON u.job_id = ej.id');
    expect(sql).toContain('WHERE u.is_active = 1');
    expect(sql).toContain('ORDER BY u.full_name ASC, u.username ASC');
    expect(sql).not.toContain('password_hash');
  });

  it('preserves default-pharmacy NULL rows only for the legacy default web tenant', async () => {
    mockIsTauri = false;
    mockSession = { id: 'default-owner', role: 'owner', pharmacy_id: null };
    const result = await getStaffAction();
    expect(result.success).toBe(true);
    expect(result.data?.map((row: any) => row.id)).toEqual([
      'default-owner', 'default-staff', 'explicit-default',
    ]);
    expect(mockSelect.mock.calls[0][1]).toEqual(['local_default', 'local_default']);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each([true, false])('rejects a missing local session before %s transport', async native => {
    mockIsTauri = native;
    mockSession = null;
    expect(await getStaffAction()).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('fails closed on native rejection and malformed responses without generic SQL fallback', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Native actor is inactive'));
    expect(await getStaffAction()).toEqual({
      success: false, error: 'فشل جلب قائمة الموظفين',
    });
    mockInvoke.mockResolvedValueOnce({ id: 'unexpected' });
    expect(await getStaffAction()).toEqual({
      success: false, error: 'فشل جلب قائمة الموظفين',
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
