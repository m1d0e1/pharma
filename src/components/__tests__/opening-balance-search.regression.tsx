import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewOpeningBalanceClient from '@/app/(dashboard)/inventory/opening-balances/new/page';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/app/actions-client/inventory', () => ({ addOpeningBalanceAction: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({ searchMasterDrugsAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

describe('opening-balance drug search', () => {
  it('searches the master catalog without depending on POS access', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 77, trade_name: 'بانادول', trade_name_en: 'Panadol', official_price: 20 }],
    });

    render(<NewOpeningBalanceClient />);
    fireEvent.change(screen.getByPlaceholderText('ادخل اسم الدواء بالعربية أو الإنجليزية...'), { target: { value: 'Pana' } });

    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith({
      query: 'Pana',
      searchByActiveIngredient: false,
      status: 'active',
    }));
    expect(await screen.findByText('Panadol')).toBeInTheDocument();
  });
});
