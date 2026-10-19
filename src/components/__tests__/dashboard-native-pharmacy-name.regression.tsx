import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';
import { getConfigAction } from '@/app/actions-client/config';
import { dbGet } from '@/lib/db/tauri';

let mockNative = true;
const mockPush = jest.fn();
const mockSession = { id: 'owner-a', username: 'owner', role: 'owner', pharmacy_id: 'tenant-a', permissions: {} };

jest.mock('@/lib/env', () => ({ get isTauri() { return mockNative; } }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }), usePathname: () => '/' }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/components/AuthGuard', () => ({ children }: any) => children);
jest.mock('@/components/PermissionGuard', () => ({ children }: any) => children);
jest.mock('@/components/HeaderAlerts', () => () => null);
jest.mock('@/components/ThemeToggle', () => () => null);
jest.mock('@/components/SidebarNav', () => () => null);
jest.mock('@/app/actions-client/config', () => ({ getConfigAction: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: () => true,
  logoutLocal: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn(async () => undefined) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ listen: jest.fn(async () => jest.fn()) }) }));
jest.mock('@tauri-apps/plugin-updater', () => ({ check: jest.fn(async () => null) }));
jest.mock('@tauri-apps/plugin-dialog', () => ({ ask: jest.fn(), message: jest.fn() }));
jest.mock('@tauri-apps/plugin-process', () => ({ relaunch: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockNative = true;
  (dbGet as jest.Mock).mockRejectedValue(new Error('STRICT SQL denied'));
  (getConfigAction as jest.Mock).mockResolvedValue({ success: true, value: 'QA Branch Scoped' });
});

it('uses native scoped pharmacy identity only, never renderer SQL on the desktop', async () => {
  render(<DashboardLayout><div>QA owned content</div></DashboardLayout>);
  await waitFor(() => expect(getConfigAction).toHaveBeenCalledWith('pharmacy_name'));
  expect(await screen.findAllByText('QA Branch Scoped')).not.toHaveLength(0);
  expect(dbGet).not.toHaveBeenCalled();
});

it('keeps neutral display fallback on absent or denied native name without showing foreign config', async () => {
  (getConfigAction as jest.Mock).mockResolvedValue({ success: false, error: 'native permission denied' });
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    render(<DashboardLayout><div>QA owned content</div></DashboardLayout>);
    await waitFor(() => expect(getConfigAction).toHaveBeenCalledWith('pharmacy_name'));
    expect(await screen.findAllByText('فارما تيك')).not.toHaveLength(0);
    expect(screen.queryByText('QA Branch Scoped')).not.toBeInTheDocument();
    expect(dbGet).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalledWith('Failed to fetch pharmacy name:', expect.anything());
  } finally { errorLog.mockRestore(); }
});

it('preserves the scoped browser SQL implementation', async () => {
  mockNative = false;
  (dbGet as jest.Mock).mockResolvedValue({ value: 'QA Web Branch' });
  render(<DashboardLayout><div>Web content</div></DashboardLayout>);
  expect(await screen.findAllByText('QA Web Branch')).not.toHaveLength(0);
  expect(dbGet).toHaveBeenCalledWith('SELECT value FROM config WHERE key = ?', [
    'pharmacy:tenant-a:pharmacy_name',
  ]);
  expect(getConfigAction).not.toHaveBeenCalled();
});
