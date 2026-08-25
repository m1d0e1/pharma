import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SubscriptionActivationPage from '@/app/subscription/page';
import SubscriptionStatus from '@/components/dashboard/SubscriptionStatus';
import { getConfigAction, updateConfigAction } from '@/app/actions-client/config';
import { toast } from 'react-hot-toast';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/app/actions-client/config', () => ({
  getConfigAction: jest.fn(),
  updateConfigAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

it('enables an explicitly local mode without accepting a fake subscription ID', async () => {
  const user = userEvent.setup();
  render(<SubscriptionActivationPage />);

  expect(screen.queryByText('معرف الاشتراك')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'بدء العمل المحلي' }));

  expect(localStorage.getItem('subscriptionMode')).toBe('local');
  expect(toast.success).toHaveBeenCalledWith('تم تفعيل وضع العمل المحلي');
  expect(push).toHaveBeenCalledWith('/');
});

it('persists local mode from the dashboard status card', async () => {
  (getConfigAction as jest.Mock).mockResolvedValue({ success: true, value: 'none' });
  (updateConfigAction as jest.Mock).mockResolvedValue({ success: true });
  const user = userEvent.setup();
  render(<SubscriptionStatus />);

  await user.click(await screen.findByRole('button', { name: 'تفعيل العمل المحلي' }));

  await waitFor(() => expect(updateConfigAction).toHaveBeenCalledWith('subscription_status', 'activated'));
  expect(await screen.findByText('العمل المحلي مفعل')).toBeInTheDocument();
});
