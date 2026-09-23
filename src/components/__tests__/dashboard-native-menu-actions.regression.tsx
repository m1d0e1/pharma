import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';
import { logoutLocal } from '@/lib/auth/local';
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
jest.mock('@/components/TopMenuBar', () => () => null);
jest.mock('@/components/SidebarNav', () => () => null);
jest.mock('@/lib/auth/roles', () => ({ getRoutePermission: () => null }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  logoutLocal: jest.fn(),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
  getClientSession: jest.fn().mockResolvedValue({
    id: 'owner-1', username: 'owner', role: 'owner', permissions: {},
  }),
}));
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
