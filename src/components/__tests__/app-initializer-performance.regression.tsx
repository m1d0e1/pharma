import { render, screen, waitFor } from '@testing-library/react';
import AppInitializer from '@/components/AppInitializer';
import { secureCache } from '@/lib/cache/secure_cache';
import { migrateLegacyPlaceholderInventoryScope } from '@/lib/inventory/placeholder-migration';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { toast } from 'react-hot-toast';

let mockPathname = '/login';
const mockGetLocalSession = jest.fn();

jest.mock('next/navigation', () => ({ usePathname: () => mockPathname }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/auth/local', () => ({ getLocalSession: (...args: unknown[]) => mockGetLocalSession(...args) }));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(() => new Promise<void>(() => {})),
    reload: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/inventory/placeholder-migration', () => ({
  migrateLegacyPlaceholderInventoryScope: jest.fn(),
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn() } }));
jest.mock('@/lib/db/tauri', () => ({ dbExecute: jest.fn(async () => ({ rowsAffected: 0 })) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/login';
  mockGetLocalSession.mockResolvedValue({ id: 'owner' });
  (secureCache.load as jest.Mock).mockImplementation(() => new Promise<void>(() => {}));
  (secureCache.reload as jest.Mock).mockResolvedValue(undefined);
  (migrateLegacyPlaceholderInventoryScope as jest.Mock).mockResolvedValue({ changed: false, affectedItems: [] });
});

it('renders a new window without waiting for the master-drug cache', async () => {
  render(
    <AppInitializer>
      <div>window content</div>
    </AppInitializer>
  );

  expect(screen.getByText('window content')).toBeInTheDocument();
  await waitFor(() => expect(secureCache.load).toHaveBeenCalledTimes(1));
});

it('skips startup repair while logged out and initializes after login navigation', async () => {
  mockGetLocalSession.mockResolvedValueOnce(null).mockResolvedValue({ id: 'owner' });
  (secureCache.load as jest.Mock).mockResolvedValue(undefined);
  const { rerender } = render(<AppInitializer><div>window content</div></AppInitializer>);

  await waitFor(() => expect(mockGetLocalSession).toHaveBeenCalledTimes(1));
  expect(secureCache.load).not.toHaveBeenCalled();
  expect(migrateLegacyPlaceholderInventoryScope).not.toHaveBeenCalled();

  mockPathname = '/';
  rerender(<AppInitializer><div>window content</div></AppInitializer>);

  await waitFor(() => expect(migrateLegacyPlaceholderInventoryScope).toHaveBeenCalledTimes(1));
  expect(secureCache.load).toHaveBeenCalledTimes(1);
});

it('does not attempt legacy local_default inventory reassignment for an explicitly owned tenant', async () => {
  mockGetLocalSession.mockResolvedValue({ id: 'owner-qa', role: 'owner', pharmacy_id: 'qa_lifecycle_20261016' });
  (secureCache.load as jest.Mock).mockResolvedValue(undefined);
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const { rerender } = render(<AppInitializer><div>QA dashboard</div></AppInitializer>);
    await waitFor(() => expect(secureCache.load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('QA dashboard')).toBeInTheDocument());
    mockPathname = '/inventory';
    rerender(<AppInitializer><div>QA inventory</div></AppInitializer>);
    expect(migrateLegacyPlaceholderInventoryScope).not.toHaveBeenCalled();
    expect(secureCache.reload).not.toHaveBeenCalled();
    expect(notifyInventoryChanged).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalledWith('App initialization repair failed', expect.anything());
  } finally { errorLog.mockRestore(); }
});

it('retries failed startup repair on subsequent navigation without blocking the window', async () => {
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  (secureCache.load as jest.Mock).mockResolvedValue(undefined);
  (migrateLegacyPlaceholderInventoryScope as jest.Mock).mockRejectedValueOnce(new Error('repair interrupted'));
  try {
    const { rerender } = render(<AppInitializer><div>window content</div></AppInitializer>);
    expect(screen.getByText('window content')).toBeInTheDocument();
    await waitFor(() => expect(errorLog).toHaveBeenCalledWith('App initialization repair failed', expect.any(Error)));

    mockPathname = '/inventory';
    rerender(<AppInitializer><div>window content</div></AppInitializer>);
    await waitFor(() => expect(migrateLegacyPlaceholderInventoryScope).toHaveBeenCalledTimes(2));
    expect(secureCache.load).toHaveBeenCalledTimes(2);
    expect(notifyInventoryChanged).not.toHaveBeenCalled();
  } finally {
    errorLog.mockRestore();
  }
});

it('reloads cache, refreshes inventory listeners, and shows the restored-items toast after startup healing', async () => {
  (secureCache.load as jest.Mock).mockResolvedValue(undefined);
  (migrateLegacyPlaceholderInventoryScope as jest.Mock).mockResolvedValue({
    changed: true,
    migratedRows: 2,
    barcodeRowsUpdated: 2,
    affectedItems: [
      { id: 'legacy-1', drug_id: 1319, trade_name: 'Antodine 40 legacy', quantity: 1.3333333337, barcode: '6221025003843' },
      { id: 'legacy-2', drug_id: 2000, trade_name: 'LAMIFEN', quantity: 4, barcode: null },
    ],
  });

  render(
    <AppInitializer>
      <div>window content</div>
    </AppInitializer>
  );

  await waitFor(() => expect(migrateLegacyPlaceholderInventoryScope).toHaveBeenCalledTimes(1));
  expect(secureCache.reload).toHaveBeenCalledTimes(1);
  expect(notifyInventoryChanged).toHaveBeenCalledTimes(1);
  expect(toast.success).toHaveBeenCalledWith(expect.any(Function), {
    duration: 10000,
    position: 'top-center',
  });
  const notificationRenderer = (toast.success as jest.Mock).mock.calls[0][0];
  render(notificationRenderer());
  expect(screen.getByText('📦 تم استعادة وتنشيط 2 صنفاً في المخزون')).toBeInTheDocument();
  expect(screen.getByText(/Antodine 40 legacy/)).toBeInTheDocument();
  expect(screen.getByText(/LAMIFEN/)).toBeInTheDocument();
});
