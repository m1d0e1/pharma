import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseReportsClient from '@/components/reports/PurchaseReportsClient';
import {
  deletePurchaseInvoiceAction,
  getPurchaseInvoiceDetailsAction,
  getPurchaseInvoicesAction,
} from '@/app/actions-client/purchases';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/purchases', () => ({
  deletePurchaseInvoiceAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getPurchaseInvoicesAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    loading: jest.fn(),
    dismiss: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('next/link', () => function MockLink({ children, href, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});

jest.mock('@/components/purchases/BarcodePrinter', () => function MockBarcodePrinter({ items }: any) {
  return <div data-testid="barcode-printer">barcode-{items?.[0]?.trade_name || 'empty'}</div>;
});

const invoice = (id: string, number: string, supplier: string) => ({
  id,
  invoice_number: number,
  invoice_date: '2026-09-21',
  created_at: '2026-09-21T10:00:00Z',
  supplier_id: 1,
  supplier_name: supplier,
  supplier_phone: '',
  user_name: 'Owner',
  payment_method: 'cash',
  status: 'completed',
  total_amount: 100,
  gross_amount: 100,
  discount_amount: 0,
  expenses: 0,
  tax_percent: 0,
  drug_names: 'drug',
});

const item = (id: string, name: string) => ({
  id,
  drug_id: 1,
  trade_name: name,
  trade_name_en: name,
  barcode: '123',
  quantity: 1,
  bonus_quantity: 0,
  expiry_date: '2027-01-01',
  unit_id: 1,
  cost_price: 10,
  selling_price: 15,
  tax_percent: 0,
  line_gross_amount: 10,
  line_net_amount: 10,
});

describe('PurchaseReportsClient async/error behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getPurchaseInvoicesAction as jest.Mock).mockReset();
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockReset();
    (deletePurchaseInvoiceAction as jest.Mock).mockReset();
    window.confirm = jest.fn(() => true);
  });

  it('shows a retryable load error instead of healthy zero totals when invoice loading fails', async () => {
    (getPurchaseInvoicesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'purchase reports unavailable' })
      .mockResolvedValueOnce({ success: true, data: [invoice('inv-1', 'PO-1', 'Recovered Supplier')] });

    render(<PurchaseReportsClient />);

    expect(await screen.findByText('تعذر تحميل تقارير المشتريات')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد فواتير مطابقة')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Recovered Supplier')).toBeInTheDocument();
  });

  it('keeps the newest purchase-report retry result when same-tick retries resolve out of order', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    (getPurchaseInvoicesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'initial unavailable' })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    render(<PurchaseReportsClient />);
    const retryButton = await screen.findByRole('button', { name: 'إعادة المحاولة' });

    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getPurchaseInvoicesAction).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveNewer({ success: true, data: [invoice('inv-new', 'PO-NEW', 'Newest Supplier')] });
    });
    expect(await screen.findByText('Newest Supplier')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: true, data: [invoice('inv-old', 'PO-OLD', 'Older Supplier')] });
    });
    expect(screen.getByText('Newest Supplier')).toBeInTheDocument();
    expect(screen.queryByText('Older Supplier')).not.toBeInTheDocument();
  });

  it('keeps the latest invoice details when an older request resolves afterwards', async () => {
    const first = invoice('inv-a', 'PO-A', 'Supplier A');
    const second = invoice('inv-b', 'PO-B', 'Supplier B');
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({ success: true, data: [first, second] });

    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    render(<PurchaseReportsClient />);
    const firstSupplier = await screen.findByText('Supplier A');
    const secondSupplier = screen.getByText('Supplier B');

    fireEvent.click(firstSupplier.closest('tr') as HTMLTableRowElement);
    fireEvent.click(secondSupplier.closest('tr') as HTMLTableRowElement);
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenNthCalledWith(1, 'inv-a');
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenNthCalledWith(2, 'inv-b');

    await act(async () => {
      resolveSecond({ success: true, data: [item('item-b', 'Latest Item B')] });
    });
    expect(await screen.findByText('Latest Item B')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /فاتورة شراء PO-B/ })).toBeInTheDocument();

    await act(async () => {
      resolveFirst({ success: true, data: [item('item-a', 'Stale Item A')] });
    });

    expect(screen.getByRole('heading', { name: /فاتورة شراء PO-B/ })).toBeInTheDocument();
    expect(screen.getByText('Latest Item B')).toBeInTheDocument();
    expect(screen.queryByText('Stale Item A')).not.toBeInTheDocument();
  });

  it('blocks repeated destructive delete events while the first critical deletion is pending', async () => {
    const target = invoice('inv-delete', 'PO-DELETE', 'Delete Supplier');
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({ success: true, data: [target] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    let resolveDelete!: (value: { success: boolean; error?: string }) => void;
    (deletePurchaseInvoiceAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveDelete = resolve;
    }));

    render(<PurchaseReportsClient />);
    fireEvent.click((await screen.findByText('Delete Supplier')).closest('tr') as HTMLTableRowElement);
    const deleteButton = await screen.findByRole('button', { name: /حذف السجل فقط/ });

    act(() => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deletePurchaseInvoiceAction).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);

    await act(async () => resolveDelete({ success: false, error: 'critical delete rejected' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('critical delete rejected'));
    expect(screen.getByRole('heading', { name: /فاتورة شراء PO-DELETE/ })).toBeInTheDocument();
  });

  it('keeps the latest barcode-detail result when an older request resolves afterwards', async () => {
    const first = invoice('inv-barcode-a', 'PO-BA', 'Barcode Supplier A');
    const second = invoice('inv-barcode-b', 'PO-BB', 'Barcode Supplier B');
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({ success: true, data: [first, second] });
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    render(<PurchaseReportsClient />);
    const printButtons = await screen.findAllByTitle('طباعة ملصقات الباركود');
    fireEvent.click(printButtons[0]);
    fireEvent.click(printButtons[1]);
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenNthCalledWith(1, 'inv-barcode-a');
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenNthCalledWith(2, 'inv-barcode-b');

    await act(async () => {
      resolveSecond({ success: true, data: [item('barcode-b', 'Latest Barcode Drug')] });
    });
    expect(await screen.findByTestId('barcode-printer')).toHaveTextContent('barcode-Latest Barcode Drug');

    await act(async () => {
      resolveFirst({ success: true, data: [item('barcode-a', 'Stale Barcode Drug')] });
    });
    expect(screen.getByTestId('barcode-printer')).toHaveTextContent('barcode-Latest Barcode Drug');
  });
});
