jest.mock('@/app/actions-client/purchases', () => ({
  getPurchaseInvoicesAction: jest.fn(),
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  deletePurchaseInvoiceAction: jest.fn(),
}));

jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn(),
}));

jest.mock('@/components/purchases/BarcodePrinter', () => () => null);

import {
  purchaseReportDate,
  purchaseReportLineAmounts,
  purchaseReportPaymentLabel,
  purchaseReportUnitLabel,
} from '@/components/reports/PurchasesReportsClient';
import {
  purchaseInvoiceDate,
  purchaseInvoiceLineAmounts,
  purchaseInvoicePaymentLabel,
  purchaseInvoiceUnitLabel,
} from '@/components/reports/PurchaseReportsClient';

describe('purchase report display regressions', () => {
  const currentDetailPayload = {
    quantity: 3,
    bonus_quantity: 1,
    cost_price: 10,
    tax_percent: 10,
    unit_id: 1,
    unit: 'Box',
    large_unit: 'زجاجة',
  };

  it('shows the master large-unit name for canonical purchase quantities with an Arabic fallback', () => {
    expect(purchaseReportUnitLabel(currentDetailPayload)).toBe('زجاجة');
    expect(purchaseInvoiceUnitLabel(currentDetailPayload)).toBe('زجاجة');
    expect(purchaseReportUnitLabel({ unit_id: 2, unit: 'Strip', large_unit: 'كرتونة' })).toBe('كرتونة');
    expect(purchaseInvoiceUnitLabel({ unit_id: 2, unit: 'Strip', large_unit: 'كرتونة' })).toBe('كرتونة');
    expect(purchaseReportUnitLabel({ large_unit: '   ' })).toBe('علبة');
    expect(purchaseInvoiceUnitLabel({ large_unit: '' })).toBe('علبة');
  });

  it('calculates a safe gross/net fallback from the current detail payload', () => {
    expect(purchaseReportLineAmounts(currentDetailPayload)).toEqual({ gross: 33, discount: 0, net: 33 });
    expect(purchaseInvoiceLineAmounts(currentDetailPayload)).toEqual({ gross: 33, discount: 0, net: 33 });
  });

  it('prefers reconciled line totals supplied by the details action', () => {
    const payload = { ...currentDetailPayload, line_gross_amount: 40, line_net_amount: 36.5 };
    expect(purchaseReportLineAmounts(payload)).toEqual({ gross: 40, discount: 3.5, net: 36.5 });
    expect(purchaseInvoiceLineAmounts(payload)).toEqual({ gross: 40, discount: 3.5, net: 36.5 });
  });

  it('shows invoice dates and check payments with the correct labels', () => {
    expect(purchaseReportDate('2026-08-12')).toBe('2026/08/12');
    expect(purchaseInvoiceDate('2026-08-12')).toBe('12/08/2026');
    expect(purchaseReportPaymentLabel('check')).toBe('شيك');
    expect(purchaseInvoicePaymentLabel('check')).toBe('شيك');
  });
});
