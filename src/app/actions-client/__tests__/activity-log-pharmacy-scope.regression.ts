import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockSession: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => callback()),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => mockSession),
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner' || user?.permissions?.includes(permission)
  ),
}));

import { clearAuditLogsAction, getAuditLogsAction } from '@/app/actions-client/audit';

describe('activity log pharmacy ownership', () => {
  beforeEach(() => {
    mockSession = { id: 'u1', role: 'owner', pharmacy_id: 'ph-1' };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        full_name TEXT,
        role TEXT,
        pharmacy_id TEXT
      );
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        pharmacy_id TEXT,
        action TEXT,
        details TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TRIGGER activity_log_snapshot_pharmacy_insert
      AFTER INSERT ON activity_log
      WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
      BEGIN
        UPDATE activity_log
        SET pharmacy_id = COALESCE(
          (SELECT NULLIF(TRIM(u.pharmacy_id), '')
           FROM users u
           WHERE CAST(u.id AS TEXT) = CAST(NEW.user_id AS TEXT)
              OR LOWER(u.username) = LOWER(CAST(NEW.user_id AS TEXT))
           LIMIT 1),
          'local_default'
        )
        WHERE id = NEW.id;
      END;

      INSERT INTO users VALUES
        ('u1', 'u1', 'User One', 'owner', 'ph-1'),
        ('u2', 'u2', 'User Two', 'owner', 'ph-2');
      INSERT INTO activity_log (user_id, pharmacy_id, action, details, created_at) VALUES
        ('u1', 'ph-1', 'PH1', 'ph1 history', datetime('now', 'localtime')),
        ('u2', 'ph-2', 'PH2', 'ph2 history', datetime('now', 'localtime'));
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps audit history and aggregates inside the stored branch even if the user scope changes', async () => {
    mockDb.prepare("UPDATE users SET pharmacy_id = 'ph-2' WHERE id = 'u1'").run();

    const result = await getAuditLogsAction();
    expect(result.success).toBe(true);
    expect(result.data?.logs.map((row: any) => row.action)).toEqual(['PH1']);
    expect(result.data?.todayCount).toBe(1);
    expect(result.data?.userActivity).toEqual([
      expect.objectContaining({ full_name: 'User One', actions: 1 }),
    ]);
    expect(result.data?.actionTypes).toEqual([
      expect.objectContaining({ action: 'PH1', count: 1 }),
    ]);
  });

  it('clears only the signed-in pharmacy and snapshots the clear event back into that pharmacy', async () => {
    const result = await clearAuditLogsAction();
    expect(result.success).toBe(true);

    expect(mockDb.prepare('SELECT pharmacy_id, action FROM activity_log ORDER BY id').all()).toEqual([
      { pharmacy_id: 'ph-2', action: 'PH2' },
      { pharmacy_id: 'ph-1', action: 'CLEAR_LOGS' },
    ]);
  });

  it('denies audit reads without the configured audit permission', async () => {
    mockSession = { id: 'u1', role: 'pharmacist', pharmacy_id: 'ph-1', permissions: [] };
    expect(await getAuditLogsAction()).toMatchObject({ success: false });
  });
});
