import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TrialBalanceReport from '@/components/reports/TrialBalanceReport';
import { getTrialBalanceAction } from '@/app/actions-client/finance';

jest.mock('@/app/actions-client/finance', () => ({
  getTrialBalanceAction: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function row(name: string) {
  return [{
    id: name,
    code: name,
    name_ar: name,
    name_en: name,
    is_group: 0,
    type: 'asset',
    net_debit: 0,
    net_credit: 0,
    period_debit: 0,
    period_credit: 0,
  }];
}

describe('coverage gap: trial balance load errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('distinguishes a returned report failure from a legitimate empty result and retries', async () => {
    (getTrialBalanceAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'trial balance unavailable' })
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<TrialBalanceReport userRole="owner" />);

    expect(await screen.findByText('تعذر تحميل ميزان المراجعة')).toBeInTheDocument();
    expect(screen.getByText('trial balance unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/لا توجد حركات مسجلة/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    await waitFor(() => expect(getTrialBalanceAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('لا توجد حركات مسجلة للفترة المحددة')).toBeInTheDocument();
  });

  it('recovers from a thrown report load without leaving the table spinner stuck', async () => {
    (getTrialBalanceAction as jest.Mock)
      .mockRejectedValueOnce(new Error('trial balance bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<TrialBalanceReport userRole="owner" />);

    expect(await screen.findByText('تعذر تحميل ميزان المراجعة')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('لا توجد حركات مسجلة للفترة المحددة')).toBeInTheDocument();
  });

  it('keeps edited date inputs local until the explicit Apply action', async () => {
    (getTrialBalanceAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    render(<TrialBalanceReport userRole="owner" />);
    await waitFor(() => expect(getTrialBalanceAction).toHaveBeenCalledTimes(1));

    const dateInputs = screen.getAllByDisplayValue('') as HTMLInputElement[];
    fireEvent.change(dateInputs[0], { target: { value: '2026-09-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-09-22' } });

    expect(getTrialBalanceAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق' }));
    await waitFor(() => expect(getTrialBalanceAction).toHaveBeenLastCalledWith('2026-09-01', '2026-09-22'));
    expect(getTrialBalanceAction).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest applied date result when an older request resolves afterwards', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    (getTrialBalanceAction as jest.Mock).mockImplementation((s: string, e: string) => {
      if (!s && !e) return Promise.resolve({ success: true, data: row('initial') });
      if (s === '2026-09-01' && !e) return Promise.resolve({ success: true, data: row('partial') });
      if (s === '2026-09-01' && e === '2026-09-10') return older.promise;
      if (s === '2026-09-01' && e === '2026-09-22') return newer.promise;
      return Promise.resolve({ success: true, data: [] });
    });

    render(<TrialBalanceReport userRole="owner" />);
    expect((await screen.findAllByText('initial')).length).toBeGreaterThan(0);
    const dateInputs = screen.getAllByDisplayValue('') as HTMLInputElement[];

    fireEvent.change(dateInputs[0], { target: { value: '2026-09-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق' }));
    await waitFor(() => expect(getTrialBalanceAction).toHaveBeenCalledWith('2026-09-01', '2026-09-10'));

    fireEvent.change(dateInputs[1], { target: { value: '2026-09-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق' }));
    await waitFor(() => expect(getTrialBalanceAction).toHaveBeenCalledWith('2026-09-01', '2026-09-22'));

    newer.resolve({ success: true, data: row('newest') });
    expect((await screen.findAllByText('newest')).length).toBeGreaterThan(0);
    await act(async () => {
      older.resolve({ success: true, data: row('stale') });
      await older.promise;
    });
    expect(screen.queryAllByText('stale')).toHaveLength(0);
    expect(screen.getAllByText('newest').length).toBeGreaterThan(0);
  });
});
