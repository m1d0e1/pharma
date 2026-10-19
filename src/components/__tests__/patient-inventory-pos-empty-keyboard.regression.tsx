import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PatientListClient from '@/components/patients/PatientListClient';
import InventoryTable from '@/components/inventory/InventoryTable';
import StockWarningModal from '@/components/pos/StockWarningModal';
import { useHotkeys } from 'react-hotkeys-hook';
import { deletePatientAction } from '@/app/actions-client/patients';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-to-print', () => ({ useReactToPrint: () => jest.fn() }));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/app/actions-client/inventory', () => ({
  deleteInventoryAction: jest.fn(),
  importInventoryWorkbookAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  deletePatientAction: jest.fn(),
  getPatientsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));
jest.mock('@/components/AddPatientModal', () => () => null);
jest.mock('@/components/patients/PatientProfileModal', () => function MockProfile({ patientId }: { patientId: string }) {
  return <div role="dialog" aria-label="ملف مريض تجريبي">fixture profile {patientId}</div>;
});
jest.mock('@/components/EditInventoryModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => () => null);

const patient = {
  id: 'synthetic-p-1', full_name: 'أحمد التجريبي', name_en: 'Ahmed Fixture',
  phone: '01000000000', address: '', notes: '', points_balance: 0,
  outstanding_balance: 0, wallet_balance: 0, customer_type: 'individual', created_at: '2026-09-01',
};

const inventoryRow = {
  id: 'synthetic-lot-1', drug_id: 502, quantity: 3, expiry_date: '2099-10-15',
  local_selling_price: 20, cost_price: 10, barcode: 'TESTBARCODE',
  master_drugs: {
    trade_name: 'دواء تجريبي', trade_name_en: 'Synthetic Drug',
    category: 'Synthetic', manufacturer: 'Fixture', active_ingredient: 'Nonclinical Fixture',
  },
};

function inventory(items: typeof inventoryRow[], searchTerm = '') {
  return <InventoryTable
    items={items}
    searchTerm={searchTerm}
    setSearchTerm={jest.fn()}
    onRefresh={jest.fn()}
    pharmacyId="synthetic-pharmacy"
    canManageInventory={false}
  />;
}

describe('patient directory empty-state and keyboard workflows', () => {
  beforeEach(() => jest.clearAllMocks());

  it('identifies a genuinely empty patient directory rather than claiming a name search failed', () => {
    render(<PatientListClient initialPatients={[]} pharmacyId="synthetic-pharmacy" canDeletePatients={false} />);

    expect(screen.getByText('لا يوجد مرضى مسجلون حتى الآن.')).toBeInTheDocument();
    expect(screen.queryByText('لم يتم العثور على مرضى بهذا الاسم.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إضافة مريض' })).toBeEnabled();
  });

  it('distinguishes filtered no-matches, then restores the existing patient without a data fetch', async () => {
    const user = userEvent.setup();
    render(<PatientListClient initialPatients={[patient]} pharmacyId="synthetic-pharmacy" canDeletePatients={false} />);

    const search = screen.getByRole('textbox', { name: 'بحث في المرضى بالاسم أو رقم الهاتف' });
    await user.type(search, 'not a patient');
    expect(screen.getByText('لم يتم العثور على مرضى بهذا الاسم.')).toBeInTheDocument();
    expect(screen.queryByText('لا يوجد مرضى مسجلون حتى الآن.')).not.toBeInTheDocument();

    await user.clear(search);
    expect(screen.getByText(patient.full_name)).toBeInTheDocument();
    expect(deletePatientAction).not.toHaveBeenCalled();
  });

  it('opens a patient through a keyboard-activated, explicitly named profile control without exposing deletion', async () => {
    const user = userEvent.setup();
    render(<PatientListClient initialPatients={[patient]} pharmacyId="synthetic-pharmacy" canDeletePatients={false} />);

    const profileButton = screen.getByRole('button', { name: `تعديل بيانات المريض ${patient.full_name}` });
    profileButton.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('dialog', { name: 'ملف مريض تجريبي' })).toHaveTextContent(patient.id);
    expect(screen.queryByRole('button', { name: `حذف المريض ${patient.full_name}` })).not.toBeInTheDocument();
    expect(deletePatientAction).not.toHaveBeenCalled();
  });
});

describe('inventory empty-state without file import, stock mutation, or native IO', () => {
  it('labels a genuinely empty inventory distinctly from a no-result query', () => {
    render(inventory([]));

    expect(screen.getByText('لا توجد دفعات مخزون مسجلة حالياً.')).toBeInTheDocument();
    expect(screen.queryByText('لم يتم العثور على نتائج للبحث في المخزون.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'استيراد Excel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'التالي' })).not.toBeInTheDocument();
  });

  it('keeps the filtered-empty message separate and recovers rendered stock on new matching props', () => {
    const view = render(inventory([], 'no matching drug'));
    expect(screen.getByText('لم يتم العثور على نتائج للبحث في المخزون.')).toBeInTheDocument();

    view.rerender(inventory([inventoryRow], 'matching drug'));
    expect(screen.getAllByText('Synthetic Drug').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'عرض تفاصيل Synthetic Drug' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'حذف دفعة Synthetic Drug' })).not.toBeInTheDocument();
  });
});

describe('no-stock POS warning: disabled callbacks and keyboard lifecycle', () => {
  it('does not register a global Escape close handler while closed or without a selected drug', () => {
    const onClose = jest.fn();
    const props = {
      onClose, drug: { id: 81, trade_name: 'صنف بلا مخزون' },
      onNewPurchaseOrder: jest.fn(), onNegativeSale: jest.fn(),
      allowNegativeSale: false,
    };
    const view = render(<StockWarningModal {...props} isOpen={false} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useHotkeys).toHaveBeenLastCalledWith('esc', expect.any(Function), expect.objectContaining({ enabled: false }));
    view.rerender(<StockWarningModal {...props} isOpen drug={null} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useHotkeys).toHaveBeenLastCalledWith('esc', expect.any(Function), expect.objectContaining({ enabled: false }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps negative sale absent without permission while preserving a keyboard-reachable safe purchase action', async () => {
    const user = userEvent.setup();
    const purchase = jest.fn();
    const negativeSale = jest.fn();
    render(<StockWarningModal
      isOpen
      drug={{ id: 81, trade_name: 'صنف بلا مخزون' }}
      onClose={jest.fn()}
      onNewPurchaseOrder={purchase}
      onNegativeSale={negativeSale}
      allowNegativeSale={false}
    />);
    const dialog = screen.getByRole('alertdialog', { name: 'نفد المخزون!' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).queryByRole('button', { name: /بيع بدون رصيد/ })).not.toBeInTheDocument();
    expect(useHotkeys).toHaveBeenLastCalledWith('esc', expect.any(Function), expect.objectContaining({ enabled: true }));

    const order = within(dialog).getByRole('button', { name: 'فاتورة شراء جديدة' });
    order.focus();
    await user.keyboard('{Enter}');
    expect(purchase).toHaveBeenCalledWith(81);
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(negativeSale).not.toHaveBeenCalled();
  });
});
