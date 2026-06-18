import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query } from '../db/client';
import { hashPassword } from '../auth/password';
import { ROLE_PERMISSIONS, Permission } from '../auth/roles';

// User management schemas
export const CreateUserSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8),
  fullName: z.string().min(1),
  role: z.enum(['owner', 'manager', 'pharmacist', 'cashier']),
  permissions: z.array(z.string()).optional(),
  isActive: z.boolean().default(true),
});

export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = CreateUserSchema.partial().extend({
  id: z.string().uuid(),
});

export type UpdateUser = z.infer<typeof UpdateUserSchema>;

// Pharmacy management schemas
export const CreatePharmacySchema = z.object({
  nameEn: z.string().min(1),
  nameAr: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  commercialRegistry: z.string().optional(),
  taxCard: z.string().optional(),
  ownerName: z.string().optional(),
  ownerPhone: z.string().optional(),
  subscriptionId: z.string().optional(),
});

export type CreatePharmacy = z.infer<typeof CreatePharmacySchema>;

export const UpdatePharmacySchema = CreatePharmacySchema.partial().extend({
  id: z.string().uuid(),
});

export type UpdatePharmacy = z.infer<typeof UpdatePharmacySchema>;

/**
 * Create a new pharmacy
 * @param data - Pharmacy data
 * @returns Created pharmacy
 */
export function createPharmacy(data: CreatePharmacy): any {
  const pharmacyId = uuidv4();

  execute(
    `INSERT INTO pharmacies (id, name_en, name_ar, phone, address, commercial_registry, tax_card, owner_name, owner_phone, subscription_id, subscription_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`,
    [
      pharmacyId,
      data.nameEn,
      data.nameAr || null,
      data.phone || null,
      data.address || null,
      data.commercialRegistry || null,
      data.taxCard || null,
      data.ownerName || null,
      data.ownerPhone || null,
      data.subscriptionId || null,
    ]
  );

  return getPharmacy(pharmacyId);
}

/**
 * Get a pharmacy by ID
 * @param pharmacyId - Pharmacy ID
 * @returns Pharmacy data or null
 */
export function getPharmacy(pharmacyId: string): any {
  return get<any>(`SELECT * FROM pharmacies WHERE id = ?`, [pharmacyId]);
}

/**
 * Update a pharmacy
 * @param data - Pharmacy data
 * @returns Updated pharmacy
 */
export function updatePharmacy(data: UpdatePharmacy): any {
  const updates: string[] = [];
  const params: any[] = [];

  if (data.nameEn !== undefined) {
    updates.push('name_en = ?');
    params.push(data.nameEn);
  }
  if (data.nameAr !== undefined) {
    updates.push('name_ar = ?');
    params.push(data.nameAr);
  }
  if (data.phone !== undefined) {
    updates.push('phone = ?');
    params.push(data.phone);
  }
  if (data.address !== undefined) {
    updates.push('address = ?');
    params.push(data.address);
  }
  if (data.commercialRegistry !== undefined) {
    updates.push('commercial_registry = ?');
    params.push(data.commercialRegistry);
  }
  if (data.taxCard !== undefined) {
    updates.push('tax_card = ?');
    params.push(data.taxCard);
  }
  if (data.ownerName !== undefined) {
    updates.push('owner_name = ?');
    params.push(data.ownerName);
  }
  if (data.ownerPhone !== undefined) {
    updates.push('owner_phone = ?');
    params.push(data.ownerPhone);
  }
  if (data.subscriptionId !== undefined) {
    updates.push('subscription_id = ?');
    params.push(data.subscriptionId);
  }

  if (updates.length === 0) {
    return getPharmacy(data.id);
  }

  params.push(data.id);

  execute(
    `UPDATE pharmacies SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    params
  );

  return getPharmacy(data.id);
}

/**
 * Delete a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @returns Success status
 */
export function deletePharmacy(pharmacyId: string): boolean {
  const result = execute(`DELETE FROM pharmacies WHERE id = ?`, [pharmacyId]);
  return result.changes > 0;
}

/**
 * Get all users for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @returns List of users
 */
export function getPharmacyUsers(pharmacyId: string): any[] {
  return query<any>(
    `SELECT id, username, full_name, role, permissions, is_active, created_at, updated_at
     FROM users
     WHERE pharmacy_id = ?
     ORDER BY created_at DESC`,
    [pharmacyId]
  );
}

/**
 * Create a new user
 * @param pharmacyId - Pharmacy ID
 * @param data - User data
 * @returns Created user
 */
export async function createUser(
  pharmacyId: string,
  data: CreateUser
): Promise<any> {
  // Validate request
  CreateUserSchema.parse(data);

  // Check if username already exists
  const existingUser = get<any>(
    `SELECT id FROM users WHERE username = ?`,
    [data.username]
  );

  if (existingUser) {
    throw new Error('Username already exists');
  }

  // Hash password
  const passwordHash = await hashPassword(data.password);

  // Get default permissions for role
  const rolePermissions =
    ROLE_PERMISSIONS[data.role]?.permissions || [];

  // Create user
  const userId = uuidv4();
  execute(
    `INSERT INTO users (id, username, password_hash, pharmacy_id, role, permissions, full_name, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      userId,
      data.username,
      passwordHash,
      pharmacyId,
      data.role,
      JSON.stringify(data.permissions || rolePermissions),
      data.fullName,
      data.isActive ? 1 : 0,
    ]
  );

  return getUser(userId);
}

/**
 * Get a user by ID
 * @param userId - User ID
 * @returns User data or null
 */
export function getUser(userId: string): any {
  return get<any>(
    `SELECT id, username, pharmacy_id, full_name, role, permissions, is_active, created_at, updated_at
     FROM users
     WHERE id = ?`,
    [userId]
  );
}

/**
 * Update a user
 * @param data - User data
 * @returns Updated user
 */
export async function updateUser(data: UpdateUser): Promise<any> {
  // Validate request
  UpdateUserSchema.parse(data);

  const updates: string[] = [];
  const params: any[] = [];

  if (data.fullName !== undefined) {
    updates.push('full_name = ?');
    params.push(data.fullName);
  }
  if (data.role !== undefined) {
    updates.push('role = ?');
    params.push(data.role);
  }
  if (data.permissions !== undefined) {
    updates.push('permissions = ?');
    params.push(JSON.stringify(data.permissions));
  }
  if (data.isActive !== undefined) {
    updates.push('is_active = ?');
    params.push(data.isActive ? 1 : 0);
  }

  if (data.password !== undefined) {
    updates.push('password_hash = ?');
    params.push(await hashPassword(data.password));
  }

  if (updates.length === 0) {
    return getUser(data.id);
  }

  params.push(data.id);

  execute(
    `UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    params
  );

  return getUser(data.id);
}

/**
 * Delete a user
 * @param userId - User ID
 * @returns Success status
 */
export function deleteUser(userId: string): boolean {
  const result = execute(`DELETE FROM users WHERE id = ?`, [userId]);
  return result.changes > 0;
}

/**
 * Deactivate a user
 * @param userId - User ID
 * @returns Success status
 */
export function deactivateUser(userId: string): boolean {
  const result = execute(
    `UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
    [userId]
  );
  return result.changes > 0;
}

/**
 * Activate a user
 * @param userId - User ID
 * @returns Success status
 */
export function activateUser(userId: string): boolean {
  const result = execute(
    `UPDATE users SET is_active = 1, updated_at = datetime('now') WHERE id = ?`,
    [userId]
  );
  return result.changes > 0;
}

/**
 * Reset user password
 * @param userId - User ID
 * @param newPassword - New password
 * @returns Success status
 */
export async function resetUserPassword(
  userId: string,
  newPassword: string
): Promise<boolean> {
  const passwordHash = await hashPassword(newPassword);

  const result = execute(
    `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    [passwordHash, userId]
  );

  return result.changes > 0;
}

/**
 * Get user permissions
 * @param userId - User ID
 * @returns List of permissions
 */
export function getUserPermissions(userId: string): Permission[] {
  const user = get<any>(
    `SELECT permissions FROM users WHERE id = ?`,
    [userId]
  );

  if (!user) {
    return [];
  }

  return JSON.parse(user.permissions);
}

/**
 * Update user permissions
 * @param userId - User ID
 * @param permissions - New permissions
 * @returns Success status
 */
export function updateUserPermissions(
  userId: string,
  permissions: Permission[]
): boolean {
  const result = execute(
    `UPDATE users SET permissions = ?, updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(permissions), userId]
  );

  return result.changes > 0;
}

/**
 * Check if username exists
 * @param username - Username
 * @returns True if username exists
 */
export function usernameExists(username: string): boolean {
  const user = get<any>(
    `SELECT id FROM users WHERE username = ?`,
    [username]
  );

  return user !== undefined;
}

/**
 * Get user by username
 * @param username - Username
 * @returns User data or null
 */
export function getUserByUsername(username: string): any {
  return get<any>(
    `SELECT id, username, pharmacy_id, full_name, role, permissions, is_active, created_at, updated_at
     FROM users
     WHERE username = ?`,
    [username]
  );
}

/**
 * Get pharmacy statistics
 * @param pharmacyId - Pharmacy ID
 * @returns Pharmacy statistics
 */
export function getPharmacyStats(pharmacyId: string): any {
  const userCount = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM users WHERE pharmacy_id = ?`,
    [pharmacyId]
  );

  const inventoryCount = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM inventory WHERE pharmacy_id = ?`,
    [pharmacyId]
  );

  const patientCount = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM patients WHERE pharmacy_id = ?`,
    [pharmacyId]
  );

  const salesCount = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM sales_invoices WHERE pharmacy_id = ?`,
    [pharmacyId]
  );

  return {
    userCount: userCount?.count || 0,
    inventoryCount: inventoryCount?.count || 0,
    patientCount: patientCount?.count || 0,
    salesCount: salesCount?.count || 0,
  };
}
