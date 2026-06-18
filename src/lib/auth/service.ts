import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query } from '../db/client';
import { hashPassword, verifyPassword, validatePassword } from './password';
import {
  generateTokenPair,
  verifyRefreshToken,
  TokenPayload,
} from './jwt';
import {
  createSession,
  deleteSession,
  refreshSession,
  deleteAllUserSessions,
  getUserSessions,
  initializeSessionsTable,
} from './session';
import { ROLE_PERMISSIONS, Permission } from './roles';
import {
  startShift,
  closeShift,
  getOpenShift,
  getCurrentShift,
} from '../shifts/service';

// Login request schema
export const LoginRequestSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
  startingCashAmount: z.number().optional(),
  openingNotes: z.string().optional(),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

// Login response schema
export const LoginResponseSchema = z.object({
  success: z.boolean(),
  token: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().optional(),
  user: z
    .object({
      id: z.string(),
      username: z.string(),
      pharmacyId: z.string(),
      role: z.string(),
      permissions: z.array(z.string()),
      fullName: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// Register request schema
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8),
  fullName: z.string().min(1),
  pharmacyId: z.string().uuid(),
  role: z.enum(['owner', 'manager', 'pharmacist', 'cashier']),
  permissions: z.array(z.string()).optional(),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

// Change password request schema
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// Auth result
export interface AuthResult {
  success: boolean;
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: {
    id: string;
    username: string;
    pharmacyId: string;
    role: string;
    permissions: Permission[];
    fullName?: string;
  };
  shiftId?: string;
  error?: string;
}

/**
 * Login a user
 * @param request - Login request
 * @param options - Session options
 * @returns Auth result
 */
export async function login(
  request: LoginRequest,
  options?: {
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<AuthResult> {
  try {
    // Validate request
    LoginRequestSchema.parse(request);

    // Get user from database
    const user = get<any>(
      `SELECT id, username, password_hash, pharmacy_id, role, permissions, full_name, is_active
       FROM users
       WHERE username = ?`,
      [request.username]
    );

    if (!user) {
      return {
        success: false,
        error: 'Invalid username or password',
      };
    }

    // Check if user is active
    if (!user.is_active) {
      return {
        success: false,
        error: 'Account is inactive',
      };
    }

    // Verify password
    const isValid = await verifyPassword(request.password, user.password_hash);

    if (!isValid) {
      return {
        success: false,
        error: 'Invalid username or password',
      };
    }

    // Check if user already has an open shift (for pharmacists)
    if (user.role === 'pharmacist' || user.role === 'cashier') {
      const existingShift = getOpenShift(user.id);
      if (existingShift) {
        return {
          success: false,
          error: 'You already have an open shift. Please close it first.',
        };
      }
    }

    // Parse permissions
    const permissions: Permission[] = JSON.parse(user.permissions);

    // Create token payload
    const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
      userId: user.id,
      username: user.username,
      pharmacyId: user.pharmacy_id,
      role: user.role,
      permissions,
    };

    // Initialize sessions table if needed
    initializeSessionsTable();

    // Create session and tokens
    const tokenPair = createSession(payload, {
      userId: user.id,
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
    });

    // Start shift for pharmacists and cashiers
    let shiftId: string | undefined;
    if ((user.role === 'pharmacist' || user.role === 'cashier') && request.startingCashAmount !== undefined) {
      try {
        const shift = startShift(user.pharmacy_id, user.id, {
          startingCashAmount: request.startingCashAmount,
          openingNotes: request.openingNotes,
        });
        shiftId = shift.id;
      } catch (error) {
        console.error('Failed to start shift:', error);
        // Continue with login even if shift fails
      }
    }

    // Log successful login
    logAuditEvent(user.id, user.pharmacy_id, 'login', 'users', user.id, {
      username: user.username,
      ipAddress: options?.ipAddress,
      shiftId,
    });

    return {
      success: true,
      token: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: user.id,
        username: user.username,
        pharmacyId: user.pharmacy_id,
        role: user.role,
        permissions,
        fullName: user.full_name,
      },
      shiftId,
    };
  } catch (error) {
    console.error('Login error:', error);
    return {
      success: false,
      error: 'Login failed',
    };
  }
}

// Logout request schema
export const LogoutRequestSchema = z.object({
  refreshToken: z.string(),
  endingCashAmount: z.number().optional(),
  closingNotes: z.string().optional(),
});

export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

/**
 * Logout a user
 * @param request - Logout request
 * @returns Success status
 */
export async function logout(request: LogoutRequest): Promise<{ success: boolean; error?: string; shiftClosed?: boolean }> {
  try {
    if (!request || !request.refreshToken) {
      return { success: true, shiftClosed: false };
    }
    // Verify refresh token
    const userId = verifyRefreshToken(request.refreshToken);

    // Get user to check role
    const user = get<any>(
      `SELECT id, role, pharmacy_id FROM users WHERE id = ?`,
      [userId]
    );

    // Close shift for pharmacists and cashiers
    let shiftClosed = false;
    if (user && (user.role === 'pharmacist' || user.role === 'cashier')) {
      const openShift = getOpenShift(userId);
      if (openShift && request.endingCashAmount !== undefined) {
        try {
          closeShift(openShift.id, {
            endingCashAmount: request.endingCashAmount,
            closingNotes: request.closingNotes,
          });
          shiftClosed = true;
        } catch (error) {
          console.error('Failed to close shift:', error);
          // Continue with logout even if shift fails
        }
      }
    }

    // Delete session
    deleteSession(request.refreshToken);

    // Log logout
    logAuditEvent(userId, user?.pharmacy_id || '', 'logout', 'users', userId, {
      shiftClosed,
    });

    return { success: true, shiftClosed };
  } catch (error) {
    console.error('Logout error:', error);
    return {
      success: false,
      error: 'Logout failed',
    };
  }
}

/**
 * Refresh tokens
 * @param refreshToken - Refresh token
 * @param options - Session options
 * @returns New token pair or null
 */
export async function refreshToken(
  refreshToken: string,
  options?: {
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<AuthResult | null> {
  try {
    // Refresh session
    const tokenPair = refreshSession(refreshToken, options);

    if (!tokenPair) {
      return null;
    }

    // Get user ID from refresh token
    const userId = verifyRefreshToken(refreshToken);

    // Get user data
    const user = get<any>(
      `SELECT id, username, pharmacy_id, role, permissions, full_name
       FROM users
       WHERE id = ? AND is_active = 1`,
      [userId]
    );

    if (!user) {
      return null;
    }

    // Parse permissions
    const permissions: Permission[] = JSON.parse(user.permissions);

    return {
      success: true,
      token: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      user: {
        id: user.id,
        username: user.username,
        pharmacyId: user.pharmacy_id,
        role: user.role,
        permissions,
        fullName: user.full_name,
      },
    };
  } catch (error) {
    console.error('Refresh token error:', error);
    return null;
  }
}

/**
 * Register a new user
 * @param request - Register request
 * @returns Auth result
 */
export async function register(
  request: RegisterRequest
): Promise<AuthResult> {
  try {
    // Validate request
    RegisterRequestSchema.parse(request);

    // Validate password
    const passwordValidation = validatePassword(request.password);
    if (!passwordValidation.valid) {
      return {
        success: false,
        error: passwordValidation.errors.join(', '),
      };
    }

    // Check if username already exists
    const existingUser = get<any>(
      `SELECT id FROM users WHERE username = ?`,
      [request.username]
    );

    if (existingUser) {
      return {
        success: false,
        error: 'Username already exists',
      };
    }

    // Hash password
    const passwordHash = await hashPassword(request.password);

    // Get default permissions for role
    const rolePermissions =
      ROLE_PERMISSIONS[request.role]?.permissions || [];

    // Create user
    const userId = uuidv4();
    execute(
      `INSERT INTO users (id, username, password_hash, pharmacy_id, role, permissions, full_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [
        userId,
        request.username,
        passwordHash,
        request.pharmacyId,
        request.role,
        JSON.stringify(request.permissions || rolePermissions),
        request.fullName,
      ]
    );

    // Log registration
    logAuditEvent(userId, request.pharmacyId, 'register', 'users', userId, {
      username: request.username,
      role: request.role,
    });

    return {
      success: true,
      user: {
        id: userId,
        username: request.username,
        pharmacyId: request.pharmacyId,
        role: request.role,
        permissions: (request.permissions || rolePermissions) as Permission[],
        fullName: request.fullName,
      },
    };
  } catch (error) {
    console.error('Register error:', error);
    return {
      success: false,
      error: 'Registration failed',
    };
  }
}

/**
 * Change password
 * @param userId - User ID
 * @param request - Change password request
 * @returns Success status
 */
export async function changePassword(
  userId: string,
  request: ChangePasswordRequest
): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate request
    ChangePasswordRequestSchema.parse(request);

    // Get user
    const user = get<any>(
      `SELECT id, password_hash FROM users WHERE id = ? AND is_active = 1`,
      [userId]
    );

    if (!user) {
      return {
        success: false,
        error: 'User not found',
      };
    }

    // Verify current password
    const isValid = await verifyPassword(
      request.currentPassword,
      user.password_hash
    );

    if (!isValid) {
      return {
        success: false,
        error: 'Current password is incorrect',
      };
    }

    // Validate new password
    const passwordValidation = validatePassword(request.newPassword);
    if (!passwordValidation.valid) {
      return {
        success: false,
        error: passwordValidation.errors.join(', '),
      };
    }

    // Hash new password
    const newPasswordHash = await hashPassword(request.newPassword);

    // Update password
    execute(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      [newPasswordHash, userId]
    );

    // Log password change
    logAuditEvent(userId, '', 'change_password', 'users', userId);

    // Invalidate all sessions
    deleteAllUserSessions(userId);

    return { success: true };
  } catch (error) {
    console.error('Change password error:', error);
    return {
      success: false,
      error: 'Password change failed',
    };
  }
}

/**
 * Get current user
 * @param userId - User ID
 * @returns User data or null
 */
export function getCurrentUser(userId: string): any {
  return get<any>(
    `SELECT id, username, pharmacy_id, role, permissions, full_name, is_active
     FROM users
     WHERE id = ? AND is_active = 1`,
    [userId]
  ) || null;
}

/**
 * Get user sessions
 * @param userId - User ID
 * @returns List of sessions
 */
export function getUserSessionsList(userId: string): any[] {
  return getUserSessions(userId);
}

/**
 * Log audit event
 * @param userId - User ID
 * @param pharmacyId - Pharmacy ID
 * @param actionType - Action type
 * @param tableName - Table name
 * @param recordId - Record ID
 * @param details - Additional details
 */
function logAuditEvent(
  userId: string,
  pharmacyId: string,
  actionType: string,
  tableName: string,
  recordId: string,
  details?: any
): void {
  try {
    execute(
      `INSERT INTO audit_logs (id, user_id, pharmacy_id, action_type, table_name, record_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        uuidv4(),
        userId,
        pharmacyId,
        actionType,
        tableName,
        recordId,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (error) {
    console.error('Failed to log audit event:', error);
  }
}
