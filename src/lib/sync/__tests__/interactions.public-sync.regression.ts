const execute = jest.fn();
const get = jest.fn();
const setWatermark = jest.fn();
const from = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({
  dbExecute: (...args: unknown[]) => execute(...args),
  dbGet: (...args: unknown[]) => get(...args),
}));
jest.mock('@/lib/sync/watermark', () => ({
  setSyncWatermark: (...args: unknown[]) => setWatermark(...args),
}));
jest.mock('@/lib/supabase', () => ({
  getSupabaseBrowserClient: () => ({ from }),
}));

import { syncDrugInteractionsClient } from '../interactions';

function queryPage(data: unknown[], error: unknown = null) {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.gt = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.range = jest.fn(async () => ({ data, error }));
  return query;
}

describe('public interaction synchronization seam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    get.mockResolvedValue({ last_synced_at: '2026-09-01T00:00:00Z' });
    execute.mockResolvedValue({ rowsAffected: 1 });
    setWatermark.mockResolvedValue(undefined);
    from.mockImplementation(() => queryPage([]));
  });

  it('only reads the public interaction table and writes local upserts before the watermark', async () => {
    const page = queryPage([
      { drug_1: 'A', drug_2: 'B', interaction_description: 'AB' },
      { drug_1: 'C', drug_2: 'D', interaction_description: 'CD' },
    ]);
    from.mockReturnValue(page);
    const events: string[] = [];
    execute.mockImplementation(async () => {
      events.push('write');
      return { rowsAffected: 2 };
    });
    setWatermark.mockImplementation(async () => { events.push('watermark'); });

    await expect(syncDrugInteractionsClient()).resolves.toEqual({ success: true, count: 2 });

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('cloud_drug_interactions');
    expect(page.gt).toHaveBeenCalledWith('updated_at', '2026-09-01T00:00:00Z');
    expect(page.range).toHaveBeenCalledWith(0, 999);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT(ingredient_a, ingredient_b) DO UPDATE SET'),
      ['A', 'B', 'AB', 'C', 'D', 'CD'],
    );
    expect(events).toEqual(['write', 'watermark']);
    expect(setWatermark).toHaveBeenCalledWith('cloud_drug_interactions', expect.any(String));
  });

  it('does not advance the cursor on a network failure', async () => {
    from.mockReturnValue(queryPage([], new Error('offline')));
    await expect(syncDrugInteractionsClient()).resolves.toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
    expect(setWatermark).not.toHaveBeenCalled();
  });

  it('does not advance the cursor on a failed local write, so the batch can be retried', async () => {
    from.mockReturnValue(queryPage([{ drug_1: 'A', drug_2: 'B', interaction_description: 'AB' }]));
    execute.mockRejectedValueOnce(new Error('sqlite busy'));
    await expect(syncDrugInteractionsClient()).resolves.toMatchObject({ success: false });
    expect(setWatermark).not.toHaveBeenCalled();
  });

  it('does not advance the cursor when native persistence rejects the watermark', async () => {
    setWatermark.mockRejectedValueOnce(new Error('transaction blocked'));
    await expect(syncDrugInteractionsClient()).resolves.toMatchObject({ success: false });
  });
});
