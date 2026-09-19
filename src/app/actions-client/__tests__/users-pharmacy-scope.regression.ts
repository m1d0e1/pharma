import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockSession: any;
let mockId = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: any[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: any[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: any[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => callback()),
  generateId: jest.fn(() => `user-${++mockId}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hashPassword: jest.fn(async () => 'password-hash'),
}));

const { addUserAction, getStaffAction } = jest.requireActual(
  '@/app/actions-client/users'
) as typeof import('@/app/actions-client/users');

describe('staff pharmacy scope', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockId = 0;
    mockDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT,
        permissions TEXT,
        job_id INTEGER,
        qualification TEXT,
        hire_date TEXT,
        shift TEXT,
        code TEXT,
        pharmacy_id TEXT,
        is_active INTEGER DEFAULT 1
      );
      CREATE TABLE employee_jobs (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);
    `);
  });

  afterEach(() => mockDb.close());

  it('creates staff in the owner pharmacy and keeps explicit pharmacies isolated', async () => {
    mockSession = { id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' };
    expect(await addUserAction({ username: 'ph1-staff', full_name: 'Pharmacy One', role: 'pharmacist' })).toEqual({ success: true });
    expect(mockDb.prepare("SELECT pharmacy_id FROM users WHERE username = 'ph1-staff'").get()).toEqual({ pharmacy_id: 'ph-1' });
    expect(await addUserAction({ username: 'ph1-admin', full_name: 'Pharmacy Admin', role: 'admin' })).toEqual({ success: true });
    const adminPermissions = JSON.parse((mockDb.prepare("SELECT permissions FROM users WHERE username = 'ph1-admin'").get() as any).permissions);
    expect(adminPermissions).not.toHaveProperty('can_view_cogs');

    expect((await getStaffAction()).data.map((user: any) => user.username)).toEqual(['ph1-admin', 'ph1-staff']);
    mockSession = { id: 'owner-2', role: 'owner', pharmacy_id: 'ph-2' };
    expect((await getStaffAction()).data).toEqual([]);
  });

  it('normalizes missing owner pharmacy to local_default without leaking to explicit pharmacies', async () => {
    mockSession = { id: 'owner-default', role: 'owner' };
    expect(await addUserAction({ username: 'default-staff', full_name: 'Default Staff', role: 'pharmacist' })).toEqual({ success: true });
    expect(mockDb.prepare("SELECT pharmacy_id FROM users WHERE username = 'default-staff'").get()).toEqual({ pharmacy_id: 'local_default' });

    expect((await getStaffAction()).data.map((user: any) => user.username)).toEqual(['default-staff']);
    mockSession = { id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' };
    expect((await getStaffAction()).data).toEqual([]);
  });
});
