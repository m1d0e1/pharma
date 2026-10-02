'use client'
import { useHotkeys } from 'react-hotkeys-hook';

import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { 
  User, Phone, MapPin, Calendar, CreditCard, HeartPulse, Save, X, Activity, 
  History, Award, ShieldCheck, Trash2, PlusCircle, AlertCircle, FileText
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { 
  getPatientProfileAction, updatePatientAction, 
  addPatientAllergyAction, addPatientConditionAction,
  deletePatientAllergyAction, getReceiptDetailsAction
} from '@/app/actions-client/patients'
import { addPatientPaymentAction } from '@/app/actions-client/finance'
import { format } from 'date-fns'
import { ar } from 'date-fns/locale'
import CustomerStatementModal from './CustomerStatementModal'
import ReceiptDetailsModal from '../receipts/ReceiptDetailsModal'
import { CustomerStatementContent, FinancialNoticeForm } from '../finance/FinancialComponents'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local'
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap'

interface Props {
  patientId: string
  onClose: () => void
  onSuccess: () => void
}

export default function PatientProfileModal({ patientId, onClose, onSuccess }: Props) {
  const [canProcessPatientPayments, setCanProcessPatientPayments] = useState(false)
  const [canManageFinancialNotices, setCanManageFinancialNotices] = useState(false)
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
  useHotkeys('f1', (e) => {
    if (!canProcessPatientPayments) return;
    e.preventDefault();
    setActiveTab('payments');
    setShowPaymentForm(true);
  }, { enableOnFormTags: true }, [canProcessPatientPayments]);

  const [activeTab, setActiveTab] = useState<'profile' | 'finance' | 'medical' | 'history' | 'statement' | 'payments' | 'notices'>('profile')
  const [loading, setLoading] = useState(true)
  const [refreshError, setRefreshError] = useState(false)
  const [data, setData] = useState<any>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const profileSubmissionRef = useRef(false)
  const profileRequestRef = useRef(0)
  const activePatientIdRef = useRef(patientId)
  const [showStatement, setShowStatement] = useState(false)
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null)
  const [loadingReceipt, setLoadingReceipt] = useState(false)
  const receiptRequestRef = useRef(0)
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(!loading)

  const handleOpenReceipt = async (invoiceId: string) => {
    const requestId = ++receiptRequestRef.current
    setLoadingReceipt(true)
    try {
      const res = await getReceiptDetailsAction(invoiceId)
      if (requestId !== receiptRequestRef.current) return
      if (res.success && res.data) {
        setSelectedReceipt(res.data)
      } else {
        toast.error(res.error || 'فشل تحميل تفاصيل الفاتورة')
      }
    } catch {
      if (requestId !== receiptRequestRef.current) return
      toast.error('حدث خطأ أثناء تحميل الفاتورة')
    } finally {
      if (requestId === receiptRequestRef.current) setLoadingReceipt(false)
    }
  }

  // Payment Form States
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank'>('cash')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [paymentDate, setPaymentDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false)
  const paymentSubmissionRef = useRef(false)
  const [isToppingUpWallet, setIsToppingUpWallet] = useState(false)
  const walletTopUpRef = useRef(false)

  // Allergy Form States
  const [showAllergyForm, setShowAllergyForm] = useState(false)
  const [allergenName, setAllergenName] = useState('')
  const [allergySeverity, setAllgySeverity] = useState('mild')
  const [allergyNotes, setAllergyNotes] = useState('')
  const [isSubmittingAllergy, setIsSubmittingAllergy] = useState(false)
  const allergySubmissionRef = useRef(false)
  const [deletingAllergyIds, setDeletingAllergyIds] = useState<Set<number>>(() => new Set())
  const deletingAllergyIdsRef = useRef<Set<number>>(new Set())

  // Condition Form States
  const [showConditionForm, setShowConditionForm] = useState(false)
  const [conditionName, setConditionName] = useState('')
  const [conditionMedications, setConditionMedications] = useState('')
  const [conditionNotes, setConditionNotes] = useState('')
  const [isSubmittingCondition, setIsSubmittingCondition] = useState(false)
  const conditionSubmissionRef = useRef(false)

  // Form State
  const [formData, setFormData] = useState({
    full_name: '',
    name_en: '',
    phone: '',
    mobile: '',
    address: '',
    area: '',
    birth_date: '',
    gender: 'male',
    insurance_number: '',
    car_number: '',
    credit_limit: 0,
    opening_balance: 0,
    points_balance: 0,
    point_value: 1,
    customer_type: 'individual',
    payment_method: 'cash',
    notes: ''
  })

  useLayoutEffect(() => {
    activePatientIdRef.current = patientId
  }, [patientId])

  useEffect(() => {
    void fetchProfile()
    return () => {
      profileRequestRef.current += 1
    }
    // patientId is the only changing input that should trigger a profile reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId])

  useEffect(() => {
    let active = true
    getClientSession().then(user => {
      if (active) {
        setCanProcessPatientPayments(hasUserPermissionSync(user, 'acc_can_process_cash_flow'))
        setCanManageFinancialNotices(hasUserPermissionSync(user, 'acc_can_view_notifications'))
      }
    })
    return () => { active = false }
  }, [])

  const fetchProfile = async (preserveOnFailure = false) => {
    const requestedPatientId = patientId
    const requestId = ++profileRequestRef.current
    if (!preserveOnFailure) setLoading(true)
    setRefreshError(false)
    try {
      const res = await getPatientProfileAction(requestedPatientId)
      if (requestId !== profileRequestRef.current || requestedPatientId !== activePatientIdRef.current) return
      if (res.success) {
        setData(res.data)
        setFormData({
          full_name: res.data.full_name || '',
          name_en: res.data.name_en || '',
          phone: res.data.phone || '',
          mobile: res.data.mobile || '',
          address: res.data.address || '',
          area: res.data.area || '',
          birth_date: res.data.birth_date || '',
          gender: res.data.gender || 'male',
          insurance_number: res.data.insurance_number || '',
          car_number: res.data.car_number || '',
          credit_limit: res.data.credit_limit || 0,
          opening_balance: res.data.opening_balance || 0,
          points_balance: res.data.points_balance || 0,
          point_value: res.data.point_value || 1,
          customer_type: res.data.customer_type || 'individual',
          payment_method: res.data.payment_method || 'cash',
          notes: res.data.notes || ''
        })
      } else {
        if (preserveOnFailure) {
          setRefreshError(true)
        } else {
          toast.error(res.error || 'فشل جلب ملف المريض')
          onClose()
        }
      }
    } catch {
      if (requestId !== profileRequestRef.current || requestedPatientId !== activePatientIdRef.current) return
      if (preserveOnFailure) {
        setRefreshError(true)
      } else {
        toast.error('فشل جلب ملف المريض')
        onClose()
      }
    } finally {
      if (requestId === profileRequestRef.current && requestedPatientId === activePatientIdRef.current && !preserveOnFailure) setLoading(false)
    }
  }

  const handleUpdate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (profileSubmissionRef.current) return
    profileSubmissionRef.current = true
    setIsSubmitting(true)
    try {
      const res = await updatePatientAction(patientId, formData as any)
      if (res.success) {
        toast.success('تم تحديث البيانات بنجاح')
        onSuccess()
      } else {
        toast.error(res.error || 'فشل التحديث')
      }
    } catch {
      toast.error('حدث خطأ أثناء تحديث البيانات')
    } finally {
      profileSubmissionRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (paymentSubmissionRef.current) return
    const amt = parseFloat(paymentAmount)
    if (isNaN(amt) || amt <= 0) {
      toast.error('يرجى إدخال مبلغ صحيح')
      return
    }

    paymentSubmissionRef.current = true
    setIsSubmittingPayment(true)
    try {
      const res = await addPatientPaymentAction({
        patient_id: patientId,
        amount: amt,
        payment_method: paymentMethod,
        notes: paymentNotes,
        date: paymentDate
      })

      if (res.success) {
        toast.success('تم تسجيل الدفعة بنجاح')
        setShowPaymentForm(false)
        setPaymentAmount('')
        setPaymentNotes('')
        setPaymentDate(format(new Date(), 'yyyy-MM-dd'))
        void fetchProfile(true)
      } else {
        toast.error(res.error || 'فشل إضافة الدفعة')
      }
    } catch {
      toast.error('حدث خطأ أثناء إضافة الدفعة')
    } finally {
      paymentSubmissionRef.current = false
      setIsSubmittingPayment(false)
    }
  }

  const handleWalletTopUp = async () => {
    if (walletTopUpRef.current) return
    const amt = (document.getElementById('topup-amount') as HTMLInputElement | null)?.value || ''
    if (!amt || parseFloat(amt) <= 0) {
      toast.error('يرجى إدخال مبلغ صحيح')
      return
    }

    walletTopUpRef.current = true
    setIsToppingUpWallet(true)
    try {
      const { updatePatientWalletAction } = await import('@/app/actions-client/patients')
      const res = await updatePatientWalletAction(patientId, parseFloat(amt), 'شحن يدوي من الملف الشخصي')
      if (res.success) {
        toast.success('تم شحن المحفظة بنجاح')
        void fetchProfile(true)
      } else {
        toast.error(res.error || 'فشل شحن المحفظة')
      }
    } catch {
      toast.error('حدث خطأ أثناء شحن المحفظة')
    } finally {
      walletTopUpRef.current = false
      setIsToppingUpWallet(false)
    }
  }

  const handleAddAllergy = async (e: React.FormEvent) => {
    e.preventDefault()
    if (allergySubmissionRef.current) return
    if (!allergenName.trim()) return
    allergySubmissionRef.current = true
    setIsSubmittingAllergy(true)
    try {
      const res = await addPatientAllergyAction({
        patient_id: patientId,
        allergen: allergenName,
        severity: allergySeverity,
        notes: allergyNotes
      })
      if (res.success) {
        toast.success('تمت إضافة الحساسية')
        setShowAllergyForm(false)
        setAllergenName('')
        setAllergyNotes('')
        void fetchProfile(true)
      } else {
        toast.error(res.error || 'فشل إضافة الحساسية')
      }
    } catch {
      toast.error('حدث خطأ أثناء إضافة الحساسية')
    } finally {
      allergySubmissionRef.current = false
      setIsSubmittingAllergy(false)
    }
  }

  const handleAddCondition = async (e: React.FormEvent) => {
    e.preventDefault()
    if (conditionSubmissionRef.current) return
    if (!conditionName.trim()) return
    conditionSubmissionRef.current = true
    setIsSubmittingCondition(true)
    try {
      const res = await addPatientConditionAction({
        patient_id: patientId,
        condition_name: conditionName,
        medications: conditionMedications,
        notes: conditionNotes
      })
      if (res.success) {
        toast.success('تمت إضافة الحالة المرضية')
        setShowConditionForm(false)
        setConditionName('')
        setConditionMedications('')
        setConditionNotes('')
        void fetchProfile(true)
      } else {
        toast.error(res.error || 'فشل إضافة الحالة المرضية')
      }
    } catch {
      toast.error('حدث خطأ أثناء إضافة الحالة المرضية')
    } finally {
      conditionSubmissionRef.current = false
      setIsSubmittingCondition(false)
    }
  }

  const handleDeleteAllergy = async (id: number) => {
    if (deletingAllergyIdsRef.current.has(id)) return

    deletingAllergyIdsRef.current.add(id)
    setDeletingAllergyIds(new Set(deletingAllergyIdsRef.current))
    try {
      const res = await deletePatientAllergyAction(id)
      if (res.success) {
        toast.success('تم حذف الحساسية')
        await fetchProfile(true)
      } else {
        toast.error(res.error || 'فشل حذف الحساسية')
      }
    } catch {
      toast.error('فشل حذف الحساسية')
    } finally {
      deletingAllergyIdsRef.current.delete(id)
      setDeletingAllergyIds(new Set(deletingAllergyIdsRef.current))
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[300]">
        <div role="status" aria-live="polite" className="bg-white dark:bg-slate-900 p-8 rounded-3xl flex flex-col items-center shadow-2xl">
           <Activity className="w-12 h-12 text-purple-600 animate-spin mb-4" />
           <p className="font-black text-slate-500">جاري تحميل ملف العميل...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center p-2 sm:p-4 z-[300]" dir="rtl">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="patient-profile-title"
        tabIndex={-1}
        className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-5xl max-h-[calc(100vh-1rem)] sm:max-h-[95vh] overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-200 flex flex-col focus:outline-none"
      >
        
        {/* Header */}
        <div className="bg-slate-900 p-4 sm:p-6 flex justify-between items-center text-white relative shrink-0 gap-4">
          <div className="relative z-10 flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-purple-600 rounded-2xl flex items-center justify-center text-2xl sm:text-3xl border border-white/10 shrink-0">
               👤
            </div>
            <div className="min-w-0">
              <h2 id="patient-profile-title" className="text-2xl sm:text-3xl font-black text-white truncate">
                {formData.full_name}
              </h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-slate-300 font-bold text-sm">
                 <span className="flex items-center gap-1"><Phone className="w-4 h-4" /> {formData.phone || 'بدون هاتف'}</span>
                 <span className="flex items-center gap-1"><Award className="w-4 h-4" /> {formData.points_balance} نقطة</span>
                 <span className="bg-white/10 px-3 py-1 rounded-full">{formData.customer_type}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-2 sm:gap-4 shrink-0">
             <button 
               onClick={() => setShowStatement(true)}
               className="px-4 sm:px-6 py-3 bg-blue-600 text-white rounded-xl font-black hover:bg-blue-500 transition-colors flex items-center gap-2"
             >
                <FileText className="w-5 h-5" /> كشف الحساب
             </button>
             <button type="button" aria-label="إغلاق ملف العميل" onClick={onClose} className="p-3 bg-white/10 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-xl transition-colors relative z-10">
               <X className="w-6 h-6" />
             </button>
          </div>
        </div>

        {refreshError && (
          <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-6 py-3 text-amber-800">
            <span className="font-black text-sm">تم الحفظ لكن تعذر تحديث ملف العميل</span>
            <button
              type="button"
              onClick={() => void fetchProfile(true)}
              className="rounded-xl bg-white px-3 py-2 text-xs font-black shadow-sm ring-1 ring-amber-200"
            >
              إعادة تحميل ملف العميل
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex bg-slate-50 dark:bg-slate-800/50 p-2 border-b border-slate-100 dark:border-slate-800 shrink-0 overflow-x-auto no-scrollbar">
           {[
             { id: 'profile', label: 'البيانات الأساسية', icon: User },
             { id: 'finance', label: 'المالية والتأمين', icon: CreditCard },
             { id: 'statement', label: 'كشف الحساب', icon: FileText },
             { id: 'payments', label: 'توريدات نقدية', icon: History },
             ...(canManageFinancialNotices ? [{ id: 'notices', label: 'إشعارات', icon: AlertCircle }] : []),
             { id: 'medical', label: 'الملف الطبي', icon: HeartPulse },
             { id: 'history', label: 'سجل المشتريات', icon: Activity }
           ].map(tab => (
             <button
               type="button"
               key={tab.id}
               onClick={() => setActiveTab(tab.id as any)}
               aria-pressed={activeTab === tab.id}
               className={`flex-1 min-w-[120px] flex items-center justify-center gap-3 py-4 rounded-2xl font-black text-sm transition-all ${activeTab === tab.id ? 'bg-white dark:bg-slate-900 text-purple-600 shadow-lg' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
             >
               <tab.icon className="w-5 h-5" />
               {tab.label}
             </button>
           ))}
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">
          {activeTab === 'profile' && (
            <form onSubmit={handleUpdate} className="space-y-10">
               <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-2">
                    <label htmlFor="patient-profile-full-name" className="text-xs font-black text-slate-500 mr-2">الاسم بالكامل (عربي)</label>
                    <input
                      id="patient-profile-full-name"
                      type="text"
                      value={formData.full_name}
                      onChange={(e) => setFormData({...formData, full_name: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="patient-profile-name-en" className="text-xs font-black text-slate-500 mr-2">Name (English)</label>
                    <input
                      id="patient-profile-name-en"
                      type="text"
                      value={formData.name_en}
                      onChange={(e) => setFormData({...formData, name_en: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all text-left shadow-sm focus:border-purple-500"
                      dir="ltr"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="patient-profile-phone" className="text-xs font-black text-slate-500 mr-2">رقم الهاتف (اختياري)</label>
                    <input
                      id="patient-profile-phone"
                      type="text"
                      value={formData.phone}
                      onChange={(e) => setFormData({...formData, phone: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
               </div>
               
               <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-2">
                    <label htmlFor="patient-profile-mobile" className="text-xs font-black text-slate-500 mr-2">رقم الموبايل</label>
                    <input
                      id="patient-profile-mobile"
                      type="text"
                      value={formData.mobile}
                      onChange={(e) => setFormData({...formData, mobile: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="patient-profile-area" className="text-xs font-black text-slate-500 mr-2">المنطقة</label>
                    <input
                      id="patient-profile-area"
                      type="text"
                      value={formData.area}
                      onChange={(e) => setFormData({...formData, area: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="patient-profile-birth-date" className="text-xs font-black text-slate-500 mr-2">تاريخ الميلاد</label>
                    <input
                      id="patient-profile-birth-date"
                      type="date"
                      value={formData.birth_date}
                      onChange={(e) => setFormData({...formData, birth_date: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
               </div>

               <div className="space-y-2">
                  <label htmlFor="patient-profile-address" className="text-xs font-black text-slate-500 mr-2">العنوان بالتفصيل</label>
                  <input
                    id="patient-profile-address"
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData({...formData, address: e.target.value})}
                    className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                  />
               </div>

               <div className="bg-amber-50 dark:bg-amber-900/10 p-6 rounded-3xl border border-amber-100 dark:border-amber-900/20">
                  <label htmlFor="patient-profile-notes" className="text-xs font-black text-amber-700 mb-2 block">ملاحظات إدارية</label>
                  <textarea
                    id="patient-profile-notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({...formData, notes: e.target.value})}
                    rows={3}
                    className="w-full bg-transparent outline-none font-bold text-slate-700 dark:text-slate-300 resize-none"
                    placeholder="سجل أي ملاحظات إضافية هنا..."
                  />
               </div>

               <button 
                 type="submit" 
                 disabled={isSubmitting}
                 className="bg-purple-600 text-white px-12 py-5 rounded-3xl font-black hover:bg-purple-700 transition-all flex items-center gap-3 shadow-xl shadow-purple-500/20"
               >
                 <Save className="w-6 h-6" /> {isSubmitting ? 'جاري الحفظ...' : 'حفظ جميع التعديلات'}
               </button>
            </form>
          )}

          {activeTab === 'finance' && (
            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4">
               <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <FinanceStatCard icon={Award} label="نقاط الولاء" value={formData.points_balance} unit="نقطة" color="from-emerald-500 to-teal-600" />
                  <FinanceStatCard icon={CreditCard} label="رصيد المحفظة" value={data?.wallet_balance || 0} unit="ج.م" color="from-purple-500 to-indigo-600" />
                  <FinanceStatCard icon={ShieldCheck} label="حد الائتمان" value={formData.credit_limit} unit="ج.م" color="from-blue-500 to-indigo-600" />
                  <FinanceStatCard
                    icon={History}
                    label={Number(data?.outstandingBalance || 0) < 0 ? 'رصيد دائن' : 'المديونية الحالية'}
                    value={Math.abs(Number(data?.outstandingBalance || 0))}
                    unit="ج.م"
                    color="from-slate-700 to-slate-900"
                  />
               </div>

               {canProcessPatientPayments && (
                 <div className="bg-white dark:bg-slate-900 p-5 sm:p-8 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-6">
                    <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                       <PlusCircle className="w-8 h-8 text-purple-500" /> شحن محفظة العميل
                    </h3>
                    <div className="flex gap-6 items-end">
                       <div className="flex-1 space-y-2">
                          <label htmlFor="topup-amount" className="text-xs font-black text-slate-500">المبلغ المراد شحنه</label>
                          <input
                             id="topup-amount"
                             type="number"
                             placeholder="0.00"
                             className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-purple-500 p-4 rounded-2xl outline-none font-black text-2xl"
                          />
                       </div>
                       <button
                          onClick={() => void handleWalletTopUp()}
                          disabled={isToppingUpWallet}
                          className="px-12 py-5 bg-purple-600 text-white rounded-2xl font-black hover:bg-purple-700 transition-all shadow-xl shadow-purple-500/20 disabled:opacity-50"
                       >
                          {isToppingUpWallet ? 'جاري الشحن...' : 'تأكيد الشحن'}
                       </button>
                    </div>
                 </div>
               )}

               <form onSubmit={handleUpdate} className="bg-white dark:bg-slate-900 p-5 sm:p-8 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-8">
                  <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                     <ShieldCheck className="w-8 h-8 text-blue-500" /> إعدادات التعاقد والتحصيل
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
                     <div className="space-y-2">
                        <label htmlFor="patient-profile-payment-method" className="text-xs font-black text-slate-500 mr-2">طريقة الدفع الافتراضية</label>
                        <select
                          id="patient-profile-payment-method"
                          value={formData.payment_method}
                          onChange={(e) => setFormData({...formData, payment_method: e.target.value})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all appearance-none"
                        >
                           <option value="cash">نقدي (Cash)</option>
                           <option value="credit">آجل (Credit)</option>
                           <option value="visa">فيزا (Visa)</option>
                           <option value="wallet">محفظة (Wallet)</option>
                        </select>
                     </div>
                     <div className="space-y-2">
                        <label htmlFor="patient-profile-credit-limit" className="text-xs font-black text-slate-500 mr-2">الحد الأقصى للرصيد (الحد الائتماني)</label>
                        <input
                          id="patient-profile-credit-limit"
                          type="number"
                          min="0"
                          step="0.01"
                          value={formData.credit_limit}
                          onChange={(e) => setFormData({...formData, credit_limit: parseFloat(e.target.value) || 0})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all"
                        />
                     </div>
                     <div className="space-y-2">
                        <label htmlFor="patient-profile-insurance" className="text-xs font-black text-slate-500 mr-2">رقم التأمين الصحي</label>
                        <input
                          id="patient-profile-insurance"
                          type="text"
                          value={formData.insurance_number}
                          onChange={(e) => setFormData({...formData, insurance_number: e.target.value})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all"
                        />
                     </div>
                     <div className="space-y-2">
                        <label htmlFor="patient-profile-car-number" className="text-xs font-black text-slate-500 mr-2">رقم السيارة</label>
                        <input
                          id="patient-profile-car-number"
                          type="text"
                          value={formData.car_number}
                          onChange={(e) => setFormData({...formData, car_number: e.target.value})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all"
                        />
                     </div>
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-blue-600 text-white px-8 py-4 rounded-2xl font-black hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-500/20 disabled:opacity-50"
                  >
                    <Save className="w-5 h-5" />
                    {isSubmitting ? 'جاري الحفظ...' : 'حفظ حد الائتمان والإعدادات'}
                  </button>
               </form>
            </div>
          )}

          {activeTab === 'medical' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-12 animate-in fade-in slide-in-from-bottom-4">
               {/* Allergies */}
               <div className="space-y-6">
                  <h3 className="font-black text-rose-600 dark:text-rose-400 flex items-center gap-3 italic">
                     <AlertCircle className="w-8 h-8" /> الحساسية الدوائية (Allergies)
                  </h3>
                  <div className="space-y-3">
                     {data.allergies.map((a: any) => (
                       <div key={a.id} className="bg-rose-50 dark:bg-rose-900/20 p-5 rounded-3xl border border-rose-100 dark:border-rose-900/30 flex justify-between items-center group">
                          <div>
                            <p className="font-black text-rose-900 dark:text-rose-200 text-lg">{a.allergen}</p>
                            <p className="text-xs font-bold text-rose-600">{a.severity}</p>
                          </div>
                          <button
                            disabled={deletingAllergyIds.has(a.id)}
                            aria-label={deletingAllergyIds.has(a.id) ? `جاري حذف حساسية ${a.allergen}` : `حذف حساسية ${a.allergen}`}
                            onClick={() => handleDeleteAllergy(a.id)}
                            className="p-3 hover:bg-rose-100 dark:hover:bg-rose-800 rounded-2xl transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                          >
                             <Trash2 className="w-5 h-5 text-rose-600" />
                          </button>
                       </div>
                     ))}
                     {showAllergyForm ? (
                        <form onSubmit={handleAddAllergy} className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-rose-200 space-y-4 animate-in slide-in-from-top-2 duration-200">
                          <div className="flex justify-between items-center">
                            <h4 className="font-black text-rose-600">إضافة حساسية جديدة</h4>
                            <button type="button" aria-label="إغلاق نموذج الحساسية" onClick={() => setShowAllergyForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                          </div>
                          <div className="space-y-2">
                            <label htmlFor="patient-allergen-name" className="text-xs font-black text-slate-500">مسبب الحساسية</label>
                            <input 
                              id="patient-allergen-name"
                              type="text" 
                              value={allergenName} 
                              onChange={(e) => setAllergenName(e.target.value)} 
                              className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold" 
                              placeholder="مثال: البنسلين" 
                              required 
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label htmlFor="patient-allergy-severity" className="text-xs font-black text-slate-500">شدة الحساسية</label>
                              <select 
                                id="patient-allergy-severity"
                                value={allergySeverity} 
                                onChange={(e) => setAllgySeverity(e.target.value)} 
                                className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold"
                              >
                                <option value="mild">خفيفة (Mild)</option>
                                <option value="moderate">متوسطة (Moderate)</option>
                                <option value="severe">شديدة (Severe)</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label htmlFor="patient-allergy-notes" className="text-xs font-black text-slate-500">ملاحظات</label>
                              <input 
                                id="patient-allergy-notes"
                                type="text" 
                                value={allergyNotes} 
                                onChange={(e) => setAllergyNotes(e.target.value)} 
                                className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold" 
                                placeholder="اختياري" 
                              />
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setShowAllergyForm(false)} className="px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm font-bold">إلغاء</button>
                            <button type="submit" disabled={isSubmittingAllergy} className="px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-black shadow-md shadow-rose-600/10">حفظ</button>
                          </div>
                        </form>
                      ) : (
                        <button 
                          onClick={() => setShowAllergyForm(true)}
                          className="w-full py-5 border-2 border-dashed border-rose-200 dark:border-rose-900/30 rounded-3xl text-rose-400 font-black hover:bg-rose-50 transition-all flex items-center justify-center gap-2"
                        >
                           <PlusCircle className="w-6 h-6" /> إضافة حساسية جديدة
                        </button>
                      )}
                  </div>
               </div>

               {/* Conditions */}
               <div className="space-y-6">
                  <h3 className="font-black text-blue-600 dark:text-blue-400 flex items-center gap-3">
                     <HeartPulse className="w-8 h-8" /> الأمراض المزمنة (Conditions)
                  </h3>
                  <div className="space-y-3">
                     {data.conditions.map((c: any) => (
                       <div key={c.id} className="bg-blue-50 dark:bg-blue-900/20 p-5 rounded-3xl border border-blue-100 dark:border-blue-900/30">
                          <p className="font-black text-blue-900 dark:text-blue-200 text-lg">{c.condition_name}</p>
                          {c.medications && <p className="text-xs font-bold text-blue-600 mt-1">الأدوية المستخدمة: {c.medications}</p>}
                       </div>
                     ))}
                     {showConditionForm ? (
                        <form onSubmit={handleAddCondition} className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-blue-200 space-y-4 animate-in slide-in-from-top-2 duration-200">
                          <div className="flex justify-between items-center">
                            <h4 className="font-black text-blue-600">إضافة حالة صحية جديدة</h4>
                            <button type="button" aria-label="إغلاق نموذج الحالة الصحية" onClick={() => setShowConditionForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                          </div>
                          <div className="space-y-2">
                            <label htmlFor="patient-condition-name" className="text-xs font-black text-slate-500">اسم الحالة المرضية</label>
                            <input 
                              id="patient-condition-name"
                              type="text" 
                              value={conditionName} 
                              onChange={(e) => setConditionName(e.target.value)} 
                              className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold" 
                              placeholder="مثال: ضغط الدم المرتفع" 
                              required 
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label htmlFor="patient-condition-medications" className="text-xs font-black text-slate-500">الأدوية المنتظمة</label>
                              <input 
                                id="patient-condition-medications"
                                type="text" 
                                value={conditionMedications} 
                                onChange={(e) => setConditionMedications(e.target.value)} 
                                className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold" 
                                placeholder="اختياري" 
                              />
                            </div>
                            <div className="space-y-2">
                              <label htmlFor="patient-condition-notes" className="text-xs font-black text-slate-500">ملاحظات</label>
                              <input 
                                id="patient-condition-notes"
                                type="text" 
                                value={conditionNotes} 
                                onChange={(e) => setConditionNotes(e.target.value)} 
                                className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold" 
                                placeholder="اختياري" 
                              />
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setShowConditionForm(false)} className="px-4 py-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm font-bold">إلغاء</button>
                            <button type="submit" disabled={isSubmittingCondition} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-black shadow-md shadow-blue-600/10">حفظ</button>
                          </div>
                        </form>
                     ) : (
                        <button 
                          onClick={() => setShowConditionForm(true)}
                          className="w-full py-5 border-2 border-dashed border-blue-200 dark:border-blue-900/30 rounded-3xl text-blue-400 font-black hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
                        >
                           <PlusCircle className="w-6 h-6" /> إضافة حالة صحية
                        </button>
                     )}
                  </div>
               </div>
            </div>
          )}

          {activeTab === 'statement' && (
            <div className="h-full animate-in fade-in slide-in-from-bottom-4">
               <CustomerStatementContent patientId={patientId} />
            </div>
          )}

          {activeTab === 'payments' && (
             <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
                <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm">
                   <div>
                      <h3 className="text-2xl font-black text-slate-800 dark:text-white">توريدات نقدية جديدة</h3>
                      <p className="text-slate-500 font-bold">إضافة دفعة نقدية لحساب العميل</p>
                   </div>
                   {canProcessPatientPayments && (
                     <button
                       onClick={() => setShowPaymentForm(true)}
                       className="px-8 py-4 bg-emerald-600 text-white rounded-2xl font-black hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2"
                     >
                        <PlusCircle className="w-6 h-6" /> إضافة توريد (F1)
                     </button>
                   )}
                </div>

                 {showPaymentForm && (
                    <form onSubmit={handleAddPayment} className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border-2 border-emerald-500 shadow-xl space-y-6 animate-in slide-in-from-top-4 duration-200">
                       <div className="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-4">
                          <h4 className="text-lg font-black text-slate-800 dark:text-white flex items-center gap-2">
                             💵 تسجيل دفعة جديدة
                          </h4>
                          <button 
                             type="button" 
                             aria-label="إغلاق نموذج الدفعة"
                             onClick={() => setShowPaymentForm(false)}
                             className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                          >
                             <X className="w-5 h-5" />
                          </button>
                       </div>
                       
                       <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                          <div className="space-y-2">
                             <label htmlFor="patient-payment-amount" className="text-xs font-black text-slate-500">مبلغ الدفعة</label>
                             <input 
                                id="patient-payment-amount"
                                type="number" 
                                step="any"
                                value={paymentAmount}
                                onChange={(e) => setPaymentAmount(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-black text-xl text-center text-emerald-600 focus:bg-white dark:focus:bg-slate-900 border-2 border-transparent focus:border-emerald-500 transition-all"
                                placeholder="0.00"
                                required
                             />
                          </div>
                          
                          <div className="space-y-2">
                             <label htmlFor="patient-payment-method" className="text-xs font-black text-slate-500">طريقة الدفع</label>
                             <select
                                id="patient-payment-method"
                                value={paymentMethod}
                                onChange={(e) => setPaymentMethod(e.target.value as 'cash' | 'bank')}
                                className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold"
                             >
                                <option value="cash">نقدي (Cash)</option>
                                <option value="bank">بنك / شبكة (Bank)</option>
                             </select>
                          </div>

                          <div className="space-y-2">
                             <label htmlFor="patient-payment-date" className="text-xs font-black text-slate-500">تاريخ الدفعة</label>
                             <input 
                                id="patient-payment-date"
                                type="date" 
                                value={paymentDate}
                                onChange={(e) => setPaymentDate(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold"
                                required
                             />
                          </div>

                          <div className="space-y-2">
                             <label htmlFor="patient-payment-notes" className="text-xs font-black text-slate-500">البيان / ملاحظات</label>
                             <input 
                                id="patient-payment-notes"
                                type="text"
                                value={paymentNotes}
                                onChange={(e) => setPaymentNotes(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold"
                                placeholder="مثال: دفعة تحت الحساب"
                             />
                          </div>
                       </div>

                       <div className="flex justify-end gap-4">
                          <button 
                             type="button" 
                             onClick={() => setShowPaymentForm(false)}
                             className="px-6 py-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 rounded-xl font-bold transition-all text-slate-600 dark:text-slate-200"
                          >
                             إلغاء
                          </button>
                          <button 
                             type="submit" 
                             disabled={isSubmittingPayment}
                             className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black transition-all shadow-lg shadow-emerald-500/20"
                          >
                             {isSubmittingPayment ? 'جاري الحفظ...' : 'تأكيد تسجيل الدفعة'}
                          </button>
                       </div>
                    </form>
                 )}
                
                <div className="bg-white dark:bg-slate-900 rounded-[32px] border border-slate-100 dark:border-slate-800 overflow-hidden">
                   <table className="w-full text-right">
                      <thead className="bg-slate-50 dark:bg-slate-800/50">
                         <tr>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase">التاريخ</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase">المبلغ</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase">البيان</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase">المستخدم</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                         {(data.payments || []).map((p: any) => (
                             <tr key={p.id}>
                                <td className="px-6 py-4 font-bold">{p.date ? format(new Date(p.date), 'yyyy/MM/dd') : '---'}</td>
                                <td className={cn("px-6 py-4 font-black text-lg", p.type === 'refund' ? "text-amber-600" : "text-emerald-600")}>
                                  {p.type === 'refund' ? `-${p.amount}` : p.amount} ج.م
                                </td>
                                <td className="px-6 py-4 text-slate-500">{p.notes || (p.type === 'refund' ? 'مرتجع لحساب العميل' : 'دفعة نقدية')}</td>
                                <td className="px-6 py-4 font-bold">{p.user_name || '---'}</td>
                             </tr>
                          ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

          {activeTab === 'notices' && canManageFinancialNotices && (
             <div className="h-full animate-in fade-in slide-in-from-bottom-4">
                <FinancialNoticeForm
                  targetId={patientId}
                  targetType="customer"
                  onSuccess={() => { void fetchProfile(true) }}
                />
             </div>
          )}

          {activeTab === 'history' && (

             <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
                <h3 className="font-black text-slate-800 dark:text-white flex items-center gap-3">
                   <Activity className="w-8 h-8 text-purple-500" /> سجل العمليات والمشتريات
                </h3>
                <div className="space-y-4">
                   {(!data?.purchaseHistory || data.purchaseHistory.length === 0) ? (
                     <div className="p-8 text-center text-slate-400 font-bold bg-white dark:bg-slate-800/50 rounded-[32px]">
                       لا توجد عمليات مشتريات مسجلة لهذا المريض
                     </div>
                   ) : (
                     data.purchaseHistory.map((inv: any) => (
                       <div 
                         key={inv.invoice_id} 
                         onClick={() => handleOpenReceipt(inv.invoice_id)}
                         className="bg-white dark:bg-slate-800/50 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 flex justify-between items-center hover:shadow-2xl hover:border-purple-500 transition-all cursor-pointer group"
                       >
                          <div className="flex gap-8 items-center">
                             <div className="w-16 h-16 bg-purple-50 dark:bg-purple-900/30 text-purple-600 rounded-[24px] flex items-center justify-center text-3xl group-hover:scale-110 transition-transform">
                                📄
                             </div>
                             <div>
                               <p className="font-black text-slate-900 dark:text-white text-xl flex items-center gap-2">
                                 فاتورة #{inv.invoice_id ? inv.invoice_id.substring(0, 8) : ''}
                                 <span className="text-xs bg-purple-100 dark:bg-purple-900/40 text-purple-600 px-3 py-1 rounded-full font-bold">
                                   عرض الفاتورة والأصناف 👁️
                                 </span>
                               </p>
                               <p className="text-sm font-bold text-slate-400 mt-1 line-clamp-1">
                                 {inv.drugs || (inv.payment_method === 'credit' ? 'فاتورة آجل' : 'فاتورة مبيعات')}
                               </p>
                             </div>
                          </div>
                          <div className="text-left">
                             <p className="font-black text-purple-600 text-3xl">{Number(inv.total_amount || 0).toFixed(2)} <span className="text-sm">ج.م</span></p>
                             <p className="text-xs font-black text-slate-500 mt-2">{inv.created_at ? format(new Date(inv.created_at), 'PPP', { locale: ar }) : ''}</p>
                          </div>
                       </div>
                     ))
                   )}
                </div>
             </div>
           )}
        </div>

        {selectedReceipt && (
          <ReceiptDetailsModal
            invoice={selectedReceipt}
            onClose={() => setSelectedReceipt(null)}
          />
        )}
        {/* Statement Modal Overlay */}
        {showStatement && (
          <CustomerStatementModal 
            patientId={patientId}
            onClose={() => setShowStatement(false)}
          />
        )}
      </div>
    </div>
  )
}

function FinanceStatCard({ icon: Icon, label, value, unit, color }: any) {
   return (
      <div className={cn("p-8 rounded-[32px] text-white shadow-xl relative overflow-hidden bg-gradient-to-br", color)}>
         <Icon className="absolute -right-4 -bottom-4 w-24 h-24 opacity-20" />
         <p className="text-xs font-bold opacity-80 uppercase tracking-widest mb-1">{label}</p>
         <p className="text-4xl font-black">{value} <span className="text-sm opacity-60">{unit}</span></p>
      </div>
   )
}
