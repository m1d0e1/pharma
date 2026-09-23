import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReturnsClient from '@/components/returns/ReturnsClient';
import { getReturnsAction } from '@/app/actions-client/returns';
import { getPurchaseReturnDetailsAction, getPurchaseReturnsAction } from '@/app/actions-client/purchases';

jest.mock('next/link', () => function MockLink({ href, children, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});

jest.mock('@/app/actions-client/returns', () => ({
  getReturnsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  getPurchaseReturnsAction: jest.fn(),
  getPurchaseReturnDetailsAction: jest.fn(),
}));

const salesReturn = {
  id: 'sales-return-12345678',
  invoice_id: 'invoice-sales-12345678',
  patient_name: 'عميل مرتجع',
  user_name: 'د. أحمد',
  total_refund: 45,
  created_at: '2026-09-21T11:00:00',
  refund_method: 'cash',
  status: 'completed',
  items: [{ id: 1, drug_name: 'دواء مرتجع', quantity_returned: 1, unit: 'large', unit_price: 45 }],
};

const purchaseReturn = {
  id: 'purchase-return-12345678',
  purchase_invoice_id: 'purchase-invoice-12345678',
  invoice_number: 'PINV-77',
  supplier_name: 'مورد الاختبار',
  created_by_name: 'د. سارة',
  total_amount: 70,
  created_at: '2026-09-21T12:00:00',
};

describe('returns-list UI behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getReturnsAction as jest.Mock).mockResolvedValue({ success: true, data: [salesReturn] });
    (getPurchaseReturnsAction as jest.Mock).mockResolvedValue({ success: true, data: [purchaseReturn] });
  });

  it('searches sales returns, exposes the correct new-return route, opens details with Enter, and closes the modal', async () => {
    render(<ReturnsClient title="مرتجعات العملاء" type="sales" />);

    expect(await screen.findByText('عميل مرتجع')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /إضافة مرتجع/ })).toHaveAttribute('href', '/returns/new');

    const search = screen.getByPlaceholderText('بحث برقم المرتجع أو الفاتورة...');
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('لا توجد مرتجعات')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'invoice-sales' } });

    const row = screen.getByText('عميل مرتجع').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'تفاصيل مرتجع المبيعات' })).toBeInTheDocument();
    expect(screen.getByText('دواء مرتجع')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(screen.queryByRole('heading', { name: 'تفاصيل مرتجع المبيعات' })).not.toBeInTheDocument();
  });

  it('loads purchase-return details from a keyboard-selected row and renders returned line metadata', async () => {
    let resolveDetails: (value: any) => void = () => {};
    (getPurchaseReturnDetailsAction as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveDetails = resolve; }));

    render(<ReturnsClient title="مرتجعات الموردين" type="purchases" />);

    expect(await screen.findByText('مورد الاختبار')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /إضافة مرتجع/ })).toHaveAttribute('href', '/purchases/returns/new');
    const row = screen.getByText('مورد الاختبار').closest('tr');
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' });

    expect(screen.getByText('جاري تحميل تفاصيل المرتجع...')).toBeInTheDocument();
    expect(getPurchaseReturnDetailsAction).toHaveBeenCalledWith('purchase-return-12345678');

    resolveDetails({
      success: true,
      data: {
        ...purchaseReturn,
        supplier_phone: '01234567890',
        invoice_date: '2026-09-20',
        invoice_total: 140,
        refund_method: 'supplier_account',
        items: [{
          id: 2,
          drug_name: 'Purchase Return Drug',
          quantity_returned: 2,
          unit: 'large',
          unit_price: 35,
          batch_number: 'LOT-7',
          expiry_date: '2027-12-31',
        }],
      },
    });

    expect(await screen.findByRole('heading', { name: 'تفاصيل مرتجع المشتريات' })).toBeInTheDocument();
    expect(screen.getByText('LOT-7')).toBeInTheDocument();
    expect(screen.getByText('2027-12-31')).toBeInTheDocument();
  });

  it('shows a retryable list error instead of a successful empty state when loading fails', async () => {
    (getReturnsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'تعذر تحميل المرتجعات' });
    render(<ReturnsClient title="مرتجعات العملاء" type="sales" />);

    expect(await screen.findByText('تعذر تحميل المرتجعات')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد مرتجعات')).not.toBeInTheDocument();

    (getReturnsAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [salesReturn] });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('عميل مرتجع')).toBeInTheDocument();
  });

  it('surfaces purchase-detail failure instead of silently ignoring a selected return', async () => {
    (getPurchaseReturnDetailsAction as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر تحميل تفاصيل المرتجع' });
    render(<ReturnsClient title="مرتجعات الموردين" type="purchases" />);

    fireEvent.click((await screen.findByText('مورد الاختبار')).closest('tr') as HTMLElement);

    expect(await screen.findByText('تعذر تحميل تفاصيل المرتجع')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'تفاصيل مرتجع المشتريات' })).not.toBeInTheDocument();
  });

  it('keeps the newest purchase-return details when an older row request resolves afterwards', async () => {
    const secondPurchaseReturn = {
      ...purchaseReturn,
      id: 'purchase-return-87654321',
      invoice_number: 'PINV-88',
      supplier_name: 'المورد الأحدث',
    };
    (getPurchaseReturnsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [purchaseReturn, secondPurchaseReturn],
    });
    let resolveOlder!: (value: any) => void;
    let resolveNewer!: (value: any) => void;
    (getPurchaseReturnDetailsAction as jest.Mock).mockImplementation((id: string) => new Promise(resolve => {
      if (id === purchaseReturn.id) resolveOlder = resolve;
      if (id === secondPurchaseReturn.id) resolveNewer = resolve;
    }));

    render(<ReturnsClient title="مرتجعات الموردين" type="purchases" />);
    const olderRow = (await screen.findByText('مورد الاختبار')).closest('tr') as HTMLElement;
    const newerRow = screen.getByText('المورد الأحدث').closest('tr') as HTMLElement;
    fireEvent.click(olderRow);
    fireEvent.click(newerRow);
    await waitFor(() => expect(getPurchaseReturnDetailsAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({
        success: true,
        data: {
          ...secondPurchaseReturn,
          items: [{ id: 22, drug_name: 'Newest Return Item', quantity_returned: 1, unit_price: 22 }],
        },
      });
    });
    expect(await screen.findByText('Newest Return Item')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        success: true,
        data: {
          ...purchaseReturn,
          items: [{ id: 11, drug_name: 'Stale Return Item', quantity_returned: 1, unit_price: 11 }],
        },
      });
    });

    expect(screen.getByText('Newest Return Item')).toBeInTheDocument();
    expect(screen.queryByText('Stale Return Item')).not.toBeInTheDocument();
  });

  it('keeps a newer successful returns retry when an older retry fails afterwards', async () => {
    let resolveOlder!: (value: any) => void;
    let resolveNewer!: (value: any) => void;
    const older = new Promise(resolve => { resolveOlder = resolve; });
    const newer = new Promise(resolve => { resolveNewer = resolve; });
    (getReturnsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'initial unavailable' })
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);

    render(<ReturnsClient title="مرتجعات العملاء" type="sales" />);
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(getReturnsAction).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveNewer({ success: true, data: [{ ...salesReturn, id: 'sales-return-newest', patient_name: 'أحدث مرتجع' }] });
      await newer;
    });
    expect(await screen.findByText('أحدث مرتجع')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: false, error: 'older unavailable' });
      await older;
    });

    expect(screen.getByText('أحدث مرتجع')).toBeInTheDocument();
    expect(screen.queryByText('older unavailable')).not.toBeInTheDocument();
  });
});
