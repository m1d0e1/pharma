/**
 * Inventory Service Tests
 * Tests for inventory management business logic
 */

import {
  createInventoryItem,
  getInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  getPharmacyInventory,
  getLowStockItems,
  getExpiringItems,
  getExpiredItems,
  updateInventoryQuantity,
  adjustInventoryQuantity,
  getInventoryStatistics,
  getInventoryByDrug,
  getInventoryByBarcode,
  searchInventory,
  getInventoryValueByCategory,
  getTopSuppliers,
} from '@/lib/inventory/service';
import { getDatabase, execute } from '@/lib/db/client';

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

describe('Inventory Service', () => {
  const mockDb = {
    prepare: jest.fn(),
    exec: jest.fn(),
    pragma: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
  });

  describe('createInventoryItem', () => {
    it('should create a new inventory item', () => {
      const mockItem = {
        id: 'test-id',
        pharmacyId: 'pharmacy-1',
        drugId: 123,
        drugName: 'Test Drug',
        quantity: 100,
        unitPrice: 10.5,
      };

      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue(mockItem),
      });

      const result = createInventoryItem('pharmacy-1', {
        drugId: 123,
        expiryDate: '2025-12-31',
        quantity: 100,
        unitPrice: 10.5,
        minStockLevel: 10,
      });

      expect(result).toBeDefined();
      expect(result.drugName).toBe('Test Drug');
    });

    it('should throw error for invalid data', () => {
      expect(() => {
        createInventoryItem('pharmacy-1', {
          drugId: 123,
          expiryDate: '2025-12-31',
          quantity: -10, // Invalid: negative quantity
          unitPrice: 10.5,
          minStockLevel: 10,
        });
      }).toThrow();
    });
  });

  describe('getInventoryItem', () => {
    it('should return inventory item by ID', () => {
      const mockItem = {
        id: 'test-id',
        drugName: 'Test Drug',
        quantity: 50,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockItem),
      });

      const result = getInventoryItem('test-id');

      expect(result).toEqual(mockItem);
    });

    it('should return null for non-existent item', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = getInventoryItem('non-existent');

    });
  });

  describe('updateInventoryItem', () => {
    it('should update inventory item', () => {
      const mockItem = {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        quantity: 75,
        unitPrice: 15.0,
      };

      mockDb.prepare.mockReturnValue({
        run: jest.fn(),
        get: jest.fn().mockReturnValue(mockItem),
      });

      const result = updateInventoryItem({
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        quantity: 75,
        unitPrice: 15.0,
      });

      expect(result).toBeDefined();
      expect(result.quantity).toBe(75);
    });
  });

  describe('deleteInventoryItem', () => {
    it('should delete inventory item', () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn().mockReturnValue({ changes: 1 }),
      });

      const result = deleteInventoryItem('test-id');

      expect(result).toBe(true);
    });

    it('should return false for non-existent item', () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn().mockReturnValue({ changes: 0 }),
      });

      const result = deleteInventoryItem('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('getLowStockItems', () => {
    it('should return items with low stock', () => {
      const mockItems = [
        { id: '1', drugName: 'Drug A', quantity: 5, minStockLevel: 10 },
        { id: '2', drugName: 'Drug B', quantity: 0, minStockLevel: 10 },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const result = getLowStockItems('pharmacy-1');

      expect(result).toHaveLength(2);
      expect(result[0].quantity).toBeLessThanOrEqual(result[0].minStockLevel);
    });
  });

  describe('getExpiringItems', () => {
    it('should return items expiring within specified days', () => {
      const mockItems = [
        {
          id: '1',
          drugName: 'Drug A',
          expiryDate: '2025-06-15',
          quantity: 50,
        },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const result = getExpiringItems('pharmacy-1', 30);

      expect(result).toHaveLength(1);
    });
  });

  describe('getExpiredItems', () => {
    it('should return expired items', () => {
      const mockItems = [
        {
          id: '1',
          drugName: 'Expired Drug',
          expiryDate: '2024-01-01',
          quantity: 10,
        },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const result = getExpiredItems('pharmacy-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('updateInventoryQuantity', () => {
    it('should update inventory quantity', () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn().mockReturnValue({ changes: 1 }),
      });

      const result = updateInventoryQuantity('test-id', 100);

      expect(result).toBe(true);
    });
  });

  describe('adjustInventoryQuantity', () => {
    it('should add to inventory quantity', () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn().mockReturnValue({ changes: 1 }),
      });

      const result = adjustInventoryQuantity('test-id', 10);

      expect(result).toBe(true);
    });

    it('should subtract from inventory quantity', () => {
      mockDb.prepare.mockReturnValue({
        run: jest.fn().mockReturnValue({ changes: 1 }),
      });

      const result = adjustInventoryQuantity('test-id', -5);

      expect(result).toBe(true);
    });
  });

  describe('getInventoryStatistics', () => {
    it('should return inventory statistics', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({
          totalItems: 100,
          totalQuantity: 1000,
          totalValue: 50000,
          lowStockCount: 5,
          expiringSoonCount: 3,
          expiredCount: 2,
        }),
      });

      const result = getInventoryStatistics('pharmacy-1');

      expect(result).toEqual({
        totalItems: 100,
        totalQuantity: 1000,
        totalValue: 50000,
        lowStockCount: 5,
        expiringSoonCount: 3,
        expiredCount: 2,
      });
    });
  });

  describe('getInventoryByDrug', () => {
    it('should return inventory items for a drug', () => {
      const mockItems = [
        { id: '1', drugName: 'Drug A', expiryDate: '2025-12-31' },
        { id: '2', drugName: 'Drug A', expiryDate: '2026-06-30' },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const result = getInventoryByDrug('pharmacy-1', 123);

      expect(result).toHaveLength(2);
    });
  });

  describe('getInventoryByBarcode', () => {
    it('should return inventory items by barcode', () => {
      const mockItems = [
        { id: '1', drugName: 'Scanned Drug', barcode: '123456789' },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const result = getInventoryByBarcode('pharmacy-1', '123456789');

      expect(result).toHaveLength(1);
      expect((result[0] as any).barcode).toBe('123456789');
    });
  });

  describe('searchInventory', () => {
    it('should search inventory by query', () => {
      const mockItems = [
        { id: '1', drugName: 'Panadol', barcode: '111' },
        { id: '2', drugName: 'Aspirin', barcode: '222' },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockItems),
      });

      const result = searchInventory('pharmacy-1', 'pan');

      expect(result).toBeDefined();
    });
  });

  describe('getInventoryValueByCategory', () => {
    it('should return inventory value grouped by category', () => {
      const mockResults = [
        { category: 'Pain Relief', totalValue: 10000, itemCount: 50 },
        { category: 'Antibiotics', totalValue: 25000, itemCount: 30 },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockResults),
      });

      const result = getInventoryValueByCategory('pharmacy-1');

      expect(result).toHaveLength(2);
      expect(result[0].category).toBe('Pain Relief');
    });
  });

  describe('getTopSuppliers', () => {
    it('should return top suppliers by value', () => {
      const mockSuppliers = [
        { supplier: 'PharmaCo', itemCount: 100, totalValue: 50000 },
        { supplier: 'MedSupply', itemCount: 50, totalValue: 25000 },
      ];

      mockDb.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockSuppliers),
      });

      const result = getTopSuppliers('pharmacy-1', 10);

      expect(result).toHaveLength(2);
      expect(result[0].supplier).toBe('PharmaCo');
    });
  });
});
