/** @jest-environment node */
const invoke = jest.fn();
const dbSelect = jest.fn();
let session: any;
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => dbSelect(...args),
  dbGet: jest.fn(() => { throw Error('unscoped patient SQL'); }),
  dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => session,
  hasUserPermissionSync: (user: any, permission: string) => !!user?.permissions?.[permission],
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.unmock('@/app/actions-client/patients');

import { getPatientStatementAction, getPatientProfileAction } from '../patients';

describe('native patient statement requires verified 061-owned financial witnesses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    session = { id: 'user-a', pharmacy_id: 'tenant-a', role: 'pharmacist',
      permissions: { can_view_patients: true } };
    invoke.mockResolvedValue({ patient: { id: 'owned', full_name: 'Owned', opening_balance: null },
      movements: [{ type: 'فاتورة بيع', doc_no: 'sale-1', date: '2026-10-16',
        value: 300, balance_effect: null, payment_method: 'cash', notes: null, user_name: null }],
      items: [], notices: [], currentBalance: null,
      unsupported_categories: ['مدفوعات المرضى', 'الإشعارات المالية'], scope: 'verified_subset' });
    dbSelect.mockImplementation(() => { throw Error('unscoped patient SQL'); });
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses only authenticated native fixed command; never invents a numeric outstanding balance', async () => {
    const result = await getPatientStatementAction('owned');
    expect(result).toMatchObject({ success: true, data: {
      patient: { id: 'owned' }, currentBalance: null, scope: 'verified_subset',
      movements: [{ value: 300, balance_effect: null }],
    } });
    expect(invoke).toHaveBeenCalledWith('read_patient_statement_native', { patientId: 'owned' });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('rejects missing tenant, permission or invalid patient identity before invoking native', async () => {
    for (const bad of ['local_default', '', null]) {
      session.pharmacy_id = bad;
      expect((await getPatientStatementAction('owned')).success).toBe(false);
    }
    session.pharmacy_id = 'tenant-a';
    session.permissions.can_view_patients = false;
    expect((await getPatientStatementAction('owned')).success).toBe(false);
    session.permissions.can_view_patients = true;
    expect((await getPatientStatementAction(' x ')).success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed on missing/foreign native patient, forged return totals, stale or incomplete projections', async () => {
    for (const result of [null, [], { patient: { id: 'foreign' }, movements: [], items: [],
        notices: [], currentBalance: null, unsupported_categories: [], scope: 'verified_subset' },
      { patient: { id: 'owned' }, movements: [{ type: 'مرتجع بيع', value: -200,
          balance_effect: 0 }], items: [], notices: [], currentBalance: null,
        unsupported_categories: [], scope: 'verified_subset' },
      { patient: { id: 'owned' }, movements: [], items: [], notices: [], currentBalance: 0,
        unsupported_categories: [], scope: 'verified_subset' },
    ]) {
      invoke.mockResolvedValueOnce(result);
      expect((await getPatientStatementAction('owned')).success).toBe(false);
    }
    invoke.mockRejectedValueOnce(Error('Unverified legacy patient payment'));
    expect((await getPatientStatementAction('owned')).success).toBe(false);
  });

  it('opens a typed owned base profile without inventing finance/medical history or invoking renderer SQL', async () => {
    invoke.mockResolvedValueOnce([{ id: 'owned', full_name: 'Owned Patient',
      credit_limit: 50, wallet_balance: 9000, outstanding_balance: 700,
      opening_balance: 300, points_balance: 10, phone: '01011111111' }]);
    const profile = await getPatientProfileAction('owned');
    expect(profile).toMatchObject({ success: true, data: {
      id: 'owned', full_name: 'Owned Patient', credit_limit: 50,
      wallet_balance: null, opening_balance: null, outstandingBalance: null,
      points_balance: null, profileScope: 'owned_basics_only',
    } });
    expect((profile as any).data).not.toHaveProperty('allergies');
    expect((profile as any).data).not.toHaveProperty('payments');
    expect(invoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'patients.profile', recordId: 'owned', search: null,
      drugId: null, limit: 1, offset: 0,
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });
});
