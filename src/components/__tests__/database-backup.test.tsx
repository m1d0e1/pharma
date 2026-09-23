import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';
import DbMaintenance from '@/components/settings/DbMaintenance';
import { dbGet } from '@/lib/db/tauri';
import { runDatabaseMaintenanceClient } from '@/lib/settings/client';

jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn() }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  isOwnerOrAdmin: (user: { role?: string } | null) => ['owner', 'admin'].includes(user?.role || ''),
}));
jest.mock('@/lib/settings/client', () => ({ runDatabaseMaintenanceClient: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    loading: jest.fn(() => 'maintenance-toast'),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'admin-id', role: 'admin' });
  (dbGet as jest.Mock).mockResolvedValue(null);
});

it('shows the persisted local automatic-repair result in Settings', async () => {
  (dbGet as jest.Mock).mockResolvedValue({ value: 'اكتمل التصحيح المحلي: 4 سجل دواء و3 سعر مخزون', backup_path: 'C:/data/backups/before-repair.db' });
  render(<DbMaintenance />);
  expect(await screen.findByRole('note', { name: 'حالة التصحيح المحلي' })).toHaveTextContent('4 سجل دواء و3 سعر مخزون');
  expect(screen.getByRole('note')).toHaveTextContent('C:/data/backups/before-repair.db');
});

it('exports a complete database through Tauri and shows the resulting path', async () => {
  (invoke as jest.Mock).mockResolvedValue('C:/data/backups/snapshot/pharma_local.db');
  render(<DbMaintenance />);
  expect(screen.getByRole('heading', { name: 'النسخ الاحتياطي وصيانة قاعدة البيانات' })).toBeInTheDocument();
  const button = await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'test-password' } });
  fireEvent.click(button);
  expect(await screen.findByRole('status')).toHaveTextContent('C:/data/backups/snapshot/pharma_local.db');
  expect(invoke).toHaveBeenCalledWith('export_database_backup', { userId: 'admin-id', password: 'test-password' });
});

it('does not claim success or display a backup path when SQLite refuses the snapshot', async () => {
  (invoke as jest.Mock).mockRejectedValue('Database integrity check failed');
  render(<DbMaintenance />);
  const button = await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'test-password' } });
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Database integrity check failed')));
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي')).toHaveValue('');
});

it('rechecks the user when exporting, even if the session changed after rendering', async () => {
  render(<DbMaintenance />);
  const button = await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'test-password' } });
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'cashier', role: 'cashier' });
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalled();
});

it('prevents duplicate maintenance runs while the first write-sensitive operation is pending', async () => {
  let resolveMaintenance!: (value: { success: boolean; message?: string }) => void;
  (runDatabaseMaintenanceClient as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
    resolveMaintenance = resolve;
  }));
  render(<DbMaintenance />);

  const button = screen.getByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' });
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(runDatabaseMaintenanceClient).toHaveBeenCalledTimes(1);

  expect(screen.getByRole('button', { name: 'جاري تحسين قاعدة البيانات...' })).toBeDisabled();

  resolveMaintenance({ success: true, message: 'اكتملت الصيانة' });
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('اكتملت الصيانة', { id: 'maintenance-toast' }));
  expect(screen.getByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' })).toBeEnabled();
});

it('restores the maintenance control after returned and thrown failures', async () => {
  (runDatabaseMaintenanceClient as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'تعذر تنفيذ VACUUM' })
    .mockRejectedValueOnce(new Error('maintenance bridge unavailable'));
  render(<DbMaintenance />);

  const button = screen.getByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' });
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر تنفيذ VACUUM', { id: 'maintenance-toast' }));
  expect(button).toBeEnabled();

  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ غير متوقع أثناء تنفيذ الصيانة', { id: 'maintenance-toast' }));
  expect(button).toBeEnabled();
});

it('prevents duplicate backup exports while the first snapshot is pending', async () => {
  let resolveBackup: (value: string) => void = () => {};
  const pendingBackup = new Promise<string>(resolve => {
    resolveBackup = resolve;
  });
  (invoke as jest.Mock).mockReturnValue(pendingBackup);
  render(<DbMaintenance />);

  const button = await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'test-password' } });

  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveBackup('C:/data/backups/snapshot/pharma_local.db');
  });
  expect(await screen.findByRole('status')).toHaveTextContent('C:/data/backups/snapshot/pharma_local.db');
});
