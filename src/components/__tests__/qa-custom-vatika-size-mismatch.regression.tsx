import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import QuickAddDrugModal from '@/components/master-drugs/QuickAddDrugModal';
import DrugReplacementDialog from '@/components/master-drugs/DrugReplacementDialog';
import { addMasterDrugAction, getUnitsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict, findDrugBarcodeOwners, getReplacementDrug,
  reconcileDrugBarcodeOwnersAction, replaceDrugAction } from '@/app/actions-client/drug-replacement';
import { hasConflictingNamedPackSize, namedProductNumbers } from '@/lib/inventory/drug-pack-identity';

jest.mock('@/app/actions-client/master-drugs', () => ({
  addMasterDrugAction: jest.fn(), getUnitsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn(), findDrugBarcodeOwners: jest.fn(),
  getReplacementDrug: jest.fn(), reconcileDrugBarcodeOwnersAction: jest.fn(),
  replaceDrugAction: jest.fn(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const old180 = {
  id: 25515,
  trade_name: 'فاتكا زيت شعر 180 بالجرجير',
  trade_name_en: 'vatika hair oil 180 bl grgir',
  barcode: '6224007939147',
  inventory_barcodes: '6224007939161',
  active_inventory_barcodes: '6224007939161',
  stock_quantity: 1,
  official_price: 50,
  large_unit: 'عبوة', large_to_medium: 1, medium_to_small: 1,
};
const proposed45 = {
  trade_name: 'فاتكا زيت 45 بالجرجير',
  trade_name_en: 'vatica hair oil 45 bl grger',
  official_price: 15,
  barcode: '6224007939147',
  large_unit: 'عبوة', large_to_medium: 1, medium_to_small: 1,
};

beforeEach(() => {
  for (const fn of [addMasterDrugAction, getUnitsAction, findDrugBarcodeConflict,
    findDrugBarcodeOwners, getReplacementDrug, replaceDrugAction,
    reconcileDrugBarcodeOwnersAction]) (fn as jest.Mock).mockReset();
  (getUnitsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ name_ar: 'عبوة' }] });
  // Keep this fixture aligned with the real ownership-denial contract.
  // A generic barcode-related service error must not offer replacement.
  (addMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, error: 'Barcode is already assigned to another drug' });
  (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(old180);
  (getReplacementDrug as jest.Mock).mockImplementation(async (id: number) => id === 25515 ? old180 : null);
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([old180]);
});

it('reproduces the screenshot: adding distinct 45 ml warns about the occupied master barcode without suggesting replacement', async () => {
  const onSuccess = jest.fn();
  const onClose = jest.fn();
  render(<QuickAddDrugModal onSuccess={onSuccess} onClose={onClose} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: proposed45.trade_name } });
  fireEvent.change(screen.getByPlaceholderText('Trade Name (EN)'), { target: { value: proposed45.trade_name_en } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '15' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), { target: { value: proposed45.barcode } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('vatika hair oil 180 bl grgir');
  expect(alert).toHaveTextContent('6224007939147');
  expect(alert).toHaveTextContent('6224007939161');
  expect(alert).toHaveTextContent('بطاقة الصنف');
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
  expect(replaceDrugAction).not.toHaveBeenCalled();
  expect(reconcileDrugBarcodeOwnersAction).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
});

it('normalizes Arabic and Eastern-Arabic numbered pack identities but does not block the same-size spelling variant', () => {
  expect(namedProductNumbers({ trade_name: 'زيت شعر ١٨٠ مل', trade_name_en: 'Vatika 180 bl' })).toEqual(['180']);
  expect(namedProductNumbers({ trade_name: 'زيت شعر ۴۵ مل' })).toEqual(['45']);
  expect(hasConflictingNamedPackSize({ trade_name: 'زيت شعر ١٨٠ مل' }, { trade_name: 'زيت شعر ٤٥ مل' })).toBe(true);
  expect(hasConflictingNamedPackSize(old180, {
    trade_name_en: 'vatica hair oil 180 bl grger', trade_name: 'فاتكا زيت شعر ١٨٠ بالجرجير',
  })).toBe(false);
});

it('must not allow final-name edits to turn a reviewed 180 ml merge into a 45 ml historical relink', async () => {
  const target180 = {
    ...old180, id: 90020, trade_name: 'فاتكا زيت 180 بالجرجير',
    trade_name_en: 'vatica hair oil 180 bl grger',
  };
  (getReplacementDrug as jest.Mock).mockImplementation(async (id: number) =>
    id === 25515 ? old180 : id === 90020 ? target180 : null);
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([old180, target180]);
  render(<DrugReplacementDialog source={old180} target={target180} onClose={jest.fn()} onSuccess={jest.fn()} />);
  const finalEnglishName = await screen.findByLabelText('البيانات النهائية: الاسم الإنجليزي');
  await waitFor(() => expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeDisabled());
  fireEvent.change(finalEnglishName, { target: { value: 'vatica hair oil 45 bl grger' } });
  fireEvent.change(screen.getByLabelText('البيانات النهائية: الاسم التجاري'), { target: { value: 'فاتكا زيت ٤٥ بالجرجير' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /نفس الدواء والتركيز والشكل وحجم العبوة/ }));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'synthetic-password' } });
  await waitFor(() => expect(findDrugBarcodeOwners).toHaveBeenCalledWith('6224007939147'));
  expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeDisabled();
  expect(replaceDrugAction).not.toHaveBeenCalled();
  expect(reconcileDrugBarcodeOwnersAction).not.toHaveBeenCalled();
});

it('still permits review of a genuine same-size duplicate, without posting any native transaction', async () => {
  const duplicate180 = { ...proposed45,
    trade_name: 'فاتكا زيت 180 بالجرجير', trade_name_en: 'vatica hair oil 180 bl grger',
  };
  const onSuccess = jest.fn();
  render(<QuickAddDrugModal onSuccess={onSuccess} onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: duplicate180.trade_name } });
  fireEvent.change(screen.getByPlaceholderText('Trade Name (EN)'), { target: { value: duplicate180.trade_name_en } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '15' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), { target: { value: duplicate180.barcode } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));
  await screen.findByRole('dialog', { name: /استبدال الصنف القديم/ });
  await waitFor(() => expect(screen.getByLabelText('البيانات النهائية: الاسم الإنجليزي')).toHaveValue(duplicate180.trade_name_en));
  fireEvent.click(screen.getByRole('checkbox', { name: /نفس الدواء والتركيز والشكل وحجم العبوة/ }));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'synthetic-password' } });
  expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeEnabled();
  expect(replaceDrugAction).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
});

it('creates the distinct 45-size product as a separate custom master record when the barcode is corrected', async () => {
  (addMasterDrugAction as jest.Mock).mockResolvedValue({ success: true, id: 90001 });
  const onSuccess = jest.fn();
  render(<QuickAddDrugModal onSuccess={onSuccess} onClose={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: proposed45.trade_name } });
  fireEvent.change(screen.getByPlaceholderText('Trade Name (EN)'), { target: { value: proposed45.trade_name_en } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '15' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), { target: { value: 'CUSTOM-45-ISOLATED' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));
  await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(90001, proposed45.trade_name_en, '', 15, 1, 'CUSTOM-45-ISOLATED'));
  expect(findDrugBarcodeConflict).not.toHaveBeenCalled();
  expect(replaceDrugAction).not.toHaveBeenCalled();
  expect(reconcileDrugBarcodeOwnersAction).not.toHaveBeenCalled();
});
