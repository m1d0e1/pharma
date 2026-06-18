import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, execute, get, query } from '../db/client';

// Shift register schema
export const ShiftRegisterSchema = z.object({
  id: z.string().uuid(),
  pharmacyId: z.string().uuid(),
  userId: z.string().uuid(),
  startingCashAmount: z.number().nonnegative(),
  endingCashAmount: z.number().nonnegative().nullable(),
  openingNotes: z.string().optional(),
  closingNotes: z.string().optional(),
  shiftStart: z.string().datetime(),
  shiftEnd: z.string().datetime().nullable(),
  status: z.enum(['open', 'closed', 'discrepancy']),
  verifiedBy: z.string().uuid().nullable(),
  verifiedAt: z.string().datetime().nullable(),
});

export type ShiftRegister = z.infer<typeof ShiftRegisterSchema>;

// Create shift request schema
export const CreateShiftRequestSchema = z.object({
  startingCashAmount: z.number().nonnegative(),
  openingNotes: z.string().optional(),
});

export type CreateShiftRequest = z.infer<typeof CreateShiftRequestSchema>;

// Close shift request schema
export const CloseShiftRequestSchema = z.object({
  endingCashAmount: z.number().nonnegative(),
  closingNotes: z.string().optional(),
});

export type CloseShiftRequest = z.infer<typeof CloseShiftRequestSchema>;

/**
 * Start a new shift for a user
 * @param pharmacyId - Pharmacy ID
 * @param userId - User ID
 * @param request - Shift creation request
 * @returns Created shift register
 */
export function startShift(
  pharmacyId: string,
  userId: string,
  request: CreateShiftRequest
): ShiftRegister {
  // Check if user already has an open shift
  const existingShift = getOpenShift(userId);
  if (existingShift) {
    throw new Error('User already has an open shift');
  }

  const shiftId = uuidv4();

  execute(
    `INSERT INTO shift_registers (id, pharmacy_id, user_id, starting_cash_amount, opening_notes, shift_start, status)
     VALUES (?, ?, ?, ?, ?, datetime('now'), 'open')`,
    [shiftId, pharmacyId, userId, request.startingCashAmount, request.openingNotes || null]
  );

  return getShift(shiftId);
}

/**
 * Close a shift
 * @param shiftId - Shift ID
 * @param request - Shift closing request
 * @returns Updated shift register
 */
export function closeShift(
  shiftId: string,
  request: CloseShiftRequest
): ShiftRegister {
  const shift = getShift(shiftId);

  if (!shift) {
    throw new Error('Shift not found');
  }

  if (shift.status !== 'open') {
    throw new Error('Shift is already closed');
  }

  // Calculate expected cash
  const expectedCash = calculateExpectedCash(shiftId);

  // Determine status based on discrepancy
  const discrepancy = request.endingCashAmount - expectedCash;
  const status = Math.abs(discrepancy) > 5 ? 'discrepancy' : 'closed';

  execute(
    `UPDATE shift_registers
     SET ending_cash_amount = ?,
         closing_notes = ?,
         shift_end = datetime('now'),
         status = ?
     WHERE id = ?`,
    [request.endingCashAmount, request.closingNotes || null, status, shiftId]
  );

  return getShift(shiftId);
}

function mapShiftRow(row: any): ShiftRegister | null {
  if (!row) return null;
  return {
    id: row.id,
    pharmacyId: row.pharmacy_id,
    userId: row.user_id,
    startingCashAmount: row.starting_cash_amount,
    endingCashAmount: row.ending_cash_amount !== undefined ? row.ending_cash_amount : null,
    openingNotes: row.opening_notes || undefined,
    closingNotes: row.closing_notes || undefined,
    shiftStart: row.shift_start,
    shiftEnd: row.shift_end !== undefined ? row.shift_end : null,
    status: row.status,
    verifiedBy: row.verified_by !== undefined ? row.verified_by : null,
    verifiedAt: row.verified_at !== undefined ? row.verified_at : null,
    ...(row.username && { username: row.username }),
    ...(row.full_name && { full_name: row.full_name }),
  } as any;
}

/**
 * Get shift by ID
 * @param shiftId - Shift ID
 * @returns Shift register or null
 */
export function getShift(shiftId: string): ShiftRegister | null {
  const result = get<any>(
    `SELECT sr.*, u.username, u.full_name
     FROM shift_registers sr
     JOIN users u ON sr.user_id = u.id
     WHERE sr.id = ?`,
    [shiftId]
  );
  return mapShiftRow(result);
}

/**
 * Get open shift for a user
 * @param userId - User ID
 * @returns Open shift or null
 */
export function getOpenShift(userId: string): ShiftRegister | null {
  const result = get<any>(
    `SELECT sr.*, u.username, u.full_name
     FROM shift_registers sr
     JOIN users u ON sr.user_id = u.id
     WHERE sr.user_id = ? AND sr.status = 'open'`,
    [userId]
  );
  return mapShiftRow(result);
}

/**
 * Get all shifts for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns List of shift registers
 */
export function getPharmacyShifts(
  pharmacyId: string,
  options?: {
    limit?: number;
    offset?: number;
    userId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
  }
): ShiftRegister[] {
  let sql = `
    SELECT sr.*, u.username, u.full_name
    FROM shift_registers sr
    JOIN users u ON sr.user_id = u.id
    WHERE sr.pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.userId) {
    sql += ` AND sr.user_id = ?`;
    params.push(options.userId);
  }

  if (options?.status) {
    sql += ` AND sr.status = ?`;
    params.push(options.status);
  }

  if (options?.startDate) {
    sql += ` AND sr.shift_start >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND sr.shift_start <= ?`;
    params.push(options.endDate);
  }

  sql += ` ORDER BY sr.shift_start DESC`;

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ` OFFSET ?`;
    params.push(options.offset);
  }

  return query<any>(sql, params).map(mapShiftRow).filter(Boolean) as ShiftRegister[];
}

/**
 * Get shift statistics
 * @param pharmacyId - Pharmacy ID
 * @param options - Query options
 * @returns Shift statistics
 */
export function getShiftStatistics(
  pharmacyId: string,
  options?: {
    startDate?: string;
    endDate?: string;
  }
): {
  totalShifts: number;
  openShifts: number;
  closedShifts: number;
  discrepancyShifts: number;
  totalCashHandled: number;
  averageShiftDuration: number;
} {
  let sql = `
    SELECT
      COUNT(*) as total_shifts,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_shifts,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_shifts,
      SUM(CASE WHEN status = 'discrepancy' THEN 1 ELSE 0 END) as discrepancy_shifts,
      COALESCE(SUM(ending_cash_amount), 0) as total_cash_handled
    FROM shift_registers
    WHERE pharmacy_id = ?
  `;
  const params: any[] = [pharmacyId];

  if (options?.startDate) {
    sql += ` AND shift_start >= ?`;
    params.push(options.startDate);
  }

  if (options?.endDate) {
    sql += ` AND shift_start <= ?`;
    params.push(options.endDate);
  }

  const result = get<any>(sql, params);

  // Calculate average shift duration
  const avgDurationResult = get<any>(
    `SELECT AVG(
      CASE
        WHEN shift_end IS NOT NULL
        THEN (julianday(shift_end) - julianday(shift_start)) * 24 * 60
        ELSE NULL
      END
    ) as avg_duration_minutes
     FROM shift_registers
     WHERE pharmacy_id = ? AND shift_end IS NOT NULL
     ${options?.startDate ? `AND shift_start >= ?` : ''}
     ${options?.endDate ? `AND shift_start <= ?` : ''}`,
    options?.startDate && options?.endDate
      ? [pharmacyId, options.startDate, options.endDate]
      : options?.startDate
      ? [pharmacyId, options.startDate]
      : options?.endDate
      ? [pharmacyId, options.endDate]
      : [pharmacyId]
  );

  return {
    totalShifts: result?.total_shifts || 0,
    openShifts: result?.open_shifts || 0,
    closedShifts: result?.closed_shifts || 0,
    discrepancyShifts: result?.discrepancy_shifts || 0,
    totalCashHandled: result?.total_cash_handled || 0,
    averageShiftDuration: avgDurationResult?.avg_duration_minutes || 0,
  };
}

/**
 * Calculate expected cash for a shift
 * @param shiftId - Shift ID
 * @returns Expected cash amount
 */
export function calculateExpectedCash(shiftId: string): number {
  const shift = getShift(shiftId);

  if (!shift) {
    throw new Error('Shift not found');
  }

  // Get total sales during this shift (bound by shiftEnd if closed)
  const salesResult = get<{ total: number }>(
    `SELECT COALESCE(SUM(total_amount), 0) as total
     FROM sales_invoices
     WHERE (shift_id = ? OR (user_id = ? AND created_at >= ? ${shift.shiftEnd ? `AND created_at <= ?` : ''}))
     AND status = 'completed' AND payment_method IN ('cash', 'delivery')`,
    shift.shiftEnd
      ? [shift.id, shift.userId, shift.shiftStart, shift.shiftEnd]
      : [shift.id, shift.userId, shift.shiftStart]
  );

  const returnsResult = get<{ total: number }>(
    `SELECT COALESCE(SUM(total_refund), 0) as total
     FROM returns
     WHERE (shift_id = ? OR (user_id = ? AND created_at >= ? ${shift.shiftEnd ? `AND created_at <= ?` : ''}))
     AND status = 'approved' AND refund_method = 'cash'`,
    shift.shiftEnd
      ? [shift.id, shift.userId, shift.shiftStart, shift.shiftEnd]
      : [shift.id, shift.userId, shift.shiftStart]
  );

  const movementsResult = get<{ net: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END), 0) as net
     FROM cash_movements
     WHERE (shift_id = ? OR (user_id = ? AND date >= ? ${shift.shiftEnd ? `AND date <= ?` : ''}))`,
    shift.shiftEnd
      ? [
          shift.id,
          shift.userId,
          (shift.shiftStart || '').split('T')[0] || new Date().toISOString().split('T')[0],
          (shift.shiftEnd || '').split('T')[0] || new Date().toISOString().split('T')[0]
        ]
      : [
          shift.id,
          shift.userId,
          (shift.shiftStart || '').split('T')[0] || new Date().toISOString().split('T')[0]
        ]
  );

  const totalSales = salesResult?.total || 0;
  const totalReturns = returnsResult?.total || 0;
  const netMovements = movementsResult?.net || 0;

  return shift.startingCashAmount + totalSales - totalReturns + netMovements;
}

/**
 * Get shift discrepancy
 * @param shiftId - Shift ID
 * @returns Discrepancy information
 */
export function getShiftDiscrepancy(shiftId: string): {
  expectedCash: number;
  actualCash: number;
  discrepancy: number;
  percentage: number;
} | null {
  const shift = getShift(shiftId);

  if (!shift || shift.status === 'open') {
    return null;
  }

  const expectedCash = calculateExpectedCash(shiftId);
  const actualCash = shift.endingCashAmount || 0;
  const discrepancy = actualCash - expectedCash;
  const percentage = expectedCash > 0 ? (discrepancy / expectedCash) * 100 : 0;

  return {
    expectedCash,
    actualCash,
    discrepancy,
    percentage,
  };
}

/**
 * Verify a shift
 * @param shiftId - Shift ID
 * @param verifiedBy - User ID of verifier
 * @param notes - Verification notes
 * @returns Updated shift register
 */
export function verifyShift(
  shiftId: string,
  verifiedBy: string,
  notes?: string
): ShiftRegister | null {
  const shift = getShift(shiftId);

  if (!shift) {
    throw new Error('Shift not found');
  }

  if (shift.status === 'open') {
    throw new Error('Cannot verify an open shift');
  }

  execute(
    `UPDATE shift_registers
     SET verified_by = ?,
         verified_at = datetime('now'),
         closing_notes = CASE
           WHEN closing_notes IS NULL THEN ?
           ELSE closing_notes || ' | ' || ?
         END
     WHERE id = ?`,
    [verifiedBy, notes || '', notes || '', shiftId]
  );

  return getShift(shiftId);
}

/**
 * Get user's shift history
 * @param userId - User ID
 * @param options - Query options
 * @returns List of shift registers
 */
export function getUserShiftHistory(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
  }
): ShiftRegister[] {
  let sql = `
    SELECT sr.*, u.username, u.full_name
    FROM shift_registers sr
    JOIN users u ON sr.user_id = u.id
    WHERE sr.user_id = ?
    ORDER BY sr.shift_start DESC
  `;
  const params: any[] = [userId];

  if (options?.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ` OFFSET ?`;
    params.push(options.offset);
  }

  return query<any>(sql, params).map(mapShiftRow).filter(Boolean) as ShiftRegister[];
}

/**
 * Get current shift for a user
 * @param userId - User ID
 * @returns Current shift or null
 */
export function getCurrentShift(userId: string): ShiftRegister | null {
  return getOpenShift(userId);
}

/**
 * Check if user has an open shift
 * @param userId - User ID
 * @returns True if user has open shift
 */
export function hasOpenShift(userId: string): boolean {
  return getOpenShift(userId) !== null;
}

/**
 * Get shift sales summary
 * @param shiftId - Shift ID
 * @returns Sales summary
 */
export function getShiftSalesSummary(shiftId: string): {
  totalSales: number;
  totalRevenue: number;
  averageTransaction: number;
  transactionCount: number;
  itemsSold: number;
} | null {
  const shift = getShift(shiftId);

  if (!shift) {
    return null;
  }

  const result = get<any>(
    `SELECT
      COUNT(*) as transaction_count,
      COALESCE(SUM(total_amount), 0) as total_revenue,
      COALESCE(SUM(total_amount) / COUNT(*), 0) as average_transaction
     FROM sales_invoices
     WHERE user_id = ? AND created_at >= ?
     ${shift.shiftEnd ? `AND created_at <= ?` : ''}`,
    shift.shiftEnd
      ? [shift.userId, shift.shiftStart, shift.shiftEnd]
      : [shift.userId, shift.shiftStart]
  );

  const itemsResult = get<{ total: number }>(
    `SELECT COALESCE(SUM(quantity_sold), 0) as total
     FROM sales_items si
     JOIN sales_invoices inv ON si.invoice_id = inv.id
     WHERE inv.user_id = ? AND inv.created_at >= ?
     ${shift.shiftEnd ? `AND inv.created_at <= ?` : ''}`,
    shift.shiftEnd
      ? [shift.userId, shift.shiftStart, shift.shiftEnd]
      : [shift.userId, shift.shiftStart]
  );

  return {
    totalSales: result?.transaction_count || 0,
    totalRevenue: result?.total_revenue || 0,
    averageTransaction: result?.average_transaction || 0,
    transactionCount: result?.transaction_count || 0,
    itemsSold: itemsResult?.total || 0,
  };
}
