import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import ShiftReportClient from '@/components/reports/ShiftReportClient';
import { getShiftReportAction } from '@/app/actions-client/reports';
import { getShiftReceiptsAction } from '@/app/actions-client/shifts';

jest.mock('@/app/actions-client/reports', () => ({
  getShiftReportAction: jest.fn(),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  openShiftAction: jest.fn(),
  getShiftsAction: jest.fn(),
  forceCloseAllShiftsAction: jest.fn(),
  getShiftReceiptsAction: jest.fn(),
}));

jest.mock('react-hotkeys-hook', () => ({
  useHotkeys: jest.fn(),
}));

jest.mock('@/app/actions-client/config', () => ({
  getConfigAction: jest.fn(async () => ({ value: 'صيدلية تجريبية' })),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('shift receipts ui wiring', () => {
  beforeEach(() => {
    (getShiftReceiptsAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: [
        {
          id: 'inv-12345',
          total_amount: 150,
          paid_amount: 150,
          payment_method: 'cash',
          created_at: '2026-08-26T09:30:00Z',
          patient_name: 'علي حسن',
          patient_phone: '01234567890',
          staff_name: 'د. أحمد',
          sales_items: [
            {
              quantity_sold: 1,
              unit_price: 150,
              trade_name: 'Augmentin 1g',
              unit: 'large',
            },
          ],
        },
      ],
    });

    (getShiftReportAction as jest.Mock).mockReset().mockResolvedValue({
      success: true,
      data: {
        shift: {
          id: 'shift-99',
          staff_name: 'د. أحمد',
          start_time: '2026-08-26T08:00:00Z',
          end_time: '2026-08-26T16:00:00Z',
          starting_cash: 200,
          ending_cash: 350,
          status: 'closed',
        },
        sales: [{ payment_method: 'cash', count: 1, total: 150, paid: 150, remaining: 0 }],
        returns: [],
        movements: [],
        summary: {
          cashSales: 150,
          cashReturns: 0,
          cashReceipts: 0,
          cashDisbursements: 0,
          cashHandover: 0,
          expectedCash: 350,
          actualCash: 350,
          difference: 0,
        },
      },
    });
  });

  it('opens shift receipts modal from ShiftManagementClient table', async () => {
    const mockShifts = [
      {
        id: 'shift-99',
        shift_start: '2026-08-26T08:00:00Z',
        shift_end: '2026-08-26T16:00:00Z',
        starting_cash_amount: 200,
        ending_cash_amount: 350,
        expected_cash_amount: 350,
        cash_difference: 0,
        status: 'closed' as const,
        profiles: { full_name: 'د. أحمد', role: 'pharmacist' },
      },
    ];

    render(
      <ShiftManagementClient
        initialShifts={mockShifts}
        currentShift={null}
        hasOpenShift={false}
        userRole="owner"
      />
    );

    const receiptsBtn = screen.getByRole('button', { name: /فواتير الوردية/ });
    expect(receiptsBtn).toBeInTheDocument();

    fireEvent.click(receiptsBtn);

    expect(await screen.findByText('فواتير وإيصالات الوردية')).toBeInTheDocument();
    expect(getShiftReceiptsAction).toHaveBeenCalledWith('shift-99');
    expect(await screen.findByText('علي حسن')).toBeInTheDocument();

    const viewDetailsBtn = screen.getByTitle('عرض تفاصيل الفاتورة');
    fireEvent.click(viewDetailsBtn);

    expect(await screen.findByText('Augmentin 1g')).toBeInTheDocument();
  });

  it('opens shift receipts modal from ShiftReportClient header and statbox', async () => {
    render(<ShiftReportClient shiftId="shift-99" />);

    const reportHeaderBtn = await screen.findByRole('button', { name: /عرض فواتير الوردية/ });
    expect(reportHeaderBtn).toBeInTheDocument();

    fireEvent.click(reportHeaderBtn);

    expect(await screen.findByText('فواتير وإيصالات الوردية')).toBeInTheDocument();
    expect(getShiftReceiptsAction).toHaveBeenCalledWith('shift-99');
    expect(await screen.findByText('علي حسن')).toBeInTheDocument();
  });
});
