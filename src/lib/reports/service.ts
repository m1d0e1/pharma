import { z } from 'zod';
import { getDatabase, get, query } from '../db/client';
import { getPharmacyInvoices, getSalesStatistics, getTopSellingDrugs } from '../pos/checkout';
import { getInventoryStatistics, getInventoryValueByCategory } from '../inventory/service';

// Report date range schema
export const DateRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export type DateRange = z.infer<typeof DateRangeSchema>;

/**
 * Get sales report
 * @param pharmacyId - Pharmacy ID
 * @param dateRange - Date range
 * @returns Sales report
 */
export function getSalesReport(
  pharmacyId: string,
  dateRange?: DateRange
): {
  summary: {
    totalSales: number;
    totalRevenue: number;
    averageTransaction: number;
    transactionCount: number;
  };
  byDay: Array<{
    date: string;
    sales: number;
    revenue: number;
  }>;
  byPaymentMethod: Array<{
    paymentMethod: string;
    count: number;
    revenue: number;
  }>;
  topSellingDrugs: Array<{
    drugId: number;
    drugName: string;
    drugNameAr: string;
    totalQuantity: number;
    totalRevenue: number;
    transactionCount: number;
  }>;
} {
  const stats = getSalesStatistics(pharmacyId, dateRange);

  // Sales by day
  const byDay = query<any>(
    `SELECT
      DATE(created_at) as date,
      COUNT(*) as sales,
      COALESCE(SUM(total_amount), 0) as revenue
     FROM sales_invoices
     WHERE pharmacy_id = ?
     ${dateRange?.startDate ? `AND created_at >= ?` : ''}
     ${dateRange?.endDate ? `AND created_at <= ?` : ''}
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // Sales by payment method
  const byPaymentMethod = query<any>(
    `SELECT
      COALESCE(payment_method, 'Cash') as payment_method,
      COUNT(*) as count,
      COALESCE(SUM(total_amount), 0) as revenue
     FROM sales_invoices
     WHERE pharmacy_id = ?
     ${dateRange?.startDate ? `AND created_at >= ?` : ''}
     ${dateRange?.endDate ? `AND created_at <= ?` : ''}
     GROUP BY payment_method
     ORDER BY revenue DESC`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // Top selling drugs
  const topSellingDrugs = getTopSellingDrugs(pharmacyId, {
    limit: 10,
    ...dateRange,
  });

  return {
    summary: stats,
    byDay,
    byPaymentMethod,
    topSellingDrugs,
  };
}

/**
 * Get inventory report
 * @param pharmacyId - Pharmacy ID
 * @param dateRange - Date range (optional)
 * @returns Inventory report
 */
export function getInventoryReport(
  pharmacyId: string,
  dateRange?: DateRange
): {
  summary: {
    totalItems: number;
    totalQuantity: number;
    totalValue: number;
    lowStockCount: number;
    expiringSoonCount: number;
    expiredCount: number;
  };
  byCategory: Array<{
    category: string;
    totalValue: number;
    itemCount: number;
  }>;
  lowStockItems: Array<{
    inventoryId: string;
    drugName: string;
    drugNameAr: string;
    currentQuantity: number;
    minStockLevel: number;
  }>;
  expiringItems: Array<{
    inventoryId: string;
    drugName: string;
    drugNameAr: string;
    expiryDate: string;
    daysUntilExpiry: number;
    quantity: number;
  }>;
  expiredItems: Array<{
    inventoryId: string;
    drugName: string;
    drugNameAr: string;
    expiryDate: string;
    quantity: number;
    value: number;
  }>;
} {
  const summary = getInventoryStatistics(pharmacyId);
  const byCategory = getInventoryValueByCategory(pharmacyId);

  // Low stock items
  const lowStockItems = query<any>(
    `SELECT i.id as inventory_id, md.name_en as drug_name, md.name_ar as drug_name_ar, i.quantity, i.min_stock_level
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ? AND i.quantity <= i.min_stock_level
     ORDER BY i.quantity ASC`,
    [pharmacyId]
  );

  // Expiring items
  const expiringItems = query<any>(
    `SELECT
      i.id as inventory_id,
      md.name_en as drug_name,
      md.name_ar as drug_name_ar,
      i.expiry_date,
      CAST((julianday(i.expiry_date) - julianday('now')) AS INTEGER) as days_until_expiry,
      i.quantity
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ?
     AND i.expiry_date BETWEEN date('now') AND date('now', '+30 days')
     ORDER BY i.expiry_date ASC`,
    [pharmacyId]
  );

  // Expired items
  const expiredItems = query<any>(
    `SELECT
      i.id as inventory_id,
      md.name_en as drug_name,
      md.name_ar as drug_name_ar,
      i.expiry_date,
      i.quantity,
      i.quantity * i.unit_price as value
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ? AND i.expiry_date < date('now')
     ORDER BY i.expiry_date DESC`,
    [pharmacyId]
  );

  return {
    summary,
    byCategory,
    lowStockItems,
    expiringItems,
    expiredItems,
  };
}

/**
 * Get staff performance report
 * @param pharmacyId - Pharmacy ID
 * @param dateRange - Date range
 * @returns Staff performance report
 */
export function getStaffPerformanceReport(
  pharmacyId: string,
  dateRange?: DateRange
): {
  byStaff: Array<{
    userId: string;
    username: string;
    fullName: string;
    role: string;
    totalTransactions: number;
    totalRevenue: number;
    averageTransaction: number;
    totalShifts: number;
  }>;
  topPerformers: Array<{
    userId: string;
    username: string;
    fullName: string;
    totalRevenue: number;
    rank: number;
  }>;
} {
  // Staff performance
  const byStaff = query<any>(
    `SELECT
      u.id as user_id,
      u.username,
      u.full_name,
      u.role,
      COUNT(si.id) as total_transactions,
      COALESCE(SUM(si.total_amount), 0) as total_revenue,
      CASE
        WHEN COUNT(si.id) > 0 THEN SUM(si.total_amount) / COUNT(si.id)
        ELSE 0
      END as average_transaction,
      (SELECT COUNT(*) FROM shift_registers sr WHERE sr.user_id = u.id) as total_shifts
     FROM users u
     LEFT JOIN sales_invoices si ON u.id = si.user_id
     WHERE u.pharmacy_id = ?
     ${dateRange?.startDate ? `AND (si.created_at IS NULL OR si.created_at >= ?)` : ''}
     ${dateRange?.endDate ? `AND (si.created_at IS NULL OR si.created_at <= ?)` : ''}
     GROUP BY u.id, u.username, u.full_name, u.role
     ORDER BY total_revenue DESC`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // Top performers
  const topPerformers = byStaff
    .filter((staff) => staff.total_transactions > 0)
    .map((staff, index) => ({
      userId: staff.user_id,
      username: staff.username,
      fullName: staff.full_name,
      totalRevenue: staff.total_revenue,
      rank: index + 1,
    }))
    .slice(0, 5);

  return {
    byStaff,
    topPerformers,
  };
}

/**
 * Get patient report
 * @param pharmacyId - Pharmacy ID
 * @param dateRange - Date range
 * @returns Patient report
 */
export function getPatientReport(
  pharmacyId: string,
  dateRange?: DateRange
): {
  summary: {
    totalPatients: number;
    activePatients: number;
    newPatients: number;
  };
  topPatients: Array<{
    patientId: string;
    fullName: string;
    phone: string;
    totalPurchases: number;
    totalSpent: number;
    lastPurchase: string;
  }>;
  byMonth: Array<{
    month: string;
    newPatients: number;
  }>;
} {
  // Summary
  const totalPatients = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM patients WHERE pharmacy_id = ?`,
    [pharmacyId]
  );

  const activePatients = get<{ count: number }>(
    `SELECT COUNT(DISTINCT patient_id) as count
     FROM sales_invoices
     WHERE pharmacy_id = ? AND patient_id IS NOT NULL
     ${dateRange?.startDate ? `AND created_at >= ?` : ''}
     ${dateRange?.endDate ? `AND created_at <= ?` : ''}`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  const newPatients = get<{ count: number }>(
    `SELECT COUNT(*) as count FROM patients
     WHERE pharmacy_id = ?
     ${dateRange?.startDate ? `AND created_at >= ?` : ''}
     ${dateRange?.endDate ? `AND created_at <= ?` : ''}`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // Top patients
  const topPatients = query<any>(
    `SELECT
      p.id as patient_id,
      p.full_name,
      p.phone,
      COUNT(si.id) as total_purchases,
      COALESCE(SUM(si.total_amount), 0) as total_spent,
      MAX(si.created_at) as last_purchase
     FROM patients p
     JOIN sales_invoices si ON p.id = si.patient_id
     WHERE p.pharmacy_id = ?
     ${dateRange?.startDate ? `AND si.created_at >= ?` : ''}
     ${dateRange?.endDate ? `AND si.created_at <= ?` : ''}
     GROUP BY p.id, p.full_name, p.phone
     ORDER BY total_spent DESC
     LIMIT 10`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // New patients by month
  const byMonth = query<any>(
    `SELECT
      strftime('%Y-%m', created_at) as month,
      COUNT(*) as new_patients
     FROM patients
     WHERE pharmacy_id = ?
     ${dateRange?.startDate ? `AND created_at >= ?` : ''}
     ${dateRange?.endDate ? `AND created_at <= ?` : ''}
     GROUP BY month
     ORDER BY month DESC`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  return {
    summary: {
      totalPatients: totalPatients?.count || 0,
      activePatients: activePatients?.count || 0,
      newPatients: newPatients?.count || 0,
    },
    topPatients,
    byMonth,
  };
}

/**
 * Get shift report
 * @param pharmacyId - Pharmacy ID
 * @param dateRange - Date range
 * @returns Shift report
 */
export function getShiftReport(
  pharmacyId: string,
  dateRange?: DateRange
): {
  summary: {
    totalShifts: number;
    openShifts: number;
    closedShifts: number;
    discrepancyShifts: number;
  };
  byStaff: Array<{
    userId: string;
    username: string;
    fullName: string;
    totalShifts: number;
    totalCashHandled: number;
    averageCash: number;
  }>;
  recentShifts: Array<{
    shiftId: string;
    userId: string;
    username: string;
    fullName: string;
    startTime: string;
    endTime: string | null;
    status: string;
    startingCash: number;
    endingCash: number | null;
  }>;
} {
  // Summary
  const summary = get<any>(
    `SELECT
      COUNT(*) as total_shifts,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_shifts,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_shifts,
      SUM(CASE WHEN status = 'discrepancy' THEN 1 ELSE 0 END) as discrepancy_shifts
     FROM shift_registers
     WHERE pharmacy_id = ?
     ${dateRange?.startDate ? `AND shift_start >= ?` : ''}
     ${dateRange?.endDate ? `AND shift_start <= ?` : ''}`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // By staff
  const byStaff = query<any>(
    `SELECT
      u.id as user_id,
      u.username,
      u.full_name,
      COUNT(sr.id) as total_shifts,
      COALESCE(SUM(sr.ending_cash_amount), 0) as total_cash_handled,
      CASE
        WHEN COUNT(sr.id) > 0 THEN COALESCE(SUM(sr.ending_cash_amount), 0) / COUNT(sr.id)
        ELSE 0
      END as average_cash
     FROM users u
     LEFT JOIN shift_registers sr ON u.id = sr.user_id
     WHERE u.pharmacy_id = ?
     ${dateRange?.startDate ? `AND (sr.shift_start IS NULL OR sr.shift_start >= ?)` : ''}
     ${dateRange?.endDate ? `AND (sr.shift_start IS NULL OR sr.shift_start <= ?)` : ''}
     GROUP BY u.id, u.username, u.full_name
     ORDER BY total_shifts DESC`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  // Recent shifts
  const recentShifts = query<any>(
    `SELECT
      sr.id as shift_id,
      sr.user_id,
      u.username,
      u.full_name,
      sr.shift_start as start_time,
      sr.shift_end as end_time,
      sr.status,
      sr.starting_cash_amount as starting_cash,
      sr.ending_cash_amount as ending_cash
     FROM shift_registers sr
     JOIN users u ON sr.user_id = u.id
     WHERE sr.pharmacy_id = ?
     ${dateRange?.startDate ? `AND sr.shift_start >= ?` : ''}
     ${dateRange?.endDate ? `AND sr.shift_start <= ?` : ''}
     ORDER BY sr.shift_start DESC
     LIMIT 20`,
    dateRange?.startDate && dateRange?.endDate
      ? [pharmacyId, dateRange.startDate, dateRange.endDate]
      : dateRange?.startDate
      ? [pharmacyId, dateRange.startDate]
      : dateRange?.endDate
      ? [pharmacyId, dateRange.endDate]
      : [pharmacyId]
  );

  return {
    summary: summary || {
      total_shifts: 0,
      open_shifts: 0,
      closed_shifts: 0,
      discrepancy_shifts: 0,
    },
    byStaff,
    recentShifts,
  };
}

/**
 * Get comprehensive dashboard report
 * @param pharmacyId - Pharmacy ID
 * @param dateRange - Date range
 * @returns Dashboard report
 */
export function getDashboardReport(
  pharmacyId: string,
  dateRange?: DateRange
): {
  sales: ReturnType<typeof getSalesReport>;
  inventory: ReturnType<typeof getInventoryReport>;
  staff: ReturnType<typeof getStaffPerformanceReport>;
  patients: ReturnType<typeof getPatientReport>;
  shifts: ReturnType<typeof getShiftReport>;
} {
  return {
    sales: getSalesReport(pharmacyId, dateRange),
    inventory: getInventoryReport(pharmacyId, dateRange),
    staff: getStaffPerformanceReport(pharmacyId, dateRange),
    patients: getPatientReport(pharmacyId, dateRange),
    shifts: getShiftReport(pharmacyId, dateRange),
  };
}
