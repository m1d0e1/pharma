import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';

jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(), getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn(async () => ({ success: true, data: [] })),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn(async () => ({ success: true, data: [] })),
}));
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn() } }));

const nativeInvoice = {
  id: 'TENANT-A-NATIVE-INVOICE', pharmacy_id: 'tenant-a',
  created_at: '2026-10-12 12:00:00', total_amount: 90, discount_amount: 10,
  payment_method: 'cash', status: 'completed', refunded_amount: null,
};

describe('/reports/sales native visible fail-closed and positive response', () => {
  beforeEach(() => (getSalesReportsAction as jest.Mock).mockReset());

  it('shows the denied-read alert, not fake zero totals; retry restores nonempty verified invoice and export', async () => {
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'فشل جلب تقرير المبيعات' })
      .mockResolvedValueOnce({ success: true, data: [nativeInvoice] });

    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('فشل جلب تقرير المبيعات');
    expect(screen.queryByText('صافي المبيعات')).not.toBeInTheDocument();
    expect(screen.queryByText('لا توجد فواتير مطابقة للبحث')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المبيعات' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    expect(await screen.findByText('#TENANT-A')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeEnabled();
    expect(screen.getByText(/احتساب المرتجعات غير متاح/)).toBeInTheDocument();
    expect(screen.getByText('الإجمالي (1 فاتورة)')).toBeInTheDocument();
  });

  it('editing filters invalidates old export before searching again, even if a previous read completes late', async () => {
    let completeRead!: (value: any) => void;
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [nativeInvoice] })
      .mockImplementationOnce(() => new Promise(resolve => { completeRead = resolve; }));

    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByText('#TENANT-A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'another' } });
    expect(screen.queryByText('#TENANT-A')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المبيعات' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'third' } });
    await act(async () => completeRead({ success: true, data: [nativeInvoice] }));
    expect(screen.queryByText('#TENANT-A')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();
    await waitFor(() => expect(getSalesReportsAction).toHaveBeenCalledTimes(2));
  });

  it('invalidates report, export and metadata when the authenticated user pharmacy changes', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true, data: [nativeInvoice],
    });
    const userA = { id: 'same', pharmacy_id: 'tenant-a', role: 'owner',
      permissions: { rep_can_view_sales: true } };
    const view = render(<SalesReportsClient userRole="owner" user={userA} />);
    expect(await screen.findByText('#TENANT-A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeEnabled();

    view.rerender(<SalesReportsClient userRole="owner" user={{ ...userA, pharmacy_id: 'tenant-b' }} />);
    expect(screen.queryByText('#TENANT-A')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المبيعات' })).toBeDisabled();
  });
});
