import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeliveryManagementClient from '@/components/sales/DeliveryManagementClient';
import { closeDeliveryInvoiceAction, getPendingDeliveriesAction } from '@/app/actions-client/delivery';
import toast from 'react-hot-toast';

jest.mock('@/app/actions-client/delivery', () => ({
  getPendingDeliveriesAction: jest.fn(),
  closeDeliveryInvoiceAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const delivery = {
  id: 'delivery-12345678',
  total_amount: 120,
  created_at: '2026-09-21T10:00:00.000Z',
  patient_name: 'عميل التوصيل',
  patient_phone: '01000000000',
  patient_address: 'عنوان الاختبار',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('delivery management UI flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getPendingDeliveriesAction as jest.Mock).mockResolvedValue({ success: true, data: [delivery] });
  });

  it('passes the entered delivery fee, keeps the invoice after action failure, and removes it after success reload', async () => {
    (closeDeliveryInvoiceAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'لا توجد وردية مفتوحة' })
      .mockResolvedValueOnce({ success: true });

    render(<DeliveryManagementClient />);

    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();
    const fee = screen.getByPlaceholderText('0.00');
    fireEvent.change(fee, { target: { value: '15.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق وتأكيد' }));

    await waitFor(() => expect(closeDeliveryInvoiceAction).toHaveBeenCalledWith('delivery-12345678', 15.5));
    expect(toast.error).toHaveBeenCalledWith('لا توجد وردية مفتوحة');
    expect(screen.getByText('عميل التوصيل')).toBeInTheDocument();

    (getPendingDeliveriesAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [] });
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق وتأكيد' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تم إغلاق الفاتورة وتأكيد التوصيل'));
    expect(await screen.findByText('لا توجد طلبات توصيل معلقة')).toBeInTheDocument();
  });

  it('renders the successful empty state only for a successful empty load', async () => {
    (getPendingDeliveriesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    render(<DeliveryManagementClient />);

    expect(await screen.findByText('لا توجد طلبات توصيل معلقة')).toBeInTheDocument();
    expect(screen.getByText('تم إغلاق جميع فواتير التوصيل المنزلي بنجاح')).toBeInTheDocument();
  });

  it('shows a retryable load error instead of misreporting a failed query as an empty delivery queue', async () => {
    (getPendingDeliveriesAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'تعذر تحميل فواتير التوصيل' });
    render(<DeliveryManagementClient />);

    expect(await screen.findByText('تعذر تحميل فواتير التوصيل')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد طلبات توصيل معلقة')).not.toBeInTheDocument();

    (getPendingDeliveriesAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [delivery] });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();
  });

  it('keeps the newest delivery reload when an older request resolves later', async () => {
    render(<DeliveryManagementClient />);
    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();

    const older = deferred<any>();
    const newer = deferred<any>();
    const oldDelivery = { ...delivery, id: 'delivery-old-1234', patient_name: 'Older Delivery' };
    const newDelivery = { ...delivery, id: 'delivery-new-1234', patient_name: 'Newer Delivery' };
    (getPendingDeliveriesAction as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const refresh = screen.getAllByRole('button')[0];
    fireEvent.click(refresh);
    await waitFor(() => expect(getPendingDeliveriesAction).toHaveBeenCalledTimes(2));
    fireEvent.click(refresh);
    await waitFor(() => expect(getPendingDeliveriesAction).toHaveBeenCalledTimes(3));

    newer.resolve({ success: true, data: [newDelivery] });
    expect(await screen.findByText('Newer Delivery')).toBeInTheDocument();

    await act(async () => {
      older.resolve({ success: true, data: [oldDelivery] });
      await older.promise;
    });
    expect(screen.queryByText('Older Delivery')).not.toBeInTheDocument();
    expect(screen.getByText('Newer Delivery')).toBeInTheDocument();
  });

  it('does not close the same invoice twice while the first close is pending', async () => {
    const pending = deferred<any>();
    (closeDeliveryInvoiceAction as jest.Mock).mockImplementation(() => pending.promise);
    render(<DeliveryManagementClient />);

    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'إغلاق وتأكيد' });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '9' } });
    fireEvent.click(close);
    fireEvent.click(close);

    expect(closeDeliveryInvoiceAction).toHaveBeenCalledTimes(1);
    pending.resolve({ success: false, error: 'stop' });
    await waitFor(() => expect(close).not.toBeDisabled());
  });

  it('keeps each invoice locked while multiple delivery closes are pending concurrently', async () => {
    const secondDelivery = { ...delivery, id: 'delivery-87654321', patient_name: 'عميل توصيل ثان' };
    const firstPending = deferred<any>();
    const secondPending = deferred<any>();
    (getPendingDeliveriesAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [delivery, secondDelivery] });
    (closeDeliveryInvoiceAction as jest.Mock).mockImplementation((id: string) => (
      id === delivery.id ? firstPending.promise : secondPending.promise
    ));

    render(<DeliveryManagementClient />);
    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();
    expect(screen.getByText('عميل توصيل ثان')).toBeInTheDocument();

    const closeButtons = screen.getAllByRole('button', { name: 'إغلاق وتأكيد' });
    fireEvent.click(closeButtons[0]);
    fireEvent.click(closeButtons[1]);

    expect(closeDeliveryInvoiceAction).toHaveBeenCalledTimes(2);
    expect(closeButtons[0]).toBeDisabled();
    expect(closeButtons[1]).toBeDisabled();

    fireEvent.click(closeButtons[0]);
    fireEvent.click(closeButtons[1]);
    expect(closeDeliveryInvoiceAction).toHaveBeenCalledTimes(2);

    await act(async () => {
      firstPending.resolve({ success: false, error: 'stop first' });
      secondPending.resolve({ success: false, error: 'stop second' });
      await Promise.all([firstPending.promise, secondPending.promise]);
    });
  });

  it('recovers the close control and preserves the entered fee when the close action throws', async () => {
    (closeDeliveryInvoiceAction as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    render(<DeliveryManagementClient />);

    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();
    const fee = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    const close = screen.getByRole('button', { name: 'إغلاق وتأكيد' });
    fireEvent.change(fee, { target: { value: '13.5' } });
    fireEvent.click(close);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل إغلاق الفاتورة'));
    expect(close).not.toBeDisabled();
    expect(fee.value).toBe('13.5');
    expect(screen.getByText('عميل التوصيل')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a reload failure after a successful close without repeating the financial write', async () => {
    (closeDeliveryInvoiceAction as jest.Mock).mockResolvedValueOnce({ success: true });
    (getPendingDeliveriesAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [delivery] })
      .mockResolvedValueOnce({ success: false, error: 'تعذر تحديث قائمة التوصيل' });
    render(<DeliveryManagementClient />);

    expect(await screen.findByText('عميل التوصيل')).toBeInTheDocument();
    const fee = screen.getByPlaceholderText('0.00');
    fireEvent.change(fee, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق وتأكيد' }));

    expect(await screen.findByText('تعذر تحديث قائمة التوصيل')).toBeInTheDocument();
    expect(closeDeliveryInvoiceAction).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('تم إغلاق الفاتورة وتأكيد التوصيل');
  });
});
