
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isTauri } from '@/lib/env';

type SalesReportFilters = {
  startDate?: string;
  endDate?: string;
  pharmacyId?: string;
  userId?: string;
  patientId?: string;
  paymentMethod?: string;
  invoiceNumber?: string;
  isReturn?: boolean;
};

const completedSalesStatuses = new Set(['', 'completed', 'approved', 'delivered']);

function verifiedTenant(user: any): string {
  const pharmacyId = typeof user?.pharmacy_id === 'string' ? user.pharmacy_id.trim() : '';
  if (!pharmacyId || pharmacyId === 'local_default') {
    throw new Error('Legacy sales ownership requires independent tenant verification');
  }
  return pharmacyId;
}

function validCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Native SQLite DATE(created_at,'localtime') interprets naive SQL timestamps
// as UTC, then applies the local timezone. Respect the same calendar buckets.
function localInvoiceDay(value: string): string {
  const normalized = value.trim().replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ?
    normalized : normalized + 'Z');
  if (Number.isNaN(date.getTime())) throw new Error('Invalid native invoice timestamp');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

/** Native invoice listing has no trusted patient/staff names. The full tenant
 * invoice index also proves that every immutable return references an owned,
 * completed sale, even when its invoice date falls outside the report window. */
async function nativeSalesInvoices(filters: SalesReportFilters, pharmacyId: string): Promise<{
  filtered: any[]; byId: Map<string, any>;
}> {
  const { invoke } = await import('@tauri-apps/api/core');
  const all: any[] = [];
  const byId = new Map<string, any>();
  const pageSize = 200;
  for (let offset = 0; offset <= 50_000; offset += pageSize) {
    const page = await invoke<any[]>('db_read_scoped', {
      queryId: 'sales.invoices', recordId: null, search: null,
      drugId: null, limit: pageSize, offset,
    });
    if (!Array.isArray(page) || page.length > pageSize) {
      throw new Error('Invalid native invoice response page');
    }
    for (const invoice of page) {
      if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice) ||
          typeof invoice.id !== 'string' || !invoice.id ||
          invoice.pharmacy_id !== pharmacyId ||
          typeof invoice.created_at !== 'string' ||
          typeof invoice.total_amount !== 'number' ||
          !Number.isFinite(invoice.total_amount) ||
          invoice.total_amount < 0 ||
          (invoice.discount_amount != null &&
            (typeof invoice.discount_amount !== 'number' || !Number.isFinite(invoice.discount_amount) ||
              invoice.discount_amount < 0)) ||
          byId.has(invoice.id)) {
        throw new Error('Native invoice ownership or financial projection invalid');
      }
      byId.set(invoice.id, invoice);
      if (!completedSalesStatuses.has(invoice.status || '')) continue;
      const date = localInvoiceDay(invoice.created_at);
      if ((filters.startDate && date < filters.startDate) ||
          (filters.endDate && date > filters.endDate) ||
          (filters.userId && String(invoice.user_id) !== filters.userId) ||
          (filters.patientId && String(invoice.patient_id) !== filters.patientId) ||
          (filters.paymentMethod && filters.paymentMethod !== 'all' &&
            invoice.payment_method !== filters.paymentMethod) ||
          (filters.invoiceNumber && !invoice.id.includes(filters.invoiceNumber))) continue;
      // Never consume synthesized patient/staff names or refund values from
      // unverified response fields. No trusted native joins exist here.
      all.push({ ...invoice, patient_name: null, staff_name: null, refunded_amount: null });
    }
    if (page.length < pageSize) {
      return { filtered: all.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) ||
        b.id.localeCompare(a.id)), byId };
    }
  }
  throw new Error('Sales reporting exceeds native pagination capacity');
}

/** returns.list is a fixed native CTE verifying receipt, posted journals,
 * original sale provenance and all tenant-owned return rows. Never let a
 * partial/denied response silently become a zero refund. */
async function applyVerifiedNativeRefunds(
  filtered: any[], byId: Map<string, any>, pharmacyId: string,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const seen = new Set<string>();
  const refunded = new Map<string, number>();
  const pageSize = 200;
  for (let offset = 0; offset <= 50_000; offset += pageSize) {
    const page = await invoke<any[]>('db_read_scoped', {
      queryId: 'returns.list', recordId: null, search: null,
      drugId: null, limit: pageSize, offset,
    });
    if (!Array.isArray(page) || page.length > pageSize) {
      throw new Error('Native verified return page is missing or invalid');
    }
    for (const row of page) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          typeof row.id !== 'string' || !row.id || seen.has(row.id) ||
          typeof row.invoice_id !== 'string' || !row.invoice_id ||
          row.pharmacy_id !== pharmacyId ||
          !['approved', 'completed'].includes(String(row.status || '').toLowerCase()) ||
          typeof row.user_id !== 'string' || !row.user_id ||
          typeof row.refund_method !== 'string' || !row.refund_method ||
          !Number.isSafeInteger(row.item_count) || row.item_count <= 0 ||
          typeof row.total_refund !== 'number' || !Number.isFinite(row.total_refund) ||
          row.total_refund < 0 ||
          typeof row.invoice_total !== 'number' || !Number.isFinite(row.invoice_total) ||
          row.invoice_total < 0 ||
          typeof row.invoice_date !== 'string' ||
          typeof row.created_at !== 'string') {
        throw new Error('Invalid verified native return receipt');
      }
      // Strictly validate both timestamps; native sale date and return date
      // need not share a period, because this is invoice-date reporting.
      localInvoiceDay(row.invoice_date);
      localInvoiceDay(row.created_at);
      const sale = byId.get(row.invoice_id);
      if (!sale || sale.status !== 'completed' ||
          row.invoice_date !== sale.created_at ||
          Math.abs(row.invoice_total - sale.total_amount) > 0.000001) {
        throw new Error('Verified return has missing or inconsistent original invoice');
      }
      seen.add(row.id);
      const sum = (refunded.get(sale.id) || 0) + row.total_refund;
      if (!Number.isFinite(sum) || sum - sale.total_amount > 0.000001) {
        throw new Error('Returns exceed their originating invoice total');
      }
      refunded.set(sale.id, sum);
    }
    if (page.length < pageSize) {
      for (const sale of filtered) sale.refunded_amount = refunded.get(sale.id) || 0;
      return;
    }
  }
  throw new Error('Native returns report exceeds verified pagination capacity');
}

export async function getSalesReportsAction(filters: SalesReportFilters) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = verifiedTenant(user);
    if ((filters.startDate && !validCalendarDay(filters.startDate)) ||
        (filters.endDate && !validCalendarDay(filters.endDate)) ||
        (filters.startDate && filters.endDate && filters.startDate > filters.endDate) ||
        (filters.isReturn === true)) {
      throw new Error('Invalid sales report filters');
    }
    if (isTauri) {
      const { filtered, byId } = await nativeSalesInvoices(filters, pharmacyId);
      const returnsVerified = hasUserPermissionSync(user, 'can_view_returns');
      if (returnsVerified) await applyVerifiedNativeRefunds(filtered, byId, pharmacyId);
      return { success: true, data: filtered, returnsVerified };
    }

    let query = `
      SELECT 
        si.*, 
        COALESCE(si.user_id, 'غير محدد') as staff_name,
        NULL as patient_name,
        COALESCE((
          SELECT SUM(r.total_refund)
          FROM returns r
          WHERE r.invoice_id = si.id
            AND r.pharmacy_id = si.pharmacy_id
            AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        ), 0) AS refunded_amount
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status IN ('completed', 'approved', 'delivered'))
    `;
    const params: any[] = [];
    query += ` AND si.pharmacy_id = ?`;
    params.push(pharmacyId);

    if (filters.startDate) {
      query += ` AND date(si.created_at, 'localtime') >= ?`;
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      query += ` AND date(si.created_at, 'localtime') <= ?`;
      params.push(filters.endDate);
    }
    if (filters.userId) {
      query += ` AND si.user_id = ?`;
      params.push(filters.userId);
    }
    if (filters.patientId) {
      query += ` AND si.patient_id = ?`;
      params.push(filters.patientId);
    }
    if (filters.paymentMethod && filters.paymentMethod !== 'all') {
      query += ` AND si.payment_method = ?`;
      params.push(filters.paymentMethod);
    }
    if (filters.invoiceNumber) {
      query += ` AND si.id LIKE ?`;
      params.push(`%${filters.invoiceNumber}%`);
    }

    query += ` ORDER BY si.created_at DESC`;

    const invoices = await db.prepare(query).all(...params) as any[];

    // If we need items for the first invoice or a specific one, we can fetch them separately
    // But for the main report list, we usually show summary first.

    return { success: true, data: invoices };
  } catch (error) {
    console.error('Sales report error:', error);
    return { success: false, error: 'فشل جلب تقرير المبيعات' };
  }
}

export async function getInvoiceDetailsAction(invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    const pharmacyId = verifiedTenant(user);
    if (typeof invoiceId !== 'string' || !invoiceId.trim() || invoiceId.length > 128 ||
        invoiceId.includes('\0')) throw new Error('Invalid invoice identifier');
    // The typed native sales.items reader exposes item IDs and amounts but not
    // trusted drug names; a fabricated receipt is worse than an explicit error.
    // A future fixed enriched invoice-items reader can safely replace this.
    if (isTauri) {
      return { success: false, error: 'تفاصيل الفاتورة غير متاحة حتى التحقق من بيانات الأصناف' };
    }
    const pharmacyClause = ` AND inv.pharmacy_id = ?`;
    const items = await db.prepare(`
      SELECT 
        si.*, 
        COALESCE(
          NULLIF(NULLIF(md.trade_name, ''), 'Drug ' || md.id),
          NULLIF(NULLIF(md.trade_name_en, ''), 'Drug ' || md.id),
          md.trade_name,
          md.trade_name_en,
          'صنف #' || si.drug_id
        ) AS trade_name,
        COALESCE(
          NULLIF(NULLIF(md.trade_name_en, ''), 'Drug ' || md.id),
          NULLIF(NULLIF(md.trade_name, ''), 'Drug ' || md.id),
          md.trade_name_en,
          md.trade_name,
          'صنف #' || si.drug_id
        ) AS trade_name_en,
        md.active_ingredient,
        md.barcode
      FROM sales_items si
      JOIN sales_invoices inv ON inv.id = si.invoice_id
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      WHERE si.invoice_id = ?${pharmacyClause}
    `).all(invoiceId, pharmacyId) as any[];

    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: 'فشل جلب تفاصيل الفاتورة' };
  }
}
