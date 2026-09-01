import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import ShiftReportClient from '@/components/reports/ShiftReportClient';
import ShiftReceiptsModal from '@/components/shifts/ShiftReceiptsModal';
import ShortagesClient from '@/app/(dashboard)/stores/shortages/ShortagesClient';

import {
  getHandoverDetailsAction,
  getOpenShiftHandoverAction,
  getShiftCreditSalesAction,
  processHandoverAction,
} from '@/app/actions-client/handover';
import {
  getCurrentShiftAction,
  getShiftsAction,
  openShiftAction,
  getShiftReceiptsAction,
} from '@/app/actions-client/shifts';
import { getShiftReportAction } from '@/app/actions-client/reports';
import {
  deleteShortageAction,
  deleteShortagesBulkAction,
  getShortagesAction,
  syncLowStockToShortagesAction,
  updateShortageQuantityAction,
  updateShortageStatusAction,
  updateShortagesStatusBulkAction,
} from '@/app/actions-client/shortages';
import { getStaffAction } from '@/app/actions-client/users';
import { getBanksAction } from '@/app/actions-client/finance';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('react-hotkeys-hook', () => ({
  useHotkeys: jest.fn(),
}));

jest.mock('@/app/actions-client/auth', () => ({
  logoutLocalAction: jest.fn(),
}));

jest.mock('@/app/actions-client/config', () => ({
  getConfigAction: jest.fn(async () => ({ value: 'صيدلية النور التجريبية' })),
}));

jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
  getOpenShiftHandoverAction: jest.fn(),
  getShiftCreditSalesAction: jest.fn(async () => ({ success: true, data: [] })),
  processHandoverAction: jest.fn(),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  getCurrentShiftAction: jest.fn(),
  getCurrentShiftStatsAction: jest.fn(),
  getShiftsAction: jest.fn(),
  openShiftAction: jest.fn(async () => ({ success: true, shiftId: 'mock-shift-id' })),
  forceCloseAllShiftsAction: jest.fn(),
  getShiftReceiptsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/reports', () => ({
  getShiftReportAction: jest.fn(),
}));

jest.mock('@/app/actions-client/shortages', () => ({
  getShortagesAction: jest.fn(),
  syncLowStockToShortagesAction: jest.fn(),
  updateShortageStatusAction: jest.fn(),
  updateShortageQuantityAction: jest.fn(),
  deleteShortageAction: jest.fn(),
  deleteShortagesBulkAction: jest.fn(),
  updateShortagesStatusBulkAction: jest.fn(),
}));

jest.mock('@/app/actions-client/finance', () => ({
  getBanksAction: jest.fn(async () => ({ success: true, data: [] })),
}));

jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn(async () => ({
    success: true,
    data: [
      { id: 'user-next', username: 'dr_sara', full_name: 'د. سارة أحمد' },
      { id: 'user-vault', username: 'dr_ali', full_name: 'د. علي محمود' },
    ],
  })),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({ role: 'owner' })),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('Comprehensive UI Flow Regression Suite for all Added Features', () => {
  jest.setTimeout(30000);

  beforeEach(() => {
    mockPush.mockReset();
    window.confirm = jest.fn(() => true);
  });

  /* ========================================================================
   * 1. HANDOVER UI FLOWS
   * ======================================================================== */
  describe('1. Drawer Handover UI Flow (تسليم الوردية والدرج)', () => {
    beforeEach(() => {
      (getOpenShiftHandoverAction as jest.Mock).mockResolvedValue({ success: true, data: { id: 'shift-100' } });
      (getHandoverDetailsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          id: 'shift-100',
          user_name: 'د. أحمد صيدلي',
          starting_cash: 200,
          expected_cash: 750,
          cash_sales: 600,
          cash_returns: 50,
        },
      });
      (processHandoverAction as jest.Mock).mockResolvedValue({
        success: true,
        difference: -50,
        remainingCash: 200,
      });
    });

    it('accepts actual cash with shortage/excess without showing discrepancy badge in handover UI, and allows selecting next shift receiver', async () => {
      const onClose = jest.fn();
      render(<DrawerHandoverClient shiftId="shift-100" onClose={onClose} />);

      // Wait for data to load
      expect(await screen.findByText(/تسليم درج الوردية/)).toBeInTheDocument();

      // Ensure discrepancy badge / icon is NOT displayed in handover modal
      expect(screen.queryByText(/فائض نقدي/)).not.toBeInTheDocument();
      expect(screen.queryByText(/عجز نقدي/)).not.toBeInTheDocument();

      // Enter Actual Cash: 700 (Shortage of 50 against expected 750)
      const [actualCashInput, transferInput] = screen.getAllByPlaceholderText('0.00');
      fireEvent.change(actualCashInput, { target: { value: '700' } });

      // Change transfer target to "الوردية التالية (ترحيل بالدرج)"
      const targetSelect = screen.getByDisplayValue('الخزينة الرئيسية');
      fireEvent.change(targetSelect, { target: { value: 'next_shift' } });

      // Verify next shift user "د. سارة أحمد" is selectable
      const receiverSelect = await screen.findByDisplayValue('د. سارة أحمد');
      fireEvent.change(receiverSelect, { target: { value: 'dr_sara' } });

      // Enter Transfer Amount: 500
      fireEvent.change(transferInput, { target: { value: '500' } });

      // Submit handover
      const submitBtn = screen.getByRole('button', { name: /إتمام تسليم الدرج/ });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(processHandoverAction).toHaveBeenCalledWith({
          shiftId: 'shift-100',
          actualCash: 700,
          transferAmount: 500,
          transferTargetType: 'next_shift',
          receiverUsername: 'dr_sara',
          receiverPassword: '',
          receiverPasswordHash: '',
          transferTargetId: '',
          notes: '',
          autoOpenNewShift: false,
        });
      });

      expect(onClose).toHaveBeenCalled();
    });
  });

  /* ========================================================================
   * 2. SHIFT MANAGEMENT & AUDIT COLUMNS UI FLOW
   * ======================================================================== */
  describe('2. Shift Management UI Flow (إدارة الورديات والرقابة المالية)', () => {
    const mockShifts = [
      {
        id: 'shift-1',
        shift_start: '2026-08-26T08:00:00Z',
        shift_end: '2026-08-26T16:00:00Z',
        starting_cash_amount: 200,
        ending_cash_amount: 500,
        expected_cash_amount: 500,
        actual_cash_amount: 500,
        cash_difference: 0,
        transferred_amount: 300,
        transfer_target: 'treasury',
        receiver_name: 'د. علي محمود',
        status: 'closed' as const,
        profiles: { full_name: 'د. أحمد', role: 'pharmacist' },
      },
      {
        id: 'shift-2',
        shift_start: '2026-08-26T16:00:00Z',
        shift_end: '2026-08-27T00:00:00Z',
        starting_cash_amount: 200,
        ending_cash_amount: 450,
        expected_cash_amount: 500,
        actual_cash_amount: 450,
        cash_difference: -50,
        transferred_amount: 250,
        transfer_target: 'next_shift',
        receiver_name: 'د. سارة أحمد',
        status: 'closed' as const,
        profiles: { full_name: 'د. علي', role: 'pharmacist' },
      },
    ];

    it('pre-fills suggested starting cash and displays financial audit columns and receipts button', async () => {
      render(
        <ShiftManagementClient
          initialShifts={mockShifts}
          currentShift={null}
          hasOpenShift={false}
          suggestedStartingCash={200}
          userRole="owner"
        />
      );

      // Verify suggested starting cash is pre-filled
      const startingCashInput = screen.getByPlaceholderText('أدخل المبلغ النقدي الافتتاحي') as HTMLInputElement;
      expect(startingCashInput.value).toBe('200');

      // Verify financial audit table columns
      expect(screen.getByText('نقدية الدرج الفعلية')).toBeInTheDocument();
      expect(screen.getByText('المحول للخزينة')).toBeInTheDocument();
      expect(screen.getByText('المستلم')).toBeInTheDocument();
      expect(screen.getByText('العجز / الزيادة')).toBeInTheDocument();

      // Check difference badge: Shift 1 exact (مطابق), Shift 2 deficit (-50 عجز)
      expect(screen.getByText(/مطابق/)).toBeInTheDocument();
      expect(screen.getAllByText(/عجز/)).toHaveLength(2);

      // Check receipt buttons for both shifts
      const receiptBtns = screen.getAllByRole('button', { name: /فواتير الوردية/ });
      expect(receiptBtns).toHaveLength(2);
    });
  });

  /* ========================================================================
   * 3. SHIFT RECEIPTS MODAL & REPORT UI FLOW
   * ======================================================================== */
  describe('3. Shift Receipts Modal & Report UI Flow (فواتير الوردية والتقرير)', () => {
    const mockReceipts = [
      {
        id: 'inv-rec-1',
        total_amount: 250,
        paid_amount: 250,
        remaining_amount: 0,
        payment_method: 'cash',
        discount_amount: 0,
        created_at: '2026-08-26T10:15:00Z',
        patient_name: 'محمود عبد الله',
        patient_phone: '01099887766',
        staff_name: 'د. أحمد',
        sales_items: [
          {
            drug_id: 1,
            trade_name: 'Panadol Extra',
            unit: 'علبة',
            unit_price: 50,
            quantity_sold: 2,
          },
          {
            drug_id: 2,
            trade_name: 'Augmentin 1g',
            unit: 'علبة',
            unit_price: 150,
            quantity_sold: 1,
          },
        ],
      },
    ];

    beforeEach(() => {
      (getShiftReceiptsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockReceipts,
      });

      (getShiftReportAction as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          shift: {
            id: 'shift-1',
            staff_name: 'د. أحمد',
            start_time: '2026-08-26T08:00:00Z',
            end_time: '2026-08-26T16:00:00Z',
            starting_cash: 200,
            ending_cash: 450,
            status: 'closed',
          },
          sales: [{ payment_method: 'cash', count: 1, total: 250, paid: 250, remaining: 0 }],
          returns: [],
          movements: [],
          summary: {
            cashSales: 250,
            cashReturns: 0,
            cashReceipts: 0,
            cashDisbursements: 0,
            cashHandover: 0,
            expectedCash: 450,
            actualCash: 450,
            difference: 0,
          },
        },
      });
    });

    it('searches and opens receipt details in ShiftReceiptsModal', async () => {
      render(
        <ShiftReceiptsModal
          isOpen={true}
          shiftId="shift-1"
          shiftTitle="الوردية الأولى"
          onClose={jest.fn()}
        />
      );

      // Verify modal header & stats
      expect(await screen.findByText('فواتير وإيصالات الوردية')).toBeInTheDocument();
      expect(screen.getByText('عدد الفواتير')).toBeInTheDocument();
      expect(screen.getByText('إجمالي المبيعات')).toBeInTheDocument();
      expect(screen.getByText('المبيعات النقدية')).toBeInTheDocument();

      // Search filter
      const searchInput = screen.getByPlaceholderText('بحث برقم الفاتورة أو اسم العميل أو اسم الصنف...');
      fireEvent.change(searchInput, { target: { value: 'محمود' } });
      expect(screen.getByText('محمود عبد الله')).toBeInTheDocument();

      // Open Receipt Details
      const detailsBtn = screen.getByTitle('عرض تفاصيل الفاتورة');
      fireEvent.click(detailsBtn);

      // Verify items in ReceiptDetailsModal
      expect(await screen.findByText('Panadol Extra')).toBeInTheDocument();
      expect(screen.getByText('Augmentin 1g')).toBeInTheDocument();
    }, 15000);

    it('opens shift receipts modal from Shift Report clicking the invoice count StatBox', async () => {
      render(<ShiftReportClient shiftId="shift-1" />);

      // Find the interactive StatBox with title "عدد الفواتير"
      const invoiceStatBox = await screen.findByText('عدد الفواتير');
      fireEvent.click(invoiceStatBox);

      expect(await screen.findByText('فواتير وإيصالات الوردية')).toBeInTheDocument();
      expect(getShiftReceiptsAction).toHaveBeenCalledWith('shift-1');
    }, 15000);
  });

  /* ========================================================================
   * 4. SHORTAGES NOTEBOOK & BULK ACTIONS UI FLOW
   * ======================================================================== */
  describe('4. Shortages Notebook & Bulk Actions UI Flow (كشكول النواقص والإجراءات الجماعية)', () => {
    const mockShortages = [
      {
        id: 201,
        drug_id: 10,
        trade_name: 'Panadol Extra 24 Tab',
        trade_name_en: 'Panadol Extra 24 Tab En',
        status: 'pending',
        requested_quantity: 12,
        current_stock: 0,
        reorder_point: 10,
        deficit: 10,
        last_supplier_name: 'شركة ابن سينا فارما',
        last_cost_price: 35.5,
        created_at: '2026-08-26T08:00:00Z',
      },
      {
        id: 202,
        drug_id: 20,
        trade_name: 'Amoxil 500mg Cap',
        trade_name_en: 'Amoxil 500mg Cap En',
        status: 'pending',
        requested_quantity: 6,
        current_stock: 2,
        reorder_point: 8,
        deficit: 6,
        last_supplier_name: 'المصرية لتجارة الأدوية',
        last_cost_price: 22.0,
        created_at: '2026-08-26T08:30:00Z',
      },
      {
        id: 203,
        drug_id: 30,
        trade_name: 'Cataflam 50mg Tab',
        trade_name_en: 'Cataflam 50mg Tab En',
        status: 'ordered',
        requested_quantity: 15,
        current_stock: 1,
        reorder_point: 10,
        deficit: 9,
        created_at: '2026-08-26T09:00:00Z',
      },
    ];

    beforeEach(() => {
      (deleteShortagesBulkAction as jest.Mock).mockResolvedValue({ success: true, count: 2 });
      (updateShortagesStatusBulkAction as jest.Mock).mockResolvedValue({ success: true, count: 2 });
      (updateShortageQuantityAction as jest.Mock).mockResolvedValue({ success: true, requested_quantity: 20 });
    });

    it('performs full UI lifecycle: search, inline edit, select all, and bulk status update', async () => {
      render(<ShortagesClient initialData={mockShortages} />);

      // Verify header counts
      expect(screen.getByText('مطلوب: 2 صنف')).toBeInTheDocument();
      expect(screen.getByText('قيد الطلب: 1 صنف')).toBeInTheDocument();

      // Search filter
      const searchInput = screen.getByPlaceholderText('بحث باسم الدواء، المورد، أو الملاحظة...');
      fireEvent.change(searchInput, { target: { value: 'Amoxil' } });
      expect(screen.getByText('Amoxil 500mg Cap En')).toBeInTheDocument();
      expect(screen.queryByText('Panadol Extra 24 Tab En')).not.toBeInTheDocument();

      // Clear search
      fireEvent.change(searchInput, { target: { value: '' } });
      expect(screen.getByText('Panadol Extra 24 Tab En')).toBeInTheDocument();

      // Inline Edit Quantity on Panadol Extra
      const editButtons = screen.getAllByTitle('تعديل الكمية والملاحظات');
      fireEvent.click(editButtons[0]);

      const qtyInput = screen.getByDisplayValue('12');
      fireEvent.change(qtyInput, { target: { value: '20' } });

      const saveBtn = screen.getByRole('button', { name: /حفظ/ });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateShortageQuantityAction).toHaveBeenCalledWith(201, 20, '');
      });

      // Multi-selection: Click "تحديد الكل"
      const selectAllBtn = screen.getByRole('button', { name: /تحديد الكل/ });
      fireEvent.click(selectAllBtn);

      // Verify Floating Bulk Actions Bar
      expect(await screen.findByText('تم تحديد 3 صنف')).toBeInTheDocument();
      expect(screen.getByText('يمكنك تطبيق إجراء جماعي على جميع الأصناف المحددة')).toBeInTheDocument();

      // Perform Bulk status change to 'ordered'
      const bulkOrderedBtn = screen.getByRole('button', { name: /تحويل لـ قيد الطلب/ });
      fireEvent.click(bulkOrderedBtn);

      await waitFor(() => {
        expect(updateShortagesStatusBulkAction).toHaveBeenCalledWith([201, 202, 203], 'ordered');
      });
    });

    it('performs bulk convert to purchase invoice and copies to WhatsApp', async () => {
      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
      const writeTextSpy = jest.fn(() => Promise.resolve());
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextSpy,
        },
      });

      render(<ShortagesClient initialData={mockShortages} />);

      // Select first two items using card checkboxes
      const selectCheckboxes = screen.getAllByTitle('تحديد الصنف');
      fireEvent.click(selectCheckboxes[0]); // Panadol
      fireEvent.click(selectCheckboxes[1]); // Amoxil

      expect(await screen.findByText('تم تحديد 2 صنف')).toBeInTheDocument();

      // Click "نسخ للواتساب" for selected
      const copyWhatsAppBtn = screen.getByRole('button', { name: /نسخ للواتساب/ });
      fireEvent.click(copyWhatsAppBtn);

      expect(writeTextSpy).toHaveBeenCalledWith(expect.stringContaining('طلبيّة نواقص الأدوية'));
      expect(writeTextSpy).toHaveBeenCalledWith(expect.stringContaining('Panadol Extra'));
      expect(writeTextSpy).toHaveBeenCalledWith(expect.stringContaining('Amoxil'));

      // Click "تحويل للمشتريات (2)"
      const convertBtn = screen.getByRole('button', { name: /تحويل للمشتريات \(2\)/ });
      fireEvent.click(convertBtn);

      expect(setItemSpy).toHaveBeenCalledWith('shortages_to_purchase', expect.stringContaining('Panadol Extra'));
      expect(mockPush).toHaveBeenCalledWith('/purchases/new');
    });

    it('filters out of stock and critical items and opens purchase order modal', async () => {
      render(<ShortagesClient initialData={mockShortages} />);

      // Verify "منتهي / حرج" tab exists
      const urgentTab = screen.getByRole('button', { name: /منتهي \/ حرج \(/i });
      expect(urgentTab).toBeInTheDocument();

      // Click "منتهي / حرج" tab
      fireEvent.click(urgentTab);

      // Verify filtered list shows out of stock item (Panadol Extra has current_stock: 0)
      expect(screen.getByText('Panadol Extra 24 Tab En')).toBeInTheDocument();
      // Augmentin has current_stock: 15, reorder_point: 10 (sufficient), so should not be in urgent filter
      expect(screen.queryByText('Augmentin 1g Tab En')).not.toBeInTheDocument();

      // Click "إنشاء أمر شراء"
      const createPoBtn = screen.getByRole('button', { name: /إنشاء أمر شراء \(/ });
      fireEvent.click(createPoBtn);

      // Verify PurchaseOrderModal opened with items
      expect(await screen.findByText('إنشاء أمر شراء جديد')).toBeInTheDocument();
    });
  });
});
