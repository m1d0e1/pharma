/**
 * Shifts Service Tests
 * Tests for shift management business logic
 */

import {
  startShift,
  closeShift,
  getShift,
  getOpenShift,
  getPharmacyShifts,
  getShiftStatistics,
  calculateExpectedCash,
  getShiftDiscrepancy,
  verifyShift,
  getUserShiftHistory,
  getCurrentShift,
  hasOpenShift,
  getShiftSalesSummary,
} from '@/lib/shifts/service';
import { getDatabase, execute, get, query } from '@/lib/db/client';

jest.mock('@/lib/db/client', () => {
  return {
    getDatabase: jest.fn(),
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
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-shift-uuid'),
}));

describe('Shifts Service', () => {
  const mockDb = {
    prepare: jest.fn(),
    exec: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
    (execute as jest.Mock).mockReturnValue({ changes: 1 });
  });

  describe('startShift', () => {
    it('should start a new shift', () => {
      const mockShift = {
        id: 'shift-1',
        pharmacy_id: 'pharmacy-1',
        user_id: 'user-1',
        starting_cash_amount: 1000,
        status: 'open',
        shift_start: '2025-01-01T09:00:00',
      };

      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(mockShift),
      });

      const result = startShift('pharmacy-1', 'user-1', {
        startingCashAmount: 1000,
        openingNotes: 'Morning shift',
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('open');
      expect(result.startingCashAmount).toBe(1000);
    });

    it('should throw error if user already has open shift', () => {
      const mockOpenShift = {
        id: 'existing-shift',
        status: 'open',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockOpenShift),
      });

      expect(() => {
        startShift('pharmacy-1', 'user-1', {
          startingCashAmount: 1000,
        });
      }).toThrow('User already has an open shift');
    });
  });

  describe('closeShift', () => {
    it('should close a shift', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
        starting_cash_amount: 1000,
      };

      const mockSales = { total: 500 };

      const mockShiftClosed = { ...mockShift, status: 'closed', ending_cash_amount: 1500 };
      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockSales)
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(mockShiftClosed),
        run: jest.fn(),
      });

      const result = closeShift('shift-1', {
        endingCashAmount: 1500,
        closingNotes: 'Shift ended',
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('closed');
    });

    it('should mark discrepancy if cash difference is significant', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
        starting_cash_amount: 1000,
      };

      const mockSales = { total: 500 };

      const mockShiftDiscrepancy = { ...mockShift, status: 'discrepancy', ending_cash_amount: 2000 };
      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockSales)
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(mockShiftDiscrepancy),
        run: jest.fn(),
      });

      const result = closeShift('shift-1', {
        endingCashAmount: 2000, // 500 more than expected
        closingNotes: 'Discrepancy noted',
      });

      expect(result.status).toBe('discrepancy');
    });

    it('should throw error for non-existent shift', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      expect(() => {
        closeShift('non-existent', {
          endingCashAmount: 1500,
        });
      }).toThrow('Shift not found');
    });

    it('should throw error if shift is already closed', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'closed',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      expect(() => {
        closeShift('shift-1', {
          endingCashAmount: 1500,
        });
      }).toThrow('Shift is already closed');
    });
  });

  describe('getShift', () => {
    it('should return shift by ID', () => {
      const mockShift = {
        id: 'shift-1',
        username: 'testuser',
        full_name: 'Test User',
        status: 'open',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      const result = getShift('shift-1');

      expect(result).toBeDefined();
      expect(result?.id).toBe('shift-1');
    });

    it('should return null for non-existent shift', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = getShift('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getOpenShift', () => {
    it('should return open shift for user', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
        username: 'testuser',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      const result = getOpenShift('user-1');

      expect(result).toBeDefined();
      expect(result?.status).toBe('open');
    });

    it('should return null if no open shift', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = getOpenShift('user-1');

      expect(result).toBeNull();
    });
  });

  describe('getPharmacyShifts', () => {
    it('should return shifts for pharmacy', () => {
      const mockShifts = [
        { id: 'shift-1', status: 'closed' },
        { id: 'shift-2', status: 'open' },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockShifts),
      });

      const result = getPharmacyShifts('pharmacy-1');

      expect(result).toHaveLength(2);
    });

    it('should filter by user ID', () => {
      const mockShifts = [
        { id: 'shift-1', user_id: 'user-1' },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockShifts),
      });

      const result = getPharmacyShifts('pharmacy-1', { userId: 'user-1' });

      expect(result).toHaveLength(1);
    });
  });

  describe('getShiftStatistics', () => {
    it('should return shift statistics', () => {
      const mockStats = {
        total_shifts: 10,
        open_shifts: 1,
        closed_shifts: 8,
        discrepancy_shifts: 1,
        total_cash_handled: 50000,
      };

      const mockAvgDuration = { avg_duration_minutes: 480 };

      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockStats)
          .mockReturnValueOnce(mockAvgDuration),
      });

      const result = getShiftStatistics('pharmacy-1');

      expect(result.totalShifts).toBe(10);
      expect(result.openShifts).toBe(1);
      expect(result.closedShifts).toBe(8);
      expect(result.discrepancyShifts).toBe(1);
      expect(result.totalCashHandled).toBe(50000);
    });
  });

  describe('calculateExpectedCash', () => {
    it('should calculate expected cash for shift', () => {
      const mockShift = {
        id: 'shift-1',
        user_id: 'user-1',
        starting_cash_amount: 1000,
        shift_start: '2025-01-01T09:00:00',
      };

      const mockSales = { total: 500 };

      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockSales),
      });

      const result = calculateExpectedCash('shift-1');

      expect(result).toBe(1500); // 1000 + 500
    });
  });

  describe('getShiftDiscrepancy', () => {
    it('should return discrepancy information', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'closed',
        starting_cash_amount: 1000,
        ending_cash_amount: 1550,
        user_id: 'user-1',
        shift_start: '2025-01-01T09:00:00',
      };

      const mockSales = { total: 500 };

      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockSales),
      });

      const result = getShiftDiscrepancy('shift-1');

      expect(result).toBeDefined();
      expect(result.expectedCash).toBe(1500);
      expect(result.actualCash).toBe(1550);
      expect(result.discrepancy).toBe(50);
    });

    it('should return null for open shift', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      const result = getShiftDiscrepancy('shift-1');

      expect(result).toBeNull();
    });
  });

  describe('verifyShift', () => {
    it('should verify a shift', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'closed',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
        run: jest.fn(),
      });

      const result = verifyShift('shift-1', 'verifier-user', 'Verified');

      expect(result).toBeDefined();
    });

    it('should throw error for open shift', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      expect(() => {
        verifyShift('shift-1', 'verifier-user');
      }).toThrow('Cannot verify an open shift');
    });
  });

  describe('getUserShiftHistory', () => {
    it('should return user shift history', () => {
      const mockShifts = [
        { id: 'shift-1', status: 'closed' },
        { id: 'shift-2', status: 'closed' },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockShifts),
      });

      const result = getUserShiftHistory('user-1');

      expect(result).toHaveLength(2);
    });
  });

  describe('getCurrentShift', () => {
    it('should return current shift for user', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      const result = getCurrentShift('user-1');

      expect(result).toBeDefined();
      expect(result?.status).toBe('open');
    });
  });

  describe('hasOpenShift', () => {
    it('should return true if user has open shift', () => {
      const mockShift = {
        id: 'shift-1',
        status: 'open',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockShift),
      });

      const result = hasOpenShift('user-1');

      expect(result).toBe(true);
    });

    it('should return false if user has no open shift', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = hasOpenShift('user-1');

      expect(result).toBe(false);
    });
  });

  describe('getShiftSalesSummary', () => {
    it('should return shift sales summary', () => {
      const mockShift = {
        id: 'shift-1',
        user_id: 'user-1',
        shift_start: '2025-01-01T09:00:00',
        shift_end: '2025-01-01T17:00:00',
      };

      const mockSalesStats = {
        transaction_count: 10,
        total_revenue: 500,
        average_transaction: 50,
      };

      const mockItemsStats = { total: 20 };

      mockDb.prepare.mockReturnValue({
        get: jest.fn()
          .mockReturnValueOnce(mockShift)
          .mockReturnValueOnce(mockSalesStats)
          .mockReturnValueOnce(mockItemsStats),
      });

      const result = getShiftSalesSummary('shift-1');

      expect(result).toBeDefined();
      expect(result.totalSales).toBe(10);
      expect(result.totalRevenue).toBe(500);
      expect(result.itemsSold).toBe(20);
    });
  });
});
