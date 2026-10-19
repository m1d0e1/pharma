import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, Root } from 'react-dom/client';
import LicenseBoundary from '@/components/LicenseBoundary';

// During static export `isTauri` is false; in the real WebView2 renderer it
// becomes true *before* React hydrates. Reproduce that split in one DOM.
let mockNativeRenderer = false;
jest.mock('@/lib/env', () => ({ get isTauri() { return mockNativeRenderer; } }));
const mockInvoke = jest.fn();
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));

it('hydrates the static export identically on a native renderer, withholding protected content until native license verification', async () => {
  mockNativeRenderer = false;
  mockInvoke.mockResolvedValue({ valid: false, startup_ready: false, reason: 'Synthetic license denied',
    machine_fingerprint: '', license_id: null, expires_at_utc: null, lease_until_utc: null });
  const children = <strong>Protected pharmacy data</strong>;
  const serverMarkup = renderToString(<LicenseBoundary>{children}</LicenseBoundary>);
  const container = document.createElement('div');
  container.innerHTML = serverMarkup;
  document.body.appendChild(container);
  const nativeErrors: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { nativeErrors.push(parts.map(String).join(' ')); };
  let root: Root | null = null;
  try {
    mockNativeRenderer = true;
    await act(async () => {
      root = hydrateRoot(container, <LicenseBoundary>{children}</LicenseBoundary>);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(nativeErrors.join('\n')).not.toMatch(/hydration|server rendered HTML|didn't match/i);
    expect(mockInvoke).toHaveBeenCalledWith('license_status');
    expect(container).toHaveTextContent('Synthetic license denied');
    expect(container).not.toHaveTextContent('Protected pharmacy data');
  } finally {
    if (root) await act(async () => { root?.unmount(); });
    mockNativeRenderer = false;
    console.error = originalError;
    container.remove();
  }
});

it('hydrates the same static export for a legitimate non-native web client, then displays its children', async () => {
  mockNativeRenderer = false;
  mockInvoke.mockClear();
  const children = <strong>Web development pharmacy content</strong>;
  const serverMarkup = renderToString(<LicenseBoundary>{children}</LicenseBoundary>);
  const container = document.createElement('div');
  container.innerHTML = serverMarkup;
  document.body.appendChild(container);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
  let root: Root | null = null;
  try {
    expect(container).not.toHaveTextContent('Web development pharmacy content');
    await act(async () => {
      root = hydrateRoot(container, <LicenseBoundary>{children}</LicenseBoundary>);
    });
    expect(errors.join('\n')).not.toMatch(/hydration|server rendered HTML|didn't match/i);
    expect(container).toHaveTextContent('Web development pharmacy content');
    expect(mockInvoke).not.toHaveBeenCalled();
  } finally {
    if (root) await act(async () => { root?.unmount(); });
    console.error = originalError;
    container.remove();
  }
});
