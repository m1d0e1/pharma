import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query, transaction } from '../db/client';

// Inventory item schema
export const InventoryItemSchema = z.object({
  id: z.string().uuid(),
  pharmacyId: z.string().uuid(),
  drugId: z.number(),
  drugName: z.string(),
  drugNameAr: z.string().optional(),
  batchNumber: z.string().optional(),
  expiryDate: z.string(),
  quantity: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
  minStockLevel: z.number().int().nonnegative().default(10),
  supplier: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type InventoryItem = z.infer<typeof InventoryItemSchema>;

// Create inventory item schema
export const CreateInventoryItemSchema = z.object({
  drugId: z.number(),
  batchNumber: z.string().optional(),
  expiryDate: z.string(),
  quantity: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
  minStockLevel: z.number().int().nonnegative().default(10),
  supplier: z.string().optional(),
});

export type CreateInventoryItem = z.infer<typeof CreateInventoryItemSchema>;

// Update inventory item schema
export const UpdateInventoryItemSchema = CreateInventoryItemSchema.partial().extend({
  id: z.string().uuid(),
});

export type UpdateInventoryItem = z.infer<typeof UpdateInventoryItemSchema>;

/**
 * Create inventory item
 * @param pharmacyId - Pharmacy ID
 * @param data - Inventory item data
 * @returns Created inventory item
 */
export function createInventoryItem(
  pharmacyId: string,
  data: CreateInventoryItem
): InventoryItem {
  CreateInventoryItemSchema.parse(data);
  const id = uuidv4();

  execute(
    `INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, min_stock_level, supplier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      pharmacyId,
      data.drugId,
      data.batchNumber || null,
      data.expiryDate,
      data.quantity,
      data.unitPrice,
      data.minStockLevel,
      data.supplier || null,
    ]
  );

  return getInventoryItem(id);
}

/**
 * Get inventory item by ID
 * @param inventoryId - Inventory item ID
 * @returns Inventory item or null
 */
export function getInventoryItem(inventoryId: string): InventoryItem | null {
  const item = get<any>(
    `SELECT i.*, md.name_en as drug_name, md.name_ar as drug_name_ar
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.id = ?`,
    [inventoryId]
  );

  return item || null;
}

/**
 * Update inventory item
 * @param data - Inventory item data
 * @returns Updated inventory item
 */
export function updateInventoryItem(
  data: UpdateInventoryItem
): InventoryItem | null {
  UpdateInventoryItemSchema.parse(data);
  const updates: string[] = [];
  const params: any[] = [];

  if (data.drugId !== undefined) {
    updates.push('drug_id = ?');
    params.push(data.drugId);
  }
  if (data.batchNumber !== undefined) {
    updates.push('batch_number = ?');
    params.push(data.batchNumber);
  }
  if (data.expiryDate !== undefined) {
    updates.push('expiry_date = ?');
    params.push(data.expiryDate);
  }
  if (data.quantity !== undefined) {
    updates.push('quantity = ?');
    params.push(data.quantity);
  }
  if (data.unitPrice !== undefined) {
    updates.push('unit_price = ?');
    params.push(data.unitPrice);
  }
  if (data.minStockLevel !== undefined) {
    updates.push('min_stock_level = ?');
    params.push(data.minStockLevel);
  }
  if (data.supplier !== undefined) {
    updates.push('supplier = ?');
    params.push(data.supplier);
  }

  if (updates.length === 0) {
    return getInventoryItem(data.id);
  }

  params.push(data.id);

  execute(
    `UPDATE inventory SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    params
  );

  return getInventoryItem(data.id);
}

/**
 * Delete inventory item
 * @param inventoryId - Inventory item ID
 * @returns Success status
 */
export function deleteInventoryItem(inventoryId: string): boolean {
  const result = execute(`DELETE FROM inventory WHERE id = ?`, [inventoryId]);
  return result.changes > 0;
}

/**
 * Get all inventory items for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns List of inventory items
 */
export function getPharmacyInventory(
  pharmacyId: string,
  options?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
    drugId?: number;
    lowStock?: boolean;
    expiringSoon?: boolean;
    expired?: boolean;
  }
): InventoryItem[] {
  let sql = `
    SELECT i.*, md.name_en as drug_name, md.name_ar as drug_name_ar, md.generic_name, md.manufacturer
    FROM inventory i
    JOIN master_drugs md ON i.drug_id = md.id
    WHERE i.pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.search) {
    sql += ` AND (md.name_en LIKE ? OR md.name_ar LIKE ? OR md.barcode LIKE ?)`;
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  if (options?.drugId) {
    sql += ` AND i.drug_id = ?`;
    params.push(options.drugId);
  }

  if (options?.lowStock) {
    sql += ` AND i.quantity <= i.min_stock_level`;
  }

  if (options?.expiringSoon) {
    sql += ` AND i.expiry_date BETWEEN date('now') AND date('now', '+30 days')`;
  }

  if (options?.expired) {
    sql += ` AND i.expiry_date < date('now')`;
  }

  // Sorting - validate against whitelist to prevent SQL injection
  const allowedSortColumns = [
    'created_at', 'updated_at', 'drug_name', 'drug_name_ar', 'quantity',
    'unit_price', 'expiry_date', 'min_stock_level', 'supplier'
  ];
  const sortBy = allowedSortColumns.includes(options?.sortBy || '')
    ? options.sortBy
    : 'created_at';

  const allowedSortOrders = ['ASC', 'DESC'];
  const sortOrder = allowedSortOrders.includes(options?.sortOrder?.toUpperCase() || '')
    ? options.sortOrder?.toUpperCase()
    : 'DESC';

  sql += ` ORDER BY ${sortBy} ${sortOrder}`;

  // Pagination
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
 * Get inventory count for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns Count of inventory items
 */
export function getPharmacyInventoryCount(
  pharmacyId: string,
  options?: {
    search?: string;
    drugId?: number;
    lowStock?: boolean;
    expiringSoon?: boolean;
    expired?: boolean;
  }
): number {
  let sql = `
    SELECT COUNT(*) as count
    FROM inventory i
    WHERE i.pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.search) {
    sql += ` AND EXISTS (
      SELECT 1 FROM master_drugs md
      WHERE md.id = i.drug_id
      AND (md.name_en LIKE ? OR md.name_ar LIKE ? OR md.barcode LIKE ?)
    )`;
    const searchTerm = `%${options.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  if (options?.drugId) {
    sql += ` AND i.drug_id = ?`;
    params.push(options.drugId);
  }

  if (options?.lowStock) {
    sql += ` AND i.quantity <= i.min_stock_level`;
  }

  if (options?.expiringSoon) {
    sql += ` AND i.expiry_date BETWEEN date('now') AND date('now', '+30 days')`;
  }

  if (options?.expired) {
    sql += ` AND i.expiry_date < date('now')`;
  }

  const result = get<{ count: number }>(sql, params);
  return result?.count || 0;
}

/**
 * Get low stock items
 * @param pharmacyId - Pharmacy ID
 * @returns List of low stock items
 */
export function getLowStockItems(pharmacyId: string): InventoryItem[] {
  return getPharmacyInventory(pharmacyId, { lowStock: true });
}

/**
 * Get expiring soon items
 * @param pharmacyId - Pharmacy ID
 * @param days - Number of days to look ahead (default 30)
 * @returns List of expiring items
 */
export function getExpiringItems(
  pharmacyId: string,
  days: number = 30
): InventoryItem[] {
  return query<any>(
    `SELECT i.*, md.name_en as drug_name, md.name_ar as drug_name_ar
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ?
     AND i.expiry_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
     ORDER BY i.expiry_date ASC`,
    [pharmacyId, days]
  );
}

/**
 * Get expired items
 * @param pharmacyId - Pharmacy ID
 * @returns List of expired items
 */
export function getExpiredItems(pharmacyId: string): InventoryItem[] {
  return getPharmacyInventory(pharmacyId, { expired: true });
}

/**
 * Update inventory quantity
 * @param inventoryId - Inventory item ID
 * @param quantity - New quantity
 * @returns Success status
 */
export function updateInventoryQuantity(
  inventoryId: string,
  quantity: number
): boolean {
  const result = execute(
    `UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`,
    [quantity, inventoryId]
  );
  return result.changes > 0;
}

/**
 * Adjust inventory quantity (add or subtract)
 * @param inventoryId - Inventory item ID
 * @param adjustment - Quantity adjustment (positive to add, negative to subtract)
 * @returns Success status
 */
export function adjustInventoryQuantity(
  inventoryId: string,
  adjustment: number
): boolean {
  const result = execute(
    `UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`,
    [adjustment, inventoryId]
  );
  return result.changes > 0;
}

/**
 * Get inventory by drug ID
 * @param pharmacyId - Pharmacy ID
 * @param drugId - Drug ID
 * @returns List of inventory items for the drug
 */
export function getInventoryByDrug(
  pharmacyId: string,
  drugId: number
): InventoryItem[] {
  return query<any>(
    `SELECT i.*, md.name_en as drug_name, md.name_ar as drug_name_ar
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ? AND i.drug_id = ?
     ORDER BY i.expiry_date ASC`,
    [pharmacyId, drugId]
  );
}

/**
 * Get inventory by barcode
 * @param pharmacyId - Pharmacy ID
 * @param barcode - Drug barcode
 * @returns List of inventory items
 */
export function getInventoryByBarcode(
  pharmacyId: string,
  barcode: string
): InventoryItem[] {
  return query<any>(
    `SELECT i.*, md.name_en as drug_name, md.name_ar as drug_name_ar
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ? AND md.barcode = ?
     ORDER BY i.expiry_date ASC`,
    [pharmacyId, barcode]
  );
}

/**
 * Get inventory statistics
 * @param pharmacyId - Pharmacy ID
 * @returns Inventory statistics
 */
export function getInventoryStatistics(pharmacyId: string): {
  totalItems: number;
  totalQuantity: number;
  totalValue: number;
  lowStockCount: number;
  expiringSoonCount: number;
  expiredCount: number;
} {
  const result = get<any>(
    `SELECT 
      COUNT(*) as totalItems,
      COALESCE(SUM(quantity), 0) as totalQuantity,
      COALESCE(SUM(quantity * unit_price), 0) as totalValue,
      SUM(CASE WHEN quantity <= min_stock_level THEN 1 ELSE 0 END) as lowStockCount,
      SUM(CASE WHEN expiry_date BETWEEN date('now') AND date('now', '+30 days') THEN 1 ELSE 0 END) as expiringSoonCount,
      SUM(CASE WHEN expiry_date < date('now') THEN 1 ELSE 0 END) as expiredCount
     FROM inventory 
     WHERE pharmacy_id = ?`,
    [pharmacyId]
  );

  return {
    totalItems: result?.totalItems || 0,
    totalQuantity: result?.totalQuantity || 0,
    totalValue: result?.totalValue || 0,
    lowStockCount: result?.lowStockCount || 0,
    expiringSoonCount: result?.expiringSoonCount || 0,
    expiredCount: result?.expiredCount || 0,
  };
}

/**
 * Batch create inventory items
 * @param pharmacyId - Pharmacy ID
 * @param items - List of inventory items to create
 * @returns List of created items
 */
export function batchCreateInventoryItems(
  pharmacyId: string,
  items: CreateInventoryItem[]
): InventoryItem[] {
  const createdItems: InventoryItem[] = [];

  for (const item of items) {
    const created = createInventoryItem(pharmacyId, item);
    if (created) {
      createdItems.push(created);
    }
  }

  return createdItems;
}

/**
 * Search inventory
 * @param pharmacyId - Pharmacy ID
 * @param query - Search query
 * @param options - Query options
 * @returns List of matching inventory items
 */
export function searchInventory(
  pharmacyId: string,
  searchQuery: string,
  options?: {
    limit?: number;
    offset?: number;
  }
): InventoryItem[] {
  return getPharmacyInventory(pharmacyId, {
    search: searchQuery,
    limit: options?.limit,
    offset: options?.offset,
  });
}

/**
 * Get inventory value by category
 * @param pharmacyId - Pharmacy ID
 * @returns Inventory value by category
 */
export function getInventoryValueByCategory(pharmacyId: string): Array<{
  category: string;
  totalValue: number;
  itemCount: number;
}> {
  return query<any>(
    `SELECT
      md.category,
      COALESCE(SUM(i.quantity * i.unit_price), 0) as total_value,
      COUNT(*) as item_count
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ?
     GROUP BY md.category
     ORDER BY total_value DESC`,
    [pharmacyId]
  );
}

/**
 * Get top suppliers
 * @param pharmacyId - Pharmacy ID
 * @param limit - Number of suppliers to return
 * @returns List of top suppliers
 */
export function getTopSuppliers(
  pharmacyId: string,
  limit: number = 10
): Array<{
  supplier: string;
  itemCount: number;
  totalValue: number;
}> {
  return query<any>(
    `SELECT
      supplier,
      COUNT(*) as item_count,
      COALESCE(SUM(quantity * unit_price), 0) as total_value
     FROM inventory
     WHERE pharmacy_id = ? AND supplier IS NOT NULL
     GROUP BY supplier
     ORDER BY total_value DESC
     LIMIT ?`,
    [pharmacyId, limit]
  );
}
