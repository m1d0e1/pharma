import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CategoriesPage from '@/app/(dashboard)/stores/categories/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import {
  addProductCategoryAction,
  deleteProductCategoryAction,
  getProductCategoriesAction,
  updateProductCategoryAction,
} from '@/app/actions-client/master-drugs';
import { dbExecute, dbGet, dbSelect } from '@/lib/db/tauri';

const push = jest.fn();
const router = { push };

jest.mock('next/navigation', () => ({ useRouter: () => router }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/master-drugs', () => ({
  addProductCategoryAction: jest.fn(),
  deleteProductCategoryAction: jest.fn(),
  getProductCategoriesAction: jest.fn(),
  updateProductCategoryAction: jest.fn(),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbExecute: jest.fn(),
  dbGet: jest.fn(),
  dbSelect: jest.fn(),
}));

const category = { id: 1, parent_id: null, name_ar: 'مسكنات', name_en: 'Analgesics' };

describe('product categories permission boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'viewer', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
    (getProductCategoriesAction as jest.Mock).mockResolvedValue({ success: true, data: [category] });
    (addProductCategoryAction as jest.Mock).mockResolvedValue({ success: true, id: 2 });
    (updateProductCategoryAction as jest.Mock).mockResolvedValue({ success: true });
    (deleteProductCategoryAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('keeps categories visible but hides all mutation controls for view-only users', async () => {
    render(<CategoriesPage />);

    const row = await screen.findByText('مسكنات');
    await waitFor(() => expect(hasUserPermissionSync).toHaveBeenCalledWith(expect.anything(), 'can_manage_inventory'));
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    fireEvent.click(row);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(getProductCategoriesAction).toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('routes category add, update, and delete through the secured actions', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CategoriesPage />);

    await screen.findByText('مسكنات');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));

    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'مضادات' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المجموعة' }));
    await waitFor(() => expect(addProductCategoryAction).toHaveBeenCalledWith({
      name_ar: 'مضادات',
      name_en: '',
      parent_id: undefined,
    }));

    fireEvent.click(screen.getByText('مسكنات'));
    const selectedButtons = screen.getAllByRole('button');
    expect(selectedButtons).toHaveLength(4);
    fireEvent.click(selectedButtons[1]);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'مسكنات محدثة' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المجموعة' }));
    await waitFor(() => expect(updateProductCategoryAction).toHaveBeenCalledWith(1, {
      name_ar: 'مسكنات محدثة',
      name_en: 'Analgesics',
      parent_id: undefined,
    }));

    fireEvent.click(screen.getAllByRole('button')[2]);
    await waitFor(() => expect(deleteProductCategoryAction).toHaveBeenCalledWith(1));

    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('shows a retryable load error instead of a successful empty category tree', async () => {
    (getProductCategoriesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'category load failed' })
      .mockResolvedValueOnce({ success: true, data: [category] });

    render(<CategoriesPage />);

    expect(await screen.findByText('تعذر تحميل مجموعات الأصناف')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد مجموعات معرفة بعد.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('مسكنات')).toBeInTheDocument();
    expect((getProductCategoriesAction as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('blocks repeated category creates while the first write is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    let resolveAdd: (value: { success: boolean; id?: number; error?: string }) => void = () => {};
    (addProductCategoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveAdd = resolve;
    }));

    render(<CategoriesPage />);
    await screen.findByText('مسكنات');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    const addButton = screen.getAllByRole('button')[0];
    fireEvent.click(addButton);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'مضادات جديدة' } });
    const saveButton = screen.getByRole('button', { name: 'حفظ المجموعة' });

    act(() => {
      fireEvent.click(saveButton);
      fireEvent.click(saveButton);
    });

    expect(addProductCategoryAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd({ success: false, error: 'write rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ المجموعة' })).toBeEnabled());
  });

  it('blocks repeated category deletes while the first destructive write is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
    (deleteProductCategoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveDelete = resolve;
    }));

    render(<CategoriesPage />);
    await screen.findByText('مسكنات');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    fireEvent.click(screen.getByText('مسكنات'));
    const selectedButtons = screen.getAllByRole('button');
    const deleteButton = selectedButtons[2];

    act(() => {
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
    });

    expect(deleteProductCategoryAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveDelete({ success: false, error: 'delete rejected' }));
    confirmSpy.mockRestore();
  });
});
