import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SidebarNav from '@/components/SidebarNav';

let mockPathname = '/reports/sales';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ prefetch: jest.fn() }),
}));

describe('RTL workbench navigation states', () => {
  beforeEach(() => { mockPathname = '/reports/sales'; });

  it('marks only the most specific visible report route as the current page', () => {
    const { container } = render(<SidebarNav userRole="owner" userPermissions={{}} />);
    const desktopNav = container.querySelector('nav[aria-label="التنقل الرئيسي"]');
    expect(desktopNav?.querySelector('a[href="/reports/sales"]')).toHaveAttribute('aria-current', 'page');
    expect(desktopNav?.querySelector('a[href="/reports"]')).not.toHaveAttribute('aria-current');
  });

  it('groups available secondary navigation and preserves the existing links', async () => {
    const user = userEvent.setup();
    render(<SidebarNav userRole="owner" userPermissions={{}} />);
    const mobileNav = screen.getByRole('navigation', { name: 'التنقل الرئيسي للجوال' });
    const moreButton = within(mobileNav).getByRole('button', { name: 'المزيد من الخيارات' });
    expect(moreButton).toHaveAttribute('aria-describedby', 'pharma-mobile-more-current');
    expect(moreButton.className).toContain('bg-primary-50');
    await user.click(moreButton);
    expect(within(mobileNav).getByRole('heading', { name: 'التقارير' })).toBeInTheDocument();
    const currentLink = within(mobileNav).getByRole('link', { name: 'تقارير المبيعات' });
    expect(currentLink).toHaveAttribute('href', '/reports/sales');
    expect(currentLink).toHaveAttribute('aria-current', 'page');
    expect(document.activeElement).toHaveAttribute('href');
    await user.keyboard('{Escape}');
    expect(moreButton).toHaveAttribute('aria-expanded', 'false');
    expect(moreButton).toHaveFocus();

    await user.click(moreButton);
    moreButton.focus();
    await user.keyboard('{Escape}');
    expect(moreButton).toHaveAttribute('aria-expanded', 'false');
  });
});
