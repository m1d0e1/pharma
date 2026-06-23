import jwt from 'jsonwebtoken';
import { z } from 'zod';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const ACCESS_SECRET = JWT_SECRET;
const REFRESH_SECRET = JWT_REFRESH_SECRET || JWT_SECRET;

const JWT_ACCESS_TOKEN_EXPIRY = '15m'; // 15 minutes
const JWT_REFRESH_TOKEN_EXPIRY = '7d'; // 7 days

// Token payload schema
export const TokenPayloadSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  pharmacyId: z.string().uuid(),
  role: z.enum(['owner', 'manager', 'pharmacist', 'cashier']),
  permissions: z.array(z.string()),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type TokenPayload = z.infer<typeof TokenPayloadSchema>;

// Token pair
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Generate an access token
 * @param payload - Token payload
 * @returns Access token
 */
export function generateAccessToken(payload: Omit<TokenPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_TOKEN_EXPIRY,
  });
}

/**
 * Generate a refresh token
 * @param userId - User ID
 * @returns Refresh token
 */
export function generateRefreshToken(userId: string): string {
  return jwt.sign({ userId, type: 'refresh' }, REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_TOKEN_EXPIRY,
  });
}

/**
 * Generate a token pair (access + refresh)
 * @param payload - Token payload
 * @returns Token pair
 */
export function generateTokenPair(
  payload: Omit<TokenPayload, 'iat' | 'exp'>
): TokenPair {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload.userId);

  // Calculate expiry time in seconds
  const expiresIn = 15 * 60; // 15 minutes

  return {
    accessToken,
    refreshToken,
    expiresIn,
  };
}

/**
 * Verify and decode an access token
 * @param token - Access token
 * @returns Decoded token payload
 */
export function verifyAccessToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET) as any;
    return TokenPayloadSchema.parse(decoded);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
    }
    throw error;
  }
}

/**
 * Verify and decode a refresh token
 * @param token - Refresh token
 * @returns User ID
 */
export function verifyRefreshToken(token: string): string {
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET) as any;
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid refresh token');
    }
    return decoded.userId;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Refresh token expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid refresh token');
    }
    throw error;
  }
}

/**
 * Decode a token without verification (for debugging)
 * @param token - JWT token
 * @returns Decoded token payload
 */
export function decodeToken(token: string): any {
  return jwt.decode(token);
}

/**
 * Get token expiry time
 * @param token - JWT token
 * @returns Expiry date or null if invalid
 */
export function getTokenExpiry(token: string): Date | null {
  try {
    const decoded = decodeToken(token) as any;
    if (decoded && decoded.exp) {
      return new Date(decoded.exp * 1000);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if token is expired
 * @param token - JWT token
 * @returns True if token is expired
 */
export function isTokenExpired(token: string): boolean {
  const expiry = getTokenExpiry(token);
  if (!expiry) {
    return true;
  }
  return expiry < new Date();
}

/**
 * Get time until token expiry
 * @param token - JWT token
 * @returns Time until expiry in seconds, or 0 if expired
 */
export function getTimeUntilExpiry(token: string): number {
  const expiry = getTokenExpiry(token);
  if (!expiry) {
    return 0;
  }
  const now = new Date();
  const diff = expiry.getTime() - now.getTime();
  return Math.max(0, Math.floor(diff / 1000));
}

/**
 * Extract token from Authorization header
 * @param authHeader - Authorization header value
 * @returns Token or null
 */
export function extractToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Create Authorization header value
 * @param token - Access token
 * @returns Authorization header value
 */
export function createAuthHeader(token: string): string {
  return `Bearer ${token}`;
}
