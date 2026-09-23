import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DrugAlternativesClient from '@/components/inventory/DrugAlternativesClient';
import { dbSelect } from '@/lib/db/tauri';
import {
  addDrugAlternativeAction,
  addDrugInteractionAction,
  removeDrugAlternativeAction,
  removeDrugInteractionAction,
} from '@/app/actions-client/master-drugs';

let mockUser: any = { id: 'user-1', role: 'owner', pharmacy_id: 'ph-1' };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbExecute: jest.fn().mockResolvedValue({ rowsAffected: 1 }),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  addDrugAlternativeAction: jest.fn().mockResolvedValue({ success: true }),
  removeDrugAlternativeAction: jest.fn().mockResolvedValue({ success: true }),
  addDrugInteractionAction: jest.fn().mockResolvedValue({ success: true }),
  removeDrugInteractionAction: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
  Toaster: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('DrugAlternativesClient branch stock scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'user-1', role: 'owner', pharmacy_id: 'ph-1' };
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM master_drugs')) {
        return [{ id: 10, trade_name: 'Drug A', active_ingredient: 'ING-A' }];
      }
      return [];
    });
  });

  it('keeps alternatives chain-wide while scoping total_stock to the signed-in pharmacy', async () => {
    render(<DrugAlternativesClient />);

    fireEvent.change(screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...'), {
      target: { value: 'Drug' },
    });
    const result = await screen.findByText('Drug A');
    fireEvent.click(result.closest('button')!);

    await waitFor(() => expect((dbSelect as jest.Mock).mock.calls.some(([sql]) =>
      String(sql).includes('(SELECT SUM(quantity) FROM inventory')
    )).toBe(true));

    const stockCall = (dbSelect as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('(SELECT SUM(quantity) FROM inventory')
    );
    expect(String(stockCall![0])).toContain("pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default')");
    expect(stockCall![1]).toEqual(['ING-A', 'ph-1', 'ph-1', 'ING-A', 10, 10, 10]);
  });

  it('keeps alternatives readable but hides mutation controls without can_manage_inventory', async () => {
    mockUser = { id: 'viewer-1', role: 'admin', pharmacy_id: 'ph-1', permissions: { can_view_alternatives: true } };
    render(<DrugAlternativesClient />);

    fireEvent.change(screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...'), {
      target: { value: 'Drug' },
    });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);

    await screen.findByText('قائمة البدائل الدوائية');
    expect(screen.queryByRole('button', { name: /إضافة بديل/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'الأغذية' }));
    expect(screen.queryByRole('button', { name: /إضافة التعارض الغذائي/ })).not.toBeInTheDocument();
  });

  it('keeps the newest main drug search when an older debounced request resolves later', async () => {
    const older = deferred<any[]>();
    const newer = deferred<any[]>();
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('SELECT * FROM master_drugs')) return [];
      if (params?.[0] === '%Old%') return older.promise;
      if (params?.[0] === '%New%') return newer.promise;
      return [];
    });

    render(<DrugAlternativesClient />);
    const search = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(search, { target: { value: 'Old' } });
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM master_drugs'), ['%Old%', '%Old%', '%Old%', '%Old%']));
    fireEvent.change(search, { target: { value: 'New' } });
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM master_drugs'), ['%New%', '%New%', '%New%', '%New%']));

    newer.resolve([{ id: 20, trade_name: 'New Search Drug', active_ingredient: '' }]);
    expect(await screen.findByText('New Search Drug')).toBeInTheDocument();

    await act(async () => {
      older.resolve([{ id: 10, trade_name: 'Old Search Drug', active_ingredient: '' }]);
      await older.promise;
    });
    expect(screen.queryByText('Old Search Drug')).not.toBeInTheDocument();
    expect(screen.getByText('New Search Drug')).toBeInTheDocument();
  });

  it('keeps detail state for the newest selected drug when the prior selection finishes later', async () => {
    const oldDetails = deferred<any[]>();
    const newDetails = deferred<any[]>();
    const drugA = { id: 10, trade_name: 'Drug A', active_ingredient: '' };
    const drugB = { id: 20, trade_name: 'Drug B', active_ingredient: '' };
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM master_drugs')) return [drugA, drugB];
      if (sql.includes('(SELECT SUM(quantity) FROM inventory')) {
        if (params?.[4] === 10) return oldDetails.promise;
        if (params?.[4] === 20) return newDetails.promise;
      }
      return [];
    });

    render(<DrugAlternativesClient />);
    const search = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(search, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);
    await screen.findByRole('heading', { name: 'Drug A' });

    fireEvent.change(search, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug B')).closest('button')!);
    await screen.findByRole('heading', { name: 'Drug B' });

    newDetails.resolve([{ id: 22, trade_name: 'New Drug Alternative', active_ingredient: '', total_stock: 3 }]);
    expect(await screen.findByText('New Drug Alternative')).toBeInTheDocument();
    await act(async () => {
      oldDetails.resolve([{ id: 11, trade_name: 'Old Drug Alternative', active_ingredient: '', total_stock: 2 }]);
      await oldDetails.promise;
    });
    expect(screen.queryByText('Old Drug Alternative')).not.toBeInTheDocument();
    expect(screen.getByText('New Drug Alternative')).toBeInTheDocument();
  });

  it('does not add the same manual alternative twice while the first mutation is pending', async () => {
    const pending = deferred<any>();
    const base = { id: 10, trade_name: 'Drug A', active_ingredient: '' };
    const alt = { id: 20, trade_name: 'Alt Drug', active_ingredient: '' };
    (addDrugAlternativeAction as jest.Mock).mockImplementation(() => pending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM master_drugs')) {
        return params?.[0] === '%Alt%' ? [alt] : [base];
      }
      return [];
    });

    render(<DrugAlternativesClient />);
    const mainSearch = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(mainSearch, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);
    await screen.findByRole('heading', { name: 'Drug A' });
    fireEvent.click(screen.getByRole('button', { name: /إضافة بديل/ }));
    const altSearch = screen.getByPlaceholderText('ابحث عن الصنف البديل...');
    fireEvent.change(altSearch, { target: { value: 'Alt' } });
    const add = await screen.findByRole('button', { name: 'إضافة كبديل' });
    fireEvent.click(add);
    fireEvent.click(add);

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => { await pending.promise; });
    expect(addDrugAlternativeAction).toHaveBeenCalledTimes(1);
  });

  it('does not remove the same manual alternative twice while the first mutation is pending', async () => {
    const pending = deferred<any>();
    const base = { id: 10, trade_name: 'Drug A', active_ingredient: '' };
    const alt = { id: 20, trade_name: 'Manual Alt', active_ingredient: '', is_auto: 0, total_stock: 0 };
    (removeDrugAlternativeAction as jest.Mock).mockImplementation(() => pending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM master_drugs')) return [base];
      if (sql.includes('(SELECT SUM(quantity) FROM inventory')) return [alt];
      return [];
    });

    render(<DrugAlternativesClient />);
    const search = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(search, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);
    expect(await screen.findByText('Manual Alt')).toBeInTheDocument();
    const remove = screen.getByTitle('حذف البديل');
    fireEvent.click(remove);
    fireEvent.click(remove);

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => { await pending.promise; });
    expect(removeDrugAlternativeAction).toHaveBeenCalledTimes(1);
  });

  it('guards same-tick food interaction add and remove mutations', async () => {
    const addPending = deferred<any>();
    const removePending = deferred<any>();
    const base = { id: 10, trade_name: 'Drug A', active_ingredient: 'ING-A' };
    const food = { id: 70, ingredient_a: 'ING-A', ingredient_b: 'Milk', severity: 'food' };
    (addDrugInteractionAction as jest.Mock).mockImplementation(() => addPending.promise);
    (removeDrugInteractionAction as jest.Mock).mockImplementation(() => removePending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM master_drugs')) return [base];
      if (sql.includes('FROM drug_interactions')) return [food];
      return [];
    });

    render(<DrugAlternativesClient />);
    const search = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(search, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);
    await screen.findByRole('heading', { name: 'Drug A' });
    fireEvent.click(screen.getByRole('button', { name: 'الأغذية' }));
    expect(await screen.findByText('Milk')).toBeInTheDocument();

    const foodInput = screen.getByPlaceholderText('مثال: الحليب، الجريب فروت...');
    fireEvent.change(foodInput, { target: { value: 'Grapefruit' } });
    const addFood = screen.getByRole('button', { name: 'إضافة التعارض الغذائي' });
    fireEvent.click(addFood);
    fireEvent.click(addFood);
    expect(addDrugInteractionAction).toHaveBeenCalledTimes(1);
    addPending.resolve({ success: false, error: 'stop' });
    await act(async () => { await addPending.promise; });

    const foodCard = screen.getByText('Milk').closest('div')?.parentElement?.parentElement;
    expect(foodCard).toBeTruthy();
    const removeFood = foodCard!.querySelector('button') as HTMLButtonElement;
    fireEvent.click(removeFood);
    fireEvent.click(removeFood);
    removePending.resolve({ success: false, error: 'stop' });
    await act(async () => { await removePending.promise; });
    expect(removeDrugInteractionAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest alternative-modal search when an older request resolves later', async () => {
    const older = deferred<any[]>();
    const newer = deferred<any[]>();
    const base = { id: 10, trade_name: 'Drug A', active_ingredient: '' };
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM master_drugs')) {
        if (params?.[0] === '%Drug%') return [base];
        if (params?.[0] === '%Old%') return older.promise;
        if (params?.[0] === '%New%') return newer.promise;
      }
      return [];
    });

    render(<DrugAlternativesClient />);
    const mainSearch = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(mainSearch, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);
    await screen.findByRole('heading', { name: 'Drug A' });
    fireEvent.click(screen.getByRole('button', { name: /إضافة بديل/ }));

    const altSearch = screen.getByPlaceholderText('ابحث عن الصنف البديل...');
    fireEvent.change(altSearch, { target: { value: 'Old' } });
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM master_drugs'), ['%Old%', '%Old%', '%Old%', '%Old%']));
    fireEvent.change(altSearch, { target: { value: 'New' } });
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM master_drugs'), ['%New%', '%New%', '%New%', '%New%']));

    newer.resolve([{ id: 30, trade_name: 'New Alternative Search', active_ingredient: '' }]);
    expect(await screen.findByText('New Alternative Search')).toBeInTheDocument();
    await act(async () => {
      older.resolve([{ id: 31, trade_name: 'Old Alternative Search', active_ingredient: '' }]);
      await older.promise;
    });
    expect(screen.queryByText('Old Alternative Search')).not.toBeInTheDocument();
    expect(screen.getByText('New Alternative Search')).toBeInTheDocument();
  });

  it('does not remove the same food interaction twice while the first mutation is pending', async () => {
    const pending = deferred<any>();
    const base = { id: 10, trade_name: 'Drug A', active_ingredient: 'ING-A' };
    const food = { id: 70, ingredient_a: 'ING-A', ingredient_b: 'Milk', severity: 'food' };
    (removeDrugInteractionAction as jest.Mock).mockImplementation(() => pending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM master_drugs')) return [base];
      if (sql.includes('FROM drug_interactions')) return [food];
      return [];
    });

    render(<DrugAlternativesClient />);
    const search = screen.getByPlaceholderText('ابحث عن الصنف لربط البدائل به...');
    fireEvent.change(search, { target: { value: 'Drug' } });
    fireEvent.click((await screen.findByText('Drug A')).closest('button')!);
    await screen.findByRole('heading', { name: 'Drug A' });
    fireEvent.click(screen.getByRole('button', { name: 'الأغذية' }));
    const milk = await screen.findByText('Milk');
    const foodCard = milk.closest('div')?.parentElement?.parentElement;
    expect(foodCard).toBeTruthy();
    const remove = foodCard!.querySelector('button') as HTMLButtonElement;
    fireEvent.click(remove);
    fireEvent.click(remove);

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => { await pending.promise; });
    expect(removeDrugInteractionAction).toHaveBeenCalledTimes(1);
  });
});
