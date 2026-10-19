import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '@/app/login/page';
import { loginLocalAction } from '@/app/actions-client/auth';

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), loading: jest.fn() } }));
jest.mock('@/app/actions-client/auth', () => ({ loginLocalAction: jest.fn() }));
jest.mock('@/lib/sync/universal', () => ({ syncFromCloud: jest.fn() }));

it('keeps a visible and accessible login label while authentication is pending', async () => {
  (loginLocalAction as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  render(<LoginPage />);
  await user.type(screen.getByLabelText('اسم المستخدم / البريد'), 'admin');
  await user.type(screen.getByLabelText('كلمة المرور'), 'sample-password');
  await user.click(screen.getByRole('button', { name: 'دخول للنظام المحلي' }));
  expect(screen.getByRole('button', { name: 'جاري تسجيل الدخول...' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('جاري تسجيل الدخول...');
});
