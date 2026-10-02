'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, LockKeyhole, ShieldCheck, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { applyMasterDrugCatalogUpdateAction } from '@/app/actions-client/master-drugs';
import { catalogFieldLabels } from '@/lib/inventory/catalog-update';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';
import type {
  CatalogFieldDecisionAction,
  CatalogMutableField,
  CatalogNewDrugDecisionAction,
  CatalogProtectedField,
  MasterDrugCatalogUpdatePreview,
} from '@/lib/inventory/catalog-update';

interface Props {
  preview: MasterDrugCatalogUpdatePreview;
  rows: Record<string, unknown>[];
  sourceName: string;
  onClose: () => void;
  onApplied: (result: any) => Promise<void> | void;
  onReviewStale?: () => Promise<void> | void;
}

const valueText = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '—';
  if (value === 1) return 'نعم / 1';
  if (value === 0) return 'لا / 0';
  return String(value);
};

const fieldKey = (catalogDrugId: number, masterDrugId: number, field: string) =>
  `${catalogDrugId}:${masterDrugId}:${field}`;

export default function DrugCatalogUpdateReviewModal({ preview, rows, sourceName, onClose, onApplied, onReviewStale }: Props) {
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(true);
  const isDrugEyeSource = /egypt_drugs_drugeye/i.test(sourceName);
  const initialFieldDecisions = useMemo(() => {
    const decisions = new Map<string, CatalogFieldDecisionAction>();
    for (const drug of preview.changedDrugs) {
      for (const change of drug.changes) {
        decisions.set(
          fieldKey(drug.catalogDrugId, drug.masterDrugId, change.field),
          change.defaultDecision,
        );
      }
    }
    return decisions;
  }, [preview]);

  const initialNewDecisions = useMemo(() => new Map<number, CatalogNewDrugDecisionAction>(
    preview.newDrugs.map(drug => [
      drug.catalogDrugId,
      isDrugEyeSource && !drug.suppressed ? 'add' : 'keep_absent',
    ] as const),
  ), [preview, isDrugEyeSource]);

  const [fieldDecisions, setFieldDecisions] = useState(initialFieldDecisions);
  const [newDecisions, setNewDecisions] = useState(initialNewDecisions);
  const [adminPassword, setAdminPassword] = useState('');
  const [applying, setApplying] = useState(false);
  const [showCurrentOnly, setShowCurrentOnly] = useState(false);

  const catalogFieldSelections = [...fieldDecisions.values()].filter(value => value === 'use_catalog').length;
  const selectedNewDrugs = [...newDecisions.values()].filter(value => value === 'add').length;

  const setFieldDecision = (
    catalogDrugId: number,
    masterDrugId: number,
    field: CatalogMutableField,
    action: CatalogFieldDecisionAction,
  ) => {
    setFieldDecisions(current => {
      const next = new Map(current);
      next.set(fieldKey(catalogDrugId, masterDrugId, field), action);
      return next;
    });
  };

  const keepAllLocal = () => {
    setFieldDecisions(current => new Map([...current.keys()].map(key => [key, 'keep_local' as const])));
  };

  const useAllCatalog = () => {
    const blockedKeys = new Set(preview.changedDrugs.flatMap(drug => drug.changes
      .filter(change => Boolean(change.blockedReason))
      .map(change => fieldKey(drug.catalogDrugId, drug.masterDrugId, change.field))));
    setFieldDecisions(current => new Map([...current.keys()].map(key => [
      key,
      blockedKeys.has(key) ? 'keep_local' as const : 'use_catalog' as const,
    ])));
  };

  const keepAllAbsent = () => {
    setNewDecisions(current => new Map([...current.keys()].map(key => [key, 'keep_absent' as const])));
  };

  const addAllUnsuppressed = () => {
    setNewDecisions(new Map(preview.newDrugs.map(drug => [
      drug.catalogDrugId,
      drug.suppressed ? 'keep_absent' : 'add',
    ] as const)));
  };

  const handleApply = async () => {
    if (!adminPassword.trim()) {
      toast.error('أدخل كلمة مرور المالك أو المدير لإنشاء النسخة الاحتياطية قبل التحديث');
      return;
    }

    setApplying(true);
    try {
      const decisions = preview.changedDrugs.flatMap(drug => drug.changes.map(change => ({
        catalogDrugId: drug.catalogDrugId,
        masterDrugId: drug.masterDrugId,
        field: change.field,
        action: fieldDecisions.get(fieldKey(drug.catalogDrugId, drug.masterDrugId, change.field)) || 'keep_local',
        expectedCurrentValue: change.currentValue,
        expectedIncomingValue: change.incomingValue,
      })));
      const newDrugDecisions = preview.newDrugs.map(drug => ({
        catalogDrugId: drug.catalogDrugId,
        action: newDecisions.get(drug.catalogDrugId) || 'keep_absent' as const,
      }));

      const result = await applyMasterDrugCatalogUpdateAction({
        rows,
        previewSignature: preview.signature,
        fieldDecisions: decisions,
        newDrugDecisions,
        identityConflictDecisions: preview.identityConflicts.map(conflict => ({
          catalogDrugId: conflict.catalogDrugId,
          action: 'keep_local' as const,
        })),
        sourceName,
        adminPassword,
      });
      if (!result.success || !result.data) {
        const message = result.error || 'فشل تطبيق تحديث دليل الأدوية';
        if (/changed while it was being reviewed/i.test(message) && onReviewStale) {
          await onReviewStale();
          toast.error('تغير دليل الأدوية أثناء المراجعة. تم تحديث المقارنة؛ راجع القرارات مرة أخرى قبل التطبيق.');
          return;
        }
        throw new Error(message);
      }
      await onApplied(result.data);
    } catch (error: any) {
      toast.error(error?.message || String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-slate-950/70 backdrop-blur-sm p-3 md:p-6" dir="rtl">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="catalog-review-title" tabIndex={-1} className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-6 w-6" />
              <span className="text-sm font-black">مراجعة آمنة قبل أي تعديل</span>
            </div>
            <h2 id="catalog-review-title" className="mt-1 text-2xl font-black text-slate-950 dark:text-white">مراجعة تحديث دليل الأدوية</h2>
            <p className="mt-1 text-sm font-bold text-slate-500">{sourceName}</p>
          </div>
          <button type="button" onClick={onClose} disabled={applying} className="rounded-2xl p-3 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800" aria-label="إغلاق مراجعة تحديث دليل الأدوية">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['أدوية بها تغييرات', preview.summary.changedDrugCount],
              ['حقول قابلة للمراجعة', preview.summary.changedFieldCount],
              ['أدوية جديدة/كانت محذوفة', preview.summary.newDrugCount],
              ['تعارضات هوية', preview.summary.identityConflictCount],
            ].map(([label, count]) => (
              <div key={String(label)} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <p className="text-xs font-black text-slate-500">{label}</p>
                <p className="mt-1 text-2xl font-black text-slate-950 dark:text-white">{count}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="flex items-center gap-2 font-black"><CheckCircle2 className="h-5 w-5" /> البيانات التشغيلية محمية</div>
              <p className="mt-2 text-sm font-bold">المخزون المتأثر: 0 · السجل التاريخي المتأثر: 0 · أرقام master_drugs الحالية لا يتم تبديلها.</p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex items-center gap-2 font-black"><AlertTriangle className="h-5 w-5" /> الوضع الافتراضي محافظ</div>
              <p className="mt-2 text-sm font-bold">كل إصدار جديد يبدأ بالاحتفاظ بالقيمة المحلية. الاختيارات السابقة تظهر كتذكير فقط ولا تعتمد قيمة دليل جديدة تلقائياً، وأي صنف غير موجود محلياً لا يُضاف إلا إذا اخترته أنت.</p>
            </div>
          </div>

          {preview.changedDrugs.length > 0 && (
            <section className="mt-6">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black">الحقول المتغيرة</h3>
                  <p className="text-sm font-bold text-slate-500">اختر القيمة المحلية أو قيمة الدليل لكل حقل.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={keepAllLocal} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-black hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                    الاحتفاظ بكل القيم المحلية
                  </button>
                  <button type="button" onClick={useAllCatalog} className="rounded-xl border border-emerald-300 px-4 py-2 text-sm font-black text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30">
                    استخدام الدليل لكل الحقول القابلة للمراجعة
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                {preview.changedDrugs.map(drug => (
                  <details key={drug.catalogDrugId} className="rounded-2xl border border-slate-200 bg-slate-50/60 open:bg-white dark:border-slate-800 dark:bg-slate-900/40 dark:open:bg-slate-950">
                    <summary className="cursor-pointer px-4 py-4 font-black">
                      {drug.name} <span className="mr-2 text-xs text-slate-500">#{drug.masterDrugId} · {drug.changes.length + drug.protectedChanges.length} اختلاف</span>
                    </summary>
                    <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                      <table className="w-full min-w-[760px] text-sm">
                        <thead className="bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                          <tr><th className="p-3 text-right">الحقل</th><th className="p-3 text-right">الحالي</th><th className="p-3 text-right">الدليل الجديد</th><th className="p-3 text-right">القرار</th></tr>
                        </thead>
                        <tbody>
                          {drug.changes.map(change => {
                            const key = fieldKey(drug.catalogDrugId, drug.masterDrugId, change.field);
                            const decision = fieldDecisions.get(key) || 'keep_local';
                            return (
                              <tr key={change.field} className="border-t border-slate-100 dark:border-slate-900">
                                <td className="p-3 font-black">{change.label}</td>
                                <td className="p-3 font-mono text-xs">{valueText(change.currentValue)}</td>
                                <td className="p-3 font-mono text-xs">{valueText(change.incomingValue)}</td>
                                <td className="p-3">
                                  <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={() => setFieldDecision(drug.catalogDrugId, drug.masterDrugId, change.field, 'keep_local')} className={`rounded-lg px-3 py-2 text-xs font-black ${decision === 'keep_local' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-950' : 'border border-slate-300 dark:border-slate-700'}`}>احتفظ بالمحلي</button>
                                    <button type="button" disabled={Boolean(change.blockedReason)} onClick={() => setFieldDecision(drug.catalogDrugId, drug.masterDrugId, change.field, 'use_catalog')} className={`rounded-lg px-3 py-2 text-xs font-black disabled:cursor-not-allowed disabled:opacity-40 ${decision === 'use_catalog' ? 'bg-emerald-600 text-white' : 'border border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300'}`}>استخدم الدليل</button>
                                  </div>
                                  {change.blockedReason && (
                                    <p className="mt-2 max-w-xl text-[11px] font-black text-rose-700 dark:text-rose-300">لا يمكن استخدام قيمة الدليل الآن: {change.blockedReason}</p>
                                  )}
                                  {change.policy && (
                                    <p className="mt-2 text-[11px] font-bold text-slate-500">
                                      الاختيار السابق: {change.policy === 'catalog' ? 'استخدام الدليل' : change.policy === 'local' ? 'الاحتفاظ بالمحلي' : 'السؤال في كل مرة'}
                                    </p>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {drug.protectedChanges.map(change => (
                            <tr key={`protected-${change.field}`} className="border-t border-amber-100 bg-amber-50/60 dark:border-amber-950 dark:bg-amber-950/20">
                              <td className="p-3 font-black"><span className="inline-flex items-center gap-1"><LockKeyhole className="h-4 w-4" /> {change.label}</span></td>
                              <td className="p-3 font-mono text-xs">{valueText(change.currentValue)}</td>
                              <td className="p-3 font-mono text-xs line-through opacity-60">{valueText(change.incomingValue)}</td>
                              <td className="p-3 text-xs font-black text-amber-800 dark:text-amber-300">محمي محلياً — لن يتغير</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}

          {preview.newDrugs.length > 0 && (
            <section className="mt-7">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black">أدوية غير موجودة حالياً</h3>
                  <p className="mt-1 text-sm font-bold text-slate-500">
                    {isDrugEyeSource
                      ? 'ملف DrugEye بدون أرقام IDs؛ الأصناف ذات الأسماء الفريدة غير الموجودة محلياً محددة للإضافة تلقائياً بأرقام جديدة، بينما المحذوف سابقاً يبقى غير مضاف.'
                      : 'قد تكون أدوية جديدة فعلاً أو أدوية حذفها المستخدم سابقاً. لذلك لا يتم تحديد أي منها للإضافة تلقائياً.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {isDrugEyeSource && (
                    <button type="button" onClick={addAllUnsuppressed} className="rounded-xl border border-emerald-300 px-4 py-2 text-sm font-black text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30">
                      إضافة كل الأصناف الجديدة الآمنة
                    </button>
                  )}
                  <button type="button" onClick={keepAllAbsent} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-black hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                    إبقاء كل غير الموجود محذوفاً/غير مضاف
                  </button>
                </div>
              </div>
              <div className="mt-3 max-h-[28rem] overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800">
                {preview.newDrugs.map(drug => {
                  const action = newDecisions.get(drug.catalogDrugId) || 'keep_absent';
                  const protectedFields = new Set(drug.protectedIncomingFields);
                  return (
                    <div key={drug.catalogDrugId} className="border-b border-slate-100 p-4 last:border-0 dark:border-slate-900">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="font-black">{drug.name} <span className="text-xs text-slate-500">#{drug.catalogDrugId}</span></p>
                          <p className="mt-1 text-xs font-bold text-slate-500">{drug.suppressed ? 'تم اختيار إبقائه محذوفاً في تحديث سابق' : 'غير موجود في قاعدة البيانات الحالية'}</p>
                        </div>
                        <label className="flex cursor-pointer items-center gap-2 text-sm font-black">
                          <input type="checkbox" aria-label={`${drug.name} — إضافة`} checked={action === 'add'} onChange={event => setNewDecisions(current => {
                            const next = new Map(current);
                            next.set(drug.catalogDrugId, event.target.checked ? 'add' : 'keep_absent');
                            return next;
                          })} className="h-5 w-5" />
                          إضافة
                        </label>
                      </div>
                      <details className="mt-3 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/60">
                        <summary className="cursor-pointer text-xs font-black">عرض كل الحقول التي ستُستخدم أو تُتجاهل قبل الإضافة</summary>
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full min-w-[620px] text-xs">
                            <thead>
                              <tr className="text-slate-500"><th className="p-2 text-right">الحقل</th><th className="p-2 text-right">القيمة الواردة</th><th className="p-2 text-right">ما سيحدث</th></tr>
                            </thead>
                            <tbody>
                              {Object.entries(drug.incoming).map(([field, value]) => {
                                const isProtected = protectedFields.has(field as CatalogProtectedField);
                                const label = catalogFieldLabels[field as keyof typeof catalogFieldLabels] || field;
                                return (
                                  <tr key={field} className="border-t border-slate-200 dark:border-slate-800">
                                    <td className="p-2 font-black">{label}</td>
                                    <td className="p-2 font-mono">{valueText(value)}</td>
                                    <td className={`p-2 font-black ${isProtected ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                                      {isProtected ? 'محمي محلياً — لن يُنسخ من الدليل' : 'سيُضاف عند اختيار إضافة'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {preview.identityConflicts.length > 0 && (
            <section className="mt-7 rounded-2xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900/60 dark:bg-rose-950/20">
              <h3 className="font-black text-rose-900 dark:text-rose-200">تعارضات هوية — لن يتم الدمج تلقائياً</h3>
              <p className="mt-1 text-sm font-bold text-rose-700 dark:text-rose-300">هذه الأرقام مستخدمة محلياً لدواء مختلف. سيبقى الدواء المحلي كما هو ويتم تجاهل سجل الدليل حتى تتم مراجعته يدوياً.</p>
              <div className="mt-3 space-y-2">
                {preview.identityConflicts.map(conflict => (
                  <div key={conflict.catalogDrugId} className="rounded-xl bg-white p-3 text-sm dark:bg-slate-950">
                    <span className="font-black">#{conflict.catalogDrugId}</span> · المحلي: <b>{conflict.currentName}</b> · الدليل: <b>{conflict.incomingName}</b>
                  </div>
                ))}
              </div>
            </section>
          )}

          {preview.summary.currentOnlyCount > 0 && (
            <section className="mt-7 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
              <button type="button" onClick={() => setShowCurrentOnly(value => !value)} className="font-black">
                {showCurrentOnly ? 'إخفاء' : 'عرض'} عينة من {preview.summary.currentOnlyCount} صنف محلي غير موجود في الملف — كلها محفوظة بدون تغيير
              </button>
              {showCurrentOnly && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {preview.currentOnlySample.map(drug => <div key={drug.masterDrugId} className="rounded-xl bg-slate-50 p-2 text-xs font-bold dark:bg-slate-900">{drug.name} · #{drug.masterDrugId}</div>)}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/50">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <div className="flex items-center gap-2 font-black"><DatabaseBackup className="h-5 w-5" /> نسخة احتياطية إلزامية قبل التطبيق</div>
              <p className="mt-1 text-xs font-bold text-slate-500">سيتم التحقق من كلمة المرور وإنشاء نسخة SQLite كاملة وسليمة قبل بدء أي كتابة.</p>
              <input type="password" autoComplete="current-password" value={adminPassword} onChange={event => setAdminPassword(event.target.value)} disabled={applying} placeholder="كلمة مرور المالك أو المدير" className="mt-3 w-full max-w-md rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold outline-none focus:border-emerald-500 dark:border-slate-700 dark:bg-slate-950" />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="ml-2 text-left text-xs font-bold text-slate-500">{catalogFieldSelections} حقل سيأخذ قيمة الدليل · {selectedNewDrugs} صنف سيُضاف</div>
              <button type="button" onClick={onClose} disabled={applying} className="rounded-xl border border-slate-300 px-5 py-3 font-black disabled:opacity-50 dark:border-slate-700">إلغاء</button>
              <button type="button" onClick={handleApply} disabled={applying || !adminPassword.trim()} className="rounded-xl bg-emerald-600 px-6 py-3 font-black text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-50">
                {applying ? 'جاري إنشاء النسخة والتطبيق...' : 'إنشاء نسخة احتياطية ثم تطبيق القرارات'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
