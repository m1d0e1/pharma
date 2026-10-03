function calculateCheckoutTotal(items: Array<{ quantity_sold: number; unit_price: number; is_negative?: boolean }>, totalDiscount: number = 0, additionalFees: number = 0): number {
  const subtotal = items.reduce((sum, item) => {
    return sum + (item.quantity_sold * item.unit_price);
  }, 0);
  return subtotal - totalDiscount + additionalFees;
}

describe('Multi-Unit Same Drug POS Sale Simulation', () => {
  it('calculates total correctly when selling 1 Box and 2 Strips of the same drug', () => {
    const boxPrice = 120.00;
    const stripPrice = 40.00; // 3 strips per box

    const items = [
      {
        drug_id: 'drug-amoxil-100',
        quantity_sold: 1,
        unit_price: boxPrice,
        selected_unit: 'large',
        is_negative: false
      },
      {
        drug_id: 'drug-amoxil-100',
        quantity_sold: 2,
        unit_price: stripPrice,
        selected_unit: 'medium',
        is_negative: false
      }
    ];

    const totalDiscount = 0;
    const additionalFees = 0;

    const total = calculateCheckoutTotal(items, totalDiscount, additionalFees);
    expect(total).toBe(200.00); // 120 + (2 * 40) = 200
  });

  it('handles item discounts per line correctly for multi-unit same drug lines', () => {
    const items = [
      {
        drug_id: 'drug-panadol-200',
        quantity_sold: 2,
        unit_price: 90.00, // 100 with 10% discount
        selected_unit: 'large',
        is_negative: false
      },
      {
        drug_id: 'drug-panadol-200',
        quantity_sold: 1,
        unit_price: 30.00, // 30 net
        selected_unit: 'medium',
        is_negative: false
      }
    ];

    const total = calculateCheckoutTotal(items, 0, 0);
    expect(total).toBe(210.00); // (2 * 90) + 30 = 210
  });
});
