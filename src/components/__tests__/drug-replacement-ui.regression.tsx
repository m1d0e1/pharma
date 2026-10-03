import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import QuickAddDrugModal from '../master-drugs/QuickAddDrugModal';
import DrugReplacementDialog from '../master-drugs/DrugReplacementDialog';
import { addMasterDrugAction, archiveMasterDrugAction, getUnitsAction, searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict, findDrugBarcodeOwners, getReplacementDrug, reconcileDrugBarcodeOwnersAction, replaceDrugAction } from '@/app/actions-client/drug-replacement';

jest.mock('@/app/actions-client/master-drugs', () => ({ addMasterDrugAction: jest.fn(), archiveMasterDrugAction: jest.fn(), getUnitsAction: jest.fn(), searchMasterDrugsAction: jest.fn() }));
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn(),
  findDrugBarcodeOwners: jest.fn(async () => []),
  getReplacementDrug: jest.fn(),
  reconcileDrugBarcodeOwnersAction: jest.fn(),
  replaceDrugAction: jest.fn(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

beforeEach(() => {
  [
    addMasterDrugAction,
    archiveMasterDrugAction,
    getUnitsAction,
    searchMasterDrugsAction,
    findDrugBarcodeConflict,
    findDrugBarcodeOwners,
    getReplacementDrug,
    reconcileDrugBarcodeOwnersAction,
    replaceDrugAction,
  ].forEach(mock => (mock as jest.Mock).mockReset());
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([]);
});

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
  expect(await screen.findByRole('dialog', { name: /استبدال الصنف القديم/ })).toHaveTextContent('Old medicine');
  expect(success).not.toHaveBeenCalled();
  const confirm = screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'wrong' } });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password');
  expect(success).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'correct' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(success).toHaveBeenCalledWith(21, 'Correct medicine', 'box', 40, 2, '123'));
  expect(replaceDrugAction).toHaveBeenLastCalledWith(10, null, expect.objectContaining({ trade_name: 'Correct medicine', barcode: '123', official_price: 40, large_to_medium: 2 }), 'correct', expect.any(Object));
});

it('keeps quick-add open while the add mutation is pending', async () => {
  jest.clearAllMocks();
  (getUnitsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  let resolveAdd!: (value: { success: boolean; id?: number; error?: string }) => void;
  const pending = new Promise<{ success: boolean; id?: number; error?: string }>(resolve => {
    resolveAdd = resolve;
  });
  (addMasterDrugAction as jest.Mock).mockImplementation(() => pending);
  const onClose = jest.fn();

  render(<QuickAddDrugModal onClose={onClose} onSuccess={jest.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: 'Pending drug' } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '40' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));
  await waitFor(() => expect(addMasterDrugAction).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => {
    resolveAdd({ success: false, error: 'save failed' });
    await pending;
  });
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
  expect(screen.getByText(/باركود قيد المراجعة/)).toHaveTextContent('123');
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

it('resolves three barcode owners in one reviewed group operation with an explicit canonical record', async () => {
  jest.clearAllMocks();
  const canonical = { id: 10, trade_name: 'DEXATROL EYE/EAR DROPS 5 ML', barcode: '123', inventory_barcodes: '123', stock_quantity: 10, large_to_medium: 1, medium_to_small: 1, large_unit: 'bottle', active_ingredient: 'DEXAMETHASONE', manufacturer: 'EIPICO', official_price: 27 };
  const custom = { id: 20, trade_name: 'dexatrol drops', barcode: '123', inventory_barcodes: '123', stock_quantity: 0, large_to_medium: 1, medium_to_small: 1, large_unit: 'bottle', active_ingredient: 'DEXAMETHASONE', manufacturer: 'EIPICO', official_price: 27 };
  const third = { id: 30, trade_name: 'Drug 30', barcode: '123', inventory_barcodes: '123', stock_quantity: 3, large_to_medium: 1, medium_to_small: 1, large_unit: 'bottle', active_ingredient: 'DEXAMETHASONE', manufacturer: 'EIPICO', official_price: 27 };
  (getReplacementDrug as jest.Mock).mockImplementation(async id => ({ 10: canonical, 20: custom, 30: third } as any)[id]);
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([canonical, custom, third]);
  (reconcileDrugBarcodeOwnersAction as jest.Mock).mockResolvedValue({ success: true, id: 10, backupPath: 'backups/group.db' });
  const onSuccess = jest.fn();

  render(<DrugReplacementDialog source={canonical} target={custom} onClose={jest.fn()} onSuccess={onSuccess} />);

  expect(await screen.findByText(/تعارض باركود متعدد/)).toHaveTextContent('3');
  expect(screen.getByText(/Drug 30/)).toBeInTheDocument();
  expect(screen.getAllByText(/DEXAMETHASONE/).length).toBeGreaterThanOrEqual(3);
  expect(screen.getAllByText(/EIPICO/).length).toBeGreaterThanOrEqual(3);
  const submit = screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/الاحتفاظ بالصنف #10/));
  await screen.findByLabelText('البيانات النهائية: الاسم التجاري');
  fireEvent.change(screen.getByLabelText('البيانات النهائية: الوحدة المتوسطة'), { target: { value: 'strip' } });
  fireEvent.change(screen.getByLabelText('البيانات النهائية: الوحدة الصغرى'), { target: { value: 'tablet' } });
  fireEvent.change(screen.getByLabelText('البيانات النهائية: عدد الوحدات المتوسطة'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('البيانات النهائية: عدد الوحدات الصغرى'), { target: { value: '10' } });
  fireEvent.click(screen.getByLabelText(/جميع الأصناف المذكورة/));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
  fireEvent.click(submit);

  await waitFor(() => expect(reconcileDrugBarcodeOwnersAction).toHaveBeenCalledWith([20, 30], 10, 'admin-password', {
    medium_unit: 'strip',
    small_unit: 'tablet',
    large_to_medium: 10,
    medium_to_small: 10,
  }));
  expect(replaceDrugAction).not.toHaveBeenCalled();
  await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(10, 'backups/group.db', expect.objectContaining({ id: 10 }), {
    medium_unit: 'strip',
    small_unit: 'tablet',
    large_to_medium: 10,
    medium_to_small: 10,
  }, [20, 30, 10]));
});

it('includes an unsaved edited target in the group and forces it as canonical when its proposed barcode already has multiple owners', async () => {
  const first = { id: 10, trade_name: 'First owner', barcode: '123', active_inventory_barcodes: '123', stock_quantity: 2, large_to_medium: 2 };
  const second = { id: 20, trade_name: 'Second owner', barcode: '123', active_inventory_barcodes: '123', stock_quantity: 1, large_to_medium: 2 };
  const persistedTarget = { id: 30, trade_name: 'Edited target', barcode: '789', stock_quantity: 0, large_to_medium: 2 };
  const pendingTarget = { ...persistedTarget, barcode: '123' };
  (getReplacementDrug as jest.Mock).mockImplementation(async id => ({ 10: first, 20: second, 30: persistedTarget } as any)[id]);
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([first, second]);
  (reconcileDrugBarcodeOwnersAction as jest.Mock).mockResolvedValue({ success: true, id: 30, backupPath: 'backups/pending.db' });

  render(<DrugReplacementDialog source={first} target={pendingTarget} pendingEdit={pendingTarget} onClose={jest.fn()} onSuccess={jest.fn()} />);

  expect(await screen.findByText(/تعارض باركود متعدد/)).toHaveTextContent('3');
  expect(screen.getByText(/تعديل باركود غير محفوظ/)).toHaveTextContent('#30');
  expect(screen.getByLabelText('الاحتفاظ بالصنف #30 كسجل نهائي')).toBeChecked();
  expect(screen.getByLabelText('الاحتفاظ بالصنف #10 كسجل نهائي')).toBeDisabled();
  expect(screen.getByLabelText('الاحتفاظ بالصنف #20 كسجل نهائي')).toBeDisabled();

  fireEvent.click(screen.getByLabelText(/جميع الأصناف المذكورة/));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' }));

  await waitFor(() => expect(reconcileDrugBarcodeOwnersAction).toHaveBeenCalledWith([10, 20], 30, 'admin-password', { barcode: '123' }));
  expect(replaceDrugAction).not.toHaveBeenCalled();
});

it('blocks saving if complete records cannot be loaded', async () => {
  (getReplacementDrug as jest.Mock).mockResolvedValue(null);
  render(<DrugReplacementDialog source={{ id: 10 }} target={{ id: 20 }} onClose={jest.fn()} onSuccess={jest.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('تعذر تحميل');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeDisabled();
});

it('recovers a thrown full-record loader and retries without closing the replacement dialog', async () => {
  const old = { id: 10, trade_name: 'Old' };
  const target = { id: 20, trade_name: 'New' };
  (getReplacementDrug as jest.Mock).mockRejectedValue(new Error('replacement loader unavailable'));
  render(<DrugReplacementDialog source={old} target={target} onClose={jest.fn()} onSuccess={jest.fn()} />);

  expect(await screen.findByRole('alert')).toHaveTextContent('تعذر تحميل');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();

  (getReplacementDrug as jest.Mock).mockImplementation(async id => id === 10 ? old : target);
  fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل بيانات الصنفين' }));
  expect(await screen.findByLabelText('البيانات النهائية: الاسم التجاري')).toBeInTheDocument();
});

it('restores replacement controls when the destructive replacement action throws', async () => {
  const old = { id: 10, trade_name: 'Old' };
  const target = { id: 20, trade_name: 'New' };
  (getReplacementDrug as jest.Mock).mockImplementation(async id => id === 10 ? old : target);
  (replaceDrugAction as jest.Mock).mockRejectedValue(new Error('replacement bridge unavailable'));
  render(<DrugReplacementDialog source={old} target={target} onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByLabelText('البيانات النهائية: الاسم التجاري');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
  const replaceButton = screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' });
  fireEvent.click(replaceButton);

  expect(await screen.findByRole('alert')).toHaveTextContent('فشل الاستبدال');
  expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeEnabled();
});

it('acknowledges a completed replacement when the follow-up saved-record read throws', async () => {
  const old = { id: 10, trade_name: 'Old', manufacturer: 'Old M' };
  const target = { id: 20, trade_name: 'New', manufacturer: 'New M' };
  const onSuccess = jest.fn();
  (getReplacementDrug as jest.Mock)
    .mockImplementationOnce(async () => old)
    .mockImplementationOnce(async () => target)
    .mockRejectedValueOnce(new Error('post-replacement read unavailable'));
  (replaceDrugAction as jest.Mock).mockResolvedValue({ success: true, id: 20, backupPath: 'backups/replaced.db' });
  render(<DrugReplacementDialog source={old} target={target} onClose={jest.fn()} onSuccess={onSuccess} />);

  await screen.findByLabelText('البيانات النهائية: الاسم التجاري');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'admin-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' }));

  await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(
    20,
    'backups/replaced.db',
    expect.objectContaining({ id: 20, trade_name: 'New' }),
    expect.any(Object),
  ));
  expect(replaceDrugAction).toHaveBeenCalledTimes(1);
});

it('restores archive controls when safe archival throws', async () => {
  const old = { id: 10, trade_name: 'Old', stock_quantity: 0 };
  const target = { id: 20, trade_name: 'New' };
  const onArchived = jest.fn();
  (getReplacementDrug as jest.Mock).mockImplementation(async id => id === 10 ? old : target);
  (archiveMasterDrugAction as jest.Mock).mockRejectedValue(new Error('archive bridge unavailable'));
  render(<DrugReplacementDialog source={old} target={target} onClose={jest.fn()} onSuccess={jest.fn()} onArchived={onArchived} />);

  await screen.findByLabelText('البيانات النهائية: الاسم التجاري');
  fireEvent.click(screen.getByLabelText(/أوافق على إيقاف الصنف/));
  const archiveButton = screen.getByRole('button', { name: 'تأكيد الحذف الآمن (أرشفة)' });
  fireEvent.click(archiveButton);

  expect(await screen.findByRole('alert')).toHaveTextContent('فشل الحذف الآمن');
  expect(screen.getByRole('button', { name: 'تأكيد الحذف الآمن (أرشفة)' })).toBeEnabled();
  expect(onArchived).not.toHaveBeenCalled();
});

it('clears stale replacement suggestions and reports a thrown replacement search', async () => {
  const old = { id: 10, trade_name: 'Old medicine' };
  const candidate = { id: 20, trade_name: 'Candidate medicine', barcode: 'ABC' };
  (getReplacementDrug as jest.Mock).mockImplementation(async id => id === 10 ? old : candidate);
  (searchMasterDrugsAction as jest.Mock)
    .mockResolvedValueOnce({ success: true, data: [candidate] })
    .mockRejectedValueOnce(new Error('search bridge unavailable'));

  render(<DrugReplacementDialog source={old} onClose={jest.fn()} onSuccess={jest.fn()} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

  const search = screen.getByLabelText('ابحث عن الصنف البديل');
  fireEvent.change(search, { target: { value: 'Can' } });
  expect(await screen.findByText(/Candidate medicine/)).toBeInTheDocument();

  fireEvent.change(search, { target: { value: 'Other' } });

  await waitFor(() => expect(screen.queryByText(/Candidate medicine/)).not.toBeInTheDocument());
  expect(await screen.findByRole('alert')).toHaveTextContent('تعذر البحث عن الصنف البديل');
});

it('uses the replacement record already supplied by the child after a committed quick-add replacement', async () => {
  const old = { id: 10, trade_name: 'Old medicine', barcode: '123' };
  const saved = { id: 21, trade_name: 'Correct medicine', large_unit: 'box', large_to_medium: 2, barcode: '123', official_price: 40 };
  (getUnitsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (addMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, error: 'Barcode already used' });
  (findDrugBarcodeConflict as jest.Mock).mockResolvedValue(old);
  (replaceDrugAction as jest.Mock).mockResolvedValue({ success: true, id: 21, backupPath: 'backups/test.db' });
  (getReplacementDrug as jest.Mock)
    .mockResolvedValueOnce(old)
    .mockResolvedValueOnce(saved)
    .mockResolvedValueOnce(null);
  const success = jest.fn();

  render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={success} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: 'Correct medicine' } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '40' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), { target: { value: '123' } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));

  expect(await screen.findByRole('dialog', { name: /استبدال الصنف القديم/ })).toHaveTextContent('Old medicine');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير الحالي'), { target: { value: 'correct' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'نقل الروابط وحذف القديم' }));

  await waitFor(() => expect(success).toHaveBeenCalledWith(21, 'Correct medicine', 'box', 40, 2, '123'));
  expect(getReplacementDrug).toHaveBeenCalledTimes(2);
});
