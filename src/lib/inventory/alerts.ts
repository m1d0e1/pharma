import { getDatabase, get, query } from '../db/client';
import {
  getLowStockItems,
  getExpiringItems,
  getExpiredItems,
  getInventoryStatistics,
} from './service';

// Alert types
export type AlertType = 'low_stock' | 'expiring_soon' | 'expired' | 'out_of_stock';

// Alert interface
export interface Alert {
  id: string;
  type: AlertType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details: any;
  createdAt: Date;
}

/**
 * Get all alerts for a pharmacy
 * @param pharmacyId - Pharmacy ID
 * @returns List of alerts
 */
export function getPharmacyAlerts(pharmacyId: string): Alert[] {
  const alerts: Alert[] = [];

  // Get low stock alerts
  const lowStockItems = getLowStockItems(pharmacyId);
  for (const item of lowStockItems) {
    const severity = item.quantity === 0 ? 'critical' : item.quantity <= item.minStockLevel / 2 ? 'high' : 'medium';
    alerts.push({
      id: `low_stock_${item.id}`,
      type: 'low_stock',
      severity,
      message: `Low stock: ${item.drugName} (${item.quantity} remaining)`,
      details: {
        inventoryId: item.id,
        drugName: item.drugName,
        drugNameAr: item.drugNameAr,
        currentQuantity: item.quantity,
        minStockLevel: item.minStockLevel,
        expiryDate: item.expiryDate,
      },
      createdAt: new Date(),
    });
  }

  // Get expiring soon alerts
  const expiringItems = getExpiringItems(pharmacyId, 30);
  for (const item of expiringItems) {
    const daysUntilExpiry = Math.ceil(
      (new Date(item.expiryDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
    );
    const severity = daysUntilExpiry <= 7 ? 'critical' : daysUntilExpiry <= 14 ? 'high' : 'medium';
    alerts.push({
      id: `expiring_${item.id}`,
      type: 'expiring_soon',
      severity,
      message: `Expiring soon: ${item.drugName} (${daysUntilExpiry} days)`,
      details: {
        inventoryId: item.id,
        drugName: item.drugName,
        drugNameAr: item.drugNameAr,
        expiryDate: item.expiryDate,
        daysUntilExpiry,
        quantity: item.quantity,
      },
      createdAt: new Date(),
    });
  }

  // Get expired alerts
  const expiredItems = getExpiredItems(pharmacyId);
  for (const item of expiredItems) {
    alerts.push({
      id: `expired_${item.id}`,
      type: 'expired',
      severity: 'critical',
      message: `Expired: ${item.drugName} (expired on ${item.expiryDate})`,
      details: {
        inventoryId: item.id,
        drugName: item.drugName,
        drugNameAr: item.drugNameAr,
        expiryDate: item.expiryDate,
        quantity: item.quantity,
      },
      createdAt: new Date(),
    });
  }

  // Sort by severity and date
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  alerts.sort((a, b) => {
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return alerts;
}

/**
 * Get alert summary
 * @param pharmacyId - Pharmacy ID
 * @returns Alert summary
 */
export function getAlertSummary(pharmacyId: string): {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  byType: Record<AlertType, number>;
} {
  const alerts = getPharmacyAlerts(pharmacyId);

  const summary = {
    total: alerts.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    byType: {
      low_stock: 0,
      expiring_soon: 0,
      expired: 0,
      out_of_stock: 0,
    },
  };

  for (const alert of alerts) {
    summary[alert.severity]++;
    summary.byType[alert.type]++;
  }

  return summary;
}

/**
 * Get critical alerts
 * @param pharmacyId - Pharmacy ID
 * @returns List of critical alerts
 */
export function getCriticalAlerts(pharmacyId: string): Alert[] {
  return getPharmacyAlerts(pharmacyId).filter((alert) => alert.severity === 'critical');
}

/**
 * Check if pharmacy has any critical alerts
 * @param pharmacyId - Pharmacy ID
 * @returns True if there are critical alerts
 */
export function hasCriticalAlerts(pharmacyId: string): boolean {
  return getCriticalAlerts(pharmacyId).length > 0;
}

/**
 * Get inventory health score
 * @param pharmacyId - Pharmacy ID
 * @returns Health score (0-100)
 */
export function getInventoryHealthScore(pharmacyId: string): {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  issues: string[];
} {
  const stats = getInventoryStatistics(pharmacyId);
  const alerts = getPharmacyAlerts(pharmacyId);

  const issues: string[] = [];
  let score = 100;

  // Deduct for expired items
  if (stats.expiredCount > 0) {
    score -= stats.expiredCount * 10;
    issues.push(`${stats.expiredCount} expired items`);
  }

  // Deduct for expiring soon items
  if (stats.expiringSoonCount > 0) {
    score -= stats.expiringSoonCount * 5;
    issues.push(`${stats.expiringSoonCount} items expiring soon`);
  }

  // Deduct for low stock items
  if (stats.lowStockCount > 0) {
    score -= stats.lowStockCount * 3;
    issues.push(`${stats.lowStockCount} items with low stock`);
  }

  // Ensure score is between 0 and 100
  score = Math.max(0, Math.min(100, score));

  // Determine grade
  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';

  return { score, grade, issues };
}

/**
 * Get restock recommendations
 * @param pharmacyId - Pharmacy ID
 * @returns List of items that need restocking
 */
export function getRestockRecommendations(pharmacyId: string): Array<{
  inventoryId: string;
  drugName: string;
  drugNameAr: string;
  currentQuantity: number;
  minStockLevel: number;
  recommendedQuantity: number;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}> {
  const lowStockItems = getLowStockItems(pharmacyId);

  return lowStockItems.map((item) => {
    const recommendedQuantity = item.minStockLevel * 2; // Recommend 2x min stock
    const priority = item.quantity === 0 ? 'high' : item.quantity <= item.minStockLevel / 2 ? 'medium' : 'low';

    return {
      inventoryId: item.id,
      drugName: item.drugName,
      drugNameAr: item.drugNameAr || '',
      currentQuantity: item.quantity,
      minStockLevel: item.minStockLevel,
      recommendedQuantity,
      reason: item.quantity === 0 ? 'Out of stock' : 'Below minimum stock level',
      priority,
    };
  });
}

/**
 * Get expiry report
 * @param pharmacyId - Pharmacy ID
 * @param months - Number of months to look ahead
 * @returns Expiry report
 */
export function getExpiryReport(
  pharmacyId: string,
  months: number = 12
): Array<{
  month: string;
  itemCount: number;
  totalValue: number;
  items: Array<{
    drugName: string;
    drugNameAr: string;
    expiryDate: string;
    quantity: number;
    value: number;
  }>;
}> {
  // Get start date (first day of current month)
  const start = new Date();
  start.setDate(1);
  const startStr = start.toISOString().split('T')[0];

  // Get end date (last day of the month after X months)
  const end = new Date();
  end.setMonth(end.getMonth() + months);
  end.setDate(0);
  const endStr = end.toISOString().split('T')[0];

  // Execute a single query for the entire date range
  const allItems = query<any>(
    `SELECT i.*, md.name_en as drug_name, md.name_ar as drug_name_ar
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     WHERE i.pharmacy_id = ?
     AND i.expiry_date >= ? AND i.expiry_date <= ?
     ORDER BY i.expiry_date ASC`,
    [pharmacyId, startStr, endStr]
  );

  const report: Array<{
    month: string;
    itemCount: number;
    totalValue: number;
    items: any[];
  }> = [];

  // Group items by month in memory
  for (let i = 0; i < months; i++) {
    const currentMonthDate = new Date();
    currentMonthDate.setMonth(currentMonthDate.getMonth() + i);
    
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth() + 1; // 1-indexed
    const yearMonthStr = `${year}-${String(month).padStart(2, '0')}`;

    // Filter items belonging to this month (prefix matching 'YYYY-MM')
    const monthItems = allItems.filter(
      (item) => item.expiry_date && item.expiry_date.startsWith(yearMonthStr)
    );

    if (monthItems.length > 0) {
      const totalValue = monthItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);

      report.push({
        month: currentMonthDate.toLocaleString('default', { month: 'long', year: 'numeric' }),
        itemCount: monthItems.length,
        totalValue,
        items: monthItems.map((item) => ({
          drugName: item.drug_name,
          drugNameAr: item.drug_name_ar,
          expiryDate: item.expiry_date, // Fixed: use expiry_date instead of undefined expiryDate
          quantity: item.quantity,
          value: item.quantity * item.unit_price,
        })),
      });
    }
  }

  return report;
}

/**
 * Get dead stock report (items not sold in X days)
 * @param pharmacyId - Pharmacy ID
 * @param days - Number of days to look back
 * @returns Dead stock report
 */
export function getDeadStockReport(
  pharmacyId: string,
  days: number = 90
): Array<{
  inventoryId: string;
  drugName: string;
  drugNameAr: string;
  quantity: number;
  value: number;
  lastSoldDate: string | null;
  daysSinceLastSale: number | null;
}> {
  return query<any>(
    `SELECT
      i.id as inventory_id,
      md.name_en as drug_name,
      md.name_ar as drug_name_ar,
      i.quantity,
      i.quantity * i.unit_price as value,
      MAX(si.created_at) as last_sold_date
     FROM inventory i
     JOIN master_drugs md ON i.drug_id = md.id
     LEFT JOIN sales_items si ON i.id = si.inventory_id
     WHERE i.pharmacy_id = ?
     GROUP BY i.id, md.name_en, md.name_ar, i.quantity, i.unit_price
     HAVING MAX(si.created_at) IS NULL OR MAX(si.created_at) < datetime('now', '-' || ? || ' days')
     ORDER BY value DESC`,
    [pharmacyId, days]
  ).map((item) => ({
    inventoryId: item.inventory_id,
    drugName: item.drug_name,
    drugNameAr: item.drug_name_ar,
    quantity: item.quantity,
    value: item.value,
    lastSoldDate: item.last_sold_date,
    daysSinceLastSale: item.last_sold_date
      ? Math.floor((new Date().getTime() - new Date(item.last_sold_date).getTime()) / (1000 * 60 * 60 * 24))
      : null,
  }));
}
