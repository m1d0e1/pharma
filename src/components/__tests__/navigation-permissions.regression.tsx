import { render, screen } from '@testing-library/react';
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
});
