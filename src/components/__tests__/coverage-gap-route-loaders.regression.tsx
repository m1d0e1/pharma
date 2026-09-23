import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseOrdersPage from '@/app/(dashboard)/purchase-orders/page';
import PatientsPage from '@/app/(dashboard)/patients/page';
import ShiftsPage from '@/app/(dashboard)/shifts/page';
import SettingsPage from '@/app/(dashboard)/settings/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getPurchaseOrdersAction } from '@/app/actions-client/purchases';
import { getPatientsAction } from '@/app/actions-client/patients';
import { getCurrentShiftAction, getShiftsAction } from '@/app/actions-client/shifts';
import { getLocalPharmacySettingsClient } from '@/lib/settings/client';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/purchases', () => ({ getPurchaseOrdersAction: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({ getPatientsAction: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({
  getCurrentShiftAction: jest.fn(),
  getShiftsAction: jest.fn(),
}));
jest.mock('@/lib/settings/client', () => ({ getLocalPharmacySettingsClient: jest.fn() }));
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() { return <div>access-denied</div>; });
jest.mock('@/components/inventory/PurchaseOrdersClient', () => function MockPurchaseOrdersClient({ initialOrders }: any) {
  return <div>purchase-orders:{initialOrders.map((order: any) => order.id).join(',')}</div>;
});
jest.mock('@/components/patients/PatientListClient', () => function MockPatientListClient({ initialPatients }: any) {
  return <div>patients:{initialPatients.map((patient: any) => patient.full_name).join(',')}</div>;
});
jest.mock('@/components/shifts/ShiftManagementClient', () => function MockShiftManagementClient({ initialShifts }: any) {
  return <div>shifts:{initialShifts.map((shift: any) => shift.id).join(',')}</div>;
});
jest.mock('@/components/settings/PharmacySettingsForm', () => function MockPharmacySettingsForm({ pharmacy }: any) {
  return <div>pharmacy:{pharmacy?.name || 'empty'}</div>;
});
jest.mock('@/components/settings/SyncSettings', () => function MockSyncSettings() { return <div>sync-settings</div>; });
jest.mock('@/components/settings/DbMaintenance', () => function MockDbMaintenance() { return <div>db-maintenance</div>; });
jest.mock('@/components/settings/LocalUserManagement', () => function MockLocalUserManagement() { return <div>local-users</div>; });

const owner = {
  id: 'owner-1',
  role: 'owner',
  pharmacy_id: 'local_default',
  permissions: {
    can_view_patients: true,
    can_view_shifts: true,
    can_view_settings: true,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue(owner);
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user?.permissions?.[key] === true);
});

it('recovers the purchase-orders route after a thrown initial load', async () => {
  (getPurchaseOrdersAction as jest.Mock)
    .mockRejectedValueOnce(new Error('bridge unavailable'))
    .mockResolvedValueOnce({ success: true, data: [{ id: 'PO-RECOVERED' }] });
  render(<PurchaseOrdersPage />);
  expect(await screen.findByText('تعذر تحميل أوامر الشراء')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('purchase-orders:PO-RECOVERED')).toBeInTheDocument();
});

it('distinguishes a failed patients load from a legitimate empty patient list and retries', async () => {
  (getPatientsAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'تعذر جلب المرضى' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'p2', full_name: 'مريض مستعاد' }] });
  render(<PatientsPage />);
  expect(await screen.findByText('تعذر تحميل بيانات المرضى')).toBeInTheDocument();
  expect(screen.queryByText('patients:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('patients:مريض مستعاد')).toBeInTheDocument();
});

it('distinguishes failed shift data from an empty shift history and retries', async () => {
  (getCurrentShiftAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'current failed' })
    .mockResolvedValueOnce({ success: true, data: null, suggested_starting_cash: 25 });
  (getShiftsAction as jest.Mock)
    .mockResolvedValueOnce({ success: false, error: 'history failed' })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'shift-recovered' }] });
  render(<ShiftsPage />);
  expect(await screen.findByText('تعذر تحميل بيانات الشفتات')).toBeInTheDocument();
  expect(screen.queryByText('shifts:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('shifts:shift-recovered')).toBeInTheDocument();
});

it('keeps the newest shift refresh when an older focus load resolves later', async () => {
  const oldCurrent = deferred<any>();
  const oldHistory = deferred<any>();
  (getCurrentShiftAction as jest.Mock)
    .mockImplementationOnce(() => oldCurrent.promise)
    .mockResolvedValueOnce({ success: true, data: null, suggested_starting_cash: 50 });
  (getShiftsAction as jest.Mock)
    .mockImplementationOnce(() => oldHistory.promise)
    .mockResolvedValueOnce({ success: true, data: [{ id: 'shift-newest' }] });

  render(<ShiftsPage />);
  await waitFor(() => expect(getShiftsAction).toHaveBeenCalledTimes(1));

  fireEvent.focus(window);
  expect(await screen.findByText('shifts:shift-newest')).toBeInTheDocument();

  await act(async () => {
    oldCurrent.resolve({ success: true, data: null, suggested_starting_cash: 10 });
    oldHistory.resolve({ success: true, data: [{ id: 'shift-stale' }] });
    await Promise.all([oldCurrent.promise, oldHistory.promise]);
  });

  expect(screen.getByText('shifts:shift-newest')).toBeInTheDocument();
  expect(screen.queryByText('shifts:shift-stale')).not.toBeInTheDocument();
});

it('distinguishes failed settings data from an empty pharmacy settings form and retries', async () => {
  (getLocalPharmacySettingsClient as jest.Mock)
    .mockRejectedValueOnce(new Error('bridge unavailable'))
    .mockResolvedValueOnce({ name: 'صيدلية مستعادة' });
  render(<SettingsPage />);
  expect(await screen.findByText('تعذر تحميل إعدادات النظام')).toBeInTheDocument();
  expect(screen.queryByText('pharmacy:empty')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('pharmacy:صيدلية مستعادة')).toBeInTheDocument();
});
