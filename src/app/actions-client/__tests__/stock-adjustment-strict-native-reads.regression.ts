/** @jest-environment node */
const mockInvoke = jest.fn();
const mockSql = jest.fn((..._args: unknown[]) => { throw Error('Private inventory SQL must remain denied'); });
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockSql(...args),
  dbGet: (...args: unknown[]) => mockSql(...args),
  dbExecute: (...args: unknown[]) => mockSql(...args),
  generateId: jest.fn(),
}));
import { readAdjustmentReasonsNative, searchAdjustmentLotsNative } from '../stock-adjustment-native-reads';

beforeEach(() => jest.clearAllMocks());

it('uses fixed authenticated native reason source without renderer SQL', async () => {
  mockInvoke.mockResolvedValueOnce([{ id: 3, name_ar: 'Count', name_en: null }]);
  expect(await readAdjustmentReasonsNative()).toEqual([{ id: 3, name_ar: 'Count', name_en: null }]);
  expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
    queryId: 'inventory.adjustment_reasons', recordId: null,
    search: null, drugId: null, limit: 100, offset: 0,
  });
  expect(mockSql).not.toHaveBeenCalled();
});

it('searches zero-quantity lots using bounded fixed owner projection', async () => {
  mockInvoke.mockResolvedValueOnce([
    { id: 'lot-zero', drug_id: 17, quantity: 0, trade_name: 'Test', trade_name_en: null, barcode: null },
  ]);
  expect(await searchAdjustmentLotsNative('  Test  ')).toEqual([
    { id: 'lot-zero', drug_id: 17, quantity: 0, trade_name: 'Test', trade_name_en: null, barcode: null },
  ]);
  expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
    queryId: 'inventory.adjustment_lots', recordId: null,
    search: 'Test', drugId: null, limit: 20, offset: 0,
  });
  expect(mockSql).not.toHaveBeenCalled();
});

it('fails closed on malformed owner sources and invalid search without SQL fallback', async () => {
  await expect(searchAdjustmentLotsNative('%')).rejects.toThrow('Invalid');
  expect(mockInvoke).not.toHaveBeenCalled();
  for (const wrong of [null, {}, Array(21).fill({}),
    [{ id: 'z', drug_id: 1, quantity: -1, trade_name: 'Valid' }],
    [{ id: 'z', drug_id: 1, quantity: 0, trade_name: 'Valid' },
      { id: 'z', drug_id: 1, quantity: 0, trade_name: 'Valid' }],
  ]) {
    mockInvoke.mockResolvedValueOnce(wrong);
    await expect(searchAdjustmentLotsNative('Drug')).rejects.toThrow();
  }
  mockInvoke.mockResolvedValueOnce([{ id: 1, name_ar: 'Test' }, { id: 1, name_ar: 'Duplicated' }]);
  await expect(readAdjustmentReasonsNative()).rejects.toThrow('identity');
  expect(mockSql).not.toHaveBeenCalled();
});
