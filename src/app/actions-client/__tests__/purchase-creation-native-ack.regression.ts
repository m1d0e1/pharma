import { invoke } from '@tauri-apps/api/core';
import { createPurchaseInvoiceAction } from '@/app/actions-client/purchases';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn().mockResolvedValue({ id: 'owner-a', role: 'owner', pharmacy_id: 'A' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbExecute: jest.fn(), dbGet: jest.fn(),
  dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(), enrich: jest.fn() },
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

const native = invoke as jest.Mock;
const NONCE = '12345678-abcd-4abc-8abc-123456789abc';
const purchase = {
  supplier_id: 7, payment_method: 'credit', status: 'completed',
  request_id: NONCE,
  cart: [{ id: 9, quantity: 2, cost_price: 10, selling_price: 12,
    expiry_date: '2030-12-31', strips_per_box: 1, bonus_quantity: 0,
    tax_percent: 0, discount_percent: 0 }],
};
const proof = {
  requestId: NONCE, invoiceId: 'native-purchase-1',
  status: 'completed', supplierId: 7, lineCount: 1, totalCents: 2000,
};
const expected = {
  requestId: NONCE, supplierId: 7,
  expectedStatus: 'completed', expectedLineCount: 1, expectedTotalCents: 2000,
};

describe('native 044 purchase creation read-only acknowledgement', () => {
  beforeEach(() => native.mockReset());

  it('identifies deterministic pre-writer validation failure without claiming a native receipt', async () => {
    const duplicate = {
      ...purchase,
      cart: [purchase.cart[0], { ...purchase.cart[0], quantity: 3 }],
    };
    expect(await createPurchaseInvoiceAction(duplicate)).toMatchObject({
      success: false,
      native_write_not_attempted: true,
      error: expect.stringContaining('سطر شراء مكرر'),
    });
    expect(native).not.toHaveBeenCalled();
  });

  it('never marks an attempted but rejected native write as safe to abandon', async () => {
    native.mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('native writer state unknown'))
      .mockResolvedValueOnce(null);
    expect(await createPurchaseInvoiceAction(purchase)).toEqual({
      success: false,
      error: 'native writer state unknown',
    });
    expect(native.mock.calls.filter(([command]) => command === 'save_purchase_invoice_critical'))
      .toHaveLength(1);
  });

  it('confirms a lost committed write with exactly one mutation and no nonce rotation', async () => {
    native
      .mockResolvedValueOnce(null) // read before writing
      .mockRejectedValueOnce(new Error('IPC reply lost'))
      .mockResolvedValueOnce(proof); // read after write ambiguity
    expect(await createPurchaseInvoiceAction(purchase)).toMatchObject({
      success: true, id: proof.invoiceId,
    });
    expect(native).toHaveBeenCalledTimes(3);
    expect(native).toHaveBeenNthCalledWith(1,'confirm_purchase_creation_native',{ payload:expected });
    expect(native).toHaveBeenNthCalledWith(2,'save_purchase_invoice_critical',
      expect.objectContaining({ requestId:NONCE, expectedExistingStatus:null }));
    expect(native).toHaveBeenNthCalledWith(3,'confirm_purchase_creation_native',{ payload:expected });
  });

  it('resolves a persisted nonce on reload before invoking the unique writer', async () => {
    native.mockResolvedValueOnce(proof);
    expect(await createPurchaseInvoiceAction(purchase)).toMatchObject({
      success: true, id: proof.invoiceId,
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith('confirm_purchase_creation_native',{ payload:expected });
  });

  it.each([
    ['missing', null],
    ['wrong actor-issued source nonce', { ...proof,requestId:'12345678-abcd-4abc-8abc-123456789abd' }],
    ['wrong invoice', { ...proof,invoiceId:'' }],
    ['wrong supplier', { ...proof,supplierId:8 }],
    ['wrong status', { ...proof,status:'draft' }],
    ['wrong original cents', { ...proof,totalCents:1900 }],
    ['wrong count', { ...proof,lineCount:2 }],
  ])('never reports success for %s acknowledgement', async (_label, denied) => {
    native.mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('create rejected'))
      .mockResolvedValueOnce(denied);
    expect(await createPurchaseInvoiceAction(purchase)).toMatchObject({
      success:false,error:'create rejected',
    });
    expect(native).toHaveBeenCalledTimes(3);
    expect(native.mock.calls.filter(([name])=>name==='save_purchase_invoice_critical')).toHaveLength(1);
  });

  it('fails closed when both preflight and post-error reads fail', async () => {
    native.mockRejectedValueOnce(new Error('read failed'))
      .mockRejectedValueOnce(new Error('write failed'))
      .mockRejectedValueOnce(new Error('read failed'));
    expect(await createPurchaseInvoiceAction(purchase)).toMatchObject({
      success:false,error:'write failed',
    });
    expect(native.mock.calls.filter(([name])=>name==='save_purchase_invoice_critical')).toHaveLength(1);
  });

  it('recovers a nonempty native draft only with its original complete typed request', async () => {
    const draft = { ...purchase, status: 'draft', notes: 'original supplier draft' };
    const draftProof = { ...proof, status: 'draft', totalCents: 0 };
    native.mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('ambiguous native draft commit'))
      .mockResolvedValueOnce(draftProof);
    expect(await createPurchaseInvoiceAction(draft)).toMatchObject({
      success: true, id: draftProof.invoiceId,
    });
    expect(native).toHaveBeenCalledTimes(3);
    const originalSave = native.mock.calls[1][1];
    const preflight = native.mock.calls[0][1].payload;
    const recovery = native.mock.calls[2][1].payload;
    expect(preflight).toMatchObject({
      requestId: NONCE, expectedStatus: 'draft', expectedLineCount: 1,
      expectedTotalCents: 0,
      expectedDraftPayload: { status: 'draft', notes: 'original supplier draft',
        supplier_id: 7, cart: [{ id: 9, quantity: 2, cost_price: 10 }] },
    });
    expect(recovery.expectedDraftPayload).toEqual(originalSave.payload);
    expect(preflight.expectedDraftPayload).toEqual(originalSave.payload);
  });

  it('does not rotate a nonempty draft nonce when the native witness rejects recovery', async () => {
    native.mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('native receipt not verifiable'))
      .mockResolvedValueOnce(null);
    expect(await createPurchaseInvoiceAction({ ...purchase, status: 'draft' })).toMatchObject({
      success: false, error: 'native receipt not verifiable',
    });
    expect(native.mock.calls.filter(([command]) => command === 'save_purchase_invoice_critical'))
      .toHaveLength(1);
    expect(native.mock.calls[1][1].requestId).toEqual(NONCE);
  });
});
