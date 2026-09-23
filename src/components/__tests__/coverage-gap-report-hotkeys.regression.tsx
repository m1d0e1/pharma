import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useHotkeys } from 'react-hotkeys-hook';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import { getInvoiceDetailsAction, getSalesReportsAction } from '@/app/actions-client/sales-reports';
import { getPurchaseInvoiceDetailsAction, getPurchasesReportsAction, getSuppliersAction } from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('next/link', () => function MockLink({ children, href, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});
jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(),
  getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/purchases', () => ({
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({ getPatientsAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

describe('report search keyboard shortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSalesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getStaffAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it.each([
    ['sales', <SalesReportsClient key="sales" userRole="owner" />, getSalesReportsAction],
    ['purchases', <PurchasesReportsClient key="purchases" userRole="owner" />, getPurchasesReportsAction],
  ])('runs the advertised F search shortcut in %s reports', async (_name, view, action) => {
    render(view as React.ReactElement);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    const hotkeyCall = (useHotkeys as jest.Mock).mock.calls.find(call => call[0] === 'f');
    expect(hotkeyCall).toBeDefined();
    const preventDefault = jest.fn();
    await act(async () => {
      hotkeyCall[1]({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('opens a sales invoice from a focused table row with Enter', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'SALE-KEYBOARD',
        payment_method: 'cash',
        created_at: '2026-09-22T08:00:00Z',
        patient_name: 'Keyboard Sales Customer',
        staff_name: 'Staff',
        total_amount: 10,
        discount_amount: 0,
        status: 'completed',
      }],
    });

    render(<SalesReportsClient userRole="owner" />);
    const row = (await screen.findByText('Keyboard Sales Customer')).closest('tr') as HTMLTableRowElement;
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(getInvoiceDetailsAction).toHaveBeenCalledWith('SALE-KEYBOARD'));
  });

  it('opens a purchase invoice from a focused table row with Enter', async () => {
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'PURCHASE-KEYBOARD',
        invoice_number: 'PURCHASE-KEYBOARD',
        invoice_date: '2026-09-22',
        created_at: '2026-09-22T08:00:00Z',
        supplier_name: 'Keyboard Supplier',
        staff_name: 'Staff',
        payment_method: 'cash',
        gross_amount: 10,
        total_amount: 10,
        discount_amount: 0,
        total_selling_amount: 12,
        status: 'completed',
      }],
    });

    render(<PurchasesReportsClient userRole="owner" />);
    const row = (await screen.findByText('Keyboard Supplier')).closest('tr') as HTMLTableRowElement;
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledWith('PURCHASE-KEYBOARD'));
  });
});
