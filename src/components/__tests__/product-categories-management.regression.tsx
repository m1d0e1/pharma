import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductCategoriesManagement from '@/components/inventory/ProductCategoriesManagement';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
  Toaster: () => null,
}));

describe('product categories management ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
  });

  it('keeps the category editor open while save persistence is pending', async () => {
    let resolveAdd!: (value: { success: boolean; id?: number; error?: string }) => void;
    const pending = new Promise<{ success: boolean; id?: number; error?: string }>(resolve => {
      resolveAdd = resolve;
    });
    const onAdd = jest.fn(() => pending);

    render(
      <ProductCategoriesManagement
        initialData={[]}
        onAdd={onAdd}
        onUpdate={jest.fn(async () => ({ success: true }))}
        onDelete={jest.fn(async () => ({ success: true }))}
      />
    );

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'مجموعة معلّقة' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ المجموعة/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByDisplayValue('مجموعة معلّقة')).toBeInTheDocument();

    await act(async () => {
      resolveAdd({ success: false, error: 'تعذر الحفظ' });
      await pending;
    });
  });

  it('surfaces a thrown category save failure and preserves the form for retry', async () => {
    const onAdd = jest.fn().mockRejectedValueOnce(new Error('bridge unavailable'));

    render(
      <ProductCategoriesManagement
        initialData={[]}
        onAdd={onAdd}
        onUpdate={jest.fn(async () => ({ success: true }))}
        onDelete={jest.fn(async () => ({ success: true }))}
      />
    );

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'مجموعة محفوظة' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ المجموعة/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل الإضافة'));
    expect(screen.getByDisplayValue('مجموعة محفوظة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /حفظ المجموعة/ })).toBeEnabled();
  });

  it('surfaces a thrown category removal failure and keeps the category visible', async () => {
    const onDelete = jest.fn().mockRejectedValueOnce(new Error('removal bridge unavailable'));
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <ProductCategoriesManagement
        initialData={[{ id: 7, parent_id: null, name_ar: 'مجموعة قائمة', name_en: 'Existing' }]}
        onAdd={jest.fn(async () => ({ success: true, id: 8 }))}
        onUpdate={jest.fn(async () => ({ success: true }))}
        onDelete={onDelete}
      />
    );

    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    fireEvent.click(screen.getByText('مجموعة قائمة'));
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(4));
    fireEvent.click(screen.getAllByRole('button')[2]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل الحذف'));
    expect(screen.getAllByText('مجموعة قائمة').length).toBeGreaterThan(0);
  });

});
