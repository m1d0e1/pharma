import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AddInventoryModal from '@/components/AddInventoryModal';
import InventoryTable from '@/components/inventory/InventoryTable';
import {
  addInventoryAction,
  deleteInventoryAction,
  updateInventoryAction,
} from '@/app/actions-client/inventory';
import {
  getAdjustmentReasonsAction,
  getUnitsAction,
  searchMasterDrugsAction,
} from '@/app/actions-client/master-drugs';
import { toast } from 'react-hot-toast';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-to-print', () => ({ useReactToPrint: jest.fn(() => jest.fn()) }));
jest.mock('@/lib/env', () => ({ isTauri: false, isClient: true }));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn(), generateId: jest.fn() }));
jest.mock('@/components/master-drugs/QuickAddDrugModal', () => () => null);
jest.mock('@/components/pos/DrugDetailsModal', () => function DrugDetails({ drugId }: { drugId: number }) {
  return <div role="dialog" aria-label="drug details">Details for drug {drugId}</div>;
});
jest.mock('@/app/actions-client/inventory', () => ({
  addInventoryAction: jest.fn(),
  deleteInventoryAction: jest.fn(),
  updateInventoryAction: jest.fn(),
  importInventoryWorkbookAction: jest.fn(),
  getPendingInventoryCreationsAction: jest.fn(),
  acknowledgePendingInventoryCreationAction: jest.fn(),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn(),
  getUnitsAction: jest.fn(),
  getAdjustmentReasonsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const catalogDrug = {
  id: 803,
  trade_name: 'Fractional Inventory Drug',
  trade_name_en: 'Fractional Inventory Drug',
  active_ingredient: 'Synthetic Ingredient',
  official_price: 36,
  large_unit: 'علبة',
  large_to_medium: 4,
  has_expiry: 1,
};

const stockDrug = {
  trade_name: 'Shared Lot Drug',
  trade_name_en: 'Shared Lot Drug',
  category: 'Synthetic',
  manufacturer: 'Test Manufacturer',
  active_ingredient: 'Synthetic Ingredient',
  large_to_medium: 4,
};

const lots = [
  {
    id: 'lot-expired-003', drug_id: 803, quantity: 2, expiry_date: '2020-01-01',
    strips_per_box: 4, local_selling_price: 36, cost_price: 18,
    barcode: 'LOT-EXPIRED-003', master_drugs: stockDrug,
  },
  {
    id: 'lot-fresh-004', drug_id: 803, quantity: 6, expiry_date: '2099-11-30',
    strips_per_box: 8, local_selling_price: 48, cost_price: 24,
    barcode: 'LOT-FRESH-004', master_drugs: stockDrug,
  },
];

function inventoryTable(canManageInventory: boolean, onRefresh = jest.fn()) {
  return <InventoryTable
    items={lots} searchTerm="" setSearchTerm={jest.fn()} onRefresh={onRefresh}
    pharmacyId="mock-pharmacy-only" canManageInventory={canManageInventory}
  />;
}

async function selectCatalogDrug() {
  fireEvent.change(screen.getByRole('textbox', { name: 'البحث عن صنف لإضافته للمخزون' }), {
    target: { value: 'Synthetic Ingredient' },
  });
  fireEvent.click(await screen.findByText('Fractional Inventory Drug'));
}

describe('QA background: rendered inventory lot, expiry, and unit workflows (mocked actions)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUnitsAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ name_ar: 'علبة' }, { name_ar: 'زجاجة' }],
    });
    (getAdjustmentReasonsAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ id: 7, name_ar: 'جرد فعلي' }, { id: 9, name_ar: 'تالف' }],
    });
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({ success: true, data: [catalogDrug] });
  });

  it('searches by active ingredient and saves the selected expiry lot as boxes plus fractional strips', async () => {
    (addInventoryAction as jest.Mock).mockResolvedValue({ success: true });
    const onSuccess = jest.fn();
    const onClose = jest.fn();
    render(<AddInventoryModal pharmacyId="mock-pharmacy-only" onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'البحث بالمادة الفعالة' }));
    await selectCatalogDrug();
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith({
      query: 'Synthetic Ingredient', searchByActiveIngredient: true,
    }));

    expect(screen.getByRole('combobox', { name: 'الوحدة الأساسية للمخزون' })).toHaveValue('علبة');
    expect(screen.getByRole('option', { name: 'زجاجة' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الكمية (علبة)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('الكمية (شريط)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/عدد الشرائط بالعلبة/), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), { target: { value: '2099-10-31' } });
    fireEvent.change(screen.getByLabelText('الباركود'), { target: { value: 'NEW-LOT-005' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ في المخزون' }));

    await waitFor(() => expect(addInventoryAction).toHaveBeenCalledWith({
      pharmacy_id: 'mock-pharmacy-only', drug_id: 803, quantity: 2.75,
      local_selling_price: 36, expiry_date: '2099-10-31', barcode: 'NEW-LOT-005',
      unit: 'علبة', large_to_medium: 4,
    }));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing box conversion, then switches to single-bottle entry without carrying strips', async () => {
    (addInventoryAction as jest.Mock).mockResolvedValue({ success: false, error: 'Synthetic lot policy refused' });
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ ...catalogDrug, large_to_medium: 1 }],
    });
    render(<AddInventoryModal pharmacyId="mock-pharmacy-only" onClose={jest.fn()} onSuccess={jest.fn()} />);
    await selectCatalogDrug();

    fireEvent.change(screen.getByLabelText('الكمية (شريط)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/عدد الشرائط بالعلبة/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), { target: { value: '2099-09-30' } });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ في المخزون' }).closest('form')!);
    expect(addInventoryAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يجب إدخال عدد الشرائط بالعلبة');

    fireEvent.change(screen.getByRole('combobox', { name: 'الوحدة الأساسية للمخزون' }), {
      target: { value: 'زجاجة' },
    });
    expect(screen.queryByLabelText('الكمية (شريط)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/عدد الشرائط بالعلبة/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الكمية (زجاجة)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ في المخزون' }));

    await waitFor(() => expect(addInventoryAction).toHaveBeenCalledWith(expect.objectContaining({
      drug_id: 803, unit: 'زجاجة', quantity: 2, large_to_medium: 1,
      expiry_date: '2099-09-30',
    })));
    expect(toast.error).toHaveBeenCalledWith('Synthetic lot policy refused');
  });

  it('keeps separate expiry warnings for each lot and hides mutation controls from a viewer', () => {
    const view = render(inventoryTable(false));
    const body = view.container.querySelector('tbody')!;
    expect(within(body).getAllByText('Shared Lot Drug')).toHaveLength(2);
    expect(within(body).getByText('منتهي الصلاحية')).toBeInTheDocument();
    expect(within(body).queryByText('قريب الانتهاء')).not.toBeInTheDocument();
    expect(within(body).getByText('LOT-EXPIRED-003')).toBeInTheDocument();
    expect(within(body).getByText('LOT-FRESH-004')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /تعديل Shared Lot Drug/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /حذف دفعة Shared Lot Drug/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'استيراد Excel' })).not.toBeInTheDocument();

    fireEvent.contextMenu(within(body).getByText('LOT-FRESH-004').closest('tr')!);
    expect(screen.queryByRole('button', { name: /تعديل الرصيد/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /حذف الصنف/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'عرض تفاصيل Shared Lot Drug' })[1]);
    expect(screen.getByRole('dialog', { name: 'drug details' })).toHaveTextContent('Details for drug 803');
    expect(deleteInventoryAction).not.toHaveBeenCalled();
  });

  it('edits only the clicked lot with its own conversion, requires a reason, then retries a rejected update', async () => {
    (updateInventoryAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic concurrent lot change' })
      .mockResolvedValueOnce({ success: true });
    const onRefresh = jest.fn();
    render(inventoryTable(true, onRefresh));
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل Shared Lot Drug' })[1]);
    expect(screen.getByRole('dialog', { name: 'تعديل الصنف' })).toBeInTheDocument();
    expect(screen.getByLabelText('عدد الشرائط بالعلبة')).toHaveValue(8);
    expect(screen.getByLabelText('الكمية المتوفرة')).toHaveValue(6);

    fireEvent.change(screen.getByLabelText('الكمية المتوفرة'), { target: { value: '5.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));
    expect(updateInventoryAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يجب اختيار سبب عند تعديل الكمية');

    expect(await screen.findByRole('option', { name: 'جرد فعلي' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /سبب التعديل/ }), { target: { value: '7' } });
    expect(screen.getByRole('combobox', { name: /سبب التعديل/ })).toHaveValue('7');
    fireEvent.change(screen.getByLabelText('عدد الشرائط بالعلبة'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), { target: { value: '2099-12-15' } });
    fireEvent.submit(screen.getByRole('button', { name: 'حفظ التغييرات' }).closest('form')!);
    const expectedLotUpdate = {
      id: 'lot-fresh-004', quantity: 5.5, expected_quantity: 6,
      local_selling_price: 48, expected_local_selling_price: 48,
      expiry_date: '2099-12-15', large_to_medium: 6, reason_id: 7,
    };
    await waitFor(() => expect(updateInventoryAction).toHaveBeenCalledWith(expectedLotUpdate));
    expect(await screen.findByRole('dialog', { name: 'تعديل الصنف' })).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Synthetic concurrent lot change');
    expect(onRefresh).not.toHaveBeenCalled();

    fireEvent.submit(screen.getByRole('button', { name: 'حفظ التغييرات' }).closest('form')!);
    await waitFor(() => expect(updateInventoryAction).toHaveBeenCalledTimes(2));
    expect((updateInventoryAction as jest.Mock).mock.calls[1][0]).toEqual(expectedLotUpdate);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'تعديل الصنف' })).not.toBeInTheDocument();
  });

  it('retries a rejected deletion of the selected expiry lot without deleting its sibling', async () => {
    (deleteInventoryAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic lot locked' })
      .mockResolvedValueOnce({ success: true });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onRefresh = jest.fn();
    try {
      render(inventoryTable(true, onRefresh));
      const deleteButtons = screen.getAllByRole('button', { name: 'حذف دفعة Shared Lot Drug' });
      fireEvent.click(deleteButtons[0]);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Synthetic lot locked'));
      expect(onRefresh).not.toHaveBeenCalled();

      fireEvent.click(deleteButtons[0]);
      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
      expect(deleteInventoryAction).toHaveBeenNthCalledWith(1, { id: 'lot-expired-003' });
      expect(deleteInventoryAction).toHaveBeenNthCalledWith(2, { id: 'lot-expired-003' });
      expect(confirm).toHaveBeenCalledTimes(2);
    } finally {
      confirm.mockRestore();
    }
  });
});
