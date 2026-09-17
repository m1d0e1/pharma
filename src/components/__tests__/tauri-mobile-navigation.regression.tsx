import { render, screen } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/components/AuthGuard', () => ({ children }: any) => children);
jest.mock('@/components/PermissionGuard', () => ({ children }: any) => children);
jest.mock('@/components/HeaderAlerts', () => () => null);
jest.mock('@/components/ThemeToggle', () => () => null);
jest.mock('@/components/TopMenuBar', () => () => null);
jest.mock('@/lib/auth/roles', () => ({ getRoutePermission: () => null }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  logoutLocal: jest.fn(),
  hasUserPermissionSync: (_user: any, key: string) => key !== 'can_access_pos',
  getClientSession: jest.fn().mockResolvedValue({
    id: 'lowpriv',
    username: 'lowpriv',
    role: 'pharmacist',
    permissions: JSON.stringify({
      can_access_pos: false,
      can_view_sales: true,
      can_view_stores: true,
      can_view_patients: true,
    }),
  }),
}));

describe('Tauri mobile navigation mount', () => {
  it('mounts SidebarNav in the Tauri layout so the body portal can render without exposing POS', async () => {
    render(<DashboardLayout><div>content</div></DashboardLayout>);

    const mobileNav = await screen.findByRole('navigation', { name: 'التنقل الرئيسي للجوال' });
    expect(mobileNav).toBeInTheDocument();
    expect(mobileNav.parentElement).toBe(document.body);
    expect(screen.queryByRole('link', { name: 'فاتورة مبيعات جديدة' })).not.toBeInTheDocument();
  });
});
