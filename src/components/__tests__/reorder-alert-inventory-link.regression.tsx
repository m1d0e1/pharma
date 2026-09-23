import { act, fireEvent, render, screen } from '@testing-library/react';
import ReorderAlerts from '@/components/dashboard/ReorderAlerts';
import { getLowStockAction } from '@/app/actions-client/inventory';

jest.mock('@/app/actions-client/inventory', () => ({
  getLowStockAction: jest.fn(),
}));
jest.mock('@/app/actions-client/shortages', () => ({
  addToShortagesAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('reorder alert inventory link', () => {
  it('keeps fractional stock and opens the exact drug when names are duplicated', async () => {
    (getLowStockAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { drug_id: 417, trade_name_en: 'Duplicate drug', quantity: 0, reorder_point: 10, deficit: 10 },
        { drug_id: 429, trade_name_en: 'Duplicate drug', quantity: 0.5, reorder_point: 10, deficit: 9.5 },
      ],
    });

    render(<ReorderAlerts />);

    expect(await screen.findByText('المخزون: 0.5')).toBeInTheDocument();
    const links = await screen.findAllByTitle('عرض في المخزون');
    expect(links[0]).toHaveAttribute('href', '/inventory?drugId=417&search=Duplicate%20drug');
    expect(links[1]).toHaveAttribute('href', '/inventory?drugId=429&search=Duplicate%20drug');
  });

  it('uses the canonical stock field and refreshes after inventory changes', async () => {
    (getLowStockAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [
          { drug_id: 1556, trade_name_en: 'ARTHINEUR 10 CAPS.', current_stock: 0, reorder_point: 10, deficit: 10 },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [
          { drug_id: 1556, trade_name_en: 'ARTHINEUR 10 CAPS.', current_stock: 2, quantity: 0, reorder_point: 10, deficit: 8 },
        ],
      });

    render(<ReorderAlerts />);

    expect(await screen.findByText('المخزون: 0')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('inventory-alerts-refresh'));
    });

    expect(await screen.findByText('المخزون: 2')).toBeInTheDocument();
    expect(getLowStockAction).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a reorder-alert load failure from healthy stock and retries', async () => {
    (getLowStockAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'low stock unavailable' })
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<ReorderAlerts />);

    expect(await screen.findByText('تعذر تحميل تنبيهات إعادة الطلب')).toBeInTheDocument();
    expect(screen.queryByText('المخزون ممتاز ✅')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('المخزون ممتاز ✅')).toBeInTheDocument();
    expect(getLowStockAction).toHaveBeenCalledTimes(2);
  });

  it('keeps the last valid reorder alerts visible when a background refresh fails, then retries in place', async () => {
    (getLowStockAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{ drug_id: 88, trade_name_en: 'Keep Visible Drug', current_stock: 1, reorder_point: 10, deficit: 9 }],
      })
      .mockResolvedValueOnce({ success: false, error: 'refresh unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ drug_id: 88, trade_name_en: 'Keep Visible Drug', current_stock: 3, reorder_point: 10, deficit: 7 }],
      });

    render(<ReorderAlerts />);
    expect(await screen.findByText('المخزون: 1')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event('inventory-alerts-refresh'));
    });

    expect(await screen.findByText('تعذر تحديث تنبيهات إعادة الطلب')).toBeInTheDocument();
    expect(screen.getByText('Keep Visible Drug')).toBeInTheDocument();
    expect(screen.getByText('المخزون: 1')).toBeInTheDocument();
    expect(screen.queryByText('تعذر تحميل تنبيهات إعادة الطلب')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل تنبيهات إعادة الطلب' }));
    expect(await screen.findByText('المخزون: 3')).toBeInTheDocument();
    expect(getLowStockAction).toHaveBeenCalledTimes(3);
  });

  it('keeps reorder alerts owned by the newest background refresh when an older refresh resolves later', async () => {
    let resolveOlder!: (value: any) => void;
    let resolveNewer!: (value: any) => void;
    (getLowStockAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{ drug_id: 99, trade_name_en: 'Race Drug', current_stock: 1, reorder_point: 10, deficit: 9 }],
      })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<ReorderAlerts />);
    expect(await screen.findByText('المخزون: 1')).toBeInTheDocument();

    window.dispatchEvent(new Event('inventory-alerts-refresh'));
    await act(async () => Promise.resolve());
    window.dispatchEvent(new Event('inventory-alerts-refresh'));
    await act(async () => Promise.resolve());
    expect(getLowStockAction).toHaveBeenCalledTimes(3);

    await act(async () => resolveNewer({
      success: true,
      data: [{ drug_id: 99, trade_name_en: 'Race Drug', current_stock: 5, reorder_point: 10, deficit: 5 }],
    }));
    expect(await screen.findByText('المخزون: 5')).toBeInTheDocument();

    await act(async () => resolveOlder({
      success: true,
      data: [{ drug_id: 99, trade_name_en: 'Race Drug', current_stock: 2, reorder_point: 10, deficit: 8 }],
    }));

    expect(screen.getByText('المخزون: 5')).toBeInTheDocument();
    expect(screen.queryByText('المخزون: 2')).not.toBeInTheDocument();
  });
});
