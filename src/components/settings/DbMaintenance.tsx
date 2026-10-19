'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Database, ShieldAlert, Sparkles, RefreshCw } from 'lucide-react';
import { runDatabaseMaintenanceClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';
import { getClientSession, isOwnerOrAdmin } from '@/lib/auth/local';
import { isStaffOwner } from '@/lib/auth/staff-policy';
import { isTauri } from '@/lib/env';
import { invoke } from '@tauri-apps/api/core';
import { dbGet } from '@/lib/db/tauri';

type BackupRecoveryPreview = {
  status: string;
  backupId: string;
  sourceName: string;
  sizeBytes: number;
  createdUnixMs: number;
  createdByOwner: string | null;
  sha256: string;
  warning: string;
};

type RecoveryRehearsalResult = {
  status: string;
  requestId: string;
  backupId: string;
  sha256: string;
  sizeBytes: number;
  migrationCount: number;
  warning: string;
};

type FinancialSourceReconciliation = {
  status: 'review_required' | 'limited_no_findings';
  scannedJournals: number;
  unverifiableLegacyJournals: number;
  stockProvenance: {
    recorded: number;
    structurallyVerified: number;
    reviewRequired: number;
    unattributedAdjustments: number;
  };
  maxFindings: number;
  findings: Array<{ recordId: string; issueCode: string; classification: string; sourceType: string }>;
};

// A location chosen by the renderer is never an authority to read a backup.
// Only extract the native UUID directory from our own last export response;
// the verification command independently resolves and validates its path.
function backupIdFromNativePath(path: string): string {
  const match = path.match(/(?:^|[\\/])([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[\\/]pharma_local\.db$/);
  return match?.[1] || '';
}

export default function DbMaintenance() {
  const [running, setRunning] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupPath, setBackupPath] = useState('');
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [rehearsalRunning, setRehearsalRunning] = useState(false);
  const [reconciliationRunning, setReconciliationRunning] = useState(false);
  const [reconciliation, setReconciliation] = useState<FinancialSourceReconciliation | null>(null);
  const [rehearsalRequestId, setRehearsalRequestId] = useState('');
  const [rehearsalResult, setRehearsalResult] = useState<RecoveryRehearsalResult | null>(null);
  const [backupId, setBackupId] = useState('');
  const [verifiedBackup, setVerifiedBackup] = useState<BackupRecoveryPreview | null>(null);
  const [backupAllowed, setBackupAllowed] = useState(false);
  const [maintenanceAllowed, setMaintenanceAllowed] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [repairNote, setRepairNote] = useState('');
  const [repairBackupPath, setRepairBackupPath] = useState('');
  const [walletReviewNote, setWalletReviewNote] = useState('');
  const operationLockRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    if (isTauri) {
      void getClientSession().then(async user => {
        if (mounted) setBackupAllowed(user?.role?.trim().toLowerCase() === 'owner');
        if (mounted) setMaintenanceAllowed(isStaffOwner(user));
        if (isOwnerOrAdmin(user)) {
          const row = await dbGet<{ value: string | null; backup_path: string | null; wallet_review: string | null }>("SELECT (SELECT value FROM config WHERE key='catalog_csv_repair_status') AS value, (SELECT value FROM config WHERE key='catalog_csv_repair_backup_path') AS backup_path, (SELECT value FROM config WHERE key='legacy_patient_wallet_review_status') AS wallet_review");
          if (mounted) {
            setRepairNote(row?.value || '');
            setRepairBackupPath(row?.backup_path || '');
            setWalletReviewNote(row?.wallet_review || '');
          }
        }
      }).catch(() => { /* Keep backup unavailable without a verified user. */ });
    }
    return () => { mounted = false; };
  }, []);

  const handleBackup = async () => {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setBackupRunning(true);
    setBackupPath('');
    try {
      const user = await getClientSession();
      if (user?.role?.trim().toLowerCase() !== 'owner') throw new Error('حفظ نسخة كاملة لجميع الفروع متاح للمالك فقط');
      const path = await invoke<string>('export_database_backup', { userId: user!.id, password: backupPassword });
      setBackupPath(path);
      setBackupId(backupIdFromNativePath(path));
      setVerifiedBackup(null);
      setRehearsalResult(null);
      toast.success('تم حفظ نسخة كاملة تشمل أحدث البيانات');
    } catch (error) {
      toast.error(`فشل حفظ النسخة الاحتياطية: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      operationLockRef.current = false;
      setBackupRunning(false);
      setBackupPassword('');
    }
  };

  const handleStageRehearsal = async () => {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setRehearsalRunning(true);
    setRehearsalResult(null);
    try {
      const user = await getClientSession();
      if (user?.role?.trim().toLowerCase() !== 'owner') throw new Error('فحص الاستعادة المعزول متاح للمالك فقط');
      if (!verifiedBackup || verifiedBackup.backupId !== backupId.trim()) {
        throw new Error('افحص سلامة هذه النسخة أولاً دون أي استعادة');
      }
      const result = await invoke<RecoveryRehearsalResult>('stage_database_recovery_rehearsal_native', {
        backupId: backupId.trim(), requestId: rehearsalRequestId.trim(), password: backupPassword,
      });
      if (result.status !== 'verified_isolated_copy_only' ||
          result.backupId !== backupId.trim() || result.requestId !== rehearsalRequestId.trim() ||
          result.sha256 !== verifiedBackup.sha256) {
        throw new Error('لم تثبت سلامة النسخة المعزولة أو هوية طلب الفحص');
      }
      setRehearsalResult(result);
      toast.success('اكتمل فحص نسخة معزولة فقط؛ لم تتم استعادة أي قاعدة بيانات');
    } catch (error) {
      toast.error(`فشل فحص النسخة المعزولة: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      operationLockRef.current = false;
      setRehearsalRunning(false);
      setBackupPassword('');
    }
  };

  const handleReconciliation = async () => {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setReconciliationRunning(true);
    setReconciliation(null);
    try {
      const user = await getClientSession();
      if (user?.role?.trim().toLowerCase() !== 'owner') throw new Error('فحص السجل المالي الشامل متاح للمالك فقط');
      const report = await invoke<FinancialSourceReconciliation>('reconcile_financial_sources_native');
      if (!report || !['review_required','limited_no_findings'].includes(report.status) ||
          !Array.isArray(report.findings) || report.findings.length > 200 ||
          !Number.isSafeInteger(report.scannedJournals) || report.scannedJournals < 0 ||
          !Number.isSafeInteger(report.unverifiableLegacyJournals) || report.unverifiableLegacyJournals < 0 ||
          !report.stockProvenance ||
          ![report.stockProvenance.recorded, report.stockProvenance.structurallyVerified,
            report.stockProvenance.reviewRequired, report.stockProvenance.unattributedAdjustments]
            .every(count => Number.isSafeInteger(count) && count >= 0) ||
          report.stockProvenance.structurallyVerified + report.stockProvenance.reviewRequired !==
            report.stockProvenance.recorded) {
        throw new Error('رد غير موثوق من فحص مرجعيات السجل المالي');
      }
      setReconciliation(report);
      toast.success('اكتمل الفحص التشخيصي دون تعديل الحسابات أو المخزون');
    } catch (error) {
      toast.error(`تعذر فحص مرجعيات الحسابات: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      operationLockRef.current = false;
      setReconciliationRunning(false);
    }
  };

  const handleVerifyBackup = async () => {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setVerifyRunning(true);
    setVerifiedBackup(null);
    setRehearsalResult(null);
    try {
      const user = await getClientSession();
      if (user?.role?.trim().toLowerCase() !== 'owner') throw new Error('التحقق من النسخة الكاملة متاح للمالك فقط');
      const preview = await invoke<BackupRecoveryPreview>('verify_database_backup_recovery_preview', {
        backupId: backupId.trim(), password: backupPassword,
      });
      if (preview.status !== 'verified_read_only_preview' || preview.backupId !== backupId.trim()) {
        throw new Error('لم يتم التحقق من بيانات النسخة الاحتياطية');
      }
      setVerifiedBackup(preview);
      toast.success('اجتازت النسخة اختبارات السلامة الأولية؛ الاستعادة غير مفعلة');
    } catch (error) {
      toast.error(`فشل فحص النسخة الاحتياطية: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      operationLockRef.current = false;
      setVerifyRunning(false);
      setBackupPassword('');
    }
  };

  const handleMaintenance = async () => {
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    setRunning(true);
    const toastId = toast.loading('جاري إجراء صيانة قاعدة البيانات (VACUUM & ANALYZE)...');
    try {
      const result = await runDatabaseMaintenanceClient();
      if (result.success) {
        toast.success(result.message || 'تم تحسين قاعدة البيانات بنجاح', { id: toastId });
      } else {
        toast.error(result.error || 'فشلت عملية الصيانة', { id: toastId });
      }
    } catch (err) {
      console.error('Maintenance execution error:', err);
      toast.error('حدث خطأ غير متوقع أثناء تنفيذ الصيانة', { id: toastId });
    } finally {
      operationLockRef.current = false;
      setRunning(false);
    }
  };

  return (
    <div className="bg-slate-950 p-6 sm:p-8 rounded-3xl text-white shadow-xl border border-slate-800">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-2xl">
          <Database className="w-6 h-6 text-blue-400" />
        </div>
        <div>
          <h4 className="text-xl font-bold">النسخ الاحتياطي وصيانة قاعدة البيانات</h4>
          <p className="text-slate-400 text-sm">حفظ نسخة كاملة من بيانات النظام وتحسين التخزين المحلي</p>
        </div>
      </div>

      <div className="space-y-4">
        {repairNote && (
          <div role="note" aria-label="حالة التصحيح المحلي" className="p-4 rounded-xl bg-white/10 text-sm space-y-2">
            <p>{repairNote}</p>
            {repairBackupPath && <><p>نسخة ما قبل التصحيح:</p><p dir="ltr" className="break-all select-all text-xs">{repairBackupPath}</p></>}
          </div>
        )}
        {walletReviewNote && (
          <div role="note" aria-label="مراجعة محافظ العملاء القديمة" className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-100">
            <p>{walletReviewNote}</p>
          </div>
        )}
        {backupAllowed && (
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl space-y-4">
            <p className="text-sm text-slate-300">
              يحفظ الزر نسخة SQLite متسقة تشمل أحدث التغييرات المحفوظة، ومعها ملف backup_manifest.json للتحقق من سلامة النسخة. احتفظ بملف قاعدة البيانات وملف بيان النسخة معاً داخل مجلد النسخة الأصلي؛ لا تنسخ ملفات WAL وSHM يدوياً، ولا ترسل ملفات المرضى أو الحسابات إلا إلى جهة دعم موثوقة عبر قناة آمنة. التحقق من النسخة لا يعني الموافقة على استعادتها.
            </p>
            <label className="block text-sm">
              كلمة مرور حسابك لتأكيد النسخ الاحتياطي
              <input type="password" autoComplete="current-password" value={backupPassword}
                onChange={event => setBackupPassword(event.target.value)} disabled={backupRunning || verifyRunning || rehearsalRunning}
                className="block w-full mt-2 p-3 rounded-xl bg-slate-800" />
            </label>
            <button type="button" onClick={handleBackup} disabled={running || backupRunning || verifyRunning || rehearsalRunning || reconciliationRunning || !backupPassword}
              className="w-full py-4 bg-emerald-700 rounded-2xl font-bold disabled:opacity-50">
              {backupRunning ? 'جاري حفظ النسخة...' : 'حفظ نسخة احتياطية كاملة'}
            </button>
            {backupPath && (
              <div role="status" className="text-sm space-y-2">
                <p>تم حفظ النسخة الكاملة. احتفظ بملف النسخة وملف backup_manifest.json المجاور له معاً. مكان ملف قاعدة البيانات:</p>
                <p dir="ltr" className="text-xs break-all select-all">{backupPath}</p>
              </div>
            )}
            <div className="pt-4 border-t border-white/10 space-y-3">
              <p className="text-sm font-bold">فحص نسخة محفوظة دون استعادة أو تغيير أي بيانات</p>
              <p className="text-xs text-slate-300">أدخل معرّف مجلد النسخة UUID داخل مجلد النسخ المحلي فقط. لا تختَر مسار ملف، ولا تفترض أن سلامة الملف تثبت هوية المصدر أو تجيز الاستعادة.</p>
              <label className="block text-sm">
                معرّف النسخة الاحتياطية
                <input type="text" autoComplete="off" spellCheck={false} dir="ltr"
                  value={backupId} onChange={event => { setBackupId(event.target.value); setVerifiedBackup(null); setRehearsalResult(null); }}
                  disabled={backupRunning || verifyRunning || rehearsalRunning} maxLength={36}
                  className="block w-full mt-2 p-3 rounded-xl bg-slate-800" />
              </label>
              <button type="button" onClick={handleVerifyBackup}
                disabled={running || backupRunning || verifyRunning || rehearsalRunning || reconciliationRunning || !backupPassword || !backupId.trim()}
                className="w-full py-3 border border-sky-400/40 bg-sky-900/40 rounded-2xl font-bold disabled:opacity-50">
                {verifyRunning ? 'جاري فحص سلامة النسخة...' : 'فحص سلامة نسخة محفوظة فقط'}
              </button>
              {verifiedBackup && (
                <div role="status" aria-label="نتيجة فحص النسخة" className="space-y-1 rounded-xl bg-white/10 p-4 text-sm">
                  <p>تم فحص سلامة الملف والبيان (SHA-256 وSQLite) دون استعادة.</p>
                  <p dir="ltr" className="break-all text-xs">ID: {verifiedBackup.backupId}</p>
                  <p className="text-amber-200">{verifiedBackup.warning}</p>
                </div>
              )}
              {verifiedBackup && (
                <div className="border-t border-white/10 pt-4 space-y-3">
                  <p className="text-sm font-bold">فحص نسخة معزولة — بدون استعادة قاعدة البيانات</p>
                  <p className="text-xs text-amber-200">يُنشئ هذا الفحص نسخة تجريبية داخل مجلد معزول ووصلاً دائماً لمعرف المحاولة. لا يغير قاعدة البيانات المباشرة ولا يجيز استعادة فعلية. احتفظ بمعرف الطلب ولا تنشئ معرفاً جديداً لإعادة محاولة قد تكون نجحت رغم انقطاع الرد.</p>
                  <label className="block text-sm">
                    معرّف طلب الفحص المعزول (UUID)
                    <input type="text" autoComplete="off" spellCheck={false} dir="ltr" maxLength={36}
                      className="block w-full mt-2 p-3 rounded-xl bg-slate-800" value={rehearsalRequestId}
                      disabled={rehearsalRunning || backupRunning || verifyRunning}
                      onChange={event => { setRehearsalRequestId(event.target.value); setRehearsalResult(null); }} />
                  </label>
                  <button type="button" className="text-sm underline" disabled={rehearsalRunning}
                    onClick={() => { setRehearsalRequestId(crypto.randomUUID()); setRehearsalResult(null); }}>
                    إنشاء معرف جديد للفحص
                  </button>
                  <button type="button" onClick={handleStageRehearsal}
                    disabled={running || backupRunning || verifyRunning || rehearsalRunning || reconciliationRunning || !backupPassword || !rehearsalRequestId.trim()}
                    className="w-full py-3 border border-amber-400/40 rounded-2xl bg-amber-900/30 font-bold disabled:opacity-50">
                    {rehearsalRunning ? 'جاري فحص النسخة المعزولة...' : 'فحص نسخة معزولة فقط (دون استعادة)'}
                  </button>
                  {rehearsalResult && (
                    <div role="status" aria-label="نتيجة فحص النسخة المعزولة" className="rounded-xl bg-white/10 p-4 text-sm space-y-2">
                      <p>اكتمل إنشاء النسخة التجريبية وفحص سلامتها؛ لم تُستعد بيانات النظام.</p>
                      <p dir="ltr" className="text-xs break-all">Request ID: {rehearsalResult.requestId}</p>
                      <p className="text-amber-200">{rehearsalResult.warning}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="border-t border-white/10 pt-4 space-y-3">
              <p className="text-sm font-bold">مراجعة مرجعيات الحسابات والمخزون التاريخية (للمالك)</p>
              <p className="text-xs text-slate-300">يفحص هذا التقرير القيود والمراجع والعلاقات بين فواتير البيع والشراء والمرتجعات والمخزون عبر الفروع دون تعديل أي سجل. الأوصاف القديمة ليست روابط أصلية ثابتة؛ عدم ظهور تعارض لا يعني اعتماد تاريخ الحسابات.</p>
              <button type="button" onClick={handleReconciliation}
                disabled={running || backupRunning || verifyRunning || rehearsalRunning || reconciliationRunning}
                className="w-full py-3 border border-slate-400/40 rounded-2xl bg-slate-800 font-bold disabled:opacity-50">
                {reconciliationRunning ? 'جاري مراجعة مرجعيات السجل...' : 'فحص مرجعيات السجل المالي فقط'}
              </button>
              {reconciliation && <div role="status" aria-label="نتيجة مراجعة المرجعيات المالية" className="rounded-xl bg-white/10 p-4 text-sm space-y-2">
                <p>قيود راجعها الفحص: {reconciliation.scannedJournals} — تعارضات أو مراجعات: {reconciliation.findings.length} — قيود قديمة غير قابلة لإثبات المصدر: {reconciliation.unverifiableLegacyJournals}</p>
                <p>إثبات تسويات المخزون الجديدة: {reconciliation.stockProvenance.structurallyVerified} سليم بنيوياً من {reconciliation.stockProvenance.recorded} — يحتاج مراجعة: {reconciliation.stockProvenance.reviewRequired} — تسويات دون إثبات 040: {reconciliation.stockProvenance.unattributedAdjustments}</p>
                <p className="text-amber-200">هذه أعداد إثباتات المصدر البنيوية الجديدة فقط؛ لا تثبت تكلفة المبيعات التاريخية أو صحة أسعار المخزون القديمة.</p>
                <p className="text-amber-200">{reconciliation.status === 'limited_no_findings' ? 'لم تظهر تعارضات ضمن النطاق المحدود؛ هذا ليس شهادة مصادقة على التاريخ المالي.' : 'يحتاج السجل مراجعة مالية بشرية؛ لم تتم أي تسوية آلية.'}</p>
                {reconciliation.findings.slice(0, 20).map((finding, index) =>
                  <p dir="ltr" className="break-all text-xs" key={`${finding.sourceType}-${finding.recordId}-${index}`}>
                    {finding.sourceType} / {finding.recordId}: {finding.issueCode} ({finding.classification})
                  </p>)}
                {reconciliation.findings.length > 20 && <p>تعرض الواجهة أول 20 نتيجة فقط؛ يلزم مراجعة بقية السجلات تحت إشراف المالك.</p>}
              </div>}
            </div>
          </div>
        )}
        {maintenanceAllowed && <div className="bg-white/5 border border-white/10 p-6 rounded-2xl space-y-4">
          <p className="text-sm text-slate-300 leading-relaxed">
            يقوم هذا الإجراء بإعادة بناء ملف قاعدة البيانات بالكامل لاستعادة المساحة المهدرة الناتجة عن حذف الفواتير والأصناف السابقة (`VACUUM`)، ويقوم بتحديث إحصائيات الفهارس لتسريع محرك بحث SQLite (`ANALYZE`).
          </p>

          <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex gap-3 text-amber-200">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed font-semibold">
              تنبيه: قد تتوقف عمليات الكتابة والقراءة لثوانٍ معدودة أثناء إجراء الصيانة. يُنصح بإجرائها خارج أوقات الذروة.
            </p>
          </div>
          
          <button 
            type="button"
            onClick={handleMaintenance}
            disabled={running || backupRunning || verifyRunning || rehearsalRunning || reconciliationRunning}
            className="w-full py-4 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white rounded-2xl font-black shadow-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 border border-blue-400/20"
          >
            {running ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>جاري تحسين قاعدة البيانات...</span>
              </>
            ) : (
              <>
                <span>تحسين وضغط قاعدة البيانات الآن</span>
                <Sparkles className="w-4 h-4" />
              </>
            )}
          </button>
        </div>}
      </div>
    </div>
  );
}
