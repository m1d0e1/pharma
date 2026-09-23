import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DashboardLayout from '@/app/(dashboard)/layout';
import { useHotkeys } from 'react-hotkeys-hook';
import { hasUserPermissionSync } from '@/lib/auth/local';

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
jest.mock('@/components/TopMenuBar', () => () => null);
jest.mock('@/components/SidebarNav', () => () => null);
jest.mock('@/lib/auth/roles', () => ({ getRoutePermission: () => null }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/auth/local', () => ({
  logoutLocal: jest.fn(),
  hasUserPermissionSync: jest.fn(),
  getClientSession: jest.fn().mockResolvedValue({
    id: 'owner-1',
    username: 'owner',
    role: 'owner',
    permissions: {},
  }),
}));

function lastHotkeyHandler(keys: string) {
  const calls = (useHotkeys as jest.Mock).mock.calls.filter(args => args[0] === keys);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as (event: { preventDefault: jest.Mock }) => void;
}

describe('coverage-gap: dashboard global keyboard shortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
  });

  it('executes dashboard, inventory, purchases, POS and quick-search shortcuts through their registered handlers', async () => {
    render(
      <DashboardLayout>
        <input placeholder="بحث سريع" />
        <div>content</div>
      </DashboardLayout>,
    );
    expect(await screen.findByText('content')).toBeInTheDocument();

    for (const [keys, destination] of [
      ['ctrl+d, meta+d', '/'],
      ['ctrl+i, meta+i', '/inventory'],
      ['ctrl+o, meta+o', '/purchases'],
      ['ctrl+p, meta+p', '/pos'],
    ] as const) {
      const preventDefault = jest.fn();
      lastHotkeyHandler(keys)({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith(destination);
    }

    const search = screen.getByPlaceholderText('بحث سريع');
    expect(search).not.toHaveFocus();
    const preventDefault = jest.fn();
    lastHotkeyHandler('f1')({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(search).toHaveFocus();
  });

  it('keeps the global POS shortcut permission-sensitive', async () => {
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user, key) => key !== 'can_access_pos');
    render(<DashboardLayout><div>content</div></DashboardLayout>);
    await waitFor(() => expect(screen.getByText('content')).toBeInTheDocument());

    const preventDefault = jest.fn();
    lastHotkeyHandler('ctrl+p, meta+p')({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalledWith('/pos');
  });
});
