import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import POSPage from '@/app/(dashboard)/pos/page';
import { processCheckoutAction, searchDrugsAction } from '@/app/actions-client/sales';
import { searchPatientsAction, getPatientForPosAction } from '@/app/actions-client/patients';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { usePOSStore } from '@/store/usePOSStore';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({
    success: true,
    user: { id: 'pos5-user', pharmacy_id: 'pos5-pharmacy', full_name: 'Synthetic Pharmacist' },
  }),
}));
jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn(),
  barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  processCheckoutAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  searchPatientsAction: jest.fn(),
  getPatientForPosAction: jest.fn(),
  getPatientProfileAction: jest.fn().mockResolvedValue({ success: true, data: {} }),
}));
jest.mock('@/app/actions-client/interactions', () => ({ checkDrugInteractions: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/shortages', () => ({ addToShortagesAction: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({ generateDailySnapshotAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/returns/ReturnsClient', () => () => null);
jest.mock('@/components/pos/DraftsModal', () => () => null);
jest.mock('@/components/pos/PosDrawerHandoverModal', () => () => null);
jest.mock('@/components/pos/DrugInteractionModal', () => () => null);
jest.mock('@/components/AddPatientModal', () => () => null);
// StockWarningModal intentionally stays real: zero-stock permission and decision controls are under test.
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  Toaster: () => null,
  toast: Object.assign(jest.fn(), {
    error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn(),
  }),
}));

const lots = [
  { inventory_id: 'pos5-lot-A', expiry_date: '2099-10-31', quantity: 1, unit_price: 96, strips_per_box: 4, medium_to_small: 3 },
  { inventory_id: 'pos5-lot-B', expiry_date: '2099-12-15', quantity: 0.5, unit_price: 90, strips_per_box: 5, medium_to_small: 2 },
];
const stockDrug = {
  id: 'pos5-drug-501',
  trade_name: 'دواء خامس للمخزون',
  trade_name_en: 'POS5 Stock Drug',
  active_ingredient: 'Synthetic Ingredient',
  min_price: 96,
  total_stock: 1.5,
  nearest_expiry: '2099-10-31',
  is_expired: false,
  units: { large: 'box', medium: 'strip', small: 'pill', large_to_medium: 3, medium_to_small: 4 },
  batches: lots,
};
const noStockDrug = {
  ...stockDrug,
  id: 'pos5-drug-empty-702',
  trade_name: 'دواء صفر خامس',
  trade_name_en: 'POS5 Zero Stock Drug',
  total_stock: 0,
  min_price: 40,
  batches: [],
};
const patient = {
  id: 'pos5-patient-205',
  full_name: 'Synthetic POS5 Patient',
  phone: '01000000555',
  credit_limit: 240,
  outstanding_balance: 35,
  wallet_balance: 20,
  points_balance: 0,
  payment_method: 'cash' as const,
};

async function addSearchedDrug(drug = stockDrug) {
  fireEvent.change(await screen.findByPlaceholderText('بحث (اسم أو كود)...'), {
    target: { value: drug.trade_name },
  });
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(drug.trade_name) }));
  return (await screen.findByText(drug.trade_name_en)).closest('tr') as HTMLTableRowElement;
}

async function selectPatient() {
  fireEvent.change(await screen.findByPlaceholderText('بحث باسم أو هاتف العميل...'), {
    target: { value: patient.full_name },
  });
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic POS5 Patient.*مديونية:/ }));
  // A selected patient is not shown or trusted until the independent scoped
  // getPatientForPosAction verification resolves. A synchronous assertion
  // here incorrectly raced the safety check introduced for persisted drafts.
  expect(await screen.findByRole('button', { name: `إلغاء اختيار العميل ${patient.full_name}` })).toBeInTheDocument();
}

function expectedCheckout(items: any[], fields: Record<string, any> = {}) {
  return {
    request_id: expect.any(String),
    items,
    patient_id: undefined,
    payment_method: 'cash',
    check_number: undefined,
    status: 'completed',
    total_discount: 0,
    additional_fees: 0,
    points_to_redeem: 0,
    source_draft_id: null,
    ...fields,
  };
}

describe('QA background: POS rendered checkout source lots, patient credit and no-stock branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockReset();
    usePOSStore.getState().resetPOS();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'pos5-user', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    (searchDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [stockDrug] });
    (searchPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [patient] });
    (getPatientForPosAction as jest.Mock).mockResolvedValue({ success: true, data: patient });
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true, data: { interactions: [], allergies: [] },
    });
    (processCheckoutAction as jest.Mock).mockResolvedValue({
      success: true, data: { sale_id: 'pos5-sale-mocked' },
    });
  });

  afterEach(() => {
    act(() => usePOSStore.getState().resetPOS());
  });

  it('searches a real POS drug result, corrects a selected lot overcommit and posts only that lot in strips', async () => {
    render(<POSPage />);
    const row = await addSearchedDrug();
    const selectors = within(row).getAllByRole('combobox');
    const unit = selectors[0];
    const lot = selectors[1];
    const quantity = row.querySelector('input[data-qty-input="true"]') as HTMLInputElement;
    expect(quantity).toBeInTheDocument();

    fireEvent.change(lot, { target: { value: 'pos5-lot-A' } });
    fireEvent.change(unit, { target: { value: 'medium' } });
    fireEvent.change(quantity, { target: { value: '4' } });
    expect(quantity).toHaveValue(4);
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeEnabled();

    fireEvent.change(lot, { target: { value: 'pos5-lot-B' } });
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeDisabled();
    expect(processCheckoutAction).not.toHaveBeenCalled();
    fireEvent.change(quantity, { target: { value: '2' } });
    expect(quantity).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'إتمام البيع' }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expectedCheckout([{
      drug_id: 'pos5-drug-501', inventory_id: 'pos5-lot-B', quantity_sold: 2,
      unit_price: 18, item_discount_percent: 0, selected_unit: 'medium', is_negative: false,
    }])));
    expect(processCheckoutAction).toHaveBeenCalledTimes(1);
  });

  it('selects a real patient and credit method, retains exact payment and source data through writer denial and retry', async () => {
    (processCheckoutAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'POS5 synthetic credit refusal' })
      .mockResolvedValueOnce({ success: true, data: { sale_id: 'pos5-credit-retry' } });
    render(<POSPage />);
    const row = await addSearchedDrug();
    fireEvent.change(within(row).getAllByRole('combobox')[1], { target: { value: 'pos5-lot-A' } });
    await selectPatient();
    fireEvent.click(screen.getByRole('button', { name: 'آجل' }));
    expect(screen.getByRole('button', { name: 'آجل' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('205.00 ج.م')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('م. إضافية'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'إتمام البيع' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('POS5 synthetic credit refusal'));
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeEnabled();
    expect(usePOSStore.getState().cart).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'آجل' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'إتمام البيع' }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledTimes(2));
    const expected = expectedCheckout([{
      drug_id: 'pos5-drug-501', inventory_id: 'pos5-lot-A', quantity_sold: 1,
      unit_price: 96, item_discount_percent: 0, selected_unit: 'large', is_negative: false,
    }], { patient_id: patient.id, payment_method: 'credit', additional_fees: 6 });
    expect((processCheckoutAction as jest.Mock).mock.calls[0][0]).toEqual(expected);
    expect((processCheckoutAction as jest.Mock).mock.calls[1][0]).toEqual(expected);
    expect((processCheckoutAction as jest.Mock).mock.calls[0][0].request_id)
      .toBe((processCheckoutAction as jest.Mock).mock.calls[1][0].request_id);
    await waitFor(() => expect(usePOSStore.getState().cart).toHaveLength(0));
  });

  it('falls back to cash when an auto-credit patient is removed, without retaining a patient ID in checkout', async () => {
    (searchPatientsAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ ...patient, payment_method: 'credit' }],
    });
    render(<POSPage />);
    await addSearchedDrug();
    await selectPatient();
    expect(screen.getByRole('button', { name: 'آجل' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: `إلغاء اختيار العميل ${patient.full_name}` }));
    expect(screen.getByRole('button', { name: 'كاش' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'إتمام البيع' }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expectedCheckout([{
      drug_id: 'pos5-drug-501', inventory_id: null, quantity_sold: 1,
      unit_price: 96, item_discount_percent: 0, selected_unit: 'large', is_negative: false,
    }])));
  });

  it('refuses a no-stock sale in the real warning dialog without negative-sale permission', async () => {
    (hasUserPermissionSync as jest.Mock).mockImplementation((_session, key) => key !== 'can_sell_no_stock');
    (searchDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [noStockDrug] });
    render(<POSPage />);
    fireEvent.change(await screen.findByPlaceholderText('بحث (اسم أو كود)...'), {
      target: { value: noStockDrug.trade_name },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(noStockDrug.trade_name) }));

    const dialog = await screen.findByRole('alertdialog', { name: 'نفد المخزون!' });
    expect(within(dialog).queryByRole('button', { name: 'بيع بدون رصيد (تسوية لاحقاً)' })).not.toBeInTheDocument();
    expect(processCheckoutAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeDisabled();
    expect(usePOSStore.getState().cart).toHaveLength(0);
  });

  it('sells a permitted zero-stock item through the real warning decision and retains the negative-sale flag', async () => {
    (searchDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [noStockDrug] });
    render(<POSPage />);
    fireEvent.change(await screen.findByPlaceholderText('بحث (اسم أو كود)...'), {
      target: { value: noStockDrug.trade_name },
    });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(noStockDrug.trade_name) }));
    const dialog = await screen.findByRole('alertdialog', { name: 'نفد المخزون!' });
    expect(processCheckoutAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'بيع بدون رصيد (تسوية لاحقاً)' }));
    const row = (await screen.findByText(noStockDrug.trade_name_en)).closest('tr')!;
    const increment = within(row).getByRole('button', { name: 'زيادة كمية POS5 Zero Stock Drug' });
    fireEvent.click(increment);
    fireEvent.click(increment);
    expect(row.querySelector('input[data-qty-input="true"]')).toHaveValue(3);
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'إتمام البيع' }));

    await waitFor(() => expect(processCheckoutAction).toHaveBeenCalledWith(expectedCheckout([{
      drug_id: 'pos5-drug-empty-702', inventory_id: null, quantity_sold: 3,
      unit_price: 40, item_discount_percent: 0, selected_unit: 'large', is_negative: true,
    }])));
    expect(processCheckoutAction).toHaveBeenCalledTimes(1);
  });
});
