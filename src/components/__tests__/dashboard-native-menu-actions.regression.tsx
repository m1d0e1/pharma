import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';
import { getClientSession, hasUserPermissionSync, logoutLocal } from '@/lib/auth/local';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-hot-toast';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

const mockPush = jest.fn();
const listenHandlers: Record<string, (event: { payload: string }) => unknown> = {};
const mockListen = jest.fn(async (event: string, handler: (event: { payload: string }) => unknown) => {
  listenHandlers[event] = handler;
  return jest.fn();
});

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/components/AuthGuard', () => ({ children }: any) => children);
jest.mock('@/components/PermissionGuard', () => ({ children }: any) => children);
jest.mock('@/components/HeaderAlerts', () => () => null);
jest.mock('@/components/ThemeToggle', () => () => null);
jest.mock('@/components/SidebarNav', () => () => null);
jest.mock('@/lib/auth/roles', () => jest.requireActual('@/lib/auth/roles'));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  logoutLocal: jest.fn(),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
  getClientSession: jest.fn().mockResolvedValue({
    id: 'owner-1', username: 'owner', role: 'owner', permissions: {},
  }),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: mockListen }),
}));
jest.mock('@tauri-apps/api/app', () => ({ getVersion: jest.fn().mockResolvedValue('0.2.96') }));
jest.mock('@tauri-apps/plugin-updater', () => ({ check: jest.fn() }));
jest.mock('@tauri-apps/plugin-dialog', () => ({
  ask: jest.fn(),
  message: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@tauri-apps/plugin-process', () => ({ relaunch: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: {
    loading: jest.fn().mockReturnValue('toast-update'),
    dismiss: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

async function renderAndGetMenuAction() {
  render(<DashboardLayout><div>native content</div></DashboardLayout>);
  expect(await screen.findByText('native content')).toBeInTheDocument();
  await waitFor(() => expect(mockListen).toHaveBeenCalledWith('menu-action', expect.any(Function)));
  expect(listenHandlers['menu-action']).toBeDefined();
  return listenHandlers['menu-action'];
}

describe('dashboard native menu actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(listenHandlers)) delete listenHandlers[key];
    jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not install or relaunch when the user cancels an available update', async () => {
    const downloadAndInstall = jest.fn();
    (check as jest.Mock).mockResolvedValue({ version: '0.2.97', downloadAndInstall });
    (ask as jest.Mock).mockResolvedValue(false);
    const menuAction = await renderAndGetMenuAction();

    await act(async () => { await menuAction({ payload: 'update' }); });

    expect(ask).toHaveBeenCalled();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('reports update installation failure and does not relaunch', async () => {
    const downloadAndInstall = jest.fn().mockRejectedValue(new Error('installer locked'));
    (check as jest.Mock).mockResolvedValue({ version: '0.2.97', downloadAndInstall });
    (ask as jest.Mock).mockResolvedValue(true);
    const menuAction = await renderAndGetMenuAction();

    await act(async () => { await menuAction({ payload: 'update' }); });

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('فشل التثبيت. تأكد من إغلاق الملفات وحاول مرة أخرى.', { id: 'toast-update' });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('keeps the current route and reports a thrown native-menu logout failure', async () => {
    (logoutLocal as jest.Mock).mockRejectedValueOnce(new Error('logout bridge unavailable'));
    const menuAction = await renderAndGetMenuAction();

    await act(async () => { await menuAction({ payload: 'logout' }); });

    expect(mockPush).not.toHaveBeenCalledWith('/login');
    expect(toast.error).toHaveBeenCalledWith('تعذر تسجيل الخروج. حاول مرة أخرى.');
  });

  it('syncs native Administration menu visibility to the authenticated permissions', async () => {
    (getClientSession as jest.Mock).mockResolvedValueOnce({
      id: 'pharmacist-1',
      username: 'pharmacist',
      role: 'pharmacist',
      permissions: {
        can_view_low_stock: true,
        can_view_shifts: true,
        rep_can_view_activity: false,
        can_view_staff_manage: false,
        can_view_staff_roles: false,
        can_view_audit: false,
        can_view_settings: false,
      },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) =>
      user.role === 'owner' || user.permissions?.[key] === true
    );

    render(<DashboardLayout><div>native content</div></DashboardLayout>);
    expect(await screen.findByText('native content')).toBeInTheDocument();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sync_native_admin_menu', {
      access: {
        staff: false,
        staffManage: false,
        staffRoles: false,
        audit: false,
        settings: false,
        allowedRouteIds: ['dashboard'],
      },
    }));
  });

  it('serializes the final hidden-menu sync behind an in-flight visibility sync on unmount', async () => {
    let resolveVisibleSync: (() => void) | undefined;
    (invoke as jest.Mock)
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveVisibleSync = resolve; }))
      .mockResolvedValue(undefined);

    const view = render(<DashboardLayout><div>native content</div></DashboardLayout>);
    expect(await screen.findByText('native content')).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    view.unmount();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => { resolveVisibleSync?.(); });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith('sync_native_admin_menu', {
      access: {
        staff: false,
        staffManage: false,
        staffRoles: false,
        audit: false,
        settings: false,
        allowedRouteIds: [],
      },
    });
  });

  it('owns only one Escape listener when the native shortcuts action is invoked repeatedly', async () => {
    const menuAction = await renderAndGetMenuAction();

    await act(async () => {
      await menuAction({ payload: 'shortcuts' });
      await menuAction({ payload: 'shortcuts' });
    });
    (toast.dismiss as jest.Mock).mockClear();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(toast.dismiss).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith('shortcuts-toast');
  });

  it('forwards the native F10 purchase-draft action even while web focus is transiently lost', async () => {
    const onDraft = jest.fn();
    window.addEventListener('pharma:purchase-save-draft', onDraft);
    jest.mocked(document.hasFocus).mockReturnValue(false);
    const menuAction = await renderAndGetMenuAction();

    await act(async () => { await menuAction({ payload: 'purchase-save-draft' }); });

    expect(onDraft).toHaveBeenCalledTimes(1);
    window.removeEventListener('pharma:purchase-save-draft', onDraft);
  });

  it('removes the native shortcuts Escape listener when the dashboard layout unmounts', async () => {
    const view = render(<DashboardLayout><div>native content</div></DashboardLayout>);
    expect(await screen.findByText('native content')).toBeInTheDocument();
    await waitFor(() => expect(mockListen).toHaveBeenCalledWith('menu-action', expect.any(Function)));
    const menuAction = listenHandlers['menu-action'];

    await act(async () => { await menuAction({ payload: 'shortcuts' }); });
    (toast.dismiss as jest.Mock).mockClear();
    view.unmount();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(toast.dismiss).not.toHaveBeenCalled();
  });
});
