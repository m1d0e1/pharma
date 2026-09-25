import { dbGet, dbSelect } from '@/lib/db/tauri';

const HANDOVER_DETAILS_SQL = `
  SELECT
    s.id,
    s.user_id,
    s.start_time,
    s.end_time,
    s.status,
    CAST(COALESCE(s.starting_cash, 0) AS REAL) AS starting_cash,
    CAST(COALESCE(s.transfer_amount, 0) AS REAL) AS previous_transfers,
    COALESCE(u.full_name, u.username, s.user_id, 'غير معروف') AS user_name,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'cash' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = s.id
    ) AS cash_sales,
    (
      SELECT COALESCE(SUM(CASE WHEN si.payment_method = 'visa' THEN CAST(si.total_amount AS REAL) ELSE 0 END), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = s.id
    ) AS visa_sales,
    (
      SELECT COALESCE(SUM(
        CASE
          WHEN (si.remaining_amount IS NOT NULL AND CAST(si.remaining_amount AS REAL) > 0) THEN CAST(si.remaining_amount AS REAL)
          WHEN si.payment_method = 'credit' THEN MAX(CAST(si.total_amount AS REAL) - CAST(COALESCE(si.paid_amount, 0) AS REAL), 0)
          ELSE 0
        END
      ), 0)
      FROM sales_invoices si
      WHERE (si.status IS NULL OR si.status = '' OR si.status = 'completed' OR si.status = 'approved')
        AND si.shift_id = s.id
    ) AS credit_sales,
    (
      SELECT COALESCE(SUM(CAST(r.total_refund AS REAL)), 0)
      FROM returns r
      WHERE r.refund_method = 'cash'
        AND (r.status IS NULL OR r.status = '' OR r.status IN ('approved', 'completed'))
        AND r.shift_id = s.id
    ) AS returns,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('receipt', 'in') THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id
    ) AS receipts,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('disbursement', 'out') THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id
    ) AS disbursements,
    (
      SELECT COALESCE(SUM(CASE WHEN cm.type IN ('disbursement', 'out') AND cm.category = 'handover' THEN CAST(cm.amount AS REAL) ELSE 0 END), 0)
      FROM cash_movements cm
      WHERE cm.shift_id = s.id
    ) AS handover_movements
  FROM shifts s
  LEFT JOIN users u ON (CAST(u.id AS TEXT) = CAST(s.user_id AS TEXT) OR LOWER(u.username) = LOWER(s.user_id))
`;

export async function loadHandoverDetails(shiftId: string) {
  const row = await dbGet(`${HANDOVER_DETAILS_SQL} WHERE s.id = ?`, [shiftId]) as any;
  if (!row) throw new Error('الوردية غير موجودة');
  return calculateDrawer(row);
}

function calculateDrawer(row: any) {
  const startingCash = Number(row.starting_cash || 0);
  const cashSales = Number(row.cash_sales || 0);
  const visaSales = Number(row.visa_sales || 0);
  const creditSales = Number(row.credit_sales || 0);
  const returns = Number(row.returns || 0);
  const receipts = Number(row.receipts || 0);
  const disbursements = Number(row.disbursements || 0);
  const previousTransfers = Number(row.previous_transfers || 0);
  const handoverMovements = Number(row.handover_movements || 0);
  const transferredSoFar = Math.max(previousTransfers, handoverMovements);
  // If previous transfers were tracked on the shift but not yet reflected in disbursements:
  const unrecordedTransfers = Math.max(0, previousTransfers - handoverMovements);

  const data = {
    ...row,
    starting_cash: startingCash,
    cash_sales: cashSales,
    visa_sales: visaSales,
    credit_sales: creditSales,
    returns,
    receipts,
    disbursements,
    transferred_so_far: transferredSoFar,
  };

  return {
    ...data,
    expected_cash: data.starting_cash + data.cash_sales + data.receipts - data.disbursements - data.returns - unrecordedTransfers,
  };
}

/** Read only: a finance view must never open a shift or aggregate closed drawers. */
export async function getOpenDrawerSnapshot(pharmacyId: string) {
  // Select the open shift and all of its balances in one SQLite snapshot.
  const shifts = await dbSelect(`${HANDOVER_DETAILS_SQL}
    WHERE LOWER(COALESCE(s.status, '')) = 'open'
      AND COALESCE(NULLIF(TRIM(s.pharmacy_id), ''), 'local_default') = ?
    LIMIT 2
  `, [pharmacyId]);
  if (shifts.length > 1) throw new Error('توجد أكثر من وردية مفتوحة؛ راجع إدارة الورديات قبل حساب رصيد الدرج');
  if (!shifts.length) return { balance: 0, shiftId: null, details: [] };
  const drawer = calculateDrawer(shifts[0]);
  const components: [string, string, number][] = [
    ['opening', 'رصيد بداية الوردية', drawer.starting_cash],
    ['sales', 'مبيعات نقدية للوردية', drawer.cash_sales],
    ['receipts', 'توريدات واستلام نقدية للوردية', drawer.receipts],
    ['disbursements', 'مصروفات وصرف وتسليم نقدية للوردية', -drawer.disbursements],
    ['returns', 'مرتجعات نقدية للوردية', -drawer.returns],
    ['legacy-transfers', 'تسليمات سابقة غير مسجلة بحركات الصرف', -Math.max(0, Number(drawer.previous_transfers) - Number(drawer.handover_movements))],
  ];
  const details = components.filter(([, , amount]) => amount !== 0).map(([id, description, amount]) => ({
    id: `${drawer.id}:${id}`, description,
    amount: Math.abs(amount), type: amount >= 0 ? 'receipt' : 'disbursement',
    shift_id: drawer.id, date: drawer.start_time, created_at: drawer.start_time,
    user_name: null,
  }));
  return { balance: drawer.expected_cash, shiftId: drawer.id, details };
}
