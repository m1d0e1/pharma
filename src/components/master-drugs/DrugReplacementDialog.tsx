'use client';
import React, { useState } from 'react';
import { archiveMasterDrugAction, searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeOwners, getReplacementDrug, reconcileDrugBarcodeOwnersAction, replaceDrugAction } from '@/app/actions-client/drug-replacement';

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

export default function DrugReplacementDialog({ source, target, newDrug, pendingEdit, onClose, onSuccess, onArchived }: {
  source: any; target?: any; newDrug?: any; pendingEdit?: any; onClose: () => void;
  onSuccess: (targetId: number, backupPath?: string, savedDrug?: any, edits?: Record<string, any>, reconciledIds?: number[]) => void;
  onArchived?: () => void;
}) {
  const [selected, setSelected] = useState<any>(target || null);
  const [results, setResults] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [sourceInfo, setSourceInfo] = useState<any>(null);
  const [targetInfo, setTargetInfo] = useState<any>(null);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [barcodeOwners, setBarcodeOwners] = useState<any[]>([]);
  const [ownerReviewBarcodes, setOwnerReviewBarcodes] = useState<string[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(false);
  const [ownersError, setOwnersError] = useState('');
  const [canonicalId, setCanonicalId] = useState<number | null>(null);
  const selectedId = selected?.id;
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(''); setError(''); setConfirmed(false); setEdits({});
    setSourceInfo(null); setTargetInfo(null);
    Promise.all([getReplacementDrug(Number(source.id)), selectedId ? getReplacementDrug(Number(selectedId)) : Promise.resolve(null)]).then(([old, next]) => {
      if (cancelled) return;
      if (!old || (selectedId && !next)) {
        setLoadError('تعذر تحميل بيانات الصنفين. لم يتم تغيير البيانات.');
        setLoading(false);
        return;
      }
      setSourceInfo(old);
      const comparisonTarget = selectedId && next ? next : old;
      setTargetInfo(newDrug ? { ...comparisonTarget, ...newDrug } : next);
      if (pendingEdit) setEdits(Object.fromEntries(fields.filter(([key]) => key in pendingEdit && pendingEdit[key] !== next?.[key]).map(([key]) => [key, pendingEdit[key]])));
      else if (newDrug) setEdits(Object.fromEntries(fields.filter(([key]) => key in newDrug && newDrug[key] !== comparisonTarget[key] && !((key.endsWith('_unit') || key === 'large_to_medium' || key === 'medium_to_small') && !newDrug[key])).map(([key]) => [key, newDrug[key]])));
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setLoadError('تعذر تحميل بيانات الصنفين؛ أعد المحاولة');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [source.id, selectedId, newDrug, pendingEdit, loadAttempt]);
  const edit = (key: string, value: any) => { setEdits(previous => ({ ...previous, [key]: value })); setConfirmed(false); };
  const barcodes = (drug: any): string[] => [drug?.barcode, ...(drug?.active_inventory_barcodes ?? drug?.inventory_barcodes ?? '').split(',')].filter(Boolean).map(code => String(code).trim().toLowerCase());
  const sharedBarcodes = [...new Set(barcodes(sourceInfo).filter(code => barcodes(targetInfo).includes(code)))];
  const proposedBarcode = String(pendingEdit?.barcode || newDrug?.barcode || '').trim().toLowerCase();
  const reviewBarcodes = [...new Set([...sharedBarcodes, proposedBarcode].filter(Boolean))];
  // Stock/lot barcode evidence stays pharmacy-scoped, but a barcode already visible on either
  // master record is safe to use as a lookup key for global owner identity. This lets a user
  // reconcile a real global duplicate even when the other owner's lot exists in another branch.
  const visibleMasterBarcodes = [sourceInfo?.barcode, targetInfo?.barcode]
    .filter(Boolean)
    .map(code => String(code).trim().toLowerCase())
    .filter(Boolean);
  const ownerLookupBarcodes = [...new Set([...reviewBarcodes, ...visibleMasterBarcodes])];
  const ownerLookupKey = ownerLookupBarcodes.join('|');
  React.useEffect(() => {
    let cancelled = false;
    if (!ownerLookupKey) {
      if (!loading) {
        setBarcodeOwners([]);
        setOwnerReviewBarcodes([]);
        setOwnersError('');
        setOwnersLoading(false);
        setCanonicalId(null);
      }
      return () => { cancelled = true; };
    }
    setOwnersLoading(true);
    setOwnersError('');
    const codes = ownerLookupKey.split('|').filter(Boolean);
    Promise.all(codes.map(code => findDrugBarcodeOwners(code))).then(groups => {
      if (cancelled) return;
      const sourceId = Number(sourceInfo?.id);
      const comparisonTargetId = selectedId ? Number(selectedId) : null;
      const pendingTargetId = pendingEdit && target?.id ? Number(target.id) : null;
      const relevantGroups = groups
        .map((owners, index) => ({ owners, code: codes[index] }))
        .filter(({ owners, code }) => {
          const ownerIds = new Set(owners.map((owner: any) => Number(owner.id)));
          if (!ownerIds.has(sourceId)) return false;
          if (newDrug) return Boolean(proposedBarcode && code === proposedBarcode && owners.length > 1);
          if (pendingTargetId && proposedBarcode && code === proposedBarcode && !ownerIds.has(pendingTargetId)) {
            return owners.length > 1;
          }
          return Boolean(comparisonTargetId && ownerIds.has(comparisonTargetId));
        });
      const byId = new Map<number, any>();
      for (const drug of relevantGroups.flatMap(group => group.owners)) byId.set(Number(drug.id), drug);
      const owners = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
      setBarcodeOwners(owners);
      setOwnerReviewBarcodes(relevantGroups.map(group => group.code));
      const pendingTargetIsExternal = Boolean(
        pendingTargetId
        && owners.length > 1
        && !owners.some(owner => Number(owner.id) === pendingTargetId),
      );
      setCanonicalId(previous => {
        if (pendingTargetIsExternal) return pendingTargetId;
        const needsGroupChoice = owners.length > 2 || Boolean(newDrug && owners.length > 1);
        return needsGroupChoice && owners.some(owner => Number(owner.id) === Number(previous)) ? previous : null;
      });
      setOwnersLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setBarcodeOwners([]);
      setOwnerReviewBarcodes([]);
      setCanonicalId(null);
      setOwnersError('تعذر تحميل كل الأصناف المرتبطة بهذا الباركود؛ لم يتم تغيير البيانات.');
      setOwnersLoading(false);
    });
    return () => { cancelled = true; };
  }, [ownerLookupKey, newDrug, pendingEdit, target?.id, selectedId, sourceInfo?.id, proposedBarcode, loading]);
  const pendingTargetId = pendingEdit && target?.id ? Number(target.id) : null;
  const pendingTargetIsExternal = Boolean(
    pendingTargetId
    && barcodeOwners.length > 1
    && !barcodeOwners.some(owner => Number(owner.id) === pendingTargetId),
  );
  const pendingTargetOwner = pendingTargetIsExternal && targetInfo
    ? { ...targetInfo, ...pendingEdit, id: pendingTargetId, pending_barcode_edit: true }
    : null;
  const groupOwners = pendingTargetOwner ? [...barcodeOwners, pendingTargetOwner] : barcodeOwners;
  const groupMode = groupOwners.length > 2 || Boolean(newDrug && barcodeOwners.length > 1);
  const twoOwnerBarcodeMatch = Boolean(
    !groupMode
    && barcodeOwners.length === 2
    && sourceInfo?.id
    && selected?.id
    && barcodeOwners.some(owner => Number(owner.id) === Number(sourceInfo.id))
    && barcodeOwners.some(owner => Number(owner.id) === Number(selected.id)),
  );
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
    }} className="bg-white dark:bg-slate-900 rounded-2xl p-4 sm:p-6 w-full max-w-6xl max-h-[90vh] overflow-auto space-y-4">
      <h2 id="replacement-title" className="font-bold text-xl">{onArchived ? 'تحذير: حذف آمن أو استبدال الصنف القديم' : 'تحذير: استبدال الصنف القديم وحفظ روابطه'}</h2>
      <p>الصنف القديم: {source.trade_name_en || source.trade_name || `#${source.id}`} (#{source.id})</p>
      <p>لا يمكن مشاركة الباركود بين صنفين أو حذف سجل مستخدم مباشرة. عند اختيار نقل الروابط: تُنشأ نسخة احتياطية وتُنقل دفعات المخزون والفواتير والمرتجعات والروابط إلى البديل، ثم يُحذف السجل القديم. تبقى الكميات والتكاليف وأسعار الفواتير السابقة دون تغيير.</p>
      <p className="text-amber-700">لا تستخدم الدمج لأدوية أو تركيزات أو عبوات مختلفة. أغلق الفواتير المفتوحة أو المعلقة في النوافذ الأخرى أولاً. عند إنشاء بديل جديد تُحفظ الإعدادات التشغيلية للصنف القديم.</p>
      {onArchived && <div className="border border-amber-400 rounded p-4 space-y-3">
        <h3 className="font-bold">حذف آمن بدون اختيار بديل (أرشفة)</h3>
        <p>يوقف البيع والشراء الجديد لهذا الصنف ولا يحذف كمياته أو فواتيره أو سجله الطبي. يبقى قابلاً للمراجعة في إدارة الأصناف ضمن «متوقف»، ويمكن استعادته بإلغاء «إيقاف التعامل». الباركود يبقى محجوزاً؛ استخدم نقل الروابط أدناه إذا كنت تريد استعماله لصنف بديل مطابق.</p>
        <p>الرصيد المحفوظ: {sourceInfo?.stock_quantity ?? 'جاري التحميل'} — باركود الدفعات: {sourceInfo?.inventory_barcodes || '—'}</p>
        <label className="flex gap-2"><input type="checkbox" checked={archiveConfirmed} disabled={busy} onChange={e => setArchiveConfirmed(e.target.checked)} />أوافق على إيقاف الصنف مع حفظ المخزون والسجل، وليس مسح الحركات.</label>
        <button type="button" disabled={busy || loading || !archiveConfirmed} className="w-full sm:w-auto bg-amber-700 text-white rounded p-3 disabled:opacity-40" onClick={async () => {
          if (submitLock.current) return;
          submitLock.current=true; setBusy(true); setError('');
          try {
            const result = await archiveMasterDrugAction(Number(source.id), true);
            if (result.success) onArchived();
            else { setError(result.error || 'فشل الحذف الآمن'); setBusy(false); submitLock.current=false; }
          } catch (err) {
            console.error('Archive master drug error:', err);
            setError('فشل الحذف الآمن'); setBusy(false); submitLock.current=false;
          }
        }}>تأكيد الحذف الآمن (أرشفة)</button>
      </div>}
      <p>حذف الباركود من بطاقة الصنف لا يزيله من دفعات المخزون القديمة. الاستبدال ينقل هذه الدفعات إلى الصنف الصحيح ويزيل التعارض. إذا كان دواءً مختلفاً، ألغِ العملية واستخدم باركوداً مختلفاً.</p>
      {newDrug ? <p>البديل الجديد: {newDrug.trade_name_en || newDrug.trade_name}</p> : target ? <p>البديل: {target.trade_name_en || target.trade_name} (#{target.id})</p> : <>
        <label className="block">ابحث عن الصنف البديل
          <input value={query} disabled={busy} className="w-full border rounded p-2" onChange={async e => {
            const text = e.target.value; setQuery(text); setSelected(null); setConfirmed(false); setError(''); const sequence = ++searchSequence.current;
            if (text.trim().length < 2) { setResults([]); return; }
            try {
              const response = await searchMasterDrugsAction({ query: text });
              if (sequence !== searchSequence.current) return;
              if (!response.success) {
                setResults([]);
                setError(response.error || 'تعذر البحث عن الصنف البديل');
                return;
              }
              setResults((response.data || []).filter((d: any) => Number(d.id) !== Number(source.id)));
            } catch {
              if (sequence !== searchSequence.current) return;
              setResults([]);
              setError('تعذر البحث عن الصنف البديل');
            }
          }} />
        </label>
        <div className="max-h-36 overflow-auto">{results.map(drug => <button key={drug.id} type="button" disabled={busy} className="block border rounded p-2 w-full text-right" onClick={() => { setSelected(drug); setResults([]); setConfirmed(false); }}>{drug.trade_name_en || drug.trade_name} (#{drug.id}) — {drug.barcode || 'بدون باركود'}</button>)}</div>
        {selected && <p>البديل المختار: {selected.trade_name_en || selected.trade_name} (#{selected.id})</p>}
      </>}
      {loading && <p role="status">جاري تحميل البيانات الكاملة...</p>}
      {loadError && <div className="space-y-2">
        <p role="alert" className="text-red-600">{loadError}</p>
        <button type="button" disabled={busy || loading} className="border rounded p-2" onClick={() => setLoadAttempt(attempt => attempt + 1)}>إعادة تحميل بيانات الصنفين</button>
      </div>}
      {!loading && sourceInfo && targetInfo && <>
        {(ownerReviewBarcodes.length > 0 || reviewBarcodes.length > 0) && <p className="bg-emerald-50 text-emerald-800 p-2">باركود قيد المراجعة بين البطاقة أو دفعات المخزون: {(ownerReviewBarcodes.length > 0 ? ownerReviewBarcodes : reviewBarcodes).join('، ')}</p>}
        {ownersLoading && <p role="status">جاري فحص جميع الأصناف المرتبطة بالباركود...</p>}
        {ownersError && <p role="alert" className="text-red-600">{ownersError}</p>}
        {twoOwnerBarcodeMatch && <p className="bg-blue-50 text-blue-900 dark:bg-blue-950/30 dark:text-blue-200 p-3 rounded-lg">
          الصنفان يشتركان في نفس الباركود. يمكنك مراجعة وتغيير أسماء الوحدات ومعاملات التحويل في «البيانات النهائية» قبل الدمج؛ تبقى معاملات الوحدات المحفوظة في الدفعات والفواتير السابقة دون إعادة كتابة.
        </p>}
        {groupMode && <div className="border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 rounded-xl p-4 space-y-3">
          <h3 className="font-black text-amber-900 dark:text-amber-200">تعارض باركود متعدد — {groupOwners.length} أصناف مرتبطة بنفس الباركود</h3>
          <p className="text-sm">لا تحاول دمجها اثنين اثنين. اختر السجل النهائي الصحيح؛ ستُنقل روابط ومخزون وسجل جميع الأصناف الأخرى إليه في نسخة احتياطية ومعاملة واحدة. إذا كان أي صف دواءً أو تركيزاً أو عبوة مختلفة، ألغِ العملية وصحح باركوده بدلاً من الدمج.</p>
          {pendingTargetIsExternal && <p className="text-sm font-bold text-blue-800 dark:text-blue-200">هذا التعارض ظهر بسبب تعديل باركود غير محفوظ. لإتمامه في معاملة واحدة سيبقى الصنف الذي تعدله (#{pendingTargetId}) كسجل نهائي. إذا أردت الاحتفاظ بسجل آخر، ألغِ هذه العملية وحل تعارض الباركود من شاشة إدارة الأصناف أولاً.</p>}
          <div className="grid gap-2">
            {groupOwners.map(owner => <label key={owner.id} className={`flex items-start gap-3 border rounded-lg p-3 ${Number(canonicalId) === Number(owner.id) ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950' : 'bg-white dark:bg-slate-900'}`}>
              <input
                type="radio"
                name="canonical-barcode-owner"
                aria-label={`الاحتفاظ بالصنف #${owner.id} كسجل نهائي`}
                checked={Number(canonicalId) === Number(owner.id)}
                disabled={busy || (pendingTargetIsExternal && Number(owner.id) !== pendingTargetId)}
                onChange={() => {
                  setCanonicalId(Number(owner.id));
                  setSelected(owner);
                  setConfirmed(false);
                  setError('');
                }}
              />
              <span className="flex-1">
                <b>{owner.trade_name_en || owner.trade_name || `#${owner.id}`}</b> <span className="text-slate-500">(#{owner.id})</span>
                <span className="block text-xs mt-1">الرصيد: {String(owner.stock_quantity ?? 0)} — باركود البطاقة: {owner.barcode || '—'} — باركود الدفعات: {owner.inventory_barcodes || '—'}</span>
                <span className="block text-xs mt-1">المادة الفعالة: {owner.active_ingredient || '—'} — الشركة: {owner.manufacturer || '—'} — سعر البيع: {String(owner.official_price ?? '—')}</span>
                <span className="block text-xs mt-1">الوحدات: {owner.large_unit || '—'} / {owner.medium_unit || '—'} / {owner.small_unit || '—'} — التحويل: {String(owner.large_to_medium ?? 1)} × {String(owner.medium_to_small ?? 1)}</span>
              </span>
            </label>)}
          </div>
          {!canonicalId && <p className="font-bold text-red-700">اختر أولاً الصنف الذي سيبقى كسجل نهائي.</p>}
        </div>}
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
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />{groupMode ? 'أؤكد أن جميع الأصناف المذكورة هي نفس الدواء والتركيز والشكل وحجم العبوة، وأوافق على نقل روابطها إلى السجل النهائي المختار وحذف السجلات المكررة.' : 'أؤكد أنه نفس الدواء والتركيز والشكل وحجم العبوة، وأوافق على نقل الروابط وحذف القديم.'}</label>
      <label className="block">كلمة مرور المدير الحالي<input type="password" autoComplete="current-password" className="w-full border rounded p-2" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      <p>التأكيد يحفظ التعديلات والاستبدال معاً. في شاشة الشراء: ستعود للفاتورة بالبيانات المصححة؛ راجعها ثم اضغط «حفظ نهائي» لإتمام الشراء.</p>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sticky bottom-0 bg-white/95 dark:bg-slate-900/95 py-2">
        <button type="button" disabled={busy || loading || ownersLoading || !!ownersError || !confirmed || !password || (groupMode ? !canonicalId : (!newDrug && !selected))} className="w-full sm:w-auto bg-red-600 text-white rounded p-3 disabled:opacity-40" onClick={async () => {
          if (submitLock.current) return;
          submitLock.current = true; setBusy(true); setError('');
          let result: any;
          let reconciledIds: number[] | undefined;
          try {
            if (groupMode || twoOwnerBarcodeMatch) {
              const finalId = groupMode ? Number(canonicalId) : Number(selected.id);
              const reviewedOwners = groupMode ? groupOwners : barcodeOwners;
              const sourceIds = reviewedOwners.map(owner => Number(owner.id)).filter(id => id !== finalId);
              reconciledIds = [...sourceIds, finalId];
              result = await reconcileDrugBarcodeOwnersAction(sourceIds, finalId, password, edits);
            } else {
              result = await replaceDrugAction(Number(source.id), newDrug ? null : Number(selected.id), newDrug || null, password, edits);
            }
          } catch (err) {
            console.error('Replace master drug error:', err);
            setError('فشل الاستبدال'); setBusy(false); submitLock.current = false;
            return;
          }
          if (result.success) {
            let saved: any = null;
            try {
              saved = await getReplacementDrug(result.id!);
            } catch (err) {
              console.error('Replacement completed but saved record could not be reloaded:', err);
            }
            if (reconciledIds) onSuccess(result.id!, result.backupPath, saved || { ...targetInfo, ...edits, id: result.id }, edits, reconciledIds);
            else onSuccess(result.id!, result.backupPath, saved || { ...targetInfo, ...edits, id: result.id }, edits);
          }
          else { setError(result.error || 'فشل الاستبدال'); setBusy(false); submitLock.current = false; }
        }}>{busy ? 'جاري النسخ الاحتياطي والاستبدال...' : 'نقل الروابط وحذف القديم'}</button>
        <button type="button" disabled={busy} className="w-full sm:w-auto border rounded p-3" onClick={onClose}>إلغاء — بدون تغيير</button>
      </div>
    </section>
  </div>;
}
