import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// UI Components to test
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import TrialBalanceReport from '@/components/reports/TrialBalanceReport';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import ReceiptListClient from '@/components/receipts/ReceiptListClient';
import ReceiptDetailsModal from '@/components/receipts/ReceiptDetailsModal';

// Actions to test & mock
import {
  getTrialBalanceAction,
  getAccountsAction,
  getPointsOfSaleAction,
  getBanksAction,
} from '@/app/actions-client/finance';
import {
  getHandoverDetailsAction,
  processHandoverAction,
  getShiftCreditSalesAction,
} from '@/app/actions-client/handover';
import {
  openShiftAction,
  getShiftsAction,
  forceCloseAllShiftsAction,
  getShiftReceiptsAction,
} from '@/app/actions-client/shifts';
import { getStaffAction } from '@/app/actions-client/users';
import { getConfigAction } from '@/app/actions-client/config';
import { generateReceiptHtml, generateWhatsAppMessage, printHtmlContent } from '@/lib/utils/printing';

// Global test setup & mocks
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'owner' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));

jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({
    success: true,
    user: { id: 'user-1', pharmacy_id: 'pharmacy-1', full_name: 'د. محمد' },
  }),
}));

jest.mock('@/app/actions-client/finance', () => ({
  getTrialBalanceAction: jest.fn(),
  getAccountsAction: jest.fn(),
  getPointsOfSaleAction: jest.fn(),
  getBanksAction: jest.fn(),
  getCashMovementsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getExpenseDefinitionsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getPapersAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getCardsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getJournalsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getFinancialNoticesAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getActivityLogsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/app/actions-client/handover', () => ({
  getHandoverDetailsAction: jest.fn(),
  processHandoverAction: jest.fn(),
  getShiftCreditSalesAction: jest.fn(),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  openShiftAction: jest.fn(),
  getShiftsAction: jest.fn(),
  forceCloseAllShiftsAction: jest.fn(),
  getShiftReceiptsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/users', () => ({
  getStaffAction: jest.fn(),
}));

jest.mock('@/app/actions-client/config', () => ({
  getConfigAction: jest.fn(),
}));

jest.mock('@/app/actions-client/expenses', () => ({
  getExpensesAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/lib/utils/printing', () => ({
  generateReceiptHtml: jest.fn().mockReturnValue('<html>receipt</html>'),
  generateWhatsAppMessage: jest.fn().mockReturnValue('فاتورة تجريبية'),
  printHtmlContent: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  Toaster: () => null,
  toast: Object.assign(jest.fn(), {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  }),
}));

describe('Exhaustive Testing: Financials, Handover, Shift, and Receipt Modules', () => {
  jest.setTimeout(30000);

  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    mockPush.mockReset();
    window.confirm = jest.fn(() => true);
  });

  /* ==========================================================================
   * 1. FINANCIALS DOMAIN (الحسابات، ميزان المراجعة، ونقاط البيع)
   * ========================================================================== */
  describe('1. Financials Domain (الإدارة المالية والحسابات وميزان المراجعة)', () => {
    const mockTrialBalanceData = [
      {
        id: 1,
        code: '101',
        name_ar: 'الخزينة الرئيسية',
        name_en: 'Main Treasury',
        is_group: 0,
        opening_net_debit: 5000,
        opening_net_credit: 0,
        period_debit: 2000,
        period_credit: 1000,
        net_debit: 6000,
        net_credit: 0,
      },
      {
        id: 2,
        code: '201',
        name_ar: 'موردو الأدوية',
        name_en: 'Drug Suppliers',
        is_group: 0,
        opening_net_debit: 0,
        opening_net_credit: 5000,
        period_debit: 1000,
        period_credit: 2000,
        net_debit: 0,
        net_credit: 6000,
      },
    ];

    it('renders TrialBalanceReport with balanced debit/credit totals and mode toggles', async () => {
      (getTrialBalanceAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockTrialBalanceData,
      });

      render(<TrialBalanceReport userRole="owner" />);

      expect(await screen.findByText('الخزينة الرئيسية')).toBeInTheDocument();
      expect(screen.getByText('موردو الأدوية')).toBeInTheDocument();

      // Check that balance warning alert is NOT shown when balanced
      expect(screen.queryByText(/تنبيه مالي: ميزان المراجعة غير متزن/i)).not.toBeInTheDocument();

      // Switch to Net mode (الأرصدة الصافية)
      const netBtn = screen.getByRole('button', { name: 'الأرصدة الصافية' });
      fireEvent.click(netBtn);

      // Verify net column headers
      expect(screen.getByText('أرصدة مدينة')).toBeInTheDocument();
      expect(screen.getByText('أرصدة دائنة')).toBeInTheDocument();

      // Switch date preset to "اليوم"
      const todayBtn = screen.getByRole('button', { name: 'اليوم' });
      fireEvent.click(todayBtn);

      await waitFor(() => {
        expect((getTrialBalanceAction as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('navigates through AccountsManagementClient tabs and loads chart of accounts', async () => {
      (getAccountsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [
          { id: 1, code: '1', name_ar: 'الأصول', is_group: 1, parent_id: null },
          { id: 2, code: '101', name_ar: 'النقدية بالصندوق', is_group: 0, parent_id: 1, current_balance: 15000 },
        ],
      });
      (getPointsOfSaleAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ id: 1, name: 'نقطة بيع الكاشير 1', code: 'POS-1', is_active: 1 }],
      });

      render(<AccountsManagementClient initialTab="chart_of_accounts" />);

      expect(await screen.findByText(/شجرة الحسابات \(Chart of Accounts\)/i)).toBeInTheDocument();
      expect(await screen.findByText('الأصول')).toBeInTheDocument();
      expect(await screen.findByText('النقدية بالصندوق')).toBeInTheDocument();

      // Switch tab to POS Management
      const posTabBtn = screen.getByRole('button', { name: /نقط البيع/i });
      fireEvent.click(posTabBtn);

      expect(await screen.findByRole('heading', { name: 'إدارة نقاط البيع' })).toBeInTheDocument();
      expect(getPointsOfSaleAction).toHaveBeenCalled();
    });
  });

  /* ==========================================================================
   * 2. HANDOVER DOMAIN (تسليم الوردية وتقفيل الدرج)
   * ========================================================================== */
  describe('2. Handover Domain (تسليم درج الوردية والمناوبة)', () => {
    const mockHandoverDetails = {
      id: 'shift-100',
      user_id: 'user-1',
      user_name: 'د. أحمد الصيدلي',
      start_time: '2026-08-27T08:00:00Z',
      starting_cash: 500,
      cash_sales: 3500,
      cash_refunds: 200,
      expenses: 100,
      expected_cash: 3700,
      credit_sales: 800,
      visa_sales: 600,
      total_sales: 4900,
    };

    const mockStaff = [
      { id: 'user-2', username: 'pharmacist_eve', full_name: 'د. سارة محمود' },
      { id: 'user-3', username: 'cashier_night', full_name: 'محمود كاشير' },
    ];

    const mockBanks = [
      { id: 'bank-1', name_ar: 'البنك الأهلي المصري' },
      { id: 'bank-2', name_ar: 'بنك مصر' },
    ];

    it('calculates cash differences, validates transfer constraints, and submits handover', async () => {
      (getHandoverDetailsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockHandoverDetails,
      });
      (getStaffAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockStaff,
      });
      (getBanksAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockBanks,
      });
      (processHandoverAction as jest.Mock).mockResolvedValue({
        success: true,
        startingCash: 200,
        difference: -50,
      });

      const onClose = jest.fn();
      render(<DrawerHandoverClient shiftId="shift-100" onClose={onClose} />);

      // Verify shift details rendering
      expect(await screen.findByText(/تسليم الوردية المشتركة/i)).toBeInTheDocument();
      expect(screen.getByText(/د. أحمد الصيدلي/i)).toBeInTheDocument();
      expect(screen.getByText('3,700')).toBeInTheDocument();

      // Find Actual Cash input and enter 3650 (50 EGP shortage)
      const inputs = screen.getAllByPlaceholderText('0.00');
      const actualCashInput = inputs[0];
      const transferAmountInput = inputs[1];

      fireEvent.change(actualCashInput, { target: { value: '3650' } });
      fireEvent.change(transferAmountInput, { target: { value: '3450' } });

      // Select Receiver
      const comboboxes = screen.getAllByRole('combobox');
      expect(comboboxes.length).toBeGreaterThanOrEqual(2);
      const receiverSelect = comboboxes[1];
      fireEvent.change(receiverSelect, { target: { value: 'pharmacist_eve' } });

      // Submit handover
      const submitBtn = screen.getByRole('button', { name: /إتمام تسليم الدرج/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(processHandoverAction).toHaveBeenCalledWith(expect.objectContaining({
          shiftId: 'shift-100',
          actualCash: 3650,
          transferAmount: 3450,
          transferTargetType: 'treasury',
          autoOpenNewShift: false,
        }));
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('blocks handover submission if transfer amount exceeds actual cash in drawer', async () => {
      (getHandoverDetailsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockHandoverDetails,
      });
      (getStaffAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockStaff,
      });
      (getBanksAction as jest.Mock).mockResolvedValue({
        success: true,
        data: mockBanks,
      });

      render(<DrawerHandoverClient shiftId="shift-100" />);

      expect(await screen.findByText(/تسليم الوردية المشتركة/i)).toBeInTheDocument();

      const inputs = screen.getAllByPlaceholderText('0.00');
      const actualCashInput = inputs[0];
      const transferAmountInput = inputs[1];

      // Set transfer (4000) > actual (3000)
      fireEvent.change(actualCashInput, { target: { value: '3000' } });
      fireEvent.change(transferAmountInput, { target: { value: '4000' } });

      const submitBtn = screen.getByRole('button', { name: /إتمام تسليم الدرج/i });
      fireEvent.click(submitBtn);

      // processHandoverAction must NOT be called due to validation guard
      expect(processHandoverAction).not.toHaveBeenCalled();
    });
  });

  /* ==========================================================================
   * 3. SHIFT MANAGEMENT DOMAIN (سجل الورديات وفتح الشفت والتقارير)
   * ========================================================================== */
  describe('3. Shift Management Domain (إدارة الورديات وسجل الشفتات النقدية)', () => {
    const mockShiftsList = [
      {
        id: 'shift-1',
        starting_cash_amount: 500,
        ending_cash_amount: 300,
        expected_cash_amount: 3750,
        actual_cash: 3800,
        transfer_amount: 3500,
        receiver_name: 'د. سارة محمود',
        cash_difference: 50, // surplus
        status: 'closed' as const,
        shift_start: '2026-08-27T08:00:00Z',
        shift_end: '2026-08-27T16:00:00Z',
        profiles: { full_name: 'د. أحمد الصيدلي', role: 'pharmacist' },
      },
      {
        id: 'shift-2',
        starting_cash_amount: 300,
        ending_cash_amount: null,
        expected_cash_amount: 340,
        actual_cash: null,
        transfer_amount: null,
        receiver_name: null,
        cash_difference: -40, // shortage
        status: 'open' as const,
        shift_start: '2026-08-27T16:00:00Z',
        shift_end: null,
        profiles: { full_name: 'د. سارة محمود', role: 'pharmacist' },
      },
    ];

    it('renders shifts history table, displays surplus/shortage badges, and handles filters', async () => {
      (getShiftsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [mockShiftsList[0]],
      });

      render(
        <ShiftManagementClient
          initialShifts={mockShiftsList}
          currentShift={null}
          hasOpenShift={false}
          suggestedStartingCash={300}
          userRole="owner"
        />
      );

      // Verify table rows and audit data
      expect(screen.getByText('د. أحمد الصيدلي')).toBeInTheDocument();
      expect(screen.getAllByText('د. سارة محمود').length).toBeGreaterThanOrEqual(1);

      // Check surplus badge (زيادة)
      expect(screen.getByText(/\(زيادة\)/)).toBeInTheDocument();

      // Check shortage badge (عجز)
      expect(screen.getByText(/\(عجز\)/)).toBeInTheDocument();

      // Filter by status dropdown
      const statusSelect = screen.getByRole('combobox');
      fireEvent.change(statusSelect, { target: { value: 'closed' } });

      await waitFor(() => {
        expect(getShiftsAction).toHaveBeenCalledWith({ status: 'closed' });
      });
    });

    it('supports opening a new shift with pre-filled suggested starting cash', async () => {
      (openShiftAction as jest.Mock).mockResolvedValue({
        success: true,
        shift_id: 'new-shift-99',
      });

      render(
        <ShiftManagementClient
          initialShifts={mockShiftsList}
          currentShift={null}
          hasOpenShift={false}
          suggestedStartingCash={350}
          userRole="owner"
        />
      );

      // Pre-filled starting cash input
      const cashInput = screen.getByPlaceholderText('أدخل المبلغ النقدي الافتتاحي');
      expect(cashInput).toHaveValue(350);

      const openBtn = screen.getByRole('button', { name: 'فتح شفت جديد' });
      fireEvent.click(openBtn);

      await waitFor(() => {
        expect(openShiftAction).toHaveBeenCalledWith(expect.objectContaining({
          starting_cash_amount: 350,
        }));
      });
    });
  });

  /* ==========================================================================
   * 4. RECEIPTS & INVOICES DOMAIN (سجل الفواتير والطباعة والواتساب)
   * ========================================================================== */
  describe('4. Receipts & Invoices Domain (سجل الفواتير وتفاصيل الإيصال الحراري)', () => {
    const mockInvoices = [
      {
        id: 'INV-2026-0001',
        total_amount: 250,
        created_at: '2026-08-27T10:00:00Z',
        profiles: { full_name: 'أحمد الصيدلي' },
        patients: { full_name: 'خالد مصطفى', phone: '01012345678' },
        sales_items: [
          {
            quantity_sold: 2,
            unit_price: 125,
            inventory: {
              master_drugs: { trade_name: 'فيتامين د 50000' },
            },
          },
        ],
      },
    ];

    it('filters receipts, triggers direct print, and formats WhatsApp sharing link', async () => {
      (getConfigAction as jest.Mock).mockResolvedValue({ value: 'صيدلية النخبة' });

      render(<ReceiptListClient initialInvoices={mockInvoices} />);

      expect(await screen.findByText('#INV-2026')).toBeInTheDocument();
      expect(screen.getByText('خالد مصطفى')).toBeInTheDocument();
      expect(screen.getByText('250 ج.م')).toBeInTheDocument();

      // Trigger Print
      const printBtn = screen.getByTitle('طباعة');
      fireEvent.click(printBtn);

      expect(generateReceiptHtml).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'INV-2026-0001' }),
        expect.any(Object)
      );
      expect(printHtmlContent).toHaveBeenCalledWith('<html>receipt</html>');

      // Trigger WhatsApp
      const windowOpenSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
      const whatsappBtn = screen.getByTitle('واتساب');
      fireEvent.click(whatsappBtn);

      expect(generateWhatsAppMessage).toHaveBeenCalled();
      expect(windowOpenSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://wa.me/201012345678'),
        '_blank'
      );
    });

    it('renders ReceiptDetailsModal with line items, breakdown, and barcode display', () => {
      const onClose = jest.fn();

      render(
        <ReceiptDetailsModal
          invoice={{
            id: 'INV-2026-8888',
            created_at: '2026-08-27T11:00:00Z',
            total_amount: 180,
            payment_method: 'cash',
            profiles: { full_name: 'د. محمود' },
            patients: { full_name: 'ياسر كمال', phone: '01000000000' },
            sales_items: [
              {
                quantity_sold: 3,
                unit_price: 60,
                unit: 'large',
                inventory: {
                  master_drugs: {
                    trade_name: 'كونجستال أقراص',
                    trade_name_en: 'Congestal',
                  },
                },
              },
            ],
          } as any}
          onClose={onClose}
        />
      );

      expect(screen.getByText('فاتورة مبيعات')).toBeInTheDocument();
      expect(screen.getByText('Congestal')).toBeInTheDocument();
      expect(screen.getByText('نقدي (Cash)')).toBeInTheDocument();
      expect(screen.getByText('180')).toBeInTheDocument();
    });
  });
});
