-- Merge the old per-user permanent sessions into one pharmacy-wide open shift.
-- Transaction rows keep their own user_id, so staff accountability is preserved.
UPDATE shifts
SET starting_cash = (
  SELECT COALESCE(SUM(CAST(COALESCE(starting_cash, 0) AS REAL)), 0)
  FROM shifts
  WHERE LOWER(COALESCE(status, '')) = 'open'
)
WHERE id = (
  SELECT id FROM shifts
  WHERE LOWER(COALESCE(status, '')) = 'open'
  ORDER BY datetime(start_time) ASC, rowid ASC
  LIMIT 1
);

UPDATE sales_invoices
SET shift_id = (
  SELECT id FROM shifts
  WHERE LOWER(COALESCE(status, '')) = 'open'
  ORDER BY datetime(start_time) ASC, rowid ASC
  LIMIT 1
)
WHERE shift_id IN (
  SELECT id FROM shifts WHERE LOWER(COALESCE(status, '')) = 'open'
);

UPDATE returns
SET shift_id = (
  SELECT id FROM shifts
  WHERE LOWER(COALESCE(status, '')) = 'open'
  ORDER BY datetime(start_time) ASC, rowid ASC
  LIMIT 1
)
WHERE shift_id IN (
  SELECT id FROM shifts WHERE LOWER(COALESCE(status, '')) = 'open'
);

UPDATE cash_movements
SET shift_id = (
  SELECT id FROM shifts
  WHERE LOWER(COALESCE(status, '')) = 'open'
  ORDER BY datetime(start_time) ASC, rowid ASC
  LIMIT 1
)
WHERE shift_id IN (
  SELECT id FROM shifts WHERE LOWER(COALESCE(status, '')) = 'open'
);

UPDATE shifts
SET end_time = COALESCE(end_time, CURRENT_TIMESTAMP),
    ending_cash = 0,
    status = 'merged',
    notes = CASE
      WHEN notes IS NULL OR TRIM(notes) = '' THEN 'دُمجت في الوردية المشتركة'
      ELSE notes || ' | دُمجت في الوردية المشتركة'
    END
WHERE LOWER(COALESCE(status, '')) = 'open'
  AND id != (
    SELECT id FROM shifts
    WHERE LOWER(COALESCE(status, '')) = 'open'
    ORDER BY datetime(start_time) ASC, rowid ASC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_single_open
ON shifts(status)
WHERE LOWER(COALESCE(status, '')) = 'open';
