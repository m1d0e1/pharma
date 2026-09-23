import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewOpeningBalanceClient from '@/app/(dashboard)/inventory/opening-balances/new/page';
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  addOpeningBalanceAction: jest.fn(),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

const catalogDrug = {
  id: 77,
  trade_name: 'بانادول',
  trade_name_en: 'Panadol',
  purchase_price: 12.5,
  official_price: 20,
};

async function selectCatalogDrug() {
  (searchMasterDrugsAction as jest.Mock).mockResolvedValueOnce({
    success: true,
    data: [catalogDrug],
  });
  fireEvent.change(
    screen.getByPlaceholderText('ادخل اسم الدواء بالعربية أو الإنجليزية...'),
    { target: { value: 'Pana' } },
  );
  fireEvent.click(await screen.findByText('Panadol'));
}

describe('coverage gap: opening-balance creation route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('switches active-ingredient search on and clears stale suggestions when a later search fails', async () => {
    (searchMasterDrugsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [catalogDrug] })
      .mockResolvedValueOnce({ success: false, error: 'catalog unavailable' });

    render(<NewOpeningBalanceClient />);

    const search = screen.getByPlaceholderText('ادخل اسم الدواء بالعربية أو الإنجليزية...');
    fireEvent.change(search, { target: { value: 'Pana' } });
    expect(await screen.findByText('Panadol')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'البحث بالمادة الفعالة' }));
    await waitFor(() => expect(searchMasterDrugsAction).toHaveBeenLastCalledWith({
      query: 'Pana',
      searchByActiveIngredient: true,
      status: 'active',
    }));

    await waitFor(() => expect(screen.queryByText('Panadol')).not.toBeInTheDocument());
    expect(toast.error).toHaveBeenCalledWith('catalog unavailable');
  });

  it('recovers from a thrown save error without leaving the form stuck in saving state', async () => {
    (addOpeningBalanceAction as jest.Mock).mockRejectedValueOnce(new Error('db unavailable'));

    render(<NewOpeningBalanceClient />);
    await selectCatalogDrug();
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), {
      target: { value: '2029-12-31' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' })).toBeEnabled();
    });
    expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء حفظ الرصيد الإفتتاحي');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps a committed opening balance acknowledged and locked when post-save navigation throws', async () => {
    mockPush.mockImplementationOnce(() => { throw new Error('navigation unavailable'); });
    (addOpeningBalanceAction as jest.Mock).mockResolvedValueOnce({ success: true });

    render(<NewOpeningBalanceClient />);
    await selectCatalogDrug();
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), {
      target: { value: '2029-12-31' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' }));

    await waitFor(() => expect(addOpeningBalanceAction).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تم إضافة الرصيد الإفتتاحي بنجاح');
    expect(toast.error).toHaveBeenCalledWith('تم إضافة الرصيد الإفتتاحي بنجاح لكن تعذر فتح قائمة الأرصدة الإفتتاحية');
    expect(toast.error).not.toHaveBeenCalledWith('حدث خطأ أثناء حفظ الرصيد الإفتتاحي');
    expect(screen.getByRole('button', { name: 'تم حفظ الرصيد الإفتتاحي' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'تم حفظ الرصيد الإفتتاحي' }));
    expect(addOpeningBalanceAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest catalog search result when an older request resolves late', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    (searchMasterDrugsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<NewOpeningBalanceClient />);

    const search = screen.getByPlaceholderText('ادخل اسم الدواء بالعربية أو الإنجليزية...');
    fireEvent.change(search, { target: { value: 'Pana' } });
    fireEvent.change(search, { target: { value: 'Cata' } });

    resolveNewer({
      success: true,
      data: [{ id: 88, trade_name: 'كتافلام', trade_name_en: 'Cataflam' }],
    });
    expect(await screen.findByText('Cataflam')).toBeInTheDocument();

    resolveOlder({ success: true, data: [catalogDrug] });
    await waitFor(() => {
      expect(screen.getByText('Cataflam')).toBeInTheDocument();
      expect(screen.queryByText('Panadol')).not.toBeInTheDocument();
    });
  });

  it('submits edited quantity/prices and navigates back to the opening-balance list on success', async () => {
    (addOpeningBalanceAction as jest.Mock).mockResolvedValueOnce({ success: true });

    render(<NewOpeningBalanceClient />);
    await selectCatalogDrug();

    const spinButtons = screen.getAllByRole('spinbutton');
    fireEvent.change(spinButtons[0], { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('سعر التكلفة (للعلبة)'), { target: { value: '11.75' } });
    fireEvent.change(spinButtons[2], { target: { value: '19.5' } });
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), { target: { value: '2029-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' }));

    await waitFor(() => expect(addOpeningBalanceAction).toHaveBeenCalledWith({
      drug_id: 77,
      quantity: 3,
      cost_price: 11.75,
      unit_price: 19.5,
      expiry_date: '2029-12-31',
    }));
    expect(toast.success).toHaveBeenCalledWith('تم إضافة الرصيد الإفتتاحي بنجاح');
    expect(mockPush).toHaveBeenCalledWith('/inventory/opening-balances');
  });

  it('blocks repeated opening-balance writes while the first inventory mutation is pending', async () => {
    let resolveSave: (value: { success: boolean; error?: string }) => void = () => {};
    (addOpeningBalanceAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveSave = resolve;
    }));

    render(<NewOpeningBalanceClient />);
    await selectCatalogDrug();
    fireEvent.change(screen.getByLabelText('تاريخ الصلاحية'), {
      target: { value: '2029-12-31' },
    });
    const save = screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' });

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(addOpeningBalanceAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave({ success: false, error: 'تعذر الحفظ مؤقتاً' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ الرصيد الإفتتاحي' })).toBeEnabled());
  });
});
