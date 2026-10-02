import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReceiptDetailsModal from '@/components/receipts/ReceiptDetailsModal';
import { getConfigAction } from '@/app/actions-client/config';
import { generateReceiptHtml, printHtmlContent } from '@/lib/utils/printing';
import toast from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/config', () => ({ getConfigAction: jest.fn() }));
jest.mock('@/lib/utils/printing', () => ({
  calculateReceiptTotals: (invoice: any) => {
    const subtotal = invoice.sales_items?.reduce((sum: number, item: any) => sum + item.quantity_sold * item.unit_price, 0) || 0;
    const discount = Number.isFinite(Number(invoice.discount_amount))
      ? Math.max(0, Number(invoice.discount_amount))
      : Math.max(0, subtotal - invoice.total_amount);
    const additionalFees = Number.isFinite(Number(invoice.additional_fees))
      ? Math.max(0, Number(invoice.additional_fees))
      : Math.max(0, invoice.total_amount - subtotal + discount);
    return { subtotal, discount, additionalFees };
  },
  generateReceiptHtml: jest.fn(() => '<html>receipt</html>'),
  generateWhatsAppMessage: jest.fn(() => 'receipt message'),
  printHtmlContent: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}));

const invoice = {
  id: 'INV-DETAIL-PRINT',
  total_amount: 50,
  created_at: '2026-09-20T12:00:00Z',
  profiles: { full_name: 'Admin' },
  patients: { full_name: 'Receipt Customer', phone: '01000000000' },
  sales_items: [],
  payment_method: 'cash',
};

describe('ReceiptDetailsModal interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getConfigAction as jest.Mock).mockResolvedValue({ value: '' });
  });

  it('surfaces thermal-print failures without escaping the receipt modal action', async () => {
    (generateReceiptHtml as jest.Mock).mockImplementationOnce(() => {
      throw new Error('receipt print generation failed');
    });

    render(<ReceiptDetailsModal invoice={invoice as any} onClose={jest.fn()} />);
    await waitFor(() => expect(getConfigAction).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: /طباعة حرارية/ }));

    expect(toast.error).toHaveBeenCalledWith('فشلت عملية الطباعة');
    expect(printHtmlContent).not.toHaveBeenCalled();
  });

  it('does not auto-print after the receipt modal unmounts while config loading is pending', async () => {
    let resolveConfig: (value: { value: string }) => void = () => {};
    const pendingConfig = new Promise<{ value: string }>(resolve => {
      resolveConfig = resolve;
    });
    (getConfigAction as jest.Mock).mockReturnValue(pendingConfig);

    const view = render(<ReceiptDetailsModal invoice={invoice as any} onClose={jest.fn()} autoPrint />);
    await waitFor(() => expect(getConfigAction).toHaveBeenCalledTimes(3));
    view.unmount();

    await act(async () => {
      resolveConfig({ value: '' });
      await pendingConfig;
    });

    expect(printHtmlContent).not.toHaveBeenCalled();
  });

  it.each([
    ['wallet', 'محفظة (Wallet)'],
    ['check', 'شيك (Check)'],
    ['delivery', 'توصيل (Delivery)'],
  ])('shows an explicit %s payment-method label', async (paymentMethod, expectedLabel) => {
    render(<ReceiptDetailsModal invoice={{ ...invoice, payment_method: paymentMethod } as any} onClose={jest.fn()} />);
    await waitFor(() => expect(getConfigAction).toHaveBeenCalledTimes(3));
    const dialog = screen.getByRole('dialog', { name: 'فاتورة مبيعات' });
    expect(dialog).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(screen.getByText('طريقة الدفع')).toHaveClass('text-xs');
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
  });

  it('shows invoice discount and additional fees as separate receipt adjustments', async () => {
    render(<ReceiptDetailsModal invoice={{
      ...invoice,
      total_amount: 95,
      discount_amount: 10,
      additional_fees: 5,
      sales_items: [{ quantity_sold: 2, unit_price: 50 }],
    } as any} onClose={jest.fn()} />);
    await waitFor(() => expect(getConfigAction).toHaveBeenCalledTimes(3));

    expect(screen.getByText('المجموع الفرعي:')).toHaveClass('text-xs');
    expect(screen.getByText('إجمالي الخصم:').parentElement).toHaveClass('text-xs');
    expect(screen.getByText('رسوم إضافية:').parentElement).toHaveClass('text-xs');
    expect(screen.getByText('-10.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText('+5.00 ج.م')).toBeInTheDocument();
  });

  it('shows loyalty redemption as a component of the persisted invoice discount', async () => {
    render(<ReceiptDetailsModal invoice={{
      ...invoice,
      total_amount: 90,
      discount_amount: 10,
      points_redeemed: 100,
      loyalty_discount_amount: 10,
      sales_items: [{ quantity_sold: 1, unit_price: 100 }],
    } as any} onClose={jest.fn()} />);
    await waitFor(() => expect(getConfigAction).toHaveBeenCalledTimes(3));

    expect(screen.getByText('إجمالي الخصم:')).toBeInTheDocument();
    expect(screen.getByText('منه خصم نقاط الولاء (100 نقطة):').parentElement).toHaveClass('text-xs');
    expect(screen.getAllByText('-10.00 ج.م')).toHaveLength(2);
  });
});
