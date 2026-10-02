fn unit_name_matches(unit: &str, configured: Option<&str>) -> bool {
    configured.is_some_and(|name| unit.trim().eq_ignore_ascii_case(name.trim()))
}

pub(crate) fn unit_quantity_in_large(
    quantity: f64,
    unit: &str,
    large_to_medium: f64,
    medium_to_small: f64,
    medium_unit: Option<&str>,
    small_unit: Option<&str>,
) -> f64 {
    let large_to_medium = large_to_medium.max(1.0);
    let medium_to_small = medium_to_small.max(1.0);
    let normalized = unit.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "medium" | "strip" | "شريط")
        || unit_name_matches(unit, medium_unit)
    {
        quantity / large_to_medium
    } else if matches!(normalized.as_str(), "small" | "unit" | "pill")
        || unit_name_matches(unit, small_unit)
    {
        quantity / (large_to_medium * medium_to_small)
    } else {
        quantity
    }
}

pub(crate) fn large_quantity_in_unit(
    large_quantity: f64,
    unit: &str,
    large_to_medium: f64,
    medium_to_small: f64,
    medium_unit: Option<&str>,
    small_unit: Option<&str>,
) -> f64 {
    let large_to_medium = large_to_medium.max(1.0);
    let medium_to_small = medium_to_small.max(1.0);
    let normalized = unit.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "medium" | "strip" | "شريط")
        || unit_name_matches(unit, medium_unit)
    {
        large_quantity * large_to_medium
    } else if matches!(normalized.as_str(), "small" | "unit" | "pill")
        || unit_name_matches(unit, small_unit)
    {
        large_quantity * large_to_medium * medium_to_small
    } else {
        large_quantity
    }
}

pub(crate) fn sale_stock_qty(
    quantity: f64,
    unit: &str,
    large_to_medium: f64,
    medium_to_small: f64,
    medium_unit: Option<&str>,
    small_unit: Option<&str>,
) -> f64 {
    unit_quantity_in_large(
        quantity,
        unit,
        large_to_medium,
        medium_to_small,
        medium_unit,
        small_unit,
    )
}

#[cfg(test)]
mod tests {
    use super::{large_quantity_in_unit, sale_stock_qty, unit_quantity_in_large};

    #[test]
    fn unit_conversion_round_trips_custom_names() {
        let large = unit_quantity_in_large(120.0, "Tablet", 12.0, 10.0, Some("Blister"), Some("tablet"));
        assert!((large - 1.0).abs() < 0.000_001);
        let tablets = large_quantity_in_unit(large, "Tablet", 12.0, 10.0, Some("Blister"), Some("tablet"));
        assert!((tablets - 120.0).abs() < 0.000_001);
        assert!((sale_stock_qty(12.0, "شريط", 12.0, 10.0, None, None) - 1.0).abs() < 0.000_001);
    }
}
