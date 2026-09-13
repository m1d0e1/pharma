import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateSession } from '@/utils/supabase/middleware';
import { isOwnerOnlyStaffRoute } from '@/lib/auth/staff-policy';

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

  // Staff administration is deliberately owner-only. Other protected routes
  // are authorized by the shared permission guard and their backend actions;
  // hard-coding roles here would override permissions granted by the owner.
  const isStaffRoute = isOwnerOnlyStaffRoute(path);

  if (token && isStaffRoute) {
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
    "script-src 'self' 'unsafe-inline'",
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
