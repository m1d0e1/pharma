import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { useHotkeys } from 'react-hotkeys-hook';
import { barcodeLookupAction, processCheckoutAction, searchDrugsAction } from '@/app/actions-client/sales';
import { searchPatientsAction } from '@/app/actions-client/patients';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { addToShortagesAction } from '@/app/actions-client/shortages';
import { usePOSStore } from '@/store/usePOSStore';
import { getClientSession } from '@/lib/auth/local';
import { getCurrentUserAction } from '@/app/actions-client/auth';
import { fetchDraftsAction } from '@/app/actions-client/sales';
import { toast } from 'react-hot-toast';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'pharmacist' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({
    success: true,
    user: { id: 'user-1', pharmacy_id: 'pharmacy-1', full_name: 'Test Pharmacist' },
  }),
}));
jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn(),
  searchPatientsAction: jest.fn(),
  barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  processCheckoutAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  searchPatientsAction: jest.fn(),
  getPatientProfileAction: jest.fn(),
}));
jest.mock('@/app/actions-client/interactions', () => ({ checkDrugInteractions: jest.fn() }));
jest.mock('@/app/actions-client/shortages', () => ({ addToShortagesAction: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/finance', () => ({ generateDailySnapshotAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => function MockDrugDetailsModal({ drugId }: any) {
  return <div data-testid="drug-details-modal">drug:{drugId}</div>;
});
jest.mock('@/components/returns/ReturnsClient', () => () => null);
jest.mock('@/components/pos/DraftsModal', () => function MockDraftsModal({ isOpen, drafts, onLoadDraft }: any) {
  if (!isOpen || !drafts?.length) return null;
  return <button onClick={() => onLoadDraft(drafts[0])}>LOAD TEST DRAFT</button>;
});
jest.mock('@/components/pos/StockWarningModal', () => () => null);
jest.mock('@/components/pos/PosDrawerHandoverModal', () => () => null);
jest.mock('@/components/pos/DrugInteractionModal', () => () => null);
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  Toaster: () => null,
  toast: Object.assign(jest.fn(), {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  }),
}));

const cartItem = {
  id: 'line-1',
  drug_id: 'drug-1',
  trade_name: 'دواء اختبار',
  trade_name_en: 'Test Drug',
  active_ingredient: 'Ingredient A',
  qty: 1,
  price: 25,
  itemDiscountPercent: 0,
  basePrice: 25,
  selectedUnit: 'large',
  units: { large: 'علبة', large_to_medium: 1, medium_to_small: 1 },
  total_stock: 3,
  needsRefill: false,
  batches: [],
  inventory_id: null,
};

function lastHotkeyHandler(key: string) {
  const calls = (useHotkeys as jest.Mock).mock.calls.filter(args => args[0] === key);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as (event: { preventDefault: jest.Mock }) => void;
}

describe('coverage-gap: POS keyboard shortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockReset();
    usePOSStore.getState().resetPOS();
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true,
      data: { interactions: [], allergies: [] },
    });
    (processCheckoutAction as jest.Mock).mockResolvedValue({ success: true, data: { sale_id: 'sale-hotkey' } });
    (addToShortagesAction as jest.Mock).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    act(() => usePOSStore.getState().resetPOS());
  });

  it('Insert focuses and selects the actual POS search field', async () => {
    render(<POSPage />);
    const search = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    const selectSpy = jest.spyOn(search as HTMLInputElement, 'select');
    const preventDefault = jest.fn();

    lastHotkeyHandler('insert')({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(search).toHaveFocus();
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not fall through to the first text result when an entered barcode is ambiguous', async () => {
    (barcodeLookupAction as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: 'الباركود مرتبط بأكثر من صنف؛ يرجى تصحيحه من إدارة الأصناف',
    });
    (searchDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'drug-ambiguous',
        trade_name: 'Ambiguous Drug',
        trade_name_en: 'Ambiguous Drug',
        active_ingredient: 'X',
        total_stock: 2,
        min_price: 10,
        units: { large: 'علبة', large_to_medium: 1, medium_to_small: 1 },
        batches: [],
      }],
    });

    render(<POSPage />);
    const search = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    fireEvent.change(search, { target: { value: 'DUP-BARCODE' } });
    await waitFor(() => expect(searchDrugsAction).toHaveBeenCalled());
    fireEvent.keyDown(search, { key: 'Enter' });

    await waitFor(() => expect(barcodeLookupAction).toHaveBeenCalledWith('DUP-BARCODE'));
    expect(usePOSStore.getState().cart).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledWith('الباركود مرتبط بأكثر من صنف؛ يرجى تصحيحه من إدارة الأصناف');
  });

  it('surfaces the specific scanner ambiguity error without adding a product', async () => {
    (barcodeLookupAction as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: 'الباركود مرتبط بأكثر من صنف؛ يرجى تصحيحه من إدارة الأصناف',
    });
    render(<POSPage />);
    const scannerCalls = (useBarcodeScanner as jest.Mock).mock.calls;
    const scan = scannerCalls[scannerCalls.length - 1][0] as (barcode: string) => Promise<void>;

    await act(async () => { await scan('DUP-BARCODE'); });

    expect(usePOSStore.getState().cart).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledWith('الباركود مرتبط بأكثر من صنف؛ يرجى تصحيحه من إدارة الأصناف');
  });

  it('reports a manual interaction-check failure instead of claiming there are no interactions', async () => {
    usePOSStore.getState().setCart([
      cartItem,
      { ...cartItem, id: 'line-2', drug_id: 'drug-2', trade_name_en: 'Second Drug', active_ingredient: 'Ingredient B' },
    ]);
    (checkDrugInteractions as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: 'interaction service unavailable',
    });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'فحص التداخلات' }));

    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('interaction service unavailable', expect.any(Object));
    expect(toast.success).not.toHaveBeenCalledWith(
      'لا توجد تداخلات دوائية معروفة في هذه الفاتورة',
      expect.any(Object),
    );
  });

  it('Ctrl+S executes the real completed-checkout path for a populated cart', async () => {
    usePOSStore.getState().setCart([cartItem]);
    render(<POSPage />);
    await screen.findByRole('button', { name: /إتمام وطباعة/ });

    const preventDefault = jest.fn();
    await act(async () => {
      lastHotkeyHandler('ctrl+s')({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ drug_id: 'drug-1', quantity_sold: 1, unit_price: 25 })],
      payment_method: 'cash',
      status: 'completed',
    })));
  });

  it('blocks repeated Ctrl+S checkout while the first financial write is still pending', async () => {
    usePOSStore.getState().setCart([cartItem]);
    let resolveCheckout: (value: { success: boolean; data?: any; error?: string }) => void = () => {};
    (processCheckoutAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveCheckout = resolve;
    }));
    render(<POSPage />);
    await screen.findByRole('button', { name: /إتمام وطباعة/ });

    const handler = lastHotkeyHandler('ctrl+s');
    await act(async () => {
      handler({ preventDefault: jest.fn() });
      handler({ preventDefault: jest.fn() });
    });

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalled());
    expect(processCheckoutAction).toHaveBeenCalledTimes(1);

    resolveCheckout({ success: false, error: 'temporary checkout failure' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('temporary checkout failure'));
  });

  it('Ctrl+S is a no-op beyond preventing the browser shortcut when the cart is empty', async () => {
    render(<POSPage />);
    await screen.findByPlaceholderText('بحث (اسم أو كود)...');

    const preventDefault = jest.fn();
    lastHotkeyHandler('ctrl+s')({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(processCheckoutAction).not.toHaveBeenCalled();
  });

  it('F2 opens details and F9 adds the selected POS row to shortages', async () => {
    usePOSStore.getState().setCart([cartItem]);
    render(<POSPage />);
    const drugName = await screen.findByText('Test Drug');
    const row = drugName.closest('tr')!;
    fireEvent.click(row);

    fireEvent.keyDown(window, { key: 'F2' });
    expect(await screen.findByTestId('drug-details-modal')).toHaveTextContent('drug:drug-1');

    fireEvent.keyDown(window, { key: 'F9' });
    await waitFor(() => expect(addToShortagesAction).toHaveBeenCalledWith({ drug_id: 'drug-1' }));
  });

  it('surfaces a backend shortage-permission denial from the F9 hotkey', async () => {
    usePOSStore.getState().setCart([cartItem]);
    (addToShortagesAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'غير مصرح' });
    render(<POSPage />);
    const row = (await screen.findByText('Test Drug')).closest('tr')!;
    fireEvent.click(row);

    fireEvent.keyDown(window, { key: 'F9' });

    await waitFor(() => expect(addToShortagesAction).toHaveBeenCalledWith({ drug_id: 'drug-1' }));
    expect(toast.error).toHaveBeenCalledWith('غير مصرح');
  });

  it('Delete removes a selected cart row unless an input currently owns focus', async () => {
    usePOSStore.getState().setCart([cartItem]);
    render(<POSPage />);
    let drugName = await screen.findByText('Test Drug');
    fireEvent.click(drugName.closest('tr')!);

    const search = screen.getByPlaceholderText('بحث (اسم أو كود)...');
    search.focus();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(screen.getByText('Test Drug')).toBeInTheDocument();

    (search as HTMLInputElement).blur();
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(screen.queryByText('Test Drug')).not.toBeInTheDocument());
  });

  it('recovers the POS route when the local session load throws', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'user-1', role: 'pharmacist' });

    render(<POSPage />);

    expect(await screen.findByText('تعذر تحميل نقطة البيع')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByPlaceholderText('بحث (اسم أو كود)...')).toBeInTheDocument();
  });

  it('recovers the POS route when current-user details throw after permission checks', async () => {
    (getCurrentUserAction as jest.Mock)
      .mockRejectedValueOnce(new Error('user bridge unavailable'))
      .mockResolvedValueOnce({
        success: true,
        user: { id: 'user-1', pharmacy_id: 'pharmacy-1', full_name: 'Test Pharmacist' },
      });

    render(<POSPage />);

    expect(await screen.findByText('تعذر تحميل نقطة البيع')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByPlaceholderText('بحث (اسم أو كود)...')).toBeInTheDocument();
  });

  it('surfaces a thrown drafts load instead of silently presenting a false empty result', async () => {
    (fetchDraftsAction as jest.Mock).mockRejectedValueOnce(new Error('draft transport unavailable'));
    render(<POSPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'فواتير معلقة' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل المسودات'));
    expect(fetchDraftsAction).toHaveBeenCalledTimes(1);
  });

  it('replaces stale POS discount, fee, and check state when loading a suspended invoice', async () => {
    usePOSStore.getState().setDiscountPercent(17);
    usePOSStore.getState().setAdditionalFees(9);
    usePOSStore.getState().setCheckNumber('STALE-CHECK');
    (fetchDraftsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{
        id: 'draft-1',
        patient_id: null,
        payment_method: 'check',
        check_number: 'CHK-DRAFT-1',
        discount_amount: 2,
        additional_fees: 3,
        items: [{ ...cartItem, qty: 1 }],
      }],
    });

    render(<POSPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'فواتير معلقة' }));
    fireEvent.click(await screen.findByRole('button', { name: 'LOAD TEST DRAFT' }));

    await waitFor(() => expect(usePOSStore.getState()).toMatchObject({
      paymentMethod: 'check',
      checkNumber: 'CHK-DRAFT-1',
      totalDiscount: 2,
      discountPercent: 0,
      additionalFees: 3,
    }));
  });

  it('keeps POS drug search results owned by the newest query when an older request resolves later', async () => {
    let resolveOld!: (value: any) => void;
    let resolveNew!: (value: any) => void;
    (searchDrugsAction as jest.Mock).mockImplementation((query: string) => {
      if (query === 'old') return new Promise(resolve => { resolveOld = resolve; });
      if (query === 'new') return new Promise(resolve => { resolveNew = resolve; });
      return Promise.resolve({ success: true, data: [] });
    });

    render(<POSPage />);
    const search = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    fireEvent.change(search, { target: { value: 'old' } });
    await waitFor(() => expect(searchDrugsAction).toHaveBeenCalledWith('old', 20, false));
    fireEvent.change(search, { target: { value: 'new' } });
    await waitFor(() => expect(searchDrugsAction).toHaveBeenCalledWith('new', 20, false));

    await act(async () => resolveNew({
      success: true,
      data: [{ id: 'new-drug', trade_name: 'Newest POS Drug', total_stock: 5, min_price: 10 }],
    }));
    expect(await screen.findByText('Newest POS Drug')).toBeInTheDocument();

    await act(async () => resolveOld({
      success: true,
      data: [{ id: 'old-drug', trade_name: 'Stale POS Drug', total_stock: 5, min_price: 10 }],
    }));
    expect(screen.queryByText('Stale POS Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Newest POS Drug')).toBeInTheDocument();
  });

  it('refreshes an open drug search after stock changes without clearing the cart', async () => {
    usePOSStore.getState().setCart([cartItem]);
    (searchDrugsAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'searched-drug', trade_name: 'Searched Drug', total_stock: 1, min_price: 10 }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'searched-drug', trade_name: 'Searched Drug', total_stock: 8, min_price: 10 }],
      });

    render(<POSPage />);
    const search = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    fireEvent.change(search, { target: { value: 'Searched Drug' } });
    await waitFor(() => expect(searchDrugsAction).toHaveBeenCalledTimes(1));
    await screen.findByText('Searched Drug');

    act(() => notifyInventoryChanged());

    await waitFor(() => expect(searchDrugsAction).toHaveBeenCalledTimes(2));
    expect(usePOSStore.getState().cart).toEqual([cartItem]);
    expect(search).toHaveValue('Searched Drug');
  });

  it('keeps POS patient search results owned by the newest query when an older request resolves later', async () => {
    let resolveOld!: (value: any) => void;
    let resolveNew!: (value: any) => void;
    (searchPatientsAction as jest.Mock).mockImplementation((query: string) => {
      if (query === 'old') return new Promise(resolve => { resolveOld = resolve; });
      if (query === 'new') return new Promise(resolve => { resolveNew = resolve; });
      return Promise.resolve({ success: true, data: [] });
    });

    render(<POSPage />);
    const patientSearch = await screen.findByPlaceholderText('بحث عن عميل (نقرتين لعرض الكل)...');
    fireEvent.change(patientSearch, { target: { value: 'old' } });
    await waitFor(() => expect(searchPatientsAction).toHaveBeenCalledWith('old'));
    fireEvent.change(patientSearch, { target: { value: 'new' } });
    await waitFor(() => expect(searchPatientsAction).toHaveBeenCalledWith('new'));

    await act(async () => resolveNew({
      success: true,
      data: [{ id: 'p-new', full_name: 'Newest POS Patient', outstanding_balance: 0 }],
    }));
    expect(await screen.findByText(/Newest POS Patient/)).toBeInTheDocument();

    await act(async () => resolveOld({
      success: true,
      data: [{ id: 'p-old', full_name: 'Stale POS Patient', outstanding_balance: 0 }],
    }));
    expect(screen.queryByText(/Stale POS Patient/)).not.toBeInTheDocument();
    expect(screen.getByText(/Newest POS Patient/)).toBeInTheDocument();
  });

  it('distinguishes a failed POS drug search from an empty result and retries without clearing the query', async () => {
    (searchDrugsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'catalog unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'drug-retry', trade_name: 'Recovered POS Drug', total_stock: 5, min_price: 10 }],
      });

    render(<POSPage />);
    const search = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    fireEvent.change(search, { target: { value: 'retry-drug' } });

    expect(await screen.findByText('تعذر البحث عن الأصناف')).toBeInTheDocument();
    expect(search).toHaveValue('retry-drug');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة البحث عن الأصناف' }));

    expect(await screen.findByText('Recovered POS Drug')).toBeInTheDocument();
    expect(search).toHaveValue('retry-drug');
    expect(searchDrugsAction).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a thrown POS patient search from no matches and retries without clearing the query', async () => {
    (searchPatientsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('patient search unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'p-retry', full_name: 'Recovered POS Patient', outstanding_balance: 0 }],
      });

    render(<POSPage />);
    const patientSearch = await screen.findByPlaceholderText('بحث عن عميل (نقرتين لعرض الكل)...');
    fireEvent.change(patientSearch, { target: { value: 'retry-patient' } });

    expect(await screen.findByText('تعذر البحث عن العملاء')).toBeInTheDocument();
    expect(patientSearch).toHaveValue('retry-patient');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة البحث عن العملاء' }));

    expect(await screen.findByText(/Recovered POS Patient/)).toBeInTheDocument();
    expect(patientSearch).toHaveValue('retry-patient');
    expect(searchPatientsAction).toHaveBeenCalledTimes(2);
  });
});
