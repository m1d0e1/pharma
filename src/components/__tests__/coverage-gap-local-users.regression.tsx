import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocalUserManagement from '@/components/settings/LocalUserManagement';
import { getClientSession } from '@/lib/auth/local';
import { getLocalUsersClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('@/lib/settings/client', () => ({ getLocalUsersClient: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn() },
}));

describe('coverage gap: local user settings panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner' });
  });

  it('renders owner-local users and routes add/edit controls to guarded staff management', async () => {
    (getLocalUsersClient as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'staff-9',
        full_name: 'Ahmed Pharmacist',
        username: 'ahmed',
        role: 'pharmacist',
        has_password: false,
      }],
    });
    render(<LocalUserManagement />);

    expect(await screen.findByText('Ahmed Pharmacist')).toBeInTheDocument();
    expect(screen.getByText('بدون كلمة مرور')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إضافة مستخدم' }));
    expect(push).toHaveBeenCalledWith('/staff/manage?add=true');

    fireEvent.click(screen.getByTitle('تعديل الموظف وصلاحياته'));
    expect(push).toHaveBeenCalledWith('/staff/manage?edit=staff-9');
  });

  it('recovers from a thrown local-user loader instead of remaining on loading', async () => {
    (getLocalUsersClient as jest.Mock)
      .mockRejectedValueOnce(new Error('local users unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'staff-2', full_name: 'Recovered User', username: 'recovered', role: 'pharmacist', has_password: true }],
      });
    render(<LocalUserManagement />);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل المستخدمين'));
    expect(screen.queryByText('جاري التحميل...')).not.toBeInTheDocument();
    expect(screen.getByText('تعذر تحميل المستخدمين المحليين')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Recovered User')).toBeInTheDocument();
  });

  it('shows a retryable failure instead of silently treating a session-read error as access denial', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'owner-1', role: 'owner' });
    (getLocalUsersClient as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'staff-3', full_name: 'Session Recovered', username: 'session-ok', role: 'pharmacist', has_password: true }],
    });

    render(<LocalUserManagement />);

    expect(await screen.findByText('تعذر تحميل المستخدمين المحليين')).toBeInTheDocument();
    expect(screen.queryByText('إدارة المستخدمين المحليين')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Session Recovered')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(2);
  });

  it('does not let an older owner retry re-authorize the panel after a newer session check denies access', async () => {
    let resolveOlderOwner!: (value: any) => void;
    const olderOwner = new Promise(resolve => {
      resolveOlderOwner = resolve;
    });

    (getClientSession as jest.Mock)
      .mockResolvedValueOnce({ id: 'owner-initial', role: 'owner' })
      .mockReturnValueOnce(olderOwner)
      .mockResolvedValueOnce({ id: 'pharmacist-newer', role: 'pharmacist' });
    (getLocalUsersClient as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'initial users failure' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'stale-user', full_name: 'Stale Owner User', username: 'stale', role: 'pharmacist', has_password: true }],
      });

    render(<LocalUserManagement />);
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });

    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveOlderOwner({ id: 'owner-stale', role: 'owner' });
      await olderOwner;
    });

    expect(screen.queryByText('Stale Owner User')).not.toBeInTheDocument();
    expect(screen.queryByText('إدارة المستخدمين المحليين')).not.toBeInTheDocument();
  });
});
