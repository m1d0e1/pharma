import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LowStockPage from '@/app/(dashboard)/inventory/low-stock/page';
import InventorySettlementPage from '@/app/(dashboard)/inventory/settlement/page';
import InventoryPage from '@/app/(dashboard)/inventory/page';
import CogsAdjustmentPage from '@/app/(dashboard)/sales/cogs/page';
import DeliveryPage from '@/app/(dashboard)/sales/delivery/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getInventoryListAction, getLowStockAction } from '@/app/actions-client/inventory';
import { getUnsettledSalesAction } from '@/app/actions-client/settlement';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('drugId=17'),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/inventory', () => ({
  getInventoryListAction: jest.fn(),
  getLowStockAction: jest.fn(),
}));
jest.mock('@/app/actions-client/settlement', () => ({ getUnsettledSalesAction: jest.fn() }));
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() { return <div>access-denied</div>; });
jest.mock('@/app/(dashboard)/inventory/low-stock/LowStockClient', () => function MockLowStockClient({ initialItems }: any) {
  return <div>low-stock:{initialItems.map((item: any) => item.id).join(',')}</div>;
});
jest.mock('@/components/sales/SettlementClient', () => function MockSettlementClient({ initialItems }: any) {
  return <div>settlement:{initialItems.map((item: any) => item.id).join(',')}</div>;
});
jest.mock('@/components/inventory/InventoryTable', () => function MockInventoryTable({ items, searchTerm, onRefresh }: any) {
  return <div>inventory:{searchTerm}:{items.map((item: any) => item.id).join(',')}<button onClick={onRefresh}>mock inventory refresh</button></div>;
});
jest.mock('@/components/InventoryClientWrapper', () => function MockInventoryClientWrapper() { return <div>inventory-actions</div>; });
jest.mock('@/components/sales/CogsAdjustmentClient', () => function MockCogsAdjustmentClient() { return <div>cogs-client</div>; });
jest.mock('@/components/sales/DeliveryManagementClient', () => function MockDeliveryManagementClient() { return <div>delivery-client</div>; });

const owner = {
  id: 'owner-1',
  role: 'owner',
  pharmacy_id: 'ph-1',
  permissions: {
    can_view_low_stock: true,
    can_view_settlement: true,
    can_view_delivery: true,
    can_manage_inventory: true,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue(owner);
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
  (getLowStockAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (getUnsettledSalesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (getInventoryListAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
});

it('distinguishes a failed low-stock load from a legitimate empty list and retries', async () => {
  (getLowStockAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'low-stock unavailable' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'low-recovered' }] });

  render(<LowStockPage />);

  expect(await screen.findByText('تعذر تحميل بيانات النواقص')).toBeInTheDocument();
  expect(screen.queryByText('low-stock:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('low-stock:low-recovered')).toBeInTheDocument();
});

it('distinguishes a failed settlement load from a legitimate empty settlement queue and retries', async () => {
  (getUnsettledSalesAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'settlement unavailable' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'settlement-recovered' }] });

  render(<InventorySettlementPage />);

  expect(await screen.findByText('تعذر تحميل بيانات التسوية')).toBeInTheDocument();
  expect(screen.queryByText('settlement:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('settlement:settlement-recovered')).toBeInTheDocument();
});

it('shows a retryable inventory load error and preserves the requested drug context', async () => {
  (getInventoryListAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'inventory unavailable' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'inventory-recovered' }] });

  render(<InventoryPage />);

  expect(await screen.findByText('تعذر تحميل بيانات المخزون')).toBeInTheDocument();
  expect(screen.queryByText(/^inventory:/)).not.toBeInTheDocument();
  expect(getInventoryListAction).toHaveBeenCalledWith('', 17);
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('inventory::inventory-recovered')).toBeInTheDocument();
  await waitFor(() => expect(getInventoryListAction).toHaveBeenLastCalledWith('', 17));
});

it('keeps the last valid inventory visible when a later refresh fails, then retries in place', async () => {
  (getInventoryListAction as jest.Mock)
    .mockResolvedValueOnce({ success: true, data: [{ id: 'inventory-old' }] })
    .mockResolvedValueOnce({ success: false, error: 'refresh unavailable' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'inventory-new' }] });

  render(<InventoryPage />);
  expect(await screen.findByText(/inventory::inventory-old/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'mock inventory refresh' }));

  expect(await screen.findByText('تعذر تحديث بيانات المخزون')).toBeInTheDocument();
  expect(screen.getByText(/inventory::inventory-old/)).toBeInTheDocument();
  expect(screen.queryByText('تعذر تحميل بيانات المخزون')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل المخزون' }));
  expect(await screen.findByText(/inventory::inventory-new/)).toBeInTheDocument();
  expect(getInventoryListAction).toHaveBeenCalledTimes(3);
});

it('shows a retryable COGS session error instead of false permission denial', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<CogsAdjustmentPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  expect(screen.queryByText('access-denied')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('cogs-client')).toBeInTheDocument();
});

it('shows a retryable delivery session error instead of false permission denial', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);

  render(<DeliveryPage />);

  expect(await screen.findByText('تعذر التحقق من جلسة المستخدم')).toBeInTheDocument();
  expect(screen.queryByText('access-denied')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('delivery-client')).toBeInTheDocument();
});
