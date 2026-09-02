import React from 'react';
import { render, waitFor } from '@testing-library/react';
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
jest.mock('@/components/receipts/ReceiptListClient', () => function ReceiptListStub() {
  return <div data-testid="receipt-list" />;
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
      expect.stringContaining('WHERE si.shift_id = ?'),
      ['shift-a'],
    ));

    currentShiftId = 'shift-b';
    view.rerender(<ReceiptsPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(
      expect.stringContaining('WHERE si.shift_id = ?'),
      ['shift-b'],
    ));
  });
});
