import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffPage from '@/app/(dashboard)/staff/page';
import StaffManagePage from '@/app/(dashboard)/staff/manage/page';
import StaffRolesPage from '@/app/(dashboard)/staff/roles/page';
import SidebarNav from '@/components/SidebarNav';
import TopMenuBar from '@/components/TopMenuBar';
import LocalUserManagement from '@/components/settings/LocalUserManagement';
import { getClientSession } from '@/lib/auth/local';
import { addJobAction, addUserAction, getStaffManagementDataAction, getStaffPerformanceAction, getJobsAction } from '@/app/actions-client/users';
import { OWNER_ONLY_STAFF_PERMISSIONS } from '@/lib/auth/staff-policy';

jest.mock('@/lib/auth/local', () => ({
  ...jest.requireActual('@/lib/auth/local'),
  getClientSession: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffManagementDataAction: jest.fn(async () => ({ success: true, users: [], jobs: [] })),
  getStaffPerformanceAction: jest.fn(async () => ({ success: true, data: [] })),
  getJobsAction: jest.fn(async () => ({ success: true, data: [] })),
  addUserAction: jest.fn(),
  addJobAction: jest.fn(),
}));
jest.mock('@/lib/settings/client', () => ({ getLocalUsersClient: jest.fn(async () => ({ success: true, data: [] })) }));
jest.mock('@/components/admin/StaffAnalyticsClient', () => function MockStaffAnalytics() { return <div>performance content</div>; });
jest.mock('@/components/admin/StaffManagementClient', () => function MockStaffManagement({ users, onAddUser }: any) {
  return <div>
    <div>management content</div>
    <div>staff rows {users.length}</div>
    <button onClick={() => void onAddUser({ full_name: 'New Staff', username: 'new_staff' })}>mock add staff</button>
  </div>;
});
jest.mock('@/components/admin/JobsManagementClient', () => function MockJobsManagement({ initialJobs, onAddJob }: any) {
  return <div>
    <div>jobs content</div>
    <div>job rows {initialJobs.length}</div>
    <button onClick={() => void onAddJob({ name_ar: 'وظيفة جديدة' })}>mock add job</button>
  </div>;
});

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

it('distinguishes a failed staff-performance load from a legitimate empty analysis and retries', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', permissions: {} });
  (getStaffPerformanceAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'performance unavailable' })
    .mockResolvedValueOnce({ success: true, data: [] });

  render(<StaffPage />);

  expect(await screen.findByText('تعذر تحميل بيانات أداء الموظفين')).toBeInTheDocument();
  expect(screen.queryByText('performance content')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  expect(await screen.findByText('performance content')).toBeInTheDocument();
  expect(getStaffPerformanceAction).toHaveBeenCalledTimes(2);
});

it('recovers the staff-management route from a thrown data loader without showing false empty content', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', permissions: {} });
  (getStaffManagementDataAction as jest.Mock)
    .mockRejectedValueOnce(new Error('management bridge unavailable'))
    .mockResolvedValueOnce({ success: true, users: [], jobs: [] });

  render(<StaffManagePage />);

  expect(await screen.findByText('تعذر تحميل بيانات إدارة الموظفين')).toBeInTheDocument();
  expect(screen.queryByText('management content')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  expect(await screen.findByText('management content')).toBeInTheDocument();
  expect(getStaffManagementDataAction).toHaveBeenCalledTimes(2);
});

it('keeps the last valid staff view after a committed add when the post-save refresh fails, and allows retry', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', permissions: {} });
  (addUserAction as jest.Mock).mockResolvedValue({ success: true, id: 'staff-new' });
  (getStaffManagementDataAction as jest.Mock)
    .mockResolvedValueOnce({ success: true, users: [{ id: 'staff-old' }], jobs: [] })
    .mockResolvedValueOnce({ success: false, error: 'refresh unavailable' })
    .mockResolvedValueOnce({ success: true, users: [{ id: 'staff-old' }, { id: 'staff-new' }], jobs: [] });

  render(<StaffManagePage />);
  expect(await screen.findByText('staff rows 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'mock add staff' }));

  await waitFor(() => expect(addUserAction).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('تعذر تحديث بيانات الموظفين')).toBeInTheDocument();
  expect(screen.getByText('staff rows 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل بيانات الموظفين' }));

  expect(await screen.findByText('staff rows 2')).toBeInTheDocument();
  expect(getStaffManagementDataAction).toHaveBeenCalledTimes(3);
});

it('recovers the jobs route from a returned jobs-load failure instead of showing a false empty list', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', permissions: {} });
  (getJobsAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'jobs unavailable' })
    .mockResolvedValueOnce({ success: true, data: [] });

  render(<StaffRolesPage />);

  expect(await screen.findByText('تعذر تحميل بيانات الوظائف')).toBeInTheDocument();
  expect(screen.queryByText('jobs content')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  expect(await screen.findByText('jobs content')).toBeInTheDocument();
  expect(getJobsAction).toHaveBeenCalledTimes(2);
});

it('keeps the last valid jobs view after a committed add when the post-save refresh fails, and allows retry', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', permissions: {} });
  (addJobAction as jest.Mock).mockResolvedValue({ success: true, id: 8 });
  (getJobsAction as jest.Mock)
    .mockResolvedValueOnce({ success: true, data: [{ id: 7, name_ar: 'صيدلي' }] })
    .mockResolvedValueOnce({ success: false, error: 'jobs refresh unavailable' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 7, name_ar: 'صيدلي' }, { id: 8, name_ar: 'وظيفة جديدة' }] });

  render(<StaffRolesPage />);
  expect(await screen.findByText('job rows 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'mock add job' }));

  await waitFor(() => expect(addJobAction).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('تعذر تحديث بيانات الوظائف')).toBeInTheDocument();
  expect(screen.getByText('job rows 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل بيانات الوظائف' }));

  expect(await screen.findByText('job rows 2')).toBeInTheDocument();
  expect(getJobsAction).toHaveBeenCalledTimes(3);
});
