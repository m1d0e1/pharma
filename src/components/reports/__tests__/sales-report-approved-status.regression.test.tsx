import React from 'react';
import { render, screen } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';

jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(),
  getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));

it('displays historical approved sales with a localized approved status', async () => {
  (getSalesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [{
    id: 'legacy-approved-sale',
    created_at: '2026-10-10T10:00:00Z',
    patient_name: 'Approved Customer',
    staff_name: 'Cashier',
    payment_method: 'cash',
    total_amount: 20,
    discount_amount: 0,
    status: 'approved',
  }] });

  render(<SalesReportsClient userRole="owner" />);
  expect(await screen.findByText('Approved Customer')).toBeInTheDocument();
  const invoiceRow = screen.getByText('Approved Customer').closest('tr');
  expect(invoiceRow).toHaveTextContent('معتمدة');
  expect(invoiceRow).not.toHaveTextContent('approved');
});
