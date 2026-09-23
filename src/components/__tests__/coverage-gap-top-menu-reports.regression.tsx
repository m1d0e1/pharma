import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TopMenuBar from '@/components/TopMenuBar';
import ReportsPage from '@/app/(dashboard)/reports/page';
import TrialBalanceReportPage from '@/app/(dashboard)/reports/trial-balance/page';
import { getClientSession, hasUserPermissionSync, logoutLocal } from '@/lib/auth/local';
import { getReportsDataAction } from '@/app/actions-client/reports';

const mockPush = jest.fn();
const mockPathname = jest.fn(() => '/');
const mockRouter = { push: mockPush };

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => mockRouter,
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
  logoutLocal: jest.fn(),
}));

jest.mock('@/app/actions-client/reports', () => ({
  getReportsDataAction: jest.fn(),
}));

jest.mock('next/dynamic', () => () => function MockDynamicReport() {
  return <div data-testid="sales-charts" />;
});

jest.mock('@/components/reports/TrialBalanceReport', () => function MockTrialBalanceReport() {
  return <div data-testid="trial-balance-report" />;
});

jest.mock('@/components/AccessDenied', () => function MockAccessDenied() {
  return <div>ACCESS DENIED</div>;
});

describe('coverage-gap: top menu and report actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname.mockReturnValue('/');
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner', permissions: {} });
    (logoutLocal as jest.Mock).mockResolvedValue(undefined);
    (getReportsDataAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        salesHistoryRaw: [{ created_at: '2026-09-21T10:00:00', total_amount: 125.5 }],
        topDrugsRaw: [{ trade_name: 'Drug A', quantity_sold: 3 }],
        categoryRaw: [{ category: 'Category A', quantity_sold: 3 }],
      },
    });
    Object.defineProperty(window, 'print', { configurable: true, value: jest.fn() });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:report') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  });

  it('opens and closes Help dialogs, routes Alt+P, prints, and logs out through real menu actions', async () => {
    render(<TopMenuBar userRole="owner" permissions={{}} />);

    fireEvent.click(screen.getByRole('button', { name: 'مساعدة' }));
    fireEvent.click(screen.getByRole('button', { name: 'اختصارات لوحة المفاتيح' }));
    expect(screen.getByRole('heading', { name: 'اختصارات لوحة المفاتيح' })).toBeInTheDocument();
    expect(screen.getByText('Ctrl+D')).toBeInTheDocument();
    expect(screen.getByText('Alt+P')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'اختصارات لوحة المفاتيح' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'مساعدة' }));
    fireEvent.click(screen.getByRole('button', { name: 'عن النظام' }));
    expect(screen.getByText('نظام إدارة الصيدليات')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(screen.queryByText('نظام إدارة الصيدليات')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'p', altKey: true });
    expect(mockPush).toHaveBeenCalledWith('/pos');

    fireEvent.click(screen.getByRole('button', { name: 'ملف' }));
    fireEvent.click(screen.getByRole('button', { name: 'طباعة' }));
    expect(window.print).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'ملف' }));
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    await waitFor(() => expect(logoutLocal).toHaveBeenCalledTimes(1));
    expect(mockPush).toHaveBeenCalledWith('/login');
  });

  it('does not route Alt+P to POS when the current user lacks POS permission', () => {
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => key !== 'can_access_pos');
    render(<TopMenuBar userRole="pharmacist" permissions={{ can_access_pos: false }} />);

    fireEvent.keyDown(window, { key: 'p', altKey: true });

    expect(mockPush).not.toHaveBeenCalledWith('/pos');
  });

  it('exports the rendered sales summary through a CSV object URL and downloadable anchor', async () => {
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<ReportsPage />);

    const exportButton = await screen.findByRole('button', { name: /تصدير التقرير/ });
    expect(getReportsDataAction).toHaveBeenCalledTimes(1);
    fireEvent.click(exportButton);

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8;');
    expect(blob.size).toBeGreaterThan(0);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.href).toContain('blob:report');
    expect(anchor.download).toMatch(/^sales_summary_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report');
    clickSpy.mockRestore();
  });

  it('blocks the reports page before loading report data when sales-report permission is denied', async () => {
    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
    render(<ReportsPage />);

    expect(await screen.findByText('غير مصرح لك بالوصول')).toBeInTheDocument();
    expect(getReportsDataAction).not.toHaveBeenCalled();
  });

  it('prints trial balance only on the permitted page and renders access denial otherwise', async () => {
    render(<TrialBalanceReportPage />);
    const printButton = await screen.findByRole('button', { name: /طباعة التقرير/ });
    expect(screen.getByTestId('trial-balance-report')).toBeInTheDocument();
    fireEvent.click(printButton);
    expect(window.print).toHaveBeenCalledTimes(1);

    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
    render(<TrialBalanceReportPage />);
    expect(await screen.findByText('ACCESS DENIED')).toBeInTheDocument();
  });

  it('recovers the trial-balance auth wrapper after a thrown session load', async () => {
    (getClientSession as jest.Mock)
      .mockRejectedValueOnce(new Error('session unavailable'))
      .mockResolvedValueOnce({ id: 'owner-1', role: 'owner', permissions: {} });

    render(<TrialBalanceReportPage />);

    expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByTestId('trial-balance-report')).toBeInTheDocument();
  });
});
