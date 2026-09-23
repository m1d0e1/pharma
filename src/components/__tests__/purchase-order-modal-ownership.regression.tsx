import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseOrderModal from '@/components/inventory/PurchaseOrderModal';
import { createPurchaseOrderAction, getSuppliersAction } from '@/app/actions-client/purchases';

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

describe('purchase-order modal ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('keeps the modal open when Cancel is clicked while order persistence is pending', async () => {
    let resolveCreate!: (value: { success: boolean; error?: string }) => void;
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveCreate = resolve;
    });
    (createPurchaseOrderAction as jest.Mock).mockReturnValue(pending);
    const onClose = jest.fn();

    render(
      <PurchaseOrderModal
        initialItems={[{
          drug_id: 50,
          trade_name: 'فيتامين سي 1000',
          requested_quantity: 12,
          last_cost_price: 30,
        }]}
        onClose={onClose}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('اختر أو اكتب اسم المورد...'), { target: { value: 'المورد' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ وإرسال الأمر/ }));
    await waitFor(() => expect(createPurchaseOrderAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('إنشاء أمر شراء جديد')).toBeInTheDocument();

    await act(async () => {
      resolveCreate({ success: false, error: 'تعذر الحفظ' });
      await pending;
    });
  });
});
