import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';
import DbMaintenance from '@/components/settings/DbMaintenance';

jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  isOwnerOrAdmin: (user: { role?: string } | null) => ['owner', 'admin'].includes(user?.role || ''),
}));
jest.mock('@/lib/settings/client', () => ({ runDatabaseMaintenanceClient: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'admin-id', role: 'admin' });
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
