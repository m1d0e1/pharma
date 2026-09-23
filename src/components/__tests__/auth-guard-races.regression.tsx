import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuthGuard from '@/components/AuthGuard';
import { getClientSession } from '@/lib/auth/local';

const mockPush = jest.fn();
const mockRouter = { push: mockPush };
let mockPathname = '/dashboard-a';

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname,
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
}));

describe('AuthGuard async ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockReset();
    mockPathname = '/dashboard-a';
  });

  it('redirects a missing session without rendering protected content', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(null);
    render(<AuthGuard><div>protected-content</div></AuthGuard>);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('protected-content')).not.toBeInTheDocument();
  });

  it('does not let an older session check re-authorize content after a newer check denies it', async () => {
    let resolveOlder!: (value: unknown) => void;
    (getClientSession as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce(null);

    const { rerender } = render(<AuthGuard><div>protected-content</div></AuthGuard>);
    mockPathname = '/dashboard-b';
    rerender(<AuthGuard><div>protected-content</div></AuthGuard>);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('protected-content')).not.toBeInTheDocument();

    await act(async () => {
      resolveOlder({ id: 'stale-user', username: 'stale', role: 'owner' });
    });

    expect(screen.queryByText('protected-content')).not.toBeInTheDocument();
  });

  it('distinguishes a session transport failure from an unauthenticated user and retries in place', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session bridge unavailable'))
      .mockResolvedValueOnce({ id: 'owner-1', username: 'owner', role: 'owner' });

    render(<AuthGuard><div>protected-content</div></AuthGuard>);

    expect(await screen.findByText('تعذر التحقق من الهوية')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalledWith('/login');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('protected-content')).toBeInTheDocument();
    expect(getClientSession).toHaveBeenCalledTimes(2);
  });
});
