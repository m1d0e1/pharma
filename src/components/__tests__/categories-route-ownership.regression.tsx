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

const push = jest.fn();
const router = { push };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
}));

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

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
  Toaster: () => null,
}));

describe('categories route ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
    (addProductCategoryAction as jest.Mock).mockResolvedValue({ success: true, id: 9 });
    (updateProductCategoryAction as jest.Mock).mockResolvedValue({ success: true });
    (deleteProductCategoryAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('keeps the newest same-tick category retry when responses resolve out of order', async () => {
    let resolveOlder!: (value: { success: boolean; data?: any[]; error?: string }) => void;
    let resolveNewer!: (value: { success: boolean; data?: any[]; error?: string }) => void;
    const older = new Promise<{ success: boolean; data?: any[]; error?: string }>(resolve => {
      resolveOlder = resolve;
    });
    const newer = new Promise<{ success: boolean; data?: any[]; error?: string }>(resolve => {
      resolveNewer = resolve;
    });

    (getProductCategoriesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'initial load failed' })
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);

    render(<CategoriesPage />);

    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(getProductCategoriesAction).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveNewer({
        success: true,
        data: [{ id: 2, parent_id: null, name_ar: 'الأحدث', name_en: 'Newest' }],
      });
      await newer;
    });
    expect(await screen.findByText('الأحدث')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({
        success: true,
        data: [{ id: 1, parent_id: null, name_ar: 'الأقدم', name_en: 'Older' }],
      });
      await older;
    });

    expect(screen.getByText('الأحدث')).toBeInTheDocument();
    expect(screen.queryByText('الأقدم')).not.toBeInTheDocument();
  });

  it('does not let an older failed retry replace a newer successful category load', async () => {
    let resolveOlder!: (value: { success: boolean; data?: any[]; error?: string }) => void;
    let resolveNewer!: (value: { success: boolean; data?: any[]; error?: string }) => void;
    const older = new Promise<{ success: boolean; data?: any[]; error?: string }>(resolve => {
      resolveOlder = resolve;
    });
    const newer = new Promise<{ success: boolean; data?: any[]; error?: string }>(resolve => {
      resolveNewer = resolve;
    });

    (getProductCategoriesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'initial load failed' })
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);

    render(<CategoriesPage />);

    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(getProductCategoriesAction).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveNewer({
        success: true,
        data: [{ id: 2, parent_id: null, name_ar: 'الأحدث', name_en: 'Newest' }],
      });
      await newer;
    });
    expect(await screen.findByText('الأحدث')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: false, error: 'older failed' });
      await older;
    });

    expect(screen.getByText('الأحدث')).toBeInTheDocument();
    expect(screen.queryByText('تعذر تحميل مجموعات الأصناف')).not.toBeInTheDocument();
  });

  it('keeps valid category UI visible when the post-save refresh fails', async () => {
    (getProductCategoriesAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: false, error: 'refresh failed' });

    render(<CategoriesPage />);

    await screen.findByText('شجرة المجموعات');
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'مجموعة جديدة' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ المجموعة/ }));

    await waitFor(() => expect(addProductCategoryAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getProductCategoriesAction).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('تعذر تحميل مجموعات الأصناف')).not.toBeInTheDocument();
    expect(await screen.findByText('مجموعة جديدة')).toBeInTheDocument();
  });
});
