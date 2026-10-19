import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';

jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(), getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn() } }));

const reportRow = {
  id: 'SENSITIVE-OLD-TENANT-SALE',
  patient_name: 'QA-STALE-CROSS-TENANT-PRIVATE-ROW',
  staff_name: 'Old Staff', payment_method: 'cash', status: 'completed',
  created_at: '2026-10-10T10:00:00Z', total_amount: 125, discount_amount: 0,
};

describe('sales report fail-closed authorization and export', () => {
  beforeEach(() => (getSalesReportsAction as jest.Mock).mockReset());

  it('removes previously visible sensitive totals/rows when a later report read is denied, and disables exports', async () => {
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [reportRow] })
      .mockResolvedValueOnce({ success: false, error: 'Session or tenant revoked' });
    const createObjectURL = jest.fn();
    const oldCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    try {
      render(<SalesReportsClient userRole="owner" />);
      expect(await screen.findByText(reportRow.patient_name)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
      await waitFor(() => expect(getSalesReportsAction).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText(reportRow.patient_name)).not.toBeInTheDocument());
      expect(screen.queryByText('125.00')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'طباعة تقرير المبيعات' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' }));
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      if (oldCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: oldCreateObjectURL });
      } else {
        Reflect.deleteProperty(URL, 'createObjectURL');
      }
    }
  });

  it('never offers print/export for an initial failed report read', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'Unauthorized' });
    render(<SalesReportsClient userRole="owner" />);
    await waitFor(() => expect(getSalesReportsAction).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المبيعات' })).toBeDisabled();
  });
});
