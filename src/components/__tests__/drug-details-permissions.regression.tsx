import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DrugDetailsModal from '@/components/pos/DrugDetailsModal';
import { getDrugDetailsFullAction } from '@/app/actions-client/inventory';
import { addDrugInteractionAction, archiveMasterDrugAction, deleteMasterDrugAction, unarchiveMasterDrugAction, updateMasterDrugAction } from '@/app/actions-client/master-drugs';
import { toast } from 'react-hot-toast';

let mockUser: any;

jest.mock('react-hotkeys-hook', () => ({
  useHotkeys: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn((user: any, key: string) =>
    user?.role === 'owner' || user?.permissions?.[key] === true
  ),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getDrugDetailsFullAction: jest.fn(async () => ({
    success: true,
    data: {
      id: 11,
      trade_name: 'Panadol',
      active_ingredient: 'Paracetamol',
      official_price: 10,
      min_price: 10,
      total_stock: 1,
      units: { large: 'box', medium: 'strip', small: 'tablet' },
      expiry_batches: [],
      alternatives: [],
      conflicts: [],
      consumption_stats: [],
    },
  })),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  archiveMasterDrugAction: jest.fn(),
  deleteMasterDrugAction: jest.fn(),
  unarchiveMasterDrugAction: jest.fn(),
  updateMasterDrugAction: jest.fn(),
  searchMasterDrugsAction: jest.fn(),
  addDrugAlternativeAction: jest.fn(),
  removeDrugAlternativeAction: jest.fn(),
  addDrugInteractionAction: jest.fn(),
  removeDrugInteractionAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

describe('DrugDetailsModal inventory-management permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = {
      id: 'viewer',
      role: 'cashier',
      pharmacy_id: 'ph-1',
      permissions: { can_access_pos: true, can_manage_inventory: false },
    };
    (getDrugDetailsFullAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 11,
        trade_name: 'Panadol',
        active_ingredient: 'Paracetamol',
        official_price: 10,
        min_price: 10,
        total_stock: 1,
        units: { large: 'box', medium: 'strip', small: 'tablet' },
        expiry_batches: [],
        alternatives: [],
        conflicts: [],
        consumption_stats: [],
      },
    });
    (addDrugInteractionAction as jest.Mock).mockResolvedValue({ success: true });
    (archiveMasterDrugAction as jest.Mock).mockResolvedValue({ success: true });
    (deleteMasterDrugAction as jest.Mock).mockResolvedValue({ success: true });
    (unarchiveMasterDrugAction as jest.Mock).mockResolvedValue({ success: true });
    (updateMasterDrugAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('keeps drug details readable without exposing master-data edit mode to view-only users', async () => {
    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);

    expect(await screen.findByText('Panadol')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /تعديل/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'أرشفة الصنف' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إلغاء أرشفة الصنف' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'حذف الصنف نهائياً' })).not.toBeInTheDocument();
  });

  it('keeps edit mode available for an authorized inventory manager', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);

    expect(await screen.findByRole('button', { name: /تعديل/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'أرشفة الصنف' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حذف الصنف نهائياً' })).toBeInTheDocument();
  });

  it('archives from the drug card without attempting permanent deletion', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onDrugUpdated = jest.fn();

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} onDrugUpdated={onDrugUpdated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'أرشفة الصنف' }));

    await waitFor(() => expect(archiveMasterDrugAction).toHaveBeenCalledWith(11, true));
    expect(deleteMasterDrugAction).not.toHaveBeenCalled();
    expect(onDrugUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 11, stop_dealing: 1 }));
    expect(screen.getByRole('button', { name: 'إلغاء أرشفة الصنف' })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('تمت أرشفة الصنف وإيقاف التعامل مع حفظ المخزون والسجل');
    confirm.mockRestore();
  });

  it('unarchives an archived drug from the card and returns to the archive option', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    (getDrugDetailsFullAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 11,
        trade_name: 'Panadol',
        active_ingredient: 'Paracetamol',
        official_price: 10,
        min_price: 10,
        total_stock: 1,
        stop_dealing: 1,
        units: { large: 'box', medium: 'strip', small: 'tablet' },
        expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
      },
    });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onDrugUpdated = jest.fn();

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} onDrugUpdated={onDrugUpdated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'إلغاء أرشفة الصنف' }));

    await waitFor(() => expect(unarchiveMasterDrugAction).toHaveBeenCalledWith(11, true));
    expect(archiveMasterDrugAction).not.toHaveBeenCalled();
    expect(deleteMasterDrugAction).not.toHaveBeenCalled();
    expect(onDrugUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 11, stop_dealing: 0 }));
    expect(screen.getByRole('button', { name: 'أرشفة الصنف' })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('تم إلغاء أرشفة الصنف وإعادته للتعامل');
    confirm.mockRestore();
  });

  it('permanently deletes an unused drug from the card and reports the deleted id', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = jest.fn();
    const onDrugDeleted = jest.fn();

    render(<DrugDetailsModal drugId={11} onClose={onClose} onDrugDeleted={onDrugDeleted} />);
    fireEvent.click(await screen.findByRole('button', { name: 'حذف الصنف نهائياً' }));

    await waitFor(() => expect(deleteMasterDrugAction).toHaveBeenCalledWith(11));
    expect(archiveMasterDrugAction).not.toHaveBeenCalled();
    expect(onDrugDeleted).toHaveBeenCalledWith(11);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('تم حذف الصنف بنجاح');
    confirm.mockRestore();
  });

  it('keeps a linked drug card open when permanent deletion is refused', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = jest.fn();
    const onDrugDeleted = jest.fn();
    (deleteMasterDrugAction as jest.Mock).mockResolvedValue({
      success: false,
      code: 'DRUG_IN_USE',
      error: 'الصنف مرتبط بمخزون أو فواتير أو سجل طبي',
    });

    render(<DrugDetailsModal drugId={11} onClose={onClose} onDrugDeleted={onDrugDeleted} />);
    fireEvent.click(await screen.findByRole('button', { name: 'حذف الصنف نهائياً' }));

    await waitFor(() => expect(deleteMasterDrugAction).toHaveBeenCalledWith(11));
    expect(onDrugDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Panadol')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('الصنف مرتبط بمخزون أو فواتير أو سجل طبي');
    confirm.mockRestore();
  });

  it('allows an authorized manager to edit unit names and conversion factors from the drug card', async () => {
    mockUser = {
      id: 'admin',
      role: 'admin',
      pharmacy_id: 'ph-1',
      permissions: { can_manage_inventory: true, can_modify_unit_conversion: true },
    };
    (getDrugDetailsFullAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 11,
        trade_name: 'Panadol',
        active_ingredient: 'Paracetamol',
        official_price: 10,
        min_price: 10,
        total_stock: 1,
        large_unit: 'box',
        medium_unit: 'strip-old',
        small_unit: 'tablet-old',
        large_to_medium: 2,
        medium_to_small: 5,
        units: { large: 'box', medium: 'strip-old', small: 'tablet-old' },
        expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
      },
    });
    (updateMasterDrugAction as jest.Mock).mockResolvedValue({ success: true });

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    fireEvent.click(screen.getByRole('button', { name: 'الوحدات والموردين' }));

    fireEvent.change(screen.getByLabelText('الوحدة الكبرى'), { target: { value: 'carton' } });
    fireEvent.change(screen.getByLabelText('الوحدة المتوسطة'), { target: { value: 'strip' } });
    fireEvent.change(screen.getByLabelText('معامل تحويل الوحدة المتوسطة'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('الوحدة الصغرى'), { target: { value: 'tablet' } });
    fireEvent.change(screen.getByLabelText('معامل تحويل الوحدة الصغرى'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(updateMasterDrugAction).toHaveBeenCalledWith(11, expect.objectContaining({
      large_unit: 'carton',
      medium_unit: 'strip',
      small_unit: 'tablet',
      large_to_medium: 10,
      medium_to_small: 12,
    })));
  });

  it('keeps unit conversion fields read-only in the drug card without conversion permission', async () => {
    mockUser = {
      id: 'admin',
      role: 'admin',
      pharmacy_id: 'ph-1',
      permissions: { can_manage_inventory: true, can_modify_unit_conversion: false },
    };
    (getDrugDetailsFullAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 11,
        trade_name: 'Panadol',
        active_ingredient: 'Paracetamol',
        official_price: 10,
        min_price: 10,
        total_stock: 1,
        large_unit: 'box', medium_unit: 'strip', small_unit: 'tablet',
        large_to_medium: 2, medium_to_small: 5,
        units: { large: 'box', medium: 'strip', small: 'tablet' },
        expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
      },
    });

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    fireEvent.click(screen.getByRole('button', { name: 'الوحدات والموردين' }));

    expect(screen.getByRole('note')).toHaveTextContent('تعديل معاملات تحويل الوحدات');
    expect(screen.queryByLabelText('الوحدة الكبرى')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('معامل تحويل الوحدة المتوسطة')).not.toBeInTheDocument();
    expect(screen.getByText('box')).toBeInTheDocument();
  });

  it('exposes interaction detail cards as keyboard-native disclosure buttons', async () => {
    (getDrugDetailsFullAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 11,
        trade_name: 'Panadol',
        active_ingredient: 'Paracetamol',
        official_price: 10,
        min_price: 10,
        total_stock: 1,
        units: { large: 'box', medium: 'strip', small: 'tablet' },
        expiry_batches: [],
        alternatives: [],
        conflicts: [{
          interaction_id: 77,
          trade_name: 'Warfarin',
          conflicting_ingredient: 'Warfarin',
          severity: 'major',
          description: 'راقب النزيف',
        }],
        consumption_stats: [],
      },
    });

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    await screen.findByText('Panadol');
    fireEvent.click(screen.getByRole('button', { name: 'البدائل' }));
    fireEvent.click(screen.getByRole('button', { name: 'الأدوية المتعارضة' }));

    const disclosure = screen.getByRole('button', { name: 'عرض تفاصيل التداخل مع Warfarin' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('راقب النزيف')).toBeInTheDocument();
  });

  it('uses the displayed active ingredient when an authorized manager adds a conflict', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    fireEvent.click(screen.getByRole('button', { name: 'البدائل' }));
    fireEvent.click(screen.getByRole('button', { name: 'الأدوية المتعارضة' }));
    fireEvent.change(screen.getByPlaceholderText('أدخل المادة المتعارضة...'), {
      target: { value: 'Warfarin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة' }));

    await waitFor(() => expect(addDrugInteractionAction).toHaveBeenCalledWith(
      'Paracetamol',
      'Warfarin',
      'minor',
    ));
  });

  it('blocks same-tick duplicate interaction creation while the first write is pending', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    let resolveAdd!: (value: { success: boolean; error?: string }) => void;
    (addDrugInteractionAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveAdd = resolve;
    }));

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    fireEvent.click(screen.getByRole('button', { name: 'البدائل' }));
    fireEvent.click(screen.getByRole('button', { name: 'الأدوية المتعارضة' }));
    fireEvent.change(screen.getByPlaceholderText('أدخل المادة المتعارضة...'), {
      target: { value: 'Warfarin' },
    });
    const add = screen.getByRole('button', { name: 'إضافة' });
    act(() => {
      add.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      add.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(addDrugInteractionAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd({ success: false, error: 'stop' }));
  });

  it('keeps committed interaction changes visible when only the post-mutation details reload fails', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    (getDrugDetailsFullAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 11,
          trade_name: 'Panadol',
          active_ingredient: 'Paracetamol',
          official_price: 10,
          min_price: 10,
          total_stock: 1,
          units: { large: 'box', medium: 'strip', small: 'tablet' },
          expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
        },
      })
      .mockResolvedValueOnce({ success: false, error: 'details refresh unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 11,
          trade_name: 'Panadol',
          active_ingredient: 'Paracetamol',
          official_price: 10,
          min_price: 10,
          total_stock: 1,
          units: { large: 'box', medium: 'strip', small: 'tablet' },
          expiry_batches: [], alternatives: [],
          conflicts: [{ interaction_id: 77, trade_name: 'Warfarin', conflicting_ingredient: 'Warfarin', severity: 'minor' }],
          consumption_stats: [],
        },
      });
    (addDrugInteractionAction as jest.Mock).mockResolvedValueOnce({ success: true });

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    fireEvent.click(screen.getByRole('button', { name: 'البدائل' }));
    fireEvent.click(screen.getByRole('button', { name: 'الأدوية المتعارضة' }));
    fireEvent.change(screen.getByPlaceholderText('أدخل المادة المتعارضة...'), {
      target: { value: 'Warfarin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة' }));

    await waitFor(() => expect(addDrugInteractionAction).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تمت إضافة التفاعل الدوائي بنجاح');
    expect(await screen.findByText('تم الحفظ لكن تعذر تحديث بيانات الصنف')).toBeInTheDocument();
    expect(screen.getByText('Panadol')).toBeInTheDocument();
    expect(screen.queryByText('تعذر تحميل بيانات الصنف')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل بيانات الصنف' }));
    expect(await screen.findByText('Warfarin')).toBeInTheDocument();
    expect(getDrugDetailsFullAction).toHaveBeenCalledTimes(3);
  });

  it('distinguishes a failed drug-details load from an unnamed drug and retries', async () => {
    (getDrugDetailsFullAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'details unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 11,
          trade_name: 'Panadol',
          active_ingredient: 'Paracetamol',
          official_price: 10,
          min_price: 10,
          total_stock: 1,
          units: { large: 'box', medium: 'strip', small: 'tablet' },
          expiry_batches: [],
          alternatives: [],
          conflicts: [],
          consumption_stats: [],
        },
      });

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);

    expect(await screen.findByText('تعذر تحميل بيانات الصنف')).toBeInTheDocument();
    expect(screen.queryByText('صنف بدون اسم')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('Panadol')).toBeInTheDocument();
    expect(getDrugDetailsFullAction).toHaveBeenCalledTimes(2);
  });

  it('blocks duplicate inventory-save clicks while a drug edit is pending', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    let resolveSave: (value: { success: boolean; error?: string }) => void = () => {};
    (updateMasterDrugAction as jest.Mock).mockImplementation(() => new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveSave = resolve;
    }));

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    const save = screen.getByRole('button', { name: 'حفظ' });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(updateMasterDrugAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'جاري الحفظ...' })).toBeDisabled();

    resolveSave({ success: false, error: 'تعذر الحفظ' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر الحفظ'));
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
  });

  it('keeps committed drug details visible when only the post-save reload fails, and allows retry', async () => {
    mockUser = {
      id: 'owner',
      role: 'owner',
      pharmacy_id: 'ph-1',
      permissions: {},
    };
    (getDrugDetailsFullAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 11,
          trade_name: 'Panadol',
          active_ingredient: 'Paracetamol',
          official_price: 10,
          min_price: 10,
          total_stock: 1,
          units: { large: 'box', medium: 'strip', small: 'tablet' },
          expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
        },
      })
      .mockResolvedValueOnce({ success: false, error: 'refresh unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 11,
          trade_name: 'Panadol Updated',
          active_ingredient: 'Paracetamol',
          official_price: 10,
          min_price: 10,
          total_stock: 1,
          units: { large: 'box', medium: 'strip', small: 'tablet' },
          expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
        },
      });
    (updateMasterDrugAction as jest.Mock).mockResolvedValue({ success: true });

    render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /تعديل/ }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(updateMasterDrugAction).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تم حفظ التعديلات بنجاح');
    expect(await screen.findByText('تم الحفظ لكن تعذر تحديث بيانات الصنف')).toBeInTheDocument();
    expect(screen.getByText('Panadol')).toBeInTheDocument();
    expect(screen.queryByText('تعذر تحميل بيانات الصنف')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل بيانات الصنف' }));
    expect(await screen.findByText('Panadol Updated')).toBeInTheDocument();
    expect(getDrugDetailsFullAction).toHaveBeenCalledTimes(3);
  });

  it('keeps drug details owned by the newest drugId when an older request resolves afterwards', async () => {
    let resolveOld!: (value: any) => void;
    let resolveNew!: (value: any) => void;
    (getDrugDetailsFullAction as jest.Mock).mockImplementation((id: number | string) => {
      if (Number(id) === 11) return new Promise(resolve => { resolveOld = resolve; });
      if (Number(id) === 22) return new Promise(resolve => { resolveNew = resolve; });
      return Promise.resolve({ success: false });
    });

    const view = render(<DrugDetailsModal drugId={11} onClose={jest.fn()} />);
    await waitFor(() => expect(getDrugDetailsFullAction).toHaveBeenCalledWith(11));
    view.rerender(<DrugDetailsModal drugId={22} onClose={jest.fn()} />);
    await waitFor(() => expect(getDrugDetailsFullAction).toHaveBeenCalledWith(22));

    await act(async () => resolveNew({
      success: true,
      data: {
        id: 22, trade_name: 'Newest Drug', active_ingredient: 'New Ingredient',
        official_price: 20, min_price: 20, total_stock: 2,
        units: { large: 'box', medium: 'strip', small: 'tablet' },
        expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
      },
    }));
    expect(await screen.findByText('Newest Drug')).toBeInTheDocument();

    await act(async () => resolveOld({
      success: true,
      data: {
        id: 11, trade_name: 'Stale Drug', active_ingredient: 'Old Ingredient',
        official_price: 10, min_price: 10, total_stock: 1,
        units: { large: 'box', medium: 'strip', small: 'tablet' },
        expiry_batches: [], alternatives: [], conflicts: [], consumption_stats: [],
      },
    }));

    expect(screen.queryByText('Stale Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Newest Drug')).toBeInTheDocument();
  });
});
