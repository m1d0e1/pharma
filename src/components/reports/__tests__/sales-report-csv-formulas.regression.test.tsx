import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';

jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(),
  getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));

describe('sales report offline CSV export', () => {
  const createObjectURL = URL.createObjectURL;

  afterEach(() => {
    if (createObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    jest.restoreAllMocks();
  });

  it('exports spreadsheet formula-like patient and staff names as literal text', async () => {
    (getSalesReportsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 'SALE-CELL-1234567',
        patient_name: '=HYPERLINK("https://example.test","Open")',
        staff_name: '\t+SUM(1,2)',
        created_at: '2026-10-10T10:00:00Z',
        total_amount: 10,
        discount_amount: 0,
        payment_method: 'cash',
        status: 'completed',
      }],
    });

    let exportBlob: Blob | null = null;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn((blob: Blob) => { exportBlob = blob; return 'blob:sales-csv'; }),
    });
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByText('=HYPERLINK("https://example.test","Open")')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' }));

    expect(exportBlob).toBeInstanceOf(Blob);
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(exportBlob!);
    });
    // Quoting alone leaves a CSV formula active when opened in a spreadsheet.
    // Prepending an apostrophe makes the text literal, including after leading tabs.
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"",""Open"")"');
    expect(csv).toContain('"\'\t+SUM(1,2)"');
    expect(csv).toContain(',10,0,10,completed');
  });
});
