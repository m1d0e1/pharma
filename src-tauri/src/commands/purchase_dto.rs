use serde::Deserialize;

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

#[derive(Debug, Deserialize)]
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
