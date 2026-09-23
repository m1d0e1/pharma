import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import SidebarNav from '@/components/SidebarNav';
import { getClientSession } from '@/lib/auth/local';

let mockPathname = '/';
const mockPrefetch = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ prefetch: mockPrefetch }),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: (user: any, key: string) => user?.permissions?.[key] !== false,
}));

describe('SidebarNav asynchronous permission refresh ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname = '/';
  });

  it('keeps the newest permission snapshot when an older route refresh resolves later', async () => {
    let resolveFirst: (value: any) => void = () => {};
    let resolveSecond: (value: any) => void = () => {};
    (getClientSession as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    const view = render(<SidebarNav userRole="pharmacist" />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(1));

    mockPathname = '/inventory';
    view.rerender(<SidebarNav userRole="pharmacist" />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond({ permissions: { can_view_sales: false } });
    });
    expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' })).toHaveLength(0);

    await act(async () => {
      resolveFirst({ permissions: { can_view_sales: true } });
    });

    expect(screen.queryAllByRole('link', { name: 'المبيعات والتحصيل' })).toHaveLength(0);
  });
});
