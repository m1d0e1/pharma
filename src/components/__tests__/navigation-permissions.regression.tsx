import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SidebarNav from '@/components/SidebarNav';

describe('permission-aware navigation', () => {
  it('applies admin checkboxes instead of granting blanket access', () => {
    render(<SidebarNav userRole="admin" userPermissions={{ can_view_settings: false }} />);
    expect(screen.queryByRole('link', { name: 'الإعدادات' })).not.toBeInTheDocument();
  });

  it('allows a configured permission even when the legacy role list omitted the user role', () => {
    render(<SidebarNav userRole="pharmacist" userPermissions={{ can_view_purchases: true }} />);
    expect(screen.getAllByRole('link', { name: 'المشتريات' }).length).toBeGreaterThan(0);
  });

  it('keeps owner access unconditional', () => {
    render(<SidebarNav userRole="owner" userPermissions={{}} />);
    expect(screen.getByRole('link', { name: 'الإعدادات' })).toBeInTheDocument();
  });

  it('keeps historical COGS correction owner-only even if an admin has the legacy view flag', () => {
    const { rerender } = render(<SidebarNav userRole="admin" userPermissions={{ can_view_cogs: true }} />);
    expect(screen.queryByRole('link', { name: 'تعديل التكلفة' })).not.toBeInTheDocument();

    rerender(<SidebarNav userRole="owner" userPermissions={{}} />);
    expect(screen.getByRole('link', { name: 'تعديل التكلفة' })).toBeInTheDocument();
  });

  it('hides POS and inventory links when their explicit permissions are denied', () => {
    render(<SidebarNav userRole="pharmacist" userPermissions={{ can_access_pos: false, can_view_stores: false }} />);
    expect(screen.queryByRole('link', { name: 'فاتورة مبيعات جديدة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'المخزون' })).not.toBeInTheDocument();
  });

  it('shows POS and inventory links when their explicit permissions are granted', () => {
    render(<SidebarNav userRole="pharmacist" userPermissions={{ can_access_pos: true, can_view_stores: true }} />);
    expect(screen.getAllByRole('link', { name: 'فاتورة مبيعات جديدة' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'المخزون' }).length).toBeGreaterThan(0);
  });

  it('uses the sales permission while keeping legacy missing-key access', () => {
    const { rerender } = render(<SidebarNav userRole="pharmacist" userPermissions={{ can_view_sales: false }} />);
    expect(screen.queryByRole('link', { name: 'المبيعات والتحصيل' })).not.toBeInTheDocument();

    rerender(<SidebarNav userRole="pharmacist" userPermissions={{}} />);
    expect(screen.getAllByRole('link', { name: 'المبيعات والتحصيل' }).length).toBeGreaterThan(0);
  });

  it('mounts one mobile nav outside a hidden sidebar and keeps More count deduplicated', async () => {
    const user = userEvent.setup();
    render(
      <aside className="hidden lg:flex">
        <SidebarNav userRole="admin" userPermissions={{
          can_view_sales: true,
          can_view_receipts: true,
          can_view_delivery: true,
          can_view_returns: true,
          can_view_purchases: true,
          acc_can_view_general: true,
          can_view_shifts: true,
          can_view_settings: true,
        }} />
      </aside>,
    );

    const mobileNav = screen.getByRole('navigation', { name: 'التنقل الرئيسي للجوال' });
    expect(mobileNav.closest('aside')).toBeNull();

    const primaryLinks = within(mobileNav).getAllByRole('link');
    expect(primaryLinks).toHaveLength(5);
    const moreButton = within(mobileNav).getByRole('button', { name: 'المزيد من الخيارات' });
    const moreCount = Number(within(moreButton).getByText(/^\+\d+$/).textContent?.slice(1));
    expect(moreCount).toBeGreaterThan(0);

    await user.click(moreButton);
    const allMobileLinks = within(mobileNav).getAllByRole('link');
    const hrefs = allMobileLinks.map(link => link.getAttribute('href'));
    expect(allMobileLinks).toHaveLength(primaryLinks.length + moreCount);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
