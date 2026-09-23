import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DrugSyncButton from '@/components/dashboard/DrugSyncButton';
import InteractionsSyncButton from '@/components/dashboard/InteractionsSyncButton';
import { syncFromCloud } from '@/lib/sync/universal';
import { secureCache } from '@/lib/cache/secure_cache';
import { dbExecute, dbGet } from '@/lib/db/tauri';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { toast } from 'react-hot-toast';

const refresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

jest.mock('@/lib/sync/universal', () => ({
  syncFromCloud: jest.fn(),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { reload: jest.fn() },
}));

jest.mock('@/lib/db/tauri', () => ({
  dbExecute: jest.fn(),
  dbGet: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({
  getSupabaseBrowserClient: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

function interactionQuery(result: { data: any[] | null; error: any }) {
  const query: any = {};
  query.select = jest.fn(() => query);
  query.gt = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.range = jest.fn(async () => result);
  return query;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('active dashboard sync controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (secureCache.reload as jest.Mock).mockResolvedValue(undefined);
    (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1 });
    (dbGet as jest.Mock).mockResolvedValue(null);
  });

  it('blocks duplicate drug-sync clicks while pending and restores the control on a returned failure', async () => {
    let resolveSync: (value: { success: boolean; error?: string }) => void = () => {};
    (syncFromCloud as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveSync = resolve;
    }));

    render(<DrugSyncButton />);
    fireEvent.click(screen.getByRole('button', { name: 'تحديث قائمة الأدوية' }));

    const pending = screen.getByRole('button', { name: 'جاري التحديث...' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(syncFromCloud).toHaveBeenCalledTimes(1);

    resolveSync({ success: false, error: 'تعذر تحديث الدليل' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر تحديث الدليل'));
    expect(screen.getByRole('button', { name: 'تحديث قائمة الأدوية' })).toBeEnabled();
    expect(secureCache.reload).not.toHaveBeenCalled();
  });

  it('restores the drug-sync control after an unexpected rejection', async () => {
    (syncFromCloud as jest.Mock).mockRejectedValueOnce(new Error('cloud unavailable'));

    render(<DrugSyncButton />);
    fireEvent.click(screen.getByRole('button', { name: 'تحديث قائمة الأدوية' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('خطأ في الاتصال بالسحابة'));
    expect(screen.getByRole('button', { name: 'تحديث قائمة الأدوية' })).toBeEnabled();
  });

  it('does not advance the interaction watermark when the cloud fetch returns an error', async () => {
    const query = interactionQuery({ data: null, error: new Error('remote unavailable') });
    (getSupabaseBrowserClient as jest.Mock).mockReturnValue({
      from: jest.fn(() => query),
    });

    render(<InteractionsSyncButton />);
    fireEvent.click(screen.getByRole('button', { name: 'تحديث التفاعلات الدوائية' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل في جلب التفاعلات من السحابة'));
    expect(screen.getByRole('button', { name: 'تحديث التفاعلات الدوائية' })).toBeEnabled();
    expect((dbExecute as jest.Mock).mock.calls.some(([sql]) => String(sql).includes('INSERT OR REPLACE INTO sync_metadata'))).toBe(false);
  });

  it('writes cloud interactions before advancing the watermark and reports success', async () => {
    const first = interactionQuery({
      data: [{ drug_1: 'A', drug_2: 'B', interaction_description: 'AB warning' }],
      error: null,
    });
    const from = jest.fn(() => first);
    (getSupabaseBrowserClient as jest.Mock).mockReturnValue({ from });

    render(<InteractionsSyncButton />);
    fireEvent.click(screen.getByRole('button', { name: 'تحديث التفاعلات الدوائية' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تم تحديث التفاعلات بنجاح. 1 تفاعل جديد/محدث.'));

    const calls = (dbExecute as jest.Mock).mock.calls;
    const interactionWrite = calls.findIndex(([sql]) => String(sql).includes('INSERT INTO drug_interactions'));
    const watermarkWrite = calls.findIndex(([sql]) => String(sql).includes('INSERT OR REPLACE INTO sync_metadata'));
    expect(interactionWrite).toBeGreaterThanOrEqual(0);
    expect(watermarkWrite).toBeGreaterThan(interactionWrite);
    expect(String(calls[interactionWrite][0])).toContain('description_en = excluded.description_en');
    expect(calls[interactionWrite][1]).toEqual(['A', 'B', 'AB warning']);
    expect(screen.getByRole('button', { name: 'تحديث التفاعلات الدوائية' })).toBeEnabled();
  });

  it('blocks two same-tick drug-sync events before React can commit the disabled state', async () => {
    const pending = deferred<{ success: boolean; error?: string }>();
    (syncFromCloud as jest.Mock).mockReturnValue(pending.promise);

    render(<DrugSyncButton />);
    const button = screen.getByRole('button', { name: 'تحديث قائمة الأدوية' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(syncFromCloud).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'stop' });
      await pending.promise;
    });
  });

  it('does not run the delayed dashboard refresh after the drug-sync control unmounts', async () => {
    jest.useFakeTimers();
    try {
      (syncFromCloud as jest.Mock).mockResolvedValueOnce({ success: true, message: 'updated' });
      const view = render(<DrugSyncButton />);
      fireEvent.click(screen.getByRole('button', { name: 'تحديث قائمة الأدوية' }));

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(toast.success).toHaveBeenCalledWith('updated');

      view.unmount();
      act(() => {
        jest.advanceTimersByTime(1500);
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks two same-tick interaction-sync events before React can commit the disabled state', async () => {
    const pending = deferred<{ data: any[] | null; error: any }>();
    const query: any = {};
    query.select = jest.fn(() => query);
    query.gt = jest.fn(() => query);
    query.order = jest.fn(() => query);
    query.range = jest.fn(() => pending.promise);
    (getSupabaseBrowserClient as jest.Mock).mockReturnValue({ from: jest.fn(() => query) });

    render(<InteractionsSyncButton />);
    const button = screen.getByRole('button', { name: 'تحديث التفاعلات الدوائية' });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => expect(query.range).toHaveBeenCalled());
    expect(query.range).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ data: null, error: new Error('stop') });
      await pending.promise;
    });
  });
});
