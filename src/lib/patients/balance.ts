/**
 * Canonical accounts-receivable balance expression for a patient.
 *
 * Positive values are amounts owed to the pharmacy. Negative values are a
 * credit on the patient's account. Wallet funds are deliberately excluded:
 * they are prepaid funds, not accounts receivable.
 */
export function patientOutstandingBalanceExpression(patientAlias = 'p'): string {
  return `(
    COALESCE(CAST(${patientAlias}.opening_balance AS REAL), 0) +
    (
      SELECT COALESCE(SUM(CAST(si.total_amount AS REAL)), 0)
      FROM sales_invoices si
      WHERE si.patient_id = ${patientAlias}.id
        AND si.payment_method = 'credit'
        AND si.status = 'completed'
    ) -
    (
      SELECT COALESCE(SUM(CAST(r.total_refund AS REAL)), 0)
      FROM returns r
      JOIN sales_invoices rsi ON rsi.id = r.invoice_id
      WHERE rsi.patient_id = ${patientAlias}.id
        AND r.refund_method = 'patient_account'
        AND (r.status = 'approved' OR r.status = 'completed')
    ) +
    (
      SELECT COALESCE(SUM(
        CASE
          WHEN pt.type = 'payment' THEN -ABS(CAST(pt.amount AS REAL))
          WHEN pt.type = 'adjustment' THEN CAST(pt.amount AS REAL)
          ELSE 0
        END
      ), 0)
      FROM patient_transactions pt
      WHERE pt.patient_id = ${patientAlias}.id
    ) +
    (
      SELECT COALESCE(SUM(
        CASE
          WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL))
          WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL))
          ELSE 0
        END
      ), 0)
      FROM financial_notices fn
      WHERE fn.target_type = 'customer'
        AND fn.target_id = ${patientAlias}.id
        AND NOT EXISTS (
          SELECT 1
          FROM patient_transactions mirrored
          WHERE mirrored.patient_id = fn.target_id
            AND mirrored.type = 'adjustment'
            AND ABS(CAST(mirrored.amount AS REAL) - CASE
              WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL))
              WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL))
              ELSE 0
            END) < 0.000001
            AND COALESCE(mirrored.date, '') = COALESCE(fn.date, '')
            AND COALESCE(mirrored.user_id, '') = COALESCE(fn.user_id, '')
            AND COALESCE(mirrored.notes, '') = COALESCE(fn.reason, '')
        )
    )
  )`;
}

export function patientOutstandingBalanceQuery(): string {
  return `
    SELECT CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
    FROM patients p
    WHERE p.id = ?
  `;
}
