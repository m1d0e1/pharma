import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TrialBalanceSettingsClient from '@/components/finance/TrialBalanceSettingsClient';
import {
  getAccountsAction,
  getBanksAction,
  getExpenseDefinitionsAction,
  getTrialBalanceSettingsAction,
  saveTrialBalanceSettingAction,
} from '@/app/actions-client/finance';

jest.mock('@/app/actions-client/finance', () => ({
  getAccountsAction: jest.fn(),
  getBanksAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  getTrialBalanceSettingsAction: jest.fn(),
  saveTrialBalanceSettingAction: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

describe('TrialBalanceSettingsClient accessibility regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAccountsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 1, parent_id: null, code: '1', name_ar: 'الأصول', type: 'asset', is_group: 1 },
        { id: 2, parent_id: 1, code: '1.1', name_ar: 'الخزينة الرئيسية', type: 'asset', is_group: 0 },
      ],
    });
    (getBanksAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 7, name_ar: 'البنك التجريبي' }],
    });
    (getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getTrialBalanceSettingsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (saveTrialBalanceSettingAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('opens a named dialog and lets keyboard users select a leaf account', async () => {
    render(<TrialBalanceSettingsClient canManage />);

    expect(await screen.findByText('البنك التجريبي')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ربط الحساب' }));

    expect(screen.getByRole('dialog', { name: 'اختيار الحساب المحاسبي' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'فتح الأصول' }));

    const leaf = screen.getByRole('button', { name: /الخزينة الرئيسية/ });
    expect(leaf).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(leaf, { key: 'Enter' });

    await waitFor(() => expect(saveTrialBalanceSettingAction).toHaveBeenCalledWith({
      category: 'bank',
      target_type: undefined,
      target_id: '7',
      target_name: 'البنك التجريبي',
      account_id: 2,
    }));
  });
});
