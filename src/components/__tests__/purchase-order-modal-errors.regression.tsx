import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseOrderModal from '@/components/inventory/PurchaseOrderModal';
import {
  createPurchaseOrderAction,
  getDrugInventoryQuantityAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));

jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseOrderAction: jest.fn(),
  getDrugInventoryQuantityAction: jest.fn(),
  getSuppliersAction: jest.fn(),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

describe('purchase-order modal async recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (createPurchaseOrderAction as jest.Mock).mockResolvedValue({ success: true, po_id: 'PO-1' });
    (getDrugInventoryQuantityAction as jest.Mock).mockResolvedValue({ success: true, data: 5 });
  });

  it('recovers from a rejected drug search and allows a later retry', async () => {
    (searchMasterDrugsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('catalog bridge unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 1, trade_name_en: 'Panadol', trade_name: 'بانادول', base_price: 10 }],
      });

    render(<PurchaseOrderModal initialItems={[]} onClose={jest.fn()} />);

    const search = screen.getByPlaceholderText('ابحث عن دواء بالاسم التجاري أو المادة الفعالة...');
    fireEvent.change(search, { target: { value: 'pan' } });

    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledTimes(1), { timeout: 1000 });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل البحث عن الأصناف'));

    fireEvent.change(search, { target: { value: 'pana' } });
    expect(await screen.findByText('Panadol')).toBeInTheDocument();
    expect(searchMasterDrugsAction).toHaveBeenCalledTimes(2);
  });

  it('keeps a search result retryable when stock lookup rejects', async () => {
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 1, trade_name_en: 'Panadol', trade_name: 'بانادول', base_price: 10 }],
    });
    (getDrugInventoryQuantityAction as jest.Mock)
      .mockRejectedValueOnce(new Error('stock bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: 7 });

    render(<PurchaseOrderModal initialItems={[]} onClose={jest.fn()} />);

    const search = screen.getByPlaceholderText('ابحث عن دواء بالاسم التجاري أو المادة الفعالة...');
    fireEvent.change(search, { target: { value: 'pana' } });
    const result = await screen.findByText('Panadol');
    fireEvent.click(result.closest('button') as HTMLButtonElement);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل رصيد الصنف'));
    expect(screen.getByText('Panadol')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Panadol').closest('button') as HTMLButtonElement);
    await waitFor(() => expect(getDrugInventoryQuantityAction).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const tableDrug = screen.getAllByText('Panadol').find(node => node.closest('tr'));
      expect(tableDrug?.closest('tr')).toHaveTextContent('7.00');
    });
  });

  it('blocks same-tick duplicate result clicks while the first stock lookup is pending', async () => {
    let resolveStock!: (value: { success: boolean; data: number }) => void;
    const pendingStock = new Promise<{ success: boolean; data: number }>(resolve => {
      resolveStock = resolve;
    });
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 1, trade_name_en: 'Panadol', trade_name: 'بانادول', base_price: 10 }],
    });
    (getDrugInventoryQuantityAction as jest.Mock).mockReturnValue(pendingStock);

    render(<PurchaseOrderModal initialItems={[]} onClose={jest.fn()} />);
    const search = screen.getByPlaceholderText('ابحث عن دواء بالاسم التجاري أو المادة الفعالة...');
    fireEvent.change(search, { target: { value: 'pana' } });
    const result = await screen.findByText('Panadol');
    const resultButton = result.closest('button') as HTMLButtonElement;

    act(() => {
      fireEvent.click(resultButton);
      fireEvent.click(resultButton);
    });

    expect(getDrugInventoryQuantityAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveStock({ success: true, data: 7 }));
    await waitFor(() => expect(screen.getAllByText('Panadol').filter(node => node.closest('tr'))).toHaveLength(1));
  });

  it('blocks repeated form submission while purchase-order creation is pending', async () => {
    let resolveCreate: (value: { success: boolean; po_id?: string; error?: string }) => void = () => {};
    (createPurchaseOrderAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveCreate = resolve;
    }));

    const { container } = render(
      <PurchaseOrderModal
        initialItems={[{
          drug_id: 50,
          trade_name: 'Vitamin C',
          requested_quantity: 4,
          last_cost_price: 12,
          current_stock: 1,
        }]}
        onClose={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('اختر أو اكتب اسم المورد...'), {
      target: { value: 'مورد الاختبار' },
    });
    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(createPurchaseOrderAction).toHaveBeenCalled());
    expect(createPurchaseOrderAction).toHaveBeenCalledTimes(1);

    resolveCreate({ success: false, error: 'تعذر إنشاء الطلب' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر إنشاء الطلب'));
  });
});
