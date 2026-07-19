import { render, waitFor } from '@testing-library/react';
import ReceiptDetailsModal from '@/components/receipts/ReceiptDetailsModal';
import { generateReceiptHtml, printHtmlContent } from '@/lib/utils/printing';

jest.mock('@/app/actions-client/config', () => ({
  getConfigAction: jest.fn(async () => ({ value: '' })),
}));
jest.mock('@/lib/utils/printing', () => ({
  generateReceiptHtml: jest.fn(() => '<html>receipt</html>'),
  generateWhatsAppMessage: jest.fn(),
  printHtmlContent: jest.fn(),
}));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));

test('auto-prints a completed POS receipt once', async () => {
  render(<ReceiptDetailsModal autoPrint invoice={{
    id: 'sale-1', total_amount: 69, created_at: '2026-07-19T12:00:00Z',
    profiles: { full_name: 'Admin' }, patients: null, sales_items: [], payment_method: 'cash',
  }} onClose={() => {}} />);

  await waitFor(() => expect(printHtmlContent).toHaveBeenCalledWith('<html>receipt</html>'));
  expect(generateReceiptHtml).toHaveBeenCalledTimes(1);
  expect(printHtmlContent).toHaveBeenCalledTimes(1);
});
