import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useHotkeys } from 'react-hotkeys-hook';
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
    expect(screen.getByRole('button', { name: 'العودة' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').filter(button => !button.textContent?.trim() && !button.getAttribute('aria-label'))).toHaveLength(0);

    fireEvent.click(reportHeaderBtn);

    expect(await screen.findByText('فواتير وإيصالات الوردية')).toBeInTheDocument();
    expect(getShiftReceiptsAction).toHaveBeenCalledWith('shift-99');
    expect(await screen.findByText('علي حسن')).toBeInTheDocument();
  });

  it('distinguishes a returned shift-receipts failure from a legitimate empty shift and retries', async () => {
    (getShiftReceiptsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'receipts unavailable' })
      .mockResolvedValueOnce({ success: true, data: [] });

    const ShiftReceiptsModal = jest.requireActual('@/components/shifts/ShiftReceiptsModal').default;
    render(
      <ShiftReceiptsModal
        isOpen
        shiftId="shift-error"
        shiftTitle="وردية اختبار"
        onClose={jest.fn()}
      />
    );

    expect(await screen.findByText('تعذر تحميل فواتير الوردية')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد فواتير مبيعات مسجلة في هذه الوردية')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('لا توجد فواتير مبيعات مسجلة في هذه الوردية')).toBeInTheDocument();
    expect(getShiftReceiptsAction).toHaveBeenCalledTimes(2);
  });

  it('recovers from a thrown shift-receipts load without presenting false zero-data content', async () => {
    (getShiftReceiptsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('shift receipts bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: [] });

    const ShiftReceiptsModal = jest.requireActual('@/components/shifts/ShiftReceiptsModal').default;
    render(
      <ShiftReceiptsModal
        isOpen
        shiftId="shift-throw"
        onClose={jest.fn()}
      />
    );

    expect(await screen.findByText('تعذر تحميل فواتير الوردية')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('لا توجد فواتير مبيعات مسجلة في هذه الوردية')).toBeInTheDocument();
  });

  it('closes nested receipt details when the owning shift changes while the modal stays open', async () => {
    (getShiftReceiptsAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{
          id: 'old-invoice',
          invoice_number: 'OLD-1',
          total_amount: 150,
          payment_method: 'cash',
          created_at: '2026-08-26T09:30:00Z',
          patient_name: 'عميل الوردية القديمة',
          staff_name: 'د. قديم',
          sales_items: [{ quantity_sold: 1, unit_price: 150, trade_name: 'Old Shift Drug', unit: 'large' }],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          id: 'new-invoice',
          invoice_number: 'NEW-1',
          total_amount: 90,
          payment_method: 'cash',
          created_at: '2026-08-27T09:30:00Z',
          patient_name: 'عميل الوردية الجديدة',
          staff_name: 'د. جديد',
          sales_items: [{ quantity_sold: 1, unit_price: 90, trade_name: 'New Shift Drug', unit: 'large' }],
        }],
      });

    const ShiftReceiptsModal = jest.requireActual('@/components/shifts/ShiftReceiptsModal').default;
    const view = render(
      <ShiftReceiptsModal isOpen shiftId="shift-old" shiftTitle="الوردية القديمة" onClose={jest.fn()} />
    );

    expect(await screen.findByText('عميل الوردية القديمة')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('عرض تفاصيل الفاتورة'));
    expect(await screen.findByText('Old Shift Drug')).toBeInTheDocument();

    view.rerender(
      <ShiftReceiptsModal isOpen shiftId="shift-new" shiftTitle="الوردية الجديدة" onClose={jest.fn()} />
    );

    expect(screen.queryByText('Old Shift Drug')).not.toBeInTheDocument();
    expect(await screen.findByText('عميل الوردية الجديدة')).toBeInTheDocument();
    expect(getShiftReceiptsAction).toHaveBeenCalledWith('shift-new');
  });

  it('resets the owning search filter when switching to another shift', async () => {
    (getShiftReceiptsAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{
          id: 'old-invoice',
          invoice_number: 'OLD-1',
          total_amount: 10,
          payment_method: 'cash',
          created_at: '2026-08-26T09:30:00Z',
          patient_name: 'Old Customer',
          staff_name: 'Old Staff',
          sales_items: [],
        }],
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{
          id: 'new-invoice',
          invoice_number: 'NEW-1',
          total_amount: 20,
          payment_method: 'cash',
          created_at: '2026-08-27T09:30:00Z',
          patient_name: 'New Customer',
          staff_name: 'New Staff',
          sales_items: [],
        }],
      });

    const ShiftReceiptsModal = jest.requireActual('@/components/shifts/ShiftReceiptsModal').default;
    const view = render(<ShiftReceiptsModal isOpen shiftId="shift-old" onClose={jest.fn()} />);
    const search = await screen.findByPlaceholderText('بحث برقم الفاتورة أو اسم العميل أو اسم الصنف...');
    fireEvent.change(search, { target: { value: 'OLD-1' } });
    expect(search).toHaveValue('OLD-1');

    view.rerender(<ShiftReceiptsModal isOpen shiftId="shift-new" onClose={jest.fn()} />);
    await screen.findByText('New Customer');
    expect(screen.getByPlaceholderText('بحث برقم الفاتورة أو اسم العميل أو اسم الصنف...')).toHaveValue('');
  });

  it('keeps the outer shift-receipts modal open when Escape belongs to nested receipt details', async () => {
    const onClose = jest.fn();
    const ShiftReceiptsModal = jest.requireActual('@/components/shifts/ShiftReceiptsModal').default;
    render(<ShiftReceiptsModal isOpen shiftId="shift-nested" onClose={onClose} />);
    await screen.findByText('علي حسن');
    const escCallsBeforeDetails = (useHotkeys as jest.Mock).mock.calls.filter(call => call[0] === 'esc').length;
    fireEvent.click(screen.getByTitle('عرض تفاصيل الفاتورة'));
    expect(await screen.findByText('Augmentin 1g')).toBeInTheDocument();

    const escCalls = (useHotkeys as jest.Mock).mock.calls.filter(call => call[0] === 'esc');
    const parentEsc = escCalls.slice(escCallsBeforeDetails)[0];
    expect(parentEsc).toBeDefined();
    act(() => parentEsc[1]());

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('فواتير وإيصالات الوردية')).toBeInTheDocument();
  });
});
