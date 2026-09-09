import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import QuickAddDrugModal from '../master-drugs/QuickAddDrugModal';
import DrugReplacementDialog from '../master-drugs/DrugReplacementDialog';
import { addMasterDrugAction, getUnitsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict, getReplacementDrug, replaceDrugAction } from '@/app/actions-client/drug-replacement';

jest.mock('@/app/actions-client/master-drugs', () => ({ addMasterDrugAction: jest.fn(), getUnitsAction: jest.fn(), searchMasterDrugsAction: jest.fn() }));
jest.mock('@/app/actions-client/drug-replacement', () => ({ findDrugBarcodeConflict: jest.fn(), getReplacementDrug: jest.fn(), replaceDrugAction: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

it('warns on quick-add barcode conflict, allows correcting a failed authorization, and returns the replacement to purchase', async () => {
  (getUnitsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (addMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, error: 'Barcode already used' });
  (findDrugBarcodeConflict as jest.Mock).mockResolvedValue({ id: 10, trade_name: 'Old medicine', barcode: '123' });
  (replaceDrugAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'Wrong password' }).mockResolvedValueOnce({ success: true, id: 21, backupPath: 'backups/test.db' });
  (getReplacementDrug as jest.Mock).mockResolvedValue({ id: 21, trade_name: 'Correct medicine', large_unit: 'box', large_to_medium: 2, barcode: '123', official_price: 40 });
  const success = jest.fn();
  render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={success} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: 'Correct medicine' } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '40' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), { target: { value: '123' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Old medicine');
  expect(success).not.toHaveBeenCalled();
  const confirm = screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'wrong' } });
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
  expect(success).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'correct' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(success).toHaveBeenCalledWith(21, 'Correct medicine', 'box', 40, 2, '123'));
  expect(replaceDrugAction).toHaveBeenLastCalledWith(10, null, expect.objectContaining({ trade_name: 'Correct medicine', barcode: '123', official_price: 40, large_to_medium: 2 }), 'correct', expect.any(Object));
});

it('compares full records, highlights shared information and batch barcodes, and requires reconfirmation after editing', async () => {
  jest.clearAllMocks();
  const old = { id: 10, trade_name: 'Old', active_ingredient: 'Ingredient', barcode: '', inventory_barcodes: '123', stock_quantity: 2, manufacturer: 'Old manufacturer' };
  const target = { id: 20, trade_name: 'New', active_ingredient: 'Ingredient', barcode: '123', stock_quantity: 0, manufacturer: 'New manufacturer' };
  (getReplacementDrug as jest.Mock).mockImplementation(async id => id === 10 ? old : target);
  (replaceDrugAction as jest.Mock).mockResolvedValue({ success: false, error: 'Unsafe units' });
  render(<DrugReplacementDialog source={old} target={target} onClose={jest.fn()} onSuccess={jest.fn()} />);
  const ingredient = await screen.findByLabelText('البيانات النهائية: المادة الفعالة');
  expect(ingredient.closest('tr')).toHaveAttribute('data-shared', 'true');
  expect(screen.getByText(/باركود مشترك/)).toHaveTextContent('123');
  expect(screen.getByLabelText('البيانات النهائية: الشركة المصنعة').closest('tr')).toHaveAttribute('data-shared', 'false');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'استخدام الشركة المصنعة من القديم' }));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.getByLabelText('البيانات النهائية: الشركة المصنعة')).toHaveValue('Old manufacturer');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unsafe units');
  expect(replaceDrugAction).toHaveBeenCalledWith(10, 20, null, 'admin-password', { manufacturer: 'Old manufacturer' });
});

it('blocks saving if complete records cannot be loaded', async () => {
  (getReplacementDrug as jest.Mock).mockResolvedValue(null);
  render(<DrugReplacementDialog source={{ id: 10 }} target={{ id: 20 }} onClose={jest.fn()} onSuccess={jest.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('تعذر تحميل');
  expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeDisabled();
});
