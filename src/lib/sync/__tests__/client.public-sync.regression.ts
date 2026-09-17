const metadata = new Map<string, string>();
let failInteractionWrite = false;

jest.mock('@/lib/db/tauri', () => ({
  dbExecute: jest.fn(async (sql: string, params: any[] = []) => {
    if (failInteractionWrite && sql.includes('INSERT INTO drug_interactions')) {
      throw new Error('injected interaction write failure');
    }
    if (sql.includes('INSERT OR REPLACE INTO sync_metadata')) {
      metadata.set(String(params[0]), String(params[1]));
    }
    return { rowsAffected: 1 };
  }),
  dbGet: jest.fn(async (_sql: string, params: any[] = []) => {
    const value = metadata.get(String(params[0]));
    return value ? { last_synced_at: value } : null;
  }),
}));

jest.mock('@/app/actions-client/sync', () => ({
  syncMasterDrugsToLocal: jest.fn(),
}));

const from = jest.fn();

jest.mock('@/lib/supabase', () => ({
  getSupabaseBrowserClient: jest.fn(() => ({ from })),
}));

import { syncFromCloudClient } from '@/lib/sync/client';

const emptyQuery = () => {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.gt = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.range = jest.fn(async () => ({ data: [], error: null }));
  return query;
};

describe('public catalog sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    metadata.clear();
    failInteractionWrite = false;
    from.mockImplementation(() => emptyQuery());
  });

  it('syncs public catalog tables without cloud auth or profile access', async () => {
    const result = await syncFromCloudClient();

    expect(result.success).toBe(true);
    expect(from.mock.calls.map(([table]) => table)).toEqual([
      'cloud_drugs',
      'cloud_drug_interactions',
    ]);
    expect(result.syncedUsernames).toEqual([]);
  });

  it('does not advance the interaction watermark on a failed local write and succeeds on retry', async () => {
    const interactionQuery = () => {
      const query: any = {};
      query.select = jest.fn(() => query);
      query.gt = jest.fn(() => query);
      query.order = jest.fn(() => query);
      query.range = jest.fn(async () => ({
        data: [{ drug_1: 'A', drug_2: 'B', interaction_description: 'AB' }],
        error: null,
      }));
      return query;
    };
    from.mockImplementation((table: string) => table === 'cloud_drug_interactions' ? interactionQuery() : emptyQuery());

    failInteractionWrite = true;
    const failed = await syncFromCloudClient();
    expect(failed.success).toBe(false);
    expect(metadata.has('cloud_drugs')).toBe(true);
    expect(metadata.has('cloud_drug_interactions')).toBe(false);

    failInteractionWrite = false;
    const retried = await syncFromCloudClient();
    expect(retried.success).toBe(true);
    expect(metadata.has('cloud_drug_interactions')).toBe(true);
  });
});
