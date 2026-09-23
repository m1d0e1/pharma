import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HeaderAlerts from '@/components/HeaderAlerts';
import { getInventoryAlertsAction } from '@/app/actions-client/inventory';

jest.mock('@/app/actions-client/inventory', () => ({
  getInventoryAlertsAction: jest.fn(),
}));

jest.mock('next/link', () => function LinkStub({ href, children, onClick }: any) {
  return <a href={href} onClick={onClick}>{children}</a>;
});

describe('dashboard HeaderAlerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('distinguishes a returned load failure from an empty alert list and retries', async () => {
    (getInventoryAlertsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'alerts unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          alerts: [{ id: 'drug-1', alert_type: 'low_stock', trade_name_en: 'Panadol', quantity: 1 }],
        },
      });

    render(<HeaderAlerts />);
    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('تعذر تحميل التنبيهات')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد تنبيهات حالياً')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('Panadol')).toBeInTheDocument();
    expect(getInventoryAlertsAction).toHaveBeenCalledTimes(2);
  });

  it('recovers from a thrown initial alert load without leaving the dropdown spinner stuck', async () => {
    (getInventoryAlertsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: { alerts: [] } });

    render(<HeaderAlerts />);
    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('تعذر تحميل التنبيهات')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    await waitFor(() => expect(screen.getByText('لا توجد تنبيهات حالياً')).toBeInTheDocument());
  });

  it('keeps the newest alert refresh when an older request resolves later', async () => {
    let resolveOlder: (value: any) => void = () => {};
    let resolveNewer: (value: any) => void = () => {};
    (getInventoryAlertsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<HeaderAlerts />);
    await waitFor(() => expect(getInventoryAlertsAction).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('inventory-alerts-refresh'));
    });
    await waitFor(() => expect(getInventoryAlertsAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({
        success: true,
        data: { alerts: [{ id: 'new', alert_type: 'low_stock', trade_name_en: 'Newest Alert', quantity: 2 }] },
      });
    });
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Newest Alert')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        success: true,
        data: { alerts: [{ id: 'old', alert_type: 'low_stock', trade_name_en: 'Stale Alert', quantity: 1 }] },
      });
    });

    expect(screen.getByText('Newest Alert')).toBeInTheDocument();
    expect(screen.queryByText('Stale Alert')).not.toBeInTheDocument();
  });
});
