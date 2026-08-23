INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group)
VALUES ('4.3', 'عجز وزيادة الخزينة', 'Cash Shortage/Overage', 'expense', 0);

INSERT INTO trial_balance_settings (category, target_type, account_id)
SELECT 'cash_difference', 'account', id
FROM accounts
WHERE code = '4.3'
  AND NOT EXISTS (
    SELECT 1 FROM trial_balance_settings WHERE category = 'cash_difference'
  );
