import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ItemsManagementClient from '@/components/inventory/ItemsManagementClient';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import PharmacySettingsForm from '@/components/settings/PharmacySettingsForm';
import StoresPage from '@/app/(dashboard)/stores/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { searchMasterDrugsAction, addMasterDrugAction } from '@/app/actions-client/master-drugs';
import { addInteractionAction, checkDrugInteractions } from '@/app/actions-client/interactions';
import { updatePharmacyClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next/link', () => function LinkStub({ href, children, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/use-debounce', () => ({ useDebounce: (value: string) => value }));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn().mockResolvedValue([]) }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn(),
  addMasterDrugAction: jest.fn(),
  updateMasterDrugAction: jest.fn(),
  archiveMasterDrugAction: jest.fn(),
  deleteMasterDrugAction: jest.fn(),
  previewMasterDrugCatalogUpdateAction: jest.fn(),
}));
jest.mock('@/app/actions-client/drug-replacement', () => ({
  findDrugBarcodeConflict: jest.fn().mockResolvedValue(null),
  getReplacementDrug: jest.fn(),
  replaceDrugAction: jest.fn(),
}));
jest.mock('@/app/actions-client/interactions', () => ({
  getInteractionsAction: jest.fn(),
  addInteractionAction: jest.fn(),
  checkDrugInteractions: jest.fn(),
}));
jest.mock('@/lib/settings/client', () => ({ updatePharmacyClient: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  Toaster: () => null,
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  },
}));
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() {
  return <div>access-denied</div>;
});

const catalogRows = [
  {
    id: 17, trade_name: 'دواء أ', trade_name_en: 'Original Medicine',
    active_ingredient: 'Bisoprolol', official_price: 44, is_medicine: 1, is_service: 0,
  },
  {
    id: 28, trade_name: 'خدمة ب', trade_name_en: 'Original Service',
    active_ingredient: '', official_price: 12, is_medicine: 0, is_service: 1,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'fixture-owner', role: 'owner', pharmacy_id: 'fixture-pharmacy',
    permissions: { can_manage_inventory: true, can_view_stores: true },
  });
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, permission: string) =>
    user?.permissions?.[permission] === true);
  (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
    success: true, data: catalogRows, total: catalogRows.length, page: 1,
  });
});

describe('expanded view-only catalog and drug-interaction workflows', () => {
  it('sends combined active-ingredient, type and price filters and renders the filtered catalog result', async () => {
    const match = { ...catalogRows[0], id: 89, trade_name_en: 'Filtered Medicine' };
    (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
      success: true, data: [match], total: 1, page: 1,
    });
    render(<ItemsManagementClient initialItems={catalogRows as any} totalCount={250} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'بحث في دليل الأصناف' }), {
      target: { value: '  bisoprolol  ' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'البحث بالمادة الفعالة' }));
    fireEvent.click(screen.getByRole('button', { name: 'أدوية' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'الحد الأدنى للسعر' }), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'الحد الأقصى للسعر' }), {
      target: { value: '60' },
    });

    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenCalledWith({
      query: 'bisoprolol', type: 'medicine', status: 'all',
      minPrice: 20, maxPrice: 60, searchByActiveIngredient: true, page: 1, pageSize: 100,
    }));
    expect(await screen.findByText('Filtered Medicine')).toBeInTheDocument();
    expect(screen.queryByText('Original Service')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'أدوية' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('إجمالي الأصناف:').parentElement).toHaveTextContent('1');
  });

  it('rejects a nameless drug in the editor and keeps an unsuccessful form submission open', async () => {
    (addMasterDrugAction as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر حفظ الصنف' });
    render(<ItemsManagementClient initialItems={catalogRows as any} totalCount={2} />);

    fireEvent.click(await screen.findByRole('button', { name: 'إضافة صنف جديد' }));
    const editor = screen.getByRole('dialog', { name: 'إضافة صنف جديد لقاعدة البيانات' });
    fireEvent.click(within(editor).getByRole('button', { name: /حفظ البيانات/ }));
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال اسم الصنف');
    expect(addMasterDrugAction).not.toHaveBeenCalled();

    const englishName = within(editor).getByText('Trade Name (English) *').parentElement?.querySelector('input');
    expect(englishName).toBeTruthy();
    fireEvent.change(englishName!, { target: { value: '  Valid English Name  ' } });
    fireEvent.click(within(editor).getByRole('button', { name: /حفظ البيانات/ }));
    await waitFor(() => expect(addMasterDrugAction).toHaveBeenCalledWith(expect.objectContaining({
      trade_name: 'Valid English Name', trade_name_en: 'Valid English Name',
    })));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر حفظ الصنف'));
    expect(screen.getByRole('dialog', { name: 'إضافة صنف جديد لقاعدة البيانات' })).toBeInTheDocument();
    expect(englishName).toHaveValue('  Valid English Name  ');
  });

  it('normalizes quick-check comma entries and restores the control after a returned service error', async () => {
    (checkDrugInteractions as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر فحص المواد' });
    render(<InteractionsClient initialInteractions={[]} totalCount={0} userRole="pharmacist" />);
    const checker = screen.getByRole('textbox', { name: 'المواد الفعالة للفحص السريع' });
    fireEvent.change(checker, { target: { value: ' , Warfarin, , Aspirin , ' } });
    fireEvent.click(screen.getByRole('button', { name: 'فحص' }));

    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalledWith(['Warfarin', 'Aspirin']));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر فحص المواد'));
    expect(screen.getByRole('button', { name: 'فحص' })).toBeEnabled();
    expect(checker).toHaveValue(' , Warfarin, , Aspirin , ');
    expect(screen.queryByText('لا توجد تفاعلات معروفة بين هذه المواد')).not.toBeInTheDocument();
  });

  it('requires both ingredients and a description before calling the manual interaction action', async () => {
    (addInteractionAction as jest.Mock).mockResolvedValue({ success: false, error: 'رفض الحفظ' });
    render(<InteractionsClient initialInteractions={[]} totalCount={0} userRole="owner" />);
    fireEvent.click(screen.getByRole('button', { name: 'إضافة تفاعل' }));
    const form = screen.getByRole('form', { name: 'إضافة تفاعل دوائي جديد' });
    const first = within(form).getByRole('textbox', { name: 'المادة الفعالة الأولى' });
    const second = within(form).getByRole('textbox', { name: 'المادة الفعالة الثانية' });
    const description = within(form).getByRole('textbox', { name: 'وصف التفاعل بالتفصيل' });

    fireEvent.click(within(form).getByRole('button', { name: 'حفظ' }));
    expect(first).toBeInvalid();
    expect(addInteractionAction).not.toHaveBeenCalled();
    fireEvent.change(first, { target: { value: 'Aspirin' } });
    fireEvent.change(second, { target: { value: 'Warfarin' } });
    fireEvent.click(within(form).getByRole('button', { name: 'حفظ' }));
    expect(description).toBeInvalid();
    expect(addInteractionAction).not.toHaveBeenCalled();

    fireEvent.change(description, { target: { value: 'Requires pharmacist review' } });
    fireEvent.click(within(form).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(addInteractionAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('رفض الحفظ'));
    expect(within(form).getByDisplayValue('Requires pharmacist review')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('form', { name: 'إضافة تفاعل دوائي جديد' })).not.toBeInTheDocument();
  });
});

describe('expanded settings and route navigation', () => {
  it('keeps required pharmacy name client-validated and serializes owner/manager fields after correction', async () => {
    (updatePharmacyClient as jest.Mock).mockResolvedValue({ success: true });
    render(<PharmacySettingsForm pharmacy={[{
      name: 'صيدلية التجربة', owner_name: 'مالك قديم', manager_name: 'مدير قديم', phone: '100',
    }]} />);
    const name = screen.getByRole('textbox', { name: 'الإسم (بالعربية)' });
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    expect(name).toBeInvalid();
    expect(updatePharmacyClient).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: 'صيدلية محدثة' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'إسم المالك' }), { target: { value: 'مالك جديد' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'إسم المدير' }), { target: { value: 'مدير جديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => expect(updatePharmacyClient).toHaveBeenCalledWith(expect.objectContaining({
      name: 'صيدلية محدثة', owner_name: 'مالك جديد', manager_name: 'مدير جديد', phone: '100',
    })));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تم تحديث بيانات الصيدلية بنجاح'));
  });

  it('exposes catalog and medical reference navigation only after stores permission succeeds', async () => {
    const view = render(<StoresPage />);
    await screen.findByRole('heading', { name: 'إدارة المخازن والإعدادات' });
    expect(screen.getByRole('link', { name: /الأصناف تعريف وتعديل/ })).toHaveAttribute('href', '/stores/items');
    expect(screen.getByRole('link', { name: /دواعي الإستخدام إدارة دواعي/ })).toHaveAttribute('href', '/stores/indications');
    view.unmount();

    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'fixture-viewer', role: 'pharmacist', permissions: { can_view_stores: false },
    });
    render(<StoresPage />);
    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /الأصناف تعريف وتعديل/ })).not.toBeInTheDocument();
  });
});
