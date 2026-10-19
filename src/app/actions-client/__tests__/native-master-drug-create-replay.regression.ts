/** @jest-environment jsdom */
const mockInvoke = jest.fn();
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
import { createHash } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';
import { createNativeMasterDrug } from '../native-master-drug-create';

const initialCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const initialTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
const localKey = 'pharma:native-master-drug-create:v1';
const id = '9b3fa89c-aa15-4b23-9caf-08e0ff75b350';
beforeAll(() => {
  Object.defineProperty(globalThis, 'TextEncoder', {
    configurable: true, value: NodeTextEncoder,
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      randomUUID: () => id,
      subtle: { digest: async (_algorithm: string, buffer: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(Buffer.from(buffer)).digest()).buffer },
    },
  });
});
afterAll(() => {
  if (initialCrypto) Object.defineProperty(globalThis, 'crypto', initialCrypto);
  if (initialTextEncoder) Object.defineProperty(globalThis, 'TextEncoder', initialTextEncoder);
  else Reflect.deleteProperty(globalThis, 'TextEncoder');
});
beforeEach(() => { mockInvoke.mockReset(); window.localStorage.clear(); });

const product = { trade_name: 'Catalog QA test only', official_price: '5.00', barcode: 'QA-UNPOSTED-X',
  has_expiry: 0, is_medicine: 1, large_to_medium: 12 };

it('strict native typed new catalog uses a durable nonce, no SQL, and acknowledges only exact receipt', async () => {
  mockInvoke.mockResolvedValueOnce({ success: true, id: 931 });
  expect(await createNativeMasterDrug(product)).toEqual({ success: true, id: 931 });
  expect(mockInvoke).toHaveBeenCalledWith('create_master_drug_native', { payload: expect.objectContaining({
    tradeName: product.trade_name, officialPrice: 5, requestId: id,
    isMedicine: true, hasExpiry: false, largeToMedium: 12,
  }) });
  expect(window.localStorage.getItem(localKey)).toBeNull();
});

it('losing create acknowledgment retains only fingerprint+original nonce across reload for exact native replay', async () => {
  mockInvoke.mockRejectedValueOnce(new Error('Lost native ACK'));
  expect((await createNativeMasterDrug(product)).success).toBe(false);
  const hint = JSON.parse(window.localStorage.getItem(localKey) || '{}');
  expect(Object.keys(hint).sort()).toEqual(['fingerprint', 'requestId', 'version']);
  expect(hint.requestId).toBe(id);
  expect(JSON.stringify(hint)).not.toContain(product.trade_name);
  expect(JSON.stringify(hint)).not.toContain(product.barcode);
  mockInvoke.mockResolvedValueOnce({ success: true, id: 931 });
  expect(await createNativeMasterDrug(product)).toEqual({ success: true, id: 931 });
  expect(mockInvoke).toHaveBeenCalledTimes(2);
  expect((mockInvoke.mock.calls[0][1] as any).payload.requestId).toBe(id);
  expect((mockInvoke.mock.calls[1][1] as any).payload.requestId).toBe(id);
});

it('blocks altered intent, malformed storage and forged native ACK without new catalog writes', async () => {
  mockInvoke.mockRejectedValueOnce(new Error('Uncertain result'));
  await createNativeMasterDrug(product);
  const before = mockInvoke.mock.calls.length;
  expect((await createNativeMasterDrug({ ...product, official_price: 6 })).success).toBe(false);
  expect(mockInvoke).toHaveBeenCalledTimes(before);
  window.localStorage.setItem(localKey, '{corrupt');
  expect((await createNativeMasterDrug(product)).success).toBe(false);
  expect(mockInvoke).toHaveBeenCalledTimes(before);
  window.localStorage.clear();
  mockInvoke.mockResolvedValueOnce({ success: true, id: 'wrong ID' });
  expect((await createNativeMasterDrug(product)).success).toBe(false);
  expect(window.localStorage.getItem(localKey)).not.toBeNull();
});

it('rejects blank/malformed retail and unit values before catalog IPC', async () => {
  for (const value of ['', '  ', null, false, [], NaN, Infinity, -1, 'abc', 2.222]) {
    expect((await createNativeMasterDrug({ ...product, official_price: value })).success).toBe(false);
  }
  for (const invalid of [0, -2, '  ', Infinity, 2.5, []]) {
    expect((await createNativeMasterDrug({ ...product, large_to_medium: invalid })).success).toBe(false);
  }
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(localKey)).toBeNull();
});

it('enforces native Rust text field caps before reserving an unreplayable nonce', async () => {
  for (const candidate of [
    { trade_name: 'X'.repeat(161) },
    { trade_name_en: 'X'.repeat(161) },
    { generic_name: 'X'.repeat(161) },
    { category: 'X'.repeat(161) },
    { manufacturer: 'X'.repeat(161) },
    { large_unit: 'X'.repeat(81) },
    { medium_unit: 'X'.repeat(81) },
    { small_unit: 'X'.repeat(81) },
    { barcode: 'X'.repeat(129) },
    { active_ingredient: 'X'.repeat(513) },
  ]) {
    const result = await createNativeMasterDrug({ ...product, ...candidate });
    expect(result.success).toBe(false);
  }
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(localKey)).toBeNull();
});
