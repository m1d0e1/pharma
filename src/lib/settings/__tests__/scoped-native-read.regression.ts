/** @jest-environment node */

const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockDbSelect(...args),
  dbGet: (...args: any[]) => mockDbGet(...args),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'manager-a', pharmacy_id: 'ph-a' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

import { getLocalPharmacySettingsClient } from '@/lib/settings/client';
import { getConfigAction } from '@/app/actions-client/config';

describe('native pharmacy-identity read scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockResolvedValue({
      pharmacy_name: 'Pharmacy A',
      pharmacy_phone: '000-A',
    });
  });

  it('preserves the settings form field shape and never asks renderer SQL for config', async () => {
    expect(await getLocalPharmacySettingsClient()).toEqual({
      name: 'Pharmacy A',
      phone: '000-A',
    });
    expect(mockInvoke).toHaveBeenCalledWith('read_pharmacy_settings_scoped');
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it('reads one approved base key and refuses unscoped maintenance config', async () => {
    expect(await getConfigAction('pharmacy_name')).toEqual({
      success: true, value: 'Pharmacy A',
    });
    expect(await getConfigAction('legacy_patient_wallet_review_status')).toEqual({
      success: false, error: 'Failed to fetch config',
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it('fails closed when the native actor is no longer authorized', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(getLocalPharmacySettingsClient()).rejects.toThrow('Unauthorized');
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
