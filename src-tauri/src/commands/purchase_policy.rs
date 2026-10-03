use std::collections::HashSet;

use super::purchase_dto::{PurchaseItem, PurchasePayload};

pub(crate) fn normalize_date_ymd(input: Option<&str>) -> Option<String> {
    let value = input?.trim();
    if value.is_empty() {
        return None;
    }
    let parts: Vec<&str> = value.split(&['/', '-'][..]).collect();
    if parts.len() == 3 && parts[0].len() == 4 {
        // YYYY/MM/DD or YYYY-MM-DD → always emit as YYYY-MM-DD
        return Some(format!("{}-{:0>2}-{:0>2}", parts[0], parts[1], parts[2]));
    }
    if parts.len() == 3 && parts[0].len() <= 2 && parts[2].len() == 4 {
        return Some(format!("{}-{:0>2}-{:0>2}", parts[2], parts[1], parts[0]));
    }
    if parts.len() == 2 && parts[0].len() <= 2 && parts[1].len() == 4 {
        return Some(format!("{}-{:0>2}-01", parts[1], parts[0]));
    }
    Some(value.to_string())
}

pub(crate) fn normalize_valid_date_ymd(input: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = input else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }

    let parts: Vec<&str> = value.split(&['/', '-'][..]).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(format!("Invalid calendar date '{value}'"));
    }

    let (year_text, month_text, day_text) = if parts.len() == 2
        && parts[0].len() <= 2
        && parts[1].len() == 4
    {
        (parts[1], parts[0], "1")
    } else if parts.len() == 3 && parts[0].len() == 4 {
        (parts[0], parts[1], parts[2])
    } else if parts.len() == 3 && parts[2].len() == 4 {
        (parts[2], parts[1], parts[0])
    } else {
        return Err(format!("Invalid calendar date '{value}'"));
    };
    if !year_text.chars().all(|c| c.is_ascii_digit())
        || !month_text.chars().all(|c| c.is_ascii_digit())
        || !day_text.chars().all(|c| c.is_ascii_digit())
    {
        return Err(format!("Invalid calendar date '{value}'"));
    }

    let year = year_text
        .parse::<i32>()
        .map_err(|_| format!("Invalid calendar date '{value}'"))?;
    let month = month_text
        .parse::<u32>()
        .map_err(|_| format!("Invalid calendar date '{value}'"))?;
    let day = day_text
        .parse::<u32>()
        .map_err(|_| format!("Invalid calendar date '{value}'"))?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year <= 0 || day == 0 || day > max_day {
        return Err(format!("Invalid calendar date '{value}'"));
    }

    Ok(Some(format!("{year:04}-{month:02}-{day:02}")))
}

/// Computes the gross line total for a purchase item.
///
/// CONVENTION: `item.cost_price` must be the net (post-discount) price.
/// `item.discount_percent` is stored for display and is NOT applied here.
///
/// Tax compounds intentionally: item tax is applied first, invoice-level
/// tax on top (e.g. excise then VAT). Both percentages combine
/// multiplicatively, not additively.
pub(crate) fn purchase_item_total(item: &PurchaseItem, invoice_tax_percent: f64) -> f64 {
    item.quantity
        * item.cost_price
        * (1.0 + item.tax_percent / 100.0)
        * (1.0 + invoice_tax_percent / 100.0)
}

// ponytail: one rule keeps purchased stock and its later return on the same net cost.
pub(crate) fn purchase_inventory_paid_factor(
    items_total: f64,
    expenses: f64,
    discount_value: f64,
    discount_percent: f64,
) -> f64 {
    if items_total <= f64::EPSILON {
        return 1.0;
    }
    let invoice_base = items_total + expenses;
    ((invoice_base - discount_value).max(0.0) / items_total)
        * (1.0 - discount_percent / 100.0)
}

pub(crate) fn validate_purchase_payload(payload: &PurchasePayload) -> Result<(f64, f64), String> {
    if payload.supplier_id <= 0 || payload.user_id.trim().is_empty() {
        return Err("Invalid purchase identity".into());
    }
    if !matches!(
        payload.status.as_deref().unwrap_or("completed"),
        "draft" | "completed"
    ) {
        return Err("Invalid purchase status".into());
    }
    if !matches!(
        payload.payment_method.as_deref().unwrap_or("credit"),
        "cash" | "credit" | "check"
    ) {
        return Err("Invalid purchase payment method".into());
    }
    if payload.status.as_deref() != Some("draft")
        && payload.payment_method.as_deref() == Some("check")
        && payload
            .check_number
            .as_deref()
            .map(str::trim)
            .filter(|number| !number.is_empty())
            .is_none()
    {
        return Err("Check number is required for check purchases".into());
    }
    if !payload.expenses.is_finite()
        || payload.expenses < 0.0
        || !payload.discount_value.is_finite()
        || payload.discount_value < 0.0
        || !payload.discount_percent.is_finite()
        || !(0.0..=100.0).contains(&payload.discount_percent)
        || !payload.tax_percent.is_finite()
        || !(0.0..=100.0).contains(&payload.tax_percent)
    {
        return Err("Invalid purchase totals".into());
    }
    validate_purchase_items(&payload.cart)?;
    if payload.status.as_deref() != Some("draft")
        && payload.cart.iter().any(|item| item.cost_price <= 0.0)
    {
        return Err("Completed purchase items require a positive cost price".into());
    }
    let items_total: f64 = payload
        .cart
        .iter()
        .map(|item| purchase_item_total(item, payload.tax_percent))
        .sum();
    let invoice_base = items_total + payload.expenses;
    if !items_total.is_finite()
        || (payload.status.as_deref() != Some("draft") && items_total <= 0.0)
        || !invoice_base.is_finite()
        || payload.discount_value > invoice_base + 0.000_001
    {
        return Err("Invalid purchase discount".into());
    }
    Ok((
        items_total,
        purchase_inventory_paid_factor(
            items_total,
            payload.expenses,
            payload.discount_value,
            payload.discount_percent,
        ),
    ))
}

pub(crate) fn validate_purchase_items(items: &[PurchaseItem]) -> Result<(), String> {
    if items.is_empty() {
        return Err("Purchase items are required".into());
    }
    let mut lots = HashSet::with_capacity(items.len());
    for item in items {
        if !item.quantity.is_finite() || item.quantity <= 0.0 {
            return Err(format!("Invalid quantity for drug {}", item.id));
        }
        if !item.cost_price.is_finite() || item.cost_price < 0.0 {
            return Err(format!("Invalid cost price for drug {}", item.id));
        }
        if !item.bonus_quantity.is_finite() || item.bonus_quantity < 0.0 {
            return Err(format!("Invalid bonus quantity for drug {}", item.id));
        }
        if item
            .selling_price
            .is_some_and(|price| !price.is_finite() || price < 0.0)
            || !item.tax_percent.is_finite()
            || !(0.0..=100.0).contains(&item.tax_percent)
            || !item.discount_percent.is_finite()
            || !(0.0..=100.0).contains(&item.discount_percent)
        {
            return Err(format!("Invalid price or percentage for drug {}", item.id));
        }
        if item.strips_per_box <= 0 {
            return Err(format!("Invalid unit conversion for drug {}", item.id));
        }
        let normalized_expiry = normalize_date_ymd(item.expiry_date.as_deref());
        if !lots.insert((item.id, normalized_expiry)) {
            return Err(format!(
                "Duplicate purchase lot for drug {}; combine lines with the same expiry date",
                item.id
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn validate_completed_purchase_expiry(
    items: &[PurchaseItem],
    today: &str,
) -> Result<(), String> {
    validate_completed_purchase_expiry_with_non_expiring(items, today, &HashSet::new())
}

pub(crate) fn validate_completed_purchase_expiry_with_non_expiring(
    items: &[PurchaseItem],
    today: &str,
    non_expiring_drug_ids: &HashSet<i64>,
) -> Result<(), String> {
    for item in items {
        let expiry = normalize_valid_date_ymd(item.expiry_date.as_deref())?;
        let Some(expiry) = expiry else {
            if non_expiring_drug_ids.contains(&item.id) {
                continue;
            }
            return Err(format!(
                "Completed purchase requires an expiry date for drug {}",
                item.id
            ));
        };
        if expiry.as_str() < today {
            return Err(format!(
                "Expiry date for drug {} is already expired",
                item.id
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{
        normalize_valid_date_ymd, purchase_item_total, validate_completed_purchase_expiry,
        validate_purchase_items, validate_purchase_payload,
    };
    use crate::commands::purchase_accounting_policy::{
        build_purchase_accounting_plan, PurchaseSettlementAccount,
    };
    use crate::commands::purchase_dto::{PurchaseItem, PurchasePayload};

    #[derive(Debug, Deserialize)]
    struct Contract {
        lifecycle: Vec<LifecycleVector>,
        dates: Vec<DateVector>,
        expiry: Vec<ExpiryVector>,
        lots: Vec<LotVector>,
        items: Vec<ItemVector>,
        allocation: Vec<AllocationVector>,
        accounting: Vec<AccountingVector>,
    }

    #[derive(Debug, Deserialize)]
    struct LifecycleVector {
        name: String,
        status: Option<String>,
        payment_method: Option<String>,
        check_number: Option<String>,
        expected_ok: bool,
    }

    #[derive(Debug, Deserialize)]
    struct DateVector {
        name: String,
        input: Option<String>,
        expected: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct ExpiryVector {
        name: String,
        today: String,
        expiry_date: Option<String>,
        expected_ok: bool,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct ContractItem {
        id: i64,
        quantity: f64,
        cost_price: f64,
        selling_price: Option<f64>,
        bonus_quantity: f64,
        tax_percent: f64,
        discount_percent: f64,
        strips_per_box: i64,
        expiry_date: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct LotVector {
        name: String,
        items: Vec<ContractItem>,
        expected_ok: bool,
    }

    #[derive(Debug, Deserialize)]
    struct ItemVector {
        name: String,
        status: String,
        items: Vec<ContractItem>,
        expected_ok: bool,
    }

    #[derive(Debug, Deserialize)]
    struct AllocationHeader {
        tax_percent: f64,
        expenses: f64,
        discount_value: f64,
        discount_percent: f64,
    }

    #[derive(Debug, Deserialize)]
    struct AllocationVector {
        name: String,
        items: Vec<ContractItem>,
        header: AllocationHeader,
        expected_total: f64,
        expected_unit_costs: Vec<f64>,
    }

    #[derive(Debug, Deserialize)]
    struct AccountingVector {
        name: String,
        payment_method: String,
        total_amount: f64,
        expected: AccountingExpected,
    }

    #[derive(Debug, Deserialize)]
    struct AccountingExpected {
        settlement_account: String,
        supplier_balance_delta: f64,
        supplier_transactions: Vec<AccountingSupplierTransaction>,
        cash_movement: Option<AccountingCashMovement>,
    }

    #[derive(Debug, Deserialize)]
    struct AccountingSupplierTransaction {
        #[serde(rename = "type")]
        transaction_type: String,
        amount: f64,
    }

    #[derive(Debug, Deserialize)]
    struct AccountingCashMovement {
        #[serde(rename = "type")]
        movement_type: String,
        amount: f64,
    }

    fn contract() -> Contract {
        serde_json::from_str(include_str!(
            "../../../contracts/purchase-policy-vectors.json"
        ))
        .expect("shared purchase policy contract must parse")
    }

    fn item(vector: &ContractItem) -> PurchaseItem {
        PurchaseItem {
            purchase_invoice_item_id: None,
            id: vector.id,
            quantity: vector.quantity,
            unit_id: None,
            expiry_date: vector.expiry_date.clone(),
            cost_price: vector.cost_price,
            selling_price: vector.selling_price,
            bonus_quantity: vector.bonus_quantity,
            tax_percent: vector.tax_percent,
            discount_percent: vector.discount_percent,
            strips_per_box: vector.strips_per_box,
            barcode: None,
        }
    }

    fn default_item() -> PurchaseItem {
        PurchaseItem {
            purchase_invoice_item_id: None,
            id: 1,
            quantity: 1.0,
            unit_id: None,
            expiry_date: Some("2030-01-31".into()),
            cost_price: 10.0,
            selling_price: Some(12.0),
            bonus_quantity: 0.0,
            tax_percent: 0.0,
            discount_percent: 0.0,
            strips_per_box: 1,
            barcode: None,
        }
    }

    fn payload(
        status: Option<String>,
        payment_method: Option<String>,
        check_number: Option<String>,
        cart: Vec<PurchaseItem>,
    ) -> PurchasePayload {
        PurchasePayload {
            id: None,
            supplier_id: 1,
            pharmacy_id: Some("contract".into()),
            user_id: "contract-user".into(),
            invoice_number: Some("CONTRACT".into()),
            invoice_date: Some("2026-09-28".into()),
            payment_method,
            notes: None,
            check_number,
            expenses: 0.0,
            discount_value: 0.0,
            discount_percent: 0.0,
            tax_percent: 0.0,
            status,
            cart,
        }
    }

    #[test]
    fn shared_lifecycle_vectors_match() {
        for vector in contract().lifecycle {
            let result = validate_purchase_payload(&payload(
                vector.status,
                vector.payment_method,
                vector.check_number,
                vec![default_item()],
            ));
            assert_eq!(
                result.is_ok(),
                vector.expected_ok,
                "lifecycle vector: {}",
                vector.name
            );
        }
    }

    #[test]
    fn shared_date_vectors_match() {
        for vector in contract().dates {
            let actual = normalize_valid_date_ymd(vector.input.as_deref())
                .ok()
                .flatten();
            assert_eq!(actual, vector.expected, "date vector: {}", vector.name);
        }
    }

    #[test]
    fn shared_expiry_vectors_match() {
        for vector in contract().expiry {
            let mut purchase_item = default_item();
            purchase_item.expiry_date = vector.expiry_date;
            let result = validate_completed_purchase_expiry(&[purchase_item], &vector.today);
            assert_eq!(
                result.is_ok(),
                vector.expected_ok,
                "expiry vector: {}",
                vector.name
            );
        }
    }

    #[test]
    fn shared_lot_vectors_match() {
        for vector in contract().lots {
            let items: Vec<PurchaseItem> = vector.items.iter().map(item).collect();
            let result = validate_purchase_items(&items);
            assert_eq!(
                result.is_ok(),
                vector.expected_ok,
                "lot vector: {}",
                vector.name
            );
        }
    }

    #[test]
    fn shared_item_vectors_match() {
        for vector in contract().items {
            let items: Vec<PurchaseItem> = vector.items.iter().map(item).collect();
            let result = validate_purchase_payload(&payload(
                Some(vector.status),
                Some("credit".into()),
                None,
                items,
            ));
            assert_eq!(
                result.is_ok(),
                vector.expected_ok,
                "item vector: {}",
                vector.name
            );
        }
    }

    #[test]
    fn shared_allocation_vectors_match() {
        for vector in contract().allocation {
            let items: Vec<PurchaseItem> = vector.items.iter().map(item).collect();
            let mut purchase = payload(
                Some("completed".into()),
                Some("credit".into()),
                None,
                items,
            );
            purchase.tax_percent = vector.header.tax_percent;
            purchase.expenses = vector.header.expenses;
            purchase.discount_value = vector.header.discount_value;
            purchase.discount_percent = vector.header.discount_percent;

            let (items_total, paid_factor) = validate_purchase_payload(&purchase)
                .unwrap_or_else(|error| panic!("allocation vector {}: {error}", vector.name));
            let actual_total = items_total * paid_factor;
            assert!(
                (actual_total - vector.expected_total).abs() < 1e-8,
                "allocation total vector {}: expected {}, got {}",
                vector.name,
                vector.expected_total,
                actual_total
            );

            let actual_unit_costs: Vec<f64> = purchase
                .cart
                .iter()
                .map(|purchase_item| {
                    purchase_item_total(purchase_item, purchase.tax_percent)
                        * paid_factor
                        / (purchase_item.quantity + purchase_item.bonus_quantity)
                })
                .collect();
            assert_eq!(
                actual_unit_costs.len(),
                vector.expected_unit_costs.len(),
                "allocation unit-cost count vector {}",
                vector.name
            );
            for (actual, expected) in actual_unit_costs
                .iter()
                .zip(vector.expected_unit_costs.iter())
            {
                assert!(
                    (actual - expected).abs() < 1e-8,
                    "allocation unit cost vector {}: expected {}, got {}",
                    vector.name,
                    expected,
                    actual
                );
            }
        }
    }

    #[test]
    fn shared_accounting_vectors_match() {
        for vector in contract().accounting {
            let plan = build_purchase_accounting_plan(
                &vector.payment_method,
                vector.total_amount,
            )
            .unwrap_or_else(|error| panic!("accounting vector {}: {error}", vector.name));
            let settlement_account = match plan.settlement_account {
                PurchaseSettlementAccount::Payable => "payable",
                PurchaseSettlementAccount::Cash => "cash",
            };
            assert_eq!(
                settlement_account,
                vector.expected.settlement_account,
                "accounting settlement vector: {}",
                vector.name
            );
            assert!(
                (plan.supplier_balance_delta - vector.expected.supplier_balance_delta).abs() < 1e-8,
                "accounting supplier delta vector: {}",
                vector.name
            );
            assert_eq!(
                plan.supplier_transactions.len(),
                vector.expected.supplier_transactions.len(),
                "accounting supplier transaction count vector: {}",
                vector.name
            );
            for (actual, expected) in plan
                .supplier_transactions
                .iter()
                .zip(vector.expected.supplier_transactions.iter())
            {
                assert_eq!(
                    actual.transaction_type,
                    expected.transaction_type,
                    "accounting supplier transaction type vector: {}",
                    vector.name
                );
                assert!(
                    (actual.amount - expected.amount).abs() < 1e-8,
                    "accounting supplier transaction amount vector: {}",
                    vector.name
                );
            }

            match (plan.cash_movement, vector.expected.cash_movement) {
                (None, None) => {}
                (Some(actual), Some(expected)) => {
                    assert_eq!(
                        actual.movement_type,
                        expected.movement_type,
                        "accounting cash movement type vector: {}",
                        vector.name
                    );
                    assert!(
                        (actual.amount - expected.amount).abs() < 1e-8,
                        "accounting cash movement amount vector: {}",
                        vector.name
                    );
                }
                _ => panic!("accounting cash movement presence vector: {}", vector.name),
            }
        }
    }
}
