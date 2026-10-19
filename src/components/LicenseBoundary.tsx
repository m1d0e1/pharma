'use client';

import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/env';

type LicenseStatus = {
  valid: boolean;
  reason: string;
  machine_fingerprint: string;
  license_id: string | null;
  expires_at_utc: number | null;
  lease_until_utc: number | null;
  offline_term?: boolean;
  online_activation_available?: boolean;
  startup_ready: boolean;
  startup_upgrade_blocked?: boolean;
};

type PrimaryPharmacyPreview = {
  status: 'SINGLE_PHARMACY_CANDIDATE_ONLY';
  native_migration_version: number;
  directly_scoped_rows: number;
  scopes_needing_reviewed_normalization: number;
  already_primary_rows: number;
  unresolved_owner_scope_markers: number;
  proposed_tenant: 'primary_pharmacy';
  ownership_verified: false;
  upgrade_authorized: false;
};

/** UX only. Native command interception is the real licensing boundary. */
export default function LicenseBoundary({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [license, setLicense] = useState('');
  const [onlineLicenseId, setOnlineLicenseId] = useState('');
  const [onlineActivationCode, setOnlineActivationCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restartRequired, setRestartRequired] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [scopePreview, setScopePreview] = useState<PrimaryPharmacyPreview | null>(null);
  const [scopePreviewFailed, setScopePreviewFailed] = useState(false);
  const installGeneration = useRef(0);
  const installing = useRef(false);

  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    const check = async () => {
      if (installing.current) return;
      const generation = installGeneration.current;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const next = await invoke<LicenseStatus>('license_status');
        if (active && !installing.current && generation === installGeneration.current) setStatus(next);
      } catch (e) {
        if (active && !installing.current && generation === installGeneration.current) setStatus({ valid: false, reason: String(e), machine_fingerprint: '',
          license_id: null, expires_at_utc: null, lease_until_utc: null, startup_ready: false });
      }
    };
    void check();
    // Revalidate while the application runs, including when the tab is idle.
    const interval = window.setInterval(() => { void check(); }, 15_000);
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => {
    if (!isTauri || !status?.valid || !status.startup_upgrade_blocked || status.startup_ready) return;
    let active = true;
    // The native API returns aggregate counts ONLY. Eligibility is not an
    // owner approval and never changes LicenseGuard.startup_ready.
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<PrimaryPharmacyPreview>('primary_pharmacy_upgrade_preview'))
      .then(result => {
        if (!active) return;
        if (result.status !== 'SINGLE_PHARMACY_CANDIDATE_ONLY' ||
            result.proposed_tenant !== 'primary_pharmacy' ||
            result.ownership_verified !== false || result.upgrade_authorized !== false) {
          setScopePreviewFailed(true);
          return;
        }
        setScopePreview(result);
      })
      .catch(() => { if (active) setScopePreviewFailed(true); });
    return () => { active = false; };
  }, [status?.valid, status?.startup_upgrade_blocked, status?.startup_ready]);

  // Static export renders without window; WebView2 detects Tauri before the
  // first client render. Start with the same fail-closed markup on both sides
  // instead of hydrating server-side protected children into an activation UI.
  if (!hydrated) return <main dir="rtl" className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">جارٍ التحقق من الترخيص...</main>;
  if (!isTauri) return <>{children}</>;
  const activate = async () => {
    if (installing.current) return;
    installing.current = true;
    installGeneration.current++;
    setBusy(true);
    setError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<LicenseStatus>('license_install', { signedLicense: license.trim() });
      setStatus(result);
      if (!result.valid) throw new Error(result.reason);
      // A lease may expire while the already-initialized app is running.
      // Native startup readiness, not the prior license validity, determines
      // whether a restart is required to initialize the pharmacy database.
      if (!result.startup_ready) setRestartRequired(true);
      setManageOpen(false);
      setLicense('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      installing.current = false;
      setBusy(false);
    }
  };

  const restart = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) { setError(String(e)); }
  };
  const activateOnline = async () => {
    if (installing.current) return;
    installing.current = true;
    installGeneration.current++;
    setBusy(true);
    setError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<LicenseStatus>('license_activate_online', {
        licenseId: onlineLicenseId.trim(), activationCode: onlineActivationCode.trim(),
      });
      setStatus(result);
      if (!result.valid) throw new Error(result.reason);
      if (!result.startup_ready) setRestartRequired(true);
      setOnlineActivationCode('');
      setManageOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      installing.current = false;
      setBusy(false);
    }
  };
  const renewOnline = async () => {
    if (installing.current) return;
    installing.current = true;
    installGeneration.current++;
    setBusy(true);
    setError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<LicenseStatus>('license_renew_online');
      setStatus(result);
      if (!result.valid) throw new Error(result.reason);
      if (!result.startup_ready) setRestartRequired(true);
      setManageOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      installing.current = false;
      setBusy(false);
    }
  };

  // Automatic native renewal can make a lease valid after an expired startup
  // skipped database initialization. Do not render business screens until
  // native startup has actually completed; the user must relaunch first.
  if (status?.valid && status.startup_ready && !restartRequired) {
    return <>
      {children}
      <div className="fixed bottom-4 left-4 z-[100]" dir="rtl">
        {!manageOpen ? <button type="button" onClick={() => setManageOpen(true)}
          className="rounded-lg border border-slate-400 bg-slate-900 px-3 py-2 text-xs text-white shadow-lg">
          تجديد الترخيص
        </button> : <section className="w-[min(90vw,30rem)] rounded-xl border border-slate-600 bg-slate-950 p-4 text-white shadow-2xl">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-semibold">تجديد الترخيص الموقع</h2>
            <button type="button" onClick={() => { setManageOpen(false); setError(''); }}
              aria-label="إغلاق تجديد الترخيص" className="rounded px-3 py-1 text-sm">إغلاق</button>
          </div>
          {status.offline_term ?
            <p className="mt-2 text-xs text-slate-300">ترخيص دون اتصال بالإنترنت حتى: {new Date((status.expires_at_utc || 0) * 1000).toISOString()}. لا يلزم تجديد يومي.</p> : <>
              <p className="mt-2 text-xs text-slate-300">صلاحية الاتصال حتى: {new Date((status.lease_until_utc || 0) * 1000).toISOString()}</p>
              <button type="button" onClick={() => { void renewOnline(); }} disabled={busy}
                className="mt-2 rounded bg-emerald-700 px-4 py-2 text-sm disabled:opacity-40">تجديد آمن عبر الإنترنت</button>
            </>}
          {status.online_activation_available !== false && <section className="mt-3 border-t border-slate-600 pt-3">
            <p className="text-xs text-slate-300">إذا تم تثبيت ترخيص موقع دون حفظ إثبات التفعيل عبر الإنترنت، أدخل بيانات التفعيل الأصلية على هذا الجهاز قبل إعداد المالك. لا يمنح هذا الإجراء ملكية السجلات التاريخية.</p>
            <label htmlFor="managed-online-license-id" className="mt-2 block text-xs">رقم الترخيص للتفعيل عبر الإنترنت</label>
            <input id="managed-online-license-id" dir="ltr" value={onlineLicenseId}
              onChange={event => setOnlineLicenseId(event.target.value)} autoComplete="off"
              className="mt-1 w-full rounded border border-slate-500 bg-slate-900 p-2 text-xs" />
            <label htmlFor="managed-online-activation-code" className="mt-2 block text-xs">رمز التفعيل الخاص الأصلي</label>
            <input id="managed-online-activation-code" type="password" dir="ltr" value={onlineActivationCode}
              onChange={event => setOnlineActivationCode(event.target.value)} autoComplete="off"
              className="mt-1 w-full rounded border border-slate-500 bg-slate-900 p-2 text-xs" />
            <button type="button" onClick={() => { void activateOnline(); }}
              disabled={busy || !onlineLicenseId.trim() || !onlineActivationCode.trim()}
              className="mt-2 rounded bg-blue-700 px-3 py-2 text-xs disabled:opacity-40">تأكيد التفعيل الأولي عبر الإنترنت</button>
          </section>}
          <label htmlFor="license-renewal" className="mt-2 block text-xs">ترخيص جديد موقع رقمياً (JSON)</label>
          <textarea id="license-renewal" dir="ltr" rows={4} value={license}
            onChange={e => setLicense(e.target.value)}
            className="mt-1 w-full rounded border border-slate-500 bg-slate-900 p-2 font-mono text-xs" />
          <button type="button" onClick={() => { void activate(); }} disabled={busy || !license.trim()}
            className="mt-2 rounded bg-blue-600 px-4 py-2 text-sm disabled:opacity-40">
            {busy ? 'جارٍ التحقق...' : 'تحديث الترخيص'}
          </button>
          {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
        </section>}
      </div>
    </>;
  }

  // Native startup did not touch the unidentified pharmacy database. Never
  // offer repeated restart or reactivation as a workaround for ownership.
  // This is an informational screen only; no business routes or IPC unlock.
  if (status?.valid && status.startup_upgrade_blocked && !status.startup_ready) {
    return <main dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-950 p-6 text-slate-100">
      <section role="alert" aria-label="مراجعة ملكية السجلات القديمة" className="w-full max-w-2xl rounded-2xl border border-amber-500/60 bg-slate-900 p-7 shadow-xl">
        <h1 className="text-xl font-semibold text-amber-200">تم إيقاف الترقية لحماية سجلات الصيدلية</h1>
        <p className="mt-4 text-sm leading-7">تم التحقق من ترخيص التطبيق، لكن سجلات المالك والصيدلية القديمة تحتاج مراجعة ملكية مستقلة. لم يتم نقل هذه السجلات إلى صيدلية أخرى، ولم يتم تشغيل ترحيل قاعدة البيانات.</p>
        <p className="mt-3 text-sm leading-7">يجب على مسؤول مخوّل مراجعة ملكية السجلات والاحتفاظ بنسخة احتياطية موثقة قبل الترقية. لا تحذف ملفات الصيدلية ولا تستخدم إعادة التثبيت لتجاوز المراجعة.</p>
        <p className="mt-3 text-sm leading-7">يمكن لمالك الصيدلية نفسه اعتماد التسوية في اختبار خاص بعد إثبات ملكيته للنسخة الأصلية والتحقق من توقيعه؛ لا يلزم شخص ثانٍ لهذا الاختبار. التأكيد الشفهي وكلمة مرور admin الافتراضية لا يكفيان لإثبات الملكية.</p>
        <p lang="en" dir="ltr" className="mt-4 text-xs leading-6 text-slate-300">Legacy pharmacy ownership review required. Data migration and financial access are blocked. Preserve the original database and obtain independently authorized backup and tenant attribution.</p>
        {scopePreview && <section aria-label="فحص نطاق صيدلية واحدة" className="mt-5 rounded-xl border border-slate-600 p-4 text-sm leading-7">
          <h2 className="font-semibold">نتيجة فحص قاعدة البيانات الآمن</h2>
          <p>نسخة البيانات القديمة متوافقة مبدئياً مع نطاق صيدلية واحدة. الإصدار: {scopePreview.native_migration_version}، السجلات ذات نطاق مباشر: {scopePreview.directly_scoped_rows.toLocaleString('en-US')}، السجلات التي تحتاج تسوية موثقة: {scopePreview.scopes_needing_reviewed_normalization.toLocaleString('en-US')}.</p>
          {scopePreview.unresolved_owner_scope_markers > 0 && <p className="mt-2 text-amber-200">توجد إشارات مراجعة ملكية قديمة ({scopePreview.unresolved_owner_scope_markers}). لا يمكن إلغاؤها بناءً على فحص النطاق وحده.</p>}
          <p dir="ltr" lang="en" className="mt-2 text-xs text-slate-300">Candidate tenant: primary_pharmacy. Structural check only — no ownership approval, migration, password reset or financial access.</p>
        </section>}
        {scopePreviewFailed && <p className="mt-4 text-sm text-amber-200">لم ينجح فحص أهلية صيدلية واحدة. تحتاج هذه النسخة إلى مراجعة إضافية؛ لم تتغير سجلات الصيدلية.</p>}
      </section>
    </main>;
  }

  return (
    <main dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-950 p-6 text-slate-100">
      <section className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-7 shadow-xl">
        <h1 className="text-2xl font-semibold">تفعيل ترخيص فارما</h1>
        <p className="mt-3 text-sm text-slate-300">
          {(status?.valid && (!status.startup_ready || restartRequired)) ? 'تم التحقق من الترخيص. أعد تشغيل التطبيق لبدء قاعدة البيانات.' :
            status === null ? 'جارٍ التحقق من الترخيص...' : status.reason}
        </p>
        {!(restartRequired || (status?.valid && !status.startup_ready)) && <>
          <p className="mt-5 text-sm">بصمة هذا الجهاز (أرسلها إلى جهة إصدار التراخيص):</p>
          <output dir="ltr" className="mt-2 block select-all break-all rounded bg-slate-800 p-3 font-mono text-xs" aria-label="Machine fingerprint">
            {status?.machine_fingerprint || 'Unavailable'}
          </output>
          <p className="mt-2 text-xs text-slate-300">تُنشأ البصمة داخل الجهاز لربط الترخيص به. لا تتضمن بيانات المرضى أو كلمات المرور. إذا ظهرت Unavailable، تواصل مع الدعم ولا تطلب ترخيصًا لبصمة قديمة.</p>
          {status?.online_activation_available !== false && <section className="mt-5 border-t border-slate-700 pt-4">
            <h2 className="font-semibold">التفعيل الآمن عبر الإنترنت</h2>
            <label htmlFor="online-license-id" className="mt-2 block text-sm">رقم الترخيص</label>
            <input id="online-license-id" dir="ltr" value={onlineLicenseId}
              onChange={event => setOnlineLicenseId(event.target.value)} autoComplete="off"
              className="mt-1 w-full rounded border border-slate-500 bg-slate-950 p-2" />
            <label htmlFor="online-activation-code" className="mt-2 block text-sm">رمز التفعيل الخاص</label>
            <input id="online-activation-code" type="password" dir="ltr" value={onlineActivationCode}
              onChange={event => setOnlineActivationCode(event.target.value)} autoComplete="off"
              className="mt-1 w-full rounded border border-slate-500 bg-slate-950 p-2" />
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={busy || !onlineLicenseId.trim() || !onlineActivationCode.trim()}
                onClick={() => { void activateOnline(); }}
                className="rounded bg-blue-600 px-4 py-2 font-semibold disabled:opacity-40">تفعيل عبر اتصال آمن</button>
              <button type="button" disabled={busy} onClick={() => { void renewOnline(); }}
                className="rounded bg-emerald-700 px-4 py-2 disabled:opacity-40">تجديد ترخيص سابق</button>
            </div>
          </section>}
          <label className="mt-5 block text-sm" htmlFor="signed-license">محتوى الترخيص الموقع رقمياً (JSON)</label>
          <p className="mt-2 text-xs text-slate-300">للتفعيل اليدوي دون إنترنت: استلم ملف الترخيص الموقّع الخاص بجهازك من مسؤول التراخيص، ثم اختر الملف هنا أو الصق محتواه أدناه. لا يلزم إرسال بيانات المرضى أو الاتصال بالخادم.</p>
          <label className="mt-3 block text-sm" htmlFor="signed-license-file">استيراد ملف الترخيص الموقّع (JSON)</label>
          <input id="signed-license-file" type="file" accept=".json,application/json"
            disabled={busy}
            onChange={async event => {
              const file = event.target.files?.[0];
              if (!file) return;
              event.target.value = '';
              if (file.size < 2 || file.size > 16_384) {
                setError('ملف الترخيص غير صالح أو يتجاوز الحجم المسموح');
                return;
              }
              try {
                const value = await file.text();
                const envelope: unknown = JSON.parse(value);
                if (!envelope || typeof envelope !== 'object' ||
                    Object.keys(envelope).length !== 2 ||
                    !('payload_b64' in envelope) || !('signature_b64' in envelope) ||
                    typeof envelope.payload_b64 !== 'string' ||
                    typeof envelope.signature_b64 !== 'string') {
                  throw new Error('Invalid signed license envelope');
                }
                setLicense(value);
                setError('');
              } catch {
                setError('تعذر قراءة ملف الترخيص الموقع؛ اطلب ملف JSON صالحاً');
              }
            }}
            className="mt-2 block w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm" />
          <textarea id="signed-license" dir="ltr" value={license}
            onChange={e => setLicense(e.target.value)} rows={6}
            className="mt-2 w-full rounded border border-slate-500 bg-slate-950 p-3 font-mono text-xs"
            placeholder='{"payload_b64":"...","signature_b64":"..."}' />
          <button type="button" disabled={busy || !license.trim()} onClick={() => { void activate(); }}
            className="mt-3 rounded bg-blue-600 px-5 py-3 font-semibold disabled:opacity-40">
            {busy ? 'جارٍ التحقق...' : 'تفعيل الترخيص'}
          </button>
        </>}
        {(restartRequired || (status?.valid && !status.startup_ready)) && <button type="button" onClick={() => { void restart(); }}
          className="mt-5 rounded bg-blue-600 px-5 py-3 font-semibold">إعادة تشغيل التطبيق</button>}
        {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
        <p className="mt-5 text-xs text-slate-400">لا يتم حذف بيانات الصيدلية عند انتهاء الترخيص أو فشل التحقق.</p>
      </section>
    </main>
  );
}
