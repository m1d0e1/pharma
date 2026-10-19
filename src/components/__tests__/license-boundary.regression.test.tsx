import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('@/lib/env', () => ({ isTauri: true }));
const invoke = jest.fn();
const relaunch = jest.fn();
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
jest.mock('@tauri-apps/plugin-process', () => ({ relaunch: (...args: unknown[]) => relaunch(...args) }));

import LicenseBoundary from '@/components/LicenseBoundary';

const denied = {
  valid: false, reason: 'No license is installed on this computer',
  machine_fingerprint: 'a'.repeat(64), license_id: null,
  expires_at_utc: null, lease_until_utc: null, startup_ready: false,
};
const activated = { ...denied, valid: true, reason: 'Licensed', license_id: 'licensed-device',
  expires_at_utc: 2000000000, lease_until_utc: 1900000000, startup_ready: true };

describe('native license UX is fail-closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invoke.mockResolvedValue(denied);
  });

  it('shows activation details but never mounts children without native authorization', async () => {
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
    expect(await screen.findByText(denied.reason)).toBeInTheDocument();
    expect(screen.getByLabelText('Machine fingerprint')).toHaveTextContent('a'.repeat(64));
    expect(invoke).toHaveBeenCalledWith('license_status');
  });

  it('mounts children only after a valid result from trusted native verification', async () => {
    invoke.mockResolvedValue(activated);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
  });
  it('shows signed offline-term expiration without a rolling lease renewal control', async () => {
    invoke.mockResolvedValue({ ...activated, offline_term: true, lease_until_utc: null });
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    expect(screen.getByText(/ترخيص دون اتصال بالإنترنت حتى/)).toBeInTheDocument();
    expect(screen.queryByText(/صلاحية الاتصال حتى/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تجديد آمن عبر الإنترنت' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تحديث الترخيص' })).toBeInTheDocument();
  });

  it('requires restart when background online renewal succeeded after an unlicensed startup', async () => {
    // The watcher can renew before the database startup/migration gate ran.
    invoke.mockResolvedValue({ ...activated, startup_ready: false });
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByRole('button', { name: 'إعادة تشغيل التطبيق' })).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تشغيل التطبيق' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });

  it('shows the immutable tenantless upgrade quarantine instead of a restart loop or protected data', async () => {
    invoke.mockResolvedValue({ ...activated, startup_ready: false, startup_upgrade_blocked: true });
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByRole('alert', { name: 'مراجعة ملكية السجلات القديمة' })).toBeInTheDocument();
    expect(screen.getByText(/Legacy pharmacy ownership review required/)).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إعادة تشغيل التطبيق' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تفعيل الترخيص' })).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('shows only native structural totals on a blocked v52 pharmacy; never unlocks data', async () => {
    const blocked = { ...activated, startup_ready: false, startup_upgrade_blocked: true };
    invoke.mockImplementation(async (name: string) => name === 'primary_pharmacy_upgrade_preview'
      ? { status: 'SINGLE_PHARMACY_CANDIDATE_ONLY', native_migration_version: 52,
          directly_scoped_rows: 24, scopes_needing_reviewed_normalization: 24,
          already_primary_rows: 0, unresolved_owner_scope_markers: 1,
          proposed_tenant: 'primary_pharmacy', ownership_verified: false, upgrade_authorized: false }
      : blocked);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByLabelText('فحص نطاق صيدلية واحدة')).toHaveTextContent('24');
    expect(screen.getByLabelText('فحص نطاق صيدلية واحدة')).toHaveTextContent('primary_pharmacy');
    expect(screen.getByText(/إشارات مراجعة ملكية قديمة/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('primary_pharmacy_upgrade_preview');
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إعادة تشغيل التطبيق' })).not.toBeInTheDocument();
  });

  it('rejects a forged preview reporting ownership approval and keeps finance hidden', async () => {
    const blocked = { ...activated, startup_ready: false, startup_upgrade_blocked: true };
    invoke.mockImplementation(async (name: string) => name === 'primary_pharmacy_upgrade_preview'
      ? { status: 'SINGLE_PHARMACY_CANDIDATE_ONLY', native_migration_version: 52,
          directly_scoped_rows: 24, scopes_needing_reviewed_normalization: 24,
          already_primary_rows: 0, unresolved_owner_scope_markers: 0,
          proposed_tenant: 'primary_pharmacy', ownership_verified: true, upgrade_authorized: true }
      : blocked);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText(/لم ينجح فحص أهلية صيدلية واحدة/)).toBeInTheDocument();
    expect(screen.queryByLabelText('فحص نطاق صيدلية واحدة')).not.toBeInTheDocument();
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
  });

  it('fails closed when the native read-only eligibility preflight refuses', async () => {
    const blocked = { ...activated, startup_ready: false, startup_upgrade_blocked: true };
    invoke.mockImplementation(async (name: string) => {
      if (name === 'primary_pharmacy_upgrade_preview') throw new Error('Historical tenant disputed');
      return blocked;
    });
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText(/لم ينجح فحص أهلية صيدلية واحدة/)).toBeInTheDocument();
    expect(screen.queryByText(/Historical tenant disputed/)).not.toBeInTheDocument();
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
  });

  it('renews an already-valid signed lease without requiring a restart', async () => {
    const refreshed = { ...activated, lease_until_utc: 2000000100 };
    invoke.mockImplementation(async (name: string) => name === 'license_install' ? refreshed : activated);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    const data = '{"payload_b64":"new-lease","signature_b64":"issuer-signature"}';
    fireEvent.change(screen.getByLabelText('ترخيص جديد موقع رقمياً (JSON)'), { target: { value: data } });
    fireEvent.click(screen.getByRole('button', { name: 'تحديث الترخيص' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('license_install', { signedLicense: data }));
    await waitFor(() => expect(screen.queryByText('ترخيص جديد موقع رقمياً (JSON)')).not.toBeInTheDocument());
    expect(screen.getByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('renews after an in-session expiry without unnecessary restart when native startup is ready', async () => {
    let current = activated;
    const renewed = { ...activated, lease_until_utc: 2000000100 };
    invoke.mockImplementation(async (name: string) => name === 'license_install' ? renewed : current);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();

    current = { ...activated, valid: false, reason: 'License has expired' };
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('License has expired')).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();

    const token = '{"payload_b64":"renewed","signature_b64":"signed"}';
    fireEvent.change(screen.getByLabelText('محتوى الترخيص الموقع رقمياً (JSON)'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الترخيص' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('license_install', { signedLicense: token }));
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إعادة تشغيل التطبيق' })).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('locks the visible application when a signed revocation arrives during renewal', async () => {
    const revoked = { ...denied, reason: 'License has been revoked' };
    invoke.mockImplementation(async (name: string) => name === 'license_install' ? revoked : activated);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    fireEvent.change(screen.getByLabelText('ترخيص جديد موقع رقمياً (JSON)'), {
      target: { value: '{"payload_b64":"revoked","signature_b64":"valid"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تحديث الترخيص' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('License has been revoked');
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
  });

  it('does not re-open protected UI if an old license poll resolves after revocation', async () => {
    let resolveOldPoll!: (status: typeof activated) => void;
    let polls = 0;
    const revoked = { ...denied, startup_ready: true, reason: 'License has been revoked' };
    invoke.mockImplementation((name: string) => {
      if (name === 'license_install') return Promise.resolve(revoked);
      polls++;
      return polls === 2
        ? new Promise(resolve => { resolveOldPoll = resolve; })
        : Promise.resolve(activated);
    });
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    expect(await screen.findByText('PROTECTED PHARMACY DATA')).toBeInTheDocument();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(polls).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    fireEvent.change(screen.getByLabelText('ترخيص جديد موقع رقمياً (JSON)'), {
      target: { value: '{"payload_b64":"revoked","signature_b64":"signed"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تحديث الترخيص' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('License has been revoked');
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();

    await act(async () => { resolveOldPoll(activated); });
    expect(screen.getByRole('alert')).toHaveTextContent('License has been revoked');
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
  });

  it('requires restart after installing a signed license, not immediate protected access', async () => {
    invoke.mockImplementation(async (name: string) => name === 'license_install' ? { ...activated, startup_ready: false } : denied);
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    await screen.findByText(denied.reason);
    const data = '{"payload_b64":"signed","signature_b64":"signed"}';
    fireEvent.change(screen.getByLabelText('محتوى الترخيص الموقع رقمياً (JSON)'), { target: { value: data } });
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الترخيص' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('license_install', { signedLicense: data }));
    expect(await screen.findByRole('button', { name: 'إعادة تشغيل التطبيق' })).toBeInTheDocument();
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تشغيل التطبيق' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });

  it('never unlocks after signature failure; displays the native error', async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === 'license_install') throw new Error('License signature verification failed');
      return denied;
    });
    render(<LicenseBoundary><div>PROTECTED PHARMACY DATA</div></LicenseBoundary>);
    await screen.findByText(denied.reason);
    fireEvent.change(screen.getByLabelText('محتوى الترخيص الموقع رقمياً (JSON)'),
      { target: { value: '{"payload_b64":"tampered"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الترخيص' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('signature verification failed');
    expect(screen.queryByText('PROTECTED PHARMACY DATA')).not.toBeInTheDocument();
  });
});
