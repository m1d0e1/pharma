import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import {
  enrollInitialOwnerAction,
  getOwnerEnrollmentStatusAction,
  loginLocalAction,
} from '@/app/actions-client/auth';
import LoginPage from '@/app/login/page';
import { dbSelect, dbExecute } from '@/lib/db/tauri';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), } }));
jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));
jest.mock('@/lib/sync/universal', () => ({ syncFromCloud: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => null),
  loginLocal: jest.fn(async () => ({ success: false, error: 'blocked' })),
  logoutLocal: jest.fn(),
}));
jest.mock('@/lib/auth/staff-policy', () => ({ isStaffOwner: jest.fn(() => false) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbExecute: jest.fn(), dbGet: jest.fn(), dbTransaction: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));

const nativeInvoke = invoke as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === 'owner_enrollment_status') return true;
    if (command === 'enroll_initial_owner') return undefined;
    throw new Error('Unexpected native command');
  });
});

it('routes first-install status and owner enrollment only through fixed native IPC', async () => {
  expect(await getOwnerEnrollmentStatusAction()).toEqual({ success: true, pending: true });
  const proof = 'X'.repeat(43);
  expect(await enrollInitialOwnerAction(proof, 'S3cure!OwnerPass2026')).toEqual({ success: true });
  expect(nativeInvoke).toHaveBeenNthCalledWith(1, 'owner_enrollment_status');
  expect(nativeInvoke).toHaveBeenNthCalledWith(2, 'enroll_initial_owner', {
    activationCode: proof, newPassword: 'S3cure!OwnerPass2026',
  });
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
});

it('fails closed when native status is malformed or enrollment proof is rejected', async () => {
  nativeInvoke.mockResolvedValueOnce('false');
  expect(await getOwnerEnrollmentStatusAction()).toMatchObject({ success: false, pending: true });
  nativeInvoke.mockRejectedValueOnce(new Error('Operator activation proof rejected'));
  expect(await enrollInitialOwnerAction('wrong', 'S3cure!OwnerPass2026')).toEqual({
    success: false, error: 'Operator activation proof rejected',
  });
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
});

it('shows enrollment rather than login, requires re-entry and leaves session empty on success', async () => {
  render(<LoginPage />);
  expect(await screen.findByLabelText('رمز تفعيل الترخيص')).toBeInTheDocument();
  expect(screen.queryByLabelText('اسم المستخدم / البريد')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('رمز تفعيل الترخيص'), { target: { value: 'Q'.repeat(43) } });
  fireEvent.change(screen.getByLabelText(/كلمة مرور جديدة/), { target: { value: 'S3cure!OwnerPass2026' } });
  fireEvent.change(screen.getByLabelText('تأكيد كلمة المرور'), { target: { value: 'S3cure!OwnerPass2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'إعداد المالك' }));
  await waitFor(() => expect(nativeInvoke).toHaveBeenCalledWith('enroll_initial_owner', {
    activationCode: 'Q'.repeat(43), newPassword: 'S3cure!OwnerPass2026',
  }));
  expect(await screen.findByLabelText('اسم المستخدم / البريد')).toBeInTheDocument();
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
  expect(replace).not.toHaveBeenCalled();
});

it('lets a signed-offline first-time customer leave the online activation code empty', async () => {
  render(<LoginPage />);
  const code = await screen.findByLabelText('رمز تفعيل الترخيص');
  expect(code).not.toBeRequired();
  expect(screen.getByText(/اترك هذا الحقل فارغاً فقط عند استخدام ترخيص دون اتصال/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/كلمة مرور جديدة/), { target: { value: 'S3cure!OwnerOffline2026' } });
  fireEvent.change(screen.getByLabelText('تأكيد كلمة المرور'), { target: { value: 'S3cure!OwnerOffline2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'إعداد المالك' }));
  await waitFor(() => expect(nativeInvoke).toHaveBeenCalledWith('enroll_initial_owner', {
    activationCode: '', newPassword: 'S3cure!OwnerOffline2026',
  }));
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
  expect(screen.queryByLabelText('رمز تفعيل الترخيص')).not.toBeInTheDocument();
});

it('retains the setup gate after invalid activation proof; does not silently login', async () => {
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === 'owner_enrollment_status') return true;
    throw new Error('Operator activation proof rejected');
  });
  render(<LoginPage />);
  fireEvent.change(await screen.findByLabelText('رمز تفعيل الترخيص'), { target: { value: 'X'.repeat(43) } });
  fireEvent.change(screen.getByLabelText(/كلمة مرور جديدة/), { target: { value: 'S3cure!OwnerPass2026' } });
  fireEvent.change(screen.getByLabelText('تأكيد كلمة المرور'), { target: { value: 'S3cure!OwnerPass2026' } });
  fireEvent.click(screen.getByRole('button', { name: 'إعداد المالك' }));
  expect(await screen.findByText('Operator activation proof rejected')).toBeInTheDocument();
  expect(screen.queryByLabelText('اسم المستخدم / البريد')).not.toBeInTheDocument();
  expect(localStorage.getItem('pharma_session_user')).toBeNull();
  expect(replace).not.toHaveBeenCalled();
});
