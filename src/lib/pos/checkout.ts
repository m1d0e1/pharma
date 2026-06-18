import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query, transaction } from '../db/client';
import { Cart, CartItem } from './cart';

// Checkout request schema
export const CheckoutRequestSchema = z.object({
  pharmacyId: z.string().uuid(),
  userId: z.string().uuid(),
  cartItems: z.array(
    z.object({
      inventoryId: z.string().uuid(),
      quantitySold: z.number().positive(),
      unitPrice: z.number().nonnegative(),
    })
  ).min(1, 'Cart is empty'),
  patientId: z.string().uuid().optional(),
  paymentMethod: z.string().optional(),
  notes: z.string().optional(),
});

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

// Checkout response schema
export const CheckoutResponseSchema = z.object({
  success: z.boolean(),
  invoiceId: z.string().optional(),
  totalAmount: z.number().optional(),
  error: z.string().optional(),
});

export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

/**
 * Process checkout
 * @param request - Checkout request
 * @returns Checkout response
 */
export async function processCheckout(
  request: CheckoutRequest
): Promise<CheckoutResponse> {
  try {
    // Validate request
    CheckoutRequestSchema.parse(request);

    // Validate cart items
    if (request.cartItems.length === 0) {
      return {
        success: false,
        error: 'Cart is empty',
      };
    }

    // Process checkout in transaction
    const result = await transaction(async (db) => {
      // Create invoice
      const invoiceId = uuidv4();
      let totalAmount = 0;

      // Calculate total and validate stock
      for (const item of request.cartItems) {
        const inventory = db
          .prepare(
            `SELECT id, quantity, drug_id FROM inventory
             WHERE id = ?`
          )
          .get(item.inventoryId) as any;

        if (!inventory) {
          throw new Error(`Inventory item ${item.inventoryId} not found`);
        }

        if (inventory.quantity < item.quantitySold) {
          throw new Error(
            `Insufficient stock for item ${item.inventoryId}. Available: ${inventory.quantity}, Requested: ${item.quantitySold}`
          );
        }

        totalAmount += item.quantitySold * item.unitPrice;
      }

      // Insert invoice
      db.prepare(
        `INSERT INTO sales_invoices (id, pharmacy_id, user_id, patient_id, total_amount, payment_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        invoiceId,
        request.pharmacyId || 'local_default',
        request.userId,
        request.patientId || null,
        totalAmount,
        request.paymentMethod || 'cash'
      );

      // Process items and update inventory
      for (const item of request.cartItems) {
        // Update inventory quantity
        db.prepare(
          `UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(item.quantitySold, item.inventoryId);

        // Insert sales item (ID is AUTOINCREMENT)
        db.prepare(
          `INSERT INTO sales_items (invoice_id, inventory_id, quantity_sold, unit_price, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`
        ).run(invoiceId, item.inventoryId, item.quantitySold, item.unitPrice);
      }

      return { invoiceId, totalAmount };
    });

    return {
      success: true,
      invoiceId: result.invoiceId,
      totalAmount: result.totalAmount,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.issues?.[0]?.message || 'Validation error',
      };
    }
    console.error('Checkout error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Checkout failed',
    };
  }
}

/**
 * Get invoice by ID
 * @param invoiceId - Invoice ID
 * @returns Invoice data or null
 */
export function getInvoice(invoiceId: string): any {
  return get<any>(
    `SELECT si.*, u.username, u.full_name, p.full_name as patient_name
     FROM sales_invoices si
     LEFT JOIN users u ON si.user_id = u.id
     LEFT JOIN patients p ON si.patient_id = p.id
     WHERE si.id = ?`,
    [invoiceId]
  ) || null;
}

/**
 * Get invoice items
 * @param invoiceId - Invoice ID
 * @returns List of invoice items
 */
export function getInvoiceItems(invoiceId: string): any[] {
  return query<any>(
    `SELECT si.*, i.drug_id, md.name_en, md.name_ar, i.batch_number, i.expiry_date
     FROM sales_items si
     JOIN inventory i ON si.inventory_id = i.id
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE si.invoice_id = ?`,
    [invoiceId]
  );
}

/**
 * Get invoices for pharmacy
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns List of invoices
 */
export function getPharmacyInvoices(
  pharmacyId: string,
  options?: {
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
    userId?: string;
  }
): any[] {
  let sql = `
    SELECT si.*, u.username, u.full_name
    FROM sales_invoices si
    LEFT JOIN users u ON si.user_id = u.id
    WHERE si.pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.startDate) {
    sql += ` AND si.created_at >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND si.created_at <= ?`;
    params.push(options.endDate);
  }

  if (options?.userId) {
    sql += ` AND si.user_id = ?`;
    params.push(options.userId);
  }

  sql += ` ORDER BY si.created_at DESC`;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ` OFFSET ?`;
    params.push(options.offset);
  }

  return query<any>(sql, params);
}

/**
 * Void an invoice
 * @param invoiceId - Invoice ID
 * @param userId - User ID who is voiding
 * @param reason - Void reason
 * @returns Success status
 */
export async function voidInvoice(
  invoiceId: string,
  userId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await transaction(async (db) => {
      // Get invoice
      const invoice = db
        .prepare(`SELECT * FROM sales_invoices WHERE id = ?`)
        .get(invoiceId) as any;

      if (!invoice) {
        throw new Error('Invoice not found');
      }

      // Get invoice items
      const items = db
        .prepare(`SELECT * FROM sales_items WHERE invoice_id = ?`)
        .all(invoiceId) as any[];

      // Restore inventory quantities
      for (const item of items) {
        db.prepare(
          `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(item.quantity_sold, item.inventory_id);
      }

      // Delete invoice items
      db.prepare(`DELETE FROM sales_items WHERE invoice_id = ?`).run(
        invoiceId
      );

      // Delete invoice
      db.prepare(`DELETE FROM sales_invoices WHERE id = ?`).run(invoiceId);

      // Log void operation
      db.prepare(
        `INSERT INTO audit_logs (id, user_id, pharmacy_id, action_type, table_name, record_id, details, created_at)
         VALUES (?, ?, ?, 'void', 'sales_invoices', ?, ?, datetime('now'))`
      ).run(
        uuidv4(),
        userId,
        invoice.pharmacy_id,
        invoiceId,
        JSON.stringify({ reason, originalTotal: invoice.total_amount })
      );

      return { success: true };
    });

    return result;
  } catch (error) {
    console.error('Void invoice error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to void invoice',
    };
  }
}

/**
 * Get sales statistics
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns Sales statistics
 */
export function getSalesStatistics(
  pharmacyId: string,
  options?: {
    startDate?: string;
    endDate?: string;
  }
): {
  totalSales: number;
  totalRevenue: number;
  averageTransaction: number;
  transactionCount: number;
} {
  let sql = `
    SELECT
      COUNT(*) as transaction_count,
      COALESCE(SUM(total_amount), 0) as total_revenue
    FROM sales_invoices
    WHERE pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.startDate) {
    sql += ` AND created_at >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND created_at <= ?`;
    params.push(options.endDate);
  }

  const result = get<any>(sql, params);

  const transactionCount = result?.transaction_count || 0;
  const totalRevenue = result?.total_revenue || 0;
  const averageTransaction =
    transactionCount > 0 ? totalRevenue / transactionCount : 0;

  return {
    totalSales: transactionCount,
    totalRevenue,
    averageTransaction,
    transactionCount,
  };
}

/**
 * Get top selling drugs
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns List of top selling drugs
 */
export function getTopSellingDrugs(
  pharmacyId: string,
  options?: {
    limit?: number;
    startDate?: string;
    endDate?: string;
  }
): any[] {
  let sql = `
    SELECT
      md.id,
      md.name_en,
      md.name_ar,
      SUM(si.quantity_sold) as total_quantity,
      SUM(si.quantity_sold * si.unit_price) as total_revenue,
      COUNT(DISTINCT si.invoice_id) as transaction_count
    FROM sales_items si
    JOIN inventory i ON si.inventory_id = i.id
    JOIN master_drugs md ON i.drug_id = md.id
    JOIN sales_invoices inv ON si.invoice_id = inv.id
    WHERE inv.pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.startDate) {
    sql += ` AND inv.created_at >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND inv.created_at <= ?`;
    params.push(options.endDate);
  }

  sql += `
    GROUP BY md.id, md.name_en, md.name_ar
    ORDER BY total_quantity DESC
  `;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  return query<any>(sql, params);
}
