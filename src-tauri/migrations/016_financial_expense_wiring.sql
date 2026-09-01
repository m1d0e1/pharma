-- Backfill cash expenses that were recorded before the cash and expense screens were linked.
INSERT OR IGNORE INTO expenses (id, user_id, category, amount, description, date, created_at)
SELECT
  'cash-movement-' || cm.id,
  cm.user_id,
  CASE
    WHEN cm.category = 'operating_expenses'
      THEN COALESCE(NULLIF(TRIM(cm.sub_category), ''), 'operating_expenses')
    ELSE cm.category
  END,
  cm.amount,
  COALESCE(cm.notes, cm.target_name),
  COALESCE(NULLIF(cm.date, ''), date(cm.created_at), date('now', 'localtime')),
  cm.created_at
FROM cash_movements cm
WHERE cm.type = 'disbursement'
  AND cm.category IN (
    'operating_expenses', 'salaries', 'rent', 'electricity',
    'water', 'internet', 'transport', 'supplies'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM expenses e
    WHERE e.user_id = cm.user_id
      AND date(e.date) = date(COALESCE(NULLIF(cm.date, ''), cm.created_at))
      AND ABS(CAST(e.amount AS REAL) - CAST(cm.amount AS REAL)) < 0.005
      AND LOWER(TRIM(e.category)) = LOWER(TRIM(
        CASE
          WHEN cm.category = 'operating_expenses'
            THEN COALESCE(NULLIF(TRIM(cm.sub_category), ''), 'operating_expenses')
          ELSE cm.category
        END
      ))
      AND COALESCE(TRIM(e.description), '') = COALESCE(TRIM(cm.notes), TRIM(cm.target_name), '')
  );
