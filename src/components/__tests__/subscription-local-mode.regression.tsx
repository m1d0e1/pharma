import { act, render, screen, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

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

it('shows a retryable dashboard state when subscription status loading throws', async () => {
  (getConfigAction as jest.Mock)
    .mockRejectedValueOnce(new Error('bridge unavailable'))
    .mockResolvedValueOnce({ success: true, value: 'none' });
  const user = userEvent.setup();
  render(<SubscriptionStatus />);

  expect(await screen.findByText('تعذر تحميل وضع التشغيل')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  expect(await screen.findByRole('button', { name: 'تفعيل العمل المحلي' })).toBeEnabled();
  expect(getConfigAction).toHaveBeenCalledTimes(2);
});

it('keeps the newest subscription-status retry when same-tick retries resolve out of order', async () => {
  let resolveOlder!: (value: { success: boolean; value?: string }) => void;
  let resolveNewer!: (value: { success: boolean; value?: string }) => void;
  (getConfigAction as jest.Mock)
    .mockRejectedValueOnce(new Error('initial status failure'))
    .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

  render(<SubscriptionStatus />);
  const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });
  act(() => {
    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(getConfigAction).toHaveBeenCalledTimes(3);

  await act(async () => {
    resolveNewer({ success: true, value: 'activated' });
  });
  expect(await screen.findByText('العمل المحلي مفعل')).toBeInTheDocument();

  await act(async () => {
    resolveOlder({ success: true, value: 'none' });
  });
  expect(screen.getByText('العمل المحلي مفعل')).toBeInTheDocument();
  expect(screen.queryByText('العمل المحلي غير مفعل')).not.toBeInTheDocument();
});

it('restores local-mode activation controls when persistence throws', async () => {
  (getConfigAction as jest.Mock).mockResolvedValue({ success: true, value: 'none' });
  (updateConfigAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
  const user = userEvent.setup();
  render(<SubscriptionStatus />);

  await user.click(await screen.findByRole('button', { name: 'تفعيل العمل المحلي' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تفعيل وضع العمل المحلي'));
  expect(screen.getByRole('button', { name: 'تفعيل العمل المحلي' })).toBeEnabled();
  expect(screen.getByText('العمل المحلي غير مفعل')).toBeInTheDocument();
});

it('blocks repeated local-mode activation events while persistence is pending', async () => {
  (getConfigAction as jest.Mock).mockResolvedValue({ success: true, value: 'none' });
  let resolveActivation: (value: { success: boolean }) => void = () => {};
  const pendingActivation = new Promise<{ success: boolean }>(resolve => {
    resolveActivation = resolve;
  });
  (updateConfigAction as jest.Mock).mockReturnValue(pendingActivation);
  render(<SubscriptionStatus />);

  const button = await screen.findByRole('button', { name: 'تفعيل العمل المحلي' });
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  expect(updateConfigAction).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveActivation({ success: false });
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'تفعيل العمل المحلي' })).toBeEnabled());
});
