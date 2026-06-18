import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken, extractToken } from './jwt';
import { setCurrentUser, getCurrentUser } from './permissions';
import { getDatabase, get } from '../db/client';
import { TokenPayload } from './jwt';
import { Permission } from './roles';

/**
 * Authentication middleware for API routes
 * @param request - Next.js request
 * @returns Response with user context or error
 */
export async function withAuth(
  request: NextRequest,
  handler: (request: NextRequest, user: TokenPayload) => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    // Extract token from Authorization header
    const authHeader = request.headers.get('authorization');
    const token = extractToken(authHeader);

    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized: No token provided' },
        { status: 401 }
      );
    }

    // Verify token
    let payload: TokenPayload;
    try {
      payload = verifyAccessToken(token);
    } catch (jwtError) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid token' },
        { status: 401 }
      );
    }

    // Convert TokenPayload to User for setCurrentUser
    const user = {
      id: payload.userId,
      username: payload.username,
      pharmacyId: payload.pharmacyId,
      role: payload.role,
      permissions: payload.permissions as Permission[],
    };

    // Set current user context
    setCurrentUser(user);

    // Call handler with user context
    return await handler(request, payload);
  } catch (error) {
    console.error('Auth middleware error:', error);

    if (error instanceof Error) {
      if (error.message === 'Token expired') {
        return NextResponse.json(
          { error: 'Unauthorized: Token expired' },
          { status: 401 }
        );
      }
      if (error.message === 'Invalid token') {
        return NextResponse.json(
          { error: 'Unauthorized: Invalid token' },
          { status: 401 }
        );
      }
    }

    return NextResponse.json(
      { error: 'Unauthorized: Authentication failed' },
      { status: 401 }
    );
  }
}

/**
 * Permission middleware for API routes
 * @param request - Next.js request
 * @param requiredPermissions - Required permissions
 * @param handler - Request handler
 * @returns Response or error
 */
export async function withPermission(
  request: NextRequest,
  requiredPermissions: string[],
  handler: (request: NextRequest, user: TokenPayload) => Promise<NextResponse>
): Promise<NextResponse> {
  return withAuth(request, async (req, user) => {
    // Check if user has all required permissions
    const hasAllPermissions = requiredPermissions.every((permission) =>
      user.permissions.includes(permission)
    );

    if (!hasAllPermissions) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions' },
        { status: 403 }
      );
    }

    return await handler(req, user);
  });
}

/**
 * Role middleware for API routes
 * @param request - Next.js request
 * @param allowedRoles - Allowed roles
 * @param handler - Request handler
 * @returns Response or error
 */
export async function withRole(
  request: NextRequest,
  allowedRoles: string[],
  handler: (request: NextRequest, user: TokenPayload) => Promise<NextResponse>
): Promise<NextResponse> {
  return withAuth(request, async (req, user) => {
    // Check if user has allowed role
    if (!allowedRoles.includes(user.role)) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient role' },
        { status: 403 }
      );
    }

    return await handler(req, user);
  });
}

/**
 * Get current user from request
 * @param request - Next.js request
 * @returns User payload or null
 */
export function getCurrentUserFromRequest(
  request: NextRequest
): TokenPayload | null {
  try {
    const authHeader = request.headers.get('authorization');
    const token = extractToken(authHeader);

    if (!token) {
      return null;
    }

    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

/**
 * Check if user is authenticated
 * @param request - Next.js request
 * @returns True if authenticated
 */
export function isAuthenticated(request: NextRequest): boolean {
  return getCurrentUserFromRequest(request) !== null;
}

/**
 * Get user from database
 * @param userId - User ID
 * @returns User data or null
 */
export function getUserFromDatabase(userId: string): any {
  const db = getDatabase();

  return get(
    `SELECT id, username, pharmacy_id, role, permissions, full_name, is_active
     FROM users
     WHERE id = ? AND is_active = 1`,
    [userId]
  );
}

/**
 * Validate user session
 * @param request - Next.js request
 * @returns True if session is valid
 */
export function validateSession(request: NextRequest): boolean {
  const user = getCurrentUserFromRequest(request);

  if (!user) {
    return false;
  }

  // Check if user is still active
  const dbUser = getUserFromDatabase(user.userId);

  if (!dbUser) {
    return false;
  }

  return true;
}

/**
 * Pharmacy access middleware
 * @param request - Next.js request
 * @param pharmacyId - Pharmacy ID to check
 * @param handler - Request handler
 * @returns Response or error
 */
export async function withPharmacyAccess(
  request: NextRequest,
  pharmacyId: string,
  handler: (request: NextRequest, user: TokenPayload) => Promise<NextResponse>
): Promise<NextResponse> {
  return withAuth(request, async (req, user) => {
    // Check if user belongs to the pharmacy
    if (user.pharmacyId !== pharmacyId) {
      return NextResponse.json(
        { error: 'Forbidden: Pharmacy access denied' },
        { status: 403 }
      );
    }

    return await handler(req, user);
  });
}

/**
 * Owner-only middleware
 * @param request - Next.js request
 * @param handler - Request handler
 * @returns Response or error
 */
export async function withOwner(
  request: NextRequest,
  handler: (request: NextRequest, user: TokenPayload) => Promise<NextResponse>
): Promise<NextResponse> {
  return withRole(request, ['owner'], handler);
}

/**
 * Manager or owner middleware
 * @param request - Next.js request
 * @param handler - Request handler
 * @returns Response or error
 */
export async function withManagerOrOwner(
  request: NextRequest,
  handler: (request: NextRequest, user: TokenPayload) => Promise<NextResponse>
): Promise<NextResponse> {
  return withRole(request, ['owner', 'manager'], handler);
}
