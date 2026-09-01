import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import PurchasesReportsClient from '@/components/reports/PurchasesReportsClient';
import PurchaseReportsClient from '@/components/reports/PurchaseReportsClient';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';
import { getPurchasesReportsAction, getPurchaseInvoicesAction } from '@/app/actions-client/purchases';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';
import { getSuppliersAction } from '@/app/actions-client/purchases';

jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(),
  getInvoiceDetailsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoicesAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getSuppliersAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  deletePurchaseInvoiceAction: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/purchases/BarcodePrinter', () => () => null);

describe('Sales & Purchases Reports Totals Display', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders summary total KPI cards and table footer in SalesReportsClient', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'inv-11111111',
          created_at: '2026-09-01T10:00:00Z',
          total_amount: 1000,
          discount_amount: 100,
          payment_method: 'cash',
          patient_name: 'أحمد علي',
          staff_name: 'د. محمد',
          status: 'completed',
        },
        {
          id: 'inv-22222222',
          created_at: '2026-09-01T11:00:00Z',
          total_amount: 500,
          discount_amount: 50,
          payment_method: 'visa',
          patient_name: 'محمود حسن',
          staff_name: 'د. محمد',
          status: 'completed',
        },
      ],
    });

    render(<SalesReportsClient userRole="owner" />);

    await waitFor(() => {
      // 1000 + 500 = 1500 (Gross)
      // 100 + 50 = 150 (Discount)
      // Net = 1350
      expect(screen.getByText('صافي المبيعات')).toBeInTheDocument();
      expect(screen.getByText('إجمالي قبل الخصم')).toBeInTheDocument();
      expect(screen.getByText('إجمالي الخصومات')).toBeInTheDocument();
      expect(screen.getByText('المبيعات النقدية / شبكة')).toBeInTheDocument();

      // Check footer row exists
      expect(screen.getByText('الإجمالي (2 فاتورة)')).toBeInTheDocument();
    });
  });

  it('renders summary total KPI cards and table footer in PurchasesReportsClient', async () => {
    (getPurchasesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'pur-11111111',
          created_at: '2026-09-01T10:00:00Z',
          gross_amount: 2000,
          discount_amount: 200,
          total_amount: 1800,
          total_selling_amount: 2500,
          payment_method: 'cash',
          supplier_name: 'شركة المتحدة',
          staff_name: 'د. محمد',
          status: 'completed',
        },
      ],
    });

    render(<PurchasesReportsClient userRole="owner" />);

    await waitFor(() => {
      expect(screen.getByText('صافي المشتريات')).toBeInTheDocument();
      expect(screen.getByText('القيمة البيعية المتوقعة')).toBeInTheDocument();
      expect(screen.getByText('الإجمالي (1 فاتورة)')).toBeInTheDocument();
    });
  });

  it('renders footer totals row in PurchaseReportsClient', async () => {
    (getPurchaseInvoicesAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          id: 'pur-12345678',
          created_at: '2026-09-01T10:00:00Z',
          total_amount: 3500,
          payment_method: 'cash',
          supplier_name: 'شركة ابن سينا',
          status: 'completed',
        },
      ],
    });

    render(<PurchaseReportsClient />);

    await waitFor(() => {
      expect(screen.getByText('الإجمالي (1 فاتورة)')).toBeInTheDocument();
      expect(screen.getByText('3500.00 ج.م')).toBeInTheDocument();
    });
  });
});
