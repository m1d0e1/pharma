import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import ShiftManagement from '@/components/dashboard/ShiftManagement';
import { getCurrentShiftAction, getCurrentShiftStatsAction } from '@/app/actions-client/shifts';

jest.mock('@/app/actions-client/shifts', () => ({
  getCurrentShiftAction: jest.fn(),
  getCurrentShiftStatsAction: jest.fn(),
}));

describe('unified shift navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCurrentShiftAction as jest.Mock).mockReset();
    (getCurrentShiftStatsAction as jest.Mock).mockReset();
    (getCurrentShiftStatsAction as jest.Mock).mockResolvedValue({ success: true, data: null });
  });

  it('opens the canonical shift-management page from the dashboard', async () => {
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: null });

    render(<ShiftManagement />);

    expect(await screen.findByRole('link', { name: 'إدارة الجلسات النقدية' })).toHaveAttribute('href', '/shifts');
  });

  it('recovers the dashboard shift widget after a thrown current-shift load', async () => {
    (getCurrentShiftAction as jest.Mock)
      .mockRejectedValueOnce(new Error('shift bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: null });

    render(<ShiftManagement />);

    expect(await screen.findByText('تعذر تحميل حالة الوردية')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('link', { name: 'إدارة الجلسات النقدية' })).toHaveAttribute('href', '/shifts');
  });

  it('keeps the latest current-shift refresh when an older request resolves afterwards', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    (getCurrentShiftAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));
    (getCurrentShiftStatsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { revenue: 25, expected_cash: 225 },
    });

    render(<ShiftManagement />);
    fireEvent.focus(window);
    expect(getCurrentShiftAction).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveNewer({
        success: true,
        data: { id: 'shift-new', shift_start: '2026-09-22T10:00:00Z', starting_cash_amount: 200 },
      });
    });
    await waitFor(() => expect(screen.getByText((_, el) => el?.textContent === 'EGP 200')).toBeInTheDocument());
    expect(screen.getByText('نقدية بداية الوردية بالدرج')).toBeInTheDocument();
    expect(await screen.findByText('مبيعات الوردية (كل طرق الدفع)')).toBeInTheDocument();
    expect(screen.getByText('النقدية المتوقعة بدرج الوردية')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        success: true,
        data: { id: 'shift-old', shift_start: '2026-09-22T09:00:00Z', starting_cash_amount: 100 },
      });
    });

    expect(screen.getByText((_, el) => el?.textContent === 'EGP 200')).toBeInTheDocument();
    expect(screen.queryByText((_, el) => el?.textContent === 'EGP 100')).not.toBeInTheDocument();
  });

  it('does not leave stale financial stats visible when a refresh fails and can retry stats', async () => {
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { id: 'shift-1', shift_start: '2026-09-22T10:00:00Z', starting_cash_amount: 200 },
    });
    (getCurrentShiftStatsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: { revenue: 50, expected_cash: 250 } })
      .mockResolvedValueOnce({ success: false, error: 'stats unavailable' })
      .mockResolvedValueOnce({ success: true, data: { revenue: 70, expected_cash: 270 } });

    render(<ShiftManagement />);
    await waitFor(() => expect(screen.getByText((_, el) => el?.textContent === 'EGP 250')).toBeInTheDocument());

    fireEvent.focus(window);
    await waitFor(() => expect(getCurrentShiftStatsAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('تعذر تحميل ملخص الوردية')).toBeInTheDocument();
    expect(screen.queryByText((_, el) => el?.textContent === 'EGP 250')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل الملخص' }));
    await waitFor(() => expect(screen.getByText((_, el) => el?.textContent === 'EGP 270')).toBeInTheDocument());
  });

  it('keeps the latest shift stats when an older stats request resolves afterwards', async () => {
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { id: 'shift-1', shift_start: '2026-09-22T10:00:00Z', starting_cash_amount: 200 },
    });
    let resolveOldStats!: (value: unknown) => void;
    let resolveNewStats!: (value: unknown) => void;
    (getCurrentShiftStatsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldStats = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewStats = resolve; }));

    render(<ShiftManagement />);
    await waitFor(() => expect(getCurrentShiftStatsAction).toHaveBeenCalledTimes(1));
    fireEvent.focus(window);
    await waitFor(() => expect(getCurrentShiftStatsAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewStats({ success: true, data: { revenue: 90, expected_cash: 290 } });
    });
    await waitFor(() => expect(screen.getByText((_, el) => el?.textContent === 'EGP 290')).toBeInTheDocument());

    await act(async () => {
      resolveOldStats({ success: true, data: { revenue: 10, expected_cash: 210 } });
    });
    expect(screen.getByText((_, el) => el?.textContent === 'EGP 290')).toBeInTheDocument();
    expect(screen.queryByText((_, el) => el?.textContent === 'EGP 210')).not.toBeInTheDocument();
  });

  it('does not expose the retired manual-open gate in POS checkout', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/(dashboard)/pos/page.tsx'), 'utf8');

    expect(source).not.toContain("checkoutError.includes('فتح وردية')");
    expect(source).not.toContain("router.push('/shifts')");
  });
});
