/**
 * Auth Service Tests
 * Tests for authentication business logic
 */

import {
  login,
  logout,
  refreshToken,
  register,
  changePassword,
  getCurrentUser,
} from '@/lib/auth/service';
import { getDatabase, execute, get } from '@/lib/db/client';

// Mock database and uuid
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-123'),
}));

jest.mock('@/lib/db/client', () => {
  const actual = jest.requireActual('@/lib/db/client');
  return {
    ...actual,
    getDatabase: jest.fn(),
    transaction: jest.fn(),
    execute: jest.fn((sql, params) => {
      const db = require('@/lib/db/client').getDatabase();
      const stmt = db.prepare(sql);
      const res = stmt.run ? stmt.run(...params) : {};
      return { changes: 1, lastInsertRowid: 1, ...res };
    }),
    get: jest.fn((sql, params) => {
      const db = require('@/lib/db/client').getDatabase();
      const stmt = db.prepare(sql);
      return stmt.get(...params);
    }),
    query: jest.fn((sql, params) => {
      const db = require('@/lib/db/client').getDatabase();
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    }),
  };
});
jest.mock('@/lib/auth/password', () => ({
  hashPassword: jest.fn((pwd: string) => `hashed_${pwd}`),
  verifyPassword: jest.fn((pwd: string, hash: string) => hash === `hashed_${pwd}`),
  validatePassword: jest.fn(() => ({ valid: true, errors: [] })),
}));

jest.mock('@/lib/auth/jwt', () => ({
  generateTokenPair: jest.fn(() => ({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresIn: 3600,
  })),
  verifyRefreshToken: jest.fn((token: string) => {
    if (token === 'invalid-token') {
      throw new Error('Invalid token');
    }
    return 'user-1';
  }),
}));

jest.mock('@/lib/auth/session', () => ({
  createSession: jest.fn(() => ({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresIn: 3600,
  })),
  deleteSession: jest.fn(),
  refreshSession: jest.fn(() => ({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresIn: 3600,
  })),
  deleteAllUserSessions: jest.fn(),
  getUserSessions: jest.fn(() => []),
  initializeSessionsTable: jest.fn(),
}));

jest.mock('@/lib/shifts/service', () => ({
  startShift: jest.fn(() => ({ id: 'mock-shift-123' })),
  closeShift: jest.fn(),
  getOpenShift: jest.fn(() => null),
  getCurrentShift: jest.fn(() => null),
}));

describe('Auth Service', () => {
  const mockDb = {
    prepare: jest.fn(),
    exec: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
    (execute as jest.Mock).mockReturnValue({ changes: 1 });
  });

  describe('login', () => {
    it('should login user with valid credentials', async () => {
      const mockUser = {
        id: 'user-1',
        username: 'testuser',
        password_hash: 'hashed_password123',
        pharmacy_id: 'pharmacy-1',
        role: 'pharmacist',
        permissions: JSON.stringify(['can_sell', 'can_view_inventory']),
        full_name: 'Test User',
        is_active: 1,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
      });

      const result = await login({
        username: 'testuser',
        password: 'password123',
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.username).toBe('testuser');
    });

    it('should fail with invalid username', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = await login({
        username: 'nonexistent',
        password: 'password123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid username or password');
    });

    it('should fail with invalid password', async () => {
      const mockUser = {
        id: 'user-1',
        username: 'testuser',
        password_hash: 'hashed_wrong',
        pharmacy_id: 'pharmacy-1',
        role: 'pharmacist',
        permissions: '[]',
        full_name: 'Test User',
        is_active: 1,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
      });

      const result = await login({
        username: 'testuser',
        password: 'wrongpassword',
      });

      expect(result.success).toBe(false);
    });

    it('should fail for inactive user', async () => {
      const mockUser = {
        id: 'user-1',
        username: 'testuser',
        password_hash: 'hashed_password123',
        pharmacy_id: 'pharmacy-1',
        role: 'pharmacist',
        permissions: '[]',
        full_name: 'Test User',
        is_active: 0, // Inactive
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
      });

      const result = await login({
        username: 'testuser',
        password: 'password123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Account is inactive');
    });
  });

  describe('logout', () => {
    it('should logout user successfully', async () => {
      const mockUser = {
        id: 'user-1',
        role: 'pharmacist',
        pharmacy_id: 'pharmacy-1',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
      });

      const result = await logout({
        refreshToken: 'valid-refresh-token',
      });

      expect(result.success).toBe(true);
    });

    it('should fail with invalid refresh token', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = await logout({
        refreshToken: 'invalid-token',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('register', () => {
    it('should register new user successfully', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined), // Username not taken
        run: jest.fn(),
      });

      const result = await register({
        username: 'newuser',
        password: 'SecurePass123',
        fullName: 'New User',
        pharmacyId: 'a3b077a2-f8c6-43d9-9ebd-375865243e8d',
        role: 'pharmacist',
      });

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.username).toBe('newuser');
    });

    it('should fail if username already exists', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({ id: 'existing-user' }),
      });

      const result = await register({
        username: 'existing',
        password: 'SecurePass123',
        fullName: 'Existing User',
        pharmacyId: 'a3b077a2-f8c6-43d9-9ebd-375865243e8d',
        role: 'pharmacist',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Username already exists');
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      const mockUser = {
        id: 'user-1',
        password_hash: 'hashed_oldpass',
        is_active: 1,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
        run: jest.fn(),
      });

      const result = await changePassword('user-1', {
        currentPassword: 'oldpass',
        newPassword: 'newpass123',
      });

      expect(result.success).toBe(true);
    });

    it('should fail with wrong current password', async () => {
      const mockUser = {
        id: 'user-1',
        password_hash: 'hashed_wrong',
        is_active: 1,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
      });

      const result = await changePassword('user-1', {
        currentPassword: 'wrongpass',
        newPassword: 'newpass123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Current password is incorrect');
    });

    it('should fail for non-existent user', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = await changePassword('non-existent', {
        currentPassword: 'oldpass',
        newPassword: 'newpass123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user', () => {
      const mockUser = {
        id: 'user-1',
        username: 'testuser',
        pharmacy_id: 'pharmacy-1',
        role: 'pharmacist',
        permissions: '[]',
        full_name: 'Test User',
        is_active: 1,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockUser),
      });

      const result = getCurrentUser('user-1');

      expect(result).toBeDefined();
      expect(result?.username).toBe('testuser');
    });

    it('should return null for non-existent user', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = getCurrentUser('non-existent');

      expect(result).toBeNull();
    });
  });
});
