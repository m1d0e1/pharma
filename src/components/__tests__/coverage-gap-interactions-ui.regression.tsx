import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { addInteractionAction, checkDrugInteractions, getInteractionsAction } from '@/app/actions-client/interactions';
import { toast } from 'react-hot-toast';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

jest.mock('@/hooks/use-debounce', () => ({
  useDebounce: (value: unknown) => value,
}));

jest.mock('@/app/actions-client/interactions', () => ({
  addInteractionAction: jest.fn(),
  checkDrugInteractions: jest.fn(),
  getInteractionsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

const initial = [{
  id: 1,
  ingredient_a: 'warfarin',
  ingredient_b: 'aspirin',
  severity: 'major',
  description_ar: 'نزيف محتمل',
  recommendation: 'مراقبة دقيقة',
}];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('coverage-gap: drug-interactions UI caller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getInteractionsAction as jest.Mock).mockResolvedValue({ success: true, data: initial, total: 1 });
    (checkDrugInteractions as jest.Mock).mockResolvedValue({
      success: true,
      data: { interactions: [], allergies: [] },
    });
  });

  it('validates and executes the quick interaction checker from both input and action controls', async () => {
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="pharmacist" />);
    const checker = screen.getByPlaceholderText(/أدخل المواد الفعالة مفصولة بفاصلة/);

    fireEvent.change(checker, { target: { value: 'warfarin' } });
    fireEvent.click(screen.getByRole('button', { name: 'فحص' }));
    expect(checkDrugInteractions).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('أدخل مادتين فعالتين على الأقل مفصولتين بفاصلة');

    fireEvent.change(checker, { target: { value: 'warfarin, aspirin' } });
    fireEvent.keyDown(checker, { key: 'Enter' });
    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalledWith(['warfarin', 'aspirin']));
    expect(await screen.findByText('لا توجد تفاعلات معروفة بين هذه المواد')).toBeInTheDocument();
  });

  it('keeps manual interaction creation owner-only in the UI and routes the owner form through addInteractionAction', async () => {
    const viewer = render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="pharmacist" />);
    expect(screen.queryByRole('button', { name: /إضافة تفاعل/ })).not.toBeInTheDocument();
    viewer.unmount();

    (addInteractionAction as jest.Mock).mockResolvedValue({ success: true });
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="owner" />);
    fireEvent.click(screen.getByRole('button', { name: /إضافة تفاعل/ }));
    fireEvent.change(screen.getByPlaceholderText('المادة الفعالة الأولى'), { target: { value: 'ING-A' } });
    fireEvent.change(screen.getByPlaceholderText('المادة الفعالة الثانية'), { target: { value: 'ING-B' } });
    fireEvent.change(screen.getByPlaceholderText('وصف التفاعل بالتفصيل...'), { target: { value: 'Manual UI interaction' } });
    fireEvent.change(screen.getByPlaceholderText('التوصية (اختياري)'), { target: { value: 'Monitor' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(addInteractionAction).toHaveBeenCalledWith({
      ingredient_a: 'ING-A',
      ingredient_b: 'ING-B',
      severity: 'moderate',
      description_ar: 'Manual UI interaction',
      recommendation: 'Monitor',
    }));
    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledWith(1, 50, '', 'all'));
  });

  it('fetches filtered interaction results when the list search changes and paginates the returned total', async () => {
    (getInteractionsAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...initial[0], id: 2, ingredient_a: 'warfarin-filtered' }],
        total: 51,
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...initial[0], id: 3, ingredient_a: 'page-two' }],
        total: 51,
      });
    render(<InteractionsClient initialInteractions={initial} totalCount={51} userRole="pharmacist" />);

    fireEvent.change(screen.getByPlaceholderText(/بحث عن مادة فعالة/), { target: { value: 'warf' } });
    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledWith(1, 50, 'warf', 'all'));
    expect(await screen.findByText('warfarin-filtered')).toBeInTheDocument();

    const pagination = screen.getByText('1').parentElement?.parentElement;
    expect(pagination).toBeTruthy();
    const buttons = pagination!.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledWith(2, 50, 'warf', 'all'));
    expect(await screen.findByText('page-two')).toBeInTheDocument();
  });

  it('keeps the newest filtered result when an older interaction request resolves later', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    (getInteractionsAction as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="pharmacist" />);

    const search = screen.getByPlaceholderText(/بحث عن مادة فعالة/);
    fireEvent.change(search, { target: { value: 'old' } });
    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledWith(1, 50, 'old', 'all'));
    fireEvent.change(search, { target: { value: 'new' } });
    await waitFor(() => expect(getInteractionsAction).toHaveBeenCalledWith(1, 50, 'new', 'all'));

    newer.resolve({
      success: true,
      data: [{ ...initial[0], id: 4, ingredient_a: 'newer-result' }],
      total: 1,
    });
    expect(await screen.findByText('newer-result')).toBeInTheDocument();

    await act(async () => {
      older.resolve({
        success: true,
        data: [{ ...initial[0], id: 5, ingredient_a: 'older-result' }],
        total: 1,
      });
      await older.promise;
    });
    expect(screen.queryByText('older-result')).not.toBeInTheDocument();
    expect(screen.getByText('newer-result')).toBeInTheDocument();
  });

  it('does not submit a manual interaction twice while the first write is pending', async () => {
    const pending = deferred<any>();
    (addInteractionAction as jest.Mock).mockImplementation(() => pending.promise);
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="owner" />);

    fireEvent.click(screen.getByRole('button', { name: /إضافة تفاعل/ }));
    fireEvent.change(screen.getByPlaceholderText('المادة الفعالة الأولى'), { target: { value: 'ING-A' } });
    fireEvent.change(screen.getByPlaceholderText('المادة الفعالة الثانية'), { target: { value: 'ING-B' } });
    fireEvent.change(screen.getByPlaceholderText('وصف التفاعل بالتفصيل...'), { target: { value: 'Duplicate guard' } });
    const save = screen.getByRole('button', { name: 'حفظ' });
    fireEvent.click(save);
    fireEvent.click(save);

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => {
      await pending.promise;
    });
    expect(addInteractionAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the manual form values and reports an error when creation throws', async () => {
    (addInteractionAction as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="owner" />);

    fireEvent.click(screen.getByRole('button', { name: /إضافة تفاعل/ }));
    const ingredientA = screen.getByPlaceholderText('المادة الفعالة الأولى') as HTMLInputElement;
    const ingredientB = screen.getByPlaceholderText('المادة الفعالة الثانية') as HTMLInputElement;
    const description = screen.getByPlaceholderText('وصف التفاعل بالتفصيل...') as HTMLTextAreaElement;
    fireEvent.change(ingredientA, { target: { value: 'KEEP-A' } });
    fireEvent.change(ingredientB, { target: { value: 'KEEP-B' } });
    fireEvent.change(description, { target: { value: 'Keep this text' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل الإضافة'));
    expect(ingredientA.value).toBe('KEEP-A');
    expect(ingredientB.value).toBe('KEEP-B');
    expect(description.value).toBe('Keep this text');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps the newest quick-check result when Enter starts a newer request before the older one finishes', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    (checkDrugInteractions as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="pharmacist" />);

    const checker = screen.getByPlaceholderText(/أدخل المواد الفعالة مفصولة بفاصلة/);
    fireEvent.change(checker, { target: { value: 'old-a, old-b' } });
    fireEvent.keyDown(checker, { key: 'Enter' });
    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalledWith(['old-a', 'old-b']));

    fireEvent.change(checker, { target: { value: 'new-a, new-b' } });
    fireEvent.keyDown(checker, { key: 'Enter' });
    await waitFor(() => expect(checkDrugInteractions).toHaveBeenCalledWith(['new-a', 'new-b']));

    newer.resolve({
      success: true,
      data: {
        interactions: [{ ingredient_a: 'NEW-A', ingredient_b: 'NEW-B', severity: 'major', description_ar: 'new result' }],
        allergies: [],
      },
    });
    expect(await screen.findByText(/NEW-A/)).toBeInTheDocument();

    await act(async () => {
      older.resolve({
        success: true,
        data: {
          interactions: [{ ingredient_a: 'OLD-A', ingredient_b: 'OLD-B', severity: 'major', description_ar: 'old result' }],
          allergies: [],
        },
      });
      await older.promise;
    });
    expect(screen.queryByText(/OLD-A/)).not.toBeInTheDocument();
    expect(screen.getByText(/NEW-A/)).toBeInTheDocument();
  });

  it('reports a quick-check transport failure and restores the checker control', async () => {
    (checkDrugInteractions as jest.Mock).mockRejectedValueOnce(new Error('checker offline'));
    render(<InteractionsClient initialInteractions={initial} totalCount={1} userRole="pharmacist" />);

    const checker = screen.getByPlaceholderText(/أدخل المواد الفعالة مفصولة بفاصلة/);
    fireEvent.change(checker, { target: { value: 'warfarin, aspirin' } });
    fireEvent.keyDown(checker, { key: 'Enter' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء فحص التفاعلات'));
    expect(screen.getByRole('button', { name: 'فحص' })).not.toBeDisabled();
    expect((checker as HTMLInputElement).value).toBe('warfarin, aspirin');
  });
});
