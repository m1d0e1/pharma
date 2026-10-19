use serde::{Deserialize, Serialize};

use super::serde_compat::{
    de_f64, de_i64, de_opt_f64, de_opt_i64, de_opt_string, de_string, one_i64,
};

#[derive(Debug, Deserialize)]
pub struct PurchasePayload {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub id: Option<String>,
    #[serde(deserialize_with = "de_i64")]
    pub supplier_id: i64,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub pharmacy_id: Option<String>,
    #[serde(default, deserialize_with = "de_string")]
    pub user_id: String,
    pub invoice_number: Option<String>,
    pub invoice_date: Option<String>,
    pub payment_method: Option<String>,
    pub notes: Option<String>,
    pub check_number: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub expenses: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_value: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_percent: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub tax_percent: f64,
    pub status: Option<String>,
    #[serde(default)]
    pub cart: Vec<PurchaseItem>,
}

/// Trusted purchase IPC envelope. The renderer cannot nominate an actor or
/// tenant, even when calling Tauri directly outside the React form.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativePurchaseRequest {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub id: Option<String>,
    #[serde(deserialize_with = "de_i64")]
    pub supplier_id: i64,
    pub invoice_number: Option<String>,
    pub invoice_date: Option<String>,
    pub payment_method: Option<String>,
    pub notes: Option<String>,
    pub check_number: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub expenses: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_value: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_percent: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub tax_percent: f64,
    pub status: Option<String>,
    #[serde(default)]
    pub cart: Vec<PurchaseItem>,
}

impl NativePurchaseRequest {
    pub fn with_native_owner(self, user_id: &str, pharmacy_id: &str) -> PurchasePayload {
        PurchasePayload {
            id: self.id,
            supplier_id: self.supplier_id,
            pharmacy_id: Some(pharmacy_id.to_owned()),
            user_id: user_id.to_owned(),
            invoice_number: self.invoice_number,
            invoice_date: self.invoice_date,
            payment_method: self.payment_method,
            notes: self.notes,
            check_number: self.check_number,
            expenses: self.expenses,
            discount_value: self.discount_value,
            discount_percent: self.discount_percent,
            tax_percent: self.tax_percent,
            status: self.status,
            cart: self.cart,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PurchaseItem {
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub purchase_invoice_item_id: Option<i64>,
    #[serde(deserialize_with = "de_i64")]
    pub id: i64,
    #[serde(default, deserialize_with = "de_f64")]
    pub quantity: f64,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub unit_id: Option<i64>,
    pub expiry_date: Option<String>,
    /// Net (post-discount) cost price per large unit (box).
    /// The UI pre-applies `discount_percent` before sending, so this
    /// field already reflects the discounted price. `discount_percent`
    /// is stored for display purposes only and is NOT re-applied in math.
    #[serde(default, deserialize_with = "de_f64")]
    pub cost_price: f64,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub selling_price: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub bonus_quantity: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub tax_percent: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_percent: f64,
    #[serde(default = "one_i64", deserialize_with = "de_i64")]
    pub strips_per_box: i64,
    pub barcode: Option<String>,
}
