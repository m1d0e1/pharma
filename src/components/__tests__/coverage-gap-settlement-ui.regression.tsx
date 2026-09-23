import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettlementClient from '@/components/sales/SettlementClient';
import {
  getDrugBatchesAction,
  getUnsettledSalesAction,
  settleSaleItemAction,
} from '@/app/actions-client/settlement';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.permissions?.[key] === true),
}));

jest.mock('@/app/actions-client/settlement', () => ({
  getDrugBatchesAction: jest.fn(),
  getUnsettledSalesAction: jest.fn(),
  settleSaleItemAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const item = {
  item_id: 7,
  invoice_id: 'invoice-abc-123',
  drug_id: 44,
  trade_name: 'دواء التسوية',
  trade_name_en: 'Settlement Drug',
  quantity_sold: 2,
  net_unreturned_quantity: 1,
  unit_price: 30,
  unit: 'large',
  created_at: '2026-09-21T10:00:00',
  current_stock_balance: 4,
};

const batch = {
  id: 'batch-12345678',
  expiry_date: '2027-12-31',
  quantity: 10,
  cost_price: 12.5,
};

describe('sales settlement interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'inventory-manager',
      role: 'admin',
      permissions: { can_view_settlement: true, can_manage_inventory: true },
    });
    (getUnsettledSalesAction as jest.Mock).mockResolvedValue({ success: true, data: [item] });
    (getDrugBatchesAction as jest.Mock).mockResolvedValue({ success: true, data: [batch] });
  });

  it('searches locally, refreshes on demand, and reports refresh failure', async () => {
    render(<SettlementClient initialItems={[item]} />);

    await screen.findByRole('button', { name: 'تسوية الآن' });
    const search = screen.getByPlaceholderText('ابحث برقم الفاتورة أو اسم الصنف...');
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.queryByText('Settlement Drug')).not.toBeInTheDocument();
    expect(screen.getByText('لا يوجد مبيعات معلقة للتسوية')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'invoice-abc' } });
    expect(screen.getByText('Settlement Drug')).toBeInTheDocument();

    (getUnsettledSalesAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'refresh failed' });
    fireEvent.click(screen.getByRole('button', { name: /تحديث البيانات/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحديث البيانات'));
    expect(screen.getByRole('button', { name: /تحديث البيانات/ })).toBeEnabled();
  });

  it('opens available batches, supports cancel, and surfaces batch-loading failure', async () => {
    render(<SettlementClient initialItems={[item]} />);
    await screen.findByRole('button', { name: 'تسوية الآن' });

    fireEvent.click(screen.getByRole('button', { name: 'تسوية الآن' }));
    expect(await screen.findByRole('heading', { name: 'اختيار دفعة التسوية' })).toBeInTheDocument();
    expect(screen.getByText(/دفعة: batch-12/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('heading', { name: 'اختيار دفعة التسوية' })).not.toBeInTheDocument();

    (getDrugBatchesAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'no batches' });
    fireEvent.click(screen.getByRole('button', { name: 'تسوية الآن' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل جلب دفعات المخزون'));
    expect(screen.queryByRole('heading', { name: 'اختيار دفعة التسوية' })).not.toBeInTheDocument();
  });

  it('keeps the item after settlement failure and removes it after successful settlement', async () => {
    (settleSaleItemAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'تعذر خصم الدفعة' })
      .mockResolvedValueOnce({ success: true });
    (getUnsettledSalesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });

    render(<SettlementClient initialItems={[item]} />);
    await screen.findByRole('button', { name: 'تسوية الآن' });
    fireEvent.click(screen.getByRole('button', { name: 'تسوية الآن' }));
    fireEvent.click(await screen.findByText(/دفعة: batch-12/));

    await waitFor(() => expect(settleSaleItemAction).toHaveBeenCalledWith(7, 'batch-12345678'));
    expect(toast.error).toHaveBeenCalledWith('تعذر خصم الدفعة');
    expect(screen.getByRole('heading', { name: 'اختيار دفعة التسوية' })).toBeInTheDocument();
    expect(screen.getByText('Settlement Drug')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/دفعة: batch-12/));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تمت التسوية بنجاح'));
    await waitFor(() => expect(screen.queryByText('Settlement Drug')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'اختيار دفعة التسوية' })).not.toBeInTheDocument();
  });

  it('renders the no-batches state for a valid item with no available inventory lots', async () => {
    (getDrugBatchesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    render(<SettlementClient initialItems={[item]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'تسوية الآن' }));

    expect(await screen.findByText('لا توجد أرصدة متوفرة حالياً لهذا الصنف.')).toBeInTheDocument();
    expect(screen.getByText('يرجى إضافة توريد جديد أولاً.')).toBeInTheDocument();
  });

  it('blocks repeated settlement writes while the first settlement is pending', async () => {
    let resolveSettlement: (value: { success: boolean; error?: string }) => void = () => {};
    (settleSaleItemAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveSettlement = resolve; }));
    render(<SettlementClient initialItems={[item]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'تسوية الآن' }));
    const batchButton = await screen.findByText(/دفعة: batch-12/);
    const button = batchButton.closest('button') as HTMLButtonElement;
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(settleSaleItemAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveSettlement({ success: false, error: 'settlement rejected' }));
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('recovers the settlement modal when the financial write throws', async () => {
    (settleSaleItemAction as jest.Mock).mockRejectedValueOnce(new Error('settlement bridge unavailable'));
    render(<SettlementClient initialItems={[item]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'تسوية الآن' }));
    const batchButton = (await screen.findByText(/دفعة: batch-12/)).closest('button') as HTMLButtonElement;
    fireEvent.click(batchButton);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء التسوية'));
    expect(screen.getByRole('heading', { name: 'اختيار دفعة التسوية' })).toBeInTheDocument();
    expect(batchButton).toBeEnabled();
    expect(screen.getByText('Settlement Drug')).toBeInTheDocument();
  });

  it('surfaces a thrown batch-loader failure without opening a false settlement modal', async () => {
    (getDrugBatchesAction as jest.Mock).mockRejectedValueOnce(new Error('batch bridge unavailable'));
    render(<SettlementClient initialItems={[item]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'تسوية الآن' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل جلب دفعات المخزون'));
    expect(screen.queryByRole('heading', { name: 'اختيار دفعة التسوية' })).not.toBeInTheDocument();
  });

  it('does not let an older batch request overwrite the newer selected settlement item', async () => {
    const newerItem = { ...item, item_id: 8, drug_id: 45, trade_name_en: 'Newer Settlement Drug', invoice_id: 'invoice-newer' };
    let resolveOlder: (value: any) => void = () => {};
    let resolveNewer: (value: any) => void = () => {};
    (getDrugBatchesAction as jest.Mock).mockImplementation((drugId: number) => new Promise(resolve => {
      if (drugId === 44) resolveOlder = resolve;
      if (drugId === 45) resolveNewer = resolve;
    }));
    render(<SettlementClient initialItems={[item, newerItem]} />);

    const settleButtons = await screen.findAllByRole('button', { name: 'تسوية الآن' });
    fireEvent.click(settleButtons[0]);
    fireEvent.click(settleButtons[1]);

    await act(async () => resolveNewer({ success: true, data: [{ ...batch, id: 'newer-batch-1234' }] }));
    expect(await screen.findByText('للصنف: Newer Settlement Drug')).toBeInTheDocument();
    expect(screen.getByText(/دفعة: newer-ba/)).toBeInTheDocument();

    await act(async () => resolveOlder({ success: true, data: [{ ...batch, id: 'older-batch-1234' }] }));
    expect(screen.getByText('للصنف: Newer Settlement Drug')).toBeInTheDocument();
    expect(screen.getByText(/دفعة: newer-ba/)).toBeInTheDocument();
    expect(screen.queryByText(/دفعة: older-ba/)).not.toBeInTheDocument();
  });
});
