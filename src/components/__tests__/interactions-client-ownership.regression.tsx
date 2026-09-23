import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { addInteractionAction, checkDrugInteractions, getInteractionsAction } from '@/app/actions-client/interactions';
import { toast } from 'react-hot-toast';

const router = { refresh: jest.fn() };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
}));

jest.mock('@/app/actions-client/interactions', () => ({
  addInteractionAction: jest.fn(),
  checkDrugInteractions: jest.fn(),
  getInteractionsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const interaction = (id: number, a: string, b: string) => ({
  id,
  ingredient_a: a,
  ingredient_b: b,
  severity: 'moderate',
  description_ar: `${a} + ${b}`,
  recommendation: '',
});

function fillAddForm() {
  fireEvent.change(screen.getByPlaceholderText('المادة الفعالة الأولى'), { target: { value: 'warfarin' } });
  fireEvent.change(screen.getByPlaceholderText('المادة الفعالة الثانية'), { target: { value: 'aspirin' } });
  fireEvent.change(screen.getByPlaceholderText('وصف التفاعل بالتفصيل...'), { target: { value: 'وصف' } });
}

describe('interactions client ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the add form open while interaction persistence is pending', async () => {
    let resolveAdd!: (value: { success: boolean; error?: string }) => void;
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveAdd = resolve;
    });
    (addInteractionAction as jest.Mock).mockImplementation(() => pending);

    render(<InteractionsClient initialInteractions={[]} totalCount={0} userRole="owner" />);

    fireEvent.click(screen.getByRole('button', { name: /إضافة تفاعل/ }));
    fillAddForm();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(addInteractionAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    const stayedOpenWhilePending = screen.queryByText('إضافة تفاعل دوائي جديد') !== null;

    await act(async () => {
      resolveAdd({ success: false, error: 'save failed' });
      await pending;
    });

    expect(stayedOpenWhilePending).toBe(true);
  });

  it('surfaces a returned quick-check failure', async () => {
    (checkDrugInteractions as jest.Mock).mockResolvedValue({ success: false, error: 'checker failed' });
    render(<InteractionsClient initialInteractions={[]} totalCount={0} userRole="owner" />);

    fireEvent.change(screen.getByPlaceholderText(/أدخل المواد الفعالة مفصولة بفاصلة/), {
      target: { value: 'warfarin, aspirin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'فحص' }));

    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('checker failed'));
  });

  it('refreshes the currently owned page after a successful add', async () => {
    (getInteractionsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [interaction(51, 'page2-a', 'page2-b')], total: 100 })
      .mockResolvedValueOnce({ success: true, data: [interaction(52, 'page2-new-a', 'page2-new-b')], total: 100 });
    (addInteractionAction as jest.Mock).mockResolvedValue({ success: true });

    const { container } = render(
      <InteractionsClient
        initialInteractions={[interaction(1, 'initial-a', 'initial-b')]}
        totalCount={100}
        userRole="owner"
      />
    );

    const iconOnlyButtons = screen.getAllByRole('button').filter(button => button.textContent === '');
    fireEvent.click(iconOnlyButtons[iconOnlyButtons.length - 1]);
    expect(await screen.findByText('page2-a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /إضافة تفاعل/ }));
    fillAddForm();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledTimes(2));
    expect(getInteractionsAction).toHaveBeenLastCalledWith(2, 50, '', 'all');
    expect(await screen.findByText('page2-new-a')).toBeInTheDocument();

    const activePage = container.querySelector('span.text-blue-600');
    expect(activePage).toHaveTextContent('2');
  });
});
