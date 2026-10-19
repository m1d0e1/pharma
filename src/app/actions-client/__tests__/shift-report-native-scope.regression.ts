/** @jest-environment node */
const mockInvoke = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: (...args: any[]) => mockGet(...args),
  dbExecute: jest.fn(),dbTransaction:jest.fn(),
  normalizeDatabaseTimestamps:(rows: any[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockSession,
  hasUserPermissionSync: (user: any,key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(() => { throw new Error('Unscoped shift lookup forbidden'); }),
}));
jest.unmock('@/app/actions-client/reports');

import { getShiftReportAction } from '@/app/actions-client/reports';

describe('native shift report role and tenant authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = {id:'staff-a',role:'cashier',pharmacy_id:'forged-b',permissions:{rep_can_view_shifts:true}};
    mockInvoke.mockImplementation(async (command: string,args: any) => {
      if (command !== 'db_read_scoped') throw new Error('No generic SQL allowed');
      switch (args.queryId) {
        case 'reports.shift_header': return [{id:'shift-a',status:'closed',starting_cash:100,
          actual_cash:155,cash_difference:10,ending_cash:155,staff_name:'A'}];
        case 'reports.shift_sales': return [{payment_method:'cash',count:2,total:100,paid:100,remaining:0}];
        case 'reports.shift_returns': return [{refund_method:'cash',count:1,total:20}];
        case 'reports.shift_movements': return [{type:'receipt',category:'deposit',total:5}];
        default: throw new Error('Wrong fixed query');
      }
    });
  });

  it('calculates original accounting summary exclusively from native scoped projections', async () => {
    const result = await getShiftReportAction('shift-a');
    expect(result).toMatchObject({success:true,data:{
      shift:{id:'shift-a',staff_name:'A'},sales:[{total:100}],returns:[{total:20}],
      movements:[{total:5}],summary:{cashSales:100,cashReturns:20,
        cashReceipts:5,cashDisbursements:0,expectedCash:145,actualCash:155,difference:10},
    }});
    expect(mockInvoke.mock.calls.map(([,args]:any[]) => args.queryId)).toEqual([
      'reports.shift_header','reports.shift_sales','reports.shift_returns','reports.shift_movements',
    ]);
    for (const [,args] of mockInvoke.mock.calls) {
      expect(args.recordId).toBe('shift-a');
      expect(args.pharmacyId).toBeUndefined();
      expect(args.userId).toBeUndefined();
      expect(args.sql).toBeUndefined();
    }
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fails closed on native foreign-shift rejection, invalid IDs and denied roles', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Foreign shift'));
    expect((await getShiftReportAction('foreign-shift')).success).toBe(false);
    expect((await getShiftReportAction('bad\0id')).success).toBe(false);
    mockSession.permissions.rep_can_view_shifts=false;
    expect((await getShiftReportAction('shift-a')).success).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
