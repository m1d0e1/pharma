/**
 * Cart Service Tests
 * Tests for shopping cart business logic
 */

import {
  addToCart,
  removeFromCart,
  updateCartItem,
  clearCart,
  calculateCartTotal,
  getCartSummary,
  formatCartForCheckout,
  getCartItem,
  hasCartItem,
  getCartItemCount,
  getCartTotalQuantity,
  setCartPaymentMethod,
  setCartNotes,
  validateCart,
} from '@/lib/pos/cart';
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

describe('Cart Service', () => {
  const mockDb = {
    prepare: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDatabase as jest.Mock).mockReturnValue(mockDb);
  });

  const sampleCart = {
    items: [
      {
        inventoryId: 'inv-1',
        drugId: 123,
        drugName: 'Panadol',
        drugNameAr: 'بانادول',
        quantity: 2,
        unitPrice: 10.5,
        expiryDate: '2027-01-01',
      },
      {
        inventoryId: 'inv-2',
        drugId: 456,
        drugName: 'Aspirin',
        drugNameAr: 'أسبرين',
        quantity: 1,
        unitPrice: 5.0,
        expiryDate: '2027-01-01',
      },
    ],
    paymentMethod: 'cash',
    notes: '',
  };

  describe('addToCart', () => {
    it('should add item to cart', () => {
      const cart = { items: [], paymentMethod: 'cash', notes: '' };
      const item = {
        inventoryId: 'inv-1',
        drugId: 123,
        drugName: 'Test Drug',
        quantity: 2,
        unitPrice: 10.0,
        expiryDate: '2027-01-01',
      };

      const result = addToCart(cart, item);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].inventoryId).toBe('inv-1');
    });

    it('should update quantity if item already exists', () => {
      const cart = {
        items: [
          {
            inventoryId: 'inv-1',
            drugId: 123,
            drugName: 'Test Drug',
            quantity: 2,
            unitPrice: 10.0,
            expiryDate: '2027-01-01',
          },
        ],
        paymentMethod: 'cash',
        notes: '',
      };

      const item = {
        inventoryId: 'inv-1',
        drugId: 123,
        drugName: 'Test Drug',
        quantity: 3,
        unitPrice: 10.0,
        expiryDate: '2027-01-01',
      };

      const result = addToCart(cart, item);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].quantity).toBe(5); // 2 + 3
    });
  });

  describe('removeFromCart', () => {
    it('should remove item from cart', () => {
      const result = removeFromCart(sampleCart, 'inv-1');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].inventoryId).toBe('inv-2');
    });

    it('should return unchanged cart if item not found', () => {
      const result = removeFromCart(sampleCart, 'non-existent');

      expect(result.items).toHaveLength(2);
    });
  });

  describe('updateCartItem', () => {
    it('should update item quantity', () => {
      const result = updateCartItem(sampleCart, 'inv-1', 5);

      expect(result.items[0].quantity).toBe(5);
    });

    it('should remove item if quantity is 0', () => {
      const result = updateCartItem(sampleCart, 'inv-1', 0);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].inventoryId).toBe('inv-2');
    });

    it('should return unchanged cart if item not found', () => {
      const result = updateCartItem(sampleCart, 'non-existent', 5);

      expect(result.items).toHaveLength(2);
    });
  });

  describe('clearCart', () => {
    it('should clear all items from cart', () => {
      const result = clearCart();

      expect(result.items).toHaveLength(0);
    });
  });

  describe('calculateCartTotal', () => {
    it('should calculate cart total correctly', () => {
      const total = calculateCartTotal(sampleCart);

      expect(total).toBe(26.0); // (2 * 10.5) + (1 * 5.0)
    });

    it('should return 0 for empty cart', () => {
      const total = calculateCartTotal({ items: [], paymentMethod: 'cash', notes: '' });

      expect(total).toBe(0);
    });
  });

  describe('getCartSummary', () => {
    it('should return cart summary', () => {
      const summary = getCartSummary(sampleCart);

      expect(summary.itemCount).toBe(3); // 2 + 1
      expect(summary.totalAmount).toBe(26.0);
      expect(summary.subtotal).toBe(26.0);
    });
  });

  describe('formatCartForCheckout', () => {
    it('should format cart for checkout', () => {
      const formatted = formatCartForCheckout(sampleCart);

      expect(formatted).toHaveLength(2);
      expect(formatted[0]).toEqual({
        inventoryId: 'inv-1',
        quantitySold: 2,
        unitPrice: 10.5,
      });
    });
  });

  describe('getCartItem', () => {
    it('should return cart item by inventory ID', () => {
      const item = getCartItem(sampleCart, 'inv-1');

      expect(item).toBeDefined();
      expect(item?.inventoryId).toBe('inv-1');
    });

    it('should return undefined for non-existent item', () => {
      const item = getCartItem(sampleCart, 'non-existent');

      expect(item).toBeUndefined();
    });
  });

  describe('hasCartItem', () => {
    it('should return true if item exists in cart', () => {
      const hasItem = hasCartItem(sampleCart, 'inv-1');

      expect(hasItem).toBe(true);
    });

    it('should return false if item does not exist in cart', () => {
      const hasItem = hasCartItem(sampleCart, 'non-existent');

      expect(hasItem).toBe(false);
    });
  });

  describe('getCartItemCount', () => {
    it('should return number of items in cart', () => {
      const count = getCartItemCount(sampleCart);

      expect(count).toBe(2);
    });

    it('should return 0 for empty cart', () => {
      const count = getCartItemCount({ items: [], paymentMethod: 'cash', notes: '' });

      expect(count).toBe(0);
    });
  });

  describe('getCartTotalQuantity', () => {
    it('should return total quantity of all items', () => {
      const total = getCartTotalQuantity(sampleCart);

      expect(total).toBe(3); // 2 + 1
    });
  });

  describe('setCartPaymentMethod', () => {
    it('should set cart payment method', () => {
      const result = setCartPaymentMethod(sampleCart, 'credit');

      expect(result.paymentMethod).toBe('credit');
    });
  });

  describe('setCartNotes', () => {
    it('should set cart notes', () => {
      const result = setCartNotes(sampleCart, 'Customer requested delivery');

      expect(result.notes).toBe('Customer requested delivery');
    });
  });

  describe('validateCart', () => {
    it('should validate valid cart', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({ quantity: 100 }),
      });

      const result = await validateCart(sampleCart, 'pharmacy-1');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail validation for empty cart', async () => {
      const result = await validateCart(
        { items: [], paymentMethod: 'cash', notes: '' },
        'pharmacy-1'
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Cart is empty');
    });

    it('should fail validation for insufficient stock', async () => {
      mockDb.prepare.mockReturnValue({
        get: jest.fn().mockReturnValue({ quantity: 1 }), // Only 1 in stock
      });

      const result = await validateCart(sampleCart, 'pharmacy-1');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
