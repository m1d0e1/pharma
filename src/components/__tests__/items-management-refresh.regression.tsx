import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ItemsManagementClient from '../inventory/ItemsManagementClient';
import {
  addMasterDrugAction,
  searchMasterDrugsAction,
  deleteMasterDrugAction,
  archiveMasterDrugAction,
  previewMasterDrugCatalogUpdateAction,
  applyMasterDrugCatalogUpdateAction,
} from '@/app/actions-client/master-drugs';
import { getReplacementDrug, replaceDrugAction } from '@/app/actions-client/drug-replacement';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { secureCache } from '@/lib/cache/secure_cache';
import { toast } from 'react-hot-toast';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn().mockResolvedValue([]),
  dbExecute: jest.fn().mockResolvedValue({ rowsAffected: 0 }),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'owner', pharmacy_id: 'ph-1' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  addMasterDrugAction: jest.fn(),
  deleteMasterDrugAction: jest.fn(),
  archiveMasterDrugAction: jest.fn(),
  previewMasterDrugCatalogUpdateAction: jest.fn(),
  applyMasterDrugCatalogUpdateAction: jest.fn(),
  updateMasterDrugAction: jest.fn(),
  searchMasterDrugsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/drug-replacement', () => ({ findDrugBarcodeConflict: jest.fn(), replaceDrugAction: jest.fn(), getReplacementDrug: jest.fn(async (id: number) => ({ id, trade_name: 'Concor 5mg' })) }));
jest.mock('@tauri-apps/plugin-dialog', () => ({ save: jest.fn() }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { reload: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('xlsx', () => ({
  read: jest.fn(() => ({ SheetNames: ['Drugs'], Sheets: { Drugs: { kind: 'drugs' } } })),
  write: jest.fn(() => new Uint8Array([1, 2, 3])),
  utils: {
    json_to_sheet: jest.fn(() => ({ kind: 'export-sheet' })),
    book_new: jest.fn(() => ({})),
    book_append_sheet: jest.fn(),
    sheet_to_json: jest.fn(() => [{ id: 500, trade_name: 'Imported Drug', official_price: 12 }]),
  },
}));

describe('ItemsManagementClient auto-refresh and total count regression', () => {
  const sampleItems: any[] = [
    {
      id: 1,
      trade_name: 'كونكور 5 مجم',
      trade_name_en: 'Concor 5mg',
      active_ingredient: 'Bisoprolol',
      barcode: '6221234567890',
      official_price: 35,
      manufacturer: 'Amoun',
      is_medicine: 1,
      is_service: 0,
      stop_dealing: 0,
    },
    {
      id: 2,
      trade_name: 'بنادول أزرق',
      trade_name_en: 'Panadol Blue',
      active_ingredient: 'Paracetamol',
      barcode: '6229876543210',
      official_price: 25,
      manufacturer: 'GSK',
      is_medicine: 1,
      is_service: 0,
      stop_dealing: 0,
    },
  ];

  const safeCatalogPreview: any = {
    signature: 'catalog-preview-test-signature',
    summary: {
      incomingCount: 1,
      changedDrugCount: 0,
      changedFieldCount: 0,
      protectedFieldCount: 0,
      newDrugCount: 1,
      suppressedDrugCount: 0,
      identityConflictCount: 0,
      currentOnlyCount: 2,
      unchangedCount: 0,
      inventoryRowsAffected: 0,
      historyRowsAffected: 0,
    },
    changedDrugs: [],
    newDrugs: [{
      catalogDrugId: 500,
      name: 'Imported Drug',
      suppressed: false,
      incoming: { trade_name: 'Imported Drug', official_price: 12, notes: 'Catalog protected note' },
      protectedIncomingFields: ['notes'],
    }],
    identityConflicts: [],
    matchedLinks: [],
    currentOnlySample: sampleItems.map(item => ({ masterDrugId: item.id, name: item.trade_name_en })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'user-1', role: 'owner', pharmacy_id: 'ph-1' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: sampleItems,
    });
  });

  it('contains focus in the item editor when it opens', async () => {
    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);

    fireEvent.click(await screen.findByRole('button', { name: 'إضافة صنف جديد' }));
    expect(screen.getByRole('dialog', { name: 'إضافة صنف جديد لقاعدة البيانات' })).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(screen.getByLabelText('Trade Name (English) *')).toHaveFocus());
  });

  it('keeps catalog data visible but hides mutation controls from can_view_stores-only users', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'viewer-1',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_stores: true, can_manage_inventory: false },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => key === 'can_view_stores');

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);

    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    await waitFor(() => expect(getClientSession).toHaveBeenCalled());
    expect(screen.queryByText('استيراد الكل')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إضافة صنف جديد' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('تعديل بيانات الصنف')).not.toBeInTheDocument();
    expect(screen.queryByTitle('نسخ بيانات الصنف')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    expect(screen.getByText('معلومات الصنف')).toBeInTheDocument();
    expect(screen.queryByText('تعديل بيانات الصنف')).not.toBeInTheDocument();
    expect(screen.queryByText('حذف الصنف نهائياً')).not.toBeInTheDocument();
  });

  it('keeps ordinary inventory management available but hides catalog reconciliation from non-admin staff', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'pharmacist-1',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_manage_inventory: true },
    });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);

    expect(await screen.findByRole('button', { name: 'إضافة صنف جديد' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('اختيار ملف تحديث دليل الأدوية للمراجعة')).not.toBeInTheDocument());
  });

  it('offers safe archive for the legacy deletion error, preserves cancellation, then archives with explicit confirmation', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    (deleteMasterDrugAction as jest.Mock).mockResolvedValue({success:false,error:'Drugs with inventory, transaction, or clinical history cannot be deleted'});
    (archiveMasterDrugAction as jest.Mock).mockResolvedValue({success:true});
    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    fireEvent.click(screen.getByText('حذف الصنف نهائياً'));
    const save = await screen.findByRole('button', { name:'تأكيد الحذف الآمن (أرشفة)' });
    expect(save).toBeDisabled();
    expect(archiveMasterDrugAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('أوافق على إيقاف الصنف مع حفظ المخزون والسجل، وليس مسح الحركات.'));
    fireEvent.click(save);
    await waitFor(() => expect(archiveMasterDrugAction).toHaveBeenCalledWith(1,true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Concor 5mg').closest('tr')).toHaveClass('opacity-75');
  });

  it('offers a linked-record replacement when deleting a used drug, without deleting on cancellation', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    (deleteMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, code: 'DRUG_IN_USE', error: 'linked history' });
    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    fireEvent.click(screen.getByRole('button', { name: /حذف الصنف نهائياً/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Concor 5mg');
    expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /إلغاء — بدون تغيير/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    expect(replaceDrugAction).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not let an older replacement refresh overwrite a newer catalog search', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const candidate = { ...sampleItems[1], id: 20, trade_name_en: 'Replacement Candidate', barcode: 'ABC' };
    let resolveReplacementRefresh: (value: any) => void = () => {};
    (deleteMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, code: 'DRUG_IN_USE', error: 'linked history' });
    (replaceDrugAction as jest.Mock).mockResolvedValue({ success: true, id: 20, backupPath: 'backups/replaced.db' });
    (getReplacementDrug as jest.Mock).mockImplementation(async (id: number) => Number(id) === 1 ? sampleItems[0] : candidate);
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query }: { query?: string }) => {
      if (query === 'Candidate') return Promise.resolve({ success: true, data: [candidate] });
      if (query === 'Newest Filter') {
        return Promise.resolve({
          success: true,
          data: [{ ...sampleItems[0], id: 304, trade_name_en: 'Newest After Replacement' }],
          total: 1,
          page: 1,
          pageSize: 100,
        });
      }
      if (!query) return new Promise(resolve => { resolveReplacementRefresh = resolve; });
      return Promise.resolve({ success: true, data: [] });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    fireEvent.click(screen.getByRole('button', { name: /حذف الصنف نهائياً/ }));

    const replacementSearch = await screen.findByLabelText('ابحث عن الصنف البديل');
    fireEvent.change(replacementSearch, { target: { value: 'Candidate' } });
    fireEvent.click(await screen.findByText(/Replacement Candidate/));
    await screen.findByLabelText('البيانات النهائية: الاسم التجاري');
    fireEvent.click(screen.getByRole('checkbox', { name: /أؤكد أنه نفس الدواء/ }));
    fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' }));

    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({ query: '' })));
    const listSearch = screen.getByPlaceholderText(/Search by English Trade Name/i);
    fireEvent.change(listSearch, { target: { value: 'Newest Filter' } });
    expect(await screen.findByText('Newest After Replacement')).toBeInTheDocument();

    await act(async () => resolveReplacementRefresh({
      success: true,
      data: [{ ...sampleItems[1], id: 404, trade_name_en: 'Stale Replacement Refresh' }],
    }));

    expect(screen.queryByText('Stale Replacement Refresh')).not.toBeInTheDocument();
    expect(screen.getByText('Newest After Replacement')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('warns when replacement commits but the catalog refresh action returns a failure result', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const toastError = jest.spyOn(toast, 'error');
    const candidate = { ...sampleItems[1], id: 20, trade_name_en: 'Replacement Candidate', barcode: 'ABC' };
    let replacementCommitted = false;
    (deleteMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, code: 'DRUG_IN_USE', error: 'linked history' });
    (replaceDrugAction as jest.Mock).mockImplementation(async () => {
      replacementCommitted = true;
      return { success: true, id: 20, backupPath: 'backups/replaced.db' };
    });
    (getReplacementDrug as jest.Mock).mockImplementation(async (id: number) => Number(id) === 1 ? sampleItems[0] : candidate);
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query }: { query?: string }) => {
      if (query === 'Candidate') return Promise.resolve({ success: true, data: [candidate] });
      if (!query && replacementCommitted) return Promise.resolve({ success: false, error: 'refresh failed' });
      return Promise.resolve({ success: true, data: sampleItems });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    fireEvent.click(screen.getByRole('button', { name: /حذف الصنف نهائياً/ }));

    const replacementSearch = await screen.findByLabelText('ابحث عن الصنف البديل');
    fireEvent.change(replacementSearch, { target: { value: 'Candidate' } });
    fireEvent.click(await screen.findByText(/Replacement Candidate/));
    await screen.findByLabelText('البيانات النهائية: الاسم التجاري');
    fireEvent.click(screen.getByRole('checkbox', { name: /أؤكد أنه نفس الدواء/ }));
    fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' }));

    await waitFor(() => expect(replaceDrugAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('تم الاستبدال لكن تعذر تحديث القائمة'));
    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    confirm.mockRestore();
    toastError.mockRestore();
  });

  it('preserves initialItems on initial render and after debounce without wiping to 0', async () => {
    jest.useFakeTimers();

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);

    // Initial items are visible
    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    await waitFor(() => expect(hasUserPermissionSync).toHaveBeenCalledWith(
      expect.anything(),
      'can_manage_inventory',
    ));

    // Fast-forward past debounce timer (400ms)
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Verify items are STILL visible and not wiped to 0
    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();

    // searchMasterDrugsAction was NOT called on clean initial load (initialItems preserved)
    expect(searchMasterDrugsAction).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('filters items when search term is entered and restores initialItems when cleared', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [sampleItems[0]], // Only Concor matches
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);

    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);

    // Type search
    fireEvent.change(searchInput, { target: { value: 'Concor' } });

    await waitFor(() => {
      expect(searchMasterDrugsAction).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Concor' })
      );
    });

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } });

    // Initial items should be restored immediately without showing 0
    await waitFor(() => {
      expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
      expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    });
  });

  it('does not let an older filtered search overwrite the initial catalog after the search is cleared', async () => {
    let resolveSearch: (value: any) => void = () => {};
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query }: { query?: string }) => {
      if (query === 'Concor') {
        return new Promise(resolve => { resolveSearch = resolve; });
      }
      return Promise.resolve({ success: true, data: sampleItems });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);
    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);

    fireEvent.change(searchInput, { target: { value: 'Concor' } });
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Concor', page: 1, pageSize: 100 })
    ));

    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
      expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
    });

    await act(async () => {
      resolveSearch({
        success: true,
        data: [{ ...sampleItems[0], id: 99, trade_name_en: 'Stale Filtered Drug' }],
        total: 1,
        page: 1,
        pageSize: 100,
      });
    });

    expect(screen.queryByText('Stale Filtered Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
  });

  it('keeps the last valid catalog rows visible when a later filtered search throws', async () => {
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query }: { query?: string }) => {
      if (query === 'Concor') {
        return Promise.resolve({
          success: true,
          data: [{ ...sampleItems[0], id: 91, trade_name_en: 'Stable Search Result' }],
          total: 1,
          page: 1,
          pageSize: 100,
        });
      }
      if (query === 'Broken') {
        return Promise.reject(new Error('catalog bridge unavailable'));
      }
      return Promise.resolve({ success: true, data: sampleItems });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);
    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);
    fireEvent.change(searchInput, { target: { value: 'Concor' } });
    expect(await screen.findByText('Stable Search Result')).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'Broken' } });
    expect(await screen.findByText('فشل البحث في كتالوج الأدوية')).toBeInTheDocument();
    expect(screen.getByText('Stable Search Result')).toBeInTheDocument();
  });

  it('re-reads the full drug card before editing a lightweight search result', async () => {
    const lightweight = { ...sampleItems[0], min_limit: undefined, max_limit: undefined, reorder_point: undefined, default_purchase_qty: undefined };
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [lightweight] });
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => (
      sql.includes('SELECT * FROM master_drugs')
        ? [{ ...lightweight, min_limit: 3, reorder_point: 6, max_limit: 20, default_purchase_qty: 9 }]
        : []
    ));

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);
    fireEvent.change(searchInput, { target: { value: 'Concor' } });
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalled());

    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    const editButtons = screen.getAllByRole('button', { name: 'تعديل بيانات الصنف' });
    fireEvent.click(editButtons[editButtons.length - 1]);
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith('SELECT * FROM master_drugs WHERE id = ?', [1]));
    await waitFor(() => expect((dbSelect as jest.Mock).mock.calls.some(([sql]) =>
      String(sql).includes('FROM purchase_invoice_items pii')
    )).toBe(true));
    const purchaseHistoryCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('FROM purchase_invoice_items pii')
    );
    expect(String(purchaseHistoryCall![0])).toContain('pi.pharmacy_id = ?');
    expect(purchaseHistoryCall![1]).toEqual([1, 'ph-1', 'ph-1']);

    fireEvent.click(screen.getByRole('button', { name: 'خيارات متقدمة' }));
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    expect(screen.getByDisplayValue('6')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'الوحدات والأسعار' }));
     expect(screen.getByDisplayValue('9')).toBeInTheDocument();
  });

  it('keeps the newest row selected when an older full-drug edit read resolves afterwards', async () => {
    let resolveOlderDrug: (value: any[]) => void = () => {};
    (dbSelect as jest.Mock).mockImplementation((sql: string, params?: any[]) => {
      if (sql === 'SELECT * FROM master_drugs WHERE id = ?' && Number(params?.[0]) === 1) {
        return new Promise<any[]>(resolve => { resolveOlderDrug = resolve; });
      }
      if (sql === 'SELECT * FROM master_drugs WHERE id = ?' && Number(params?.[0]) === 2) {
        return Promise.resolve([{ ...sampleItems[1], trade_name_en: 'Newest Edit Drug' }]);
      }
      return Promise.resolve([]);
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });

    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    let editButtons = screen.getAllByRole('button', { name: 'تعديل بيانات الصنف' });
    fireEvent.click(editButtons[editButtons.length - 1]);

    fireEvent.contextMenu(screen.getByText('Panadol Blue').closest('tr')!);
    editButtons = screen.getAllByRole('button', { name: 'تعديل بيانات الصنف' });
    fireEvent.click(editButtons[editButtons.length - 1]);

    expect(await screen.findByDisplayValue('Newest Edit Drug')).toBeInTheDocument();

    await act(async () => resolveOlderDrug([{ ...sampleItems[0], trade_name_en: 'Stale Edit Drug' }]));

    expect(screen.queryByDisplayValue('Stale Edit Drug')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Newest Edit Drug')).toBeInTheDocument();
  });

  it('keeps the newest row purchase history when an older history request resolves afterwards', async () => {
    let resolveOlderHistory: (value: any[]) => void = () => {};
    (dbSelect as jest.Mock).mockImplementation((sql: string, params?: any[]) => {
      if (sql === 'SELECT * FROM master_drugs WHERE id = ?') {
        const id = Number(params?.[0]);
        return Promise.resolve([{ ...sampleItems[id - 1], trade_name_en: id === 1 ? 'First Edit Drug' : 'Second Edit Drug' }]);
      }
      if (sql.includes('FROM purchase_invoice_items pii')) {
        const id = Number(params?.[0]);
        if (id === 1) {
          return new Promise<any[]>(resolve => { resolveOlderHistory = resolve; });
        }
        return Promise.resolve([{ invoice_date: '2026-09-02', invoice_number: 'P2', quantity: 2, cost_price: 22, supplier_name: 'Newest Supplier' }]);
      }
      return Promise.resolve([]);
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });

    fireEvent.contextMenu(screen.getByText('Concor 5mg').closest('tr')!);
    let editButtons = screen.getAllByRole('button', { name: 'تعديل بيانات الصنف' });
    fireEvent.click(editButtons[editButtons.length - 1]);
    expect(await screen.findByDisplayValue('First Edit Drug')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تعديل Panadol Blue' }));
    expect(await screen.findByDisplayValue('Second Edit Drug')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /البيانات المالية/ }));
    expect(await screen.findByText('Newest Supplier')).toBeInTheDocument();

    await act(async () => resolveOlderHistory([{ invoice_date: '2026-09-01', invoice_number: 'P1', quantity: 1, cost_price: 11, supplier_name: 'Stale Supplier' }]));

    expect(screen.queryByText('Stale Supplier')).not.toBeInTheDocument();
    expect(screen.getByText('Newest Supplier')).toBeInTheDocument();
  });

  it('loads the next unfiltered catalog page instead of leaving rows beyond the first 100 unreachable', async () => {
    const pageTwoItem = {
      ...sampleItems[0],
      id: 101,
      trade_name: 'الصفحة الثانية',
      trade_name_en: 'Page Two Drug',
    };
    (dbSelect as jest.Mock).mockResolvedValueOnce([pageTwoItem]);

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={101} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));

    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?'),
      [100, 100],
    ));
    expect(await screen.findByText('Page Two Drug')).toBeInTheDocument();
    expect(screen.getByText('صفحة 2 من 2')).toBeInTheDocument();
  });

  it('paginates filtered catalog results using the action total instead of truncating at the first 100 matches', async () => {
    (searchMasterDrugsAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...sampleItems[0], id: 101, trade_name_en: 'Paged Filter 001' }],
        total: 205,
        page: 1,
        pageSize: 100,
        pages: 3,
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...sampleItems[0], id: 201, trade_name_en: 'Paged Filter 101' }],
        total: 205,
        page: 2,
        pageSize: 100,
        pages: 3,
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...sampleItems[1], id: 301, trade_name_en: 'Reset Filter Result' }],
        total: 1,
        page: 1,
        pageSize: 100,
        pages: 1,
      });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={500} />);
    fireEvent.change(screen.getByPlaceholderText(/Search by English Trade Name/i), { target: { value: 'Paged Filter' } });

    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Paged Filter',
      page: 1,
      pageSize: 100,
    })));
    expect(await screen.findByText('Paged Filter 001')).toBeInTheDocument();
    expect(screen.getByText('صفحة 1 من 3')).toBeInTheDocument();
    expect(screen.getByText('205')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Paged Filter',
      page: 2,
      pageSize: 100,
    })));
    expect(await screen.findByText('Paged Filter 101')).toBeInTheDocument();
    expect(screen.getByText('صفحة 2 من 3')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search by English Trade Name/i), { target: { value: 'Reset Filter' } });
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Reset Filter',
      page: 1,
      pageSize: 100,
    })));
    expect(await screen.findByText('Reset Filter Result')).toBeInTheDocument();
    expect(screen.queryByText('Paged Filter 101')).not.toBeInTheDocument();
    expect(screen.queryByText('صفحة 2 من 3')).not.toBeInTheDocument();
  });

  it('does not let an older filtered page request overwrite a newer search', async () => {
    let resolveOlderPage: (value: any) => void = () => {};
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query, page }: { query?: string; page?: number }) => {
      if (query === 'Paged Filter' && page === 1) {
        return Promise.resolve({
          success: true,
          data: [{ ...sampleItems[0], id: 101, trade_name_en: 'Paged Filter 001' }],
          total: 205,
          page: 1,
          pageSize: 100,
        });
      }
      if (query === 'Paged Filter' && page === 2) {
        return new Promise(resolve => { resolveOlderPage = resolve; });
      }
      if (query === 'Newest Filter' && page === 1) {
        return Promise.resolve({
          success: true,
          data: [{ ...sampleItems[1], id: 301, trade_name_en: 'Newest Filter Drug' }],
          total: 1,
          page: 1,
          pageSize: 100,
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={500} />);
    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);
    fireEvent.change(searchInput, { target: { value: 'Paged Filter' } });
    expect(await screen.findByText('Paged Filter 001')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Paged Filter',
      page: 2,
    })));

    fireEvent.change(searchInput, { target: { value: 'Newest Filter' } });
    expect(await screen.findByText('Newest Filter Drug')).toBeInTheDocument();

    await act(async () => {
      resolveOlderPage({
        success: true,
        data: [{ ...sampleItems[0], id: 401, trade_name_en: 'Stale Page Drug' }],
        total: 205,
        page: 2,
        pageSize: 100,
      });
    });

    expect(screen.queryByText('Stale Page Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Newest Filter Drug')).toBeInTheDocument();
  });

  it('keeps the current filtered page visible when loading the next page throws', async () => {
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query, page }: { query?: string; page?: number }) => {
      if (query === 'Paged Failure' && page === 1) {
        return Promise.resolve({
          success: true,
          data: [{ ...sampleItems[0], id: 111, trade_name_en: 'Stable Page Result' }],
          total: 205,
          page: 1,
          pageSize: 100,
        });
      }
      if (query === 'Paged Failure' && page === 2) {
        return Promise.reject(new Error('catalog page unavailable'));
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={500} />);
    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);
    fireEvent.change(searchInput, { target: { value: 'Paged Failure' } });
    expect(await screen.findByText('Stable Page Result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));

    expect(await screen.findByText('فشل تحميل صفحة الأصناف')).toBeInTheDocument();
    expect(screen.getByText('Stable Page Result')).toBeInTheDocument();
    expect(screen.getByText('صفحة 1 من 3')).toBeInTheDocument();
  });

  it('exports the complete master-drug catalog through the rendered Excel action and Tauri write bridge', async () => {
    (dbSelect as jest.Mock).mockResolvedValueOnce(sampleItems);
    (save as jest.Mock).mockResolvedValue('C:\\tmp\\master_drugs_export.xlsx');
    (invoke as jest.Mock).mockResolvedValue(undefined);

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'تصدير الكل' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: 'master_drugs_export.xlsx',
    })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('write_binary_file', expect.objectContaining({
      path: 'C:\\tmp\\master_drugs_export.xlsx',
      data: [1, 2, 3],
    })));
  });

  it('previews the rendered master-drug workbook without writing or refreshing cache', async () => {
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((event: any) => void) | null = null;
      readAsBinaryString() {
        this.onload?.({ target: { result: 'mock-master-workbook' } });
      }
    }
    Object.defineProperty(global, 'FileReader', { configurable: true, value: MockFileReader });
    (previewMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({ success: true, data: safeCatalogPreview });

    const view = render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeInTheDocument();

    fireEvent.change(fileInput, {
      target: { files: [new File(['xlsx'], 'master.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] },
    });

    await waitFor(() => expect(previewMasterDrugCatalogUpdateAction).toHaveBeenCalledWith([
      { id: 500, trade_name: 'Imported Drug', official_price: 12 },
    ]));
    expect(await screen.findByRole('heading', { name: 'مراجعة تحديث دليل الأدوية' })).toBeInTheDocument();
    expect(screen.getAllByText('Imported Drug').length).toBeGreaterThan(0);
    expect(screen.getByText(/المخزون المتأثر: 0/)).toBeInTheDocument();
    expect(screen.getByText(/السجل التاريخي المتأثر: 0/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('عرض كل الحقول التي ستُستخدم أو تُتجاهل قبل الإضافة'));
    expect(screen.getByText('Catalog protected note')).toBeInTheDocument();
    expect(screen.getByText('محمي محلياً — لن يُنسخ من الدليل')).toBeInTheDocument();
    expect(applyMasterDrugCatalogUpdateAction).not.toHaveBeenCalled();
    expect(secureCache.reload).not.toHaveBeenCalled();
    Object.defineProperty(global, 'FileReader', { configurable: true, value: originalFileReader });
  });

  it('applies only after explicit review, new-drug choice and backup password, then refreshes visible results', async () => {
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((event: any) => void) | null = null;
      readAsBinaryString() {
        this.onload?.({ target: { result: 'mock-master-workbook' } });
      }
    }
    Object.defineProperty(global, 'FileReader', { configurable: true, value: MockFileReader });
    (previewMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({ success: true, data: safeCatalogPreview });
    (applyMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { updatedDrugs: 0, updatedFields: 0, addedDrugs: 1, inventoryRowsAffected: 0, historyRowsAffected: 0 },
    });
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ ...sampleItems[0], id: 500, trade_name_en: 'Imported Drug' }],
    });

    const view = render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['xlsx'], 'master.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] },
    });
    await screen.findByRole('heading', { name: 'مراجعة تحديث دليل الأدوية' });

    const addNewDrug = screen.getByRole('checkbox', { name: /Imported Drug.*إضافة/ });
    expect(addNewDrug).not.toBeChecked();
    fireEvent.click(addNewDrug);
    expect(addNewDrug).toBeChecked();

    const applyButton = screen.getByRole('button', { name: 'إنشاء نسخة احتياطية ثم تطبيق القرارات' });
    expect(applyButton).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('كلمة مرور المالك أو المدير'), { target: { value: 'verified-password' } });
    expect(applyButton).toBeEnabled();
    fireEvent.click(applyButton);

    await waitFor(() => expect(applyMasterDrugCatalogUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      rows: [{ id: 500, trade_name: 'Imported Drug', official_price: 12 }],
      previewSignature: 'catalog-preview-test-signature',
      newDrugDecisions: [{ catalogDrugId: 500, action: 'add' }],
      adminPassword: 'verified-password',
    })));
    expect(secureCache.reload).not.toHaveBeenCalled();
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith({ query: '', searchByActiveIngredient: false }));
    expect(await screen.findByText('Imported Drug')).toBeInTheDocument();
    Object.defineProperty(global, 'FileReader', { configurable: true, value: originalFileReader });
  });

  it('shows a prior catalog policy only as context and still submits keep-local until the user explicitly changes it', async () => {
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((event: any) => void) | null = null;
      readAsBinaryString() {
        this.onload?.({ target: { result: 'mock-master-workbook' } });
      }
    }
    Object.defineProperty(global, 'FileReader', { configurable: true, value: MockFileReader });
    const rememberedPolicyPreview = {
      ...safeCatalogPreview,
      signature: 'remembered-policy-signature',
      summary: {
        ...safeCatalogPreview.summary,
        changedDrugCount: 1,
        changedFieldCount: 1,
        newDrugCount: 0,
      },
      changedDrugs: [{
        catalogDrugId: 1,
        masterDrugId: 1,
        name: 'Concor 5mg',
        matchMethod: 'same_id_name',
        changes: [{
          field: 'official_price',
          label: 'السعر الرسمي',
          currentValue: 35,
          incomingValue: 40,
          policy: 'catalog',
          defaultDecision: 'keep_local',
        }],
        protectedChanges: [],
      }],
      newDrugs: [],
    };
    (previewMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({ success: true, data: rememberedPolicyPreview });
    (applyMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { updatedDrugs: 0, updatedFields: 0, addedDrugs: 0, inventoryRowsAffected: 0, historyRowsAffected: 0 },
    });

    const view = render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['xlsx'], 'master.xlsx')] },
    });
    await screen.findByRole('heading', { name: 'مراجعة تحديث دليل الأدوية' });
    const changedDrugSummary = screen.getAllByText(/Concor 5mg/).find(element => element.tagName === 'SUMMARY');
    expect(changedDrugSummary).toBeDefined();
    fireEvent.click(changedDrugSummary!);
    expect(screen.getByText('الاختيار السابق: استخدام الدليل')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('كلمة مرور المالك أو المدير'), { target: { value: 'verified-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء نسخة احتياطية ثم تطبيق القرارات' }));

    await waitFor(() => expect(applyMasterDrugCatalogUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      previewSignature: 'remembered-policy-signature',
      fieldDecisions: [expect.objectContaining({
        catalogDrugId: 1,
        masterDrugId: 1,
        field: 'official_price',
        action: 'keep_local',
        expectedCurrentValue: 35,
        expectedIncomingValue: 40,
      })],
    })));
    Object.defineProperty(global, 'FileReader', { configurable: true, value: originalFileReader });
  });

  it('bulk use-catalog requires an explicit click and is reflected in the reviewed field decisions', async () => {
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((event: any) => void) | null = null;
      readAsBinaryString() {
        this.onload?.({ target: { result: 'mock-master-workbook' } });
      }
    }
    Object.defineProperty(global, 'FileReader', { configurable: true, value: MockFileReader });
    const changedPreview = {
      ...safeCatalogPreview,
      signature: 'bulk-catalog-signature',
      summary: { ...safeCatalogPreview.summary, changedDrugCount: 1, changedFieldCount: 1, newDrugCount: 0 },
      changedDrugs: [{
        catalogDrugId: 1,
        masterDrugId: 1,
        name: 'Concor 5mg',
        matchMethod: 'same_id_name',
        changes: [{
          field: 'manufacturer',
          label: 'الشركة المصنعة',
          currentValue: 'LOCAL',
          incomingValue: 'CATALOG',
          policy: null,
          defaultDecision: 'keep_local',
        }],
        protectedChanges: [],
      }],
      newDrugs: [],
    };
    (previewMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({ success: true, data: changedPreview });
    (applyMasterDrugCatalogUpdateAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { updatedDrugs: 1, updatedFields: 1, addedDrugs: 0, inventoryRowsAffected: 0, historyRowsAffected: 0 },
    });

    const view = render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    await screen.findByRole('button', { name: 'إضافة صنف جديد' });
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['xlsx'], 'master.xlsx')] },
    });
    await screen.findByRole('heading', { name: 'مراجعة تحديث دليل الأدوية' });
    fireEvent.click(screen.getByRole('button', { name: 'استخدام الدليل لكل الحقول القابلة للمراجعة' }));
    fireEvent.change(screen.getByPlaceholderText('كلمة مرور المالك أو المدير'), { target: { value: 'verified-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء نسخة احتياطية ثم تطبيق القرارات' }));

    await waitFor(() => expect(applyMasterDrugCatalogUpdateAction).toHaveBeenCalledWith(expect.objectContaining({
      fieldDecisions: [expect.objectContaining({ field: 'manufacturer', action: 'use_catalog' })],
    })));
    Object.defineProperty(global, 'FileReader', { configurable: true, value: originalFileReader });
  });

  it('blocks repeated master-drug saves while the first write is pending', async () => {
    let resolveSave: (value: { success: boolean; error?: string; id?: number }) => void = () => {};
    (addMasterDrugAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveSave = resolve; }));
    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'إضافة صنف جديد' }));

    const englishName = screen.getByText('Trade Name (English) *').parentElement?.querySelector('input') as HTMLInputElement;
    fireEvent.change(englishName, { target: { value: 'Pending Save Drug' } });
    const saveButton = screen.getByRole('button', { name: /حفظ البيانات/ });

    act(() => {
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);
    });

    expect(addMasterDrugAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave({ success: false, error: 'save rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ البيانات/ })).toBeEnabled());
  });

  it('does not let an older post-save refresh overwrite a newer catalog search', async () => {
    let resolveSaveRefresh: (value: any) => void = () => {};
    (addMasterDrugAction as jest.Mock).mockResolvedValue({ success: true, id: 77 });
    (searchMasterDrugsAction as jest.Mock).mockImplementation(({ query }: { query?: string }) => {
      if (!query) {
        return new Promise(resolve => { resolveSaveRefresh = resolve; });
      }
      if (query === 'Newest Filter') {
        return Promise.resolve({
          success: true,
          data: [{ ...sampleItems[1], id: 302, trade_name_en: 'Newest After Save' }],
          total: 1,
          page: 1,
          pageSize: 100,
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'إضافة صنف جديد' }));
    const englishName = screen.getByText('Trade Name (English) *').parentElement?.querySelector('input') as HTMLInputElement;
    fireEvent.change(englishName, { target: { value: 'Saved Drug' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ البيانات/ }));

    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({ query: '' })));
    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);
    fireEvent.change(searchInput, { target: { value: 'Newest Filter' } });
    expect(await screen.findByText('Newest After Save')).toBeInTheDocument();

    await act(async () => {
      resolveSaveRefresh({
        success: true,
        data: [{ ...sampleItems[0], id: 402, trade_name_en: 'Stale Post-Save Drug' }],
      });
    });

    expect(screen.queryByText('Stale Post-Save Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Newest After Save')).toBeInTheDocument();
  });

  it('preserves the master-drug editor and restores save controls when persistence throws', async () => {
    (addMasterDrugAction as jest.Mock).mockRejectedValueOnce(new Error('catalog bridge unavailable'));
    render(<ItemsManagementClient initialItems={sampleItems} totalCount={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'إضافة صنف جديد' }));

    const englishName = screen.getByText('Trade Name (English) *').parentElement?.querySelector('input') as HTMLInputElement;
    fireEvent.change(englishName, { target: { value: 'Preserved Catalog Drug' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ البيانات/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ البيانات/ })).toBeEnabled());
    expect(screen.getByDisplayValue('Preserved Catalog Drug')).toBeInTheDocument();
    expect(screen.getByText('إضافة صنف جديد لقاعدة البيانات')).toBeInTheDocument();
  });
});
