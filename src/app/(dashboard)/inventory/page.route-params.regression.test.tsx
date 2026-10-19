import { act, render, screen, waitFor } from '@testing-library/react';
import InventoryPage from '@/app/(dashboard)/inventory/page';
import { getInventoryListAction } from '@/app/actions-client/inventory';

let mockParams = new URLSearchParams('drugId=17');

jest.mock('next/navigation', () => ({ useSearchParams: () => mockParams }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'reader-a', pharmacy_id: 'ph-a' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/inventory', () => ({ getInventoryListAction: jest.fn() }));
jest.mock('@/components/InventoryClientWrapper', () => () => null);
jest.mock('@/components/inventory/InventoryTable', () => function MockInventoryTable({ items, searchTerm }: any) {
  return <div data-testid="inventory-contents">search:{searchTerm}, lots:{items.map((item: any) => item.id).join(',')}</div>;
});

describe('same-route inventory URL query navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = new URLSearchParams('drugId=17');
    (getInventoryListAction as jest.Mock).mockImplementation(async (search: string, drugId?: number) => ({
      success: true,
      data: [{ id: drugId ? `lot-drug-${drugId}` : `search-${search}` }],
    }));
  });

  it('refetches the new scoped drug after navigating between inventory URLs without remounting the tab', async () => {
    const page = render(<InventoryPage />);
    expect(await screen.findByTestId('inventory-contents')).toHaveTextContent('lot-drug-17');
    expect(getInventoryListAction).toHaveBeenLastCalledWith('', 17);

    mockParams = new URLSearchParams('drugId=21');
    page.rerender(<InventoryPage />);
    await waitFor(() => expect(getInventoryListAction).toHaveBeenLastCalledWith('', 21));
    expect(await screen.findByTestId('inventory-contents')).toHaveTextContent('lot-drug-21');
    expect(getInventoryListAction).toHaveBeenCalledTimes(2);
  });

  it('clears an old drug filter when following a same-route search URL, and updates it on further URL changes', async () => {
    const page = render(<InventoryPage />);
    await waitFor(() => expect(getInventoryListAction).toHaveBeenLastCalledWith('', 17));

    mockParams = new URLSearchParams('search=aspirin');
    await act(async () => { page.rerender(<InventoryPage />); });
    await waitFor(() => expect(getInventoryListAction).toHaveBeenLastCalledWith('aspirin', undefined));
    expect(await screen.findByTestId('inventory-contents')).toHaveTextContent('search-aspirin');

    mockParams = new URLSearchParams('search=ibuprofen');
    await act(async () => { page.rerender(<InventoryPage />); });
    await waitFor(() => expect(getInventoryListAction).toHaveBeenLastCalledWith('ibuprofen', undefined));
    expect(await screen.findByTestId('inventory-contents')).toHaveTextContent('search-ibuprofen');
  });
});
