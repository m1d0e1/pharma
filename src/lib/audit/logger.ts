/**
 * Audit Logging Service
 * Comprehensive audit trail for sensitive operations
 */

import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query } from '../db/client';

export interface AuditEvent {
  id: string;
  userId: string;
  pharmacyId: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

export interface AuditLogOptions {
  userId: string;
  pharmacyId: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log an audit event
 * @param options - Audit event options
 * @returns Success status
 */
export function logAuditEvent(options: AuditLogOptions): boolean {
  try {
    const db = getDatabase();

    // Check if audit_logs table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'
    `).get();

    if (!tableExists) {
      createAuditLogsTable(db);
    }

    execute(
      `INSERT INTO audit_logs (id, user_id, pharmacy_id, action, resource, resource_id, details, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        uuidv4(),
        options.userId,
        options.pharmacyId,
        options.action,
        options.resource,
        options.resourceId || null,
        options.details ? JSON.stringify(options.details) : null,
        options.ipAddress || null,
        options.userAgent || null,
      ]
    );

    return true;
  } catch (error) {
    console.error('Failed to log audit event:', error);
    return false;
  }
}

/**
 * Create audit logs table if it doesn't exist
 */
function createAuditLogsTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pharmacy_id TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_pharmacy_id ON audit_logs(pharmacy_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at);
  `);
}

/**
 * Get audit logs for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns List of audit logs
 */
export function getAuditLogs(
  pharmacyId: string,
  options?: {
    limit?: number;
    offset?: number;
    userId?: string;
    action?: string;
    resource?: string;
    startDate?: string;
    endDate?: string;
  }
): AuditEvent[] {
  let sql = `
    SELECT al.*, u.username, u.full_name
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     WHERE al.pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.userId) {
    sql += ` AND al.user_id = ?`;
    params.push(options.userId);
  }

  if (options?.action) {
    sql += ` AND al.action = ?`;
    params.push(options.action);
  }

  if (options?.resource) {
    sql += ` AND al.resource = ?`;
    params.push(options.resource);
  }

  if (options?.startDate) {
    sql += ` AND al.created_at >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND al.created_at <= ?`;
    params.push(options.endDate);
  }

  sql += ` ORDER BY al.created_at DESC`;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ` OFFSET ?`;
    params.push(options.offset);
  }

  return query<any>(sql, params).map((row: any) => ({
    id: row.id,
    userId: row.user_id,
    pharmacyId: row.pharmacy_id,
    action: row.action,
    resource: row.resource,
    resourceId: row.resource_id,
    details: row.details ? JSON.parse(row.details) : null,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    username: row.username,
    fullName: row.full_name,
  }));
}

/**
 * Get audit log count for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns Count of audit logs
 */
export function getAuditLogsCount(
  pharmacyId: string,
  options?: {
    userId?: string;
    action?: string;
    resource?: string;
    startDate?: string;
    endDate?: string;
  }
): number {
  let sql = `SELECT COUNT(*) as count FROM audit_logs WHERE pharmacy_id = ?`;
  const params: any[] = [pharmacyId];

  if (options?.userId) {
    sql += ` AND user_id = ?`;
    params.push(options.userId);
  }

  if (options?.action) {
    sql += ` AND action = ?`;
    params.push(options.action);
  }

  if (options?.resource) {
    sql += ` AND resource = ?`;
    params.push(options.resource);
  }

  if (options?.startDate) {
    sql += ` AND created_at >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND created_at <= ?`;
    params.push(options.endDate);
  }

  const result = get<{ count: number }>(sql, params);
  return result?.count || 0;
}

/**
 * Get audit log statistics
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns Audit statistics
 */
export function getAuditLogStatistics(
  pharmacyId: string,
  options?: {
    startDate?: string;
    endDate?: string;
  }
): {
  totalLogs: number;
  byAction: Record<string, number>;
  byResource: Record<string, number>;
  byUser: Array<{ userId: string; username: string; fullName: string; count: number }>;
  topActions: Array<{ action: string; count: number }>;
} {
  let dateFilter = '';
  const params: any[] = [pharmacyId];

  if (options?.startDate) {
    dateFilter += ` AND created_at >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    dateFilter += ` AND created_at <= ?`;
    params.push(options.endDate);
  }

  // Total logs
  const totalResult = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM audit_logs WHERE pharmacy_id = ?${dateFilter}`,
    params
  );

  // By action
  const byActionResult = query<{ action: string; count: number }>(
    `SELECT action, COUNT(*) as count
     FROM audit_logs
     WHERE pharmacy_id = ?${dateFilter}
     GROUP BY action
     ORDER BY count DESC`,
    params
  );

  // By resource
  const byResourceResult = query<{ resource: string; count: number }>(
    `SELECT resource, COUNT(*) as count
     FROM audit_logs
     WHERE pharmacy_id = ?${dateFilter}
     GROUP BY resource
     ORDER BY count DESC`,
    params
  );

  // By user
  const byUserResult = query<{ user_id: string; username: string; full_name: string; count: number }>(
    `SELECT al.user_id, u.username, u.full_name, COUNT(*) as count
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     WHERE al.pharmacy_id = ?${dateFilter}
     GROUP BY al.user_id, u.username, u.full_name
     ORDER BY count DESC
     LIMIT 10`,
    params
  );

  return {
    totalLogs: totalResult?.count || 0,
    byAction: byActionResult.reduce((acc, row) => ({ ...acc, [row.action]: row.count }), {}),
    byResource: byResourceResult.reduce((acc, row) => ({ ...acc, [row.resource]: row.count }), {}),
    byUser: byUserResult.map(row => ({
      userId: row.user_id,
      username: row.username,
      fullName: row.full_name,
      count: row.count,
    })),
    topActions: byActionResult.slice(0, 5),
  };
}

/**
 * Get audit logs for a specific resource
 * @param pharmacyId - Pharmacy ID
 * @param resource - Resource type
 * @param resourceId - Resource ID
 * @returns List of audit logs
 */
export function getResourceAuditLogs(
  pharmacyId: string,
  resource: string,
  resourceId: string
): AuditEvent[] {
  return query<any>(
    `SELECT al.*, u.username, u.full_name
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     WHERE al.pharmacy_id = ? AND al.resource = ? AND al.resource_id = ?
     ORDER BY al.created_at DESC`,
    [pharmacyId, resource, resourceId]
  );
}

/**
 * Get audit logs for a specific user
 * @param pharmacyId - Pharmacy ID
 * @param userId - User ID
 * @param options - Query options
 * @returns List of audit logs
 */
export function getUserAuditLogs(
  pharmacyId: string,
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
  }
): AuditEvent[] {
  let sql = `
    SELECT al.*, u.username, u.full_name
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     WHERE al.pharmacy_id = ? AND al.user_id = ?
     ORDER BY al.created_at DESC
  `;
  const params: any[] = [pharmacyId, userId];

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
 * Get recent audit logs
 * @param pharmacyId - Pharmacy ID
 * @param limit - Number of logs to return
 * @returns List of recent audit logs
 */
export function getRecentAuditLogs(pharmacyId: string, limit: number = 50): AuditEvent[] {
  return query<any>(
    `SELECT al.*, u.username, u.full_name
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     WHERE al.pharmacy_id = ?
     ORDER BY al.created_at DESC
     LIMIT ?`,
    [pharmacyId, limit]
  );
}

/**
 * Delete old audit logs
 * @param daysToKeep - Number of days to keep
 * @returns Number of deleted logs
 */
export function deleteOldAuditLogs(daysToKeep: number = 90): number {
  try {
    const db = getDatabase();

    const result = db.prepare(`
      DELETE FROM audit_logs
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(daysToKeep);

    return result.changes;
  } catch (error) {
    console.error('Failed to delete old audit logs:', error);
    return 0;
  }
}

/**
 * Clear all audit logs for a pharmacy (use with caution)
 * @param pharmacyId - Pharmacy ID
 * @returns Number of deleted logs
 */
export function clearAuditLogs(pharmacyId: string): number {
  try {
    const db = getDatabase();

    const result = db.prepare(`
      DELETE FROM audit_logs WHERE pharmacy_id = ?
    `).run(pharmacyId);

    return result.changes;
  } catch (error) {
    console.error('Failed to clear audit logs:', error);
    return 0;
  }
}

/**
 * Audit action types
 */
export const AuditActions = {
  // Authentication
  LOGIN: 'login',
  LOGOUT: 'logout',
  PASSWORD_CHANGE: 'password_change',
  PASSWORD_RESET: 'password_reset',

  // User management
  USER_CREATE: 'user_create',
  USER_UPDATE: 'user_update',
  USER_DELETE: 'user_delete',
  USER_ACTIVATE: 'user_activate',
  USER_DEACTIVATE: 'user_deactivate',

  // Inventory
  INVENTORY_CREATE: 'inventory_create',
  INVENTORY_UPDATE: 'inventory_update',
  INVENTORY_DELETE: 'inventory_delete',
  INVENTORY_ADJUST: 'inventory_adjust',
  INVENTORY_RESTOCK: 'inventory_restock',

  // Sales
  SALE_CREATE: 'sale_create',
  SALE_UPDATE: 'sale_update',
  SALE_DELETE: 'sale_delete',
  SALE_VOID: 'sale_void',

  // Returns
  RETURN_CREATE: 'return_create',
  RETURN_APPROVE: 'return_approve',
  RETURN_REJECT: 'return_reject',

  // Patients
  PATIENT_CREATE: 'patient_create',
  PATIENT_UPDATE: 'patient_update',
  PATIENT_DELETE: 'patient_delete',

  // Shifts
  SHIFT_START: 'shift_start',
  SHIFT_END: 'shift_end',
  SHIFT_CLOSE: 'shift_close',

  // Financial
  EXPENSE_CREATE: 'expense_create',
  EXPENSE_UPDATE: 'expense_update',
  EXPENSE_DELETE: 'expense_delete',
  CASH_MOVEMENT: 'cash_movement',

  // Settings
  SETTINGS_UPDATE: 'settings_update',
  CONFIG_UPDATE: 'config_update',

  // Reports
  REPORT_GENERATE: 'report_generate',
  REPORT_EXPORT: 'report_export',

  // System
  DATA_EXPORT: 'data_export',
  DATA_IMPORT: 'data_import',
  BACKUP_CREATE: 'backup_create',
  BACKUP_RESTORE: 'backup_restore',
} as const;

/**
 * Audit resource types
 */
export const AuditResources = {
  USER: 'user',
  INVENTORY: 'inventory',
  SALE: 'sale',
  RETURN: 'return',
  PATIENT: 'patient',
  SHIFT: 'shift',
  EXPENSE: 'expense',
  CASH_MOVEMENT: 'cash_movement',
  SETTINGS: 'settings',
  CONFIG: 'config',
  REPORT: 'report',
  BACKUP: 'backup',
} as const;

/**
 * Helper function to log common audit events
 */
export const audit = {
  login: (userId: string, pharmacyId: string, ipAddress?: string, userAgent?: string) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.LOGIN,
      resource: AuditResources.USER,
      resourceId: userId,
      ipAddress,
      userAgent,
    }),

  logout: (userId: string, pharmacyId: string, ipAddress?: string, userAgent?: string) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.LOGOUT,
      resource: AuditResources.USER,
      resourceId: userId,
      ipAddress,
      userAgent,
    }),

  saleCreate: (userId: string, pharmacyId: string, saleId: string, details?: any) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.SALE_CREATE,
      resource: AuditResources.SALE,
      resourceId: saleId,
      details,
    }),

  saleVoid: (userId: string, pharmacyId: string, saleId: string, reason?: string) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.SALE_VOID,
      resource: AuditResources.SALE,
      resourceId: saleId,
      details: { reason },
    }),

  inventoryAdjust: (userId: string, pharmacyId: string, inventoryId: string, details?: any) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.INVENTORY_ADJUST,
      resource: AuditResources.INVENTORY,
      resourceId: inventoryId,
      details,
    }),

  shiftStart: (userId: string, pharmacyId: string, shiftId: string, details?: any) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.SHIFT_START,
      resource: AuditResources.SHIFT,
      resourceId: shiftId,
      details,
    }),

  shiftEnd: (userId: string, pharmacyId: string, shiftId: string, details?: any) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.SHIFT_END,
      resource: AuditResources.SHIFT,
      resourceId: shiftId,
      details,
    }),

  expenseCreate: (userId: string, pharmacyId: string, expenseId: string, details?: any) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.EXPENSE_CREATE,
      resource: AuditResources.EXPENSE,
      resourceId: expenseId,
      details,
    }),

  settingsUpdate: (userId: string, pharmacyId: string, setting: string, oldValue?: any, newValue?: any) =>
    logAuditEvent({
      userId,
      pharmacyId,
      action: AuditActions.SETTINGS_UPDATE,
      resource: AuditResources.SETTINGS,
      details: { setting, oldValue, newValue },
    }),
};
