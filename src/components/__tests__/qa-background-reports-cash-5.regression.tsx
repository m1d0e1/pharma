import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesReportsClient from '@/components/reports/SalesReportsClient';
import { getInvoiceDetailsAction, getSalesReportsAction } from '@/app/actions-client/sales-reports';
import { getStaffAction } from '@/app/actions-client/users';
import { getPatientsAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

jest.mock('next/dynamic', () => () => () => null);
jest.mock('@/app/actions-client/sales-reports', () => ({
  getSalesReportsAction: jest.fn(),
  getInvoiceDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/users', () => ({ getStaffAction: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({ getPatientsAction: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({ hasUserPermissionSync: () => true }));
jest.mock('react-hot-toast', () => ({ toast: { error: jest.fn() } }));

const originalCreateObjectURL = URL.createObjectURL;

const invoice = (id: string, patient_name: string) => ({
  id,
  patient_name,
  staff_name: 'QA Cashier',
  created_at: '2026-09-22T12:00:00Z',
  payment_method: 'cash',
  total_amount: 80,
  discount_amount: 20,
  status: 'completed',
});

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('QA background sales report controls and CSV boundaries', () => {
  afterEach(() => {
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getSalesReportsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [invoice('SALE-OLD-1111', 'Previous Patient')] });
    (getInvoiceDetailsAction as jest.Mock).mockReset().mockResolvedValue({ success: true, data: [] });
    (getStaffAction as jest.Mock).mockReset().mockResolvedValue({
      success: true, data: [{ id: 'staff-1', full_name: 'QA Cashier' }],
    });
    (getPatientsAction as jest.Mock).mockReset().mockResolvedValue({
      success: true, data: [{ id: 'patient-1', full_name: 'Selected Patient' }],
    });
  });

  it('sends the chosen dates, staff, patient, method and invoice only on Search, then clears all sentinel filters', async () => {
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [invoice('SALE-OLD-1111', 'Previous Patient')] })
      .mockResolvedValueOnce({ success: true, data: [invoice('SALE-NEW-2222', 'Selected Patient')] })
      .mockResolvedValueOnce({ success: true, data: [] });

    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByText('Previous Patient')).toBeInTheDocument();
    expect(getPatientsAction).toHaveBeenCalledWith({ reportScope: true });
    expect(getSalesReportsAction).toHaveBeenCalledWith(expect.objectContaining({
      userId: undefined, patientId: undefined, paymentMethod: 'all', invoiceNumber: '',
    }));

    fireEvent.change(screen.getByLabelText('من تاريخ'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('إلى تاريخ'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('الموظف / الصيدلي'), { target: { value: 'staff-1' } });
    fireEvent.change(screen.getByLabelText('العميل'), { target: { value: 'patient-1' } });
    fireEvent.change(screen.getByLabelText('طريقة الدفع'), { target: { value: 'wallet' } });
    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'SALE-NEW' } });
    expect(getSalesReportsAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Previous Patient')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    await waitFor(() => expect(getSalesReportsAction).toHaveBeenLastCalledWith({
      startDate: '2026-09-01', endDate: '2026-09-30', userId: 'staff-1',
      patientId: 'patient-1', paymentMethod: 'wallet', invoiceNumber: 'SALE-NEW',
    }));
    expect(await screen.findByText('Selected Patient', { selector: 'td' })).toBeInTheDocument();
    expect(screen.queryByText('Previous Patient')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('الموظف / الصيدلي'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('العميل'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('طريقة الدفع'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    await waitFor(() => expect(getSalesReportsAction).toHaveBeenLastCalledWith({
      startDate: '2026-09-01', endDate: '2026-09-30', userId: undefined,
      patientId: undefined, paymentMethod: 'all', invoiceNumber: '',
    }));
    expect(await screen.findByText('لا توجد فواتير مطابقة للبحث')).toBeInTheDocument();
    expect(screen.queryByText('Selected Patient', { selector: 'td' })).not.toBeInTheDocument();
    expect(getInvoiceDetailsAction).not.toHaveBeenCalled();
  });

  it('discards old invoices and export source when a refined scoped search is rejected', async () => {
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [invoice('SALE-OLD-1111', 'Previous Patient')] })
      .mockResolvedValueOnce({ success: false, error: 'QA scoped report unavailable' });
    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByText('Previous Patient')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'NOT-FOUND' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('QA scoped report unavailable'));
    expect(screen.queryByText('Previous Patient')).not.toBeInTheDocument();
    expect(screen.queryByText('الإجمالي (1 فاتورة)')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('QA scoped report unavailable');
    expect(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'طباعة تقرير المبيعات' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /بحث \(F\)/ })).toBeEnabled();
    expect(getInvoiceDetailsAction).not.toHaveBeenCalled();
  });

  it('downloads a UTF-8 CSV of the current report rows with quoted names and no stale invoices', async () => {
    const current = invoice('SALE-NEW-2222', 'Patient, "Quoted"');
    (getSalesReportsAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [invoice('SALE-OLD-1111', 'Previous Patient')] })
      .mockResolvedValueOnce({ success: true, data: [current] });

    let exportedBlob: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn((blob: Blob) => { exportedBlob = blob; return 'blob:qa-sales-report'; }),
    });
    let clickedAnchor: HTMLAnchorElement | undefined;
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function(this: HTMLAnchorElement) { clickedAnchor = this; });
    render(<SalesReportsClient userRole="owner" />);
    expect(await screen.findByText('Previous Patient')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('رقم الفاتورة'), { target: { value: 'SALE-NEW' } });
    fireEvent.click(screen.getByRole('button', { name: /بحث \(F\)/ }));
    expect(await screen.findByText(current.patient_name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تصدير تقرير المبيعات إلى CSV' }));

    expect(click).toHaveBeenCalledTimes(1);
    const anchor = clickedAnchor!;
    expect(anchor.getAttribute('href')).toBe('blob:qa-sales-report');
    expect(anchor.getAttribute('download')).toMatch(/^sales-report-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(exportedBlob).toBeInstanceOf(Blob);
    expect(exportedBlob?.type).toBe('text/csv;charset=utf-8;');
    const csv = await readBlob(exportedBlob!);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(exportedBlob!);
    });
    expect(Array.from(new Uint8Array(bytes).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    // The exported period filters invoice dates, not return-posting dates.
    // A result without verified return provenance must expose unavailability,
    // never manufacture a zero refund or a misleading post-return net total.
    expect(csv).toContain('رقم الفاتورة,طريقة الدفع,تاريخ الفاتورة (نطاق الفلترة),العميل');
    expect(csv).toContain('مرتجعات الفاتورة المعتمدة حتى الآن (قد تكون بعد الفترة),صافي الفاتورة بعد المرتجعات حتى الآن');
    expect(csv).toContain('"Patient, ""Quoted"""');
    expect(csv).toContain('#SALE-NEW');
    expect(csv).toContain(',100,20,80,completed,غير متاح,غير متاح');
    expect(csv).not.toContain(',completed,0,80');
    expect(csv).not.toContain('Previous Patient');
    expect(csv).not.toContain('#SALE-OLD');
    expect(getSalesReportsAction).toHaveBeenCalledTimes(2);
    expect(getInvoiceDetailsAction).not.toHaveBeenCalled();
  });
});
