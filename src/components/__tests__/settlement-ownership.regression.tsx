import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettlementClient from '@/components/sales/SettlementClient';
import { getDrugBatchesAction, getUnsettledSalesAction, settleSaleItemAction } from '@/app/actions-client/settlement';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/settlement', () => ({
  settleSaleItemAction: jest.fn(),
  getDrugBatchesAction: jest.fn(),
  getUnsettledSalesAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const unsettledItem = {
  item_id: 1,
  invoice_id: 'sale-1',
  drug_id: 1,
  trade_name: 'Unsettled Drug',
  quantity_sold: 1,
  unit_price: 10,
  unit: 'large',
  current_stock_balance: 2,
};

describe('settlement ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner', permissions: { can_manage_inventory: true } });
    (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => key === 'can_manage_inventory');
    (getDrugBatchesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'batch-1', expiry_date: '2027-01-01', quantity: 5, cost_price: 4 }],
    });
  });

  it('keeps the settlement modal open while persistence is pending', async () => {
    let resolveSettlement!: (value: { success: boolean; error?: string }) => void;
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveSettlement = resolve;
    });
    (settleSaleItemAction as jest.Mock).mockImplementation(() => pending);

    render(<SettlementClient initialItems={[unsettledItem]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تسوية الآن' }));
    fireEvent.click(await screen.findByRole('button', { name: /دفعة: batch-1/ }));
    await waitFor(() => expect(settleSaleItemAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    const stayedOpenWhilePending = screen.queryByText('اختيار دفعة التسوية') !== null;

    await act(async () => {
      resolveSettlement({ success: false, error: 'settlement failed' });
      await pending;
    });

    expect(stayedOpenWhilePending).toBe(true);
  });

  it('does not let an older pending read reintroduce a source after a newer verified empty refresh', async () => {
    let resolveOlder!: (value: { success: boolean; data?: any[] }) => void;
    let resolveNewer!: (value: { success: boolean; data?: any[] }) => void;
    const older = new Promise<{ success: boolean; data?: any[] }>(resolve => { resolveOlder = resolve; });
    const newer = new Promise<{ success: boolean; data?: any[] }>(resolve => { resolveNewer = resolve; });
    (getUnsettledSalesAction as jest.Mock)
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    render(<SettlementClient initialItems={[unsettledItem]} />);
    await screen.findByRole('button', { name: 'تسوية الآن' });
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getUnsettledSalesAction).toHaveBeenCalledTimes(1));
    // The previous test tried to commit while ownership/provenance was still
    // unverified. A pending strict-native read must disable stale write controls.
    expect(screen.getByRole('button', { name: 'تسوية الآن' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'تسوية الآن' }));
    expect(getDrugBatchesAction).not.toHaveBeenCalled();
    expect(settleSaleItemAction).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(getUnsettledSalesAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({ success: true, data: [] });
      await newer;
    });
    expect(screen.queryByText('Unsettled Drug')).not.toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: true, data: [unsettledItem] });
      await older;
    });
    expect(screen.queryByText('Unsettled Drug')).not.toBeInTheDocument();
    expect(settleSaleItemAction).not.toHaveBeenCalled();
  });
});
