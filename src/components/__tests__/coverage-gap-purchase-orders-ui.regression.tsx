import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseOrdersClient from '@/components/inventory/PurchaseOrdersClient';
import { updatePurchaseOrderStatusAction } from '@/app/actions-client/purchases';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/purchases', () => ({
  updatePurchaseOrderStatusAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const orders = [
  { id: 'PO-ALPHA', supplier_name: 'Alpha Supplier', status: 'pending', item_count: 2, total_amount: 100, created_at: '2026-09-20T10:00:00Z' },
  { id: 'PO-BETA', supplier_name: 'Beta Supplier', status: 'completed', item_count: 1, total_amount: 50, created_at: '2026-09-19T10:00:00Z' },
];

describe('purchase-orders list UI interactions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('combines supplier/id search with status filters and renders the explicit empty state', () => {
    render(<PurchaseOrdersClient initialOrders={orders} />);

    const search = screen.getByPlaceholderText('بحث برقم الطلب أو اسم المورد...');
    fireEvent.change(search, { target: { value: 'beta' } });
    expect(screen.getByText('PO-BETA')).toBeInTheDocument();
    expect(screen.queryByText('PO-ALPHA')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'قيد الانتظار' }));
    expect(screen.getByText('PO-ALPHA')).toBeInTheDocument();
    expect(screen.queryByText('PO-BETA')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('لا توجد أوامر شراء مطابقة')).toBeInTheDocument();
  });

  it('surfaces cancellation failure, then updates only after a successful action result', async () => {
    (updatePurchaseOrderStatusAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'تعذر إلغاء الطلب' })
      .mockResolvedValueOnce({ success: true });
    render(<PurchaseOrdersClient initialOrders={orders} />);

    const cancel = screen.getByTitle('إلغاء الطلب');
    fireEvent.click(cancel);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر إلغاء الطلب'));
    expect(screen.getByTitle('إلغاء الطلب')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('إلغاء الطلب'));
    await waitFor(() => expect(updatePurchaseOrderStatusAction).toHaveBeenLastCalledWith('PO-ALPHA', 'cancelled'));
    expect(toast.success).toHaveBeenCalledWith('تم إلغاء أمر الشراء');
    await waitFor(() => expect(screen.queryByTitle('إلغاء الطلب')).not.toBeInTheDocument());
    expect(screen.getAllByText('تم الإلغاء')).toHaveLength(2);
  });

  it('surfaces a thrown status-update failure without mutating the pending order', async () => {
    (updatePurchaseOrderStatusAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<PurchaseOrdersClient initialOrders={orders} />);

    fireEvent.click(screen.getByTitle('إلغاء الطلب'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل التحديث'));
    expect(screen.getByTitle('إلغاء الطلب')).toBeInTheDocument();
    expect(screen.getByText('PO-ALPHA')).toBeInTheDocument();
  });

  it('blocks repeated status-update events for the same order while persistence is pending', async () => {
    let resolveUpdate: (value: { success: boolean; error?: string }) => void = () => {};
    const pendingUpdate = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveUpdate = resolve;
    });
    (updatePurchaseOrderStatusAction as jest.Mock).mockReturnValue(pendingUpdate);
    render(<PurchaseOrdersClient initialOrders={orders} />);

    const cancel = screen.getByTitle('إلغاء الطلب');
    act(() => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updatePurchaseOrderStatusAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpdate({ success: false, error: 'تعذر الإلغاء مؤقتاً' });
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر الإلغاء مؤقتاً'));
  });

  it('preserves successful concurrent status updates for different orders', async () => {
    const concurrentOrders = [
      orders[0],
      { ...orders[1], id: 'PO-GAMMA', supplier_name: 'Gamma Supplier', status: 'pending' },
    ];
    let resolveAlpha: (value: { success: boolean }) => void = () => {};
    let resolveGamma: (value: { success: boolean }) => void = () => {};
    (updatePurchaseOrderStatusAction as jest.Mock).mockImplementation((poId: string) => new Promise(resolve => {
      if (poId === 'PO-ALPHA') resolveAlpha = resolve;
      if (poId === 'PO-GAMMA') resolveGamma = resolve;
    }));
    render(<PurchaseOrdersClient initialOrders={concurrentOrders} />);

    const cancelButtons = screen.getAllByTitle('إلغاء الطلب');
    fireEvent.click(cancelButtons[0]);
    fireEvent.click(cancelButtons[1]);

    await act(async () => {
      resolveAlpha({ success: true });
    });
    await act(async () => {
      resolveGamma({ success: true });
    });

    await waitFor(() => expect(screen.queryAllByTitle('إلغاء الطلب')).toHaveLength(0));
    expect(screen.getAllByText('تم الإلغاء', { selector: 'div' })).toHaveLength(2);
  });
});
