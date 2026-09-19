import { render, waitFor } from '@testing-library/react';
import ReceiptsPage from '@/app/(dashboard)/receipts/page';
import { dbSelect } from '@/lib/db/tauri';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({ id: 'user-1', role: 'admin', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
}));

jest.mock('@/components/receipts/ReceiptListClient', () => ({
  __esModule: true,
  default: () => <div>receipts-loaded</div>,
}));

describe('receipts page pharmacy scope', () => {
  it('scopes the receipt list query to the signed-in pharmacy', async () => {
    render(<ReceiptsPage />);

    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    const [sql, params] = (dbSelect as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain('si.pharmacy_id = ?');
    expect(params).toEqual(['ph-1', 'ph-1']);
  });
});
