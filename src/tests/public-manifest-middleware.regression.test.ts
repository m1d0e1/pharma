/** @jest-environment node */
import { middleware } from '@/middleware';
import type { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

function requestFor(path: string): NextRequest {
  return {
    url: `http://localhost:3125${path}`,
    nextUrl: { pathname: path },
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

describe('public PWA manifest and private-route middleware isolation', () => {
  const previous = process.env.NEXT_PUBLIC_TAURI;
  beforeAll(() => { process.env.NEXT_PUBLIC_TAURI = '0'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_TAURI;
    else process.env.NEXT_PUBLIC_TAURI = previous;
  });

  it('serves the declared public manifest without redirecting to login', async () => {
    const response = await middleware(requestFor('/manifest.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it.each(['/news.json', '/icon-192x192.png', '/icon-512x512.png'])(
    'serves the explicitly bundled public asset %s without authentication',
    async path => {
      const response = await middleware(requestFor(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    },
  );

  it('ships real correctly sized PNG files for every advertised manifest icon', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public', 'manifest.json'), 'utf8'));
    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\/icon-(?:192x192|512x512)\.png$/);
      const bytes = readFileSync(join(process.cwd(), 'public', icon.src.slice(1)));
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(bytes.readUInt32BE(16)).toBe(width);
      expect(bytes.readUInt32BE(20)).toBe(height);
    }
  });

  it.each(['/pos', '/reports', '/staff', '/manifest.json/private', '/manifest-secret.json', '/news.json/private', '/icon-192x192.png/private'])(
    'keeps %s protected without a token',
    async path => {
      const response = await middleware(requestFor(path));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3125/login');
    },
  );
});
