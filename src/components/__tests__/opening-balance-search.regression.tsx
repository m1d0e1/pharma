import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewOpeningBalanceClient from '@/app/(dashboard)/inventory/opening-balances/new/page';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/app/actions-client/inventory', () => ({ addOpeningBalanceAction: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({ searchMasterDrugsAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

describe('opening-balance drug search', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([12.5, 0])('submits known purchase cost %s from catalog search', async cost => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 77, trade_name_en: 'Panadol', purchase_price: cost, base_price: cost, official_price: 20 }] });
    (addOpeningBalanceAction as jest.Mock).mockResolvedValue({ success: true });
    render(<NewOpeningBalanceClient />);
    fireEvent.change(screen.getByPlaceholderText('ادخل اسم الدواء بالعربية أو الإنجليزية...'), { target: { value: 'Pana' } });
    fireEvent.click(await screen.findByText('Panadol'));
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), { target: { value: '2029-12-31' } });
    const costInput = screen.getByLabelText('سعر التكلفة (للعلبة)');
    expect(costInput).toHaveValue(cost);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' }));
    await waitFor(() => expect(addOpeningBalanceAction).toHaveBeenCalledWith({ drug_id: 77, quantity: 1, cost_price: cost, unit_price: 20, expiry_date: '2029-12-31' }));
  });

  it('leaves an unknown purchase cost blank until the user enters it explicitly', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 78, trade_name_en: 'Unknown Cost', purchase_price: null, base_price: 0, official_price: 20 }] });
    (addOpeningBalanceAction as jest.Mock).mockResolvedValue({ success: true });
    render(<NewOpeningBalanceClient />);
    fireEvent.change(screen.getByPlaceholderText('ادخل اسم الدواء بالعربية أو الإنجليزية...'), { target: { value: 'Unknown' } });
    fireEvent.click(await screen.findByText('Unknown Cost'));
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), { target: { value: '2029-12-31' } });
    expect(screen.getByLabelText('سعر التكلفة (للعلبة)')).toHaveValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' }));
    expect(addOpeningBalanceAction).not.toHaveBeenCalled();
  });

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
