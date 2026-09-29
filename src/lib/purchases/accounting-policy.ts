export type PurchaseSettlementAccount = 'payable' | 'cash';
export type PurchaseSupplierTransactionType = 'invoice' | 'payment';

export type PurchaseAccountingPlan = {
  settlementAccount: PurchaseSettlementAccount;
  supplierBalanceDelta: number;
  supplierTransactions: Array<{
    type: PurchaseSupplierTransactionType;
    amount: number;
  }>;
  cashMovement: null | {
    type: 'disbursement';
    amount: number;
  };
};

export function buildPurchaseAccountingPlan(
  paymentMethod: string,
  totalAmount: number,
): PurchaseAccountingPlan {
  if (!['cash', 'credit', 'check'].includes(paymentMethod)) {
    throw new Error('Invalid purchase payment method');
  }
  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new Error('Invalid purchase accounting total');
  }

  if (paymentMethod === 'cash') {
    return {
      settlementAccount: 'cash',
      supplierBalanceDelta: 0,
      supplierTransactions: [
        { type: 'invoice', amount: totalAmount },
        { type: 'payment', amount: -totalAmount },
      ],
      cashMovement: { type: 'disbursement', amount: totalAmount },
    };
  }

  return {
    settlementAccount: 'payable',
    supplierBalanceDelta: totalAmount,
    supplierTransactions: [
      { type: 'invoice', amount: totalAmount },
    ],
    cashMovement: null,
  };
}
