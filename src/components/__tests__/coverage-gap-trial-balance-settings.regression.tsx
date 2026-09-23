import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TrialBalanceSettingsClient from '@/components/finance/TrialBalanceSettingsClient';
import {
  getAccountsAction,
  getBanksAction,
  getExpenseDefinitionsAction,
  getTrialBalanceSettingsAction,
  saveTrialBalanceSettingAction,
} from '@/app/actions-client/finance';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/finance', () => ({
  getAccountsAction: jest.fn(),
  getBanksAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  getTrialBalanceSettingsAction: jest.fn(),
  saveTrialBalanceSettingAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const accounts = [
  { id: 10, parent_id: null, code: '1', name_ar: 'الأصول', type: 'asset', is_group: 1 },
  { id: 11, parent_id: 10, code: '1.1', name_ar: 'الحساب البنكي العام', type: 'asset', is_group: 0 },
  { id: 20, parent_id: null, code: '5.1', name_ar: 'مصروفات تشغيلية', type: 'expense', is_group: 0 },
];

describe('trial-balance mapping settings UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAccountsAction as jest.Mock).mockResolvedValue({ success: true, data: accounts });
    (getBanksAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 3, name_ar: 'بنك الاختبار' }] });
    (getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 8, name_ar: 'إيجار' }] });
    (getTrialBalanceSettingsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('switches entity categories, expands the account tree, and persists a bank mapping', async () => {
    (saveTrialBalanceSettingAction as jest.Mock).mockResolvedValue({ success: true });
    render(<TrialBalanceSettingsClient />);

    expect(await screen.findByText('بنك الاختبار')).toBeInTheDocument();
    expect(screen.getByText('غير مرتبط')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'المصروفات الأخرى' }));
    expect(screen.getByText('إيجار')).toBeInTheDocument();
    expect(screen.queryByText('بنك الاختبار')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'الحسابات البنكية' }));
    fireEvent.click(screen.getByRole('button', { name: 'ربط الحساب' }));
    expect(screen.getByRole('heading', { name: 'اختيار الحساب المحاسبي' })).toBeInTheDocument();

    expect(screen.queryByText('الحساب البنكي العام')).not.toBeInTheDocument();
    const groupText = screen.getByText('الأصول');
    const groupRow = groupText.parentElement?.parentElement;
    const expand = groupRow?.querySelector('button');
    expect(expand).not.toBeNull();
    fireEvent.click(expand as HTMLButtonElement);
    fireEvent.click(screen.getByText('الحساب البنكي العام'));

    await waitFor(() => expect(saveTrialBalanceSettingAction).toHaveBeenCalledWith({
      category: 'bank',
      target_type: undefined,
      target_id: '3',
      target_name: 'بنك الاختبار',
      account_id: 11,
    }));
    expect(toast.success).toHaveBeenCalledWith('تم ربط الحساب بنجاح');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'اختيار الحساب المحاسبي' })).not.toBeInTheDocument());
    expect(getTrialBalanceSettingsAction).toHaveBeenCalledTimes(2);
  });

  it('keeps the picker open and surfaces an action error when mapping fails', async () => {
    (saveTrialBalanceSettingAction as jest.Mock).mockResolvedValue({ success: false, error: 'الحساب غير صالح' });
    render(<TrialBalanceSettingsClient />);

    await screen.findByText('بنك الاختبار');
    fireEvent.click(screen.getByRole('button', { name: 'ربط الحساب' }));
    fireEvent.click(screen.getByText('مصروفات تشغيلية'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('الحساب غير صالح'));
    expect(screen.getByRole('heading', { name: 'اختيار الحساب المحاسبي' })).toBeInTheDocument();
    expect(getTrialBalanceSettingsAction).toHaveBeenCalledTimes(1);
  });

  it('recovers from a thrown initial settings load with an explicit retry', async () => {
    (getAccountsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('finance bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: accounts });

    render(<TrialBalanceSettingsClient />);

    expect(await screen.findByText('تعذر تحميل إعدادات ميزان المراجعة')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('بنك الاختبار')).toBeInTheDocument();
    expect(getAccountsAction).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest settings retry when same-tick reloads resolve out of order', async () => {
    let resolveOlderBanks!: (value: unknown) => void;
    let resolveNewerBanks!: (value: unknown) => void;
    (getAccountsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('initial finance bridge failure'))
      .mockResolvedValue({ success: true, data: accounts });
    (getBanksAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlderBanks = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewerBanks = resolve; }));

    render(<TrialBalanceSettingsClient />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getBanksAction).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveNewerBanks({ success: true, data: [{ id: 22, name_ar: 'Newest Bank' }] });
    });
    expect(await screen.findByText('Newest Bank')).toBeInTheDocument();

    await act(async () => {
      resolveOlderBanks({ success: true, data: [{ id: 21, name_ar: 'Older Bank' }] });
    });
    expect(screen.getByText('Newest Bank')).toBeInTheDocument();
    expect(screen.queryByText('Older Bank')).not.toBeInTheDocument();
  });

  it('keeps the picker usable after a thrown mapping write', async () => {
    (saveTrialBalanceSettingAction as jest.Mock).mockRejectedValueOnce(new Error('write bridge unavailable'));
    render(<TrialBalanceSettingsClient />);

    await screen.findByText('بنك الاختبار');
    fireEvent.click(screen.getByRole('button', { name: 'ربط الحساب' }));
    fireEvent.click(screen.getByText('مصروفات تشغيلية'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل الربط'));
    expect(screen.getByRole('heading', { name: 'اختيار الحساب المحاسبي' })).toBeInTheDocument();
    expect(screen.getByText('مصروفات تشغيلية')).toBeInTheDocument();
  });

  it('blocks duplicate mapping writes while a selection is still being saved', async () => {
    let resolveSave: (value: { success: boolean }) => void = () => {};
    (saveTrialBalanceSettingAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveSave = resolve;
    }));
    render(<TrialBalanceSettingsClient />);

    await screen.findByText('بنك الاختبار');
    fireEvent.click(screen.getByRole('button', { name: 'ربط الحساب' }));
    const account = screen.getByText('مصروفات تشغيلية');
    fireEvent.click(account);
    fireEvent.click(account);

    expect(saveTrialBalanceSettingAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('جاري الربط...')).toBeInTheDocument();

    resolveSave({ success: false });
    await waitFor(() => expect(screen.queryByText('جاري الربط...')).not.toBeInTheDocument());
  });

  it('keeps the last valid settings visible when a committed mapping refresh fails, and allows retry', async () => {
    (saveTrialBalanceSettingAction as jest.Mock).mockResolvedValue({ success: true });
    (getTrialBalanceSettingsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: false, error: 'refresh unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          category: 'bank', target_id: '3', target_name: 'بنك الاختبار',
          account_id: 11, account_code: '1.1', account_name: 'الحساب البنكي العام',
        }],
      });

    render(<TrialBalanceSettingsClient />);
    await screen.findByText('بنك الاختبار');
    fireEvent.click(screen.getByRole('button', { name: 'ربط الحساب' }));
    fireEvent.click(screen.getByText('مصروفات تشغيلية'));

    await waitFor(() => expect(saveTrialBalanceSettingAction).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تم ربط الحساب بنجاح');
    expect(await screen.findByText('تعذر تحديث إعدادات ميزان المراجعة')).toBeInTheDocument();
    expect(screen.getByText('بنك الاختبار')).toBeInTheDocument();
    expect(screen.queryByText('تعذر تحميل إعدادات ميزان المراجعة')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل الإعدادات' }));
    expect(await screen.findByText('الحساب البنكي العام')).toBeInTheDocument();
    expect(getTrialBalanceSettingsAction).toHaveBeenCalledTimes(3);
  });
});
