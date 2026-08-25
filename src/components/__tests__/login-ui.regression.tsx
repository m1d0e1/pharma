import { render, screen, waitFor } from '@testing-library/react';
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

it('shows synchronized usernames and selects one for local login', async () => {
  (syncFromCloud as jest.Mock).mockResolvedValue({
    success: true,
    message: 'sync complete',
    syncedUsernames: ['pharmacist@example.com'],
  });
  const user = userEvent.setup();
  render(<LoginPage />);

  await user.click(screen.getByRole('button', { name: /مزامنة كافة البيانات/ }));
  const synchronizedUser = await screen.findByRole('button', { name: 'pharmacist@example.com' });
  await user.click(synchronizedUser);

  expect(screen.getByPlaceholderText('admin@pharmacy.com')).toHaveValue('pharmacist@example.com');
});
