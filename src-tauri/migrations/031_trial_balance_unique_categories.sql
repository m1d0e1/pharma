-- Forward-only repair for pre-UNIQUE trial balance settings tables.
-- Historical migrations 001 and 024 may reinsert default rows after the
-- native startup preparer deduplicates a ledgerless legacy database.
--
-- Never guess among conflicting custom mappings. Remove only exact duplicates
-- after restoring the same 14 policy-owned account codes used by schema.rs.
-- A remaining category collision makes the UNIQUE index fail transactionally,
-- preserving that installation for explicit review rather than losing data.

CREATE TEMP TABLE upgrade_031_required_accounts (
  category TEXT PRIMARY KEY,
  code TEXT NOT NULL
);

INSERT INTO upgrade_031_required_accounts(category, code) VALUES
  ('cash_drawer', '1.1.1'),
  ('accounts_payable', '2.1'),
  ('accounts_receivable', '1.1.2'),
  ('sales_revenue', '3.1'),
  ('inventory_asset', '1.1.3'),
  ('cogs_expense', '4.1'),
  ('bank_clearing', '1.1.4'),
  ('patient_wallet_liability', '2.2'),
  ('customer_adjustments', '4.2'),
  ('opening_balance_equity', '3.9'),
  ('other_cash_income', '3.2'),
  ('supplier_cash_adjustments', '3.3'),
  ('owner_drawings', '3.8'),
  ('general_operating_expenses', '4.4');

CREATE TEMP TABLE upgrade_031_account_guard (
  valid INTEGER NOT NULL CHECK(valid = 1)
);

INSERT INTO upgrade_031_account_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM upgrade_031_required_accounts r
  WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.code = r.code)
) THEN 1 ELSE 0 END;

UPDATE trial_balance_settings
SET account_id = (
  SELECT a.id
  FROM accounts a
  JOIN upgrade_031_required_accounts r ON a.code = r.code
  WHERE r.category = trial_balance_settings.category
  ORDER BY a.id
  LIMIT 1
)
WHERE category IN (SELECT category FROM upgrade_031_required_accounts);

-- Early legacy releases left the target type NULL for built-in accounting
-- categories. Those entries mean the same account mapping as later 'account'
-- seeds. Normalize only empty types for these 14 policy-owned categories;
-- never rewrite a non-empty custom type or custom category.
UPDATE trial_balance_settings
SET target_type = 'account'
WHERE category IN (SELECT category FROM upgrade_031_required_accounts)
  AND (target_type IS NULL OR TRIM(target_type) = '');

DELETE FROM trial_balance_settings
WHERE EXISTS (
  SELECT 1
  FROM trial_balance_settings newer
  WHERE newer.category = trial_balance_settings.category
    AND newer.target_type IS trial_balance_settings.target_type
    AND newer.target_id IS trial_balance_settings.target_id
    AND newer.target_name IS trial_balance_settings.target_name
    AND newer.account_id IS trial_balance_settings.account_id
    AND newer.id > trial_balance_settings.id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_balance_settings_category_unique
ON trial_balance_settings(category);

DROP TABLE upgrade_031_account_guard;
DROP TABLE upgrade_031_required_accounts;
