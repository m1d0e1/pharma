'use client';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'react-hot-toast'
import EditInventoryModal from '../EditInventoryModal'
import DrugDetailsModal from '../pos/DrugDetailsModal'
import { useReactToPrint } from 'react-to-print'

import { useHotkeys } from 'react-hotkeys-hook'
import AddInventoryModal from '../AddInventoryModal'
import { deleteInventoryAction, importInventoryWorkbookAction } from '@/app/actions-client/inventory'
import { isTauri } from '@/lib/env'
import { dbSelect } from '@/lib/db/tauri'
import { assertBoundedDesktopXlsxArchive } from '@/lib/inventory/xlsx-zip-preflight'
import { Download, Upload, Search, Package, Pill, Banknote, Eye, Pencil, Trash2 } from 'lucide-react'

// A workbook can expand far beyond its compressed file size. Desktop import
// is deliberately a bounded new-stock workflow, never a wholesale restore.
const MAX_DESKTOP_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_DESKTOP_IMPORT_ROWS = 200;
const MAX_DESKTOP_IMPORT_COLUMNS = 40;

function assertSafeDesktopSheet(sheet: any): void {
  const reference = sheet?.['!ref'];
  if (typeof reference !== 'string' || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(reference)) {
    throw new Error('ملف المخزون لا يحتوي على نطاق خلايا صالح');
  }
  const parts = reference.split(':');
  const parseCell = (cell: string) => {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell);
    if (!match) throw new Error('نطاق خلايا المخزون غير صالح');
    let column = 0;
    for (const character of match[1]) {
      column = column * 26 + character.charCodeAt(0) - 64;
      if (column > MAX_DESKTOP_IMPORT_COLUMNS) break;
    }
    return { column, row: Number(match[2]) };
  };
  const start = parseCell(parts[0]);
  const end = parseCell(parts[1] || parts[0]);
  if (start.column < 1 || end.column > MAX_DESKTOP_IMPORT_COLUMNS ||
      end.column < start.column || start.row < 1 ||
      end.row < start.row || end.row - start.row > MAX_DESKTOP_IMPORT_ROWS) {
    throw new Error('تجاوز الملف الحدود المسموح بها للدفعات أو الأعمدة');
  }
}

interface InventoryItem {
  id: string
  drug_id: number
  quantity: number
  expiry_date: string
  local_selling_price: number
  cost_price?: number | null
  barcode?: string
  master_drugs: {
    trade_name: string
    trade_name_en?: string
    category: string
    manufacturer: string
    active_ingredient: string
    barcode?: string
  }
}

interface Props {
  items: InventoryItem[]
  searchTerm: string
  setSearchTerm: (val: string) => void
  onRefresh: () => void
  pharmacyId: string
  canManageInventory: boolean
}

const barcodeValue = (value: unknown) => value === null || value === undefined ? null : String(value).trim() || null;

export default function InventoryTable({ items, searchTerm, setSearchTerm, onRefresh, pharmacyId, canManageInventory }: Props) {
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null)
  const [detailsDrugId, setDetailsDrugId] = useState<number | null>(null)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const router = useRouter()

  useHotkeys('insert', (e) => {
    if (!canManageInventory) return;
    e.preventDefault();
    setIsAddModalOpen(true);
  }, { enableOnFormTags: true });

  const [currentPage, setCurrentPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const itemsPerPage = 50;
  const printRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: 'تقرير النواقص',
  });

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, item: InventoryItem | null } | null>(null);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu);
    };
  }, []);

  const handleForceDelete = async (id: string) => {
    if (deletingIdsRef.current.has(id)) return;
    if (!confirm('هل أنت متأكد من حذف هذا الصنف نهائياً من المخزون؟')) return;

    deletingIdsRef.current.add(id);
    try {
      const result = await deleteInventoryAction({ id });
      if (result.success) {
        toast.success('تم حذف الصنف بنجاح');
        onRefresh();
      } else {
        toast.error(result.error || 'فشل الحذف');
      }
    } catch (e) {
      toast.error('حدث خطأ أثناء الحذف');
    } finally {
      deletingIdsRef.current.delete(id);
    }
  }

  // Items are pre-filtered on the database side
  const filteredItems = useMemo(() => items || [], [items]);
  const arCollator = useMemo(() => new Intl.Collator('ar', { sensitivity: 'base' }), []);

  const sortedItems = useMemo(() => {
    if (!sort) return filteredItems;
    const key = sort.key;
    const isAsc = sort.dir === 'asc';

    return [...filteredItems].sort((a: any, b: any) => {
      let av: any;
      let bv: any;
      if (key === 'name') {
        av = a.master_drugs?.trade_name_en || a.master_drugs?.trade_name || '';
        bv = b.master_drugs?.trade_name_en || b.master_drugs?.trade_name || '';
      } else if (key === 'category') {
        av = a.master_drugs?.category || '';
        bv = b.master_drugs?.category || '';
      } else if (key === 'quantity') {
        av = a.quantity || 0;
        bv = b.quantity || 0;
      } else if (key === 'expiry') {
        av = a.expiry_date || '';
        bv = b.expiry_date || '';
      } else if (key === 'price') {
        av = a.local_selling_price || 0;
        bv = b.local_selling_price || 0;
      } else {
        return 0;
      }

      if (typeof av === 'number' && typeof bv === 'number') {
        return isAsc ? av - bv : bv - av;
      }
      const comp = arCollator.compare(String(av), String(bv));
      return isAsc ? comp : -comp;
    });
  }, [filteredItems, sort, arCollator]);

  const sortBy = (key: string) => {
    setSort(prev => prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
    setCurrentPage(1);
  };
  const SortTh = ({ sortKey, children, className = '' }: { sortKey: string; children: React.ReactNode; className?: string }) => (
    <th className={`px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300 ${className}`}>
      <button type="button" onClick={() => sortBy(sortKey)} className="inline-flex items-center gap-1 hover:text-blue-600">
        {children}
        <span className="text-xs" aria-hidden="true">{sort?.key === sortKey ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );

  // Reset to first page when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  const { totalQuantity, totalValue, totalCost, uncostedLots, uniqueDrugsCount } = useMemo(() => {
    let qty = 0;
    let val = 0;
    let cost = 0;
    let uncosted = 0;
    const drugIds = new Set<number>();
    for (let i = 0; i < filteredItems.length; i++) {
      const item = filteredItems[i];
      const q = Number(item.quantity) || 0;
      qty += q;
      val += q * (item.local_selling_price || 0);
      cost += q * (item.cost_price || 0);
      if (q > 0 && !(Number(item.cost_price) > 0)) uncosted++;
      if (item.drug_id) drugIds.add(item.drug_id);
    }
    return { totalQuantity: qty, totalValue: val, totalCost: cost, uncostedLots: uncosted, uniqueDrugsCount: drugIds.size };
  }, [filteredItems]);

  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  useEffect(() => {
    setCurrentPage(prev => Math.min(prev, Math.max(1, totalPages)));
  }, [totalPages]);
  const paginatedItems = useMemo(() => {
    return sortedItems.slice(
      (currentPage - 1) * itemsPerPage,
      currentPage * itemsPerPage
    );
  }, [sortedItems, currentPage, itemsPerPage]);

  const handleRefresh = () => {
    onRefresh()
  }

  const handleExportAll = async () => {
    try {
      const toastId = toast.loading('جاري تصدير المخزون الحالي...');
      const { inventoryRows, drugRows } = isTauri
        ? await (async () => {
            const { invoke } = await import('@tauri-apps/api/core');
            const snapshot = await invoke<unknown>('export_inventory_snapshot_native');
            if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
              throw new Error('Native inventory export response is invalid');
            }
            const rows = (snapshot as { inventoryRows?: unknown }).inventoryRows;
            const drugs = (snapshot as { drugRows?: unknown }).drugRows;
            if (!Array.isArray(rows) || !Array.isArray(drugs) ||
                rows.length > 10000 || drugs.length > 10000 ||
                rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
                  typeof row.id !== 'string' || !row.id ||
                  !Number.isSafeInteger(row.drug_id) || row.drug_id <= 0 ||
                  typeof row.quantity !== 'number' || !Number.isFinite(row.quantity) ||
                  typeof row.local_selling_price !== 'number' || !Number.isFinite(row.local_selling_price)) ||
                drugs.some(drug => !drug || typeof drug !== 'object' || Array.isArray(drug) ||
                  !Number.isSafeInteger(drug.id) || drug.id <= 0)) {
              throw new Error('Native inventory snapshot is malformed or exceeds export limits');
            }
            return { inventoryRows: rows, drugRows: drugs };
          })()
        : await (async () => {
          // Existing browser branch remains unchanged. Only the native app
          // accepts the fixed, authorized snapshot, never renderer SQL.
          const exportPharmacyId = pharmacyId || 'local_default';
          const all = await dbSelect(`
        SELECT i.*, md.trade_name, md.trade_name_en, COALESCE(NULLIF(i.barcode, ''), NULLIF(md.barcode, ''), (
                 SELECT ii.barcode FROM inventory ii
                 WHERE ii.drug_id = i.drug_id
                   AND ii.barcode IS NOT NULL AND ii.barcode != ''
                   AND (ii.pharmacy_id = ? OR (ii.pharmacy_id IS NULL AND ? = 'local_default'))
                 LIMIT 1
               )) AS resolved_barcode
        FROM inventory i
        JOIN master_drugs md ON i.drug_id = md.id
        WHERE (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
          `, [exportPharmacyId, exportPharmacyId, exportPharmacyId, exportPharmacyId]);
          const inventoryRows = all.map((row: any) => {
            const { resolved_barcode, ...item } = row;
            return { ...item, barcode: barcodeValue(item.barcode) || barcodeValue(resolved_barcode) };
          });
          const drugs = await dbSelect(`
        SELECT md.* FROM master_drugs md
        WHERE EXISTS (
          SELECT 1 FROM inventory i
          WHERE i.drug_id = md.id
            AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
        )
          `, [exportPharmacyId, exportPharmacyId]);
          return { inventoryRows, drugRows: drugs };
        })();
      
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(inventoryRows), 'inventory');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(drugRows), 'master_drugs');
      
      const fileBytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = Array.from(new Uint8Array(fileBytes));
      if (isTauri) {
        // The operating-system Save dialog belongs to Rust. No renderer
        // supplied destination can escape the native permission/non-overwrite
        // checks, even if the webview itself is compromised.
        const destination = await invoke<string | null>('save_workbook_export_native', {
          kind: 'inventory', data: bytes,
        });
        if (destination === null) { toast.dismiss(toastId); return; }
        if (typeof destination !== 'string' || !destination) {
          throw new Error('Native export did not confirm the saved workbook');
        }
      } else {
        // Preserve the existing non-Tauri browser branch behavior.
        const { save } = await import('@tauri-apps/plugin-dialog');
        const filePath = await save({
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
          defaultPath: 'inventory_export.xlsx',
        });
        if (!filePath) { toast.dismiss(toastId); return; }
        await invoke('write_binary_file', { path: filePath, data: bytes });
      }

      toast.success('تم التصدير بنجاح!', { id: toastId });
    } catch (err: any) {
      console.error(err);
      toast.error(`فشل التصدير: ${err.message || String(err)}`);
    }
  };

  const handleImportAll = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (importingRef.current) return;
    if (isTauri && (file.size > MAX_DESKTOP_IMPORT_BYTES || !/\.xlsx$/i.test(file.name))) {
      toast.error('الاستيراد الآمن يدعم XLSX فقط بحجم لا يتجاوز ٢ ميغابايت');
      if (importInputRef.current) importInputRef.current.value = '';
      return;
    }
    importingRef.current = true;
    
    const toastId = toast.loading('جاري قراءة ملف المخزون...');
    const finish = () => {
      importingRef.current = false;
      if (importInputRef.current) importInputRef.current.value = '';
    };
    try {
      const reader = new FileReader();
      reader.onerror = () => { toast.error('تعذر قراءة ملف المخزون', { id: toastId }); finish(); };
      reader.onabort = () => { toast.error('تم إلغاء قراءة ملف المخزون', { id: toastId }); finish(); };
      reader.onload = async (evt) => {
        try {
          const bstr = evt.target?.result;
          if (typeof bstr !== 'string' || (isTauri && bstr.length > MAX_DESKTOP_IMPORT_BYTES)) {
            throw new Error('ملف المخزون كبير جداً أو لا يمكن قراءته');
          }
          // Inspect EVERY real inflated ZIP byte before SheetJS's eager unzip.
          // Unsupported raw-DEFLATE runtimes fail closed on desktop.
          if (isTauri) await assertBoundedDesktopXlsxArchive(bstr);
          const XLSX = await import('xlsx');
          const wb = XLSX.read(bstr, { type: 'binary' });
          const inventorySheet = wb.Sheets.inventory || wb.Sheets.Inventory || wb.Sheets[wb.SheetNames[0]];
          const drugsSheet = wb.Sheets.master_drugs || wb.Sheets.Drugs;
          if (!inventorySheet) throw new Error('لم يتم العثور على ورقة المخزون');
          if (isTauri) {
            assertSafeDesktopSheet(inventorySheet);
            // Catalog ownership remains global and read-only; its master sheet
            // must not be supplied to the bounded new-lot import command.
            if (drugsSheet) throw new Error('استيراد الكتالوج العام غير مدعوم؛ أزل ورقة master_drugs من الملف');
          }
          const data: any[] = XLSX.utils.sheet_to_json(inventorySheet, { raw: true });
          const drugs: any[] = drugsSheet ? XLSX.utils.sheet_to_json(drugsSheet, { raw: true }) : [];
          if (isTauri && data.length > MAX_DESKTOP_IMPORT_ROWS) {
            throw new Error('تجاوز الملف حد ٢٠٠ دفعة');
          }
          
          if (data.length === 0) {
            toast.error('الملف فارغ أو غير صالح', { id: toastId });
            return;
          }

          toast.loading(`جاري استيراد ${data.length} سجل مخزون (تشغيلات)...`, { id: toastId });

          const importResult = await importInventoryWorkbookAction(data, drugs);
          if (!importResult.success || !importResult.data) {
            throw new Error(importResult.error || 'فشل استيراد بيانات المخزون');
          }
          const imported = importResult.data;

          // Desktop import was committed/authorized in one native transaction.
          // secureCache.reload() currently uses renderer SQL; never invoke
          // that legacy path from a native stock mutation.
          if (!isTauri) {
            const { secureCache } = await import('@/lib/cache/secure_cache');
            await secureCache.reload();
          }

          toast.success(importResult.replayed
            ? `هذا الملف تمت معالجته من قبل؛ تم التحقق من ${imported.inventoryCount} دفعة دون إضافتها مرتين.`
            : `تم استيراد ${imported.inventoryCount} سجل مخزون لـ ${imported.masterDrugCount} صنف دوائي بنجاح!`,
            { id: toastId });
          onRefresh();
        } catch (err: any) {
          console.error(err);
          toast.error(`فشل معالجة البيانات: ${err.message || String(err)}`, { id: toastId });
        } finally {
          finish();
        }
      };
      reader.readAsBinaryString(file);
    } catch (err: any) {
      console.error(err);
      toast.error(`فشل قراءة الملف: ${err.message || String(err)}`, { id: toastId });
      finish();
    }
  };

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1">
          <span className="absolute inset-y-0 right-3.5 flex items-center text-slate-400" aria-hidden="true"><Search className="h-4 w-4" /></span>
          <input
            type="text"
            aria-label="بحث في المخزون"
            placeholder="بحث بالاسم، الباركود، أو المادة الفعالة..."
            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 pr-10 pl-3.5 py-2.5 rounded-lg focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 outline-none transition-colors text-sm font-medium"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
           <button 
             onClick={handleExportAll} 
             className="min-h-11 px-3.5 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1.5"
           >
             <Download className="w-3.5 h-3.5" />
             تصدير Excel
           </button>
           
           {canManageInventory && (
             <>
               <button
                 type="button"
                 onClick={() => importInputRef.current?.click()}
                 className="min-h-11 px-3.5 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
               >
                 <Upload className="w-3.5 h-3.5" />
                 استيراد Excel
               </button>
               <input
                 ref={importInputRef}
                 type="file"
                 accept={isTauri ? '.xlsx' : '.xlsx, .xls'}
                 onChange={handleImportAll}
                 className="hidden"
                 tabIndex={-1}
                 aria-hidden="true"
               />
             </>
           )}

           <button onClick={() => handlePrint()} className="min-h-11 px-3.5 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">طباعة النواقص</button>
        </div>
      </div>

      {/* Stats Summary Card Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-xl flex justify-between items-center shadow-sm">
          <div>
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-300">إجمالي كمية الأدوية المتوفرة</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1.5 tabular-nums">
              {totalQuantity.toLocaleString('ar-EG')} <span className="text-xs font-medium text-slate-500">وحدة كبيرة (تشمل الكسور)</span>
            </p>
          </div>
          <div className="h-10 w-10 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 flex items-center justify-center rounded-lg"><Package className="h-5 w-5" /></div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-xl flex justify-between items-center shadow-sm">
          <div>
            <p className="text-xs font-semibold text-purple-700 dark:text-purple-300">إجمالي الأصناف المتوفرة</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1.5 tabular-nums">
              {uniqueDrugsCount.toLocaleString('ar-EG')} <span className="text-xs font-medium text-slate-500">صنف</span>
            </p>
          </div>
          <div className="h-10 w-10 bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300 flex items-center justify-center rounded-lg"><Pill className="h-5 w-5" /></div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 rounded-xl flex justify-between items-start gap-4 shadow-sm">
          <div>
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">قيمة المخزون بسعر البيع</p>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300 mt-1.5 tabular-nums">
              {totalValue.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs font-medium">ج.م</span>
            </p>
            <p className="text-sm mt-2 text-slate-600 dark:text-slate-300">
              التكلفة المسجلة: {totalCost.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
            </p>
            {uncostedLots > 0 && <p className="text-xs mt-2 text-amber-700 dark:text-amber-400">
              تنبيه: {uncostedLots.toLocaleString('ar-EG')} دفعة بتكلفة صفرية أو غير مسجلة؛ راجع التكلفة قبل الاعتماد على التقييم.
            </p>}
          </div>
          <div className="h-10 w-10 shrink-0 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 flex items-center justify-center rounded-lg"><Banknote className="h-5 w-5" /></div>
        </div>
      </div>

      <p className="text-sm text-slate-500">الإجماليات تخص جميع دفعات نتيجة البحث، وليس الصفحة الحالية فقط. تشمل الكميات منتهية الصلاحية؛ قيمة البيع ليست إيرادًا محققًا أو رصيد خزينة.</p>
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                <SortTh sortKey="name">{'\u0627\u0633\u0645 \u0627\u0644\u062f\u0648\u0627\u0621'}</SortTh>
                <SortTh sortKey="category">{'\u0627\u0644\u062a\u0635\u0646\u064a\u0641'}</SortTh>
                <SortTh sortKey="quantity" className="text-center">{'\u0627\u0644\u0643\u0645\u064a\u0629'}</SortTh>
                <SortTh sortKey="expiry">{'\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0635\u0644\u0627\u062d\u064a\u0629'}</SortTh>
                <SortTh sortKey="price">{'\u0627\u0644\u0633\u0639\u0631'}</SortTh>
                <th className="px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300">{'\u0625\u062c\u0631\u0627\u0621\u0627\u062a'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {paginatedItems.map((item) => {
                const now = new Date().getTime();
                const expiry = new Date(item.expiry_date).getTime();
                const isExpired = item.quantity > 0 && expiry < now;
                const isExpiringSoon = item.quantity > 0 && !isExpired && (expiry - now < 1000 * 60 * 60 * 24 * 90);
                const isLowStock = item.quantity < 10

                return (
                  <tr 
                    key={item.id} 
                    className="group hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-context-menu relative"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const menuWidth = 192;
                      const menuHeight = 220;
                      let x = e.clientX;
                      let y = e.clientY;
                      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 12;
                      if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 12;
                      if (x < 12) x = 12;
                      if (y < 12) y = 12;
                      setContextMenu({ x, y, item });
                    }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors">
                            {item.master_drugs.trade_name_en || item.master_drugs.trade_name}
                          </span>
                          {(item.barcode || item.master_drugs.barcode) && (
                            <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono text-xs font-bold">
                              {item.barcode || item.master_drugs.barcode}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-slate-400">{item.master_drugs.active_ingredient}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-full text-xs font-medium">
                        {item.master_drugs.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center justify-center min-w-[3rem] px-3 py-1.5 rounded-xl font-black text-sm ${
                        isLowStock 
                          ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 border border-red-200 dark:border-red-800' 
                          : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                      }`}>
                        {item.quantity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${
                        isExpired ? 'text-red-600 font-black' : 
                        isExpiringSoon ? 'text-amber-600 font-bold' : 
                        'text-slate-600 dark:text-slate-300'
                      }`}>
                        {item.expiry_date ? new Date(item.expiry_date).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }) : 'لا يوجد'}
                        {isExpired && <span className="mr-2 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-black">منتهي الصلاحية</span>}
                        {isExpiringSoon && <span className="mr-2 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">قريب الانتهاء</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-semibold text-blue-700 dark:text-blue-400 tabular-nums">
                        {(item.local_selling_price ?? 0).toLocaleString('ar-EG')} <span className="text-xs font-bold">ج.م</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button 
                          onClick={() => setDetailsDrugId(item.drug_id)}
                          aria-label={`عرض تفاصيل ${item.master_drugs.trade_name_en || item.master_drugs.trade_name}`}
                          className="inline-flex h-11 w-11 items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-lg transition-colors"
                          title="تفاصيل"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {canManageInventory && (
                          <>
                            <button
                              onClick={() => setEditingItem(item)}
                              aria-label={`تعديل ${item.master_drugs.trade_name_en || item.master_drugs.trade_name}`}
                              className="inline-flex h-11 w-11 items-center justify-center hover:bg-blue-50 dark:hover:bg-blue-950/30 text-blue-700 dark:text-blue-300 rounded-lg transition-colors"
                              title="تعديل"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleForceDelete(item.id)}
                              aria-label={`حذف دفعة ${item.master_drugs.trade_name_en || item.master_drugs.trade_name}`}
                              className="inline-flex h-11 w-11 items-center justify-center hover:bg-red-50 dark:hover:bg-red-950/30 text-red-700 dark:text-red-300 rounded-lg transition-colors"
                              title="حذف"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              
              {paginatedItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-16 text-center">
                    <div className="flex flex-col items-center justify-center space-y-3 text-slate-400">
                      <Package className="h-10 w-10 text-slate-300 dark:text-slate-600" />
                      <p className="text-slate-500 font-medium">{searchTerm.trim() ? 'لم يتم العثور على نتائج للبحث في المخزون.' : 'لا توجد دفعات مخزون مسجلة حالياً.'}</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Improved Pagination Controls */}
        {totalPages > 1 && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex flex-col md:flex-row gap-3 justify-between items-center bg-slate-50/50 dark:bg-slate-800/30">
            {/* Quick jump & Jump actions */}
            <div className="flex items-center gap-2">
              <button 
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(1)}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                title="الصفحة الأولى"
              >
                الأولى
              </button>
              <button 
                type="button"
                disabled={currentPage <= 5}
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 5))}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                title="رجوع ٥ صفحات"
              >
                -٥
              </button>
              <button 
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => prev - 1)}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                السابق
              </button>
            </div>

            {/* Current Info & Direct input */}
            <div className="flex items-center gap-4">
              <div className="text-sm font-bold text-slate-500">
                صفحة {currentPage} من {totalPages}
              </div>
              <div className="flex items-center gap-2 border-r border-slate-200 dark:border-slate-700 pr-4">
                <label htmlFor="inventory-page-jump" className="text-xs text-slate-500 font-medium">الانتقال إلى:</label>
                <input 
                  id="inventory-page-jump"
                  type="number"
                  min="1"
                  max={totalPages}
                  value={currentPage}
                  onChange={(e) => {
                    const p = parseInt(e.target.value);
                    if (p >= 1 && p <= totalPages) {
                      setCurrentPage(p);
                    }
                  }}
                  className="w-16 px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-center text-sm font-bold outline-none focus:ring-2 focus:ring-blue-500 dark:text-white"
                />
              </div>
            </div>

            {/* Next actions & Last page */}
            <div className="flex items-center gap-2">
              <button 
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(prev => prev + 1)}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                التالي
              </button>
              <button 
                type="button"
                disabled={currentPage >= totalPages - 4}
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 5))}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                title="تقدم ٥ صفحات"
              >
                +٥
              </button>
              <button 
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(totalPages)}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                title="الصفحة الأخيرة"
              >
                الأخيرة
              </button>
            </div>
          </div>
        )}
      </div>

      {canManageInventory && editingItem && (
        <EditInventoryModal 
          item={editingItem} 
          onClose={() => setEditingItem(null)} 
          onSuccess={handleRefresh}
        />
      )}

      {detailsDrugId && (
        <DrugDetailsModal 
          drugId={detailsDrugId} 
          onClose={() => setDetailsDrugId(null)} 
          onDrugUpdated={() => {
            handleRefresh();
          }}
          onDrugDeleted={() => {
            handleRefresh();
          }}
        />
      )}

      {/* Hidden Printable Section */}
      <div style={{ display: 'none' }}>
        <div ref={printRef} className="p-8 font-sans" dir="rtl">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-black mb-2">تقرير النواقص (Low Stock)</h2>
            <p className="text-gray-500">تاريخ الطباعة: {new Date().toLocaleDateString('ar-EG')}</p>
          </div>
          <table className="w-full text-right border-collapse border border-gray-300">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 p-3 font-bold">اسم الدواء</th>
                <th className="border border-gray-300 p-3 font-bold">التصنيف</th>
                <th className="border border-gray-300 p-3 font-bold">الكمية المتبقية</th>
                <th className="border border-gray-300 p-3 font-bold">المورد (إن وجد)</th>
                <th className="border border-gray-300 p-3 font-bold">السعر</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.filter(item => item.quantity < 10).map((item, idx) => (
                <tr key={idx} className="border-b border-gray-200">
                  <td className="border border-gray-300 p-2 font-bold text-gray-800">{item.master_drugs?.trade_name_en || item.master_drugs?.trade_name}</td>
                  <td className="border border-gray-300 p-2 text-gray-600">{item.master_drugs?.category || '-'}</td>
                  <td className="border border-gray-300 p-2 font-black text-red-600">{item.quantity}</td>
                  <td className="border border-gray-300 p-2 text-gray-600">{(item as any).supplier || '-'}</td>
                  <td className="border border-gray-300 p-2 text-gray-800">{item.local_selling_price} ج.م</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {contextMenu && (
        <div 
          className="fixed z-[100] bg-white dark:bg-slate-800 shadow-lg rounded-lg py-2 w-48 border border-slate-200 dark:border-slate-700"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-700 mb-1">
            <span className="block text-xs font-black text-slate-400">خيارات المخزون</span>
            <span className="block text-sm font-bold truncate text-slate-900 dark:text-white">
              {contextMenu.item?.master_drugs.trade_name}
            </span>
          </div>
          <button 
            type="button"
            className="w-full text-right px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-2"
            onClick={() => {
              if (contextMenu.item) setDetailsDrugId(contextMenu.item.drug_id);
              setContextMenu(null);
            }}
          >
            <Eye className="w-4 h-4" aria-hidden="true" /> التفاصيل الشاملة
          </button>
          {canManageInventory && (
            <>
              <button
                type="button"
                className="w-full text-right px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-2"
                onClick={() => {
                  if (contextMenu.item) setEditingItem(contextMenu.item);
                  setContextMenu(null);
                }}
              >
                <Pencil className="w-4 h-4" aria-hidden="true" /> تعديل الرصيد
              </button>
              <div className="h-px bg-slate-100 dark:bg-slate-700 my-1"></div>
              <button
                type="button"
                className="w-full text-right px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-2"
                onClick={() => {
                  if (contextMenu.item) handleForceDelete(contextMenu.item.id);
                  setContextMenu(null);
                }}
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" /> حذف الصنف
              </button>
            </>
          )}
        </div>
      )}

      {canManageInventory && isAddModalOpen && (
        <AddInventoryModal
          pharmacyId=""
          onClose={() => setIsAddModalOpen(false)}
          onSuccess={onRefresh}
        />
      )}
    </div>
  )
}
