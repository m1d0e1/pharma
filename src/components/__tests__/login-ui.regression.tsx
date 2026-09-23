import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '@/app/login/page';
import { loginLocalAction } from '@/app/actions-client/auth';
import { syncFromCloud } from '@/lib/sync/universal';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/auth', () => ({ loginLocalAction: jest.fn() }));
jest.mock('@/lib/sync/universal', () => ({ syncFromCloud: jest.fn() }));
jest.mock('react-hot-toast', () => {
  const notification = Object.assign(jest.fn(), {
    loading: jest.fn(() => 'sync-toast'),
    success: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, toast: notification };
});

it('reports a rejected local login without creating a session', async () => {
  (loginLocalAction as jest.Mock).mockResolvedValue({ success: false, error: 'المستخدم غير موجود' });
  const user = userEvent.setup();
  render(<LoginPage />);

  await user.type(screen.getByPlaceholderText('admin@pharmacy.com'), 'missing-user');
  await user.type(screen.getByPlaceholderText('••••••••'), 'wrong-password');
  await user.click(screen.getByRole('button', { name: 'دخول للنظام المحلي' }));

  await waitFor(() => expect(loginLocalAction).toHaveBeenCalledWith('missing-user', 'wrong-password'));
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('المستخدم غير موجود محلياً'));
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
});

it('keeps user provisioning local when public catalog sync succeeds', async () => {
  (syncFromCloud as jest.Mock).mockResolvedValue({
    success: true,
    message: 'sync complete',
    syncedUsernames: ['pharmacist@example.com'],
  });
  const user = userEvent.setup();
  render(<LoginPage />);

  await user.click(screen.getByRole('button', { name: 'تحديث قائمة الأدوية والتفاعلات' }));

  await waitFor(() => expect(syncFromCloud).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: 'pharmacist@example.com' })).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('admin@pharmacy.com')).toHaveValue('');
});

it('stores the authenticated local user before navigating to the dashboard', async () => {
  (loginLocalAction as jest.Mock).mockResolvedValue({
    success: true,
    user: {
      id: 'owner-1',
      username: 'owner',
      role: 'owner',
      full_name: 'Owner User',
      pharmacy_id: 'local_default',
      permissions: '{"can_view_sales":true}',
    },
  });
  const user = userEvent.setup();
  render(<LoginPage />);

  await user.type(screen.getByPlaceholderText('admin@pharmacy.com'), 'owner');
  await user.type(screen.getByPlaceholderText('••••••••'), 'correct-password');
  await user.click(screen.getByRole('button', { name: 'دخول للنظام المحلي' }));

  await waitFor(() => expect(loginLocalAction).toHaveBeenCalledWith('owner', 'correct-password'));
  expect(JSON.parse(localStorage.getItem('pharma_session_user') || '{}')).toEqual({
    id: 'owner-1',
    username: 'owner',
    role: 'owner',
    full_name: 'Owner User',
    pharmacy_id: 'local_default',
    permissions: '{"can_view_sales":true}',
  });
  expect(toast.success).toHaveBeenCalledWith('أهلاً بك، Owner User');
});

it('blocks repeated local-login submissions while authentication is pending', async () => {
  let resolveLogin!: (value: { success: boolean; error?: string }) => void;
  (loginLocalAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolveLogin = resolve;
  }));
  const user = userEvent.setup();
  render(<LoginPage />);

  await user.type(screen.getByPlaceholderText('admin@pharmacy.com'), 'owner');
  await user.type(screen.getByPlaceholderText('••••••••'), 'pending-password');
  const submit = screen.getByRole('button', { name: 'دخول للنظام المحلي' });
  const form = submit.closest('form') as HTMLFormElement;

  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(loginLocalAction).toHaveBeenCalledTimes(1);

  await act(async () => resolveLogin({ success: false, error: 'auth pending rejected' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'دخول للنظام المحلي' })).toBeEnabled());
});

it('blocks repeated initial-sync events while cloud synchronization is pending', async () => {
  let resolveSync!: (value: { success: boolean; error?: string }) => void;
  (syncFromCloud as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolveSync = resolve;
  }));
  render(<LoginPage />);

  const syncButton = screen.getByRole('button', { name: 'تحديث قائمة الأدوية والتفاعلات' });
  act(() => {
    syncButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    syncButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  expect(syncFromCloud).toHaveBeenCalledTimes(1);

  await act(async () => resolveSync({ success: false, error: 'sync pending rejected' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'تحديث قائمة الأدوية والتفاعلات' })).toBeEnabled());
});
