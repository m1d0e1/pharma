import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';
import { logoutLocal } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: false }));
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
jest.mock('@/lib/auth/roles', () => ({ getRoutePermission: () => null }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  logoutLocal: jest.fn(),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
  getClientSession: jest.fn().mockResolvedValue({
    id: 'owner-1', username: 'owner', role: 'owner', permissions: {},
  }),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

describe('dashboard logout failure recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the current route and reports a thrown sidebar logout failure', async () => {
    (logoutLocal as jest.Mock).mockRejectedValueOnce(new Error('logout bridge unavailable'));
    render(<DashboardLayout><div>web content</div></DashboardLayout>);
    expect(await screen.findByText('web content')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر تسجيل الخروج. حاول مرة أخرى.'));
    expect(mockPush).not.toHaveBeenCalledWith('/login');
  });
});
