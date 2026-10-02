'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  correctDrugBarcodeConflictAction,
  findDrugBarcodeOwners,
  getDuplicateDrugBarcodeGroupsAction,
} from '@/app/actions-client/drug-replacement';
import DrugReplacementDialog from '@/components/master-drugs/DrugReplacementDialog';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';

type ConflictGroup = {
  barcode: string;
  owner_count: number;
  owner_ids: number[];
  owner_names: string[];
};

export default function BarcodeConflictReviewModal({
  onClose,
  onEditDrug,
  onResolved,
}: {
  onClose: () => void;
  onEditDrug: (drug: any) => void;
  onResolved?: () => void | Promise<void>;
}) {
  const [groups, setGroups] = useState<ConflictGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyBarcode, setBusyBarcode] = useState('');
  const [error, setError] = useState('');
  const [reviewingOwners, setReviewingOwners] = useState<any[]>([]);
  const [reviewingBarcode, setReviewingBarcode] = useState('');
  const [replacement, setReplacement] = useState<any>(null);
  const [correctionOwner, setCorrectionOwner] = useState<any>(null);
  const [replacementBarcode, setReplacementBarcode] = useState('');
  const [correctionPassword, setCorrectionPassword] = useState('');
  const [correctionConfirmed, setCorrectionConfirmed] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useDialogFocusTrap<HTMLElement>(!replacement);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await getDuplicateDrugBarcodeGroupsAction();
      setGroups((result || []) as ConflictGroup[]);
    } catch (err) {
      console.error('Load barcode conflicts', err);
      setGroups([]);
      setError('تعذر تحميل تعارضات الباركود. لم يتم تغيير أي بيانات.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reviewGroup = async (group: ConflictGroup) => {
    setBusyBarcode(group.barcode);
    setError('');
    setNotice('');
    setReplacement(null);
    setCorrectionOwner(null);
    setReviewingBarcode(group.barcode);
    try {
      const owners = await findDrugBarcodeOwners(group.barcode);
      if (!owners || owners.length < 2) {
        setError('تم حل هذا التعارض بالفعل؛ حدّث القائمة.');
        await load();
        return;
      }
      setReviewingOwners(owners);
    } catch (err) {
      console.error('Load barcode conflict owners', err);
      setError('تعذر تحميل الأصناف المرتبطة بهذا الباركود.');
    } finally {
      setBusyBarcode('');
    }
  };

  const chooseCanonical = (canonical: any) => {
    const source = reviewingOwners.find(owner => Number(owner.id) !== Number(canonical.id));
    if (!source) return;
    setReplacement({ source, target: canonical });
  };

  const beginCorrection = (owner: any) => {
    const current = String(owner?.barcode || '').trim();
    setCorrectionOwner(owner);
    setReplacementBarcode(current && current.toLowerCase() !== reviewingBarcode.toLowerCase() ? current : '');
    setCorrectionPassword('');
    setCorrectionConfirmed(false);
    setCorrectionError('');
    setNotice('');
  };

  const applyCorrection = async () => {
    if (!correctionOwner || !reviewingBarcode || !correctionConfirmed || !correctionPassword) return;
    setCorrectionBusy(true);
    setCorrectionError('');
    try {
      const result = await correctDrugBarcodeConflictAction(
        Number(correctionOwner.id),
        reviewingBarcode,
        replacementBarcode,
        correctionPassword,
      );
      if (!result.success) {
        setCorrectionError(result.error || 'فشل تصحيح الباركود');
        return;
      }
      setNotice(`تم تصحيح باركود الصنف #${correctionOwner.id} مع حفظ نسخة احتياطية. لم يتم تغيير الكميات أو السجل التاريخي.`);
      setCorrectionOwner(null);
      setReviewingOwners([]);
      setReviewingBarcode('');
      await load();
      await onResolved?.();
    } catch (err) {
      console.error('Correct barcode conflict', err);
      setCorrectionError('فشل تصحيح الباركود؛ لم يتم تغيير البيانات.');
    } finally {
      setCorrectionBusy(false);
    }
  };

  return <>
    <div className="fixed inset-0 z-[240] bg-black/60 flex items-center justify-center p-4" dir="rtl">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-hidden={replacement ? true : undefined} aria-labelledby="barcode-conflict-title" tabIndex={-1} className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-full max-w-5xl max-h-[88vh] overflow-auto space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="barcode-conflict-title" className="font-black text-2xl">تعارضات الباركود — {groups.length}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">كل صف يعني أن نفس الباركود مرتبط بأكثر من صنف نشط أو دفعة غير صفرية. لا يتم أي دمج تلقائي.</p>
          </div>
          <button type="button" className="border rounded-lg px-3 py-2" onClick={onClose}>إغلاق</button>
        </div>

        <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 p-3 text-sm">
          إذا كانت السجلات لنفس الدواء والتركيز والشكل وحجم العبوة، اختر السجل النهائي ثم استخدم الدمج الآمن. إذا كانت أدوية أو تركيزات أو عبوات مختلفة، لا تدمجها؛ عدّل الباركود الخاطئ للصنف بدلاً من ذلك.
        </div>

        {loading && <p role="status">جاري فحص الباركودات...</p>}
        {error && <p role="alert" className="text-red-600 font-bold">{error}</p>}
        {notice && <p role="status" className="text-emerald-700 font-bold">{notice}</p>}
        {!loading && groups.length === 0 && !error && <p className="text-emerald-700 font-bold">لا توجد تعارضات باركود نشطة.</p>}

        {!loading && groups.length > 0 && <div className="space-y-3">
          {groups.map(group => <div key={group.barcode} className="border rounded-xl p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-mono font-black">{group.barcode}</div>
                <div className="text-xs text-slate-500">{group.owner_count} أصناف — IDs: {group.owner_ids.join(', ')}</div>
              </div>
              <button type="button" disabled={Boolean(busyBarcode)} className="bg-amber-600 text-white rounded-lg px-4 py-2 disabled:opacity-50" onClick={() => void reviewGroup(group)}>
                {busyBarcode === group.barcode ? 'جاري التحميل...' : 'مراجعة التعارض'}
              </button>
            </div>
            <div className="text-sm break-words">{group.owner_names.join(' | ')}</div>
          </div>)}
        </div>}

        {reviewingOwners.length >= 2 && !replacement && <div className="border-2 border-blue-300 rounded-xl p-4 space-y-3">
          <h3 className="font-black">{reviewingOwners.length > 2 ? 'كل الأصناف المرتبطة بهذا الباركود — راجع قبل الدمج أو التصحيح' : 'اختر السجل النهائي إذا كانا نفس المنتج، أو صحح الباركود إذا كانا مختلفين'}</h3>
          {reviewingOwners.map(owner => <div key={owner.id} className="border rounded-lg p-3 flex flex-wrap justify-between items-center gap-3">
            <div>
              <b>{owner.trade_name_en || owner.trade_name || `#${owner.id}`}</b> <span className="text-slate-500">(#{owner.id})</span>
              <div className="text-xs text-slate-500 mt-1">
                السعر: {String(owner.official_price ?? '—')} — الرصيد: {String(owner.stock_quantity ?? 0)} — الشركة: {owner.manufacturer || '—'} — المادة الفعالة: {owner.active_ingredient || '—'}
              </div>
              <div className="text-xs text-slate-500">الوحدات: {owner.large_unit || '—'} / {owner.medium_unit || '—'} / {owner.small_unit || '—'} — باركود البطاقة: {owner.barcode || '—'} — دفعات: {owner.inventory_barcodes || '—'}</div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {reviewingOwners.length === 2 && <button type="button" className="bg-emerald-700 text-white rounded px-3 py-2" onClick={() => chooseCanonical(owner)}>الاحتفاظ بالصنف #{owner.id}</button>}
              <button type="button" className="border border-amber-500 text-amber-800 dark:text-amber-200 rounded px-3 py-2" onClick={() => beginCorrection(owner)}>تصحيح باركود #{owner.id}</button>
              <button type="button" className="border rounded px-3 py-2" onClick={() => onEditDrug(owner)}>فتح بطاقة الصنف #{owner.id}</button>
            </div>
          </div>)}
          {reviewingOwners.length > 2 && <button type="button" className="bg-emerald-700 text-white rounded-lg px-4 py-3 font-bold" onClick={() => setReplacement({ source: reviewingOwners[0], target: reviewingOwners[1] })}>فتح الدمج الجماعي</button>}
        </div>}

        {correctionOwner && <div className="border-2 border-amber-400 rounded-xl p-4 space-y-3 bg-amber-50/60 dark:bg-amber-950/20">
          <h3 className="font-black">تصحيح باركود الصنف #{correctionOwner.id}</h3>
          <p className="text-sm">سيتم تغيير باركود بطاقة هذا الصنف والدفعات النشطة فقط من <b className="font-mono">{reviewingBarcode}</b>. الدفعات ذات الرصيد صفر والسجل التاريخي ستبقى كما هي.</p>
          <label className="block font-bold">الباركود الصحيح للصنف #{correctionOwner.id}
            <input
              aria-label={`الباركود الصحيح للصنف #${correctionOwner.id}`}
              className="w-full border rounded-lg p-2 mt-1 font-mono"
              value={replacementBarcode}
              disabled={correctionBusy}
              placeholder="اتركه فارغاً لإزالة الباركود الخاطئ"
              onChange={event => { setReplacementBarcode(event.target.value); setCorrectionConfirmed(false); setCorrectionError(''); }}
            />
          </label>
          <label className="block font-bold">كلمة مرور المدير لتصحيح الباركود
            <input
              aria-label="كلمة مرور المدير لتصحيح الباركود"
              type="password"
              autoComplete="current-password"
              className="w-full border rounded-lg p-2 mt-1"
              value={correctionPassword}
              disabled={correctionBusy}
              onChange={event => setCorrectionPassword(event.target.value)}
            />
          </label>
          <label className="flex gap-2 items-start text-sm font-bold">
            <input
              type="checkbox"
              aria-label={`أؤكد أن الباركود الحالي ${reviewingBarcode} خاطئ لهذا الصنف`}
              checked={correctionConfirmed}
              disabled={correctionBusy}
              onChange={event => setCorrectionConfirmed(event.target.checked)}
            />
            أؤكد أن الباركود الحالي {reviewingBarcode} خاطئ لهذا الصنف، وأن الباركود الجديد لا يخص منتجاً آخر.
          </label>
          {correctionError && <p role="alert" className="text-red-600 font-bold">{correctionError}</p>}
          <div className="flex gap-2 flex-wrap">
            <button type="button" disabled={correctionBusy || !correctionConfirmed || !correctionPassword} className="bg-amber-700 text-white rounded-lg px-4 py-2 disabled:opacity-40" onClick={() => void applyCorrection()}>{correctionBusy ? 'جاري التصحيح...' : 'تطبيق تصحيح الباركود'}</button>
            <button type="button" disabled={correctionBusy} className="border rounded-lg px-4 py-2" onClick={() => { setCorrectionOwner(null); setCorrectionError(''); }}>إلغاء التصحيح</button>
          </div>
        </div>}
      </section>
    </div>

    {replacement && <DrugReplacementDialog
      {...replacement}
      onClose={() => setReplacement(null)}
      onSuccess={async () => {
        setReplacement(null);
        setReviewingOwners([]);
        await load();
        await onResolved?.();
      }}
    />}
  </>;
}
