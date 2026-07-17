'use client'

import React, { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'react-hot-toast'
import EditInventoryModal from '../EditInventoryModal'
import DrugDetailsModal from '../pos/DrugDetailsModal'

import { deleteInventoryAction } from '@/app/actions-client/inventory'
import { dbSelect, dbExecute, generateId } from '@/lib/db/tauri'
import { Download, Upload } from 'lucide-react'

interface InventoryItem {
  id: string
  drug_id: number
  quantity: number
  expiry_date: string
  local_selling_price: number
  master_drugs: {
    trade_name: string
    trade_name_en?: string
    category: string
    manufacturer: string
    active_ingredient: string
  }
}

interface Props {
  items: InventoryItem[]
  searchTerm: string
  setSearchTerm: (val: string) => void
  onRefresh: () => void
}

export default function InventoryTable({ items, searchTerm, setSearchTerm, onRefresh }: Props) {
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null)
  const [detailsDrugId, setDetailsDrugId] = useState<number | null>(null)
  const router = useRouter()

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

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
    if (!confirm('هل أنت متأكد من حذف هذا الصنف نهائياً من المخزون؟')) return;

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
    }
  }

  // Items are pre-filtered on the database side
  const filteredItems = items;

  // Reset to first page when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  const totalQuantity = filteredItems.reduce((acc, item) => acc + (item.quantity || 0), 0);
  const totalValue = filteredItems.reduce((acc, item) => acc + ((item.quantity || 0) * (item.local_selling_price || 0)), 0);
  const uniqueDrugsCount = new Set(filteredItems.map(item => item.drug_id)).size;

  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  const paginatedItems = filteredItems.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const handleRefresh = () => {
    onRefresh()
  }

  const handleExportAll = async () => {
    try {
      const toastId = toast.loading('جاري تصدير المخزون الحالي...');
      const all = await dbSelect(`
        SELECT i.id, i.drug_id, md.trade_name, md.trade_name_en, i.quantity, i.expiry_date, 
               i.local_selling_price, i.cost_price, i.batch_number, i.supplier, i.min_stock_level,
               i.barcode, i.strips_per_box
        FROM inventory i
        JOIN master_drugs md ON i.drug_id = md.id
      `);
      
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        defaultPath: 'inventory_export.xlsx'
      });

      if (!filePath) {
        toast.dismiss(toastId);
        return;
      }

      const XLSX = await import('xlsx');
      const worksheet = XLSX.utils.json_to_sheet(all);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');
      
      const fileBytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_binary_file', { path: filePath, data: Array.from(new Uint8Array(fileBytes)) });

      toast.success('تم التصدير بنجاح!', { id: toastId });
    } catch (err: any) {
      console.error(err);
      toast.error(`فشل التصدير: ${err.message || String(err)}`);
    }
  };

  const handleImportAll = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const toastId = toast.loading('جاري قراءة ملف المخزون...');
    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const bstr = evt.target?.result;
          const XLSX = await import('xlsx');
          const wb = XLSX.read(bstr, { type: 'binary' });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const data: any[] = XLSX.utils.sheet_to_json(ws);
          
          if (data.length === 0) {
            toast.error('الملف فارغ أو غير صالح', { id: toastId });
            return;
          }

          toast.loading(`جاري استيراد ${data.length} صنف للمخزون...`, { id: toastId });

          let inserted = 0;
          for (const row of data) {
            const id = row.id || generateId();
            const drug_id = Number(row.drug_id);
            const quantity = Number(row.quantity) || 0;
            const expiry_date = row.expiry_date || null;
            const local_selling_price = Number(row.local_selling_price) || 0;
            const cost_price = Number(row.cost_price) || 0;
            const batch_number = row.batch_number || null;
            const supplier = row.supplier || null;
            const min_stock_level = Number(row.min_stock_level) || 10;
            const barcode = row.barcode || null;
            const strips_per_box = Number(row.strips_per_box) || 1;

            if (!drug_id) continue;

            await dbExecute(`
              INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, expiry_date, local_selling_price, cost_price, batch_number, supplier, min_stock_level, barcode, strips_per_box)
              VALUES (?, 'local_default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                drug_id=excluded.drug_id,
                quantity=excluded.quantity,
                expiry_date=excluded.expiry_date,
                local_selling_price=excluded.local_selling_price,
                cost_price=excluded.cost_price,
                batch_number=excluded.batch_number,
                supplier=excluded.supplier,
                min_stock_level=excluded.min_stock_level,
                barcode=excluded.barcode,
                strips_per_box=excluded.strips_per_box
            `, [id, drug_id, quantity, expiry_date, local_selling_price, cost_price, batch_number, supplier, min_stock_level, barcode, strips_per_box]);
            inserted++;
          }

          const { secureCache } = await import('@/lib/cache/secure_cache');
          await secureCache.reload();

          toast.success(`تم استيراد ${inserted} صنف للمخزون بنجاح!`, { id: toastId });
          onRefresh();
        } catch (err: any) {
          console.error(err);
          toast.error(`فشل معالجة البيانات: ${err.message || String(err)}`, { id: toastId });
        }
      };
      reader.readAsBinaryString(file);
    } catch (err: any) {
      console.error(err);
      toast.error(`فشل قراءة الملف: ${err.message || String(err)}`, { id: toastId });
    }
  };

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center gap-4">
        <div className="relative flex-1">
          <span className="absolute inset-y-0 right-4 flex items-center text-slate-400">🔍</span>
          <input
            type="text"
            placeholder="بحث في المخزون الحالي..."
            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-12 pl-4 py-3 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-medium"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
           <button 
             onClick={handleExportAll} 
             className="px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all flex items-center gap-1"
           >
             <Download className="w-3.5 h-3.5" />
             تصدير Excel
           </button>
           
           <label 
             className="px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all flex items-center gap-1 cursor-pointer"
           >
             <Upload className="w-3.5 h-3.5" />
             استيراد Excel
             <input 
               type="file" 
               accept=".xlsx, .xls" 
               onChange={handleImportAll} 
               className="hidden" 
             />
           </label>

           <button onClick={() => toast.success('سيتم تفعيل الطباعة قريباً')} className="px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all">طباعة النواقص</button>
        </div>
      </div>

      {/* Stats Summary Card Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/10 dark:from-blue-500/20 dark:to-indigo-500/20 border border-blue-100 dark:border-blue-900/50 p-6 rounded-3xl flex justify-between items-center shadow-sm">
          <div>
            <p className="text-xs font-black text-blue-600 dark:text-blue-400 uppercase tracking-widest">إجمالي كمية الأدوية المتوفرة</p>
            <p className="text-3xl font-black text-slate-900 dark:text-white mt-2">
              {totalQuantity.toLocaleString('ar-EG')} <span className="text-sm font-bold text-slate-500">وحدة</span>
            </p>
          </div>
          <div className="text-4xl bg-blue-500/15 dark:bg-blue-500/30 p-4 rounded-2xl">📦</div>
        </div>

        <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 dark:from-purple-500/20 dark:to-pink-500/20 border border-purple-100 dark:border-purple-900/50 p-6 rounded-3xl flex justify-between items-center shadow-sm">
          <div>
            <p className="text-xs font-black text-purple-600 dark:text-purple-400 uppercase tracking-widest">إجمالي الأصناف المتوفرة</p>
            <p className="text-3xl font-black text-slate-900 dark:text-white mt-2">
              {uniqueDrugsCount.toLocaleString('ar-EG')} <span className="text-sm font-bold text-slate-500">صنف</span>
            </p>
          </div>
          <div className="text-4xl bg-purple-500/15 dark:bg-purple-500/30 p-4 rounded-2xl">🧪</div>
        </div>

        <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 dark:from-emerald-500/20 dark:to-teal-500/20 border border-emerald-100 dark:border-emerald-900/50 p-6 rounded-3xl flex justify-between items-center shadow-sm">
          <div>
            <p className="text-xs font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">إجمالي قيمة المخزون الحالي</p>
            <p className="text-3xl font-black text-emerald-600 dark:text-emerald-400 mt-2">
              {totalValue.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm font-bold">ج.م</span>
            </p>
          </div>
          <div className="text-4xl bg-emerald-500/15 dark:bg-emerald-500/30 p-4 rounded-2xl">💰</div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                <th className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400">اسم الدواء</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400">التصنيف</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400 text-center">الكمية</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400">تاريخ الصلاحية</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400">السعر</th>
                <th className="px-8 py-5 text-sm font-bold text-slate-500 dark:text-slate-400">إجراءات</th>
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
                    <td className="px-8 py-5">
                      <div className="flex flex-col">
                        <span className="font-bold text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors">
                          {item.master_drugs.trade_name_en || item.master_drugs.trade_name}
                        </span>
                        <span className="text-xs text-slate-400">{item.master_drugs.active_ingredient}</span>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-full text-xs font-medium">
                        {item.master_drugs.category}
                      </span>
                    </td>
                    <td className="px-8 py-5 text-center">
                      <span className={`inline-flex items-center justify-center min-w-[3rem] px-3 py-1.5 rounded-xl font-black text-sm ${
                        isLowStock 
                          ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 border border-red-200 dark:border-red-800' 
                          : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                      }`}>
                        {item.quantity}
                      </span>
                    </td>
                    <td className="px-8 py-5">
                      <span className={`text-sm font-medium ${
                        isExpired ? 'text-red-600 font-black' : 
                        isExpiringSoon ? 'text-amber-600 font-bold' : 
                        'text-slate-600 dark:text-slate-300'
                      }`}>
                        {item.expiry_date ? new Date(item.expiry_date).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }) : 'لا يوجد'}
                        {isExpired && <span className="mr-2 text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded uppercase font-black">منتهي الصلاحية</span>}
                        {isExpiringSoon && <span className="mr-2 text-[10px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">قريب الانتهاء</span>}
                      </span>
                    </td>
                    <td className="px-8 py-5">
                      <span className="text-lg font-black text-blue-600 dark:text-blue-400">
                        {(item.local_selling_price ?? 0).toLocaleString('ar-EG')} <span className="text-xs font-bold">ج.م</span>
                      </span>
                    </td>
                    <td className="px-8 py-5">
                      <div className="flex gap-2">
                        <button 
                          onClick={() => setDetailsDrugId(item.drug_id)}
                          className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-lg transition-all" 
                          title="تفاصيل"
                        >
                          👁️
                        </button>
                        <button 
                          onClick={() => setEditingItem(item)}
                          className="p-2 hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg transition-all" 
                          title="تعديل"
                        >
                          ✏️
                        </button>
                        <button 
                          onClick={() => handleForceDelete(item.id)} 
                          className="p-2 hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg transition-all" 
                          title="حذف"
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              
              {paginatedItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-16 text-center">
                    <div className="flex flex-col items-center justify-center space-y-4 opacity-50">
                      <div className="text-5xl">📦</div>
                      <p className="text-slate-500 font-medium">لم يتم العثور على نتائج للبحث في المخزون.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Improved Pagination Controls */}
        {totalPages > 1 && (
          <div className="p-6 border-t border-slate-100 dark:border-slate-800 flex flex-col md:flex-row gap-4 justify-between items-center bg-slate-50/30 dark:bg-slate-800/30">
            {/* Quick jump & Jump actions */}
            <div className="flex items-center gap-2">
              <button 
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(1)}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                title="الصفحة الأولى"
              >
                ⏮️ الأولى
              </button>
              <button 
                type="button"
                disabled={currentPage <= 5}
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 5))}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                title="رجوع ٥ صفحات"
              >
                -٥
              </button>
              <button 
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => prev - 1)}
                className="px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
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
                <span className="text-xs text-slate-400 font-bold">الانتقال إلى:</span>
                <input 
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
                className="px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-bold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
              >
                التالي
              </button>
              <button 
                type="button"
                disabled={currentPage >= totalPages - 4}
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 5))}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                title="تقدم ٥ صفحات"
              >
                +٥
              </button>
              <button 
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(totalPages)}
                className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold disabled:opacity-50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                title="الصفحة الأخيرة"
              >
                الأخيرة ⏭️
              </button>
            </div>
          </div>
        )}
      </div>

      {editingItem && (
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
        />
      )}

      {contextMenu && (
        <div 
          className="fixed z-[100] bg-white dark:bg-slate-800 shadow-2xl rounded-2xl py-2 w-48 border border-slate-100 dark:border-slate-700 animate-in fade-in zoom-in-95 duration-100"
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
            className="w-full text-right px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-2"
            onClick={() => {
              if (contextMenu.item) setDetailsDrugId(contextMenu.item.drug_id);
              setContextMenu(null);
            }}
          >
            <span className="w-5 text-center">👁️</span> التفاصيل الشاملة
          </button>
          <button 
            className="w-full text-right px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-2"
            onClick={() => {
              if (contextMenu.item) setEditingItem(contextMenu.item);
              setContextMenu(null);
            }}
          >
            <span className="w-5 text-center">✏️</span> تعديل الرصيد
          </button>
          <div className="h-px bg-slate-100 dark:bg-slate-700 my-1"></div>
          <button 
            className="w-full text-right px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-2"
            onClick={() => {
              if (contextMenu.item) handleForceDelete(contextMenu.item.id);
              setContextMenu(null);
            }}
          >
            <span className="w-5 text-center">🗑️</span> حذف الصنف
          </button>
        </div>
      )}
    </div>
  )
}
