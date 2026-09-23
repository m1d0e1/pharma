import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseReportsClient from '@/components/reports/PurchaseReportsClient';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import SalesDashboardPage from '@/app/(dashboard)/sales/page';
import ReportsPage from '@/app/(dashboard)/reports/page';
import {
  getPurchaseInvoicesAction,
  getPurchaseInvoiceDetailsAction,
  getPurchasesReportsAction,
  getSuppliersAction,
  deletePurchaseInvoiceAction,
} from '@/app/actions-client/purchases';
import { getSalesReportsAction, getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { getSalesDashboardStatsAction } from '@/app/actions-client/sales';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';
import { getReportsDataAction } from '@/app/actions-client/reports';

jest.mock('@/app/actions-client/purchases', () => ({
  getPurchaseInvoicesAction: jest.fn(),
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  deletePurchaseInvoiceAction: jest.fn(),
}));
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(),
  getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/sales', () => ({
  getSalesDashboardStatsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/reports', () => ({
  getReportsDataAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  },
}));
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/components/receipts/ReceiptDetailsModal', () => function ReceiptDetailsModalStub({ invoice }: any) {
  return <div>receipt-modal:{invoice.id}</div>;
});
jest.mock('@/components/dashboard/SalesCharts', () => function MockSalesCharts({ topDrugs }: any) {
  return <div>sales-charts:{topDrugs?.[0]?.name || 'empty'}</div>;
});

describe('coverage gap: report error recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getPurchaseInvoicesAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getPurchasesReportsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (deletePurchaseInvoiceAction as jest.Mock).mockReset().mockResolvedValue({ success: true });
    (getSalesReportsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getInvoiceDetailsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getStaffAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getPatientsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getSuppliersAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getSalesDashboardStatsAction as jest.Mock).mockReset();
    (getReportsDataAction as jest.Mock).mockReset();
    (getClientSession as jest.Mock).mockResolvedValue({
      role: 'owner',
      permissions: {
        can_access_pos: true,
        can_view_returns: true,
        can_view_settlement: true,
        can_view_delivery: true,
        can_view_cogs: true,
        rep_can_view_sales: true,
      },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user, permission) => {
      if (user?.role === 'owner') return true;
      return Boolean(user?.permissions?.[permission]);
    });
  });

  it('shows a retryable PurchaseReportsClient error when the initial action throws', async () => {
    (getPurchaseInvoicesAction as jest.Mock).mockRejectedValueOnce(new Error('purchase report transport'));
    render(<PurchaseReportsClient />);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تقارير المشتريات'));
    expect(await screen.findByText('تعذر تحميل تقارير المشتريات')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('سجل الفواتير')).toBeInTheDocument();
    expect(getPurchaseInvoicesAction).toHaveBeenCalledTimes(2);
  });

  it('recovers PurchasesReportsClient search after a thrown action failure', async () => {
    (getPurchasesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockRejectedValueOnce(new Error('purchase search transport'));
    render(<PurchasesReportsClient userRole="owner" />);
    await waitFor(() => expect(getPurchasesReportsAction).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText('رقم الفاتورة...'), { target: { value: 'P-500' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث في الفواتير/ }));

    await waitFor(() => expect(getPurchasesReportsAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ invoiceNumber: 'P-500' }),
    ));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تقرير المشتريات'));
    expect(screen.getByRole('button', { name: /بحث في الفواتير/ })).toBeEnabled();
  });

  it('recovers SalesReportsClient search after a thrown action failure', async () => {
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockRejectedValueOnce(new Error('sales search transport'));
    render(<SalesReportsClient userRole="owner" />);
    await waitFor(() => expect(getSalesReportsAction).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText('ابحث برقم الفاتورة...'), { target: { value: 'S-500' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));

    await waitFor(() => expect(getSalesReportsAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ invoiceNumber: 'S-500' }),
    ));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تقرير المبيعات'));
    expect(screen.getByRole('button', { name: /بحث \(F\)/ })).toBeEnabled();
  });

  it('still loads the sales report when staff filter metadata throws', async () => {
    (getStaffAction as jest.Mock).mockRejectedValueOnce(new Error('staff metadata transport'));
    (getSalesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });

    render(<SalesReportsClient userRole="owner" />);

    await waitFor(() => expect(getSalesReportsAction).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('تعذر تحميل بعض فلاتر تقرير المبيعات');
    expect(screen.getByRole('button', { name: /بحث \(F\)/ })).toBeEnabled();
  });

  it('still loads the purchases report when supplier filter metadata throws', async () => {
    (getSuppliersAction as jest.Mock).mockRejectedValueOnce(new Error('supplier metadata transport'));
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });

    render(<PurchasesReportsClient userRole="owner" />);

    await waitFor(() => expect(getPurchasesReportsAction).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('تعذر تحميل بعض فلاتر تقرير المشتريات');
    expect(screen.getByRole('button', { name: /بحث في الفواتير/ })).toBeEnabled();
  });

  it('does not leave a false sales-detail modal open after a thrown item load and allows retry', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'sales-detail-1',
        patient_name: 'عميل تفاصيل المبيعات',
        staff_name: 'موظف',
        total_amount: 40,
        discount_amount: 0,
        payment_method: 'cash',
        created_at: '2026-09-21T10:00:00.000Z',
      }],
    });
    (getInvoiceDetailsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('sales details transport'))
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<SalesReportsClient userRole="owner" />);
    const row = (await screen.findByText('عميل تفاصيل المبيعات')).closest('tr') as HTMLElement;
    fireEvent.click(row);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تفاصيل الفاتورة'));
    expect(screen.queryByText('receipt-modal:sales-detail-1')).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(await screen.findByText('receipt-modal:sales-detail-1')).toBeInTheDocument();
  });

  it('does not leave a false purchase-detail pane open after a thrown item load and allows retry', async () => {
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'purchase-detail-1',
        invoice_number: 'PUR-DETAIL-1',
        supplier_name: 'مورد التفاصيل',
        total_amount: 80,
        discount_amount: 0,
        payment_method: 'cash',
        created_at: '2026-09-21T10:00:00.000Z',
      }],
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('purchase details transport'))
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<PurchasesReportsClient userRole="owner" />);
    const row = (await screen.findByText('مورد التفاصيل')).closest('tr') as HTMLElement;
    fireEvent.click(row);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تفاصيل فاتورة الشراء'));
    expect(screen.queryByText(/أصناف الفاتورة #/)).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(await screen.findByText(/أصناف الفاتورة #/)).toBeInTheDocument();
  });

  it('shows a retryable sales-dashboard stats error instead of stale loading labels', async () => {
    (getSalesDashboardStatsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('stats transport'))
      .mockResolvedValueOnce({
        success: true,
        data: {
          todaySales: 123,
          salesChangeText: 'مقارنة ناجحة',
          deliveryCount: 2,
          pendingDeliveryCountText: 'طلبان',
          averageInvoice: 61.5,
          averageInvoiceChangeText: 'متوسط صحيح',
        },
      });

    render(<SalesDashboardPage />);

    expect(await screen.findByText('تعذر تحميل إحصائيات المبيعات')).toBeInTheDocument();
    expect(screen.queryByText('تحميل البيانات...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('123')).toBeInTheDocument();
    expect(screen.getByText('مقارنة ناجحة')).toBeInTheDocument();
  });

  it('keeps the newest sales-dashboard stats retry when same-tick retries resolve out of order', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    (getSalesDashboardStatsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('initial stats failure'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<SalesDashboardPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getSalesDashboardStatsAction).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveNewer({
        success: true,
        data: {
          todaySales: 222,
          salesChangeText: 'newest stats',
          deliveryCount: 2,
          pendingDeliveryCountText: 'newest delivery',
          averageInvoice: 111,
          averageInvoiceChangeText: 'newest average',
        },
      });
    });
    expect(await screen.findByText('222')).toBeInTheDocument();
    expect(screen.getByText('newest stats')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        success: true,
        data: {
          todaySales: 111,
          salesChangeText: 'older stats',
          deliveryCount: 1,
          pendingDeliveryCountText: 'older delivery',
          averageInvoice: 55,
          averageInvoiceChangeText: 'older average',
        },
      });
    });
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.queryByText('older stats')).not.toBeInTheDocument();
  });

  it('shows a retryable reports-dashboard error instead of zero-value charts after a failed load', async () => {
    (getReportsDataAction as jest.Mock)
      .mockRejectedValueOnce(new Error('reports transport'))
      .mockResolvedValueOnce({
        success: true,
        data: {
          salesHistoryRaw: [{ created_at: new Date().toISOString(), total_amount: 55 }],
          topDrugsRaw: [{ trade_name: 'Panadol', quantity_sold: 2 }],
          categoryRaw: [{ category: 'مسكنات', quantity_sold: 2 }],
        },
      });

    render(<ReportsPage />);

    expect(await screen.findByText('تعذر تحميل بيانات التقارير')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('التقارير والتحليلات')).toBeInTheDocument();
    expect(screen.getByText('sales-charts:Panadol')).toBeInTheDocument();
  });

  it('suppresses a stale same-tick reports-dashboard retry before it can own report data', async () => {
    let resolveLatest!: (value: unknown) => void;
    (getReportsDataAction as jest.Mock)
      .mockRejectedValueOnce(new Error('initial reports failure'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveLatest = resolve; }));

    render(<ReportsPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(getReportsDataAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveLatest({
        success: true,
        data: {
          salesHistoryRaw: [
            { created_at: new Date().toISOString(), total_amount: 70 },
            { created_at: new Date().toISOString(), total_amount: 30 },
          ],
          topDrugsRaw: [{ trade_name: 'Newest Drug', quantity_sold: 3 }],
          categoryRaw: [],
        },
      });
    });
    expect(await screen.findByText('sales-charts:Newest Drug')).toBeInTheDocument();
    expect(screen.getByText('2 عملية')).toBeInTheDocument();
  });

  it('does not keep a stale authorized reports session when retry finds no current session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ role: 'owner', permissions: { rep_can_view_sales: true } })
      .mockResolvedValueOnce(null);
    (getReportsDataAction as jest.Mock).mockRejectedValueOnce(new Error('reports transport'));

    render(<ReportsPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retryButton);

    expect(await screen.findByText('غير مصرح لك بالوصول')).toBeInTheDocument();
    expect(screen.queryByText('التقارير والتحليلات')).not.toBeInTheDocument();
  });

  it('filters PurchaseReportsClient locally and opens the filtered invoice details from Enter', async () => {
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'purchase-a',
          invoice_number: 'INV-A',
          supplier_name: 'Alpha Supplier',
          drug_names: 'Panadol Extra',
          status: 'completed',
          total_amount: 100,
          created_at: '2026-09-21',
        },
        {
          id: 'purchase-b',
          invoice_number: 'INV-B',
          supplier_name: 'Beta Supplier',
          drug_names: 'Cataflam',
          status: 'draft',
          total_amount: 50,
          created_at: '2026-09-21',
        },
      ],
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'line-a',
        trade_name: 'Panadol Extra',
        quantity: 2,
        cost_price: 10,
        selling_price: 15,
        unit_id: 1,
      }],
    });

    render(<PurchaseReportsClient />);
    expect(await screen.findByText('INV-A')).toBeInTheDocument();
    expect(screen.getByText('INV-B')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('بحث باسم الصنف / الدواء...'), {
      target: { value: 'Panadol' },
    });
    expect(screen.getByText('INV-A')).toBeInTheDocument();
    expect(screen.queryByText('INV-B')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } });
    const row = screen.getByText('INV-A').closest('tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });

    await waitFor(() => expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledWith('purchase-a'));
    expect(await screen.findByRole('heading', { name: 'فاتورة شراء INV-A' })).toBeInTheDocument();
    expect(screen.getAllByText('Panadol Extra').length).toBeGreaterThan(0);
  });

  it('preserves the purchase-invoice modal when delete is cancelled or throws', async () => {
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'purchase-delete',
        invoice_number: 'INV-DELETE',
        supplier_name: 'Delete Supplier',
        status: 'completed',
        total_amount: 100,
        created_at: '2026-09-21',
      }],
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (deletePurchaseInvoiceAction as jest.Mock).mockRejectedValueOnce(new Error('delete transport'));
    window.confirm = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<PurchaseReportsClient />);
    const row = (await screen.findByText('INV-DELETE')).closest('tr') as HTMLElement;
    fireEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'فاتورة شراء INV-DELETE' })).toBeInTheDocument();

    const deleteRecord = screen.getByRole('button', { name: /حذف السجل فقط/ });
    fireEvent.click(deleteRecord);
    expect(deletePurchaseInvoiceAction).not.toHaveBeenCalled();

    fireEvent.click(deleteRecord);
    await waitFor(() => expect(deletePurchaseInvoiceAction).toHaveBeenCalledWith('purchase-delete', false));
    expect(toast.error).toHaveBeenCalledWith('فشل حذف فاتورة الشراء');
    expect(screen.getByRole('heading', { name: 'فاتورة شراء INV-DELETE' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /حذف السجل فقط/ })).toBeEnabled();
  });
});
