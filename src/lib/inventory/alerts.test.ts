/**
 * Inventory Alerts Tests
 * Tests for inventory alerting system
 */

import {
  getPharmacyAlerts,
  getAlertSummary,
  getCriticalAlerts,
  hasCriticalAlerts,
  getInventoryHealthScore,
  getRestockRecommendations,
  getExpiryReport,
  getDeadStockReport,
} from '@/lib/inventory/alerts';
import { getDatabase } from '@/lib/db/client';

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
jest.mock('@/lib/inventory/service', () => ({
  getLowStockItems: jest.fn(),
  getExpiringItems: jest.fn(),
  getExpiredItems: jest.fn(),
  getInventoryStatistics: jest.fn(),
}));

describe('Inventory Alerts', () => {
  const mockDb = {
    prepare: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
  });

  describe('getPharmacyAlerts', () => {
    it('should return all pharmacy alerts', () => {
      const mockLowStock = [
        {
          id: 'inv-1',
          drugName: 'Drug A',
          drugNameAr: 'دواء أ',
          quantity: 5,
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
      ];

      const mockExpiring = [
        {
          id: 'inv-2',
          drugName: 'Drug B',
          drugNameAr: 'دواء ب',
          expiryDate: '2025-06-15',
          quantity: 20,
        },
      ];

      const mockExpired = [
        {
          id: 'inv-3',
          drugName: 'Drug C',
          drugNameAr: 'دواء ج',
          expiryDate: '2024-01-01',
          quantity: 10,
        },
      ];

      const { getLowStockItems, getExpiringItems, getExpiredItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);
      getExpiringItems.mockReturnValue(mockExpiring);
      getExpiredItems.mockReturnValue(mockExpired);

      const alerts = getPharmacyAlerts('pharmacy-1');

      expect(alerts).toHaveLength(3);
      expect(alerts).toContainEqual(expect.objectContaining({ type: 'low_stock' }));
      expect(alerts).toContainEqual(expect.objectContaining({ type: 'expiring_soon' }));
      expect(alerts).toContainEqual(expect.objectContaining({ type: 'expired' }));
    });

    it('should sort alerts by severity', () => {
      const mockLowStock = [
        {
          id: 'inv-1',
          drugName: 'Drug A',
          drugNameAr: 'دواء أ',
          quantity: 0, // Critical - out of stock
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
      ];

      const { getLowStockItems, getExpiringItems, getExpiredItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);
      getExpiringItems.mockReturnValue([]);
      getExpiredItems.mockReturnValue([]);

      const alerts = getPharmacyAlerts('pharmacy-1');

      expect(alerts[0].severity).toBe('critical');
    });
  });

  describe('getAlertSummary', () => {
    it('should return alert summary', () => {
      const mockLowStock = [
        { id: 'inv-1', drugName: 'Drug A', quantity: 5, minStockLevel: 10 },
      ];

      const mockExpiring = [
        { id: 'inv-2', drugName: 'Drug B', expiryDate: '2025-06-15', quantity: 20 },
      ];

      const mockExpired = [
        { id: 'inv-3', drugName: 'Drug C', expiryDate: '2024-01-01', quantity: 10 },
      ];

      const { getLowStockItems, getExpiringItems, getExpiredItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);
      getExpiringItems.mockReturnValue(mockExpiring);
      getExpiredItems.mockReturnValue(mockExpired);

      const summary = getAlertSummary('pharmacy-1');

      expect(summary.total).toBe(3);
      expect(summary.critical).toBeGreaterThan(0);
      expect(summary.byType.low_stock).toBe(1);
      expect(summary.byType.expiring_soon).toBe(1);
      expect(summary.byType.expired).toBe(1);
    });
  });

  describe('getCriticalAlerts', () => {
    it('should return only critical alerts', () => {
      const mockLowStock = [
        {
          id: 'inv-1',
          drugName: 'Drug A',
          drugNameAr: 'دواء أ',
          quantity: 0, // Critical
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
        {
          id: 'inv-2',
          drugName: 'Drug B',
          drugNameAr: 'دواء ب',
          quantity: 8, // Medium
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
      ];

      const { getLowStockItems, getExpiringItems, getExpiredItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);
      getExpiringItems.mockReturnValue([]);
      getExpiredItems.mockReturnValue([]);

      const criticalAlerts = getCriticalAlerts('pharmacy-1');

      expect(criticalAlerts).toHaveLength(1);
      expect(criticalAlerts[0].severity).toBe('critical');
    });
  });

  describe('hasCriticalAlerts', () => {
    it('should return true if there are critical alerts', () => {
      const mockLowStock = [
        {
          id: 'inv-1',
          drugName: 'Drug A',
          quantity: 0,
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
      ];

      const { getLowStockItems, getExpiringItems, getExpiredItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);
      getExpiringItems.mockReturnValue([]);
      getExpiredItems.mockReturnValue([]);

      const hasCritical = hasCriticalAlerts('pharmacy-1');

      expect(hasCritical).toBe(true);
    });

    it('should return false if no critical alerts', () => {
      const { getLowStockItems, getExpiringItems, getExpiredItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue([]);
      getExpiringItems.mockReturnValue([]);
      getExpiredItems.mockReturnValue([]);

      const hasCritical = hasCriticalAlerts('pharmacy-1');

      expect(hasCritical).toBe(false);
    });
  });

  describe('getInventoryHealthScore', () => {
    it('should return health score with grade A', () => {
      const mockStats = {
        totalItems: 100,
        totalQuantity: 1000,
        totalValue: 50000,
        lowStockCount: 0,
        expiringSoonCount: 0,
        expiredCount: 0,
      };

      const { getInventoryStatistics } = require('@/lib/inventory/service');

      getInventoryStatistics.mockReturnValue(mockStats);

      const result = getInventoryHealthScore('pharmacy-1');

      expect(result.score).toBe(100);
      expect(result.grade).toBe('A');
      expect(result.issues).toHaveLength(0);
    });

    it('should return health score with grade F for many issues', () => {
      const mockStats = {
        totalItems: 100,
        totalQuantity: 1000,
        totalValue: 50000,
        lowStockCount: 10,
        expiringSoonCount: 5,
        expiredCount: 3,
      };

      const { getInventoryStatistics } = require('@/lib/inventory/service');

      getInventoryStatistics.mockReturnValue(mockStats);

      const result = getInventoryHealthScore('pharmacy-1');

      expect(result.score).toBeLessThan(60);
      expect(result.grade).toBe('F');
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  describe('getRestockRecommendations', () => {
    it('should return restock recommendations', () => {
      const mockLowStock = [
        {
          id: 'inv-1',
          drugName: 'Drug A',
          drugNameAr: 'دواء أ',
          quantity: 5,
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
      ];

      const { getLowStockItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);

      const recommendations = getRestockRecommendations('pharmacy-1');

      expect(recommendations).toHaveLength(1);
      expect(recommendations[0].drugName).toBe('Drug A');
      expect(recommendations[0].recommendedQuantity).toBe(20); // 2x min stock
      expect(recommendations[0].priority).toBe('medium');
    });

    it('should mark out of stock items as high priority', () => {
      const mockLowStock = [
        {
          id: 'inv-1',
          drugName: 'Drug A',
          drugNameAr: 'دواء أ',
          quantity: 0,
          minStockLevel: 10,
          expiryDate: '2025-12-31',
        },
      ];

      const { getLowStockItems } = require('@/lib/inventory/service');

      getLowStockItems.mockReturnValue(mockLowStock);

      const recommendations = getRestockRecommendations('pharmacy-1');

      expect(recommendations[0].priority).toBe('high');
      expect(recommendations[0].reason).toBe('Out of stock');
    });
  });

  describe('getExpiryReport', () => {
    it('should return expiry report by month', () => {
      const mockItems = [
        {
          drug_name: 'Drug A',
          drug_name_ar: 'دواء أ',
          expiry_date: '2025-06-15',
          quantity: 10,
        },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const report = getExpiryReport('pharmacy-1', 12);

      expect(report).toBeDefined();
      expect(Array.isArray(report)).toBe(true);
    });
  });

  describe('getDeadStockReport', () => {
    it('should return dead stock report', () => {
      const mockItems = [
        {
          inventory_id: 'inv-1',
          drug_name: 'Old Drug',
          drug_name_ar: 'دواء قديم',
          quantity: 50,
          value: 500,
          last_sold_date: '2024-01-01',
        },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const report = getDeadStockReport('pharmacy-1', 90);

      expect(report).toHaveLength(1);
      expect(report[0].drugName).toBe('Old Drug');
      expect(report[0].daysSinceLastSale).toBeGreaterThan(90);
    });

    it('should calculate days since last sale', () => {
      const mockItems = [
        {
          inventory_id: 'inv-1',
          drug_name: 'Drug A',
          drug_name_ar: 'دواء أ',
          quantity: 50,
          value: 500,
          last_sold_date: '2024-01-01',
        },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const report = getDeadStockReport('pharmacy-1', 90);

      expect(report[0].daysSinceLastSale).toBeDefined();
      expect(typeof report[0].daysSinceLastSale).toBe('number');
    });
  });
});
