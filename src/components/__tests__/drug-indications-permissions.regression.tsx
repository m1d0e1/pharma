import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DrugIndicationsClient from '@/components/inventory/DrugIndicationsClient';
import { dbExecute, dbSelect } from '@/lib/db/tauri';
import { addDrugIndicationAction, deleteDrugIndicationAction } from '@/app/actions-client/master-drugs';

let mockUser: any;

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn(), dbExecute: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  addDrugIndicationAction: jest.fn(),
  deleteDrugIndicationAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
  Toaster: () => null,
}));

const indications = [{ id: 7, name_ar: 'الصداع', name_en: 'Headache' }];
const drug = { id: 11, trade_name: 'Panadol', official_price: 20, manufacturer: 'Test' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('drug indication mutation permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'viewer', role: 'admin', permissions: { can_view_drug_indications: true } };
    (dbSelect as jest.Mock).mockResolvedValue([]);
    (addDrugIndicationAction as jest.Mock).mockResolvedValue({ success: true });
    (deleteDrugIndicationAction as jest.Mock).mockResolvedValue({ success: true });
  });

  it('keeps linked drugs readable but hides link mutation controls for view-only users', async () => {
    render(<DrugIndicationsClient indications={indications} />);
    await waitFor(() => expect(dbSelect).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText('ابحث عن دواء لربطه...')).not.toBeInTheDocument();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('routes add and remove through permission-checked actions instead of direct database writes', async () => {
    mockUser = { id: 'owner', role: 'owner' };
    let linked = false;
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('JOIN drug_indications')) return linked ? [drug] : [];
      if (sql.includes('SELECT * FROM master_drugs')) return [drug];
      return [];
    });
    (addDrugIndicationAction as jest.Mock).mockImplementation(async () => {
      linked = true;
      return { success: true };
    });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(<DrugIndicationsClient indications={indications} />);
    await screen.findByPlaceholderText('ابحث عن دواء لربطه...');
    fireEvent.change(screen.getByPlaceholderText('ابحث عن دواء لربطه...'), { target: { value: 'Pa' } });
    fireEvent.click(await screen.findByRole('button', { name: 'ربط Panadol' }));
    await waitFor(() => expect(addDrugIndicationAction).toHaveBeenCalledWith(11, 7));
    fireEvent.click(await screen.findByRole('button', { name: 'حذف ربط Panadol' }));
    await waitFor(() => expect(deleteDrugIndicationAction).toHaveBeenCalledWith(11, 7));
    expect(dbExecute).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('keeps linked drugs scoped to the newest selected indication when an older load resolves later', async () => {
    const twoIndications = [
      ...indications,
      { id: 8, name_ar: 'السعال', name_en: 'Cough' },
    ];
    const older = deferred<any[]>();
    const newer = deferred<any[]>();
    const oldDrug = { ...drug, id: 21, trade_name: 'Old Indication Drug' };
    const newDrug = { ...drug, id: 22, trade_name: 'New Indication Drug' };
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('JOIN drug_indications')) return [];
      if (params?.[0] === 7) return older.promise;
      if (params?.[0] === 8) return newer.promise;
      return [];
    });

    render(<DrugIndicationsClient indications={twoIndications} />);
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('JOIN drug_indications'), [7]));
    fireEvent.click(screen.getByRole('button', { name: /السعال/ }));
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('JOIN drug_indications'), [8]));

    newer.resolve([newDrug]);
    expect(await screen.findByText('New Indication Drug')).toBeInTheDocument();

    await act(async () => {
      older.resolve([oldDrug]);
      await older.promise;
    });
    expect(screen.queryByText('Old Indication Drug')).not.toBeInTheDocument();
    expect(screen.getByText('New Indication Drug')).toBeInTheDocument();
  });

  it('keeps the newest drug search results when an older search resolves later', async () => {
    mockUser = { id: 'owner', role: 'owner' };
    const older = deferred<any[]>();
    const newer = deferred<any[]>();
    const oldDrug = { ...drug, id: 31, trade_name: 'Old Search Drug' };
    const newDrug = { ...drug, id: 32, trade_name: 'New Search Drug' };
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('JOIN drug_indications')) return [];
      if (sql.includes('SELECT * FROM master_drugs')) {
        if (params?.[0] === '%Pa%') return older.promise;
        if (params?.[0] === '%Ib%') return newer.promise;
      }
      return [];
    });

    render(<DrugIndicationsClient indications={indications} />);
    const search = await screen.findByPlaceholderText('ابحث عن دواء لربطه...');
    fireEvent.change(search, { target: { value: 'Pa' } });
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM master_drugs'), ['%Pa%', '%Pa%', '%Pa%', '%Pa%']));
    fireEvent.change(search, { target: { value: 'Ib' } });
    await waitFor(() => expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM master_drugs'), ['%Ib%', '%Ib%', '%Ib%', '%Ib%']));

    newer.resolve([newDrug]);
    expect(await screen.findByText('New Search Drug')).toBeInTheDocument();

    await act(async () => {
      older.resolve([oldDrug]);
      await older.promise;
    });
    expect(screen.queryByText('Old Search Drug')).not.toBeInTheDocument();
    expect(screen.getByText('New Search Drug')).toBeInTheDocument();
  });

  it('does not add the same indication link twice while the first mutation is pending', async () => {
    mockUser = { id: 'owner', role: 'owner' };
    const pending = deferred<any>();
    (addDrugIndicationAction as jest.Mock).mockImplementation(() => pending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('JOIN drug_indications')) return [];
      if (sql.includes('SELECT * FROM master_drugs')) return [drug];
      return [];
    });

    render(<DrugIndicationsClient indications={indications} />);
    const search = await screen.findByPlaceholderText('ابحث عن دواء لربطه...');
    fireEvent.change(search, { target: { value: 'Pa' } });
    const add = await screen.findByRole('button', { name: 'ربط Panadol' });
    fireEvent.click(add);
    fireEvent.click(add);

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => {
      await pending.promise;
    });
    expect(addDrugIndicationAction).toHaveBeenCalledTimes(1);
  });

  it('does not remove the same indication link twice while the first mutation is pending', async () => {
    mockUser = { id: 'owner', role: 'owner' };
    const pending = deferred<any>();
    (deleteDrugIndicationAction as jest.Mock).mockImplementation(() => pending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string) => {
      if (sql.includes('JOIN drug_indications')) return [drug];
      return [];
    });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(<DrugIndicationsClient indications={indications} />);
    const remove = await screen.findByRole('button', { name: 'حذف ربط Panadol' });
    fireEvent.click(remove);
    fireEvent.click(remove);

    pending.resolve({ success: false, error: 'stop' });
    await act(async () => {
      await pending.promise;
    });
    expect(deleteDrugIndicationAction).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('does not refresh an old indication after a pending link succeeds following a selection change', async () => {
    mockUser = { id: 'owner', role: 'owner' };
    const twoIndications = [
      ...indications,
      { id: 8, name_ar: 'السعال', name_en: 'Cough' },
    ];
    const pending = deferred<any>();
    const oldDrug = { ...drug, id: 41, trade_name: 'Old Selection Drug' };
    const newDrug = { ...drug, id: 42, trade_name: 'Current Selection Drug' };
    let id7Loads = 0;
    (addDrugIndicationAction as jest.Mock).mockImplementation(() => pending.promise);
    (dbSelect as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('JOIN drug_indications')) {
        if (params?.[0] === 7) {
          id7Loads += 1;
          return id7Loads === 1 ? [] : [oldDrug];
        }
        if (params?.[0] === 8) return [newDrug];
      }
      if (sql.includes('SELECT * FROM master_drugs')) return [drug];
      return [];
    });

    render(<DrugIndicationsClient indications={twoIndications} />);
    const search = await screen.findByPlaceholderText('ابحث عن دواء لربطه...');
    fireEvent.change(search, { target: { value: 'Pa' } });
    fireEvent.click(await screen.findByRole('button', { name: 'ربط Panadol' }));
    fireEvent.click(screen.getByRole('button', { name: /السعال/ }));
    expect(await screen.findByText('Current Selection Drug')).toBeInTheDocument();

    pending.resolve({ success: true });
    await act(async () => {
      await pending.promise;
    });
    await waitFor(() => expect(addDrugIndicationAction).toHaveBeenCalledWith(11, 7));
    await act(async () => undefined);

    expect(screen.queryByText('Old Selection Drug')).not.toBeInTheDocument();
    expect(screen.getByText('Current Selection Drug')).toBeInTheDocument();
  });
});
