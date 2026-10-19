import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import LicenseBoundary from '@/components/LicenseBoundary';

// Native licensing is mocked completely: these are UI-boundary tests, not
// issuer, device identity, TPM, database initialization, or release evidence.
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@tauri-apps/plugin-process', () => ({ relaunch: jest.fn() }));

const denied = {
  valid: false,
  reason: 'Synthetic license missing',
  machine_fingerprint: 'qa-device-fingerprint',
  license_id: null,
  expires_at_utc: null,
  lease_until_utc: null,
  startup_ready: false,
};
const granted = {
  ...denied,
  valid: true,
  reason: 'Synthetic lease accepted',
  license_id: 'qa-license-only',
  expires_at_utc: 2000000100,
  lease_until_utc: 1900000100,
  startup_ready: true,
};
const protectedLabel = 'Synthetic protected pharmacy application';

function mount() {
  return render(<LicenseBoundary><section>{protectedLabel}</section></LicenseBoundary>);
}

function enterOnlineCredentials(licenseId: string, code: string) {
  fireEvent.change(screen.getByLabelText('رقم الترخيص'), { target: { value: licenseId } });
  fireEvent.change(screen.getByLabelText('رمز التفعيل الخاص'), { target: { value: code } });
}

describe('QA-background online native licensing behavior', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (invoke as jest.Mock).mockImplementation(async (command: string) => {
      if (command === 'license_status') return denied;
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
  });

  it('fails closed when initial native status IPC throws, then activates by trimmed online credentials but requires startup restart', async () => {
    (invoke as jest.Mock).mockImplementation(async (command: string) => {
      if (command === 'license_status') throw new Error('Synthetic native status bridge unavailable');
      if (command === 'license_activate_online') return { ...granted, startup_ready: false };
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();

    expect(await screen.findByText(/Synthetic native status bridge unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    const activation = screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' });
    expect(activation).toBeDisabled();

    enterOnlineCredentials('   ', '   ');
    expect(activation).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith('license_activate_online', expect.anything());

    enterOnlineCredentials('  qa-license-only  ', '  qa-activation-placeholder  ');
    expect(activation).toBeEnabled();
    fireEvent.click(activation);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('license_activate_online', {
      licenseId: 'qa-license-only', activationCode: 'qa-activation-placeholder',
    }));
    expect(await screen.findByRole('button', { name: 'إعادة تشغيل التطبيق' })).toBeInTheDocument();
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
    expect((invoke as jest.Mock).mock.calls.map(([command]) => command)).toEqual([
      'license_status', 'license_activate_online',
    ]);
  });

  it('retains blocked state after refused online activation, then allows retry only when native says startup is ready', async () => {
    let attempts = 0;
    (invoke as jest.Mock).mockImplementation(async (command: string) => {
      if (command === 'license_status') return denied;
      if (command === 'license_activate_online') {
        attempts++;
        if (attempts === 1) throw new Error('Synthetic native issuer refused activation');
        return granted;
      }
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();
    await screen.findByText(denied.reason);
    enterOnlineCredentials(' qa-license-only ', ' qa-code ');
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic native issuer refused activation');
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    expect(screen.getByLabelText('رمز التفعيل الخاص')).toHaveValue(' qa-code ');
    expect(screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' }));
    expect(await screen.findByText(protectedLabel)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
    expect((invoke as jest.Mock).mock.calls.filter(([command]) => command === 'license_activate_online')).toEqual([
      ['license_activate_online', { licenseId: 'qa-license-only', activationCode: 'qa-code' }],
      ['license_activate_online', { licenseId: 'qa-license-only', activationCode: 'qa-code' }],
    ]);
  });

  it('serializes pending online activation and does not unlock protected content on a denied native result', async () => {
    let resolveActivation!: (result: typeof denied) => void;
    const pending = new Promise<typeof denied>(resolve => { resolveActivation = resolve; });
    (invoke as jest.Mock).mockImplementation((command: string) => {
      if (command === 'license_status') return Promise.resolve(denied);
      if (command === 'license_activate_online') return pending;
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();
    await screen.findByText(denied.reason);
    enterOnlineCredentials('qa-id', 'qa-secret-placeholder');
    const activation = screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' });
    act(() => {
      activation.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      activation.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect((invoke as jest.Mock).mock.calls.filter(([command]) => command === 'license_activate_online')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' })).toBeDisabled();
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();

    await act(async () => { resolveActivation({ ...denied, reason: 'Synthetic activation rejected' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic activation rejected');
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' })).toBeEnabled();
  });

  it('keeps initially licensed UI open after failed online renewal, then gates business UI if renewal requires native restart', async () => {
    let renewals = 0;
    (invoke as jest.Mock).mockImplementation(async (command: string) => {
      if (command === 'license_status') return granted;
      if (command === 'license_renew_online') {
        renewals++;
        if (renewals === 1) throw new Error('Synthetic online renewal unavailable');
        return { ...granted, startup_ready: false };
      }
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();
    expect(await screen.findByText(protectedLabel)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    fireEvent.click(screen.getByRole('button', { name: 'تجديد آمن عبر الإنترنت' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic online renewal unavailable');
    expect(screen.getByText(protectedLabel)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تجديد آمن عبر الإنترنت' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'تجديد آمن عبر الإنترنت' }));

    expect(await screen.findByRole('button', { name: 'إعادة تشغيل التطبيق' })).toBeInTheDocument();
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    expect((invoke as jest.Mock).mock.calls.filter(([command]) => command === 'license_renew_online')).toHaveLength(2);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('a licensed offline-first operator can later obtain native online proof for first-owner enrollment without a tenant claim', async () => {
    const calls: string[] = [];
    (invoke as jest.Mock).mockImplementation(async (command: string) => {
      calls.push(command);
      if (command === 'license_status') return granted;
      if (command === 'license_activate_online') return granted;
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();
    await screen.findByText(protectedLabel);
    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    const btn = screen.getByRole('button', { name: 'تأكيد التفعيل الأولي عبر الإنترنت' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('رقم الترخيص للتفعيل عبر الإنترنت'), {
      target: { value: ' qa-existing-signed-license ' },
    });
    fireEvent.change(screen.getByLabelText('رمز التفعيل الخاص الأصلي'), {
      target: { value: ' qa-operator-code ' },
    });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('license_activate_online', {
      licenseId: 'qa-existing-signed-license', activationCode: 'qa-operator-code',
    }));
    expect(screen.getByText(protectedLabel)).toBeInTheDocument();
    expect(screen.queryByLabelText('رمز التفعيل الخاص الأصلي')).not.toBeInTheDocument();
    expect(calls.filter(command => command === 'license_activate_online')).toHaveLength(1);
    expect(calls).not.toContain('enroll_initial_owner');
  });

  it('rejects an invalid native online renewal result rather than displaying protected data', async () => {
    (invoke as jest.Mock).mockImplementation(async (command: string) => {
      if (command === 'license_status') return granted;
      if (command === 'license_renew_online') return { ...denied, reason: 'Synthetic lease revoked by issuer' };
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();
    expect(await screen.findByText(protectedLabel)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تجديد الترخيص' }));
    fireEvent.click(screen.getByRole('button', { name: 'تجديد آمن عبر الإنترنت' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic lease revoked by issuer');
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إعادة تشغيل التطبيق' })).not.toBeInTheDocument();
  });

  it('shows a native relaunch error and permits retry while preventing protected access', async () => {
    (invoke as jest.Mock).mockResolvedValue({ ...granted, startup_ready: false });
    (relaunch as jest.Mock)
      .mockRejectedValueOnce(new Error('Synthetic process relaunch refused'))
      .mockResolvedValueOnce(undefined);
    mount();
    const restart = await screen.findByRole('button', { name: 'إعادة تشغيل التطبيق' });
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    fireEvent.click(restart);

    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic process relaunch refused');
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تشغيل التطبيق' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(protectedLabel)).not.toBeInTheDocument();
    expect((invoke as jest.Mock).mock.calls.map(([command]) => command)).toEqual(['license_status']);
  });

  it('does not let an older pending license-status check undo a successful online activation', async () => {
    let pollCount = 0;
    let resolveOldStatus!: (result: typeof denied) => void;
    (invoke as jest.Mock).mockImplementation((command: string) => {
      if (command === 'license_status') {
        pollCount++;
        return pollCount === 2
          ? new Promise(resolve => { resolveOldStatus = resolve; })
          : Promise.resolve(denied);
      }
      if (command === 'license_activate_online') return Promise.resolve(granted);
      throw new Error(`Unexpected synthetic IPC: ${command}`);
    });
    mount();
    await screen.findByText(denied.reason);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(pollCount).toBe(2));
    enterOnlineCredentials('qa-license-only', 'qa-code');
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل عبر اتصال آمن' }));
    expect(await screen.findByText(protectedLabel)).toBeInTheDocument();

    await act(async () => { resolveOldStatus({ ...denied, reason: 'Stale synthetic unlicensed status' }); });
    expect(screen.getByText(protectedLabel)).toBeInTheDocument();
    expect(screen.queryByText('Stale synthetic unlicensed status')).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
