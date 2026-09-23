import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RestockPage from '@/app/(dashboard)/restock/page';
import { getRestockItemsAction } from '@/app/actions-client/inventory';
import { getClientSession } from '@/lib/auth/local';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.permissions?.[key] === true),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getRestockItemsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseOrderAction: jest.fn(),
  getDrugInventoryQuantityAction: jest.fn(),
  getSuppliersAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

const restockItem = {
  id: 'inv-7',
  drug_id: 7,
  quantity: 0,
  min_stock_level: 5,
  suggested_order: 4,
  master_drugs: {
    id: 7,
    trade_name: 'Restock Drug',
    official_price: 25,
    category: 'Analgesics',
    manufacturer: 'Test Pharma',
  },
};

describe('restock route interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'restock-user',
      role: 'pharmacist',
      permissions: { can_view_restock: true },
    });
    (getRestockItemsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [restockItem],
    });
  });

  it('edits suggested quantity, keeps the zero floor, updates the budget, and passes the edited row into the PO modal', async () => {
    render(<RestockPage />);

    const drugCell = await screen.findByText('Restock Drug');
    const restockRow = drugCell.closest('tr');
    expect(restockRow).not.toBeNull();

    const quantityInput = within(restockRow as HTMLElement).getByRole('spinbutton');
    expect(quantityInput).toHaveValue(4);

    fireEvent.change(quantityInput, { target: { value: '0' } });
    fireEvent.click(within(restockRow as HTMLElement).getByRole('button', { name: '-' }));
    expect(quantityInput).toHaveValue(0);

    fireEvent.change(quantityInput, { target: { value: '6' } });
    await waitFor(() => expect(quantityInput).toHaveValue(6));
    expect(screen.getAllByText('150')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /إنشاء أمر شراء/i }));

    expect(await screen.findByRole('heading', { name: 'إنشاء أمر شراء جديد' })).toBeInTheDocument();
    const modalDrugCells = screen.getAllByText('Restock Drug');
    const modalRow = modalDrugCells[0].closest('tr');
    expect(modalRow).not.toBeNull();
    const modalInputs = within(modalRow as HTMLElement).getAllByRole('spinbutton');
    expect(modalInputs[0]).toHaveValue(6);
    expect(modalInputs[1]).toHaveValue(25);
  });

  it('renders the explicit completed-stock empty state when there is nothing to reorder', async () => {
    (getRestockItemsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });

    render(<RestockPage />);

    expect(await screen.findByText('المخزون مكتمل! لا توجد نواقص حالياً.')).toBeInTheDocument();
    expect(screen.getByText('الميزانية التقديرية لإعادة الملء')).toBeInTheDocument();
  });

  it('shows a retryable load error instead of a completed-stock state when loading fails', async () => {
    (getRestockItemsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'db unavailable' })
      .mockResolvedValueOnce({ success: true, data: [restockItem] });

    render(<RestockPage />);

    expect(await screen.findByText('تعذر تحميل قائمة إعادة التموين')).toBeInTheDocument();
    expect(screen.queryByText('المخزون مكتمل! لا توجد نواقص حالياً.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('Restock Drug')).toBeInTheDocument();
    expect(getRestockItemsAction).toHaveBeenCalledTimes(2);
  });
});
