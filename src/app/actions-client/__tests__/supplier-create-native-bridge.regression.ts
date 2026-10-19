/** @jest-environment node */
const mockInvoke = jest.fn();
const mockSql = jest.fn((..._args: any[]) => { throw new Error('Generic renderer SQL must never provision suppliers'); });
let mockSession: any;
const NONCE = '0a30d2f1-f29e-4055-82ca-695301aa3e77';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSql(...args),
  dbGet: (...args: any[]) => mockSql(...args),
  dbExecute: (...args: any[]) => mockSql(...args),
  dbTransaction: (...args: any[]) => mockSql(...args),
  generateId: jest.fn(() => NONCE),
  normalizeDatabaseTimestamps: (rows: any[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: (user: any, permission: string) => Boolean(user?.permissions?.[permission]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));

import { addSupplierAction, updateSupplierAction, deleteSupplierAction } from '@/app/actions-client/purchases';

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = { id: 'owner-a', role: 'owner', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: true } };
});

it('creates through the only typed native command with canonical UUIDv4 and normalized directory fields', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 77, requestId: NONCE });
  expect(await addSupplierAction({
    name_ar: '  شركة جديدة  ', name_en: '  New Co  ', phone: '  0123  ', address: '  Alexandria  ',
  })).toMatchObject({ success: true, id: 77 });
  expect(mockInvoke).toHaveBeenCalledWith('create_supplier_native', { payload: {
    requestId: NONCE, nameAr: 'شركة جديدة', nameEn: 'New Co', phone: '0123', address: 'Alexandria',
  } });
  expect(mockSql).not.toHaveBeenCalled();
});

it('forwards an explicit retry UUID unchanged after ambiguous native rejection; no fallback or auto retry', async () => {
  const retry = 'c3e326d9-d09f-47e8-842f-09596506bcc2';
  mockInvoke.mockRejectedValueOnce('IPC response lost');
  mockInvoke.mockResolvedValueOnce({ id: 91, requestId: retry });
  const payload = { name_ar: '  Retried Supplier ', request_id: retry };
  expect((await addSupplierAction(payload)).success).toBe(false);
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  expect(await addSupplierAction(payload)).toMatchObject({ success: true, id: 91 });
  expect(mockInvoke.mock.calls.map(([, args]) => args.payload.requestId)).toEqual([retry, retry]);
  expect(mockSql).not.toHaveBeenCalled();
});

it.each(['', 'not-uuid', '65b13673-d3d0-42d0-82fa-979680a70ddz', '65B13673-D3D0-42D0-82FA-979680A70DDD', '65b13673-d3d0-12d0-82fa-979680a70ddd'])(
  'rejects malformed or non-v4 caller request IDs before native execution: %s', async request_id => {
    expect((await addSupplierAction({ name_ar: 'Supplier', request_id })).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  },
);

it('rejects unauthenticated and non-owner supplier creates and keeps edit/delete unavailable', async () => {
  mockSession = { id: 'cashier-a', role: 'cashier', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: true } };
  expect((await addSupplierAction({ name_ar: 'Supplier' })).success).toBe(false);
  mockSession = null;
  expect((await addSupplierAction({ name_ar: 'Supplier' })).success).toBe(false);
  mockSession = { id: 'owner-a', role: 'owner', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: true } };
  expect((await updateSupplierAction(77, { name_ar: 'Not editable' })).success).toBe(false);
  expect((await deleteSupplierAction(77)).success).toBe(false);
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(mockSql).not.toHaveBeenCalled();
});

it('fails closed on mismatched or malformed native create acknowledgement', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 77, requestId: 'another-request' });
  expect((await addSupplierAction({ name_ar: 'Supplier' })).success).toBe(false);
  mockInvoke.mockResolvedValueOnce({ id: -1, requestId: NONCE });
  expect((await addSupplierAction({ name_ar: 'Supplier' })).success).toBe(false);
  expect(mockSql).not.toHaveBeenCalled();
});
