import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import { getSalesReportsAction, getInvoiceDetailsAction } from '@/app/actions-client/sales-reports';
import { getPurchasesReportsAction, getPurchaseInvoiceDetailsAction, getSuppliersAction } from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';

jest.mock('next/link', () => function MockLink({ children, href, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});

jest.mock('next/dynamic', () => () => function MockDynamicReceipt({ invoice }: any) {
  return <div data-testid="sales-report-receipt">{invoice?.sales_items?.[0]?.trade_name || 'empty-receipt'}</div>;
});

jest.mock('@/lib/auth/local', () => ({
  hasUserPermissionSync: () => true,
}));

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
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const sale = (id: string, patientName: string) => ({
  id,
  payment_method: 'cash',
  created_at: '2026-09-21T10:00:00Z',
  patient_name: patientName,
  staff_name: 'Staff',
  total_amount: 100,
  discount_amount: 0,
  status: 'completed',
});

const purchase = (id: string, supplierName: string) => ({
  id,
  invoice_number: id,
  invoice_date: '2026-09-21',
  created_at: '2026-09-21T10:00:00Z',
  supplier_name: supplierName,
  staff_name: 'Staff',
  payment_method: 'cash',
  gross_amount: 100,
  total_amount: 100,
  discount_amount: 0,
  total_selling_amount: 120,
  status: 'completed',
});

const purchaseItem = (id: string, name: string) => ({
  id,
  drug_id: 1,
  barcode: '123',
  trade_name: name,
  trade_name_en: name,
  expiry_date: '2027-01-01',
  quantity: 1,
  unit_id: 1,
  cost_price: 10,
  selling_price: 15,
  line_gross_amount: 10,
  line_net_amount: 10,
});

describe('report clients async response ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSalesReportsAction as jest.Mock).mockReset();
    (getPurchasesReportsAction as jest.Mock).mockReset();
    (getInvoiceDetailsAction as jest.Mock).mockReset();
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockReset();
    (getStaffAction as jest.Mock).mockReset();
    (getPatientsAction as jest.Mock).mockReset();
    (getSuppliersAction as jest.Mock).mockReset();
    (getStaffAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('keeps the latest sales search result when an older request resolves afterwards', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    let resolveNew: (value: unknown) => void = () => {};
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));

    render(<SalesReportsClient userRole="owner" />);
    await waitFor(() => expect(getSalesReportsAction).toHaveBeenCalledTimes(1));

    const invoiceSearch = screen.getByPlaceholderText('ابحث برقم الفاتورة...');
    fireEvent.change(invoiceSearch, { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    fireEvent.change(invoiceSearch, { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    expect(getSalesReportsAction).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveNew({ success: true, data: [sale('SALE-NEW', 'Latest Sales Customer')] });
    });
    expect(await screen.findByText('Latest Sales Customer')).toBeInTheDocument();

    await act(async () => {
      resolveOld({ success: true, data: [sale('SALE-OLD', 'Stale Sales Customer')] });
    });

    expect(screen.getByText('Latest Sales Customer')).toBeInTheDocument();
    expect(screen.queryByText('Stale Sales Customer')).not.toBeInTheDocument();
  });

  it('keeps the latest purchase search result when an older request resolves afterwards', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    let resolveNew: (value: unknown) => void = () => {};
    (getPurchasesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));

    render(<PurchasesReportsClient userRole="owner" />);
    await waitFor(() => expect(getPurchasesReportsAction).toHaveBeenCalledTimes(1));

    const drugSearch = screen.getByPlaceholderText('ادخل اسم الصنف أو المادة الفعالة للبحث في الفواتير...');
    fireEvent.change(drugSearch, { target: { value: 'old drug' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث في الفواتير \(F\)/ }));
    fireEvent.change(drugSearch, { target: { value: 'new drug' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث في الفواتير \(F\)/ }));
    expect(getPurchasesReportsAction).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveNew({ success: true, data: [purchase('PUR-NEW', 'Latest Purchase Supplier')] });
    });
    expect(await screen.findByText('Latest Purchase Supplier')).toBeInTheDocument();

    await act(async () => {
      resolveOld({ success: true, data: [purchase('PUR-OLD', 'Stale Purchase Supplier')] });
    });

    expect(screen.getByText('Latest Purchase Supplier')).toBeInTheDocument();
    expect(screen.queryByText('Stale Purchase Supplier')).not.toBeInTheDocument();
  });

  it('keeps the latest sales invoice details when an older detail request resolves afterwards', async () => {
    const first = sale('SALE-A', 'Sales Customer A');
    const second = sale('SALE-B', 'Sales Customer B');
    (getSalesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [first, second] });
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    (getInvoiceDetailsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    render(<SalesReportsClient userRole="owner" />);
    fireEvent.click((await screen.findByText('Sales Customer A')).closest('tr') as HTMLTableRowElement);
    fireEvent.click(screen.getByText('Sales Customer B').closest('tr') as HTMLTableRowElement);

    await act(async () => {
      resolveSecond({ success: true, data: [{ id: 'sale-item-b', trade_name: 'Latest Sale Item', quantity_sold: 1, unit_price: 10 }] });
    });
    expect(await screen.findByTestId('sales-report-receipt')).toHaveTextContent('Latest Sale Item');

    await act(async () => {
      resolveFirst({ success: true, data: [{ id: 'sale-item-a', trade_name: 'Stale Sale Item', quantity_sold: 1, unit_price: 10 }] });
    });
    expect(screen.getByTestId('sales-report-receipt')).toHaveTextContent('Latest Sale Item');
  });

  it('closes sales invoice details when a successful new search no longer owns that invoice', async () => {
    const first = sale('SALE-A', 'Sales Customer A');
    const second = sale('SALE-B', 'Sales Customer B');
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [first] })
      .mockResolvedValueOnce({ success: true, data: [second] });
    (getInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'sale-item-a', trade_name: 'Owned Sale Item A', quantity_sold: 1, unit_price: 10 }],
    });

    render(<SalesReportsClient userRole="owner" />);
    fireEvent.click((await screen.findByText('Sales Customer A')).closest('tr') as HTMLTableRowElement);
    expect(await screen.findByTestId('sales-report-receipt')).toHaveTextContent('Owned Sale Item A');

    fireEvent.change(screen.getByPlaceholderText('ابحث برقم الفاتورة...'), { target: { value: 'SALE-B' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));

    expect(await screen.findByText('Sales Customer B')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('sales-report-receipt')).not.toBeInTheDocument());
  });

  it('keeps the latest purchase invoice details when an older detail request resolves afterwards', async () => {
    const first = purchase('PUR-A', 'Purchase Supplier A');
    const second = purchase('PUR-B', 'Purchase Supplier B');
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [first, second] });
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    render(<PurchasesReportsClient userRole="owner" />);
    fireEvent.click((await screen.findByText('Purchase Supplier A')).closest('tr') as HTMLTableRowElement);
    fireEvent.click(screen.getByText('Purchase Supplier B').closest('tr') as HTMLTableRowElement);

    await act(async () => {
      resolveSecond({ success: true, data: [purchaseItem('purchase-item-b', 'Latest Purchase Item')] });
    });
    expect(await screen.findByText('Latest Purchase Item')).toBeInTheDocument();

    await act(async () => {
      resolveFirst({ success: true, data: [purchaseItem('purchase-item-a', 'Stale Purchase Item')] });
    });
    expect(screen.getByText('Latest Purchase Item')).toBeInTheDocument();
    expect(screen.queryByText('Stale Purchase Item')).not.toBeInTheDocument();
  });

  it('closes purchase invoice details when a successful new search excludes the open invoice', async () => {
    const first = purchase('PUR-A', 'Purchase Supplier A');
    const second = purchase('PUR-B', 'Purchase Supplier B');
    (getPurchasesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [first] })
      .mockResolvedValueOnce({ success: true, data: [second] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: [purchaseItem('purchase-item-a', 'Owned Purchase Item A')],
    });

    render(<PurchasesReportsClient userRole="owner" />);
    fireEvent.click((await screen.findByText('Purchase Supplier A')).closest('tr') as HTMLTableRowElement);
    expect(await screen.findByText('Owned Purchase Item A')).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText('ادخل اسم الصنف أو المادة الفعالة للبحث في الفواتير...'),
      { target: { value: 'next item' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /بحث في الفواتير \(F\)/ }));

    expect(await screen.findByText('Purchase Supplier B')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Owned Purchase Item A')).not.toBeInTheDocument());
  });
});
