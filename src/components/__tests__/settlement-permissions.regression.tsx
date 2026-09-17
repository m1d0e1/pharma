import { render, screen } from '@testing-library/react';
import SettlementClient from '@/components/sales/SettlementClient';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({
    id: 'viewer',
    role: 'pharmacist',
    permissions: { can_view_settlement: true, can_manage_inventory: false },
  })),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.permissions?.[key] === true),
}));

jest.mock('@/app/actions-client/settlement', () => ({
  settleSaleItemAction: jest.fn(),
  getDrugBatchesAction: jest.fn(),
  getUnsettledSalesAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

describe('settlement mutation controls', () => {
  it('keeps a view-only settlement user read-only', async () => {
    render(<SettlementClient initialItems={[{
      item_id: 1,
      invoice_id: 'sale-1',
      drug_id: 1,
      trade_name: 'Drug',
      quantity_sold: 1,
      unit_price: 10,
      unit: 'large',
      current_stock_balance: 2,
    }]} />);

    expect(await screen.findByText('عرض فقط')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تسوية الآن' })).not.toBeInTheDocument();
  });
});
