import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CogsAdjustmentClient from '@/components/sales/CogsAdjustmentClient';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';
import toast from 'react-hot-toast';

jest.mock('@/app/actions-client/cogs', () => ({
  getSoldItemsForCogsAdjustmentAction: jest.fn(),
  updateSoldItemCostAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

const soldItem = {
  id: 11,
  trade_name: 'COGS Drug',
  invoice_id: 'invoice-12345678',
  invoice_date: '2026-09-20T10:00:00',
  unit_price: 100,
  current_inv_cost: 40,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('COGS adjustment UI interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({ success: true, data: [soldItem] });
  });

  it('searches by Enter and button, renders empty results, validates cost, and re-searches after a successful update', async () => {
    render(<CogsAdjustmentClient />);

    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    fireEvent.change(search, { target: { value: 'COGS Drug' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(await screen.findByText('COGS Drug')).toBeInTheDocument();
    expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenCalledWith('COGS Drug');

    const row = screen.getByText('COGS Drug').closest('tr');
    expect(row).not.toBeNull();
    const costInput = within(row as HTMLElement).getByRole('spinbutton');
    const save = within(row as HTMLElement).getByRole('button');

    fireEvent.click(save);
    expect(updateSoldItemCostAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال تكلفة صحيحة');

    (updateSoldItemCostAction as jest.Mock).mockResolvedValueOnce({ success: true });
    fireEvent.change(costInput, { target: { value: '55' } });
    fireEvent.click(save);

    await waitFor(() => expect(updateSoldItemCostAction).toHaveBeenCalledWith(11, 55));
    expect(toast.success).toHaveBeenCalledWith('تم تعديل تكلفة الصنف المباع بنجاح');
    await waitFor(() => expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenCalledTimes(2));

    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [] });
    fireEvent.change(search, { target: { value: 'missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(await screen.findByText('لم يتم العثور على نتائج للبحث...')).toBeInTheDocument();
  });

  it('surfaces update failures instead of reporting success', async () => {
    (updateSoldItemCostAction as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر تعديل التكلفة' });
    render(<CogsAdjustmentClient />);

    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    fireEvent.change(search, { target: { value: 'COGS Drug' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));

    const row = (await screen.findByText('COGS Drug')).closest('tr');
    const costInput = within(row as HTMLElement).getByRole('spinbutton');
    fireEvent.change(costInput, { target: { value: '60' } });
    fireEvent.click(within(row as HTMLElement).getByRole('button'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر تعديل التكلفة'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows the action error when a search fails', async () => {
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر البحث عن المبيعات' });
    render(<CogsAdjustmentClient />);

    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    fireEvent.change(search, { target: { value: 'broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));

    await waitFor(() => expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenCalledWith('broken'));
    expect(toast.error).toHaveBeenCalledWith('تعذر البحث عن المبيعات');
  });

  it('keeps a newer search result when an older request resolves later', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    const oldItem = { ...soldItem, id: 21, trade_name: 'Older Result', invoice_id: 'older-12345678' };
    const newItem = { ...soldItem, id: 22, trade_name: 'Newer Result', invoice_id: 'newer-12345678' };

    (getSoldItemsForCogsAdjustmentAction as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    render(<CogsAdjustmentClient />);
    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    const searchButton = screen.getByRole('button', { name: 'بحث' });

    fireEvent.change(search, { target: { value: 'old' } });
    fireEvent.click(searchButton);
    await waitFor(() => expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenCalledWith('old'));

    fireEvent.change(search, { target: { value: 'new' } });
    fireEvent.click(searchButton);
    await waitFor(() => expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenCalledWith('new'));

    newer.resolve({ success: true, data: [newItem] });
    expect(await screen.findByText('Newer Result')).toBeInTheDocument();

    await act(async () => {
      older.resolve({ success: true, data: [oldItem] });
      await older.promise;
    });
    expect(screen.queryByText('Older Result')).not.toBeInTheDocument();
    expect(screen.getByText('Newer Result')).toBeInTheDocument();
  });

  it('does not submit the same cost update twice while the first write is pending', async () => {
    const pending = deferred<any>();
    (updateSoldItemCostAction as jest.Mock).mockImplementation(() => pending.promise);
    render(<CogsAdjustmentClient />);

    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    fireEvent.change(search, { target: { value: 'COGS Drug' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));

    const row = (await screen.findByText('COGS Drug')).closest('tr') as HTMLElement;
    fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '65' } });
    const save = within(row).getByRole('button');
    fireEvent.click(save);
    fireEvent.click(save);

    expect(updateSoldItemCostAction).toHaveBeenCalledTimes(1);
    pending.resolve({ success: false, error: 'stop' });
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  it('recovers the update control and preserves the entered cost when the write throws', async () => {
    (updateSoldItemCostAction as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    render(<CogsAdjustmentClient />);

    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    fireEvent.change(search, { target: { value: 'COGS Drug' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));

    const row = (await screen.findByText('COGS Drug')).closest('tr') as HTMLElement;
    const costInput = within(row).getByRole('spinbutton') as HTMLInputElement;
    const save = within(row).getByRole('button');
    fireEvent.change(costInput, { target: { value: '70' } });
    fireEvent.click(save);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل التعديل'));
    expect(save).not.toBeDisabled();
    expect(costInput.value).toBe('70');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not let an older post-update refresh overwrite a newer search', async () => {
    const pendingUpdate = deferred<any>();
    const newerItem = { ...soldItem, id: 31, trade_name: 'Newest Search Result', invoice_id: 'newer-12345678' };
    const staleItem = { ...soldItem, id: 32, trade_name: 'Stale Post-Update Result', invoice_id: 'stale-12345678' };

    (updateSoldItemCostAction as jest.Mock).mockImplementation(() => pendingUpdate.promise);
    let oldQueryCalls = 0;
    (getSoldItemsForCogsAdjustmentAction as jest.Mock).mockImplementation((query: string) => {
      if (query === 'COGS Drug') {
        oldQueryCalls += 1;
        return Promise.resolve({ success: true, data: [oldQueryCalls === 1 ? soldItem : staleItem] });
      }
      if (query === 'Newest') {
        return Promise.resolve({ success: true, data: [newerItem] });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    render(<CogsAdjustmentClient />);
    const search = screen.getByPlaceholderText('ابحث باسم الصنف أو رقم الفاتورة...');
    const searchButton = screen.getByRole('button', { name: 'بحث' });

    fireEvent.change(search, { target: { value: 'COGS Drug' } });
    fireEvent.click(searchButton);
    const row = (await screen.findByText('COGS Drug')).closest('tr') as HTMLElement;
    fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '75' } });
    fireEvent.click(within(row).getByRole('button'));
    await waitFor(() => expect(updateSoldItemCostAction).toHaveBeenCalledWith(11, 75));

    fireEvent.change(search, { target: { value: 'Newest' } });
    fireEvent.click(searchButton);
    expect(await screen.findByText('Newest Search Result')).toBeInTheDocument();

    await act(async () => {
      pendingUpdate.resolve({ success: true });
      await pendingUpdate.promise;
    });
    await waitFor(() => expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenCalledTimes(3));

    expect(getSoldItemsForCogsAdjustmentAction).toHaveBeenLastCalledWith('Newest');
    expect(screen.queryByText('Stale Post-Update Result')).not.toBeInTheDocument();
    expect(screen.getByText('Newest Search Result')).toBeInTheDocument();
  });
});
