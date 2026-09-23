import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReceiptDetailsModal from '@/components/receipts/ReceiptDetailsModal';
import { getConfigAction } from '@/app/actions-client/config';
import { generateReceiptHtml, printHtmlContent } from '@/lib/utils/printing';
import toast from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/config', () => ({ getConfigAction: jest.fn() }));
jest.mock('@/lib/utils/printing', () => ({
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
});
