import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsPage from '@/app/(dashboard)/settings/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getLocalPharmacySettingsClient } from '@/lib/settings/client';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/lib/settings/client', () => ({
  getLocalPharmacySettingsClient: jest.fn(),
}));

jest.mock('@/components/settings/PharmacySettingsForm', () => function PharmacySettingsFormStub() {
  return <div>pharmacy-settings-form</div>;
});
jest.mock('@/components/settings/SyncSettings', () => function SyncSettingsStub() {
  return <div>sync-settings</div>;
});
jest.mock('@/components/settings/DbMaintenance', () => function DbMaintenanceStub() {
  return <div>db-maintenance</div>;
});
jest.mock('@/components/settings/LocalUserManagement', () => function LocalUserManagementStub() {
  return <div>local-users</div>;
});
jest.mock('@/components/AccessDenied', () => function AccessDeniedStub() {
  return <div>access-denied</div>;
});

describe('SettingsPage loader ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockReset();
    (getLocalPharmacySettingsClient as jest.Mock).mockReset();
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any) => user?.role === 'owner');
  });

  it('does not keep an earlier allowed state when retry resolves to a denied session', async () => {
    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'owner-1', role: 'owner' })
      .mockResolvedValueOnce({ id: 'pharmacist-1', role: 'pharmacist' });
    (getLocalPharmacySettingsClient as jest.Mock).mockRejectedValueOnce(new Error('settings unavailable'));

    render(<SettingsPage />);
    expect(await screen.findByText('تعذر تحميل إعدادات النظام')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('access-denied')).toBeInTheDocument();
    expect(screen.queryByText('pharmacy-settings-form')).not.toBeInTheDocument();
    expect(getLocalPharmacySettingsClient).toHaveBeenCalledTimes(1);
  });

  it('does not let an older owner retry re-authorize settings after a newer denied retry', async () => {
    let resolveOlder!: (value: unknown) => void;
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({ id: 'pharmacist-2', role: 'pharmacist' });
    (getLocalPharmacySettingsClient as jest.Mock).mockResolvedValue({ name: 'Owner Pharmacy' });

    render(<SettingsPage />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(await screen.findByText('access-denied')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ id: 'owner-2', role: 'owner' });
    });

    await waitFor(() => expect(screen.getByText('access-denied')).toBeInTheDocument());
    expect(screen.queryByText('pharmacy-settings-form')).not.toBeInTheDocument();
  });
});
