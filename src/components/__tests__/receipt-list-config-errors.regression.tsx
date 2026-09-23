import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ReceiptListClient from '@/components/receipts/ReceiptListClient';
import { getConfigAction } from '@/app/actions-client/config';
import { generateReceiptHtml, printHtmlContent } from '@/lib/utils/printing';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/config', () => ({
  getConfigAction: jest.fn(),
}));

jest.mock('@/lib/utils/printing', () => ({
  generateReceiptHtml: jest.fn(() => '<html>receipt</html>'),
  generateWhatsAppMessage: jest.fn(() => 'receipt message'),
  printHtmlContent: jest.fn(),
}));

jest.mock('@/components/receipts/ReceiptDetailsModal', () => ({
  __esModule: true,
  default: ({ invoice }: any) => <div>receipt-details:{invoice.id}</div>,
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const invoice = {
  id: 'INV-CONFIG-FAILURE',
  total_amount: 50,
  created_at: '2026-09-20T12:00:00Z',
  profiles: { full_name: 'Admin' },
  patients: { full_name: 'Fallback Customer', phone: '01000000000' },
  sales_items: [],
};

describe('ReceiptListClient config loading failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps fallback receipt actions usable when pharmacy config loading rejects', async () => {
    (getConfigAction as jest.Mock).mockRejectedValue(new Error('config bridge unavailable'));

    render(<ReceiptListClient initialInvoices={[invoice]} />);
    expect(await screen.findByText('Fallback Customer')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('طباعة'));

    expect(generateReceiptHtml).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'INV-CONFIG-FAILURE' }),
      { name: 'صيدلية فارما تيك', phone: '', address: '' },
    );
    expect(printHtmlContent).toHaveBeenCalledWith('<html>receipt</html>');
  });

  it('surfaces direct-print failures instead of throwing out of the receipt row action', async () => {
    (getConfigAction as jest.Mock).mockResolvedValue({ value: '' });
    (generateReceiptHtml as jest.Mock).mockImplementationOnce(() => {
      throw new Error('print generation failed');
    });

    render(<ReceiptListClient initialInvoices={[invoice]} />);
    expect(await screen.findByText('Fallback Customer')).toBeInTheDocument();

    expect(() => fireEvent.click(screen.getByTitle('طباعة'))).not.toThrow();
    expect(toast.error).toHaveBeenCalledWith('فشلت عملية الطباعة');
    expect(printHtmlContent).not.toHaveBeenCalled();
  });

  it('closes receipt details when refreshed route data no longer owns the selected invoice', async () => {
    (getConfigAction as jest.Mock).mockResolvedValue({ value: '' });
    const view = render(<ReceiptListClient initialInvoices={[invoice]} />);
    expect(await screen.findByText('Fallback Customer')).toBeInTheDocument();

    fireEvent.click(screen.getByText('#INV-CONF'));
    expect(screen.getByText('receipt-details:INV-CONFIG-FAILURE')).toBeInTheDocument();

    view.rerender(<ReceiptListClient initialInvoices={[{
      ...invoice,
      id: 'INV-NEW-SHIFT',
      patients: { full_name: 'New Shift Customer', phone: '01111111111' },
    }]} />);

    expect(screen.queryByText('receipt-details:INV-CONFIG-FAILURE')).not.toBeInTheDocument();
    expect(screen.getByText('New Shift Customer')).toBeInTheDocument();
  });
});
