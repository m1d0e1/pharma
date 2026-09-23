import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuditPage from '@/app/(dashboard)/audit/page';
import AuditLogClient from '@/components/admin/AuditLogClient';
import { clearAuditLogsAction, getAuditLogsAction } from '@/app/actions-client/audit';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

const refresh = jest.fn();
const router = { refresh };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/app/actions-client/audit', () => ({
  clearAuditLogsAction: jest.fn(),
  getAuditLogsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const log = {
  id: 1,
  user_id: 'owner',
  action: 'LOGIN',
  details: 'سجل قائم',
  created_at: '2026-09-22T08:00:00.000Z',
  full_name: 'Owner',
  role: 'owner',
};

describe('audit ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
  });

  it('keeps the clear confirmation open while clear persistence is pending', async () => {
    let resolveClear!: (value: { success: boolean; error?: string }) => void;
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveClear = resolve;
    });
    (clearAuditLogsAction as jest.Mock).mockImplementation(() => pending);

    render(<AuditLogClient initialLogs={[log]} canClearLogs />);

    fireEvent.click(screen.getByRole('button', { name: /مسح السجلات/ }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، مسح الكل' }));
    await waitFor(() => expect(clearAuditLogsAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    const stayedOpenWhilePending = screen.queryByText('تأكيد مسح السجلات؟') !== null;

    await act(async () => {
      resolveClear({ success: false, error: 'clear failed' });
      await pending;
    });

    expect(stayedOpenWhilePending).toBe(true);
  });

  it('keeps valid audit UI visible when the post-clear refresh fails', async () => {
    (getAuditLogsAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: {
          logs: [log],
          todayCount: 1,
          userActivity: [{ full_name: 'Owner', actions: 1 }],
          actionTypes: [{ action: 'LOGIN', count: 1 }],
        },
      })
      .mockResolvedValueOnce({ success: false, error: 'refresh failed' });
    (clearAuditLogsAction as jest.Mock).mockResolvedValue({ success: true });

    render(<AuditPage />);

    expect(await screen.findByText('سجل المراقبة والتدقيق')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /مسح السجلات/ }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، مسح الكل' }));

    await waitFor(() => expect(clearAuditLogsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getAuditLogsAction).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('تعذر تحميل سجل التدقيق')).not.toBeInTheDocument();
    expect(screen.getByText('سجل المراقبة والتدقيق')).toBeInTheDocument();
  });
});
