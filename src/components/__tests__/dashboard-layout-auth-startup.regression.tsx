import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';
import { getClientSession } from '@/lib/auth/local';
import { dbGet } from '@/lib/db/tauri';

const mockRouter = { push: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
let mockPathname = '/patients';
const authorizedPatient = {
  id: 'patient-reader',
  username: 'reader',
  role: 'pharmacist',
  pharmacy_id: 'pharmacy-one',
  permissions: { can_view_patients: true, can_view_settings: false },
};

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => mockRouter,
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/components/HeaderAlerts', () => () => null);
jest.mock('@/components/ThemeToggle', () => () => null);
jest.mock('@/components/SidebarNav', () => () => null);
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() {
  return <div>route denied</div>;
});
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  logoutLocal: jest.fn(),
  hasUserPermissionSync: (user: any, key: string) =>
    user?.role === 'owner' || user?.permissions?.[key] === true,
}));

describe('dashboard layout identity and route gate timing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname = '/patients';
    (getClientSession as jest.Mock).mockReset();
    (dbGet as jest.Mock).mockResolvedValue(null);
  });

  it('starts the shared identity guard while the separate layout session read is pending', async () => {
    const pending: Array<(user: typeof authorizedPatient) => void> = [];
    (getClientSession as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { pending.push(resolve); }))
      .mockImplementationOnce(() => new Promise(resolve => { pending.push(resolve); }))
      .mockResolvedValue(authorizedPatient);

    render(<DashboardLayout><div>protected patient screen</div></DashboardLayout>);
    // The old shell waited for its own session before even mounting AuthGuard,
    // so the second independent read started only after the first resolved.
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('protected patient screen')).not.toBeInTheDocument();
    expect(dbGet).not.toHaveBeenCalled();

    await act(async () => { pending[0](authorizedPatient); });
    expect(screen.queryByText('protected patient screen')).not.toBeInTheDocument();

    await act(async () => { pending[1](authorizedPatient); });
    expect(await screen.findByText('protected patient screen')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(3);
  });

  it('never mounts protected content when the identity check finds no session', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(null);
    render(<DashboardLayout><div>private patient screen</div></DashboardLayout>);

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('private patient screen')).not.toBeInTheDocument();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('keeps the identity guard mounted across routes, but rechecks each route grant', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(authorizedPatient);
    const view = render(<DashboardLayout><div>patient screen</div></DashboardLayout>);
    expect(await screen.findByText('patient screen')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(3);
    expect(dbGet).toHaveBeenCalledTimes(1);

    let resolveNext!: (user: typeof authorizedPatient) => void;
    (getClientSession as jest.Mock).mockImplementationOnce(
      () => new Promise(resolve => { resolveNext = resolve; }),
    );
    mockPathname = '/settings';
    view.rerender(<DashboardLayout><div>settings screen</div></DashboardLayout>);

    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(4));
    expect(screen.queryByText('patient screen')).not.toBeInTheDocument();
    expect(screen.queryByText('settings screen')).not.toBeInTheDocument();
    expect(screen.queryByText('جاري التحقق من الهوية...')).not.toBeInTheDocument();
    expect(dbGet).toHaveBeenCalledTimes(1);

    await act(async () => resolveNext(authorizedPatient));
    expect(await screen.findByText('route denied')).toBeInTheDocument();
    expect(screen.queryByText('settings screen')).not.toBeInTheDocument();
  });
});
