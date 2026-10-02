/** @jest-environment node */

import { createFunctionTransactionDb as mockCreateFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockUser: any;
const config = new Map<string, string>();

const dbSelect = jest.fn(async (_sql: string, params: unknown[] = []) =>
  params
    .map(String)
    .filter(key => config.has(key))
    .map(key => ({ key, value: config.get(key) }))
);
const dbGet = jest.fn(async (_sql: string, params: unknown[] = []) => {
  const key = String(params[0] ?? '');
  return config.has(key) ? { value: config.get(key) } : null;
});
const dbExecute = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (/INSERT INTO config/i.test(sql)) config.set(String(params[0]), String(params[1] ?? ''));
  return { rowsAffected: 1, lastInsertId: 1 };
});

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (sql: string, params: unknown[] = []) => dbSelect(sql, params),
  dbGet: (sql: string, params: unknown[] = []) => dbGet(sql, params),
  dbExecute: (sql: string, params: unknown[] = []) => dbExecute(sql, params),
  dbTransaction: jest.fn(async (callback: any) => callback(mockCreateFunctionTransactionDb({
    select: dbSelect,
    get: dbGet,
    execute: dbExecute,
  }))),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner' || user?.permissions?.[permission] === true
  ),
}));

import { getConfigAction } from '@/app/actions-client/config';
import { getLocalPharmacySettingsClient, updatePharmacyClient } from '@/lib/settings/client';

describe('pharmacy identity config scope', () => {
  beforeEach(() => {
    config.clear();
    jest.clearAllMocks();
    mockUser = { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a', permissions: {} };
  });

  it('keeps non-default pharmacy identities independent while leaving global config untouched', async () => {
    config.set('subscription_status', 'activated');
    config.set('pharmacy_name', 'Legacy Local Default');

    expect(await updatePharmacyClient({ name: 'Pharmacy A', phone: '111' })).toEqual({ success: true });
    expect(await getLocalPharmacySettingsClient()).toMatchObject({ name: 'Pharmacy A', phone: '111' });
    expect(await getConfigAction('pharmacy_name')).toEqual({ success: true, value: 'Pharmacy A' });

    mockUser = { id: 'owner-b', role: 'owner', pharmacy_id: 'ph-b', permissions: {} };
    expect(await getLocalPharmacySettingsClient()).toEqual({});
    expect(await getConfigAction('pharmacy_name')).toEqual({ success: true, value: null });
    expect(await updatePharmacyClient({ name: 'Pharmacy B', phone: '222' })).toEqual({ success: true });
    expect(await getLocalPharmacySettingsClient()).toMatchObject({ name: 'Pharmacy B', phone: '222' });
    expect(await getConfigAction('pharmacy_name')).toEqual({ success: true, value: 'Pharmacy B' });

    mockUser = { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a', permissions: {} };
    expect(await getConfigAction('pharmacy_name')).toEqual({ success: true, value: 'Pharmacy A' });
    expect(config.get('subscription_status')).toBe('activated');
    expect(config.get('pharmacy_name')).toBe('Legacy Local Default');
  });

  it('preserves legacy plain pharmacy keys for local_default only', async () => {
    mockUser = { id: 'owner-local', role: 'owner', pharmacy_id: 'local_default', permissions: {} };
    config.set('pharmacy_name', 'Legacy Local Default');

    expect(await getConfigAction('pharmacy_name')).toEqual({ success: true, value: 'Legacy Local Default' });
    expect(await updatePharmacyClient({ name: 'Updated Local' })).toEqual({ success: true });
    expect(config.get('pharmacy_name')).toBe('Updated Local');
  });
});
