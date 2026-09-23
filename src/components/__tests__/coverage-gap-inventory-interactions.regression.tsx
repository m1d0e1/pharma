import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InventoryClientWrapper from '@/components/InventoryClientWrapper';
import InventoryTable from '@/components/inventory/InventoryTable';
import { useHotkeys } from 'react-hotkeys-hook';
import { deleteInventoryAction, importInventoryWorkbookAction } from '@/app/actions-client/inventory';
import { secureCache } from '@/lib/cache/secure_cache';

const mockRefresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: jest.fn() }),
}));

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-to-print', () => ({ useReactToPrint: jest.fn(() => jest.fn()) }));

jest.mock('@/components/AddInventoryModal', () => function MockAddInventoryModal({ pharmacyId, onClose, onSuccess }: any) {
  return (
    <div role="dialog" aria-label="mock add inventory">
      <span>pharmacy:{pharmacyId}</span>
      <button onClick={onSuccess}>mock success</button>
      <button onClick={onClose}>mock close</button>
    </div>
  );
});

jest.mock('@/components/EditInventoryModal', () => function MockEditInventoryModal() {
  return <div data-testid="edit-inventory-modal" />;
});

jest.mock('@/components/pos/DrugDetailsModal', () => function MockDrugDetailsModal() {
  return <div data-testid="drug-details-modal" />;
});

jest.mock('@/app/actions-client/inventory', () => ({
  deleteInventoryAction: jest.fn(),
  importInventoryWorkbookAction: jest.fn(),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { reload: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('xlsx', () => ({
  read: jest.fn(() => ({
    SheetNames: ['inventory', 'master_drugs'],
    Sheets: {
      inventory: { kind: 'inventory' },
      master_drugs: { kind: 'master_drugs' },
    },
  })),
  utils: {
    sheet_to_json: jest.fn((sheet: any) => sheet.kind === 'inventory'
      ? [{ drug_id: 10, quantity: 4 }]
      : [{ id: 10, trade_name: 'Imported Drug' }]),
  },
}));

jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), {
    loading: jest.fn(),
    dismiss: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

function hotkeyHandler(key: string) {
  const call = (useHotkeys as jest.Mock).mock.calls.find(args => args[0] === key);
  expect(call).toBeDefined();
  return call[1] as (event: { preventDefault: jest.Mock }) => void;
}

const makeInventory = () => Array.from({ length: 55 }, (_, index) => {
  const n = 55 - index;
  return {
    id: `inv-${n}`,
    drug_id: n,
    quantity: 20,
    expiry_date: '2030-12-31',
    local_selling_price: n,
    barcode: `622${String(n).padStart(5, '0')}`,
    master_drugs: {
      trade_name: `دواء ${String(n).padStart(3, '0')}`,
      trade_name_en: `Drug ${String(n).padStart(3, '0')}`,
      category: n % 2 ? 'A' : 'B',
      manufacturer: 'Test',
      active_ingredient: 'Ingredient',
    },
  };
});

describe('coverage-gap: inventory controls, hotkeys, sorting and pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('distinguishes retail value from recorded cost across batches, pages and filtered results', () => {
    const base = makeInventory()[0];
    const items = Array.from({ length: 51 }, (_, index) => ({
      ...base, id: `valued-${index}`, quantity: index === 50 ? 0.5 : 1,
      cost_price: index === 50 ? 40 : 60, local_selling_price: index === 50 ? 100 : 90,
    }));
    const props = { setSearchTerm: jest.fn(), onRefresh: jest.fn(), pharmacyId: 'ph-1', canManageInventory: false };
    const { rerender } = render(<InventoryTable {...props} items={items} searchTerm="" />);
    const money = (value: number) => value.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const retailCard = () => screen.getByText('قيمة المخزون بسعر البيع').parentElement!;
    expect(retailCard()).toHaveTextContent(money(4550));
    expect(retailCard()).toHaveTextContent(`التكلفة المسجلة: ${money(3020)}`);
    expect(screen.queryByText(/دفعة بتكلفة صفرية/)).not.toBeInTheDocument();
    expect(screen.getByText(/الإجماليات تخص جميع دفعات نتيجة البحث/)).toBeInTheDocument();

    rerender(<InventoryTable {...props} items={[items[50]]} searchTerm="filtered" />);
    expect(retailCard()).toHaveTextContent(money(50));
    expect(retailCard()).toHaveTextContent(`التكلفة المسجلة: ${money(20)}`);

    rerender(<InventoryTable {...props} items={[{ ...items[50], cost_price: 0 }]} searchTerm="filtered" />);
    expect(screen.getByText(/دفعة بتكلفة صفرية أو غير مسجلة/)).toBeInTheDocument();
    expect(retailCard()).toHaveTextContent(`التكلفة المسجلة: ${money(0)}`);
    rerender(<InventoryTable {...props} items={[]} searchTerm="no matches" />);
    expect(retailCard()).toHaveTextContent(money(0));
    expect(screen.queryByText(/دفعة بتكلفة صفرية/)).not.toBeInTheDocument();
  });

  it('opens Add Inventory by button and Insert for managers, then refreshes after success', async () => {
    const onSuccess = jest.fn();
    render(<InventoryClientWrapper pharmacyId="ph-1" canManageInventory={true} onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole('button', { name: /إضافة دواء للمخزون/ }));
    expect(screen.getByRole('dialog', { name: 'mock add inventory' })).toBeInTheDocument();
    expect(screen.getByText('pharmacy:ph-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'mock success' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'mock close' }));
    expect(screen.queryByRole('dialog', { name: 'mock add inventory' })).not.toBeInTheDocument();

    const preventDefault = jest.fn();
    act(() => hotkeyHandler('insert')({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'mock add inventory' })).toBeInTheDocument();
  });

  it('keeps both the Add button and Insert mutation path blocked for view-only inventory users', () => {
    render(<InventoryClientWrapper pharmacyId="ph-1" canManageInventory={false} />);
    expect(screen.queryByRole('button', { name: /إضافة دواء للمخزون/ })).not.toBeInTheDocument();

    const preventDefault = jest.fn();
    act(() => hotkeyHandler('insert')({ preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'mock add inventory' })).not.toBeInTheDocument();
  });

  it('exercises inventory search wiring, page navigation, and both sort directions on actual rendered rows', () => {
    const setSearchTerm = jest.fn();
    render(
      <InventoryTable
        items={makeInventory()}
        searchTerm=""
        setSearchTerm={setSearchTerm}
        onRefresh={jest.fn()}
        pharmacyId="ph-1"
        canManageInventory={false}
      />,
    );

    expect(screen.getByText('Drug 055')).toBeInTheDocument();
    expect(screen.queryByText('Drug 001')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('بحث بالاسم، الباركود، أو المادة الفعالة...'), { target: { value: 'Drug 001' } });
    expect(setSearchTerm).toHaveBeenCalledWith('Drug 001');

    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    expect(screen.getByText('صفحة 2 من 2')).toBeInTheDocument();
    expect(screen.getByText('Drug 001')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /اسم الدواء/ }));
    expect(screen.getByText('صفحة 1 من 2')).toBeInTheDocument();
    expect(screen.getByText('Drug 001')).toBeInTheDocument();
    expect(screen.queryByText('Drug 055')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /اسم الدواء/ }));
    expect(screen.getByText('Drug 055')).toBeInTheDocument();
    expect(screen.queryByText('Drug 001')).not.toBeInTheDocument();
  });

  it('clamps an out-of-range inventory page when refreshed rows shrink after a mutation', () => {
    const view = render(
      <InventoryTable
        items={makeInventory()}
        searchTerm=""
        setSearchTerm={jest.fn()}
        onRefresh={jest.fn()}
        pharmacyId="ph-1"
        canManageInventory={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    expect(screen.getByText('Drug 001')).toBeInTheDocument();

    view.rerender(
      <InventoryTable
        items={makeInventory().slice(0, 50)}
        searchTerm=""
        setSearchTerm={jest.fn()}
        onRefresh={jest.fn()}
        pharmacyId="ph-1"
        canManageInventory={true}
      />,
    );

    expect(screen.getByText('Drug 055')).toBeInTheDocument();
    expect(screen.queryByText('Drug 001')).not.toBeInTheDocument();
  });

  it('parses an authorized inventory workbook through the rendered file input, reloads cache, and refreshes', async () => {
    const originalFileReader = global.FileReader;
    class MockFileReader {
      onload: ((event: any) => void) | null = null;
      readAsBinaryString() {
        this.onload?.({ target: { result: 'mock-workbook-binary' } });
      }
    }
    Object.defineProperty(global, 'FileReader', { configurable: true, value: MockFileReader });
    (importInventoryWorkbookAction as jest.Mock).mockResolvedValue({
      success: true,
      data: { inventoryCount: 1, masterDrugCount: 1 },
    });
    const onRefresh = jest.fn();

    const view = render(
      <InventoryTable
        items={[]}
        searchTerm=""
        setSearchTerm={jest.fn()}
        onRefresh={onRefresh}
        pharmacyId="ph-1"
        canManageInventory={true}
      />,
    );
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    fireEvent.change(input, {
      target: { files: [new File(['xlsx'], 'inventory.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] },
    });

    await waitFor(() => expect(importInventoryWorkbookAction).toHaveBeenCalledWith(
      [{ drug_id: 10, quantity: 4 }],
      [{ id: 10, trade_name: 'Imported Drug' }],
    ));
    expect(secureCache.reload).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(global, 'FileReader', { configurable: true, value: originalFileReader });
  });

  it('blocks same-tick duplicate inventory delete events while the first delete is pending', async () => {
    let resolveDelete!: (value: { success: boolean }) => void;
    (deleteInventoryAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveDelete = resolve;
    }));
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <InventoryTable
        items={makeInventory().slice(0, 1)}
        searchTerm=""
        setSearchTerm={jest.fn()}
        onRefresh={jest.fn()}
        pharmacyId="ph-1"
        canManageInventory={true}
      />,
    );

    const deleteButton = screen.getByTitle('حذف');
    act(() => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deleteInventoryAction).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDelete({ success: false });
      await Promise.resolve();
    });
    confirmSpy.mockRestore();
  });
});
