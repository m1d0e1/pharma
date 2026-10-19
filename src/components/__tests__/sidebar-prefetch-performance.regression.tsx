/** @jest-environment jsdom */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SidebarNav from '@/components/SidebarNav';

const mockPrefetch = jest.fn();
let mockPathname = '/';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ prefetch: mockPrefetch }),
}));

// Expose the actual Link prefetch input; JSDOM cannot run Next's viewport
// observer and therefore would otherwise miss eager route prefetching.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, prefetch, ...props }: any) =>
    React.createElement('a', { ...props, 'data-prefetch': String(prefetch) }, children),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: (user: any, key: string) => user?.permissions?.[key] === true,
}));

describe('sidebar navigation prefetch budget', () => {
  beforeEach(() => {
    mockPathname = '/';
    mockPrefetch.mockClear();
  });

  it('loads priority routes eagerly and leaves other authorized links clickable without viewport prefetch', () => {
    render(<SidebarNav userRole="admin" userPermissions={{
      can_view_stores: true, preview_item_movements: true, can_view_purchases: false,
    }} />);
    const desktop = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    const priority = within(desktop).getByRole('link', { name: 'المخزون' });
    const deferred = within(desktop).getByRole('link', { name: 'حركات الأصناف' });
    expect(priority).toHaveAttribute('href', '/inventory');
    expect(priority).toHaveAttribute('data-prefetch', 'true');
    expect(deferred).toHaveAttribute('href', '/inventory/item-movements');
    expect(deferred).toHaveAttribute('data-prefetch', 'false');
    expect(screen.queryByRole('link', { name: 'المشتريات' })).not.toBeInTheDocument();
    expect(mockPrefetch).not.toHaveBeenCalled();
  });

  it('prefetches an authorized destination once across repeat desktop and mobile hovers while leaving navigation intact', () => {
    const view = render(<SidebarNav userRole="owner" userPermissions={{}} />);
    const desktop = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    const movement = within(desktop).getByRole('link', { name: 'حركات الأصناف' });
    const purchases = within(desktop).getByRole('link', { name: 'المشتريات' });
    fireEvent.mouseEnter(movement);
    fireEvent.mouseEnter(movement);
    fireEvent.mouseEnter(purchases);
    expect(mockPrefetch.mock.calls).toEqual([
      ['/inventory/item-movements'], ['/purchases'],
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'المزيد من الخيارات' }));
    const mobile = screen.getByRole('navigation', { name: 'التنقل الرئيسي للجوال' });
    const movementMobile = within(mobile).getByRole('link', { name: 'حركات الأصناف' });
    expect(movementMobile).toHaveAttribute('href', '/inventory/item-movements');
    expect(movementMobile).toHaveAttribute('data-prefetch', 'false');
    fireEvent.mouseEnter(movementMobile);
    expect(mockPrefetch).toHaveBeenCalledTimes(2);

    mockPathname = '/inventory/item-movements';
    view.rerender(<SidebarNav userRole="owner" userPermissions={{}} />);
    expect(movement).toHaveAttribute('aria-current', 'page');
    fireEvent.mouseEnter(movement);
    expect(mockPrefetch).toHaveBeenCalledTimes(2);
  });
});
