import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateSession } from '@/utils/supabase/middleware';

export async function middleware(request: NextRequest) {
  // 1. Update Supabase session (Cloud Brain)
  // This prevents the "Invalid Refresh Token: Already Used" error
  let response = await updateSession(request);

  const token = request.cookies.get('token')?.value;
  const path = request.nextUrl.pathname;

  // Public routes
  const publicRoutes = ['/login', '/setup', '/subscription'];
  const isPublicRoute = publicRoutes.some(route => path.startsWith(route));

  // If no token and trying to access protected route
  if (!token && !isPublicRoute) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // If has token and trying to access login page
  if (token && path === '/login') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Check subscription activation for admin
  if (token && path === '/') {
    const subscriptionActivated = request.cookies.get('subscriptionActivated')?.value;
    const userRole = request.cookies.get('userRole')?.value;

    // If admin and subscription not activated, redirect to subscription page
    if (userRole === 'owner' && !subscriptionActivated) {
      return NextResponse.redirect(new URL('/subscription', request.url));
    }
  }

  // Admin and Finance route protection
  const adminRoutes = ['/staff', '/reports', '/settings', '/audit', '/sales/cogs', '/accounts/settings'];
  const isAdminRoute = adminRoutes.some((route) =>
    path.startsWith(route)
  );

  if (token && isAdminRoute) {
    const userRole = request.cookies.get('userRole')?.value;

    // Only allow users with owner or manager roles
    const allowedRoles = ['owner', 'admin'];
    if (!userRole || !allowedRoles.includes(userRole)) {
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
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
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
