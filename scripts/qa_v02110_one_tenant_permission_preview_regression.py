"""Tests on invented staff identities; no real source data loaded."""
import unittest

from scripts.qa_v02110_one_tenant_permission_preview import (
    can_use, decoded_permissions, summarize_users,
)


class OriginalRoleSemanticsRegression(unittest.TestCase):
    def test_owner_grant_applies_only_to_active_account(self):
        report = summarize_users([
            ("owner", 1, None, "{}"),
            ("owner", 0, None, "{}"),
        ])
        self.assertEqual(report["historical_user_count"], 2)
        self.assertEqual(report["inactive_accounts_excluded_from_access"], 1)
        self.assertEqual(report["active_users_with_capability_if_correctly_enrolled"]["can_view_cogs"], 1)

    def test_tenant_unification_cannot_grant_permissions(self):
        report = summarize_users([
            ("pharmacist", 1, "local_default", '{"can_manage_inventory":false,"can_view_patients":true}'),
            ("cashier", 1, None, '{"can_access_pos":true,"can_view_patients":false}'),
        ])
        self.assertEqual(report["original_users_with_legacy_unscoped_literals"], 2)
        self.assertEqual(report["active_users_with_capability_if_correctly_enrolled"]["can_manage_inventory"], 0)
        self.assertEqual(report["active_users_with_capability_if_correctly_enrolled"]["can_view_patients"], 1)
        self.assertEqual(report["active_users_with_capability_if_correctly_enrolled"]["can_access_pos"], 1)
        self.assertFalse(report["tenant_scope_overrides_role_permissions"])

    def test_explicit_denial_overrides_legacy_pos_default(self):
        self.assertTrue(can_use("cashier", None, "can_access_pos"))
        self.assertFalse(can_use("cashier", '{"can_access_pos":false}', "can_access_pos"))
        self.assertFalse(can_use("admin", "{}", "can_access_pos"))
        self.assertFalse(can_use("cashier", "invalid", "can_access_pos"))

    def test_double_json_encoded_permissions_and_no_string_trust(self):
        self.assertEqual(decoded_permissions('"{\\"can_view_returns\\":true}"'),
                         {"can_view_returns": True})
        self.assertTrue(can_use("pharmacist", '["can_view_returns"]', "can_view_returns"))
        self.assertFalse(can_use("pharmacist", '["can_view_returns"]', "can_view_cogs"))

    def test_unknown_roles_and_numeric_values_are_not_broad_grants(self):
        self.assertFalse(can_use("guest", None, "can_access_pos"))
        self.assertTrue(can_use("pharmacist", '{"can_view_cogs":1}', "can_view_cogs"))
        self.assertFalse(can_use("pharmacist", '{"can_view_cogs":2}', "can_view_cogs"))


if __name__ == "__main__":
    unittest.main()
