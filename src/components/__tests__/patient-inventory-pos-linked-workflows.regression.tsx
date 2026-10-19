import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import POSPage from '@/app/(dashboard)/pos/page';
import InventoryTable from '@/components/inventory/InventoryTable';
import PatientListClient from '@/components/patients/PatientListClient';
import { usePOSStore } from '@/store/usePOSStore';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { searchDrugsAction, processCheckoutAction } from '@/app/actions-client/sales';
import { addPatientAction, getPatientsAction, getPatientForPosAction, searchPatientsAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

const push = jest.fn();
const refresh = jest.fn();
const mockRouter = { push, refresh };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-to-print', () => ({ useReactToPrint: () => jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn(async () => ({
    success: true, user: { id: 'integration-user', pharmacy_id: 'integration-pharmacy', full_name: 'Fixture pharmacist' },
  })),
}));
jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn(),
  barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn(async () => ({ success: true, data: [] })),
  processCheckoutAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  addPatientAction: jest.fn(),
  getPatientsAction: jest.fn(),
  searchPatientsAction: jest.fn(),
  getPatientForPosAction: jest.fn(),
  getPatientProfileAction: jest.fn(async () => ({ success: true, data: {} })),
}));
jest.mock('@/app/actions-client/interactions', () => ({ checkDrugInteractions: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  getUnitsAction: jest.fn(async () => ({ success: true, data: [] })),
}));
jest.mock('@/app/actions-client/inventory', () => ({
  deleteInventoryAction: jest.fn(),
  importInventoryWorkbookAction: jest.fn(),
}));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/app/actions-client/shortages', () => ({ addToShortagesAction: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({ generateDailySnapshotAction: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);
jest.mock('@/components/returns/ReturnsClient', () => () => null);
jest.mock('@/components/pos/DraftsModal', () => () => null);
jest.mock('@/components/pos/PosDrawerHandoverModal', () => () => null);
jest.mock('@/components/pos/DrugInteractionModal', () => () => null);
jest.mock('@/components/patients/PatientProfileModal', () => () => null);
jest.mock('@/components/EditInventoryModal', () => () => null);
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  Toaster: () => null,
  toast: Object.assign(jest.fn(), {
    error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn(),
  }),
}));

const client = {
  id: 'patient-fixture-1', full_name: 'Patient Integration Fixture',
  phone: '01000001555', address: '', notes: '', created_at: '2026-10-01',
  customer_type: 'individual', credit_limit: 100, outstanding_balance: 10,
  wallet_balance: 25, points_balance: 0, payment_method: 'cash',
};
const stock = {
  id: 'drug-fixture-100', trade_name: 'صنف متكامل', trade_name_en: 'Integrated POS Stock',
  active_ingredient: 'Fictional Ingredient', min_price: 40, total_stock: 1,
  is_expired: false, units: { large: 'box', medium: 'strip', large_to_medium: 3, medium_to_small: 2 },
  batches: [{
    inventory_id: 'lot-fixture-100', expiry_date: '2099-12-31',
    quantity: 1, unit_price: 40, strips_per_box: 3, medium_to_small: 2,
  }],
};
const inventoryItem = {
  id: 'lot-fixture-100', drug_id: 100, quantity: 1, expiry_date: '2099-12-31',
  local_selling_price: 40, cost_price: 22,
  master_drugs: {
    trade_name: stock.trade_name, trade_name_en: stock.trade_name_en,
    category: 'fixture', manufacturer: 'fixture', active_ingredient: stock.active_ingredient,
  },
};

async function choosePatient() {
  fireEvent.change(await screen.findByPlaceholderText('بحث باسم أو هاتف العميل...'), {
    target: { value: client.full_name },
  });
  const result = await screen.findByText(client.full_name, { exact: false });
  fireEvent.click(result.closest('button')!);
  // Selecting a patient waits for the independent tenant-owned POS profile
  // verification. Clicking a search hit alone is not authorization.
  expect(await screen.findByRole('button', { name: `إلغاء اختيار العميل ${client.full_name}` })).toBeInTheDocument();
}

async function chooseDrug() {
  fireEvent.change(await screen.findByPlaceholderText('بحث (اسم أو كود)...'), {
    target: { value: stock.trade_name },
  });
  fireEvent.click((await screen.findByText(stock.trade_name)).closest('button')!);
}

describe('linked patient selection, inventory state, and POS stock-warning boundary (all actions mocked)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePOSStore.getState().resetPOS();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'integration-user', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockImplementation((_session, permission) => permission !== 'can_sell_no_stock');
    (searchPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [client] });
    (getPatientForPosAction as jest.Mock).mockResolvedValue({ success: true, data: client });
    (searchDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ ...stock, total_stock: 0, batches: [] }] });
  });

  afterEach(() => {
    act(() => usePOSStore.getState().resetPOS());
  });

  it('keeps a selected patient/credit method while rejecting zero-stock addition without negative-sale permission; never starts checkout', async () => {
    render(<POSPage />);
    await choosePatient();
    fireEvent.click(screen.getByRole('button', { name: 'آجل' }));
    await chooseDrug();
    const modal = await screen.findByRole('alertdialog', { name: 'نفد المخزون!' });
    expect(within(modal).queryByRole('button', { name: /بيع بدون رصيد/ })).not.toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'إلغاء' })).toBeEnabled();
    expect(usePOSStore.getState().cart).toHaveLength(0);
    expect(processCheckoutAction).not.toHaveBeenCalled();

    fireEvent.click(within(modal).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('alertdialog', { name: 'نفد المخزون!' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'آجل' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: `إلغاء اختيار العميل ${client.full_name}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeDisabled();
    expect(processCheckoutAction).not.toHaveBeenCalled();
  });

  it('re-queries stock after an inventory change and blocks sale of now-unavailable inventory without posting', async () => {
    let available = 1;
    (searchDrugsAction as jest.Mock).mockImplementation(async () => ({
      success: true,
      data: [{ ...stock, total_stock: available, batches: available ? stock.batches : [] }],
    }));
    const displayInventory = (quantity: number) => <InventoryTable
      items={[{ ...inventoryItem, quantity }]}
      pharmacyId="integration-pharmacy"
      searchTerm=""
      setSearchTerm={jest.fn()}
      onRefresh={jest.fn()}
      canManageInventory={false}
    />;
    const rendered = render(<><POSPage />{displayInventory(1)}</>);
    const drugSearch = await screen.findByPlaceholderText('بحث (اسم أو كود)...');
    fireEvent.change(drugSearch, { target: { value: stock.trade_name } });
    const itemResult = (await screen.findByText(stock.trade_name)).closest('button')!;
    expect(itemResult).toHaveTextContent('1 متاح');

    available = 0;
    rendered.rerender(<><POSPage />{displayInventory(0)}</>);
    act(() => notifyInventoryChanged());
    await waitFor(() => expect(searchDrugsAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(itemResult).toHaveTextContent('0 متاح'));
    fireEvent.click(itemResult);

    const dialog = await screen.findByRole('alertdialog', { name: 'نفد المخزون!' });
    expect(within(dialog).queryByRole('button', { name: /بيع بدون رصيد/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إتمام البيع' })).toBeDisabled();
    expect(processCheckoutAction).not.toHaveBeenCalled();
  });

  it('keeps the out-of-stock warning as the keyboard focus boundary after patient selection', async () => {
    const user = userEvent.setup();
    render(<POSPage />);
    await choosePatient();
    await chooseDrug();
    const warning = await screen.findByRole('alertdialog', { name: 'نفد المخزون!' });
    await waitFor(() => expect(warning).toContainElement(document.activeElement as HTMLElement));

    const cancel = within(warning).getByRole('button', { name: 'إلغاء' });
    cancel.focus();
    await user.tab();
    expect(warning).toContainElement(document.activeElement as HTMLElement);
    expect(processCheckoutAction).not.toHaveBeenCalled();
  });
});

describe('committed patient creation flowing back into the patient list (mocked persistence)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (addPatientAction as jest.Mock).mockResolvedValue({ success: true, id: 'patient-created-fixture' });
  });

  it('keeps the previously verified patient list after a failed post-create read, reports uncertainty, and never writes twice', async () => {
    (getPatientsAction as jest.Mock).mockRejectedValueOnce(new Error('fixture follow-up read unavailable'));
    render(<PatientListClient initialPatients={[client]} pharmacyId="integration-pharmacy" canDeletePatients={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مريض' }));
    fireEvent.change(screen.getByLabelText('الاسم بالكامل (ع) *'), {
      target: { value: 'مريض محفوظ تجريبياً' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));

    await waitFor(() => expect(addPatientAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getPatientsAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('مريض محفوظ تجريبياً')).not.toBeInTheDocument();
    expect(screen.getByText(client.full_name)).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('تم حفظ المريض لكن تعذر تحديث القائمة');
    expect(addPatientAction).toHaveBeenCalledTimes(1);
  });

  it('recovers a confirmed create with a read-only retry after a failed list refresh, without replaying creation', async () => {
    let resolveRetry!: (result: unknown) => void;
    (getPatientsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('fixture first read unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
    render(<PatientListClient initialPatients={[client]} pharmacyId="integration-pharmacy" canDeletePatients={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مريض' }));
    fireEvent.change(screen.getByLabelText('الاسم بالكامل (ع) *'), {
      target: { value: 'مريض مُثبت بعد الاستعادة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تم حفظ المريض لكن تعذر تحديث القائمة'));

    const retry = screen.getByRole('button', { name: 'إعادة تحميل قائمة المرضى' });
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(getPatientsAction).toHaveBeenCalledTimes(2));
    await act(async () => resolveRetry({
      success: true,
      data: [client, {
        ...client, id: 'patient-created-fixture', full_name: 'مريض مُثبت بعد الاستعادة',
      }],
    }));
    expect(await screen.findByText('مريض مُثبت بعد الاستعادة')).toBeInTheDocument();
    expect(getPatientsAction).toHaveBeenCalledTimes(2);
    expect(addPatientAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'إعادة تحميل قائمة المرضى' })).not.toBeInTheDocument();
  });

  it('does not display unverified created-patient data while a stale list read is pending or returns without that ID', async () => {
    let finishRead!: (value: unknown) => void;
    (getPatientsAction as jest.Mock).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
    render(<PatientListClient initialPatients={[client]} pharmacyId="integration-pharmacy" canDeletePatients={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مريض' }));
    fireEvent.change(screen.getByLabelText('الاسم بالكامل (ع) *'), {
      target: { value: 'مريض جديد في انتظار المزامنة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));
    await waitFor(() => expect(getPatientsAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('مريض جديد في انتظار المزامنة')).not.toBeInTheDocument();

    await act(async () => finishRead({ success: true, data: [client] }));
    expect(screen.queryByText('مريض جديد في انتظار المزامنة')).not.toBeInTheDocument();
    expect(addPatientAction).toHaveBeenCalledTimes(1);
  });

  it('displays the newly created patient once the authorized list read includes the confirmed ID', async () => {
    (getPatientsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [client, {
        ...client, id: 'patient-created-fixture', full_name: 'مريض من القائمة المؤكدة',
      }],
    });
    render(<PatientListClient initialPatients={[client]} pharmacyId="integration-pharmacy" canDeletePatients={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مريض' }));
    fireEvent.change(screen.getByLabelText('الاسم بالكامل (ع) *'), {
      target: { value: 'مريض من القائمة المؤكدة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));

    expect(await screen.findByText('مريض من القائمة المؤكدة')).toBeInTheDocument();
    expect(getPatientsAction).toHaveBeenCalledTimes(1);
    expect(addPatientAction).toHaveBeenCalledTimes(1);
  });
});
