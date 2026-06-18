/**
 * CSRF (Cross-Site Request Forgery) Protection
 * Implements double-submit cookie pattern for CSRF protection
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const CSRF_SECRET = process.env.CSRF_SECRET || 'change-in-production-secret';
const CSRF_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour

/**
 * Generate a CSRF token
 * @returns CSRF token
 */
export function generateCSRFToken(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2);
  const signature = Buffer.from(`${timestamp}:${random}:${CSRF_SECRET}`).toString('base64');
  return signature;
}

/**
 * Validate a CSRF token
 * @param token - CSRF token to validate
 * @returns True if token is valid
 */
export function validateCSRFToken(token: string): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parts = decoded.split(':');

    if (parts.length !== 3) {
      return false;
    }

    const [timestamp, random, secret] = parts;

    // Verify secret
    if (secret !== CSRF_SECRET) {
      return false;
    }

    // Check token age
    const tokenAge = Date.now() - parseInt(timestamp, 10);
    if (tokenAge > CSRF_TOKEN_EXPIRY || tokenAge < 0) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Get CSRF token from cookies
 * @returns CSRF token or null
 */
export async function getCSRFTokenFromCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get('csrf_token')?.value || null;
}

/**
 * Set CSRF token in cookies
 * @param token - CSRF token to set
 */
export async function setCSRFTokenCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set('csrf_token', token, {
    httpOnly: false, // Must be readable by JavaScript
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: CSRF_TOKEN_EXPIRY / 1000
  });
}

/**
 * Generate and set CSRF token
 * @returns CSRF token
 */
export async function generateAndSetCSRFToken(): Promise<string> {
  const token = generateCSRFToken();
  await setCSRFTokenCookie(token);
  return token;
}

/**
 * Validate CSRF token from request
 * @param token - CSRF token from request headers
 * @param cookieToken - CSRF token from cookies (optional, will fetch if not provided)
 * @returns True if tokens match and are valid
 */
export async function validateCSRFRequest(
  token: string | null,
  cookieToken?: string | null
): Promise<boolean> {
  // Get cookie token if not provided
  if (cookieToken === undefined) {
    cookieToken = await getCSRFTokenFromCookie();
  }

  // Both tokens must exist
  if (!token || !cookieToken) {
    return false;
  }

  // Tokens must match
  if (token !== cookieToken) {
    return false;
  }

  // Token must be valid
  return validateCSRFToken(token);
}

/**
 * Middleware wrapper for CSRF protection
 * @param handler - Next.js route handler
 * @returns Wrapped handler with CSRF protection
 */
export function withCSRFProtection<T extends NextRequest>(
  handler: (request: T) => Promise<NextResponse>
): (request: T) => Promise<NextResponse> {
  return async (request: T) => {
    // Skip CSRF for safe methods
    const method = request.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return handler(request);
    }

    // Get CSRF token from header
    const token = request.headers.get('x-csrf-token');

    // Validate CSRF
    const isValid = await validateCSRFRequest(token);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    return handler(request);
  };
}

/**
 * Get CSRF error response
 * @returns NextResponse with CSRF error
 */
export function getCSRFErrorResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Invalid CSRF token. Please refresh the page and try again.' },
    { status: 403 }
  );
}
