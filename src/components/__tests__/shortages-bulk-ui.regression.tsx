import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShortagesClient from '@/app/(dashboard)/stores/shortages/ShortagesClient';
import {
  deleteShortagesBulkAction,
  updateShortagesStatusBulkAction,
  deleteShortageAction,
  updateShortageStatusAction,
  getShortagesAction,
} from '@/app/actions-client/shortages';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/app/actions-client/shortages', () => ({
  getShortagesAction: jest.fn(),
  syncLowStockToShortagesAction: jest.fn(),
  updateShortageStatusAction: jest.fn(),
  updateShortageQuantityAction: jest.fn(),
  deleteShortageAction: jest.fn(),
  deleteShortagesBulkAction: jest.fn(),
  updateShortagesStatusBulkAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('shortages multi-selection and bulk actions ui', () => {
  const mockInitialData = [
    {
      id: 101,
      drug_id: 1,
      trade_name: 'Panadol Extra',
      trade_name_en: 'Panadol Extra',
      status: 'pending',
      requested_quantity: 10,
      current_stock: 0,
      reorder_point: 5,
      deficit: 5,
      created_at: '2026-08-26T08:00:00Z',
    },
    {
      id: 102,
      drug_id: 2,
      trade_name: 'Augmentin 1g',
      trade_name_en: 'Augmentin 1g',
      status: 'pending',
      requested_quantity: 5,
      current_stock: 1,
      reorder_point: 10,
      deficit: 9,
      created_at: '2026-08-26T08:05:00Z',
    },
    {
      id: 103,
      drug_id: 3,
      trade_name: 'Cataflam 50mg',
      trade_name_en: 'Cataflam 50mg',
      status: 'ordered',
      requested_quantity: 20,
      current_stock: 0,
      reorder_point: 10,
      deficit: 10,
      created_at: '2026-08-26T08:10:00Z',
    },
  ];

  beforeEach(() => {
    mockPush.mockReset();
    window.confirm = jest.fn(() => true);
    (deleteShortagesBulkAction as jest.Mock).mockReset().mockResolvedValue({ success: true, count: 2 });
    (updateShortagesStatusBulkAction as jest.Mock).mockReset().mockResolvedValue({ success: true, count: 2 });
  });

  it('selects multiple drugs and performs bulk status update', async () => {
    render(<ShortagesClient initialData={mockInitialData} />);

    // Initially bulk actions bar is not shown
    expect(screen.queryByText(/يمكنك تطبيق إجراء جماعي/)).not.toBeInTheDocument();

    // Select all button
    const selectAllBtn = screen.getByRole('button', { name: /تحديد الكل/ });
    fireEvent.click(selectAllBtn);

    // Now bulk bar is visible with 3 items
    expect(await screen.findByText('تم تحديد 3 صنف')).toBeInTheDocument();

    // Click bulk mark as ordered
    const bulkOrderedBtn = screen.getByRole('button', { name: /تحويل لـ قيد الطلب/ });
    fireEvent.click(bulkOrderedBtn);

    await waitFor(() => {
      expect(updateShortagesStatusBulkAction).toHaveBeenCalledWith([101, 102, 103], 'ordered');
    });
  });

  it('selects specific drugs and performs bulk delete', async () => {
    render(<ShortagesClient initialData={mockInitialData} />);

    // Click individual item checkboxes for item 101 and 102
    const checkboxes = screen.getAllByTitle('تحديد الصنف');
    expect(checkboxes.length).toBe(3);

    fireEvent.click(checkboxes[0]); // Select 101
    fireEvent.click(checkboxes[1]); // Select 102

    expect(await screen.findByText('تم تحديد 2 صنف')).toBeInTheDocument();

    // Click bulk delete button
    const bulkDeleteBtn = screen.getByRole('button', { name: /حذف المحدد \(2\)/ });
    fireEvent.click(bulkDeleteBtn);

    await waitFor(() => {
      expect(deleteShortagesBulkAction).toHaveBeenCalledWith([101, 102]);
    });
  });

  it('converts selected drugs to purchase invoice draft', async () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    render(<ShortagesClient initialData={mockInitialData} />);

    const checkboxes = screen.getAllByTitle('تحديد الصنف');
    fireEvent.click(checkboxes[0]); // Select 101

    const bulkPurchaseBtn = await screen.findByRole('button', { name: /تحويل للمشتريات \(1\)/ });
    fireEvent.click(bulkPurchaseBtn);

    expect(setItemSpy).toHaveBeenCalledWith('shortages_to_purchase', expect.stringContaining('Panadol Extra'));
    expect(mockPush).toHaveBeenCalledWith('/purchases/new');
  });
});
