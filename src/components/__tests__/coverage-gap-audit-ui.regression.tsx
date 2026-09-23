import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AuditPage from '@/app/(dashboard)/audit/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { clearAuditLogsAction, getAuditLogsAction } from '@/app/actions-client/audit';
import { toast } from 'react-hot-toast';

const mockRefresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbGet: jest.fn(),
}));

jest.mock('@/app/actions-client/audit', () => ({
  getAuditLogsAction: jest.fn(),
  clearAuditLogsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const logs = [
  {
    id: 1,
    user_id: 'u-1',
    action: 'SALE',
    details: 'Sold Test Drug',
    created_at: '2026-09-21T10:00:00',
    full_name: 'Owner User',
    role: 'owner',
  },
  {
    id: 2,
    user_id: 'u-2',
    action: 'ADD_INVENTORY',
    details: 'Added Panadol',
    created_at: '2026-09-21T11:00:00',
    full_name: 'Pharmacist User',
    role: 'pharmacist',
  },
];

function mockAuditData() {
  (getAuditLogsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      logs,
      todayCount: 2,
      userActivity: [{ full_name: 'Owner User', actions: 2 }],
      actionTypes: [{ action: 'SALE', count: 1 }, { action: 'ADD_INVENTORY', count: 1 }],
    },
  });
}

describe('coverage-gap: audit UI permissions and controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefresh.mockReset();
    mockAuditData();
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user, key) => key === 'can_view_audit');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:audit') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  });

  it('lets a delegated audit viewer inspect and export logs without exposing the owner-only destructive clear control', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      pharmacy_id: 'ph-1',
      permissions: { can_view_audit: true },
    });

    render(<AuditPage />);

    expect(await screen.findByText('Sold Test Drug')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /تصدير CSV/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /مسح السجلات/ })).not.toBeInTheDocument();
  });

  it('filters the loaded audit log by text and action type', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' });
    render(<AuditPage />);
    await screen.findByText('Sold Test Drug');

    fireEvent.change(screen.getByPlaceholderText('بحث في السجل...'), { target: { value: 'Panadol' } });
    expect(screen.queryByText('Sold Test Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Added Panadol')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'SALE' } });
    expect(screen.getByText('لا توجد سجلات مطابقة')).toBeInTheDocument();
  });

  it('exports only the currently filtered audit rows through a downloadable CSV blob', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' });
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<AuditPage />);
    await screen.findByText('Sold Test Drug');

    fireEvent.change(screen.getByPlaceholderText('بحث في السجل...'), { target: { value: 'Panadol' } });
    fireEvent.click(screen.getByRole('button', { name: /تصدير CSV/ }));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8;');
    expect(blob.size).toBeGreaterThan(0);
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^audit_log_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(anchor.href).toContain('blob:audit');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit');
    clickSpy.mockRestore();
  });

  it('keeps clear-log confirmation owner-only and refreshes the audit data after a successful clear', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' });
    (clearAuditLogsAction as jest.Mock).mockResolvedValue({ success: true });
    render(<AuditPage />);
    await screen.findByText('Sold Test Drug');

    fireEvent.click(screen.getByRole('button', { name: /مسح السجلات/ }));
    expect(screen.getByText('تأكيد مسح السجلات؟')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'نعم، مسح الكل' }));

    await waitFor(() => expect(clearAuditLogsAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getAuditLogsAction).toHaveBeenCalledTimes(2));
  });

  it('blocks repeated destructive clear requests while the first clear is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' });
    let resolveClear: (value: { success: boolean; error?: string }) => void = () => {};
    (clearAuditLogsAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveClear = resolve;
    }));

    render(<AuditPage />);
    await screen.findByText('Sold Test Drug');
    fireEvent.click(screen.getByRole('button', { name: /مسح السجلات/ }));
    const confirmButton = screen.getByRole('button', { name: 'نعم، مسح الكل' });

    act(() => {
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
    });

    expect(clearAuditLogsAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveClear({ success: false, error: 'clear rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'نعم، مسح الكل' })).toBeEnabled());
  });

  it('recovers the destructive clear confirmation when the clear action throws', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' });
    (clearAuditLogsAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));

    render(<AuditPage />);
    await screen.findByText('Sold Test Drug');
    fireEvent.click(screen.getByRole('button', { name: /مسح السجلات/ }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، مسح الكل' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل مسح السجلات'));
    expect(screen.getByText('تأكيد مسح السجلات؟')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'نعم، مسح الكل' })).toBeEnabled();
    expect(getAuditLogsAction).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable initial-load error instead of presenting a failed audit request as an empty log', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' });
    (getAuditLogsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'audit unavailable' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          logs,
          todayCount: 2,
          userActivity: [{ full_name: 'Owner User', actions: 2 }],
          actionTypes: [{ action: 'SALE', count: 1 }],
        },
      });

    render(<AuditPage />);

    expect(await screen.findByText('تعذر تحميل سجل التدقيق')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد سجلات مطابقة')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Sold Test Drug')).toBeInTheDocument();
  });
});
