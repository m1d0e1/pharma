pub(crate) fn loyalty_points(total_amount: f64, loyalty_level: Option<&str>) -> i64 {
    if !total_amount.is_finite() || total_amount <= 0.0 {
        return 0;
    }

    let multiplier = match loyalty_level {
        Some("platinum") => 2.0,
        Some("gold") => 1.5,
        Some("silver") => 1.2,
        _ => 1.0,
    };
    (total_amount * multiplier).floor() as i64
}

pub(crate) fn loyalty_redemption_value(points: i64) -> f64 {
    ((points as f64 * 0.1) * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::{loyalty_points, loyalty_redemption_value};

    #[test]
    fn loyalty_points_follow_tier_policy() {
        assert_eq!(loyalty_points(33.0, None), 33);
        assert_eq!(loyalty_points(33.0, Some("silver")), 39);
        assert_eq!(loyalty_points(33.0, Some("gold")), 49);
        assert_eq!(loyalty_points(33.0, Some("platinum")), 66);
        assert_eq!(loyalty_points(f64::NAN, Some("gold")), 0);
    }

    #[test]
    fn redemption_value_is_rounded() {
        assert!((loyalty_redemption_value(123) - 12.3).abs() < 0.000_001);
    }
}
