import { act, render, screen, waitFor } from '@testing-library/react';
import InventoryPage from '@/app/(dashboard)/inventory/page';
import { getInventoryListAction } from '@/app/actions-client/inventory';
import { getClientSession } from '@/lib/auth/local';
import { INVENTORY_CHANGED_EVENT } from '@/lib/inventory/refresh';

jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'reader', pharmacy_id: 'ph-a' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));
jest.mock('@/app/actions-client/inventory', () => ({ getInventoryListAction: jest.fn() }));
jest.mock('@/components/InventoryClientWrapper', () => () => null);
jest.mock('@/components/inventory/InventoryTable', () => function MockTable({ items }: any) {
  return <div data-testid="inventory-ids">{items.map((item: any) => item.id).join(',')}</div>;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('inventory tab heavy-read lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not start another full inventory scan just because the window focuses during its initial read', async () => {
    const initial = deferred<any>();
    (getInventoryListAction as jest.Mock)
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValue({ success: true, data: [{ id: 'redundant' }] });

    render(<InventoryPage />);
    await waitFor(() => expect(getInventoryListAction).toHaveBeenCalledTimes(1));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

    // The first scan is still pending. A focus event must not queue a
    // redundant identical scan while that initial snapshot is being fetched.
    await act(async () => { initial.resolve({ success: true, data: [{ id: 'initial' }] }); });
    expect(await screen.findByTestId('inventory-ids')).toHaveTextContent('initial');
    expect(getInventoryListAction).toHaveBeenCalledTimes(1);
  });

  it('serializes and coalesces burst inventory mutations while a slow read is outstanding', async () => {
    const initial = deferred<any>();
    const refresh = deferred<any>();
    let concurrent = 0;
    let peakConcurrent = 0;
    (getInventoryListAction as jest.Mock).mockImplementation(() => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      const pending = concurrent === 1 && (getInventoryListAction as jest.Mock).mock.calls.length === 1
        ? initial.promise
        : refresh.promise;
      return pending.finally(() => { concurrent -= 1; });
    });

    render(<InventoryPage />);
    await waitFor(() => expect(getInventoryListAction).toHaveBeenCalledTimes(1));
    act(() => { window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)); });
    act(() => { window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)); });
    act(() => { window.dispatchEvent(new Event(INVENTORY_CHANGED_EVENT)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(getInventoryListAction).toHaveBeenCalledTimes(1);
    expect(peakConcurrent).toBe(1);

    await act(async () => { initial.resolve({ success: true, data: [{ id: 'obsolete' }] }); });
    await waitFor(() => expect(getInventoryListAction).toHaveBeenCalledTimes(2));
    expect(peakConcurrent).toBe(1);
    await act(async () => { refresh.resolve({ success: true, data: [{ id: 'latest' }] }); });
    expect(await screen.findByTestId('inventory-ids')).toHaveTextContent('latest');
    expect(screen.queryByText('obsolete')).not.toBeInTheDocument();
    expect(getInventoryListAction).toHaveBeenCalledTimes(2);
  });

  it('does not launch an expensive inventory read after the tab unmounts while session lookup is pending', async () => {
    const session = deferred<any>();
    (getClientSession as jest.Mock).mockReturnValueOnce(session.promise);
    const page = render(<InventoryPage />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(1));

    page.unmount();
    await act(async () => {
      session.resolve({ id: 'reader', pharmacy_id: 'ph-a' });
    });
    expect(getInventoryListAction).not.toHaveBeenCalled();
  });
});
