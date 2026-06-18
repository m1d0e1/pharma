/**
 * POS Checkout Service Tests
 * Tests for point of sale checkout business logic
 */

import {
  processCheckout,
  getInvoice,
  CheckoutRequestSchema,
} from '@/lib/pos/checkout';
import { getDatabase, transaction } from '@/lib/db/client';

// Mock database
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

jest.mock('uuid', () => ({
  v4: jest.fn(() => '00000000-0000-4000-8000-000000000099'),
}));

const mockPharmacyId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const mockUserId = 'a3b077a2-f8c6-43d9-9ebd-375865243e8d';
const mockPatientId = 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6';
const mockInventoryId = '44b6c699-e659-4d69-a1b7-4a0f443b7cfd';
const mockNonExistentId = '78b6c699-e659-4d69-a1b7-4a0f443b7cfd';

describe('POS Checkout Service', () => {
  const mockDb = {
    prepare: jest.fn(),
    exec: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
  });

  describe('CheckoutRequestSchema', () => {
    it('should validate valid checkout request', () => {
      const validRequest = {
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        patientId: mockPatientId,
        cartItems: [
          {
            inventoryId: mockInventoryId,
            quantitySold: 2,
            unitPrice: 10.5,
          },
        ],
        paymentMethod: 'cash',
      };

      const result = CheckoutRequestSchema.parse(validRequest);

      expect(result).toBeDefined();
      expect(result.cartItems).toHaveLength(1);
    });

    it('should reject empty cart', () => {
      const invalidRequest = {
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        cartItems: [],
        paymentMethod: 'cash',
      };

      expect(() => CheckoutRequestSchema.parse(invalidRequest)).toThrow();
    });

    it('should reject negative quantity', () => {
      const invalidRequest = {
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        cartItems: [
          {
            inventoryId: mockInventoryId,
            quantitySold: -5,
            unitPrice: 10.5,
          },
        ],
        paymentMethod: 'cash',
      };

      expect(() => CheckoutRequestSchema.parse(invalidRequest)).toThrow();
    });

    it('should reject negative price', () => {
      const invalidRequest = {
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        cartItems: [
          {
            inventoryId: mockInventoryId,
            quantitySold: 2,
            unitPrice: -10.5,
          },
        ],
        paymentMethod: 'cash',
      };

      expect(() => CheckoutRequestSchema.parse(invalidRequest)).toThrow();
    });
  });

  describe('processCheckout', () => {
    it('should process checkout successfully', async () => {
      const mockInventory = {
        id: mockInventoryId,
        quantity: 100,
        drug_id: 123,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockInventory),
        run: jest.fn(),
      });

      (transaction as jest.Mock).mockImplementation(async (callback) => {
        return await callback(mockDb);
      });

      const result = await processCheckout({
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        patientId: mockPatientId,
        cartItems: [
          {
            inventoryId: mockInventoryId,
            quantitySold: 2,
            unitPrice: 10.5,
          },
        ],
        paymentMethod: 'cash',
      });

      expect(result.success).toBe(true);
    });

    it('should fail with empty cart', async () => {
      const result = await processCheckout({
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        cartItems: [],
        paymentMethod: 'cash',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cart is empty');
    });

    it('should fail with insufficient stock', async () => {
      const mockInventory = {
        id: mockInventoryId,
        quantity: 1, // Only 1 in stock
        drug_id: 123,
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockInventory),
      });

      (transaction as jest.Mock).mockImplementation(async (callback) => {
        return await callback(mockDb);
      });

      const result = await processCheckout({
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        cartItems: [
          {
            inventoryId: mockInventoryId,
            quantitySold: 5, // Requesting 5
            unitPrice: 10.5,
          },
        ],
        paymentMethod: 'cash',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient stock');
    });

    it('should fail for non-existent inventory item', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      (transaction as jest.Mock).mockImplementation(async (callback) => {
        return await callback(mockDb);
      });

      const result = await processCheckout({
        pharmacyId: mockPharmacyId,
        userId: mockUserId,
        cartItems: [
          {
            inventoryId: mockNonExistentId,
            quantitySold: 2,
            unitPrice: 10.5,
          },
        ],
        paymentMethod: 'cash',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('getInvoice', () => {
    it('should return invoice by ID', () => {
      const mockInvoice = {
        id: 'invoice-1',
        total_amount: 21.0,
        payment_method: 'cash',
        username: 'testuser',
        full_name: 'Test User',
        patient_name: 'Test Patient',
      };

      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(mockInvoice),
      });

      const result = getInvoice('invoice-1');

      expect(result).toBeDefined();
      expect(result?.id).toBe('invoice-1');
      expect(result?.total_amount).toBe(21.0);
    });

    it('should return null for non-existent invoice', () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
      });

      const result = getInvoice('non-existent');

      expect(result).toBeNull();
    });
  });
});
