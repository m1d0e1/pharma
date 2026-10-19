import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { checkDrugInteractions } from '@/app/actions-client/interactions';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/hooks/use-debounce', () => ({ useDebounce: (value: string) => value }));
jest.mock('@/app/actions-client/interactions', () => ({
  getInteractionsAction: jest.fn(),
  addInteractionAction: jest.fn(),
  checkDrugInteractions: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const pairResult = (first: string, second: string) => ({
  success: true,
  data: { interactions: [{
    ingredient_a: first,
    ingredient_b: second,
    severity: 'major',
    description_ar: `تحذير ${first} ${second}`,
  }], allergies: [] },
});

describe('quick clinical interaction checker binds results to the current input', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes previously checked warnings when the ingredients are edited', async () => {
    (checkDrugInteractions as jest.Mock).mockResolvedValue(pairResult('Warfarin', 'Aspirin'));
    render(<InteractionsClient initialInteractions={[]} totalCount={0} userRole="pharmacist" />);
    const input = screen.getByRole('textbox', { name: 'المواد الفعالة للفحص السريع' });

    fireEvent.change(input, { target: { value: 'Warfarin, Aspirin' } });
    fireEvent.click(screen.getByRole('button', { name: 'فحص' }));
    expect(await screen.findByText('تحذير Warfarin Aspirin')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Digoxin, Amiodarone' } });
    expect(screen.queryByText('تحذير Warfarin Aspirin')).not.toBeInTheDocument();
  });

  it('ignores a late check response after the input changes, without a second submit', async () => {
    let release!: (value: ReturnType<typeof pairResult>) => void;
    (checkDrugInteractions as jest.Mock).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<InteractionsClient initialInteractions={[]} totalCount={0} userRole="pharmacist" />);
    const input = screen.getByRole('textbox', { name: 'المواد الفعالة للفحص السريع' });

    fireEvent.change(input, { target: { value: 'Warfarin, Aspirin' } });
    fireEvent.click(screen.getByRole('button', { name: 'فحص' }));
    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalledWith(['Warfarin', 'Aspirin']));
    fireEvent.change(input, { target: { value: 'Digoxin, Amiodarone' } });
    release(pairResult('Warfarin', 'Aspirin'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'فحص' })).toBeEnabled());
    expect(screen.queryByText('تحذير Warfarin Aspirin')).not.toBeInTheDocument();
  });
});
