import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import PurchaseReportsClient from '@/components/reports/PurchaseReportsClient';
import {
  getPurchaseInvoicesAction,
  getPurchasesReportsAction,
  getPurchaseInvoiceDetailsAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/components/ui/TableScrollContainer', () => function Scroll({ children }: React.PropsWithChildren) {
  return <div>{children}</div>;
});
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));
jest.mock('@/app/actions-client/purchases', () => ({
  getPurchaseInvoicesAction: jest.fn(),
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  deletePurchaseInvoiceAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

describe('purchase report read readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getStaffAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('loads financial invoices even if optional supplier filter metadata does not resolve', async () => {
    (getSuppliersAction as jest.Mock).mockImplementation(() => new Promise(() => {}));
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'source-101', invoice_number: 'P-101', supplier_name: 'Ready Supplier',
        status: 'completed', payment_method: 'cash', total_amount: 42,
        gross_amount: 50, discount_amount: 8, total_selling_amount: 60,
      }],
    });

    render(<PurchasesReportsClient userRole="owner" />);

    expect(await screen.findByText('Ready Supplier')).toBeInTheDocument();
    expect(screen.getByText('الإجمالي (1 فاتورة)')).toBeInTheDocument();
    expect(getPurchasesReportsAction).toHaveBeenCalledTimes(1);
    expect(getSuppliersAction).toHaveBeenCalledWith({ reportScope: true });
  });

  it('shows original 462, later verified return 115.50 and adjusted 346.50 separately', async () => {
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [{
      id: 'purchase-a', invoice_number: 'P-462', invoice_date: '2026-10-15',
      supplier_name: 'QA Supplier', status: 'completed', payment_method: 'credit',
      total_amount: 462, returned_amount: 115.5, net_after_returns: 346.5,
      gross_amount: 462, discount_amount: 0, total_selling_amount: 600,
    }] });
    render(<PurchasesReportsClient userRole="owner" />);
    expect(await screen.findByText('QA Supplier')).toBeInTheDocument();
    expect(screen.getByText('صافي فواتير الشراء قبل مرتجعات الموردين').parentElement)
      .toHaveTextContent('462');
    expect(screen.getByText('مرتجعات الموردين الموثقة لتلك الفواتير').parentElement)
      .toHaveTextContent('115.5');
    expect(screen.getByText('صافي المشتريات بعد مرتجعات الموردين الموثقة').parentElement)
      .toHaveTextContent('346.5');
    expect(screen.getByRole('note')).toHaveTextContent('المرتجعات اللاحقة لنهاية الفترة');
    expect(screen.getByRole('columnheader', { name: 'الصافي بعد المرتجعات' })).toBeInTheDocument();
  });

  it('blocks report and print when native return provenance is denied after a previous success', async () => {
    (getPurchasesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [{
        id: 'purchase-a', total_amount: 462, returned_amount: 115.5,
        net_after_returns: 346.5, status: 'completed', payment_method: 'credit',
      }] })
      .mockResolvedValueOnce({ success: false,
        error: 'Unverified tenant-owned purchase return; net purchasing report unavailable' });
    render(<PurchasesReportsClient userRole="owner" />);
    expect(await screen.findByText('صافي المشتريات بعد مرتجعات الموردين الموثقة')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /بحث في الفواتير/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر احتساب الصافي بعد المرتجعات');
    expect(screen.queryByText('صافي المشتريات بعد مرتجعات الموردين الموثقة')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المشتريات' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المشتريات إلى Excel' })).toBeDisabled();
  });

  it('disables printing and exporting a previously loaded report when a later tenant ownership read is denied', async () => {
    (getPurchasesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [{
        id: 'tenant-a-cash', invoice_number: 'A-CASH', supplier_name: 'Verified Tenant A',
        invoice_date: '2026-10-10', status: 'completed', payment_method: 'cash',
        gross_amount: 122.5, discount_amount: 16.75, total_amount: 105.75,
        total_selling_amount: 160,
      }] })
      .mockResolvedValueOnce({
        success: false, error: 'Legacy purchasing ownership needs independent tenant verification',
      });
    const print = jest.spyOn(window, 'print').mockImplementation(() => {});
    try {
      render(<PurchasesReportsClient userRole="owner" />);
      expect(await screen.findByText('Verified Tenant A')).toBeInTheDocument();
      const printButton = screen.getByRole('button', { name: 'طباعة تقرير المشتريات' });
      const exportButton = screen.getByRole('button', { name: 'تصدير تقرير المشتريات إلى Excel' });
      expect(printButton).toBeEnabled();
      expect(exportButton).toBeEnabled();
      fireEvent.click(printButton);
      expect(print).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: /بحث في الفواتير/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('ملكية بيانات المشتريات');
      expect(screen.queryByText('Verified Tenant A')).not.toBeInTheDocument();
      expect(screen.queryByText('صافي فواتير الشراء قبل مرتجعات الموردين')).not.toBeInTheDocument();
      expect(printButton).toBeDisabled();
      expect(exportButton).toBeDisabled();
      fireEvent.click(printButton);
      fireEvent.click(exportButton);
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      print.mockRestore();
    }
  });

  it('closes failed invoice details so an unsuccessful read cannot be shown as an empty invoice', async () => {
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'invoice-101', invoice_number: 'PINV-101', invoice_date: '2026-10-16',
        supplier_name: 'Supplier Retry', status: 'completed', payment_method: 'cash',
        total_amount: 75,
      }],
    });
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'No access to invoice lines' })
      .mockResolvedValueOnce({ success: true, data: [{
        id: 'item-101', trade_name: 'Recovered Drug', quantity: 1, cost_price: 75,
        selling_price: 90, tax_percent: 0,
      }] });

    render(<PurchaseReportsClient />);
    const supplier = await screen.findByText('Supplier Retry');
    fireEvent.click(supplier.closest('tr')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحميل تفاصيل فاتورة الشراء'));

    expect(screen.queryByRole('dialog', { name: /فاتورة شراء PINV-101/ })).not.toBeInTheDocument();
    fireEvent.click(supplier.closest('tr')!);
    expect(await screen.findByText('Recovered Drug')).toBeInTheDocument();
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledTimes(2);
  });
});
