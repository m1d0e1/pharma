import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';
import { addPatientAction, deletePatientAction } from '@/app/actions-client/patients';
import { getHandoverDetailsAction, processHandoverAction } from '@/app/actions-client/handover';
import { getBanksAction } from '@/app/actions-client/finance';
import { getStaffAction } from '@/app/actions-client/users';
import { openShiftAction, forceCloseAllShiftsAction } from '@/app/actions-client/shifts';
import PatientListClient from '@/components/patients/PatientListClient';
import AddPatientModal from '@/components/AddPatientModal';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import DbMaintenance from '@/components/settings/DbMaintenance';

const mockPush = jest.fn();
const mockRefresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));
jest.mock('@/components/patients/PatientProfileModal', () => function MockPatientProfile({ patientId, onClose }: {
  patientId: string;
  onClose: () => void;
}) {
  return <section role="dialog" aria-label="ملف المريض">Patient profile: {patientId}<button onClick={onClose}>Close profile</button></section>;
});
jest.mock('@/components/shifts/ShiftReceiptsModal', () => () => null);
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({
  addPatientAction: jest.fn(),
  deletePatientAction: jest.fn(),
  getPatientsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
  processHandoverAction: jest.fn(),
  getShiftCreditSalesAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({ getBanksAction: jest.fn() }));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({
  openShiftAction: jest.fn(),
  forceCloseAllShiftsAction: jest.fn(),
  getShiftsAction: jest.fn(),
  getShiftReceiptsAction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  isOwnerOrAdmin: (session: { role?: string } | null) => ['owner', 'admin'].includes(session?.role || ''),
}));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn() }));
jest.mock('@/lib/settings/client', () => ({ runDatabaseMaintenanceClient: jest.fn() }));
jest.mock('react-hot-toast', () => {
  const mockToast = { success: jest.fn(), error: jest.fn(), loading: jest.fn(() => 'qa-toast') };
  return { __esModule: true, default: mockToast, toast: mockToast };
});

const syntheticPatient = {
  id: 'qa-patient-a',
  full_name: 'Synthetic Patient A',
  name_en: 'Patient Alpha',
  phone: '01000000000',
  address: 'Synthetic Address',
  notes: '',
  points_balance: 0,
  outstanding_balance: 10,
  wallet_balance: 0,
  customer_type: 'individual',
  created_at: '2026-10-01T00:00:00Z',
};

const handover = {
  id: 'qa-shift-10',
  user_name: 'Synthetic Operator',
  start_time: '2026-10-01T08:00:00Z',
  starting_cash: 50,
  cash_sales: 30,
  receipts: 0,
  credit_sales: 5,
  returns: 0,
  disbursements: 0,
  expected_cash: 80,
};

function primeHandoverMocks() {
  (getHandoverDetailsAction as jest.Mock).mockResolvedValue({ success: true, data: handover });
  (getBanksAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 'qa-bank', name_ar: 'Synthetic Bank' }] });
  (getStaffAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [{ id: 'qa-receiver', username: 'qa_receiver', full_name: 'Synthetic Receiver' }],
  });
}

describe('QA background patient, finance, shifts and backup interactions (mocked native boundaries)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'qa-owner', role: 'owner' });
    primeHandoverMocks();
  });

  it('filters patient names and phone numbers; opens and closes the selected profile without mutation', () => {
    render(<PatientListClient initialPatients={[syntheticPatient, {
      ...syntheticPatient, id: 'qa-patient-b', full_name: 'Synthetic Patient B', name_en: 'Patient Beta', phone: '01111111111',
    }]} pharmacyId="qa-branch" canDeletePatients={false} />);

    expect(screen.queryByRole('button', { name: 'حذف المريض Synthetic Patient A' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'بحث في المرضى بالاسم أو رقم الهاتف' }), {
      target: { value: '01111111111' },
    });
    expect(screen.queryByText('Synthetic Patient A')).not.toBeInTheDocument();
    expect(screen.getByText('Synthetic Patient B')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'عرض الملف' }));
    expect(screen.getByRole('dialog', { name: 'ملف المريض' })).toHaveTextContent('qa-patient-b');
    fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
    expect(screen.queryByRole('dialog', { name: 'ملف المريض' })).not.toBeInTheDocument();
    expect(deletePatientAction).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects blank patient submission before persistence, then recovers from an action failure', async () => {
    (addPatientAction as jest.Mock)
      .mockRejectedValueOnce(new Error('Synthetic native patient service unavailable'))
      .mockResolvedValueOnce({ success: true, id: 'qa-created-patient' });
    const onSuccess = jest.fn();
    const onClose = jest.fn();
    render(<AddPatientModal pharmacyId="qa-branch" onSuccess={onSuccess} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال الاسم بالكامل');
    expect(addPatientAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'الاسم بالكامل (ع) *' }), {
      target: { value: 'Synthetic New Patient' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء إضافة العميل'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ العميل' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      id: 'qa-created-patient', full_name: 'Synthetic New Patient',
    })));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(addPatientAction).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('recovers from a failed finance shift summary load via its visible retry', async () => {
    (getHandoverDetailsAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic finance permission denied' })
      .mockResolvedValueOnce({ success: true, data: handover });
    const onClose = jest.fn();
    render(<DrawerHandoverClient shiftId="qa-shift-10" onClose={onClose} />);

    expect(await screen.findByText('تعذر تحميل بيانات تسليم الوردية')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إتمام تسليم الدرج' })).not.toBeInTheDocument();
    expect(processHandoverAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByRole('heading', { name: 'تسليم الوردية المشتركة' })).toBeInTheDocument();
    expect(getHandoverDetailsAction).toHaveBeenCalledTimes(2);
    expect(processHandoverAction).not.toHaveBeenCalled();
  });

  it('rejects invalid transfer amounts and missing receiver without issuing financial IPC', async () => {
    (getStaffAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    render(<DrawerHandoverClient shiftId="qa-shift-10" onClose={jest.fn()} />);
    await screen.findByRole('heading', { name: 'تسليم الوردية المشتركة' });

    fireEvent.change(screen.getByLabelText('النقدية المعدودة فعليًا في درج الوردية'), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ المراد تحويله'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'إتمام تسليم الدرج' }));
    expect(toast.error).toHaveBeenCalledWith('مبلغ التحويل أكبر من النقدية الفعلية في الدرج');
    expect(processHandoverAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('المبلغ المراد تحويله'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'إتمام تسليم الدرج' }));
    expect(toast.error).toHaveBeenCalledWith('يرجى تحديد المستلم');
    expect(processHandoverAction).not.toHaveBeenCalled();
  });

  it('keeps handover open on rejected native action and retries one confirmed synthetic result', async () => {
    (processHandoverAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Native handover requires permission' })
      .mockResolvedValueOnce({ success: true, remainingCash: 12.5 });
    const onClose = jest.fn();
    render(<DrawerHandoverClient shiftId="qa-shift-10" onClose={onClose} />);
    await screen.findByRole('heading', { name: 'تسليم الوردية المشتركة' });
    fireEvent.change(screen.getByLabelText('النقدية المعدودة فعليًا في درج الوردية'), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ المراد تحويله'), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'إتمام تسليم الدرج' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Native handover requires permission'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'إتمام تسليم الدرج' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'إتمام تسليم الدرج' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(processHandoverAction).toHaveBeenCalledTimes(2);
    expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
      shiftId: 'qa-shift-10', actualCash: 20, transferAmount: 7.5,
      receiverUsername: 'qa_receiver', autoOpenNewShift: true,
    }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('hides owner-only emergency shift closure and handover navigation for a restricted user', () => {
    render(<ShiftManagementClient initialShifts={[]} currentShift={null} hasOpenShift={false}
      userRole="pharmacist" canHandover={false} canViewShiftReports={false} />);
    expect(screen.queryByRole('button', { name: 'إغلاق جميع الشفتات اضطرارياً' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /فتح شاشة تسليم الدرج والمناوبة/ })).not.toBeInTheDocument();
    expect(forceCloseAllShiftsAction).not.toHaveBeenCalled();
  });

  it('blocks invalid opening cash then surfaces a native-shift action refusal without claiming a new shift', async () => {
    (openShiftAction as jest.Mock).mockResolvedValue({ success: false, error: 'Native shift permission denied' });
    render(<ShiftManagementClient initialShifts={[]} currentShift={null} hasOpenShift={false}
      userRole="owner" />);
    fireEvent.click(screen.getByRole('button', { name: 'فتح شفت جديد' }));
    expect(screen.getByText(/يرجى إدخال مبلغ نقدي افتتاحي صحيح/)).toBeInTheDocument();
    expect(openShiftAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('الرصيد الافتتاحي (ج.م)'), { target: { value: '-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'فتح شفت جديد' }));
    expect(openShiftAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('الرصيد الافتتاحي (ج.م)'), { target: { value: '42.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'فتح شفت جديد' }));
    expect(await screen.findByText(/Native shift permission denied/)).toBeInTheDocument();
    expect(openShiftAction).toHaveBeenCalledTimes(1);
    expect(openShiftAction).toHaveBeenCalledWith(expect.objectContaining({ starting_cash_amount: 42.5 }));
    expect(screen.queryByText(/تم فتح الشفت بنجاح/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'فتح شفت جديد' })).toBeEnabled();
  });

  it('denies administrator-only backup access before any native IPC even with a settings role', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'qa-admin', role: 'admin' });
    render(<DbMaintenance />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'حفظ نسخة احتياطية كاملة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects failed native backup preview without showing verification, then retries the same backup UUID', async () => {
    const backupId = '11111111-2222-4333-8444-555555555555';
    (invoke as jest.Mock)
      .mockRejectedValueOnce(new Error('Native read-only preview unavailable'))
      .mockResolvedValueOnce({
        status: 'verified_read_only_preview', backupId, sourceName: 'pharma_local.db',
        sizeBytes: 2048, createdUnixMs: 1, createdByOwner: 'qa-owner',
        sha256: 'c'.repeat(64), warning: 'Preview only, no restore permission',
      });
    render(<DbMaintenance />);
    await screen.findByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' });
    fireEvent.change(screen.getByLabelText('معرّف النسخة الاحتياطية'), { target: { value: backupId } });
    fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), {
      target: { value: 'synthetic-nonsecret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Native read-only preview unavailable')));
    expect(screen.queryByRole('status', { name: 'نتيجة فحص النسخة' })).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('كلمة مرور حسابك لتأكيد النسخ الاحتياطي'), {
      target: { value: 'synthetic-retry' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'فحص سلامة نسخة محفوظة فقط' }));
    expect(await screen.findByRole('status', { name: 'نتيجة فحص النسخة' })).toHaveTextContent('Preview only');
    expect(invoke).toHaveBeenNthCalledWith(1, 'verify_database_backup_recovery_preview', {
      backupId, password: 'synthetic-nonsecret',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'verify_database_backup_recovery_preview', {
      backupId, password: 'synthetic-retry',
    });
    expect((invoke as jest.Mock).mock.calls.every(([command]) => command === 'verify_database_backup_recovery_preview')).toBe(true);
  });
});
