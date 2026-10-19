'use client';

import React, { useState, useMemo } from 'react';
import {
  Truck, Plus, Search, DollarSign, CreditCard, 
  Trash2, Edit, X, Save, Phone, MapPin, 
  CheckCircle2, Clock, FileText, ArrowDownLeft, 
  Wallet, RefreshCw, AlertTriangle, ChevronRight
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { 
  addSupplierPaymentAction, 
  getSupplierTransactionsAction 
} from '@/app/actions-client/purchases';
import { isBusinessDate, localDate, parseBusinessDate } from '@/lib/time';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';
import { generateId } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';

// This is an untrusted crash-recovery marker, never evidence that a payment
// posted or belongs to the current actor/pharmacy. The native UI does not
// receive the receipted invoice UUID; a read-only, actor-scoped native
// confirmation command is required before a marker from another session can
// be reconciled. In particular, never replay this marker as a fresh payment.
const NATIVE_PAYMENT_RECOVERY_KEY = 'pharma:supplier-payment-recovery:v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type NativePaymentRecoveryHint = {
  version: 1;
  requestId: string;
  supplierId: number;
  invoiceId: null; // The UI has no verified invoice UUID; never guess one.
  amountCents: number;
  paymentMethod: 'cash' | 'bank';
  paymentDate: string;
  notesSha256: string;
};

async function supplierNotesDigest(notes: string): Promise<string> {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('SHA-256 unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(notes.trim()),
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function readNativePaymentRecovery():
  | { status: 'empty' }
  | { status: 'valid'; hint: NativePaymentRecoveryHint }
  | { status: 'blocked' } {
  try {
    const stored = window.localStorage.getItem(NATIVE_PAYMENT_RECOVERY_KEY);
    if (stored === null) return { status: 'empty' };
    if (stored.length > 1024) return { status: 'blocked' };
    const hint: unknown = JSON.parse(stored);
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return { status: 'blocked' };
    const candidate = hint as Record<string, unknown>;
    if (Object.keys(candidate).length !== 8 || candidate.version !== 1 ||
      typeof candidate.requestId !== 'string' || !UUID_V4.test(candidate.requestId) ||
      !Number.isSafeInteger(candidate.supplierId) || Number(candidate.supplierId) <= 0 ||
      candidate.invoiceId !== null ||
      !Number.isSafeInteger(candidate.amountCents) || Number(candidate.amountCents) <= 0 ||
      !['cash', 'bank'].includes(String(candidate.paymentMethod)) ||
      typeof candidate.paymentDate !== 'string' || !isBusinessDate(candidate.paymentDate) ||
      typeof candidate.notesSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.notesSha256)) {
      return { status: 'blocked' };
    }
    return { status: 'valid', hint: candidate as NativePaymentRecoveryHint };
  } catch {
    // Corrupt or inaccessible persistence must not permit another nonce.
    return { status: 'blocked' };
  }
}

function sameNativePaymentRecovery(a: NativePaymentRecoveryHint, b: NativePaymentRecoveryHint) {
  return a.requestId === b.requestId && a.supplierId === b.supplierId &&
    a.invoiceId === b.invoiceId && a.amountCents === b.amountCents &&
    a.paymentMethod === b.paymentMethod && a.paymentDate === b.paymentDate &&
    a.notesSha256 === b.notesSha256;
}

function sameAuthorizedNativePayer(
  session: Awaited<ReturnType<typeof getLocalSession>>,
  actorId: string,
  pharmacyId: string,
) {
  return Boolean(
    session && actorId && pharmacyId && pharmacyId !== 'local_default' &&
    String(session.id) === actorId && session.pharmacy_id === pharmacyId &&
    hasUserPermissionSync(session, 'can_view_suppliers') &&
    hasUserPermissionSync(session, 'acc_can_process_cash_flow'),
  );
}

type NativeSupplierPaymentConfirmation = {
  id: string;
  supplierId: number;
  invoiceId: string;
  actorId: string;
  pharmacyId: string;
  amountCents: number;
  remainingBalance: number;
  feeCents?: number;
};

export interface SupplierItem {
  id: number;
  name_ar: string;
  name_en?: string;
  phone?: string;
  address?: string;
  balance: number | null;
  purchase_count?: number;
  transaction_count?: number;
  created_at?: string;
}

interface Props {
  initialData: SupplierItem[];
  onAdd: (data: { name_ar: string; name_en?: string; phone?: string; address?: string; request_id?: string }) => Promise<{ success: boolean; id?: any; error?: string }>;
  onUpdate: (id: number, data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => Promise<{ success: boolean; error?: string }>;
  onDelete: (id: number) => Promise<{ success: boolean; error?: string }>;
  onRefresh: () => Promise<void>;
  canMutate?: boolean;
  canCreate?: boolean;
  canPay?: boolean;
}

export default function SuppliersManagementClient({
  initialData,
  onAdd,
  onUpdate,
  onDelete,
  onRefresh,
  canMutate = false,
  canCreate = false,
  canPay = false,
}: Props) {
  // Creation has a native writer; editing/deleting shared historical rows does not.
  const canManageDirectory = canMutate && !isTauri;
  const canAddSupplier = canManageDirectory || (isTauri && canCreate);
  const [suppliers, setSuppliers] = useState<SupplierItem[]>(initialData);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'debit' | 'clear'>('all');
  
  // Modals
  const [isAddEditOpen, setIsAddEditOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<SupplierItem | null>(null);
  const [formData, setFormData] = useState({ name_ar: '', name_en: '', phone: '', address: '' });
  const [isSavingSupplier, setIsSavingSupplier] = useState(false);
  const supplierSaveRef = React.useRef(false);
  const supplierCreateAttemptRef = React.useRef<{
    requestId: string;
    normalized: string;
    form: typeof formData;
  } | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{ normalized: string } | null>(null);
  const deletingSupplierIdsRef = React.useRef(new Set<number>());

  // Payment Modal
  const [paymentSupplier, setPaymentSupplier] = useState<SupplierItem | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank' | 'check'>('cash');
  const [checkNumber, setCheckNumber] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [paymentDate, setPaymentDate] = useState(localDate());
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const paymentSubmissionRef = React.useRef(false);
  const paymentRequestRef = React.useRef<string>('');
  const paymentRequestSupplierRef = React.useRef<number | null>(null);
  const nativePaymentAttemptRef = React.useRef<{
    supplierId: number;
    amount: string;
    method: 'cash' | 'bank' | 'check';
    checkNumber: string;
    notes: string;
    notesSha256: string;
    date: string;
    requestId: string;
  } | null>(null);
  const [nativePaymentUnconfirmed, setNativePaymentUnconfirmed] = useState(false);
  const [nativePaymentReloadStatus, setNativePaymentReloadStatus] =
    useState<'checking' | 'ready' | 'blocked'>(isTauri ? 'checking' : 'ready');

  // Statement / History Modal
  const [statementSupplier, setStatementSupplier] = useState<SupplierItem | null>(null);
  const [statementTransactions, setStatementTransactions] = useState<any[]>([]);
  const [isLoadingStatement, setIsLoadingStatement] = useState(false);
  const [statementLoadError, setStatementLoadError] = useState('');
  const statementRequestRef = React.useRef(0);
  const addEditDialogRef = useDialogFocusTrap<HTMLDivElement>(canAddSupplier && isAddEditOpen);
  const paymentDialogRef = useDialogFocusTrap<HTMLDivElement>(canPay && Boolean(paymentSupplier));
  const statementDialogRef = useDialogFocusTrap<HTMLDivElement>(Boolean(statementSupplier));

  React.useEffect(() => {
    setSuppliers(initialData);
  }, [initialData]);

  React.useEffect(() => {
    if (!isTauri) return;
    let active = true;
    const resolve = async () => {
      const saved = readNativePaymentRecovery();
      if (saved.status === 'empty') {
        if (active) setNativePaymentReloadStatus('ready');
        return;
      }
      // A malformed hint, missing actor or unavailable native read never
      // authorizes a new financial nonce.
      if (saved.status !== 'valid') {
        if (active) setNativePaymentReloadStatus('blocked');
        return;
      }
      try {
        const session = await getLocalSession();
        const actorId = session?.id == null ? '' : String(session.id);
        const pharmacyId = typeof session?.pharmacy_id === 'string' ? session.pharmacy_id : '';
        if (!sameAuthorizedNativePayer(session, actorId, pharmacyId)) {
          throw new Error('No authorized owned supplier payment session');
        }
        const { invoke } = await import('@tauri-apps/api/core');
        // Read-only confirmation is allowed after reload. The unavailable or
        // unmatched case never falls through into post_supplier_payment_native.
        const receipt = await invoke<NativeSupplierPaymentConfirmation | null>(
          'confirm_supplier_payment_native', {
            payload: {
              supplierId: saved.hint.supplierId,
              amount: saved.hint.amountCents / 100,
              paymentMethod: saved.hint.paymentMethod,
              date: saved.hint.paymentDate,
              requestId: saved.hint.requestId,
              notesSha256: saved.hint.notesSha256,
            },
          },
        );
        // Another mounted directory may now own reconciliation. Only the
        // current instance may clear a marker it actually confirmed.
        if (!active) return;
        if (!receipt || !UUID.test(receipt.id) || !UUID.test(receipt.invoiceId) ||
          receipt.supplierId !== saved.hint.supplierId ||
          receipt.amountCents !== saved.hint.amountCents ||
          receipt.actorId !== actorId || receipt.pharmacyId !== pharmacyId ||
          !Number.isFinite(receipt.remainingBalance) ||
          (receipt.feeCents !== undefined && receipt.feeCents !== 0)) {
          throw new Error('Native supplier receipt could not prove the original intent');
        }
        // A receipt confirmed for the old native actor is not permission for
        // a subsequently signed-in user (or another tenant) to consume its
        // recovery hint. Check the live session again after the awaited IPC,
        // immediately before removing the original nonce.
        const currentSession = await getLocalSession();
        if (!sameAuthorizedNativePayer(currentSession, actorId, pharmacyId)) {
          throw new Error('Supplier recovery actor, tenant or payment permission changed during confirmation');
        }
        const current = readNativePaymentRecovery();
        if (current.status !== 'valid' || !sameNativePaymentRecovery(current.hint, saved.hint)) {
          throw new Error('Supplier recovery marker changed');
        }
        window.localStorage.removeItem(NATIVE_PAYMENT_RECOVERY_KEY);
        if (active) {
          setNativePaymentReloadStatus('ready');
          toast.success('تم تأكيد إيصال سداد المورد السابق من المصدر الأصلي');
          try {
            await onRefresh();
          } catch {
            toast.error('تم تأكيد الإيصال، لكن تعذر تحديث قائمة الموردين');
          }
        }
      } catch {
        if (active) setNativePaymentReloadStatus('blocked');
      }
    };
    void resolve();
    return () => { active = false; };
  }, [onRefresh]);

  const ensureNativePaymentRecovery = () => {
    if (!isTauri) return true;
    if (nativePaymentReloadStatus !== 'ready') {
      toast.error('يوجد طلب سداد سابق يتطلب تأكيد الإيصال الأصلي قبل سداد جديد');
      return false;
    }
    const saved = readNativePaymentRecovery();
    const prior = nativePaymentAttemptRef.current;
    const priorCents = prior && Number(prior.amount) * 100;
    const cents = priorCents && Math.round(priorCents);
    if (saved.status === 'empty' && !prior) return true;
    if (saved.status === 'valid' && prior && Number.isSafeInteger(cents) &&
      Math.abs(priorCents! - cents!) <= 0.0000001 &&
      sameNativePaymentRecovery(saved.hint, {
        version: 1, requestId: prior.requestId, supplierId: prior.supplierId,
        invoiceId: null, amountCents: cents!, paymentMethod: prior.method as 'cash' | 'bank',
        paymentDate: prior.date, notesSha256: prior.notesSha256,
      })) return true;
    setNativePaymentReloadStatus('blocked');
    toast.error('تغيرت بيانات استرداد السداد؛ يجب تأكيد الإيصال الأصلي قبل المتابعة');
    return false;
  };

  // Statistics
  const totalSuppliers = suppliers.length;
  const unknownBalances = suppliers.filter(s => s.balance == null).length;
  const totalDebit = useMemo(() => {
    return suppliers.reduce((sum, s) => sum + Math.max(0, Number(s.balance || 0)), 0);
  }, [suppliers]);
  const suppliersWithDebit = useMemo(() => {
    return suppliers.filter(s => Number(s.balance || 0) > 0).length;
  }, [suppliers]);

  // Filtered Suppliers
  const filteredSuppliers = useMemo(() => {
    return suppliers.filter(s => {
      const matchesSearch = 
        s.name_ar.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (s.name_en && s.name_en.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (s.phone && s.phone.includes(searchTerm)) ||
        (s.address && s.address.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      const balance = Number(s.balance || 0);
      if (filterType === 'debit') return s.balance != null && balance > 0;
      if (filterType === 'clear') return s.balance != null && balance <= 0;
      return true;
    });
  }, [suppliers, searchTerm, filterType]);

  // Add / Edit Handlers
  const handleOpenAdd = () => {
    if (!canAddSupplier) return;
    setEditingSupplier(null);
    // Closing an ambiguous native create must not allocate a new request ID
    // for the same form on reopen. Preserve the original submitted details.
    setFormData(supplierCreateAttemptRef.current?.form || { name_ar: '', name_en: '', phone: '', address: '' });
    setIsAddEditOpen(true);
  };

  const handleOpenEdit = (s: SupplierItem) => {
    if (!canManageDirectory) return;
    setEditingSupplier(s);
    setFormData({ 
      name_ar: s.name_ar, 
      name_en: s.name_en || '', 
      phone: s.phone || '', 
      address: s.address || '' 
    });
    setIsAddEditOpen(true);
  };

  const handleSaveSupplier = async () => {
    if (!canAddSupplier || (editingSupplier && !canManageDirectory)) return;
    if (!formData.name_ar.trim()) {
      toast.error('يرجى إدخال اسم المورد بالعربي');
      return;
    }
    if (supplierSaveRef.current) return;
    supplierSaveRef.current = true;
    setIsSavingSupplier(true);
    try {
      if (editingSupplier) {
        const res = await onUpdate(editingSupplier.id, formData);
        if (res.success) {
          toast.success('تم تحديث بيانات المورد بنجاح');
          setIsAddEditOpen(false);
          await onRefresh();
        } else {
          toast.error(res.error || 'فشل التحديث');
        }
      } else {
        const normalized = JSON.stringify(Object.values(formData).map(value => value.trim() || null));
        let requestId: string | undefined;
        if (isTauri) {
          const prior = supplierCreateAttemptRef.current;
          if (prior && prior.normalized !== normalized) {
            toast.error('تغيرت بيانات طلب لم تتأكد نتيجته؛ استعد البيانات الأصلية لإعادة المحاولة أو ابدأ طلباً جديداً بعد التحقق');
            return;
          }
          if (!prior) {
            supplierCreateAttemptRef.current = { requestId: generateId(), normalized, form: { ...formData } };
            setPendingCreate({ normalized });
          }
          requestId = supplierCreateAttemptRef.current!.requestId;
        }
        const res = await onAdd({ ...formData, ...(requestId ? { request_id: requestId } : {}) });
        if (res.success) {
          supplierCreateAttemptRef.current = null;
          setPendingCreate(null);
          toast.success('تمت إضافة المورد بنجاح');
          setIsAddEditOpen(false);
          await onRefresh();
        } else {
          toast.error(res.error || 'فشل إضافة المورد');
        }
      }
    } catch {
      toast.error('حدث خطأ أثناء الحفظ');
    } finally {
      supplierSaveRef.current = false;
      setIsSavingSupplier(false);
    }
  };

  const handleDeleteSupplier = async (id: number) => {
    if (!canManageDirectory) return;
    if (deletingSupplierIdsRef.current.has(id)) return;
    if (!confirm('هل أنت متأكد من رغبتك في حذف هذا المورد؟')) return;
    deletingSupplierIdsRef.current.add(id);
    try {
      const res = await onDelete(id);
      if (res.success) {
        toast.success('تم حذف المورد بنجاح');
        await onRefresh();
      } else {
        toast.error(res.error || 'فشل حذف المورد');
      }
    } catch {
      toast.error('حدث خطأ أثناء الحذف');
    } finally {
      deletingSupplierIdsRef.current.delete(id);
    }
  };

  // Payment Handlers
  const handleOpenPayment = (s: SupplierItem) => {
    // Native settlement authenticates the exact receipted supplier source;
    // a shared legacy directory balance is not evidence of what can be paid.
    if (!canPay || (s.balance == null && !isTauri)) return;
    if (!ensureNativePaymentRecovery()) return;
    const pending = nativePaymentAttemptRef.current;
    if (isTauri && pending && pending.supplierId !== s.id) {
      toast.error('يجب مراجعة إيصال سداد المورد السابق قبل بدء طلب مالي آخر');
      return;
    }
    if (paymentRequestSupplierRef.current !== s.id || !paymentRequestRef.current) {
      paymentRequestRef.current = generateId();
      paymentRequestSupplierRef.current = s.id;
    }
    setPaymentSupplier(s);
    if (isTauri && pending) {
      // An ambiguous native acknowledgement is not permission to change the
      // payload behind the old nonce or generate a second financial intent.
      setPaymentAmount(pending.amount);
      setPaymentMethod(pending.method);
      setCheckNumber(pending.checkNumber);
      setPaymentNotes(pending.notes);
      setPaymentDate(pending.date);
      setNativePaymentUnconfirmed(true);
      return;
    }
    const balance = Math.max(0, Number(s.balance || 0));
    setPaymentAmount(balance > 0 ? String(balance) : '');
    setPaymentMethod('cash');
    setCheckNumber('');
    setPaymentNotes('');
    setPaymentDate(localDate());
  };

  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentSupplier) return;

    const amount = Number(paymentAmount);
    if (!amount || amount <= 0) {
      toast.error('يرجى إدخال مبلغ دفع صحيح أكبر من الصفر');
      return;
    }
    if (paymentMethod === 'check' && !checkNumber.trim()) {
      toast.error('يرجى إدخال رقم الشيك');
      return;
    }
    if (paymentSubmissionRef.current) return;
    if (!ensureNativePaymentRecovery()) return;

    paymentSubmissionRef.current = true;
    setIsProcessingPayment(true);
    try {
      let submittedActorId = '';
      let submittedPharmacyId = '';
      if (isTauri) {
        // Anchor this financial intent to the actor and explicit tenant at
        // submit time. The native writer must re-authorize independently.
        const submittedSession = await getLocalSession();
        submittedActorId = submittedSession?.id == null ? '' : String(submittedSession.id);
        submittedPharmacyId = typeof submittedSession?.pharmacy_id === 'string'
          ? submittedSession.pharmacy_id : '';
        if (!sameAuthorizedNativePayer(submittedSession, submittedActorId, submittedPharmacyId)) {
          toast.error('يلزم تسجيل دخول أصلي لصيدلية موثقة قبل سداد المورد');
          return;
        }
        const prior = nativePaymentAttemptRef.current;
        if (prior && (prior.supplierId !== paymentSupplier.id ||
          prior.amount !== paymentAmount || prior.method !== paymentMethod ||
          prior.checkNumber !== checkNumber || prior.notes !== paymentNotes ||
          prior.date !== paymentDate || prior.requestId !== paymentRequestRef.current)) {
          toast.error('نتيجة سداد سابق غير مؤكدة؛ لا يجوز تغيير بياناته قبل مطابقة الإيصال الأصلي');
          return;
        }
        if (!prior) {
          const amountCents = Math.round(amount * 100);
          if (!UUID_V4.test(paymentRequestRef.current) ||
            !Number.isSafeInteger(amountCents) || amount > 1_000_000_000_000 ||
            Math.abs(amount * 100 - amountCents) > 0.0000001 ||
            !Number.isSafeInteger(paymentSupplier.id) || paymentSupplier.id <= 0 ||
            !isBusinessDate(paymentDate) || !['cash', 'bank'].includes(paymentMethod)) {
            toast.error('بيانات سداد المورد لا تسمح بمحاولة أصلية آمنة');
            return;
          }
          let notesSha256: string;
          try {
            notesSha256 = await supplierNotesDigest(paymentNotes);
          } catch {
            setNativePaymentReloadStatus('blocked');
            toast.error('تعذر تأمين بيانات استرداد السداد؛ لم يُرسل أي طلب مالي');
            return;
          }
          const hint: NativePaymentRecoveryHint = {
            version: 1, requestId: paymentRequestRef.current,
            supplierId: paymentSupplier.id, invoiceId: null, amountCents,
            paymentMethod: paymentMethod as 'cash' | 'bank',
            paymentDate, notesSha256,
          };
          try {
            window.localStorage.setItem(NATIVE_PAYMENT_RECOVERY_KEY, JSON.stringify(hint));
            const saved = readNativePaymentRecovery();
            if (saved.status !== 'valid' || !sameNativePaymentRecovery(saved.hint, hint)) {
              throw new Error('Supplier payment recovery marker write was not durable');
            }
          } catch {
            setNativePaymentReloadStatus('blocked');
            toast.error('تعذر حفظ بيانات استرداد السداد؛ لم يُرسل أي طلب مالي');
            return;
          }
          nativePaymentAttemptRef.current = {
            supplierId: paymentSupplier.id, amount: paymentAmount,
            method: paymentMethod, checkNumber, notes: paymentNotes, notesSha256,
            date: paymentDate, requestId: paymentRequestRef.current,
          };
          setNativePaymentUnconfirmed(true);
        }
        // SHA-256 and durable storage above are asynchronous. A different
        // user or pharmacy may have logged in during either await. Never
        // dispatch the old financial intent through their native session.
        const beforeInvoke = await getLocalSession();
        if (!sameAuthorizedNativePayer(beforeInvoke, submittedActorId, submittedPharmacyId)) {
          setNativePaymentReloadStatus('blocked');
          toast.error('تغير المستخدم أو الصيدلية قبل السداد؛ يجب مراجعة الطلب الأصلي');
          return;
        }
      }
      const res = await addSupplierPaymentAction({
        supplier_id: paymentSupplier.id,
        amount,
        payment_method: paymentMethod,
        check_number: checkNumber,
        notes: paymentNotes,
        date: paymentDate,
        request_id: paymentRequestRef.current,
      });

      if (res.success) {
        if (isTauri) {
          // A positive native ACK is not permission to discard the original
          // receipt nonce after an asynchronous user/tenant switch. Leave
          // the durable marker and block further payment until an actor-owned
          // read-only confirmation is possible.
          const currentSession = await getLocalSession();
          if (!sameAuthorizedNativePayer(currentSession, submittedActorId, submittedPharmacyId)) {
            setNativePaymentReloadStatus('blocked');
            toast.error('تغير المستخدم أو الصيدلية أثناء السداد؛ يجب مراجعة الإيصال الأصلي');
            return;
          }
        }
        toast.success(`تم سداد ${amount.toLocaleString()} ج.م للمورد ${paymentSupplier.name_ar} بنجاح`);
        if (isTauri) {
          const saved = readNativePaymentRecovery();
          const prior = nativePaymentAttemptRef.current;
          if (saved.status === 'valid' && prior && saved.hint.requestId === prior.requestId) {
            try {
              window.localStorage.removeItem(NATIVE_PAYMENT_RECOVERY_KEY);
              if (readNativePaymentRecovery().status !== 'empty') throw new Error('Marker still present');
            } catch {
              setNativePaymentReloadStatus('blocked');
            }
          } else {
            setNativePaymentReloadStatus('blocked');
          }
        }
        nativePaymentAttemptRef.current = null;
        setNativePaymentUnconfirmed(false);
        paymentRequestRef.current = '';
        paymentRequestSupplierRef.current = null;
        setPaymentSupplier(null);
        try {
          await onRefresh();
        } catch {
          toast.error('تم تسجيل الدفعة، لكن تعذر تحديث قائمة الموردين');
        }
      } else {
        toast.error(res.error || 'فشل تسجيل الدفعة');
      }
    } catch {
      toast.error('حدث خطأ أثناء تنفيذ عملية السداد');
    } finally {
      paymentSubmissionRef.current = false;
      setIsProcessingPayment(false);
    }
  };

  // Statement / History Handlers
  const handleOpenStatement = async (s: SupplierItem) => {
    const requestId = ++statementRequestRef.current;
    setStatementSupplier(s);
    setStatementTransactions([]);
    setStatementLoadError('');
    setIsLoadingStatement(true);
    try {
      const res = await getSupplierTransactionsAction(s.id);
      if (requestId !== statementRequestRef.current) return;
      if (res.success) {
        setStatementTransactions(res.data || []);
      } else {
        setStatementLoadError('تعذر تحميل كشف حساب المورد');
        toast.error(res.error || 'فشل جلب كشف الحساب');
      }
    } catch {
      if (requestId === statementRequestRef.current) {
        setStatementLoadError('تعذر تحميل كشف حساب المورد');
        toast.error('حدث خطأ أثناء جلب كشف الحساب');
      }
    } finally {
      if (requestId === statementRequestRef.current) {
        setIsLoadingStatement(false);
      }
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      {isTauri && canPay && nativePaymentReloadStatus !== 'ready' && (
        <p role="alert" className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm font-bold text-amber-900">
          {nativePaymentReloadStatus === 'checking'
            ? 'جارٍ التحقق من إيصال سداد المورد السابق من المصدر الأصلي؛ السداد الجديد متوقف حتى انتهاء التحقق.'
            : 'تعذر تأكيد طلب سداد مورد سابق. راجع الإيصال والقيود الأصلية مع المسؤول قبل بدء سداد جديد؛ لن يعاد إرسال الطلب آلياً.'}
        </p>
      )}
      {/* Header & KPI Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">إجمالي الموردين</p>
            <h3 className="text-2xl font-bold text-slate-900 dark:text-white mt-1 tabular-nums">{totalSuppliers}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">موردين مسجلين بالنظام</p>
          </div>
          <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-lg flex items-center justify-center">
            <Truck className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">إجمالي مديونية الموردين</p>
            <h3 className="text-2xl font-bold text-rose-700 dark:text-rose-400 mt-1 tabular-nums">
              {totalDebit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm font-bold">ج.م</span>
            </h3>
            <p className="text-xs text-rose-500 dark:text-rose-400 mt-1">{suppliersWithDebit} موردين لهم مستحقات{unknownBalances > 0 ? ` (لا يشمل ${unknownBalances} رصيد غير متحقق)` : ''}</p>
          </div>
          <div className="w-10 h-10 bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 rounded-lg flex items-center justify-center">
            <DollarSign className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">حسابات خالصة</p>
            <h3 className="text-2xl font-bold text-emerald-700 dark:text-emerald-400 mt-1 tabular-nums">
              {totalSuppliers - suppliersWithDebit - unknownBalances}
            </h3>
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">موردين بدون مديونيات معلقة</p>
          </div>
          <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-lg flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Control Bar: Search, Filters, Add Button */}
      <div className="flex flex-col md:flex-row gap-3 items-center justify-between bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="w-5 h-5 absolute right-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            aria-label="بحث في الموردين"
            placeholder="البحث بالاسم، الهاتف، أو العنوان..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-colors"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto shrink-0">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
            <button
              type="button"
              onClick={() => setFilterType('all')}
              aria-pressed={filterType === 'all'}
              className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
                filterType === 'all' 
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' 
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              الكل ({suppliers.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType('debit')}
              aria-pressed={filterType === 'debit'}
              className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
                filterType === 'debit' 
                  ? 'bg-rose-500 text-white shadow-sm' 
                  : 'text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30'
              }`}
            >
              مديونيات ({suppliersWithDebit})
            </button>
            <button
              type="button"
              onClick={() => setFilterType('clear')}
              aria-pressed={filterType === 'clear'}
              className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
                filterType === 'clear' 
                  ? 'bg-emerald-500 text-white shadow-sm' 
                  : 'text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
              }`}
            >
              خالصة ({suppliers.length - suppliersWithDebit - unknownBalances})
            </button>
          </div>

          {canAddSupplier && (
            <button
              type="button"
              onClick={handleOpenAdd}
              className="px-4 py-2.5 bg-primary-700 hover:bg-primary-800 text-white font-semibold text-xs rounded-lg shadow-sm flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>إضافة مورد جديد</span>
            </button>
          )}
        </div>
      </div>

      {/* Suppliers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredSuppliers.map((supplier) => {
          const unknownBalance = supplier.balance == null;
          const balance = Number(supplier.balance || 0);
          const hasDebit = balance > 0;
          const isCredit = balance < 0;

          return (
            <div
              key={supplier.id}
              className={`bg-white dark:bg-slate-900 rounded-xl p-5 border shadow-sm flex flex-col justify-between relative overflow-hidden group ${
                unknownBalance
                  ? 'border-slate-100 dark:border-slate-800 border-t-8 border-t-slate-400'
                  : hasDebit
                  ? 'border-slate-100 dark:border-slate-800 border-t-8 border-t-rose-500' 
                  : 'border-slate-100 dark:border-slate-800 border-t-8 border-t-emerald-500'
              }`}
            >
              <div>
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg ${
                      hasDebit 
                        ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/30' 
                        : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30'
                    }`}>
                      <Truck className="w-6 h-6" />
                    </div>
                    <div>
                      <h4 className="font-black text-lg text-slate-900 dark:text-white leading-tight">
                        {supplier.name_ar}
                      </h4>
                      {supplier.name_en && (
                        <p className="text-xs text-slate-500 font-medium tracking-wide text-left" dir="ltr">
                          {supplier.name_en}
                        </p>
                      )}
                    </div>
                  </div>

                  {canManageDirectory && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`تعديل المورد ${supplier.name_ar}`}
                        onClick={() => handleOpenEdit(supplier)}
                        className="inline-flex h-11 w-11 items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-lg transition-colors"
                        title="تعديل"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`حذف المورد ${supplier.name_ar}`}
                        onClick={() => handleDeleteSupplier(supplier.id)}
                        className="inline-flex h-11 w-11 items-center justify-center text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg transition-colors"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Contact details */}
                <div className="space-y-1.5 mb-6 text-xs text-slate-500 dark:text-slate-400">
                  {supplier.phone && (
                    <div className="flex items-center gap-2 font-bold">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      <span dir="ltr">{supplier.phone}</span>
                    </div>
                  )}
                  {supplier.address && (
                    <div className="flex items-center gap-2 font-bold">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      <span className="truncate">{supplier.address}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Debit & Action Bar */}
              <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-wider">
                    {unknownBalance ? 'رصيد غير متحقق' : hasDebit ? 'المديونية المستحقة للمورد' : isCredit ? 'رصيد لصالحنا' : 'الحساب'}
                  </span>
                  <div className={`px-4 py-1.5 rounded-xl font-black text-sm ${
                    hasDebit 
                      ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400' 
                      : isCredit 
                        ? 'bg-cyan-50 dark:bg-cyan-950/30 text-cyan-600 dark:text-cyan-400'
                        : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400'
                  }`}>
                    {unknownBalance ? 'يتطلب تحقق ملكية الرصيد' : `${Math.abs(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {canPay && (!unknownBalance || isTauri) && (
                    <button
                      onClick={() => handleOpenPayment(supplier)}
                      disabled={isTauri && nativePaymentReloadStatus !== 'ready'}
                      className="w-full py-2.5 px-3 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-semibold text-xs shadow-sm flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <CreditCard className="w-4 h-4" />
                      <span>سداد دفعة</span>
                    </button>
                  )}

                  <button
                    onClick={() => handleOpenStatement(supplier)}
                    className="w-full py-2.5 px-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <FileText className="w-4 h-4" />
                    <span>كشف الحساب</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {filteredSuppliers.length === 0 && (
          <div className="col-span-full py-16 text-center text-slate-400">
            <Truck className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-black text-lg">لم يتم العثور على موردين مطابقة للبحث</p>
          </div>
        )}
      </div>

      {/* Add / Edit Supplier Modal */}
      {canAddSupplier && isAddEditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/55 animate-in fade-in">
          <div ref={addEditDialogRef} role="dialog" aria-modal="true" aria-labelledby="supplier-edit-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !isSavingSupplier) setIsAddEditOpen(false); }} className="bg-white dark:bg-slate-900 rounded-xl max-w-lg w-full max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-5 sm:p-6 border border-slate-200 dark:border-slate-800 shadow-xl space-y-5">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
              <h3 id="supplier-edit-title" className="text-xl font-black text-slate-900 dark:text-white">
                {editingSupplier ? 'تعديل بيانات المورد' : 'إضافة مورد جديد'}
              </h3>
              <button
                type="button"
                aria-label="إغلاق بيانات المورد"
                onClick={() => { if (!supplierSaveRef.current) setIsAddEditOpen(false); }}
                disabled={isSavingSupplier}
                className="inline-flex h-11 w-11 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="supplier-name-ar" className="block text-xs font-black text-slate-500 mb-1">اسم المورد (بالعربي) *</label>
                <input
                  id="supplier-name-ar"
                  type="text"
                  value={formData.name_ar}
                  onChange={(e) => setFormData({ ...formData, name_ar: e.target.value })}
                  placeholder="مثال: شركة ابن سينا فارما"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <div>
                <label htmlFor="supplier-name-en" className="block text-xs font-black text-slate-500 mb-1">اسم المورد (بالإنجليزي)</label>
                <input
                  id="supplier-name-en"
                  type="text"
                  dir="ltr"
                  value={formData.name_en}
                  onChange={(e) => setFormData({ ...formData, name_en: e.target.value })}
                  placeholder="e.g. Ibnsina Pharma"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 text-right"
                />
              </div>

              <div>
                <label htmlFor="supplier-phone" className="block text-xs font-black text-slate-500 mb-1">رقم الهاتف</label>
                <input
                  id="supplier-phone"
                  type="text"
                  dir="ltr"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="01000000000"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500 text-right"
                />
              </div>

              <div>
                <label htmlFor="supplier-address" className="block text-xs font-black text-slate-500 mb-1">العنوان</label>
                <input
                  id="supplier-address"
                  type="text"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  placeholder="عنوان أو فرع المورد..."
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {isTauri && !editingSupplier && pendingCreate && (
              <div role="status" className="text-xs text-amber-800 dark:text-amber-300">
                إذا تعذر تأكيد الحفظ، أعد المحاولة بالبيانات نفسها؛ سيُستخدم معرف الطلب السابق لمنع التكرار.
                {pendingCreate.normalized !== JSON.stringify(Object.values(formData).map(value => value.trim() || null)) && (
                  <button
                    type="button"
                    className="mt-2 block underline font-bold"
                    onClick={() => {
                      if (window.confirm('تحقق من عدم إنشاء المورد السابق قبل بدء طلب جديد. هل تريد استخدام معرف جديد للبيانات المعدلة؟')) {
                        supplierCreateAttemptRef.current = null;
                        setPendingCreate(null);
                        setFormData({ ...formData });
                      }
                    }}
                  >
                    بدء طلب جديد بعد التحقق
                  </button>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => { if (!supplierSaveRef.current) setIsAddEditOpen(false); }}
                disabled={isSavingSupplier}
                className="px-6 py-3 rounded-2xl text-sm font-black text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveSupplier}
                disabled={isSavingSupplier}
                className="px-8 py-3 bg-primary-600 hover:bg-primary-700 text-white rounded-2xl text-sm font-black shadow-lg shadow-primary-500/20 transition-all active:scale-95 disabled:opacity-50"
              >
                {isSavingSupplier ? 'جاري الحفظ...' : 'حفظ البيانات'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Supplier Payment Modal */}
      {canPay && paymentSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/55 animate-in fade-in">
          <div ref={paymentDialogRef} role="dialog" aria-modal="true" aria-labelledby="supplier-payment-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !isProcessingPayment) setPaymentSupplier(null); }} className="bg-white dark:bg-slate-900 rounded-xl max-w-lg w-full max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-5 sm:p-6 border border-slate-200 dark:border-slate-800 shadow-xl space-y-5">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 id="supplier-payment-title" className="text-xl font-black text-slate-900 dark:text-white">سداد دفعة للمورد</h3>
                <p className="text-xs font-bold text-slate-400 mt-0.5">{paymentSupplier.name_ar}</p>
              </div>
              <button
                type="button"
                aria-label="إغلاق سداد المورد"
                onClick={() => { if (!paymentSubmissionRef.current) setPaymentSupplier(null); }}
                disabled={isProcessingPayment}
                className="inline-flex h-11 w-11 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Current Balance Display */}
            <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/30 flex items-center justify-between">
              <div>
                <p className="text-xs font-black text-rose-500">المديونية الحالية المستحقة للمورد</p>
                <p className="text-2xl font-black text-rose-600 dark:text-rose-400 mt-1">
                  {paymentSupplier.balance == null
                    ? 'الرصيد غير متحقق لدى المصدر الأصلي'
                    : `${Number(paymentSupplier.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })} ج.م`}
                </p>
              </div>
              <Wallet className="w-8 h-8 text-rose-500 opacity-70" />
            </div>

            <form onSubmit={handleSubmitPayment} className="space-y-4">
              {isTauri && nativePaymentUnconfirmed && (
                <p role="alert" className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm font-bold text-amber-900">
                  نتيجة طلب السداد لم تتأكد بعد. يمكن إعادة نفس الطلب فقط بنفس بياناته ومعرفه. بعد إعادة التحميل سيُفحص الإيصال الأصلي للقراءة فقط، وسيبقى أي سداد جديد متوقفاً إذا تعذر التحقق منه.
                </p>
              )}
              <div>
                <label htmlFor="supplier-payment-amount" className="block text-xs font-black text-slate-500 mb-1">مبلغ السداد (ج.م) *</label>
                <input
                  id="supplier-payment-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-lg font-black text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 text-left"
                />

                {/* Quick percentage helper buttons */}
                {Number(paymentSupplier.balance || 0) > 0 && (
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                      onClick={() => setPaymentAmount(String(Number(paymentSupplier.balance)))}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold transition-all"
                    >
                      كامل المبلغ ({Number(paymentSupplier.balance).toLocaleString()})
                    </button>
                    <button
                      type="button"
                      disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                      onClick={() => setPaymentAmount(String(Math.round(Number(paymentSupplier.balance) * 0.5 * 100) / 100))}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold transition-all"
                    >
                      50%
                    </button>
                    <button
                      type="button"
                      disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                      onClick={() => setPaymentAmount(String(Math.round(Number(paymentSupplier.balance) * 0.25 * 100) / 100))}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold transition-all"
                    >
                      25%
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="supplier-payment-method" className="block text-xs font-black text-slate-500 mb-1">طريقة الدفع</label>
                  <select
                    id="supplier-payment-method"
                    disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as any)}
                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="cash">نقدي (الخزينة)</option>
                    <option value="bank">تحويل بنكي / فيزا</option>
                    {!isTauri && <option value="check">شيك</option>}
                  </select>
                </div>

                <div>
                  <label htmlFor="supplier-payment-date" className="block text-xs font-black text-slate-500 mb-1">تاريخ السداد</label>
                  <input
                    id="supplier-payment-date"
                    type="date"
                    disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {paymentMethod === 'check' && (
                <div>
                  <label htmlFor="supplier-check-number" className="block text-xs font-black text-slate-500 mb-1">رقم الشيك *</label>
                  <input
                    id="supplier-check-number"
                    type="text"
                    required
                    disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                    value={checkNumber}
                    onChange={(e) => setCheckNumber(e.target.value)}
                    placeholder="رقم الشيك البنكي..."
                    className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              )}

              <div>
                <label htmlFor="supplier-payment-notes" className="block text-xs font-black text-slate-500 mb-1">ملاحظات / البيان</label>
                <input
                  id="supplier-payment-notes"
                  type="text"
                  disabled={isProcessingPayment || (isTauri && nativePaymentUnconfirmed)}
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  placeholder="ملاحظات حول الدفعة أو رقم الإيصال..."
                  className="w-full p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Remaining balance preview */}
              {paymentSupplier.balance != null && Number(paymentAmount) > 0 && (
                <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-black flex justify-between items-center">
                  <span className="text-slate-400">الرصيد المتبقي بعد السداد:</span>
                  <span className="text-slate-900 dark:text-white font-bold">
                    {(Number(paymentSupplier.balance || 0) - Number(paymentAmount)).toLocaleString(undefined, { minimumFractionDigits: 2 })} ج.م
                  </span>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => { if (!paymentSubmissionRef.current) setPaymentSupplier(null); }}
                  disabled={isProcessingPayment}
                  className="px-6 py-3 rounded-2xl text-sm font-black text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={isProcessingPayment}
                  className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-sm font-black shadow-lg shadow-emerald-500/20 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isProcessingPayment ? 'جاري السداد...' : 'تأكيد السداد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Supplier Statement Modal */}
      {statementSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/55 animate-in fade-in">
          <div ref={statementDialogRef} role="dialog" aria-modal="true" aria-labelledby="supplier-statement-title" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') setStatementSupplier(null); }} className="bg-white dark:bg-slate-900 rounded-xl max-w-3xl w-full p-5 sm:p-6 border border-slate-200 dark:border-slate-800 shadow-xl space-y-5 max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
              <div>
                <h3 id="supplier-statement-title" className="text-xl font-black text-slate-900 dark:text-white">كشف حساب المورد</h3>
                <p className="text-xs font-bold text-slate-400 mt-0.5">{statementSupplier.name_ar} ({statementSupplier.balance == null ? 'الرصيد غير متحقق' : `الرصيد: ${Number(statementSupplier.balance).toLocaleString()} ج.م`})</p>
              </div>
              <button
                type="button"
                aria-label="إغلاق كشف حساب المورد"
                onClick={() => setStatementSupplier(null)}
                className="inline-flex h-11 w-11 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 custom-scrollbar">
              {isLoadingStatement ? (
                <div className="py-16 text-center text-slate-400 font-bold">جاري تحميل كشف الحساب...</div>
              ) : statementLoadError ? (
                <div className="py-16 text-center space-y-4">
                  <p className="font-black text-rose-600 dark:text-rose-400">{statementLoadError}</p>
                  <button
                    type="button"
                    onClick={() => void handleOpenStatement(statementSupplier)}
                    className="px-5 py-2.5 rounded-xl bg-rose-600 text-white font-black text-xs"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              ) : statementTransactions.length === 0 ? (
                <div className="py-16 text-center text-slate-400 font-bold">لا توجد حركات مسجلة لهذا المورد حتى الآن</div>
              ) : (
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0 text-slate-400 font-black uppercase">
                    <tr>
                      <th className="p-3 rounded-r-xl">التاريخ</th>
                      <th className="p-3">نوع الحركة</th>
                      <th className="p-3">المبلغ</th>
                      <th className="p-3">البيان / الملاحظات</th>
                      <th className="p-3 rounded-l-xl">المرجع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {statementTransactions.map((tx) => (
                      <tr key={tx.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="p-3 text-slate-500 font-bold">{
                          tx.date && isBusinessDate(tx.date)
                            ? parseBusinessDate(tx.date).toLocaleDateString('ar-EG')
                            : tx.created_at ? new Date(tx.created_at).toLocaleDateString('ar-EG') : '-'
                        }</td>
                        <td className="p-3">
                          <span className={`px-2.5 py-1 rounded-lg text-[11px] font-black ${
                            tx.type === 'payment' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30' :
                            tx.type === 'invoice' ? 'bg-rose-50 text-rose-600 dark:bg-rose-950/30' :
                            tx.type === 'return' ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/30' :
                            'bg-slate-50 text-slate-600 dark:bg-slate-800'
                          }`}>
                            {tx.type === 'payment' ? 'سداد دفعة' : tx.type === 'invoice' ? 'فاتورة شراء' : tx.type === 'return' ? 'مرتجع شراء' : tx.type}
                          </span>
                        </td>
                        <td className={`p-3 font-black ${tx.type === 'payment' || tx.type === 'return' ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {Number(tx.amount || 0).toLocaleString()} ج.م
                        </td>
                        <td className="p-3 font-bold text-slate-600 dark:text-slate-300">{tx.notes || '-'}</td>
                        <td className="p-3 font-mono text-slate-400">{tx.reference_id ? tx.reference_id.slice(0, 10) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end shrink-0">
              <button
                onClick={() => setStatementSupplier(null)}
                className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-black"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
