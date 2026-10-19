import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { getInteractionsAction } from '@/app/actions-client/interactions';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/hooks/use-debounce', () => ({ useDebounce: (value: string) => value }));
jest.mock('@/app/actions-client/interactions', () => ({
  getInteractionsAction: jest.fn(), addInteractionAction: jest.fn(), checkDrugInteractions: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const item = (id: number, ingredient_a: string) => ({
  id, ingredient_a, ingredient_b: 'Aspirin', severity: 'major', description_ar: ingredient_a,
});

describe('clinical interaction directory keeps search results and errors scoped', () => {
  beforeEach(() => jest.clearAllMocks());

  it('restores the original unfiltered directory after a successful filtered search is cleared', async () => {
    (getInteractionsAction as jest.Mock).mockResolvedValue({ success: true, data: [item(2, 'FILTERED-PAIR')], total: 1 });
    render(<InteractionsClient initialInteractions={[item(1, 'INITIAL-PAIR')]} totalCount={1} userRole="pharmacist" />);
    const search = screen.getByRole('textbox', { name: 'بحث في التفاعلات الدوائية' });
    fireEvent.change(search, { target: { value: 'filtered' } });
    await waitFor(() => expect(screen.queryAllByText('FILTERED-PAIR').length).toBeGreaterThan(0));
    expect(screen.queryByText('INITIAL-PAIR')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    await waitFor(() => expect(screen.queryAllByText('INITIAL-PAIR').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('FILTERED-PAIR')).toHaveLength(0);
  });

  it('ignores a late filtered response after the query was cleared', async () => {
    let release!: (value: unknown) => void;
    (getInteractionsAction as jest.Mock).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<InteractionsClient initialInteractions={[item(1, 'INITIAL-PAIR')]} totalCount={1} userRole="pharmacist" />);
    const search = screen.getByRole('textbox', { name: 'بحث في التفاعلات الدوائية' });
    fireEvent.change(search, { target: { value: 'filtered' } });
    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledWith(1, 50, 'filtered', 'all'));
    fireEvent.change(search, { target: { value: '' } });

    await act(async () => { release({ success: true, data: [item(2, 'STALE-PAIR')], total: 1 }); });
    expect(screen.queryAllByText('STALE-PAIR')).toHaveLength(0);
    expect(screen.queryAllByText('INITIAL-PAIR').length).toBeGreaterThan(0);
  });

  it('does not show stale reference rows or a false no-results message when the filtered read is denied', async () => {
    (getInteractionsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Access denied' })
      .mockResolvedValueOnce({ success: true, data: [item(3, 'RECOVERED-PAIR')], total: 1 });
    render(<InteractionsClient initialInteractions={[item(1, 'INITIAL-PAIR')]} totalCount={1} userRole="pharmacist" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'بحث في التفاعلات الدوائية' }), { target: { value: 'new' } });
    expect(await screen.findByText('تعذر تحميل نتائج التفاعلات')).toBeInTheDocument();
    expect(screen.queryAllByText('INITIAL-PAIR')).toHaveLength(0);
    expect(screen.queryByText('لا توجد تفاعلات مطابقة للبحث')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(screen.queryAllByText('RECOVERED-PAIR').length).toBeGreaterThan(0));
    expect(screen.queryByText('تعذر تحميل نتائج التفاعلات')).not.toBeInTheDocument();
    expect(getInteractionsAction).toHaveBeenCalledTimes(2);
  });
});
