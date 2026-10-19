import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import {
  getPurchasesReportsAction,
  getPurchaseInvoiceDetailsAction,
  getSuppliersAction,
} from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { hasUserPermissionSync } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

// Receipt/source reporting only: no native IPC, financial writer, SQLite or
// purchase-creation nonce is executed by these rendered UI regressions.
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
// The scroll indicator is outside this receipt/valuation regression and its
// ResizeObserver is not implemented in JSDOM; keep the actual report/form DOM.
jest.mock('@/components/ui/TableScrollContainer', () => function MockTableScroll({ children }: React.PropsWithChildren) {
  return <div>{children}</div>;
});
jest.mock('next/link', () => function MockLink({ href, children, ...props }: React.PropsWithChildren<{ href: string }>) {
  return <a href={href} {...props}>{children}</a>;
});
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: jest.fn() }));
jest.mock('@/app/actions-client/purchases', () => ({
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const sourceInvoice = {
  id: 'synthetic-source-invoice-8-A', invoice_number: 'PINV-8-A', invoice_date: '2026-09-18',
  created_at: '2026-09-18T10:00:00Z', supplier_id: 81, supplier_name: 'Source Supplier A',
  staff_name: 'Buyer Eight', payment_method: 'credit', status: 'completed',
  gross_amount: 92, discount_amount: 7, total_amount: 85, total_selling_amount: 135,
};
const otherInvoice = {
  ...sourceInvoice, id: 'synthetic-source-invoice-8-B', invoice_number: 'PINV-8-B',
  supplier_id: 82, supplier_name: 'Source Supplier B', payment_method: 'cash',
  gross_amount: 30, discount_amount: 0, total_amount: 30, total_selling_amount: 42,
};
const receiptLots = [
  {
    id: 'source-line-8-a', drug_id: 806, barcode: 'LOT-8-EXP-31',
    trade_name: 'Synthetic Paid Lot', trade_name_en: 'Synthetic Paid Lot',
    quantity: 2, bonus_quantity: 1, large_unit: 'كرتون', expiry_date: '2028-10-31',
    cost_price: 30, tax_percent: 10, selling_price: 50,
    line_gross_amount: 66, line_net_amount: 60,
  },
  {
    id: 'source-line-8-b', drug_id: 807, barcode: 'LOT-8-EXP-32',
    trade_name: 'Second Source Lot', trade_name_en: 'Second Source Lot',
    quantity: 1, bonus_quantity: 0, large_unit: '', expiry_date: '2029-04-30',
    cost_price: 20, selling_price: 35, line_gross_amount: 20, line_net_amount: 19,
  },
];

function searchButton() {
  return screen.getByRole('button', { name: 'بحث في الفواتير (F)' });
}

function sourceRow(supplier: string) {
  return screen.getByText(supplier).closest('tr') as HTMLTableRowElement;
}

describe('QA background purchasing source receipts, stock lots and valuation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user, permission: string) =>
      permission === 'rep_can_view_purchases');
    (getStaffAction as jest.Mock).mockResolvedValue({
      success: true, data: [{ id: 'buyer-8', full_name: 'Buyer Eight' }],
    });
    (getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true, data: [
        { id: 81, name_ar: 'مورد المصدر الأول' },
        { id: 82, name_ar: 'مورد المصدر الثاني' },
      ],
    });
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({ success: true, data: [sourceInvoice] });
    (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: receiptLots });
  });

  it('loads source-scoped directory choices, submits combined lot/supplier/buyer/tender/date filters only on Search', async () => {
    render(<PurchasesReportsClient user={{ id: 'buyer-8', role: 'pharmacist' }} />);
    expect(await screen.findByText('Source Supplier A')).toBeInTheDocument();
    expect(getSuppliersAction).toHaveBeenCalledWith({ reportScope: true });
    expect(getStaffAction).toHaveBeenCalledTimes(1);
    expect(getPurchasesReportsAction).toHaveBeenCalledTimes(1);
    expect(getPurchasesReportsAction).toHaveBeenCalledWith({
      startDate: expect.any(String), endDate: expect.any(String),
      userId: undefined, supplierId: undefined, paymentMethod: 'all', invoiceNumber: '', drugName: '',
    });
    expect(screen.getByRole('option', { name: 'مورد المصدر الثاني' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Buyer Eight' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('من تاريخ'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('إلى تاريخ'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'PINV-8-A' } });
    fireEvent.change(screen.getByLabelText(/البحث باسم الصنف/), { target: { value: 'Paid Lot' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'المورد' }), { target: { value: '81' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'الموظف / الصيدلي' }), { target: { value: 'buyer-8' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'طريقة الدفع' }), { target: { value: 'credit' } });
    expect(getPurchasesReportsAction).toHaveBeenCalledTimes(1);

    fireEvent.click(searchButton());
    await waitFor(() => expect(getPurchasesReportsAction).toHaveBeenLastCalledWith({
      startDate: '2026-08-01', endDate: '2026-09-30',
      userId: 'buyer-8', supplierId: '81', paymentMethod: 'credit',
      invoiceNumber: 'PINV-8-A', drugName: 'Paid Lot',
    }));
    expect(screen.getByRole('combobox', { name: 'المورد' })).toHaveValue('81');
    expect(screen.getByRole('combobox', { name: 'طريقة الدفع' })).toHaveValue('credit');
    expect(screen.getByText('Source Supplier A')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'تقارير المشتريات' })).toHaveAttribute('href', '/reports/purchases');
    expect(screen.queryByRole('link', { name: 'تقرير فواتير المبيعات' })).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('drills down to the exact purchase source lots, paid quantity, expiry and invoice-to-lines valuation without a write', async () => {
    render(<PurchasesReportsClient userRole="owner" />);
    const source = await screen.findByText('Source Supplier A');
    fireEvent.click(source.closest('tr')!);
    await waitFor(() => expect(getPurchaseInvoiceDetailsAction).toHaveBeenCalledWith(
      'synthetic-source-invoice-8-A', { reportScope: true },
    ));

    // Dialog heading intentionally truncates the source ID to eight characters.
    const dialog = await screen.findByRole('dialog', { name: /أصناف الفاتورة/ });
    const paid = within(dialog).getByText('Synthetic Paid Lot').closest('tr')!;
    const second = within(dialog).getByText('Second Source Lot').closest('tr')!;
    expect(within(paid).getByText('LOT-8-EXP-31')).toBeInTheDocument();
    expect(within(paid).getByText('2028/10/31')).toBeInTheDocument();
    expect(within(paid).getByText('كرتون')).toBeInTheDocument();
    // Source quantity 2 is paid; bonus 1 must not inflate purchase/retail totals.
    expect(within(paid).getByText('2')).toBeInTheDocument();
    expect(within(paid).getByText('66')).toBeInTheDocument();
    expect(within(paid).getByText('60')).toBeInTheDocument();
    expect(within(paid).getByText('100')).toBeInTheDocument();
    expect(within(second).getByText('LOT-8-EXP-32')).toBeInTheDocument();
    expect(within(second).getByText('علبة')).toBeInTheDocument();
    expect(within(second).getByText('19')).toBeInTheDocument();

    const subtotal = within(dialog).getByText('إجمالي السطور المسجلة').closest('tr')!;
    expect(within(subtotal).getByText('86')).toBeInTheDocument();
    expect(within(subtotal).getByText('79')).toBeInTheDocument();
    expect(within(subtotal).getByText('135')).toBeInTheDocument();
    const reconciliation = within(dialog).getByText('تسوية الفاتورة (ضريبة/خصم/مصروفات)').closest('tr')!;
    expect(within(reconciliation).getByText('6')).toBeInTheDocument();
    expect(within(dialog).getByText('85 ج.م')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق تفاصيل أصناف فاتورة المشتريات' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects a denied source detail read, does not display mismatched lots, then retries that same invoice', async () => {
    (getPurchaseInvoiceDetailsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic invoice source scope denied' })
      .mockResolvedValueOnce({ success: true, data: receiptLots });
    render(<PurchasesReportsClient userRole="owner" />);
    await screen.findByText('Source Supplier A');
    fireEvent.click(sourceRow('Source Supplier A'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Synthetic invoice source scope denied'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic Paid Lot')).not.toBeInTheDocument();

    fireEvent.click(sourceRow('Source Supplier A'));
    const dialog = await screen.findByRole('dialog', { name: /أصناف الفاتورة/ });
    expect(await within(dialog).findByText('Synthetic Paid Lot')).toBeInTheDocument();
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenNthCalledWith(
      1, sourceInvoice.id, { reportScope: true },
    );
    expect(getPurchaseInvoiceDetailsAction).toHaveBeenNthCalledWith(
      2, sourceInvoice.id, { reportScope: true },
    );
  });

  it('hides previously acknowledged supplier and valued totals when a refined read is denied, then recovers', async () => {
    (getPurchasesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [sourceInvoice] })
      .mockResolvedValueOnce({ success: false, error: 'Synthetic native scoped-purchase read refused' })
      .mockResolvedValueOnce({ success: true, data: [otherInvoice] });
    render(<PurchasesReportsClient userRole="owner" />);
    expect(await screen.findByText('Source Supplier A')).toBeInTheDocument();
    const first = sourceRow('Source Supplier A');
    expect(within(first).getByText('92')).toBeInTheDocument();
    expect(within(first).getByText('85')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'PINV-8-B' } });
    fireEvent.click(searchButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Synthetic native scoped-purchase read refused'));
    expect(await screen.findByText('تعذر تحميل تقرير المشتريات. القيم المالية غير متاحة حتى تنجح إعادة المحاولة.')).toBeInTheDocument();
    expect(screen.queryByText('Source Supplier A')).not.toBeInTheDocument();
    expect(screen.queryByText('Source Supplier B')).not.toBeInTheDocument();
    expect(screen.queryByText('85')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المشتريات' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المشتريات إلى Excel' })).toBeDisabled();

    fireEvent.click(searchButton());
    expect(await screen.findByText('Source Supplier B')).toBeInTheDocument();
    expect(screen.queryByText('Source Supplier A')).not.toBeInTheDocument();
    expect(getPurchasesReportsAction).toHaveBeenCalledTimes(3);
    expect(getPurchasesReportsAction).toHaveBeenLastCalledWith(expect.objectContaining({ invoiceNumber: 'PINV-8-B' }));
    expect(within(sourceRow('Source Supplier B')).getAllByText('30')).toHaveLength(2);
    expect(getPurchaseInvoiceDetailsAction).not.toHaveBeenCalled();
  });

  it('survives missing buyer/supplier filter metadata while preserving source read and a later explicit search', async () => {
    (getStaffAction as jest.Mock).mockRejectedValueOnce(new Error('Synthetic staff directory unavailable'));
    (getSuppliersAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'Synthetic supplier directory denied' });
    render(<PurchasesReportsClient userRole="owner" />);
    expect(await screen.findByText('Source Supplier A')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('تعذر تحميل بعض فلاتر تقرير المشتريات');
    expect(screen.queryByRole('option', { name: 'مورد المصدر الأول' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Buyer Eight' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'طريقة الدفع' }), { target: { value: 'credit' } });
    fireEvent.click(searchButton());
    await waitFor(() => expect(getPurchasesReportsAction).toHaveBeenLastCalledWith(expect.objectContaining({
      supplierId: undefined, userId: undefined, paymentMethod: 'credit',
    })));
    expect(screen.getByText('Source Supplier A')).toBeInTheDocument();
  });
});
