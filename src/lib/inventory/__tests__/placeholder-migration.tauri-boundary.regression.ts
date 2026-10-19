jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => ({
  affectedItems: [], migratedRows: 0, barcodeRowsUpdated: 0, changed: false,
})) }));
jest.mock('@/lib/db/tauri', () => ({ dbTransaction: jest.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { dbTransaction } from '@/lib/db/tauri';
import { migrateLegacyPlaceholderInventoryScope } from '@/lib/inventory/placeholder-migration';

it('routes Tauri placeholder repair through the native compatibility command', async () => {
  await expect(migrateLegacyPlaceholderInventoryScope()).resolves.toEqual({
    affectedItems: [], migratedRows: 0, barcodeRowsUpdated: 0, changed: false,
  });
  expect(invoke).toHaveBeenCalledWith('migrate_legacy_placeholder_inventory_scope');
  expect(dbTransaction).not.toHaveBeenCalled();
});
