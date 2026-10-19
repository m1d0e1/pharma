/** @jest-environment jsdom */
import React from 'react';
import { createHash } from 'crypto';
import { TextEncoder as NodeTextEncoder } from 'util';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickAddDrugModal from '@/components/master-drugs/QuickAddDrugModal';
import { addMasterDrugAction } from '@/app/actions-client/master-drugs';
import { secureCache } from '@/lib/cache/secure_cache';
import { toast } from 'react-hot-toast';
import { invoke } from '@tauri-apps/api/core';
import { dbGet, dbSelect, dbExecute } from '@/lib/db/tauri';

jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => { throw Error('Strict native: renderer SELECT denied'); }),
  dbGet: jest.fn(async () => { throw Error('Strict native: renderer SELECT denied'); }),
  dbExecute: jest.fn(async () => { throw Error('Strict native: renderer INSERT denied'); }),
  dbTransaction: jest.fn(async () => { throw Error('Strict native: renderer transaction denied'); }),
  generateId: jest.fn(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => [{ id: 3, trade_name: 'Existing public drug', large_unit: 'علبة' }]),
    getDrug: jest.fn(),
    addDrug: jest.fn(),
    updateDrug: jest.fn(),
  },
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'qa-owner', role: 'owner', pharmacy_id: 'tenant-a' })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn(async () => { throw Error('Generic SQL not permitted'); }),
  getReplacementDrug: jest.fn(),
}));
jest.mock('@/components/master-drugs/DrugReplacementDialog', () => () => null);
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/inventory/refresh', () => ({
  notifyDrugCatalogChanged: jest.fn(), notifyInventoryChanged: jest.fn(),
}));

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const textEncoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
const REQUEST_ID = '0a44884b-d928-4f4b-924b-3ba72ad2261d';
const RECOVERY_KEY = 'pharma:native-master-drug-create:v1';

beforeAll(() => {
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      randomUUID: () => REQUEST_ID,
      subtle: {
        digest: async (_algorithm: string, buffer: Uint8Array) =>
          Uint8Array.from(createHash('sha256').update(Buffer.from(buffer)).digest()).buffer,
      },
    },
  });
});
afterAll(() => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  if (textEncoderDescriptor) Object.defineProperty(globalThis, 'TextEncoder', textEncoderDescriptor);
  else Reflect.deleteProperty(globalThis, 'TextEncoder');
});
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  (invoke as jest.Mock).mockReset();
  (secureCache.load as jest.Mock).mockReset();
  (secureCache.load as jest.Mock).mockResolvedValue(undefined);
  (secureCache.getAllDrugs as jest.Mock).mockReturnValue([
    { id: 3, trade_name: 'Existing public drug', large_unit: 'علبة' },
  ]);
});

function fillQuickAdd() {
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), {
    target: { value: 'مستحضر جديد أصلي' },
  });
  fireEvent.change(screen.getByPlaceholderText('Trade Name (EN)'), {
    target: { value: 'New Original Medicine' },
  });
  fireEvent.change(screen.getByPlaceholderText('اختر أو اكتب الوحدة'), {
    target: { value: 'علبة' },
  });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '12.50' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '10' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), {
    target: { value: 'CREATED-ONLY-2026' },
  });
}

describe('strict native QuickAddDrugModal -> action -> typed Rust command bridge', () => {
  it('creates through typed native command with exact receipt and native-only unit suggestions', async () => {
    (invoke as jest.Mock).mockResolvedValueOnce({ success: true, id: 938 });
    const onSuccess = jest.fn();
    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={onSuccess} />);
    // The HTML datalist options are deliberately hidden from the accessible
    // role tree until the native autocomplete opens.
    await waitFor(() => expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('علبة'));
    fillQuickAdd();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(
      938, 'New Original Medicine', 'علبة', 12.5, 10, 'CREATED-ONLY-2026',
    ));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('create_master_drug_native', {
      payload: expect.objectContaining({
        requestId: REQUEST_ID, tradeName: 'مستحضر جديد أصلي',
        tradeNameEn: 'New Original Medicine', largeUnit: 'علبة',
        largeToMedium: 10, officialPrice: 12.5, isMedicine: true,
        barcode: 'CREATED-ONLY-2026',
      }),
    });
    expect(secureCache.addDrug).toHaveBeenCalledWith(expect.objectContaining({ id: 938 }));
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('native ownership/RBAC rejection keeps original nonce but does not invoke raw lookup or fabricate success', async () => {
    (invoke as jest.Mock).mockRejectedValueOnce('Native catalog creation requires owner/admin can_manage_inventory');
    const onSuccess = jest.fn();
    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={onSuccess} />);
    fillQuickAdd();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('تعذر تأكيد إنشاء الصنف'),
    ));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RECOVERY_KEY)).toContain(REQUEST_ID);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects sub-cent prices locally without native or renderer database calls', async () => {
    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={jest.fn()} />);
    fillQuickAdd();
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '12.345' } });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ الصنف' }).closest('form')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('تعذر تأكيد إنشاء الصنف'),
    ));
    expect(invoke).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull();
  });

  it('does not silently truncate a noninteger user-entered pack conversion', async () => {
    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={jest.fn()} />);
    fillQuickAdd();
    fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), {
      target: { value: '2.5' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ الصنف' }).closest('form')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('تعذر تأكيد إنشاء الصنف'),
    ));
    expect(invoke).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull();
  });

  it('remains usable without suggestion cache and never falls back to generic SQL', async () => {
    (secureCache.load as jest.Mock).mockRejectedValueOnce('Native public catalog unavailable');
    (invoke as jest.Mock).mockResolvedValueOnce({ success: true, id: 939 });
    const onSuccess = jest.fn();
    render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={onSuccess} />);
    fillQuickAdd();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(
      939, 'New Original Medicine', 'علبة', 12.5, 10, 'CREATED-ONLY-2026',
    ));
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('keeps the exact nonce on replay, rejecting changed payload after an uncertain result', async () => {
    (invoke as jest.Mock).mockRejectedValueOnce(Error('Native IPC acknowledgement lost'));
    const first = await addMasterDrugAction({
      trade_name: 'Drug First', official_price: 2.5, large_to_medium: 1,
    });
    expect(first.success).toBe(false);
    const blocked = await addMasterDrugAction({
      trade_name: 'Another product', official_price: 2.5, large_to_medium: 1,
    });
    expect(blocked.success).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RECOVERY_KEY)).toContain(REQUEST_ID);
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
