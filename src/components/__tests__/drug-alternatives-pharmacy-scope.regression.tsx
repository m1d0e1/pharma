import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DrugAlternativesClient from '@/components/inventory/DrugAlternativesClient';
import { dbSelect } from '@/lib/db/tauri';

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbExecute: jest.fn().mockResolvedValue({ rowsAffected: 1 }),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'owner', pharmacy_id: 'ph-1' }),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
  Toaster: () => null,
}));

describe('DrugAlternativesClient branch stock scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM master_drugs')) {
        return [{ id: 10, trade_name: 'Drug A', active_ingredient: 'ING-A' }];
      }
      return [];
    });
  });

  it('keeps alternatives chain-wide while scoping total_stock to the signed-in pharmacy', async () => {
    render(<DrugAlternativesClient />);

    fireEvent.change(screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...'), {
      target: { value: 'Drug' },
    });
    const result = await screen.findByText('Drug A');
    fireEvent.click(result.closest('button')!);

    await waitFor(() => expect((dbSelect as jest.Mock).mock.calls.some(([sql]) =>
      String(sql).includes('(SELECT SUM(quantity) FROM inventory')
    )).toBe(true));

    const stockCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('(SELECT SUM(quantity) FROM inventory')
    );
    expect(String(stockCall![0])).toContain("pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default')");
    expect(stockCall![1]).toEqual(['ING-A', 'ph-1', 'ph-1', 'ING-A', 10, 10, 10]);
  });
});
