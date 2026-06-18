import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query, transaction } from '../db/client';

// Cart item schema
export const CartItemSchema = z.object({
  inventoryId: z.string().uuid(),
  drugId: z.number(),
  drugName: z.string(),
  drugNameAr: z.string().optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  expiryDate: z.string(),
  batchNumber: z.string().optional(),
});

export type CartItem = z.infer<typeof CartItemSchema>;

// Cart state
export interface Cart {
  items: CartItem[];
  patientId?: string;
  paymentMethod?: string;
  notes?: string;
}

/**
 * Calculate cart total
 * @param cart - Cart state
 * @returns Total amount
 */
export function calculateCartTotal(cart: Cart): number {
  return cart.items.reduce(
    (total, item) => total + item.quantity * item.unitPrice,
    0
  );
}

/**
 * Get cart from localStorage
 * @returns Cart state
 */
export function getCart(): Cart {
  if (typeof window === 'undefined') {
    return { items: [] };
  }

  const cartJson = localStorage.getItem('cart');
  if (!cartJson) {
    return { items: [] };
  }

  try {
    return JSON.parse(cartJson);
  } catch {
    return { items: [] };
  }
}

/**
 * Save cart to localStorage
 * @param cart - Cart state
 */
export function saveCart(cart: Cart): void {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem('cart', JSON.stringify(cart));
}

/**
 * Add item to cart
 * @param cart - Current cart
 * @param item - Item to add
 * @returns Updated cart
 */
export function addToCart(cart: Cart, item: CartItem): Cart {
  // Check if item already exists
  const existingIndex = cart.items.findIndex(
    (i) => i.inventoryId === item.inventoryId
  );

  if (existingIndex >= 0) {
    // Update quantity
    const updatedItems = [...cart.items];
    updatedItems[existingIndex] = {
      ...updatedItems[existingIndex],
      quantity: updatedItems[existingIndex].quantity + item.quantity,
    };
    return { ...cart, items: updatedItems };
  }

  // Add new item
  return {
    ...cart,
    items: [...cart.items, item],
  };
}

/**
 * Update item quantity in cart
 * @param cart - Current cart
 * @param inventoryId - Inventory ID
 * @param quantity - New quantity
 * @returns Updated cart
 */
export function updateCartItem(
  cart: Cart,
  inventoryId: string,
  quantity: number
): Cart {
  if (quantity <= 0) {
    return removeFromCart(cart, inventoryId);
  }

  const updatedItems = cart.items.map((item) =>
    item.inventoryId === inventoryId ? { ...item, quantity } : item
  );

  return { ...cart, items: updatedItems };
}

/**
 * Remove item from cart
 * @param cart - Current cart
 * @param inventoryId - Inventory ID
 * @returns Updated cart
 */
export function removeFromCart(cart: Cart, inventoryId: string): Cart {
  return {
    ...cart,
    items: cart.items.filter((item) => item.inventoryId !== inventoryId),
  };
}

/**
 * Clear cart
 * @returns Empty cart
 */
export function clearCart(): Cart {
  const emptyCart: Cart = { items: [] };
  saveCart(emptyCart);
  return emptyCart;
}

/**
 * Set cart patient
 * @param cart - Current cart
 * @param patientId - Patient ID
 * @returns Updated cart
 */
export function setCartPatient(cart: Cart, patientId?: string): Cart {
  return { ...cart, patientId };
}

/**
 * Set cart payment method
 * @param cart - Current cart
 * @param paymentMethod - Payment method
 * @returns Updated cart
 */
export function setCartPaymentMethod(
  cart: Cart,
  paymentMethod?: string
): Cart {
  return { ...cart, paymentMethod };
}

/**
 * Set cart notes
 * @param cart - Current cart
 * @param notes - Notes
 * @returns Updated cart
 */
export function setCartNotes(cart: Cart, notes?: string): Cart {
  return { ...cart, notes };
}

/**
 * Validate cart before checkout
 * @param cart - Cart state
 * @param pharmacyId - Pharmacy ID
 * @returns Validation result
 */
export async function validateCart(
  cart: Cart,
  pharmacyId: string
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (cart.items.length === 0) {
    errors.push('Cart is empty');
  }

  // Check stock availability
  for (const item of cart.items) {
    const inventory = get<any>(
      `SELECT id, quantity FROM inventory WHERE id = ? AND pharmacy_id = ?`,
      [item.inventoryId, pharmacyId]
    );

    if (!inventory) {
      errors.push(`Item ${item.drugName} not found in inventory`);
    } else if (inventory.quantity < item.quantity) {
      errors.push(
        `Insufficient stock for ${item.drugName}. Available: ${inventory.quantity}, Requested: ${item.quantity}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get cart summary
 * @param cart - Cart state
 * @returns Cart summary
 */
export function getCartSummary(cart: Cart): {
  itemCount: number;
  totalAmount: number;
  subtotal: number;
  tax: number;
  discount: number;
} {
  const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = calculateCartTotal(cart);
  const tax = 0; // TODO: Implement tax calculation
  const discount = 0; // TODO: Implement discount calculation
  const totalAmount = subtotal + tax - discount;

  return {
    itemCount,
    totalAmount,
    subtotal,
    tax,
    discount,
  };
}

/**
 * Format cart for checkout
 * @param cart - Cart state
 * @returns Formatted cart items
 */
export function formatCartForCheckout(cart: Cart): Array<{
  inventoryId: string;
  quantitySold: number;
  unitPrice: number;
}> {
  return cart.items.map((item) => ({
    inventoryId: item.inventoryId,
    quantitySold: item.quantity,
    unitPrice: item.unitPrice,
  }));
}

/**
 * Get cart item by inventory ID
 * @param cart - Cart state
 * @param inventoryId - Inventory ID
 * @returns Cart item or undefined
 */
export function getCartItem(
  cart: Cart,
  inventoryId: string
): CartItem | undefined {
  return cart.items.find((item) => item.inventoryId === inventoryId);
}

/**
 * Check if cart has item
 * @param cart - Cart state
 * @param inventoryId - Inventory ID
 * @returns True if item exists in cart
 */
export function hasCartItem(cart: Cart, inventoryId: string): boolean {
  return cart.items.some((item) => item.inventoryId === inventoryId);
}

/**
 * Get cart items count
 * @param cart - Cart state
 * @returns Number of items in cart
 */
export function getCartItemCount(cart: Cart): number {
  return cart.items.length;
}

/**
 * Get cart total quantity
 * @param cart - Cart state
 * @returns Total quantity of all items
 */
export function getCartTotalQuantity(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.quantity, 0);
}
