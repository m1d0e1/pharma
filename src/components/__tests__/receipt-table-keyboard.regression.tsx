import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ReceiptListClient from '@/components/receipts/ReceiptListClient';
import { getConfigAction } from '@/app/actions-client/config';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/config', () => ({ getConfigAction: jest.fn() }));
jest.mock('@/lib/utils/printing', () => ({
  generateReceiptHtml: jest.fn(() => '<html>receipt</html>'),
  generateWhatsAppMessage: jest.fn(() => 'receipt message'),
  printHtmlContent: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

const invoice = {
  id: 'INV-KEYBOARD',
  total_amount: 50,
  created_at: '2026-09-22T08:00:00Z',
  profiles: { full_name: 'Admin' },
  patients: { full_name: 'Keyboard Receipt Customer', phone: '01000000000' },
  sales_items: [],
};

describe('receipt table keyboard interaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getConfigAction as jest.Mock).mockReturnValue(new Promise(() => {}));
  });

  it('opens receipt details from a focused row with Enter', async () => {
    render(<ReceiptListClient initialInvoices={[invoice as any]} />);

    const row = screen.getByText('Keyboard Receipt Customer').closest('tr') as HTMLTableRowElement;
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(await screen.findByRole('heading', { name: 'فاتورة مبيعات' })).toBeInTheDocument();
  });

  it('does not open receipt details when Enter originates from a nested row action', () => {
    render(<ReceiptListClient initialInvoices={[invoice as any]} />);

    fireEvent.keyDown(screen.getByTitle('طباعة'), { key: 'Enter' });

    expect(screen.queryByRole('heading', { name: 'فاتورة مبيعات' })).not.toBeInTheDocument();
  });
});
