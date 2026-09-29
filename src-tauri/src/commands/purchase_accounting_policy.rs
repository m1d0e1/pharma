#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PurchaseSettlementAccount {
    Payable,
    Cash,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PurchaseSupplierTransactionPlan {
    pub transaction_type: &'static str,
    pub amount: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PurchaseCashMovementPlan {
    pub movement_type: &'static str,
    pub amount: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PurchaseAccountingPlan {
    pub settlement_account: PurchaseSettlementAccount,
    pub supplier_balance_delta: f64,
    pub supplier_transactions: Vec<PurchaseSupplierTransactionPlan>,
    pub cash_movement: Option<PurchaseCashMovementPlan>,
}

pub(crate) fn build_purchase_accounting_plan(
    payment_method: &str,
    total_amount: f64,
) -> Result<PurchaseAccountingPlan, String> {
    if !matches!(payment_method, "cash" | "credit" | "check") {
        return Err("Invalid purchase payment method".into());
    }
    if !total_amount.is_finite() || total_amount < 0.0 {
        return Err("Invalid purchase accounting total".into());
    }

    if payment_method == "cash" {
        return Ok(PurchaseAccountingPlan {
            settlement_account: PurchaseSettlementAccount::Cash,
            supplier_balance_delta: 0.0,
            supplier_transactions: vec![
                PurchaseSupplierTransactionPlan {
                    transaction_type: "invoice",
                    amount: total_amount,
                },
                PurchaseSupplierTransactionPlan {
                    transaction_type: "payment",
                    amount: -total_amount,
                },
            ],
            cash_movement: Some(PurchaseCashMovementPlan {
                movement_type: "disbursement",
                amount: total_amount,
            }),
        });
    }

    Ok(PurchaseAccountingPlan {
        settlement_account: PurchaseSettlementAccount::Payable,
        supplier_balance_delta: total_amount,
        supplier_transactions: vec![PurchaseSupplierTransactionPlan {
            transaction_type: "invoice",
            amount: total_amount,
        }],
        cash_movement: None,
    })
}
