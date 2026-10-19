const execute = jest.fn();
const get = jest.fn();
const setWatermark = jest.fn();
const from = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: false }));
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

it('rejects unsupported runtimes before database or cloud access', async () => {
  await expect(syncDrugInteractionsClient()).resolves.toEqual({
    success: false,
    error: 'تحديث الأدوية والتفاعلات متاح فقط داخل تطبيق سطح المكتب.',
  });
  expect(get).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(from).not.toHaveBeenCalled();
  expect(setWatermark).not.toHaveBeenCalled();
});
