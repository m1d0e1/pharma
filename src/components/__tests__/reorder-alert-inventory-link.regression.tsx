import { act, render, screen } from '@testing-library/react';
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
});
