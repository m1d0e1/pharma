import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettlementClient from '@/components/sales/SettlementClient';
import { getDrugBatchesAction, getUnsettledSalesAction, settleSaleItemAction } from '@/app/actions-client/settlement';
import { getClientSession } from '@/lib/auth/local';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn((_user: unknown, key: string) => key === 'can_manage_inventory'),
}));
jest.mock('@/app/actions-client/settlement', () => ({
  getDrugBatchesAction: jest.fn(),
  getUnsettledSalesAction: jest.fn(),
  settleSaleItemAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const oldItem = {
  item_id: 17,
  invoice_id: 'OWNED-SALE-BEFORE-NATIVE-READ-DENIAL',
  drug_id: 74,
  trade_name: 'Previously Visible Stock',
  quantity_sold: 2,
  net_unreturned_quantity: 2,
  unit_price: 20,
  unit: 'large',
  current_stock_balance: 3,
};

describe('negative-stock settlement fail-closed refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'manager', permissions: { can_manage_inventory: true } });
    (getDrugBatchesAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 'previous-lot', quantity: 3, cost_price: 6 }] });
  });

  it('revokes cached settlement source and forbids a batch write when the strict native read is denied', async () => {
    let resolveRead!: (value: unknown) => void;
    (getUnsettledSalesAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    render(<SettlementClient initialItems={[oldItem]} />);
    expect(screen.getByText('Previously Visible Stock')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getUnsettledSalesAction).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'تسوية الآن' })).toBeDisabled();
    expect(getDrugBatchesAction).not.toHaveBeenCalled();

    await act(async () => resolveRead({ success: false, error: 'Native strict SQL read blocked' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Native strict SQL read blocked');
    expect(screen.queryByRole('button', { name: 'تسوية الآن' })).not.toBeInTheDocument();
    expect(screen.queryByText('Previously Visible Stock')).not.toBeInTheDocument();
    expect(screen.queryByText('جميع المبيعات مرتبطة بأرصدة مخزنية صحيحة.')).not.toBeInTheDocument();
    expect(settleSaleItemAction).not.toHaveBeenCalled();
  });

  it('does not claim stock settled when an initial empty-source native read is unavailable', async () => {
    (getUnsettledSalesAction as jest.Mock).mockResolvedValueOnce({
      success: false, error: 'Unverified negative-stock source',
    });
    render(<SettlementClient initialItems={[]} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unverified negative-stock source');
    expect(screen.queryByText('جميع المبيعات مرتبطة بأرصدة مخزنية صحيحة.')).not.toBeInTheDocument();
    expect(settleSaleItemAction).not.toHaveBeenCalled();
  });

  it('restores eligible settlement only after a subsequent verified refresh', async () => {
    (getUnsettledSalesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Strict read denied' })
      .mockResolvedValueOnce({ success: true, data: [oldItem] });
    render(<SettlementClient initialItems={[]} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Strict read denied');
    fireEvent.click(screen.getByRole('button', { name: 'تحديث البيانات' }));
    expect(await screen.findByRole('button', { name: 'تسوية الآن' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(settleSaleItemAction).not.toHaveBeenCalled();
  });

  it('ignores an older source response after a newer refresh denies settlement eligibility', async () => {
    let resolveOlder!: (result: unknown) => void;
    let resolveNewer!: (result: unknown) => void;
    (getUnsettledSalesAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));
    render(<SettlementClient initialItems={[oldItem]} />);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getUnsettledSalesAction).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getUnsettledSalesAction).toHaveBeenCalledTimes(2));

    await act(async () => resolveNewer({ success: false, error: 'Current actor has no verified stock access' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Current actor has no verified stock access');
    expect(screen.queryByText('Previously Visible Stock')).not.toBeInTheDocument();

    await act(async () => resolveOlder({ success: true, data: [oldItem] }));
    expect(screen.getByRole('alert')).toHaveTextContent('Current actor has no verified stock access');
    expect(screen.queryByText('Previously Visible Stock')).not.toBeInTheDocument();
    expect(settleSaleItemAction).not.toHaveBeenCalled();
  });
});
