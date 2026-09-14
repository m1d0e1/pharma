import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffPage from '@/app/(dashboard)/staff/page';
import StaffManagePage from '@/app/(dashboard)/staff/manage/page';
import StaffRolesPage from '@/app/(dashboard)/staff/roles/page';
import SidebarNav from '@/components/SidebarNav';
import TopMenuBar from '@/components/TopMenuBar';
import LocalUserManagement from '@/components/settings/LocalUserManagement';
import { getClientSession } from '@/lib/auth/local';
import { getStaffManagementDataAction, getStaffPerformanceAction, getJobsAction } from '@/app/actions-client/users';
import { OWNER_ONLY_STAFF_PERMISSIONS } from '@/lib/auth/staff-policy';

jest.mock('@/lib/auth/local', () => ({
  ...jest.requireActual('@/lib/auth/local'),
  getClientSession: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffManagementDataAction: jest.fn(async () => ({ success: true, users: [], jobs: [] })),
  getStaffPerformanceAction: jest.fn(async () => ({ success: true, data: [] })),
  getJobsAction: jest.fn(async () => ({ success: true, data: [] })),
}));
jest.mock('@/lib/settings/client', () => ({ getLocalUsersClient: jest.fn(async () => ({ success: true, data: [] })) }));
jest.mock('@/components/admin/StaffAnalyticsClient', () => function MockStaffAnalytics() { return <div>performance content</div>; });
jest.mock('@/components/admin/StaffManagementClient', () => function MockStaffManagement() { return <div>management content</div>; });
jest.mock('@/components/admin/JobsManagementClient', () => function MockJobsManagement() { return <div>jobs content</div>; });

const permissions = Object.fromEntries(OWNER_ONLY_STAFF_PERMISSIONS.map(key => [key, true]));
beforeEach(() => jest.clearAllMocks());

it.each(['admin', 'manager', 'pharmacist', 'cashier'])('blocks direct staff pages for %s even with saved grants', async role => {
  (getClientSession as jest.Mock).mockResolvedValue({ role, permissions });
  for (const Page of [StaffPage, StaffManagePage, StaffRolesPage]) {
    render(<Page />);
    expect(await screen.findByText('وصول غير مصرح به')).toBeInTheDocument();
    cleanup();
  }
  expect(getStaffManagementDataAction).not.toHaveBeenCalled();
  expect(getStaffPerformanceAction).not.toHaveBeenCalled();
  expect(getJobsAction).not.toHaveBeenCalled();
});

it('loads all owner pages through their guarded actions', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', permissions: {} });
  for (const [Page, content] of [[StaffPage, 'performance content'], [StaffManagePage, 'management content'], [StaffRolesPage, 'jobs content']] as const) {
    render(<Page />);
    expect(await screen.findByText(content)).toBeInTheDocument();
    cleanup();
  }
  expect(getStaffManagementDataAction).toHaveBeenCalledTimes(1);
  expect(getStaffPerformanceAction).toHaveBeenCalledTimes(1);
  expect(getJobsAction).toHaveBeenCalledTimes(1);
});

it('hides non-owner staff navigation and the settings staff panel', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'admin', permissions });
  render(<SidebarNav userRole="admin" userPermissions={permissions} />);
  expect(screen.queryByRole('link', { name: 'إدارة الموظفين' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'أداء الموظفين' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'الوظائف والرواتب' })).not.toBeInTheDocument();
  cleanup();
  render(<TopMenuBar userRole="admin" permissions={permissions} />);
  expect(screen.queryByRole('button', { name: 'الموظفون' })).not.toBeInTheDocument();
  cleanup();
  render(<LocalUserManagement />);
  await waitFor(() => expect(getClientSession).toHaveBeenCalled());
  expect(screen.queryByText('إدارة المستخدمين المحليين')).not.toBeInTheDocument();
});

it('shows owner navigation in the sidebar and administration menu', async () => {
  render(<SidebarNav userRole="owner" userPermissions={{}} />);
  expect(screen.getByRole('link', { name: 'إدارة الموظفين' })).toBeInTheDocument();
  cleanup();
  render(<TopMenuBar userRole="owner" permissions={{}} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'الموظفون' }));
  expect(screen.getByText('إدارة الموظفين')).toBeInTheDocument();
  expect(screen.getByText('أداء الموظفين')).toBeInTheDocument();
  expect(screen.getByText('الوظائف والرواتب')).toBeInTheDocument();
});
