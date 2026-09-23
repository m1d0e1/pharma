import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReceiptsPage from '@/app/(dashboard)/receipts/page';
import { dbSelect } from '@/lib/db/tauri';

let currentShiftId: string | null = 'shift-a';

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => currentShiftId }),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/components/receipts/ReceiptListClient', () => function ReceiptListStub({ initialInvoices }: any) {
  return <div data-testid="receipt-list">{initialInvoices.map((invoice: any) => invoice.id).join(',')}</div>;
});
jest.mock('@/components/AccessDenied', () => function AccessDeniedStub() {
  return <div>denied</div>;
});

describe('receipts shift route', () => {
  beforeEach(() => {
    currentShiftId = 'shift-a';
    jest.clearAllMocks();
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => (
      sql.includes('FROM sales_invoices si') ? [] : []
    ));
  });

  it('reloads and scopes receipts when navigation changes the requested shift', async () => {
    const view = render(<ReceiptsPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining("si.status IN ('completed', 'approved', 'delivered')"),
      ['shift-a', 'local_default', 'local_default'],
    ));

    currentShiftId = 'shift-b';
    view.rerender(<ReceiptsPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining("si.status IN ('completed', 'approved', 'delivered')"),
      ['shift-b', 'local_default', 'local_default'],
    ));
  });

  it('keeps the newest shift receipt list when an older route query resolves later', async () => {
    let resolveOld!: (value: any[]) => void;
    (dbSelect as jest.Mock).mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('FROM sales_invoices si')) {
        if (params?.[0] === 'shift-a') {
          return new Promise<any[]>(resolve => { resolveOld = resolve; });
        }
        if (params?.[0] === 'shift-b') {
          return Promise.resolve([{
            id: 'receipt-new', total_amount: 50, paid_amount: 50,
            payment_method: 'cash', discount_amount: 0,
            created_at: '2026-09-22T10:00:00.000Z',
          }]);
        }
      }
      return Promise.resolve([]);
    });

    const view = render(<ReceiptsPage />);
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining('FROM sales_invoices si'),
      ['shift-a', 'local_default', 'local_default'],
    ));

    currentShiftId = 'shift-b';
    view.rerender(<ReceiptsPage />);
    expect(await screen.findByTestId('receipt-list')).toHaveTextContent('receipt-new');

    await act(async () => resolveOld([{
      id: 'receipt-old', total_amount: 80, paid_amount: 80,
      payment_method: 'cash', discount_amount: 0,
      created_at: '2026-09-21T10:00:00.000Z',
    }]));

    await waitFor(() => expect(screen.getByTestId('receipt-list')).toHaveTextContent('receipt-new'));
    expect(screen.getByTestId('receipt-list')).not.toHaveTextContent('receipt-old');
  });

  it('keeps drafts out of the unscoped receipt history', async () => {
    currentShiftId = null;
    render(<ReceiptsPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining("si.status IN ('completed', 'approved', 'delivered')"),
      ['local_default', 'local_default'],
    ));
  });

  it('distinguishes a receipt query failure from an empty history and retries', async () => {
    (dbSelect as jest.Mock)
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockImplementation(async (sql: string) => sql.includes('FROM sales_invoices si')
        ? [{
            id: 'receipt-recovered',
            total_amount: 40,
            paid_amount: 40,
            payment_method: 'cash',
            discount_amount: 0,
            created_at: '2026-09-21T10:00:00.000Z',
          }]
        : []);

    render(<ReceiptsPage />);

    expect(await screen.findByText('تعذر تحميل سجل الفواتير')).toBeInTheDocument();
    expect(screen.queryByTestId('receipt-list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(screen.getByTestId('receipt-list')).toHaveTextContent('receipt-recovered'));
  });
});
