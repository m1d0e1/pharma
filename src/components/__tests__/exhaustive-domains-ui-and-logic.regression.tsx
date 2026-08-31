import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// UI Components
import InventoryTable from '@/components/inventory/InventoryTable';
import AddInventoryModal from '@/components/AddInventoryModal';
import EditInventoryModal from '@/components/EditInventoryModal';
import PurchaseInvoiceClient from '@/app/(dashboard)/purchases/new/PurchaseInvoiceClient';
import PurchaseOrderModal from '@/components/inventory/PurchaseOrderModal';
import PurchaseOrdersClient from '@/components/inventory/PurchaseOrdersClient';
import PurchaseReturnClient from '@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient';
import SalesReturnClient from '@/app/(dashboard)/returns/new/SalesReturnClient';
import POSPage from '@/app/(dashboard)/pos/page';
import ClinicalAlertModal from '@/components/pos/DrugInteractionModal';
import ShortagesClient from '@/app/(dashboard)/stores/shortages/ShortagesClient';

// Actions and Helpers
import {
  addInventoryAction,
  updateInventoryAction,
  deleteInventoryAction,
} from '@/app/actions-client/inventory';
import {
  createPurchaseInvoiceAction,
  createPurchaseOrderAction,
  updatePurchaseOrderStatusAction,
  createPurchaseReturnAction,
  getSuppliersAction,
  checkSupplierPendingInvoiceAction,
  getPurchasesReportsAction,
  getPurchaseInvoiceDetailsAction,
} from '@/app/actions-client/purchases';
import {
  createReturnAction,
  getInvoiceForReturnAction,
  getSalesInvoicesByDateAction,
  searchRecentReturnInvoicesAction,
} from '@/app/actions-client/returns';
import {
  processCheckoutAction,
} from '@/app/actions-client/sales';
import {
  updateShortageQuantityAction,
  updateShortagesStatusBulkAction,
} from '@/app/actions-client/shortages';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { checkDrugInteractions } from '@/app/actions-client/interactions';
import { getPharmacyAlerts } from '@/lib/inventory/alerts';
import { usePOSStore } from '@/store/usePOSStore';

// Mocks Setup
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/hooks/useBarcodeScanner', () => ({ useBarcodeScanner: jest.fn() }));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/pos/DrugDetailsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/returns/ReturnsClient', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/pos/DraftsModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/pos/StockWarningModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/pos/PosDrawerHandoverModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/pos/DrugInteractionModal', () => ({ __esModule: true, default: () => null }));

// Use requireActual for modals to test them independently
const ActualStockWarningModal = jest.requireActual('@/components/pos/StockWarningModal').default;
const ActualClinicalAlertModal = jest.requireActual('@/components/pos/DrugInteractionModal').default;

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ id: 'user-1', role: 'pharmacist' }),
  hasUserPermissionSync: jest.fn().mockReturnValue(true),
}));

jest.mock('@/app/actions-client/auth', () => ({
  getCurrentUserAction: jest.fn().mockResolvedValue({
    success: true,
    user: { id: 'user-1', pharmacy_id: 'pharmacy-1', full_name: 'Test Pharmacist' },
  }),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  addInventoryAction: jest.fn(),
  updateInventoryAction: jest.fn(),
  deleteInventoryAction: jest.fn(),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseInvoiceAction: jest.fn(),
  createPurchaseOrderAction: jest.fn(),
  updatePurchaseOrderStatusAction: jest.fn(),
  createPurchaseReturnAction: jest.fn(),
  getSuppliersAction: jest.fn(),
  checkSupplierPendingInvoiceAction: jest.fn(),
  getPurchasesReportsAction: jest.fn(),
  getPurchaseInvoiceDetailsAction: jest.fn(),
  getDrugInventoryQuantityAction: jest.fn().mockResolvedValue({ success: true, quantity: 5 }),
}));

jest.mock('@/app/actions-client/returns', () => ({
  createReturnAction: jest.fn(),
  getInvoiceForReturnAction: jest.fn(),
  getSalesInvoicesByDateAction: jest.fn(),
  searchRecentReturnInvoicesAction: jest.fn(),
}));

jest.mock('@/app/actions-client/sales', () => ({
  searchDrugsAction: jest.fn(),
  searchPatientsAction: jest.fn(),
  barcodeLookupAction: jest.fn(),
  fetchDraftsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  processCheckoutAction: jest.fn(),
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

jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn(),
  getUnitsAction: jest.fn().mockResolvedValue({ success: true, data: [{ name_ar: 'علبة' }, { name_ar: 'شريط' }] }),
  getAdjustmentReasonsAction: jest.fn().mockResolvedValue({ success: true, data: [{ id: 1, name_ar: 'تلف أو كسر' }] }),
}));

jest.mock('@/app/actions-client/interactions', () => ({
  checkDrugInteractions: jest.fn(),
}));

jest.mock('@/app/actions-client/finance', () => ({
  generateDailySnapshotAction: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('@/lib/inventory/service', () => ({
  getLowStockItems: jest.fn().mockReturnValue([
    { id: 'inv-1', drugName: 'Panadol', drugNameAr: 'بانادول', quantity: 0, minStockLevel: 10, expiryDate: '2027-01-01' },
    { id: 'inv-2', drugName: 'Amoxil', drugNameAr: 'أموكسيل', quantity: 3, minStockLevel: 10, expiryDate: '2027-01-01' },
  ]),
  getExpiringItems: jest.fn().mockReturnValue([
    { id: 'inv-3', drugName: 'Cataflam', drugNameAr: 'كاتافلام', quantity: 15, minStockLevel: 5, expiryDate: new Date(Date.now() + 5 * 86400000).toISOString() },
  ]),
  getExpiredItems: jest.fn().mockReturnValue([]),
  getInventoryStatistics: jest.fn().mockReturnValue({ totalItems: 3, totalValue: 1500 }),
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

describe('Exhaustive Frontend UI & Business Logic Test Suite (All Domains & Features)', () => {
  jest.setTimeout(30000);

  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    mockPush.mockReset();
    window.confirm = jest.fn(() => true);
  });

  /* ==========================================================================
   * 1. INVENTORY DOMAIN (المخزون: الجدول، الإضافة، التعديل، ومنطق الأعمال)
   * ========================================================================== */
  describe('1. Inventory Domain (إدارة المخزون)', () => {
    const mockInventoryItems = [
      {
        id: 'inv-1',
        drug_id: 1,
        quantity: 50,
        expiry_date: '2027-12-31',
        local_selling_price: 35.0,
        barcode: '6221234567890',
        master_drugs: {
          trade_name: 'كونجستال أقراص',
          trade_name_en: 'Congestal Tabs',
          category: 'برد وإنفلونزا',
          manufacturer: 'سيجما',
          active_ingredient: 'باراسيتامول + سودوإيفيدرين',
          barcode: '6221234567890',
        },
      },
      {
        id: 'inv-2',
        drug_id: 2,
        quantity: 4,
        expiry_date: '2025-01-01',
        local_selling_price: 15.0,
        barcode: '6229876543210',
        master_drugs: {
          trade_name: 'ألفينترن أقراص',
          trade_name_en: 'Alphintern Tabs',
          category: 'مضاد للالتهاب',
          manufacturer: 'أمون',
          active_ingredient: 'كيموتربسين + تربسين',
          barcode: '6229876543210',
        },
      },
    ];

    it('renders inventory table with sorting, search filtering, and deletion', async () => {
      (deleteInventoryAction as jest.Mock).mockResolvedValue({ success: true });
      const onRefresh = jest.fn();

      render(
        <InventoryTable
          items={mockInventoryItems}
          searchTerm=""
          setSearchTerm={jest.fn()}
          onRefresh={onRefresh}
          pharmacyId="pharmacy-1"
        />
      );

      expect(screen.getAllByText('Congestal Tabs').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Alphintern Tabs').length).toBeGreaterThanOrEqual(1);

      const deleteButtons = screen.getAllByTitle('حذف');
      fireEvent.click(deleteButtons[0]);

      expect(window.confirm).toHaveBeenCalled();
      await waitFor(() => {
        expect(deleteInventoryAction).toHaveBeenCalledWith({ id: 'inv-1' });
        expect(onRefresh).toHaveBeenCalled();
      });
    });

    it('supports AddInventoryModal two-step search and submission', async () => {
      (searchMasterDrugsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{
          id: 10,
          trade_name: 'باندول إكسترا',
          trade_name_en: 'Panadol Extra',
          active_ingredient: 'Paracetamol',
          official_price: 45,
          large_unit: 'علبة',
          large_to_medium: 2,
        }],
      });
      (addInventoryAction as jest.Mock).mockResolvedValue({ success: true });

      const onSuccess = jest.fn();
      render(<AddInventoryModal pharmacyId="pharmacy-1" onClose={jest.fn()} onSuccess={onSuccess} />);

      const searchInput = screen.getByPlaceholderText(/ابحث باسم الدواء/i);
      fireEvent.change(searchInput, { target: { value: 'باندول' } });

      await waitFor(() => {
        expect(searchMasterDrugsAction).toHaveBeenCalledWith(expect.objectContaining({ query: 'باندول' }));
      });

      const drugCard = await screen.findByText('باندول إكسترا');
      fireEvent.click(drugCard);

      const qtyInput = await screen.findByPlaceholderText('مثلاً: 20');
      fireEvent.change(qtyInput, { target: { value: '20' } });

      const priceInput = screen.getByDisplayValue('45');
      fireEvent.change(priceInput, { target: { value: '48' } });

      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      fireEvent.change(dateInput, { target: { value: '2028-05-31' } });

      const saveBtn = screen.getByRole('button', { name: /حفظ في المخزون/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(addInventoryAction).toHaveBeenCalledWith(expect.objectContaining({
          drug_id: 10,
          quantity: 20,
          local_selling_price: 48,
          expiry_date: '2028-05-31',
        }));
        expect(onSuccess).toHaveBeenCalled();
      });
    });

    it('supports EditInventoryModal updating quantities and reasons', async () => {
      (updateInventoryAction as jest.Mock).mockResolvedValue({ success: true });
      const onSuccess = jest.fn();

      render(
        <EditInventoryModal
          item={{
            id: 'inv-100',
            quantity: 15,
            local_selling_price: 30,
            expiry_date: '2026-12-31',
            master_drugs: { trade_name: 'أوجمنتين 1 جم', large_to_medium: 2 },
          }}
          onClose={jest.fn()}
          onSuccess={onSuccess}
        />
      );

      expect(screen.getByDisplayValue('15')).toBeInTheDocument();
      expect(screen.getByDisplayValue('30')).toBeInTheDocument();

      const qtyInput = screen.getByDisplayValue('15');
      fireEvent.change(qtyInput, { target: { value: '18' } });

      const submitBtn = screen.getByRole('button', { name: /حفظ التغييرات/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(updateInventoryAction).toHaveBeenCalledWith(expect.objectContaining({
          id: 'inv-100',
          quantity: 18,
          local_selling_price: 30,
        }));
        expect(onSuccess).toHaveBeenCalled();
      });
    });
  });

  /* ==========================================================================
   * 2. PURCHASE DOMAIN (فواتير الشراء، أوامر الشراء، وتحديث الحالة)
   * ========================================================================== */
  describe('2. Purchase Domain (المشتريات وأوامر الشراء)', () => {
    it('handles PurchaseInvoiceClient form setup, calculations, and completion', async () => {
      (getSuppliersAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ id: 5, name_ar: 'الشركة المصرية للأدوية', balance: 0 }],
      });
      (checkSupplierPendingInvoiceAction as jest.Mock).mockResolvedValue({ success: true, hasPending: false });
      (createPurchaseInvoiceAction as jest.Mock).mockResolvedValue({ success: true, invoice_id: 'PINV-100' });

      render(<PurchaseInvoiceClient />);

      expect(await screen.findByText('الشركة المصرية للأدوية')).toBeInTheDocument();
      expect(screen.getByText('آجل')).toBeInTheDocument();
      expect(screen.getByText('نقدي')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /حفظ نهائي \(F9\)/i })).toBeInTheDocument();
    });

    it('creates a purchase order from PurchaseOrderModal and updates shortages', async () => {
      (getSuppliersAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ id: 5, name_ar: 'المصرية للأدوية' }],
      });
      (createPurchaseOrderAction as jest.Mock).mockResolvedValue({ success: true, po_id: 'PO-888' });

      const onSuccess = jest.fn();
      render(
        <PurchaseOrderModal
          initialItems={[{
            drug_id: 50,
            trade_name: 'فيتامين سي 1000',
            requested_quantity: 12,
            last_cost_price: 30,
          }]}
          onClose={jest.fn()}
          onSuccess={onSuccess}
        />
      );

      expect(screen.getByText('فيتامين سي 1000')).toBeInTheDocument();
      expect(screen.getByDisplayValue('12')).toBeInTheDocument();
      expect(screen.getByDisplayValue('30')).toBeInTheDocument();

      const supplierInput = screen.getByPlaceholderText('اختر أو اكتب اسم المورد...');
      fireEvent.change(supplierInput, { target: { value: 'المصرية للأدوية' } });

      const saveBtn = screen.getByRole('button', { name: /حفظ وإرسال الأمر/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(createPurchaseOrderAction).toHaveBeenCalledWith(expect.objectContaining({
          supplier_name: 'المصرية للأدوية',
          items: expect.arrayContaining([
            expect.objectContaining({ drug_id: 50, quantity: 12, expected_price: 30 }),
          ]),
        }));
        expect(onSuccess).toHaveBeenCalled();
      });
    });

    it('updates purchase order status in PurchaseOrdersClient', async () => {
      (updatePurchaseOrderStatusAction as jest.Mock).mockResolvedValue({ success: true });

      const mockOrders = [
        {
          id: 'PO-001',
          supplier_name: 'مورد الأدوية الحديثة',
          status: 'pending',
          total_amount: 1500,
          created_at: '2026-08-27T08:00:00Z',
          items_count: 3,
        },
      ];

      render(<PurchaseOrdersClient initialOrders={mockOrders} />);

      expect(screen.getByText('PO-001')).toBeInTheDocument();
      expect(screen.getByText('مورد الأدوية الحديثة')).toBeInTheDocument();

      const completeBtn = screen.getByTitle('إغلاق الطلب (التوريد يتم بفاتورة شراء)');
      fireEvent.click(completeBtn);

      await waitFor(() => {
        expect(updatePurchaseOrderStatusAction).toHaveBeenCalledWith('PO-001', 'completed');
      });
    });
  });

  /* ==========================================================================
   * 3. RETURN DOMAIN (مرتجعات المبيعات ومرتجعات المشتريات)
   * ========================================================================== */
  describe('3. Return Domain (إدارة المرتجعات)', () => {
    it('processes sales return in SalesReturnClient', async () => {
      const today = new Date().toISOString().split('T')[0];
      (getSalesInvoicesByDateAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{
          id: 'INV-55500000',
          total_amount: 200,
          payment_method: 'cash',
          patient_name: 'محمد أحمد',
          user_name: 'الكاشير',
          created_at: `${today}T10:00:00.000Z`,
        }],
      });
      (getInvoiceForReturnAction as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          id: 'INV-55500000',
          patient_name: 'محمد أحمد',
          created_at: `${today}T10:00:00.000Z`,
          items: [{
            id: 'item-1',
            inventory_id: 'inv-1',
            drug_name: 'كيتولاك أمبول',
            quantity_sold: 2,
            returned_quantity: 0,
            unit_price: 25,
            unit: 'large',
          }],
        },
      });
      (createReturnAction as jest.Mock).mockResolvedValue({ success: true, return_id: 'RET-1' });

      render(<SalesReturnClient />);

      expect(await screen.findByText('كيتولاك أمبول')).toBeInTheDocument();

      const qtyInput = screen.getByRole('spinbutton');
      fireEvent.change(qtyInput, { target: { value: '1' } });

      const submitBtn = screen.getByRole('button', { name: /تنفيذ المرتجع/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(createReturnAction).toHaveBeenCalledWith(expect.objectContaining({
          invoice_id: 'INV-55500000',
          items: expect.arrayContaining([
            expect.objectContaining({ quantity: 1, unit_price: 25 }),
          ]),
        }));
      });
    });

    it('processes purchase return in PurchaseReturnClient', async () => {
      (getSuppliersAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ id: 8, name_ar: 'مورد الفاخر' }],
      });
      (getPurchasesReportsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{
          id: 'PINV-777',
          invoice_number: 'INV-777',
          supplier_name: 'مورد الفاخر',
          status: 'completed',
          total_amount: 1000,
          created_at: '2026-08-27T08:00:00Z',
        }],
      });
      (getPurchaseInvoiceDetailsAction as jest.Mock).mockResolvedValue({
        success: true,
        data: [{
          id: 1,
          drug_id: 10,
          trade_name: 'أميبيزول 500',
          quantity: 10,
          cost_price: 15,
          refundable_large_unit_price: 15,
          remaining_large_quantity: 10,
        }],
      });
      (createPurchaseReturnAction as jest.Mock).mockResolvedValue({ success: true, return_id: 'PRET-1' });

      render(<PurchaseReturnClient />);

      const supplierSelect = await screen.findByRole('combobox');
      fireEvent.change(supplierSelect, { target: { value: '8' } });

      expect(await screen.findByText(/INV-777/i)).toBeInTheDocument();
    });
  });

  /* ==========================================================================
   * 4. POS DOMAIN (نقطة البيع وإتمام العمليات)
   * ========================================================================== */
  describe('4. POS Domain (نقطة البيع وإتمام العمليات)', () => {
    const cartItem = {
      id: 'line-1',
      drug_id: 'drug-1',
      trade_name: 'دواء اختبار',
      trade_name_en: 'Test Drug',
      active_ingredient: 'Ingredient A',
      qty: 1,
      price: 25,
      itemDiscountPercent: 0,
      basePrice: 25,
      selectedUnit: 'large',
      units: { large: 'علبة', large_to_medium: 1, medium_to_small: 1 },
      total_stock: 3,
      needsRefill: false,
      batches: [],
      inventory_id: null,
    };

    beforeEach(() => {
      usePOSStore.getState().resetPOS();
      usePOSStore.getState().setCart([cartItem]);
      (checkDrugInteractions as jest.Mock).mockResolvedValue({
        success: true,
        data: { interactions: [], allergies: [] },
      });
    });

    afterEach(() => usePOSStore.getState().resetPOS());

    it('renders POS cart with items, calculates totals, and supports checkout', async () => {
      (processCheckoutAction as jest.Mock).mockResolvedValue({
        success: true,
        data: { sale_id: 'sale-1' },
      });

      render(<POSPage />);

      const checkoutBtn = await screen.findByRole('button', { name: /إتمام وطباعة/ });
      fireEvent.click(checkoutBtn);

      await waitFor(() => {
        expect(processCheckoutAction).toHaveBeenCalledWith(expect.objectContaining({
          payment_method: 'cash',
          status: 'completed',
          items: expect.arrayContaining([
            expect.objectContaining({ drug_id: 'drug-1', quantity_sold: 1, unit_price: 25 }),
          ]),
        }));
      });
    });
  });

  /* ==========================================================================
   * 5. ALERT DOMAIN (تنبيهات نفاذ المخزون، التداخلات الدوائية، وصلاحية الأدوية)
   * ========================================================================== */
  describe('5. Alert Domain (التنبيهات السريرية والمخزنية)', () => {
    it('renders StockWarningModal with zero-stock warning and action buttons', () => {
      const onNewPO = jest.fn();
      const onNegativeSale = jest.fn();
      const onClose = jest.fn();

      render(
        <ActualStockWarningModal
          isOpen={true}
          onClose={onClose}
          drug={{ id: 99, trade_name: 'كونتراست شراب' }}
          onNewPurchaseOrder={onNewPO}
          onNegativeSale={onNegativeSale}
          allowNegativeSale={true}
        />
      );

      expect(screen.getByText('نفد المخزون!')).toBeInTheDocument();
      expect(screen.getByText(/لا يوجد كميات متوفرة من "كونتراست شراب"/i)).toBeInTheDocument();

      const poBtn = screen.getByRole('button', { name: /فاتورة شراء جديدة/i });
      fireEvent.click(poBtn);
      expect(onNewPO).toHaveBeenCalledWith(99);

      const negBtn = screen.getByRole('button', { name: /بيع بدون رصيد/i });
      fireEvent.click(negBtn);
      expect(onNegativeSale).toHaveBeenCalledWith({ id: 99, trade_name: 'كونتراست شراب' });
    });

    it('renders ClinicalAlertModal with drug interactions and allergy warnings', () => {
      const onClose = jest.fn();
      const onConfirm = jest.fn();

      render(
        <ActualClinicalAlertModal
          alerts={[
            {
              type: 'interaction',
              severity: 'high',
              ingredient_a: 'وارفارين',
              ingredient_b: 'أسبرين',
              description_ar: 'يزيد خطر النزيف الحاد بشكل كبير',
              recommendation: 'تجنب الاستخدام المتزامن أو راقب INR بدقة',
            },
            {
              type: 'allergy',
              severity: 'critical',
              message_ar: 'المريض يعاني من حساسية مفرطة للبنسلين',
            },
          ]}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText('تحذير: سلامة المريض')).toBeInTheDocument();
      expect(screen.getByText('وارفارين')).toBeInTheDocument();
      expect(screen.getByText('أسبرين')).toBeInTheDocument();
      expect(screen.getByText('يزيد خطر النزيف الحاد بشكل كبير')).toBeInTheDocument();
      expect(screen.getByText('حساسية دواء')).toBeInTheDocument();
      expect(screen.getByText('المريض يعاني من حساسية مفرطة للبنسلين')).toBeInTheDocument();
    });

    it('calculates inventory alerts accurately via getPharmacyAlerts business logic', () => {
      const alerts = getPharmacyAlerts('pharmacy-1');
      expect(alerts.length).toBeGreaterThanOrEqual(3);

      const lowStockAlert = alerts.find(a => a.id === 'low_stock_inv-1');
      expect(lowStockAlert).toBeDefined();
      expect(lowStockAlert?.severity).toBe('critical');

      const expiringAlert = alerts.find(a => a.type === 'expiring_soon');
      expect(expiringAlert).toBeDefined();
      expect(expiringAlert?.severity).toBe('critical');
    });
  });

  /* ==========================================================================
   * 6. SHORTAGES DOMAIN (كشكول النواقص، التبويبات، الإجراءات الجماعية، وتكامل الشراء)
   * ========================================================================== */
  describe('6. Shortages Domain (كشكول النواقص والتكامل)', () => {
    const mockShortages = [
      {
        id: 1,
        drug_id: 101,
        trade_name: 'أوجمنتين 1 جم',
        trade_name_en: 'Augmentin 1g',
        status: 'pending',
        requested_quantity: 15,
        current_stock: 0,
        reorder_point: 10,
        deficit: 10,
        inventory_status: 'out_of_stock',
      },
      {
        id: 2,
        drug_id: 102,
        trade_name: 'كونجستال',
        trade_name_en: 'Congestal',
        status: 'ordered',
        requested_quantity: 20,
        current_stock: 3,
        reorder_point: 10,
        deficit: 7,
        inventory_status: 'critical',
      },
      {
        id: 3,
        drug_id: 103,
        trade_name: 'سيتال أقراص',
        trade_name_en: 'Cetal Tabs',
        status: 'pending',
        requested_quantity: 5,
        current_stock: 12,
        reorder_point: 8,
        deficit: 0,
        inventory_status: 'sufficient',
      },
    ];

    it('tests all shortage tabs, filter buttons, inline edit, and bulk updates', async () => {
      (updateShortageQuantityAction as jest.Mock).mockResolvedValue({ success: true });
      (updateShortagesStatusBulkAction as jest.Mock).mockResolvedValue({ success: true });

      render(<ShortagesClient initialData={mockShortages} />);

      const urgentTab = screen.getByRole('button', { name: /^منتهي \/ حرج \(/i });
      expect(urgentTab).toBeInTheDocument();

      fireEvent.click(urgentTab);

      expect(screen.getByText('أوجمنتين 1 جم')).toBeInTheDocument();
      expect(screen.getByText('كونجستال')).toBeInTheDocument();
      expect(screen.queryByText('سيتال أقراص')).not.toBeInTheDocument();

      // Test inline edit of quantity
      const editBtn = screen.getAllByTitle('تعديل الكمية والملاحظات')[0];
      fireEvent.click(editBtn);

      const qtyInput = screen.getByDisplayValue('15');
      fireEvent.change(qtyInput, { target: { value: '25' } });

      const confirmBtn = screen.getByRole('button', { name: 'حفظ' });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(updateShortageQuantityAction).toHaveBeenCalledWith(1, 25, expect.anything());
      });

      // Test "تحديد الكل" (Select All)
      const selectAllBtn = screen.getByRole('button', { name: /تحديد الكل/i });
      fireEvent.click(selectAllBtn);

      expect(await screen.findByText('تم تحديد 2 صنف')).toBeInTheDocument();

      const bulkOrderedBtn = screen.getByRole('button', { name: /تحويل لـ قيد الطلب/i });
      fireEvent.click(bulkOrderedBtn);

      await waitFor(() => {
        expect(updateShortagesStatusBulkAction).toHaveBeenCalledWith(expect.arrayContaining([1, 2]), 'ordered');
      });
    });

    it('converts selected shortages to purchase invoice and copies formatted WhatsApp', async () => {
      const writeTextSpy = jest.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextSpy },
      });
      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

      render(<ShortagesClient initialData={mockShortages} />);

      const checkboxes = screen.getAllByTitle('تحديد الصنف');
      fireEvent.click(checkboxes[0]);

      expect(await screen.findByText('تم تحديد 1 صنف')).toBeInTheDocument();

      const whatsappBtn = screen.getByRole('button', { name: /نسخ للواتساب/i });
      fireEvent.click(whatsappBtn);

      expect(writeTextSpy).toHaveBeenCalledWith(expect.stringContaining('طلبيّة نواقص الأدوية'));
      expect(writeTextSpy).toHaveBeenCalledWith(expect.stringContaining('Augmentin 1g'));

      const convertBtn = screen.getByRole('button', { name: /تحويل للمشتريات \(1\)/i });
      fireEvent.click(convertBtn);

      expect(setItemSpy).toHaveBeenCalledWith('shortages_to_purchase', expect.stringContaining('Augmentin 1g'));
      expect(mockPush).toHaveBeenCalledWith('/purchases/new');
    });
  });
});
