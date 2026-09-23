import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ShiftReportClient from '@/components/reports/ShiftReportClient';
import { getShiftReportAction } from '@/app/actions-client/reports';

jest.mock('@/app/actions-client/reports', () => ({
  getShiftReportAction: jest.fn(),
}));

jest.mock('@/components/shifts/ShiftReceiptsModal', () => () => null);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function reportData(id: string, staffName: string) {
  return {
    shift: {
      id,
      staff_name: staffName,
      start_time: '2026-09-20T08:00:00Z',
      end_time: '2026-09-20T16:00:00Z',
      starting_cash: 100,
      ending_cash: 100,
      status: 'closed',
    },
    sales: [],
    returns: [],
    movements: [],
    summary: {
      cashSales: 0,
      cashReturns: 0,
      cashReceipts: 0,
      cashDisbursements: 0,
      cashHandover: 0,
      expectedCash: 100,
      actualCash: 100,
      difference: 0,
    },
  };
}

describe('coverage gap: shift-report load errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('recovers from a thrown report load with an explicit retry', async () => {
    (getShiftReportAction as jest.Mock)
      .mockRejectedValueOnce(new Error('report db unavailable'))
      .mockResolvedValueOnce({ success: false, error: 'still unavailable' });

    render(<ShiftReportClient shiftId="shift-error" />);

    expect(await screen.findByText('فشل تحميل بيانات التقرير')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);

    await waitFor(() => expect(getShiftReportAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('still unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeEnabled();
  });

  it('labels the reconciliation as shift drawer cash, not treasury', async () => {
    (getShiftReportAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: reportData('shift-cash-1234', 'Cashier'),
    });

    render(<ShiftReportClient shiftId="shift-cash-1234" />);

    expect(await screen.findByText('مطابقة نقدية درج الوردية')).toBeInTheDocument();
    expect(screen.queryByText('مطابقة الخزينة')).not.toBeInTheDocument();
  });

  it('keeps report data owned by the newest shift when the previous shift resolves later', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    (getShiftReportAction as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const view = render(<ShiftReportClient shiftId="shift-old-1234" />);
    await waitFor(() => expect(getShiftReportAction).toHaveBeenCalledWith('shift-old-1234'));
    view.rerender(<ShiftReportClient shiftId="shift-new-5678" />);
    await waitFor(() => expect(getShiftReportAction).toHaveBeenCalledWith('shift-new-5678'));

    newer.resolve({ success: true, data: reportData('shift-new-5678', 'New Staff') });
    expect(await screen.findByText('New Staff')).toBeInTheDocument();

    await act(async () => {
      older.resolve({ success: true, data: reportData('shift-old-1234', 'Old Staff') });
      await older.promise;
    });
    expect(screen.queryByText('Old Staff')).not.toBeInTheDocument();
    expect(screen.getByText('New Staff')).toBeInTheDocument();
  });
});
