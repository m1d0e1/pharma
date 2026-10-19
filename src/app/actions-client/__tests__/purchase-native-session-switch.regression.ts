/** @jest-environment node */
const mockInvoke = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: (...args: any[]) => mockGet(...args),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
  normalizeDatabaseTimestamps: (rows: any[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: (user: any, permission: string) => Boolean(user?.permissions?.[permission]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn() },
}));

import { getPurchaseInvoicesAction, getDraftPurchaseInvoicesAction } from '@/app/actions-client/purchases';

const fullInvoicePage = Array.from({ length: 200 }, (_, id) => ({
  id: `a-${String(id).padStart(3, '0')}`,
  created_at: '2026-10-01 10:00:00',
  pharmacy_id: 'ph-a',
}));
const fullDraftPage = fullInvoicePage.map(({ id, created_at }) => ({
  id, __cursor_created_at: created_at, supplier_id: 1, invoice_number: id,
}));
const nativePage = (rows: any[], actorId = 'reader-a', pharmacyId = 'ph-a') => ({
  actorId, pharmacyId, rows,
});
// RED compatibility: the previous unversioned API returned bare arrays and
// silently assembled cross-actor pages. GREEN must use only the new envelope.
const nativeOrLegacyPage = (command: string, rows: any[], actorId = 'reader-a', pharmacyId = 'ph-a') =>
  command === 'db_read_purchasing_page' ? nativePage(rows, actorId, pharmacyId) : rows;

describe('native purchase pagination cannot combine changed sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = {
      id: 'reader-a', role: 'cashier', pharmacy_id: 'ph-a',
      permissions: { can_view_purchases: true },
    };
    mockSelect.mockRejectedValue(new Error('Legacy renderer SQL must never read purchases'));
    mockGet.mockRejectedValue(new Error('Legacy renderer SQL must never read purchases'));
  });

  it.each([
    ['invoices', getPurchaseInvoicesAction, 'purchases.invoices_list', fullInvoicePage],
    ['drafts', getDraftPurchaseInvoicesAction, 'purchases.drafts_list', fullDraftPage],
  ] as const)('fails closed when %s page two is fetched for a different native actor/tenant', async (
    _label, read, queryId, firstPage,
  ) => {
    mockInvoke
      .mockImplementationOnce(async (command: string) => nativeOrLegacyPage(command, firstPage))
      .mockImplementationOnce(async (command: string) => {
        // The native backend independently authorizes the next page against
        // actor B. The renderer must not merge it with cached actor A rows.
        mockSession = {
          id: 'reader-b', role: 'cashier', pharmacy_id: 'ph-b',
          permissions: { can_view_purchases: true },
        };
        return nativeOrLegacyPage(command, [{
          id: 'b-private', pharmacy_id: 'ph-b',
          created_at: '2026-09-30 10:00:00',
          __cursor_created_at: '2026-09-30 10:00:00',
        }], 'reader-b', 'ph-b');
      });
    const result = await read();
    expect(result).toMatchObject({ success: false });
    expect((result as any).data).toBeUndefined();
    expect((result as any).error).toMatch(/scope changed/i);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls.map(([, args]) => args.queryId)).toEqual([queryId, queryId]);
    expect(mockInvoke.mock.calls.every(([command]) => command === 'db_read_purchasing_page')).toBe(true);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([
    ['invoices', getPurchaseInvoicesAction],
    ['drafts', getDraftPurchaseInvoicesAction],
  ] as const)('rejects %s even when page one belongs to a different authenticated actor', async (
    _label, read,
  ) => {
    mockInvoke.mockImplementationOnce(async (command: string) =>
      nativeOrLegacyPage(command, [{ id: 'b-private', pharmacy_id: 'ph-a' }], 'reader-b', 'ph-a'));
    const result = await read();
    expect(result).toMatchObject({ success: false });
    expect((result as any).data).toBeUndefined();
    expect((result as any).error).toMatch(/scope changed/i);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['invoices', getPurchaseInvoicesAction, 'purchases.invoices_list', fullInvoicePage],
    ['drafts', getDraftPurchaseInvoicesAction, 'purchases.drafts_list', fullDraftPage],
  ] as const)('preserves complete %s pagination only through authenticated envelopes', async (
    label, read, queryId, firstPage,
  ) => {
    mockInvoke
      .mockImplementationOnce(async (command: string) => nativeOrLegacyPage(command, firstPage))
      .mockImplementationOnce(async (command: string) => nativeOrLegacyPage(command, [{
        id: 'a-last', created_at: '2026-09-30 10:00:00',
        __cursor_created_at: '2026-09-30 10:00:00', pharmacy_id: 'ph-a',
      }]));
    const result = await read();
    expect(result).toMatchObject({ success: true, data: expect.any(Array) });
    expect((result as any).data).toHaveLength(201);
    if (label === 'drafts') {
      expect((result as any).data[0].__cursor_created_at).toBeUndefined();
    }
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls.map(([command, args]) => [command, args.queryId])).toEqual([
      ['db_read_purchasing_page', queryId],
      ['db_read_purchasing_page', queryId],
    ]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['bare rows', [{ id: 'private' }]],
    ['missing actor', { pharmacyId: 'ph-a', rows: [{ id: 'private' }] }],
    ['missing pharmacy', { actorId: 'reader-a', rows: [{ id: 'private' }] }],
    ['empty actor', nativePage([{ id: 'private' }], '', 'ph-a')],
    ['empty pharmacy', nativePage([{ id: 'private' }], 'reader-a', '')],
    ['invalid rows', { actorId: 'reader-a', pharmacyId: 'ph-a', rows: null }],
    ['oversize', nativePage(Array.from({ length: 201 }, (_, id) => ({ id })))],
  ])('rejects invalid invoice page envelope: %s', async (_label, response) => {
    mockInvoke.mockResolvedValueOnce(response);
    expect(await getPurchaseInvoicesAction()).toMatchObject({ success: false });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('preserves native denial and never retries legacy SQL', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Authenticated purchasing actor denied'));
    expect(await getPurchaseInvoicesAction()).toMatchObject({
      success: false, error: 'Authenticated purchasing actor denied',
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
