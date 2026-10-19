import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isOwnerOnlyStaffRoute } from '@/lib/auth/staff-policy';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next();

  const token = request.cookies.get('token')?.value;
  const path = request.nextUrl.pathname;
  const isTauriDev = process.env.NEXT_PUBLIC_TAURI === '1';

  // Public routes
  const publicRoutes = ['/login', '/setup'];
  // Exact packaged public assets must load before login, without exposing
  // adjacent private routes through a broad file-extension or prefix bypass.
  const publicAssets = new Set(['/manifest.json', '/news.json', '/icon-192x192.png', '/icon-512x512.png']);
  const isPublicRoute = publicRoutes.some(route => path.startsWith(route)) || publicAssets.has(path);

  // If no token and trying to access protected route
  if (!isTauriDev && !token && !isPublicRoute) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // If has token and trying to access login page
  if (!isTauriDev && token && path === '/login') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Staff administration is deliberately owner-only. Other protected routes
  // are authorized by the shared permission guard and their backend actions;
  // hard-coding roles here would override permissions granted by the owner.
  const isStaffRoute = isOwnerOnlyStaffRoute(path);

  if (!isTauriDev && token && isStaffRoute) {
    const userRole = request.cookies.get('userRole')?.value;
    if (userRole !== 'owner') {
      return NextResponse.redirect(new URL('/unauthorized', request.url));
    }
  }

  // Add security headers
  const headers = new Headers(response.headers);

  // Security headers
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );

  // CSP header (Content Security Policy)
  const csp = [
    "default-src 'self'",
    process.env.NODE_ENV === 'development'
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  headers.set('Content-Security-Policy', csp);

  headers.forEach((value, key) => {
    response.headers.set(key, value);
  });

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder files
     */
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};
