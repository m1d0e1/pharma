import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { getClientSession } from '@/lib/auth/local';
import { runDatabaseMaintenanceClient } from '@/lib/settings/client';
import { dbGet } from '@/lib/db/tauri';
import { toast } from 'react-hot-toast';
import DbMaintenance from '@/components/settings/DbMaintenance';

// Never invoke a real backup, restore, database-maintenance, or reconciliation command.
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  isOwnerOrAdmin: (user: { role?: string } | null) => ['owner', 'admin'].includes(user?.role || ''),
}));
jest.mock('@/lib/settings/client', () => ({ runDatabaseMaintenanceClient: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn(), loading: jest.fn(() => 'qa-maintenance-toast') },
}));

const firstBackupId = '77777777-1111-4111-8111-222222222222';
const secondBackupId = '77777777-3333-4333-8333-444444444444';
const rehearsalId = '77777777-5555-4555-8555-666666666666';
const digest = 'd'.repeat(64);

function preview(backupId: string) {
  return {
    status: 'verified_read_only_preview', backupId,
    sourceName: 'pharma_local.db', sizeBytes: 2048,
    createdUnixMs: 1700000000000, createdByOwner: 'qa-settings-owner', sha256: digest,
    warning: 'Synthetic verification only; live restore unavailable',
  };
}

function rehearsal(requestId = rehearsalId, sha256 = digest) {
  return {
    status: 'verified_isolated_copy_only', requestId,
    backupId: firstBackupId, sha256, sizeBytes: 2048, migrationCount: 11,
    warning: 'Synthetic isolated copy only; no live database replaced',
  };
}

async function ownerForm() {
  render(<DbMaintenance />);
  return screen.findByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
}

function setPassword(value: string) {
  fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), {
    target: { value },
  });
}

async function verifyBackup(id: string, password: string) {
  fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), { target: { value: id } });
  setPassword(password);
  fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
  return screen.findByRole('status', { name: 'نتيجة فحص النسخة' });
}

describe('QA background: rendered owner backup identity, recovery and maintenance controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'qa-settings-owner', role: 'owner' });
    (dbGet as jest.Mock).mockResolvedValue(null);
  });

  it('invalidates an already verified backup when its UUID changes and requires a new preview before rehearsal', async () => {
    (invoke as jest.Mock)
      .mockResolvedValueOnce(preview(firstBackupId))
      .mockResolvedValueOnce(preview(secondBackupId));
    await ownerForm();

    expect(await verifyBackup(firstBackupId, 'synthetic-preview-1'))
      .toHaveTextContent(firstBackupId);
    expect(screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' }))
      .toBeDisabled();
    fireEvent.change(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)'), {
      target: { value: rehearsalId },
    });
    setPassword('synthetic-not-yet-used');
    expect(screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), {
      target: { value: secondBackupId },
    });
    expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' })).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
    expect(await screen.findByRole('status', { name: 'نتيجة فحص النسخة' })).toHaveTextContent(secondBackupId);
    expect(invoke).toHaveBeenNthCalledWith(1, 'verify_database_backup_recovery_preview', {
      backupId: firstBackupId, password: 'synthetic-preview-1',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'verify_database_backup_recovery_preview', {
      backupId: secondBackupId, password: 'synthetic-not-yet-used',
    });
    expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة المعزولة' })).not.toBeInTheDocument();
  });

  it('rejects a mismatched isolated-copy checksum, preserves the same rehearsal UUID and succeeds only on a matching retry', async () => {
    (invoke as jest.Mock)
      .mockResolvedValueOnce(preview(firstBackupId))
      .mockResolvedValueOnce(rehearsal(rehearsalId, 'f'.repeat(64)))
      .mockResolvedValueOnce(rehearsal());
    await ownerForm();
    await verifyBackup(firstBackupId, 'synthetic-verify-password');
    fireEvent.change(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)'), {
      target: { value: rehearsalId },
    });
    setPassword('synthetic-stage-first');
    const button = screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('لم تثبت سلامة النسخة المعزولة')));
    expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة المعزولة' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'نتيجة فحص النسخة' })).toHaveTextContent(firstBackupId);
    expect(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)')).toHaveValue(rehearsalId);
    expect(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي')).toHaveValue('');
    expect(button).toBeDisabled();

    setPassword('synthetic-stage-retry');
    fireEvent.click(button);
    expect(await screen.findByRole('status', { name: 'نتيجة فحص النسخة المعزولة' }))
      .toHaveTextContent('no live database replaced');
    expect(invoke).toHaveBeenNthCalledWith(2, 'stage_database_recovery_rehearsal_native', {
      backupId: firstBackupId, requestId: rehearsalId, password: 'synthetic-stage-first',
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'stage_database_recovery_rehearsal_native', {
      backupId: firstBackupId, requestId: rehearsalId, password: 'synthetic-stage-retry',
    });
    expect((invoke as jest.Mock).mock.calls.map(([command]) => command)).toEqual([
      'verify_database_backup_recovery_preview',
      'stage_database_recovery_rehearsal_native',
      'stage_database_recovery_rehearsal_native',
    ]);
  });

  it('locks maintenance, reconciliation and verification while a backup export is pending and does not repeat the export', async () => {
    let completeExport!: (path: string) => void;
    (invoke as jest.Mock).mockImplementation(() => new Promise<string>(resolve => { completeExport = resolve; }));
    await ownerForm();
    setPassword('synthetic-export-password');
    fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), {
      target: { value: firstBackupId },
    });
    const exportButton = screen.getByRole('button', { name: 'حفظ نسخة احتياطية كاملة' });
    act(() => {
      exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'جاري حفظ النسخة...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'فحص مرجعيات السجل المالي فقط' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' })).toBeDisabled();
    expect(runDatabaseMaintenanceClient).not.toHaveBeenCalled();

    await act(async () => completeExport(`C:/synthetic-only/backups/${firstBackupId}/pharma_local.db`));
    expect(await screen.findByRole('status')).toHaveTextContent(firstBackupId);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('export_database_backup', {
      userId: 'qa-settings-owner', password: 'synthetic-export-password',
    });
    expect(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تحسين وضغط قاعدة البيانات الآن' })).toBeEnabled();
  });

  it('rejects inconsistent provenance totals and accepts only a validated later read-only reconciliation', async () => {
    const valid = {
      status: 'limited_no_findings', scannedJournals: 8, unverifiableLegacyJournals: 2,
      stockProvenance: { recorded: 6, structurallyVerified: 5, reviewRequired: 1, unattributedAdjustments: 0 },
      maxFindings: 200, findings: [],
    };
    (invoke as jest.Mock)
      .mockResolvedValueOnce({ ...valid, stockProvenance: { ...valid.stockProvenance, reviewRequired: 2 } })
      .mockResolvedValueOnce(valid);
    await ownerForm();
    const reconcile = screen.getByRole('button', { name: 'فحص مرجعيات السجل المالي فقط' });
    fireEvent.click(reconcile);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('رد غير موثوق')));
    expect(screen.queryByRole('status', { name: 'نتيجة مراجعة المرجعيات المالية' })).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(reconcile).toBeEnabled();

    fireEvent.click(reconcile);
    const report = await screen.findByRole('status', { name: 'نتيجة مراجعة المرجعيات المالية' });
    expect(report).toHaveTextContent('قيود راجعها الفحص: 8');
    expect(report).toHaveTextContent('سليم بنيوياً من 6');
    expect(report).toHaveTextContent('هذا ليس شهادة مصادقة على التاريخ المالي');
    expect(invoke).toHaveBeenNthCalledWith(1, 'reconcile_financial_sources_native');
    expect(invoke).toHaveBeenNthCalledWith(2, 'reconcile_financial_sources_native');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(runDatabaseMaintenanceClient).not.toHaveBeenCalled();
  });

  it('rechecks owner authorization at rehearsal click after preview and does not use the prior session for recovery', async () => {
    (invoke as jest.Mock)
      .mockResolvedValueOnce(preview(firstBackupId))
      .mockResolvedValueOnce(rehearsal());
    await ownerForm();
    await verifyBackup(firstBackupId, 'synthetic-owner-verify');
    fireEvent.change(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)'), {
      target: { value: rehearsalId },
    });
    setPassword('synthetic-revoked-session');
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'qa-former-owner', role: 'admin' });
    const button = screen.getByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('متاح للمالك فقط')));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة المعزولة' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('معرّف طلب الفحص المعزول (UUID)')).toHaveValue(rehearsalId);
    expect(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي')).toHaveValue('');

    (getClientSession as jest.Mock).mockResolvedValue({ id: 'qa-settings-owner', role: 'owner' });
    setPassword('synthetic-authorized-retry');
    fireEvent.click(button);
    expect(await screen.findByRole('status', { name: 'نتيجة فحص النسخة المعزولة' }))
      .toHaveTextContent(rehearsalId);
    expect(invoke).toHaveBeenNthCalledWith(2, 'stage_database_recovery_rehearsal_native', {
      backupId: firstBackupId, requestId: rehearsalId, password: 'synthetic-authorized-retry',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does not derive a trusted UUID from a spoofed export filename or offer isolated recovery without verification', async () => {
    (invoke as jest.Mock).mockResolvedValueOnce(`C:/synthetic/outside/${firstBackupId}/alternate.db`);
    await ownerForm();
    setPassword('synthetic-not-real');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ نسخة احتياطية كاملة' }));
    expect(await screen.findByRole('status')).toHaveTextContent('alternate.db');
    expect(screen.getByLabelText('معرّف النسخة الاحتياطية')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'فحص نسخة معزولة فقط (دون استعادة)' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' })).toBeDisabled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('export_database_backup', {
      userId: 'qa-settings-owner', password: 'synthetic-not-real',
    });
  });
});
