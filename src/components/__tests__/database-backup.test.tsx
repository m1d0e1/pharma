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
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-id', role: 'owner' });
  (dbGet as jest.Mock).mockResolvedValue(null);
});

it('shows the persisted local automatic-repair result in Settings', async () => {
  (dbGet as jest.Mock).mockResolvedValue({ value: 'اكتمل التصحيح المحلي: 4 سجل دواء و3 سعر مخزون', backup_path: 'C:/data/backups/before-repair.db' });
  render(<DbMaintenance />);
  expect(await screen.findByRole('note', { name: 'حالة التصحيح المحلي' })).toHaveTextContent('4 سجل دواء و3 سعر مخزون');
  expect(screen.getByRole('note')).toHaveTextContent('C:/data/backups/before-repair.db');
});

it('surfaces ambiguous legacy patient-wallet history without claiming an automatic balance repair', async () => {
  (dbGet as jest.Mock).mockResolvedValue({
    value: null,
    backup_path: null,
    wallet_review: 'تم اكتشاف رصيد محفظة تاريخي يحتاج مراجعة للعميل Legacy Patient (#legacy-patient): 40.00 ج.م',
  });
  render(<DbMaintenance />);

  const note = await screen.findByRole('note', { name: 'مراجعة محافظ العملاء القديمة' });
  expect(note).toHaveTextContent('Legacy Patient');
  expect(note).toHaveTextContent('40.00');
  expect(note).toHaveTextContent('يحتاج مراجعة');
});

it('exports a complete database through Tauri and shows the resulting path', async () => {
  (invoke as jest.Mock).mockResolvedValue('C:/data/backups/snapshot/pharma_local.db');
  render(<DbMaintenance />);
  expect(screen.getByRole('heading', { name: 'النسخ الاحتياطي وصيانة قاعدة البيانات' })).toBeInTheDocument();
  const button = await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'test-password' } });
  fireEvent.click(button);
  expect(await screen.findByRole('status')).toHaveTextContent('C:/data/backups/snapshot/pharma_local.db');
  expect(screen.getByRole('status')).toHaveTextContent('backup_manifest.json');
  expect(invoke).toHaveBeenCalledWith('export_database_backup', { userId: 'owner-id', password: 'test-password' });
});

it('hides system-wide backup and owner-only database maintenance from branch administrators', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'admin-id', role: 'admin' });
  render(<DbMaintenance />);
  await waitFor(() => expect(getClientSession).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: 'حفظ نسخة احتياطية كاملة' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' })).toBeNull();
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
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-id', role: 'owner' });
  let resolveMaintenance!: (value: { success: boolean; message?: string }) => void;
  (runDatabaseMaintenanceClient as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
    resolveMaintenance = resolve;
  }));
  render(<DbMaintenance />);

  const button = await screen.findByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' });
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
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-id', role: 'owner' });
  (runDatabaseMaintenanceClient as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'تعذر تنفيذ VACUUM' })
    .mockRejectedValueOnce(new Error('maintenance bridge unavailable'));
  render(<DbMaintenance />);

  const button = await screen.findByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' });
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

it('verifies a native-created backup by UUID only, never by a renderer file path or claimed actor', async () => {
  const backupId = '12345678-1234-4234-8234-123456789abc';
  (invoke as jest.Mock)
    .mockResolvedValueOnce(`C:\\app\\backups\\${backupId}\\pharma_local.db`)
    .mockResolvedValueOnce({
      status: 'verified_read_only_preview', backupId, sourceName: 'pharma_local.db',
      sizeBytes: 1300, createdUnixMs: 1, createdByOwner: 'owner-id', sha256: 'a'.repeat(64),
      warning: 'Verification only; not authorization to restore. SHA256 is not a signature.',
    });
  render(<DbMaintenance />);
  await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
  const password = screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي');
  fireEvent.change(password, { target: { value: 'owner-pass' } });
  fireEvent.click(await screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' }));
  expect(await screen.findByRole('status')).toHaveTextContent(backupId);
  expect(screen.getByLabelText('معرّف النسخة الاحتياطية')).toHaveValue(backupId);

  fireEvent.change(password, { target: { value: 'fresh-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
  const result = await screen.findByRole('status', { name: 'نتيجة فحص النسخة' });
  expect(result).toHaveTextContent('not authorization to restore');
  expect(invoke).toHaveBeenNthCalledWith(2, 'verify_database_backup_recovery_preview', {
    backupId, password: 'fresh-pass',
  });
  expect((invoke as jest.Mock).mock.calls[1][1]).not.toHaveProperty('userId');
  expect((invoke as jest.Mock).mock.calls[1][1]).not.toHaveProperty('path');
  expect(password).toHaveValue('');
});

it('rejects a downgraded native preview response without claiming backup verification', async () => {
  const backupId = '12345678-1234-4234-8234-123456789abc';
  (invoke as jest.Mock).mockResolvedValue({
    status: 'unknown', backupId, warning: 'untrusted response',
  });
  render(<DbMaintenance />);
  await screen.findByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' });
  fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), { target: { value: backupId } });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'owner-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة' })).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
});

it('requires an owner at native backup preview invocation time, even after a UI role change', async () => {
  render(<DbMaintenance />);
  const button = await screen.findByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' });
  fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), { target: { value: '12345678-1234-4234-8234-123456789abc' } });
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), { target: { value: 'owner-pass' } });
  (getClientSession as jest.Mock).mockResolvedValue({ id: 'branch-admin', role: 'admin' });
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalled();
});

it('stages an owner-only recovery rehearsal by two UUIDs and password without a live DB path or user claim', async () => {
  const backupId = '12345678-1234-4234-8234-123456789abc';
  const requestId = 'aabbccdd-1234-4234-8234-123456789abc';
  (invoke as jest.Mock)
    .mockResolvedValueOnce({ status: 'verified_read_only_preview', backupId,
      sha256: 'a'.repeat(64), sizeBytes: 1024, sourceName: 'pharma_local.db',
      createdUnixMs: 1, createdByOwner: 'owner-id', warning: 'Verification only' })
    .mockResolvedValueOnce({ status: 'verified_isolated_copy_only', backupId, requestId,
      sha256: 'a'.repeat(64), sizeBytes: 1024, migrationCount: 39,
      warning: 'No restore was performed; origin not signed' });
  render(<DbMaintenance />);
  await screen.findByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' });
  const password = screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي');
  fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), { target: { value: backupId } });
  fireEvent.change(password, { target: { value: 'fresh-owner' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
  await screen.findByRole('status', { name: 'نتيجة فحص النسخة' });
  fireEvent.change(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)'), { target: { value: requestId } });
  fireEvent.change(password, { target: { value: 'owner-reconfirmed' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' }));
  const result = await screen.findByRole('status', { name: 'نتيجة فحص النسخة المعزولة' });
  expect(result).toHaveTextContent(requestId);
  expect(result).toHaveTextContent('No restore was performed');
  expect(invoke).toHaveBeenNthCalledWith(2, 'stage_database_recovery_rehearsal_native', {
    backupId, requestId, password: 'owner-reconfirmed',
  });
  expect((invoke as jest.Mock).mock.calls[1][1]).not.toHaveProperty('path');
  expect((invoke as jest.Mock).mock.calls[1][1]).not.toHaveProperty('userId');
  expect(password).toHaveValue('');
});

it('treats interrupted/replayed staging and account switching as failure, retaining the request nonce', async () => {
  const backupId = '12345678-1234-4234-8234-123456789abc';
  const requestId = 'aabbccdd-1234-4234-8234-123456789abc';
  (invoke as jest.Mock)
    .mockResolvedValueOnce({ status: 'verified_read_only_preview', backupId,
      sha256: 'b'.repeat(64), sizeBytes: 1024, warning: 'Verification only' })
    .mockRejectedValueOnce(new Error('Recovery request ID already used'));
  render(<DbMaintenance />);
  await screen.findByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' });
  const password = screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي');
  fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), { target: { value: backupId } });
  fireEvent.change(password, { target: { value: 'correct-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
  await screen.findByRole('status', { name: 'نتيجة فحص النسخة' });
  fireEvent.change(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)'), { target: { value: requestId } });
  fireEvent.change(password, { target: { value: 'correct-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('already used')));
  expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة المعزولة' })).toBeNull();
  expect(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)')).toHaveValue(requestId);
  expect(password).toHaveValue('');

  (getClientSession as jest.Mock).mockResolvedValue({ id: 'other', role: 'admin' });
  fireEvent.change(password, { target: { value: 'another-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('runs owner-only financial source reconciliation without renderer SQL, actor or pharmacy claims', async () => {
  (invoke as jest.Mock).mockResolvedValueOnce({
    status: 'review_required', scannedJournals: 19, unverifiableLegacyJournals: 3,
    stockProvenance: { recorded: 3, structurallyVerified: 2, reviewRequired: 1, unattributedAdjustments: 14 },
    maxFindings: 200, findings: [{ sourceType: 'purchase_journal_claim', recordId: 'journal-1',
      issueCode: 'purchase_claim_scope_conflict', classification: 'source_claim_conflict' }],
  });
  render(<DbMaintenance />);
  const button = await screen.findByRole('button', { name: 'فحص مرجعيات السجل المالي فقط' });
  fireEvent.click(button);
  const result = await screen.findByRole('status', { name: 'نتيجة مراجعة المرجعيات المالية' });
  expect(result).toHaveTextContent('19');
  expect(result).toHaveTextContent('purchase_claim_scope_conflict');
  expect(result).toHaveTextContent('تسويات دون إثبات 040: 14');
  expect(result).toHaveTextContent('مراجعة مالية بشرية');
  expect(invoke).toHaveBeenCalledWith('reconcile_financial_sources_native');
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('does not claim clean financial history on a malformed result or after owner revocation', async () => {
  (invoke as jest.Mock).mockResolvedValue({
    status: 'limited_no_findings', scannedJournals: 5, unverifiableLegacyJournals: 0,
    findings: Array.from({ length: 201 }, (_, index) => ({ recordId: String(index) })),
  });
  render(<DbMaintenance />);
  const button = await screen.findByRole('button', { name: 'فحص مرجعيات السجل المالي فقط' });
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(screen.queryByRole('status', { name: 'نتيجة مراجعة المرجعيات المالية' })).toBeNull();

  (getClientSession as jest.Mock).mockResolvedValue({ id: 'branch-manager', role: 'admin' });
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
  expect(invoke).toHaveBeenCalledTimes(1);
});
