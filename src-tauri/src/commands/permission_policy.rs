use serde_json::Value;

pub(crate) fn normalize_pharmacy_id(input: Option<&str>) -> String {
    input
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local_default")
        .to_string()
}

fn decoded_permissions(permissions: Option<&str>) -> Option<Value> {
    let raw_permissions = permissions?;
    let mut value = Value::String(raw_permissions.to_string());
    for _ in 0..3 {
        let Value::String(encoded) = &value else {
            break;
        };
        value = match serde_json::from_str(encoded) {
            Ok(decoded) => decoded,
            Err(_) => return None,
        };
    }
    Some(value)
}

pub(crate) fn user_has_permission(
    role: Option<&str>,
    permissions: Option<&str>,
    key: &str,
    legacy_pos: bool,
) -> bool {
    let normalized_role = role.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized_role == "owner" {
        return true;
    }
    let value = decoded_permissions(permissions);
    if let Some(Value::Array(keys)) = value.as_ref() {
        return keys.iter().any(|value| value.as_str() == Some(key));
    }
    let permission = value
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|permissions| permissions.get(key));
    match permission {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64() == Some(1.0),
        Some(Value::String(value)) => {
            matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1")
        }
        _ => {
            permissions.is_none()
                && legacy_pos
                && key == "can_access_pos"
                && matches!(normalized_role.as_str(), "admin" | "pharmacist" | "cashier")
        }
    }
}

pub(crate) fn user_permission_number(
    role: Option<&str>,
    permissions: Option<&str>,
    key: &str,
    fallback: f64,
) -> f64 {
    if role.is_some_and(|role| role.trim().eq_ignore_ascii_case("owner")) {
        return 100.0;
    }
    decoded_permissions(permissions)
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|permissions| permissions.get(key))
        .and_then(|value| match value {
            Value::Number(number) => number.as_f64(),
            Value::String(number) => number.parse::<f64>().ok(),
            _ => None,
        })
        .unwrap_or(fallback)
}

pub(crate) fn user_can_view_purchases(role: Option<&str>, permissions: Option<&str>) -> bool {
    user_has_permission(role, permissions, "can_view_purchases", false)
}

#[cfg(test)]
mod tests {
    use super::{normalize_pharmacy_id, user_can_view_purchases, user_has_permission, user_permission_number};

    #[test]
    fn permission_policy_preserves_legacy_and_explicit_denial_rules() {
        assert_eq!(normalize_pharmacy_id(None), "local_default");
        assert!(user_has_permission(Some("owner"), Some("{}"), "can_access_pos", true));
        assert!(user_has_permission(Some("pharmacist"), None, "can_access_pos", true));
        assert!(!user_has_permission(Some("pharmacist"), Some(r#"{"can_access_pos":false}"#), "can_access_pos", true));
        assert!(user_can_view_purchases(Some("admin"), Some(r#"{"can_view_purchases":true}"#)));
        assert_eq!(user_permission_number(Some("owner"), None, "max_invoice_discount_percent", 0.0), 100.0);
    }
}
