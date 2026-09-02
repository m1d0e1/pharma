import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LowStockClient, { LowStockItem } from '@/app/(dashboard)/inventory/low-stock/LowStockClient';
import ReorderAlerts from '@/components/dashboard/ReorderAlerts';
import { addToShortagesAction } from '@/app/actions-client/shortages';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { toast } from 'react-hot-toast';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/app/actions-client/shortages', () => ({
  addToShortagesAction: jest.fn().mockResolvedValue({ success: true, data: { created: true } }),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getLowStockAction: jest.fn(),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  createPurchaseOrderAction: jest.fn().mockResolvedValue({ success: true, id: 1 }),
  getDrugInventoryQuantityAction: jest.fn().mockResolvedValue({ success: true, data: 0 }),
  getSuppliersAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('@/app/actions-client/master-drugs', () => ({
  searchMasterDrugsAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
  toast: { error: jest.fn(), success: jest.fn() },
}));

describe('low stock alert multi-selection and bulky actions ui', () => {
  const mockItems: LowStockItem[] = [
    {
      id: 1,
      drug_id: 101,
      quantity: 0,
      local_selling_price: 35,
      trade_name: 'بانادول اكسترا',
      trade_name_en: 'Panadol Extra',
      active_ingredient: 'Paracetamol + Caffeine',
      official_price: 25,
      manufacturer: 'GSK',
      barcode: '62210001',
      reorder_point: 10,
      default_purchase_qty: 20,
      deficit: 10,
      status: 'out_of_stock'
    },
    {
      id: 2,
      drug_id: 102,
      quantity: 2,
      local_selling_price: 20,
      trade_name: 'كونجستال اقراص',
      trade_name_en: 'Congestal Tab',
      active_ingredient: 'Paracetamol + Chlorpheniramine',
      official_price: 15,
      manufacturer: 'SIGMA',
      barcode: '62210002',
      reorder_point: 15,
      default_purchase_qty: 10,
      deficit: 13,
      status: 'critical'
    },
    {
      id: 3,
      drug_id: 103,
      quantity: 8,
      local_selling_price: 45,
      trade_name: 'كاتافلام 50مجم',
      trade_name_en: 'Cataflam 50mg',
      active_ingredient: 'Diclofenac Potassium',
      official_price: 35,
      manufacturer: 'Novartis',
      barcode: '62210003',
      reorder_point: 10,
      default_purchase_qty: 15,
      deficit: 2,
      status: 'low'
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all low stock items with bulk toolbar buttons', () => {
    render(<LowStockClient initialItems={mockItems} />);

    expect(screen.getByText('تحديد الكل (3)')).toBeInTheDocument();
    expect(screen.getByText('إضافة الكل للكشكول (3)')).toBeInTheDocument();
    expect(screen.getByText('إنشاء أمر شراء (3)')).toBeInTheDocument();
    expect(screen.getByText('تحويل للمشتريات (3)')).toBeInTheDocument();
    expect(screen.getByText('تصدير Excel')).toBeInTheDocument();
    expect(screen.getByText('نسخ للواتساب')).toBeInTheDocument();
  });

  it('handles select all and activates floating bulk action bar', async () => {
    render(<LowStockClient initialItems={mockItems} />);

    const selectAllBtn = screen.getByText('تحديد الكل (3)');
    fireEvent.click(selectAllBtn);

    expect(screen.getByText('إلغاء تحديد الكل')).toBeInTheDocument();
    expect(screen.getByText('تم تحديد 3 صنف')).toBeInTheDocument();
    expect(screen.getByText('إضافة للكشكول (3)')).toBeInTheDocument();
  });

  it('performs bulk add to shortages notebook for selected items', async () => {
    render(<LowStockClient initialItems={mockItems} />);

    // Select all
    fireEvent.click(screen.getByText('تحديد الكل (3)'));

    // Click bulk add in floating bar
    const bulkAddBtn = screen.getByText('إضافة للكشكول (3)');
    fireEvent.click(bulkAddBtn);

    await waitFor(() => {
      expect(addToShortagesAction).toHaveBeenCalledTimes(3);
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('تمت إضافة وتحديث 3 صنف في كشكول النواقص'));
    });
  });

  it('converts selected items to purchase invoice and navigates to purchases/new', async () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    render(<LowStockClient initialItems={mockItems} />);

    // Select all
    fireEvent.click(screen.getByText('تحديد الكل (3)'));

    const convertBtn = screen.getByText('فاتورة مشتريات (3)');
    fireEvent.click(convertBtn);

    expect(setItemSpy).toHaveBeenCalledWith('shortages_to_purchase', expect.stringContaining('Panadol Extra'));
    expect(mockPush).toHaveBeenCalledWith('/purchases/new');
  });

  it('copies formatted text for WhatsApp to clipboard', async () => {
    const writeTextMock = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<LowStockClient initialItems={mockItems} />);

    const copyBtn = screen.getByText('نسخ للواتساب');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('تم نسخ 3 صنف للحافظة'));
    });
  });

  it('supports multi-selection and bulk actions in ReorderAlerts dashboard widget', async () => {
    (getLowStockAction as jest.Mock).mockResolvedValue({
      success: true,
      data: mockItems.map(i => ({
        drug_id: i.drug_id,
        trade_name: i.trade_name,
        trade_name_en: i.trade_name_en,
        current_stock: i.quantity,
        reorder_point: i.reorder_point,
        deficit: i.deficit,
        avg_monthly_usage: 5,
        default_purchase_qty: i.default_purchase_qty,
        official_price: i.official_price,
      })),
    });

    render(<ReorderAlerts />);

    await waitFor(() => {
      expect(screen.getByText('تنبيهات إعادة الطلب')).toBeInTheDocument();
      expect(screen.getByText('تحديد الكل')).toBeInTheDocument();
    });

    // Click select all
    fireEvent.click(screen.getByText('تحديد الكل'));

    // Verify floating action bar in widget appears
    expect(screen.getByText('صنف محدد')).toBeInTheDocument();
    expect(screen.getByText('إضافة للكشكول')).toBeInTheDocument();
    expect(screen.getByText('تحويل للمشتريات')).toBeInTheDocument();
    expect(screen.getByText('واتساب')).toBeInTheDocument();

    // Click bulk add to notebook
    fireEvent.click(screen.getByText('إضافة للكشكول'));

    await waitFor(() => {
      expect(addToShortagesAction).toHaveBeenCalledTimes(3);
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('تمت إضافة 3 صنف إلى كشكول النواقص بنجاح'));
    });
  });

  it('hides every current reorder alert without deleting data and restores them from inventory refresh', async () => {
    (getLowStockAction as jest.Mock).mockResolvedValue({
      success: true,
      data: mockItems.map(i => ({
        ...i,
        current_stock: i.quantity,
      })),
    });

    render(<ReorderAlerts />);
    expect(await screen.findByText('Panadol Extra')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إخفاء الكل' }));
    expect(screen.getByText('تم إخفاء 3 صنف من العرض فقط')).toBeInTheDocument();
    expect(screen.queryByText('Panadol Extra')).not.toBeInTheDocument();
    expect(getLowStockAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'تحديث ومزامنة من المخزون' }));
    await waitFor(() => expect(getLowStockAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Panadol Extra')).toBeInTheDocument();
  });
});
