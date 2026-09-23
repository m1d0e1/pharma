import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeleteUnusedItemsClient from '@/components/inventory/DeleteUnusedItemsClient';
import { toast } from 'react-hot-toast';

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
  Toaster: () => null,
}));

const items = [
  { id: 1, trade_name: 'دواء عربي', trade_name_en: 'Medicine One', manufacturer: 'M1', official_price: 10, is_medicine: 1 },
  { id: 2, trade_name: 'منتج عناية', trade_name_en: 'Care Product', manufacturer: 'M2', official_price: 20, is_medicine: 0 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('unused-item cleanup UI interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters by search and medicine type and renders the explicit no-match state', () => {
    render(<DeleteUnusedItemsClient initialItems={items} onDelete={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'أدوية' }));
    expect(screen.getByText('Medicine One')).toBeInTheDocument();
    expect(screen.queryByText('Care Product')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'غير أدوية' }));
    expect(screen.queryByText('Medicine One')).not.toBeInTheDocument();
    expect(screen.getByText('Care Product')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('بحث بالكود أو الاسم...'), { target: { value: 'missing' } });
    expect(screen.getByText('لا يوجد أصناف مطابقة للبحث أو القائمة فارغة.')).toBeInTheDocument();
    expect(screen.getByText('عدد الأصناف القابلة للحذف: 0')).toBeInTheDocument();
  });

  it('honors delete cancellation and keeps an item after a failed delete', async () => {
    const onDelete = jest.fn().mockResolvedValue({ success: false, error: 'الصنف مرتبط ببيانات أخرى' });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<DeleteUnusedItemsClient initialItems={items} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'حذف Medicine One' }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'حذف Medicine One' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(1));
    expect(toast.error).toHaveBeenCalledWith('الصنف مرتبط ببيانات أخرى');
    expect(screen.getByText('Medicine One')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('removes only the successfully deleted item from the local list', async () => {
    const onDelete = jest.fn().mockResolvedValue({ success: true });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DeleteUnusedItemsClient initialItems={items} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'حذف Care Product' }));

    await waitFor(() => expect(screen.queryByText('Care Product')).not.toBeInTheDocument());
    expect(screen.getByText('Medicine One')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('تم حذف الصنف بنجاح');
    expect(screen.getByText('عدد الأصناف القابلة للحذف: 1')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('recovers from a thrown delete failure and restores the delete control', async () => {
    const onDelete = jest.fn().mockRejectedValue(new Error('delete bridge unavailable'));
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DeleteUnusedItemsClient initialItems={items} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole('button', { name: 'حذف Medicine One' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل الحذف'));
    expect(screen.getByRole('button', { name: 'حذف Medicine One' })).toBeEnabled();
    expect(screen.getByText('Medicine One')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('blocks same-tick duplicate delete events while the first delete is pending', async () => {
    const pending = deferred<{ success: boolean }>();
    const onDelete = jest.fn(() => pending.promise);
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DeleteUnusedItemsClient initialItems={items} onDelete={onDelete} />);

    const deleteButton = screen.getByRole('button', { name: 'حذف Medicine One' });
    act(() => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ success: false });
      await pending.promise;
    });
    confirmSpy.mockRestore();
  });
});
