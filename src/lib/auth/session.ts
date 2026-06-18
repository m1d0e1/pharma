import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, query, get } from '../db/client';
import { TokenPair, generateTokenPair, verifyRefreshToken } from './jwt';
import { TokenPayload } from './jwt';

export interface Session {
  id: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  createdAt: Date;
  lastAccessedAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface CreateSessionOptions {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Create a new session
 * @param payload - Token payload
 * @param options - Session options
 * @returns Token pair
 */
export function createSession(
  payload: Omit<TokenPayload, 'iat' | 'exp'>,
  options: CreateSessionOptions
): TokenPair {
  const db = getDatabase();

  // Generate token pair
  const tokenPair = generateTokenPair(payload);

  // Calculate expiry date
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  // Store session in database
  execute(
    `INSERT INTO sessions (id, user_id, refresh_token, expires_at, created_at, last_accessed_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      options.userId,
      tokenPair.refreshToken,
      expiresAt.toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      options.ipAddress || null,
      options.userAgent || null,
    ]
  );

  return tokenPair;
}

/**
 * Get a session by refresh token
 * @param refreshToken - Refresh token
 * @returns Session or null
 */
export function getSession(refreshToken: string): Session | null {
  const db = getDatabase();

  const row = get<Session>(
    `SELECT * FROM sessions WHERE refresh_token = ? AND expires_at > datetime('now')`,
    [refreshToken]
  );

  return row || null;
}

/**
 * Update session last accessed time
 * @param refreshToken - Refresh token
 */
export function updateSessionAccess(refreshToken: string): void {
  const db = getDatabase();

  execute(
    `UPDATE sessions SET last_accessed_at = datetime('now') WHERE refresh_token = ?`,
    [refreshToken]
  );
}

/**
 * Delete a session
 * @param refreshToken - Refresh token
 */
export function deleteSession(refreshToken: string): void {
  const db = getDatabase();

  execute(`DELETE FROM sessions WHERE refresh_token = ?`, [refreshToken]);
}

/**
 * Delete all sessions for a user
 * @param userId - User ID
 */
export function deleteAllUserSessions(userId: string): void {
  const db = getDatabase();

  execute(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

/**
 * Delete all expired sessions
 */
export function deleteExpiredSessions(): void {
  const db = getDatabase();

  execute(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);
}

/**
 * Refresh a session
 * @param refreshToken - Refresh token
 * @param options - Session options
 * @returns New token pair or null
 */
export function refreshSession(
  refreshToken: string,
  options?: Partial<CreateSessionOptions>
): TokenPair | null {
  // Verify refresh token
  const userId = verifyRefreshToken(refreshToken);

  // Get existing session
  const session = getSession(refreshToken);
  if (!session) {
    return null;
  }

  // Get user data
  const user = get<any>(
    `SELECT id, username, pharmacy_id, role, permissions FROM users WHERE id = ? AND is_active = 1`,
    [userId]
  );

  if (!user) {
    deleteSession(refreshToken);
    return null;
  }

  // Delete old session
  deleteSession(refreshToken);

  // Create new session
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    userId: user.id,
    username: user.username,
    pharmacyId: user.pharmacy_id,
    role: user.role,
    permissions: JSON.parse(user.permissions),
  };

  return createSession(payload, {
    userId: user.id,
    ipAddress: options?.ipAddress || session.ipAddress,
    userAgent: options?.userAgent || session.userAgent,
  });
}

/**
 * Get all sessions for a user
 * @param userId - User ID
 * @returns List of sessions
 */
export function getUserSessions(userId: string): Session[] {
  const db = getDatabase();

  return query<Session>(
    `SELECT * FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY last_accessed_at DESC`,
    [userId]
  );
}

/**
 * Get active session count for a user
 * @param userId - User ID
 * @returns Number of active sessions
 */
export function getActiveSessionCount(userId: string): number {
  const db = getDatabase();

  const result = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM sessions WHERE user_id = ? AND expires_at > datetime('now')`,
    [userId]
  );

  return result?.count || 0;
}

/**
 * Clean up old sessions (older than 30 days)
 */
export function cleanupOldSessions(): void {
  const db = getDatabase();

  execute(
    `DELETE FROM sessions WHERE created_at < datetime('now', '-30 days')`
  );
}

// Initialize sessions table
export function initializeSessionsTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refresh_token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      last_accessed_at DATETIME NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);
}
