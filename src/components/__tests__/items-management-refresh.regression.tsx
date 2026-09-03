import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ItemsManagementClient from '../inventory/ItemsManagementClient';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn().mockResolvedValue([]),
  dbExecute: jest.fn().mockResolvedValue({ rowsAffected: 0 }),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  addMasterDrugAction: jest.fn(),
  deleteMasterDrugAction: jest.fn(),
  updateMasterDrugAction: jest.fn(),
  searchMasterDrugsAction: jest.fn(),
}));

describe('ItemsManagementClient auto-refresh and total count regression', () => {
  const sampleItems: any[] = [
    {
      id: 1,
      trade_name: 'كونكور 5 مجم',
      trade_name_en: 'Concor 5mg',
      active_ingredient: 'Bisoprolol',
      barcode: '6221234567890',
      official_price: 35,
      manufacturer: 'Amoun',
      is_medicine: 1,
      is_service: 0,
      stop_dealing: 0,
    },
    {
      id: 2,
      trade_name: 'بنادول أزرق',
      trade_name_en: 'Panadol Blue',
      active_ingredient: 'Paracetamol',
      barcode: '6229876543210',
      official_price: 25,
      manufacturer: 'GSK',
      is_medicine: 1,
      is_service: 0,
      stop_dealing: 0,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: sampleItems,
    });
  });

  it('preserves initialItems on initial render and after debounce without wiping to 0', async () => {
    jest.useFakeTimers();

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);

    // Initial items are visible
    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();

    // Fast-forward past debounce timer (400ms)
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Verify items are STILL visible and not wiped to 0
    expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();

    // searchMasterDrugsAction was NOT called on clean initial load (initialItems preserved)
    expect(searchMasterDrugsAction).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('filters items when search term is entered and restores initialItems when cleared', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [sampleItems[0]], // Only Concor matches
    });

    render(<ItemsManagementClient initialItems={sampleItems} totalCount={100} />);

    const searchInput = screen.getByPlaceholderText(/Search by English Trade Name/i);

    // Type search
    fireEvent.change(searchInput, { target: { value: 'Concor' } });

    await waitFor(() => {
      expect(searchMasterDrugsAction).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'Concor' })
      );
    });

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } });

    // Initial items should be restored immediately without showing 0
    await waitFor(() => {
      expect(screen.getByText('Panadol Blue')).toBeInTheDocument();
      expect(screen.getByText('Concor 5mg')).toBeInTheDocument();
    });
  });
});
