import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import LicenseBoundary from '@/components/LicenseBoundary';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@tauri-apps/plugin-process', () => ({ relaunch: jest.fn() }));

const denied = {
  valid: false,
  reason: 'Offline manual QA activation required',
  machine_fingerprint: 'f'.repeat(64),
  license_id: null,
  expires_at_utc: null,
  lease_until_utc: null,
  offline_term: false,
  online_activation_available: false,
  startup_ready: false,
};
const signed = JSON.stringify({
  payload_b64: 'QA-PAYLOAD-not-an-actual-license',
  signature_b64: 'QA-SIGNATURE-not-an-actual-license',
});

beforeEach(() => {
  jest.resetAllMocks();
  (invoke as jest.Mock).mockImplementation(async (command: string) => {
    if (command === 'license_status') return denied;
    if (command === 'license_install') return { ...denied, valid: true, offline_term: true };
    throw new Error('Unexpected native command');
  });
});

it('imports a signed file without contacting an online authority and still requires restart', async () => {
  render(<LicenseBoundary><div>Private pharmacy data</div></LicenseBoundary>);
  await screen.findByText(denied.reason);
  expect(screen.queryByRole('button', { name: 'تفعيل عبر اتصال آمن' })).not.toBeInTheDocument();
  expect(screen.queryByText('Private pharmacy data')).not.toBeInTheDocument();
  const upload = screen.getByLabelText('استيراد ملف الترخيص الموقّع (JSON)');
  const file = new File([signed], 'pharma-license.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => signed });
  fireEvent.change(upload, { target: { files: [file] } });
  await waitFor(() => {
    expect(screen.getByLabelText('محتوى الترخيص الموقع رقمياً (JSON)')).toHaveValue(signed);
  });
  fireEvent.click(screen.getByRole('button', { name: 'تفعيل الترخيص' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('license_install', {
    signedLicense: signed,
  }));
  expect(await screen.findByRole('button', { name: 'إعادة تشغيل التطبيق' })).toBeInTheDocument();
  expect(screen.queryByText('Private pharmacy data')).not.toBeInTheDocument();
  expect((invoke as jest.Mock).mock.calls.map(([action]) => action))
    .not.toContain('license_activate_online');
});

it('rejects invalid or oversized local JSON before any native license installation', async () => {
  render(<LicenseBoundary><div>Private pharmacy data</div></LicenseBoundary>);
  await screen.findByText(denied.reason);
  const upload = screen.getByLabelText('استيراد ملف الترخيص الموقّع (JSON)');
  const malformed = new File(['{"arbitrary":true}'], 'untrusted.json', { type: 'application/json' });
  Object.defineProperty(malformed, 'text', { value: async () => '{"arbitrary":true}' });
  fireEvent.change(upload, { target: { files: [malformed] } });
  await screen.findByText('تعذر قراءة ملف الترخيص الموقع؛ اطلب ملف JSON صالحاً');
  const huge = new File(['x'.repeat(16_385)], 'too-large.json', { type: 'application/json' });
  fireEvent.change(upload, { target: { files: [huge] } });
  await screen.findByText('ملف الترخيص غير صالح أو يتجاوز الحجم المسموح');
  expect(invoke).not.toHaveBeenCalledWith('license_install', expect.anything());
});
