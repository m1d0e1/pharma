jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => undefined) }));
jest.mock('@/lib/db/tauri', () => ({ dbExecute: jest.fn(async () => ({ rowsAffected: 1 })) }));

import { invoke } from '@tauri-apps/api/core';
import { dbExecute } from '@/lib/db/tauri';
import { setSyncWatermark } from '@/lib/sync/watermark';

const mockInvoke = jest.mocked(invoke);
const mockDbExecute = jest.mocked(dbExecute);

it('routes Tauri sync watermarks through the typed native command', async () => {
  await setSyncWatermark('cloud_drug_interactions', '2026-10-05T12:00:00Z');
  expect(mockInvoke).toHaveBeenCalledWith('set_sync_watermark', {
    tableName: 'cloud_drug_interactions',
    lastSyncedAt: '2026-10-05T12:00:00Z',
  });
  expect(mockDbExecute).not.toHaveBeenCalled();
});
