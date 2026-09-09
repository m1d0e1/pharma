'use client';
import React, { useState } from 'react';
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { getReplacementDrug, replaceDrugAction } from '@/app/actions-client/drug-replacement';

const fields: [string, string, ('text' | 'number' | 'flag')?][] = [
  ['trade_name','الاسم التجاري'], ['trade_name_en','الاسم الإنجليزي'], ['barcode','الباركود'],
  ['official_price','سعر البيع','number'], ['generic_name','الاسم العلمي'], ['active_ingredient','المادة الفعالة'],
  ['active_ingredient_ratio','تركيز المادة الفعالة'], ['manufacturer','الشركة المصنعة'], ['category','التصنيف'],
  ['large_unit','الوحدة الكبرى'], ['medium_unit','الوحدة المتوسطة'], ['small_unit','الوحدة الصغرى'],
  ['large_to_medium','عدد الوحدات المتوسطة','number'], ['medium_to_small','عدد الوحدات الصغرى','number'],
  ['min_limit','الحد الأدنى','number'], ['max_limit','الحد الأقصى','number'], ['reorder_point','حد الطلب','number'],
  ['default_purchase_qty','كمية الشراء الافتراضية','number'], ['tax_percent','الضريبة %','number'], ['discount_percent','الخصم %','number'],
  ['is_medicine','دواء','flag'], ['is_service','خدمة','flag'], ['is_refrigerated','يحفظ بالثلاجة','flag'], ['is_chronic','دواء مزمن','flag'],
  ['has_expiry','له صلاحية','flag'], ['no_return','ممنوع الإرجاع','flag'], ['prevent_fractions','منع الكسور','flag'],
  ['stop_dealing','إيقاف التعامل','flag'], ['is_table','صنف جدول','flag'],
  ['origin','المنشأ'], ['code_2','كود إضافي'], ['item_nature','طبيعة الصنف'], ['scientific_group','المجموعة العلمية'],
  ['usage_method','طريقة الاستخدام'], ['indications','دواعي الاستعمال'], ['side_effects','الآثار الجانبية'], ['notes','ملاحظات'],
];

export default function DrugReplacementDialog({ source, target, newDrug, pendingEdit, onClose, onSuccess }: {
  source: any; target?: any; newDrug?: any; pendingEdit?: any; onClose: () => void;
  onSuccess: (targetId: number, backupPath?: string, savedDrug?: any, edits?: Record<string, any>) => void;
}) {
  const [selected, setSelected] = useState<any>(target || null);
  const [results, setResults] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceInfo, setSourceInfo] = useState<any>(null);
  const [targetInfo, setTargetInfo] = useState<any>(null);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const selectedId = selected?.id;
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setConfirmed(false); setEdits({});
    Promise.all([getReplacementDrug(Number(source.id)), selectedId ? getReplacementDrug(Number(selectedId)) : Promise.resolve(null)]).then(([old, next]) => {
      if (cancelled) return;
      if (!old || (selectedId && !next)) { setError('تعذر تحميل بيانات الصنفين. أغلق النافذة وأعد المحاولة؛ لم يتم تغيير البيانات.'); return; }
      setSourceInfo(old);
      setTargetInfo(newDrug ? { ...old, ...newDrug } : next);
      if (pendingEdit) setEdits(Object.fromEntries(fields.filter(([key]) => key in pendingEdit && pendingEdit[key] !== next?.[key]).map(([key]) => [key, pendingEdit[key]])));
      else if (newDrug) setEdits(Object.fromEntries(fields.filter(([key]) => key in newDrug && newDrug[key] !== old[key] && !((key.endsWith('_unit') || key === 'large_to_medium' || key === 'medium_to_small') && !newDrug[key])).map(([key]) => [key, newDrug[key]])));
      setLoading(false);
    }).catch(() => { if (!cancelled) setError('تعذر تحميل بيانات الصنفين؛ أعد المحاولة'); });
    return () => { cancelled = true; };
  }, [source.id, selectedId, newDrug, pendingEdit]);
  const edit = (key: string, value: any) => { setEdits(previous => ({ ...previous, [key]: value })); setConfirmed(false); };
  const barcodes = (drug: any): string[] => [drug?.barcode, ...(drug?.inventory_barcodes || '').split(',')].filter(Boolean).map(code => String(code).trim().toLowerCase());
  const sharedBarcodes = [...new Set(barcodes(sourceInfo).filter(code => barcodes(targetInfo).includes(code)))];
  const searchSequence = React.useRef(0);
  const submitLock = React.useRef(false);
  const dialogRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="fixed inset-0 z-[250] bg-black/60 flex items-center justify-center p-4" dir="rtl">
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="replacement-title" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); }
      if (e.key !== 'Tab') return;
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }} className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-full max-w-6xl max-h-[90vh] overflow-auto space-y-4">
      <h2 id="replacement-title" className="font-bold text-xl">تحذير: استبدال الصنف القديم وحفظ روابطه</h2>
      <p>الصنف القديم: {source.trade_name_en || source.trade_name || `#${source.id}`} (#{source.id})</p>
      <p>لا يمكن مشاركة الباركود بين صنفين أو حذف سجل مستخدم مباشرة. سيؤدي التأكيد إلى إنشاء نسخة احتياطية، ونقل دفعات المخزون والفواتير والمرتجعات والروابط إلى البديل، ثم حذف السجل القديم. تبقى الكميات والتكاليف وأسعار الفواتير السابقة دون تغيير.</p>
      <p className="text-amber-700">لا تستخدم الدمج لأدوية أو تركيزات أو عبوات مختلفة. أغلق الفواتير المفتوحة أو المعلقة في النوافذ الأخرى أولاً. عند إنشاء بديل جديد تُحفظ الإعدادات التشغيلية للصنف القديم.</p>
      <p>حذف الباركود من بطاقة الصنف لا يزيله من دفعات المخزون القديمة. الاستبدال ينقل هذه الدفعات إلى الصنف الصحيح ويزيل التعارض. إذا كان دواءً مختلفاً، ألغِ العملية واستخدم باركوداً مختلفاً.</p>
      {newDrug ? <p>البديل الجديد: {newDrug.trade_name_en || newDrug.trade_name}</p> : target ? <p>البديل: {target.trade_name_en || target.trade_name} (#{target.id})</p> : <>
        <label className="block">ابحث عن الصنف البديل
          <input value={query} disabled={busy} className="w-full border rounded p-2" onChange={async e => {
            const text = e.target.value; setQuery(text); setSelected(null); setConfirmed(false); const sequence = ++searchSequence.current;
            if (text.trim().length < 2) { setResults([]); return; }
            const response = await searchMasterDrugsAction({ query: text });
            if (sequence === searchSequence.current) setResults((response.data || []).filter((d: any) => Number(d.id) !== Number(source.id)));
          }} />
        </label>
        <div className="max-h-36 overflow-auto">{results.map(drug => <button key={drug.id} type="button" disabled={busy} className="block border rounded p-2 w-full text-right" onClick={() => { setSelected(drug); setResults([]); setConfirmed(false); }}>{drug.trade_name_en || drug.trade_name} (#{drug.id}) — {drug.barcode || 'بدون باركود'}</button>)}</div>
        {selected && <p>البديل المختار: {selected.trade_name_en || selected.trade_name} (#{selected.id})</p>}
      </>}
      {loading && <p role="status">جاري تحميل البيانات الكاملة...</p>}
      {!loading && sourceInfo && targetInfo && <>
        {sharedBarcodes.length > 0 && <p className="bg-emerald-50 text-emerald-800 p-2">باركود مشترك بين البطاقة أو دفعات المخزون: {sharedBarcodes.join('، ')}</p>}
        <p>الأخضر = معلومات متطابقة. عدّل عمود «البيانات النهائية» أو اختر قيمة من أحد الصنفين. الكميات والتكاليف والسجل السابق للعرض فقط؛ لا تُعدّل من هنا. تصحيح سعر البيع يحدّث سعر البيع بالمخزون ونقطة البيع، وليس تكلفة الشراء أو الفواتير القديمة.</p>
        <div className="overflow-x-auto max-h-[48vh] overflow-y-auto border rounded">
          <table className="w-full text-sm border-collapse"><thead className="sticky top-0 bg-slate-100 dark:bg-slate-800"><tr><th>الحقل</th><th>الصنف القديم #{sourceInfo.id}</th><th>الصنف البديل {newDrug ? '(جديد)' : `#${targetInfo.id}`}</th><th>البيانات النهائية — قابلة للتعديل</th></tr></thead>
          <tbody>
            {[['stock_quantity','رصيد المخزون'], ['inventory_barcodes','باركود دفعات المخزون']].map(([key,label]) => <tr key={key}><th>{label}</th><td>{String(sourceInfo[key] ?? '—')}</td><td>{newDrug ? '—' : String(targetInfo[key] ?? '—')}</td><td>محفوظ دون تعديل</td></tr>)}
            {fields.map(([key,label,type = 'text']) => {
              const old = sourceInfo[key] ?? '', next = targetInfo[key] ?? '';
              const shared = String(old).trim() !== '' && String(old).trim().toLowerCase() === String(next).trim().toLowerCase();
              const inherits = !['trade_name','trade_name_en','generic_name','active_ingredient','official_price','category','manufacturer'].includes(key);
              const value = key in edits ? edits[key] : (inherits && next === '' ? old : next);
              return <tr key={key} className={shared ? 'bg-emerald-50 dark:bg-emerald-950' : 'border-t'} data-shared={shared}>
                <th className="p-2">{label}{shared && <span className="block text-emerald-700">متطابق</span>}</th>
                {[old, next].map((v, index) => <td key={index} className="p-2 max-w-52 break-words"><span>{String(v) || '—'}</span><button type="button" disabled={busy} aria-label={`استخدام ${label} من ${index === 0 ? 'القديم' : 'البديل'}`} className="block text-blue-700 underline" onClick={() => edit(key, v)}>استخدام</button></td>)}
                <td className="p-2">{type === 'flag' ? <select aria-label={`البيانات النهائية: ${label}`} disabled={busy} value={Number(value || 0)} onChange={e => edit(key, Number(e.target.value))}><option value={0}>لا</option><option value={1}>نعم</option></select>
                  : <input aria-label={`البيانات النهائية: ${label}`} disabled={busy} className="w-full min-w-40 border rounded p-2 dark:bg-slate-800" type={type} min={type === 'number' ? 0 : undefined} step="any" value={value ?? ''} onChange={e => edit(key, type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}</td>
              </tr>;
            })}
          </tbody></table>
        </div>
      </>}
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />أؤكد أنه نفس الدواء والتركيز والشكل وحجم العبوة، وأوافق على نقل الروابط وحذف القديم.</label>
      <label className="block">كلمة مرور المدير الحالي<input type="password" autoComplete="current-password" className="w-full border rounded p-2" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      <p>التأكيد يحفظ التعديلات والاستبدال معاً. في شاشة الشراء: ستعود للفاتورة بالبيانات المصححة؛ راجعها ثم اضغط «حفظ نهائي» لإتمام الشراء.</p>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="flex gap-3">
        <button type="button" disabled={busy || loading || !confirmed || !password || (!newDrug && !selected)} className="bg-red-600 text-white rounded p-3 disabled:opacity-40" onClick={async () => {
          if (submitLock.current) return;
          submitLock.current = true; setBusy(true); setError('');
          const result = await replaceDrugAction(Number(source.id), newDrug ? null : Number(selected.id), newDrug || null, password, edits);
          if (result.success) {
            const saved = await getReplacementDrug(result.id!);
            onSuccess(result.id!, result.backupPath, saved || { ...targetInfo, ...edits, id: result.id }, edits);
          }
          else { setError(result.error || 'فشل الاستبدال'); setBusy(false); submitLock.current = false; }
        }}>{busy ? 'جاري النسخ الاحتياطي والاستبدال...' : 'نقل الروابط وحذف القديم'}</button>
        <button type="button" disabled={busy} className="border rounded p-3" onClick={onClose}>إلغاء — بدون تغيير</button>
      </div>
    </section>
  </div>;
}
