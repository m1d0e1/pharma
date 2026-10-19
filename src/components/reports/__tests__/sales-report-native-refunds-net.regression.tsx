import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SalesReportsClient from '../SalesReportsClient';
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

const invoice = {
  id: 'sale-300-refunded-150', pharmacy_id: 'tenant-a',
  created_at: '2026-10-10T11:00:00Z', total_amount: 300,
  discount_amount: 0, payment_method: 'cash', status: 'completed',
};

describe('/reports/sales native NET and export provenance caveat', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shows 150 adjusted NET beside the original 300 invoice, labels scope and exports both verified amounts', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true, returnsVerified: true,
      data: [{ ...invoice, refunded_amount: 150 }],
    });
    let exported: Blob | null = null;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true,
      value: jest.fn((blob: Blob) => { exported = blob; return 'blob:report'; }) });
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<SalesReportsClient userRole="owner" />);
    const net = (await screen.findByText('صافي المبيعات')).parentElement;
    expect(net).toHaveTextContent('150');
    expect(net).toHaveTextContent('مرتجعات معتمدة: 150 ج.م');
    expect(screen.getByText(/الفترة حسب تاريخ الفاتورة/)).toBeInTheDocument();
    expect(screen.getByText('الإجمالي (1 فاتورة)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' }));
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(exported!);
    });
    expect(csv).toContain('مرتجعات الفاتورة المعتمدة حتى الآن');
    expect(csv).toContain('صافي الفاتورة بعد المرتجعات حتى الآن');
    expect(csv).toContain(',300,0,300,completed,150,150');
  });

  it('keeps net unavailable when the separate native return permission is absent, including an empty report', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true, returnsVerified: false, data: [{ ...invoice, refunded_amount: null }],
    });
    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByText(/احتساب المرتجعات غير متاح/)).toBeInTheDocument();
    expect(screen.queryByText('صافي المبيعات')).not.toBeInTheDocument();
    expect(screen.getAllByText('غير متاح').length).toBeGreaterThan(0);
  });
});
