/** @jest-environment node */

import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

describe('middleware Tauri development routing', () => {
  const previousTauriFlag = process.env.NEXT_PUBLIC_TAURI;

  afterEach(() => {
    if (previousTauriFlag === undefined) {
      delete process.env.NEXT_PUBLIC_TAURI;
    } else {
      process.env.NEXT_PUBLIC_TAURI = previousTauriFlag;
    }
  });

  it('lets the Tauri client guards own authentication while preserving security headers', async () => {
    process.env.NEXT_PUBLIC_TAURI = '1';
    const response = await middleware(new NextRequest('http://localhost:3017/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    // Jest compiles NODE_ENV as 'test', not 'development'; the actual dev
    // header is verified separately against the running GUI.
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
  });

  it('keeps the normal web cookie redirect unchanged', async () => {
    delete process.env.NEXT_PUBLIC_TAURI;
    const response = await middleware(new NextRequest('http://localhost:3000/'));

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('keeps browser route authentication separate from Tauri development routing', async () => {
    delete process.env.NEXT_PUBLIC_TAURI;
    const login = await middleware(new NextRequest('http://localhost:3107/login'));
    expect(login.status).toBe(200);
    expect(login.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
    const protectedRoute = await middleware(new NextRequest('http://localhost:3107/accounts'));
    expect(protectedRoute.headers.get('location')).toBe('http://localhost:3107/login');
  });

  it('rejects eval outside development even if the renderer was built for Tauri', async () => {
    process.env.NEXT_PUBLIC_TAURI = '1';
    const response = await middleware(new NextRequest('http://localhost:3107/login'));
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
  });
});
