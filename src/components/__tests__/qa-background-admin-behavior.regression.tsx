import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { getClientSession, getLocalSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';
import LocalUserManagement from '@/components/settings/LocalUserManagement';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  getLocalSession: jest.fn(),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbExecute: jest.fn(),
  dbSelect: jest.fn(),
  dbTransaction: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn() } }));

const owner = { id: 'synthetic-owner', role: 'owner', pharmacy_id: 'synthetic-branch' };
const delegate = {
  id: 'synthetic-admin', role: 'admin', pharmacy_id: 'synthetic-branch',
  permissions: { can_manage_users: true, manage_staff: true },
};

describe('QA background settings/admin native staff behavior', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue(owner);
    (getLocalSession as jest.Mock).mockResolvedValue(owner);
  });

  it('does not render owner controls or request native staff for a delegated admin', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(delegate);
    render(<LocalUserManagement />);

    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('إدارة المستخدمين المحليين')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إضافة مستخدم' })).not.toBeInTheDocument();
    expect(getLocalSession).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('renders native staff summaries and routes owner add/edit controls without a write IPC', async () => {
    (invoke as jest.Mock).mockResolvedValue([
      { id: 'staff-qa-1', full_name: 'Synthetic Pharmacist', username: 'qa-pharmacist', role: 'pharmacist', has_password: true },
      { id: 'staff-qa-2', full_name: 'Synthetic Cashier', username: 'qa-cashier', role: 'cashier', has_password: false },
    ]);
    render(<LocalUserManagement />);

    expect(await screen.findByText('Synthetic Pharmacist')).toBeInTheDocument();
    expect(screen.getByText('Synthetic Cashier')).toBeInTheDocument();
    expect(screen.getByText('بدون كلمة مرور')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('list_local_staff_summaries');

    fireEvent.click(screen.getByRole('button', { name: 'إضافة مستخدم' }));
    fireEvent.click(screen.getByRole('button', { name: 'تعديل الموظف Synthetic Cashier وصلاحياته' }));
    expect(mockPush).toHaveBeenNthCalledWith(1, '/staff/manage?add=true');
    expect(mockPush).toHaveBeenNthCalledWith(2, '/staff/manage?edit=staff-qa-2');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rechecks ownership in the adapter and denies a revoked session before native IPC', async () => {
    (getLocalSession as jest.Mock)
      .mockResolvedValueOnce(delegate)
      .mockResolvedValueOnce(owner);
    (invoke as jest.Mock).mockResolvedValue([
      { id: 'staff-qa-3', full_name: 'Recovered Synthetic Staff', username: 'qa-recovered', role: 'pharmacist', has_password: true },
    ]);
    render(<LocalUserManagement />);

    expect(await screen.findByText('تعذر تحميل المستخدمين المحليين')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('غير مصرح - للمالك فقط');
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Recovered Synthetic Staff')).toBeInTheDocument();
    expect(getLocalSession).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('list_local_staff_summaries');
  });

  it('shows a retryable error after native IPC refusal without displaying stale staff', async () => {
    const expectedConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (invoke as jest.Mock)
        .mockRejectedValueOnce(new Error('License required: synthetic lease expired'))
        .mockResolvedValueOnce([
          { id: 'staff-qa-4', full_name: 'Native Retry Staff', username: 'qa-retry', role: 'pharmacist', has_password: true },
        ]);
      render(<LocalUserManagement />);

      expect(await screen.findByText('تعذر تحميل المستخدمين المحليين')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('فشل تحميل مستخدمين الصيدلية المحلية');
      expect(screen.queryByText('Native Retry Staff')).not.toBeInTheDocument();
      expect(invoke).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      expect(await screen.findByText('Native Retry Staff')).toBeInTheDocument();
      expect(invoke).toHaveBeenCalledTimes(2);
      expect((invoke as jest.Mock).mock.calls.map(([command]) => command)).toEqual([
        'list_local_staff_summaries', 'list_local_staff_summaries',
      ]);
      expect(screen.queryByText('تعذر تحميل المستخدمين المحليين')).not.toBeInTheDocument();
    } finally {
      expectedConsoleError.mockRestore();
    }
  });
});
