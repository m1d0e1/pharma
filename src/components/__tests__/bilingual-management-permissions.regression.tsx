import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
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

const mutation = jest.fn(async () => ({ success: true }));

describe('shared bilingual master-data permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'staff', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
  });

  it('keeps read-only data visible but hides mutation controls without can_manage_inventory', async () => {
    render(
      <BilingualManagementClient
        initialData={[{ id: 1, name_ar: 'View only', name_en: 'VIEW ONLY' }]}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    expect(screen.getByText('View only')).toBeInTheDocument();
    await waitFor(() => expect(getClientSession).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Usage/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows mutation controls when can_manage_inventory is granted', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);

    render(
      <BilingualManagementClient
        initialData={[{ id: 1, name_ar: 'Managed', name_en: 'MANAGED' }]}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    expect(await screen.findByRole('button', { name: /Usage/ })).toBeInTheDocument();
  });

  it('searches and paginates shared master data, resets search to page one, and supports Enter/Escape modal keyboard flows', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const onAdd = jest.fn(async () => ({ success: true, id: 99 }));
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: index + 1,
      name_ar: `اسم ${String(index + 1).padStart(2, '0')}`,
      name_en: `Item ${String(index + 1).padStart(2, '0')}`,
    }));

    render(
      <BilingualManagementClient
        initialData={rows}
        title="Usage"
        iconName="Info"
        onAdd={onAdd}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    const addButton = await screen.findByRole('button', { name: /إضافة Usage جديد/ });
    expect(screen.getByText('Item 01')).toBeInTheDocument();
    expect(screen.queryByText('Item 51')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    expect(screen.getByText('Item 51')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('بحث في Usage...'), { target: { value: 'Item 01' } });
    expect(screen.getByText('Item 01')).toBeInTheDocument();
    expect(screen.queryByText('Item 51')).not.toBeInTheDocument();
    expect(screen.queryByText('2 / 2')).not.toBeInTheDocument();

    fireEvent.click(addButton);
    const modalInputs = screen.getAllByRole('textbox');
    fireEvent.change(modalInputs[1], { target: { value: 'وحدة جديدة' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ name_ar: 'وحدة جديدة', name_en: '' }));
    fireEvent.change(screen.getByPlaceholderText('بحث في Usage...'), { target: { value: '' } });
    expect(await screen.findByText('وحدة جديدة')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /إضافة Usage جديد/ }));
    expect(screen.getByText('الإسم بالعربي *')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('الإسم بالعربي *')).not.toBeInTheDocument();
  });

  it('restores a bilingual save after a thrown mutation and preserves the form for retry', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const onAdd = jest.fn().mockRejectedValueOnce(new Error('bridge unavailable'));

    render(
      <BilingualManagementClient
        initialData={[]}
        title="Usage"
        iconName="Info"
        onAdd={onAdd}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /إضافة Usage جديد/ }));
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[1], { target: { value: 'قيمة محفوظة' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل إضافة Usage'));
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    expect(screen.getByDisplayValue('قيمة محفوظة')).toBeInTheDocument();
  });

  it('blocks repeated Enter saves while a bilingual mutation is still pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    let resolveAdd: (value: { success: boolean; error?: string }) => void = () => {};
    const onAdd = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveAdd = resolve;
    }));

    render(
      <BilingualManagementClient
        initialData={[]}
        title="Usage"
        iconName="Info"
        onAdd={onAdd}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /إضافة Usage جديد/ }));
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[1], { target: { value: 'مرة واحدة' } });
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'جاري الحفظ...' })).toBeDisabled();

    resolveAdd({ success: false, error: 'تعذر الحفظ' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled());
  });

  it('keeps the bilingual editor open when Escape is pressed while save persistence is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    let resolveAdd!: (value: { success: boolean; error?: string }) => void;
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveAdd = resolve;
    });
    const onAdd = jest.fn(() => pending);

    render(
      <BilingualManagementClient
        initialData={[]}
        title="Usage"
        iconName="Info"
        onAdd={onAdd}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /إضافة Usage جديد/ }));
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[1], { target: { value: 'قيمة معلّقة' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByDisplayValue('قيمة معلّقة')).toBeInTheDocument();

    await act(async () => {
      resolveAdd({ success: false, error: 'تعذر الحفظ' });
      await pending;
    });
  });

  it('returns to the last valid bilingual page after deleting the only row on the final page', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const onDelete = jest.fn().mockResolvedValue({ success: true });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: index + 1,
      name_ar: `اسم ${String(index + 1).padStart(2, '0')}`,
      name_en: `Item ${String(index + 1).padStart(2, '0')}`,
    }));

    render(
      <BilingualManagementClient
        initialData={rows}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={onDelete}
      />
    );

    await screen.findByRole('button', { name: /إضافة Usage جديد/ });
    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    expect(screen.getByText('Item 51')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حذف اسم 51' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(51));
    expect(await screen.findByText('Item 01')).toBeInTheDocument();
    expect(screen.queryByText('Item 51')).not.toBeInTheDocument();
  });

  it('surfaces a thrown bilingual delete and keeps the item visible', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const onDelete = jest.fn().mockRejectedValueOnce(new Error('delete bridge unavailable'));
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <BilingualManagementClient
        initialData={[{ id: 1, name_ar: 'قيمة قائمة', name_en: 'Existing' }]}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={onDelete}
      />
    );

    await screen.findByRole('button', { name: /إضافة Usage جديد/ });
    const itemCard = screen.getByText('قيمة قائمة').closest('div.bg-white') as HTMLElement;
    const itemButtons = itemCard.querySelectorAll('button');
    fireEvent.click(itemButtons[itemButtons.length - 1]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل الحذف'));
    expect(screen.getByText('قيمة قائمة')).toBeInTheDocument();
  });

  it('blocks duplicate bilingual deletes while the delete action is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
    const onDelete = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveDelete = resolve;
    }));
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <BilingualManagementClient
        initialData={[{ id: 1, name_ar: 'قيمة قائمة', name_en: 'Existing' }]}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={onDelete}
      />
    );

    await screen.findByRole('button', { name: /إضافة Usage جديد/ });
    const itemCard = screen.getByText('قيمة قائمة').closest('div.bg-white') as HTMLElement;
    const itemButtons = itemCard.querySelectorAll('button');
    const deleteButton = itemButtons[itemButtons.length - 1];
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(deleteButton).toBeDisabled();

    resolveDelete({ success: false, error: 'تعذر الحذف' });
    await waitFor(() => expect(deleteButton).toBeEnabled());
  });

});
