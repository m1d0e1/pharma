'use client'
import { useHotkeys } from 'react-hotkeys-hook';

import { useState, useEffect } from 'react'
import { 
  User, Phone, MapPin, Calendar, CreditCard, HeartPulse, Save, X, Activity, 
  History, Award, ShieldCheck, Trash2, PlusCircle, AlertCircle, FileText
} from 'lucide-react'
import { toast } from 'react-hot-toast'
import { 
  getPatientProfileAction, updatePatientAction, 
  addPatientAllergyAction, addPatientConditionAction,
  deletePatientAllergyAction
} from '@/app/actions/patients'
import { addPatientPaymentAction } from '@/app/actions/finance'
import { format } from 'date-fns'
import { ar } from 'date-fns/locale'
import CustomerStatementModal from './CustomerStatementModal'
import { CustomerStatementContent, FinancialNoticeForm } from '../finance/FinancialComponents'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  patientId: string
  onClose: () => void
  onSuccess: () => void
}

export default function PatientProfileModal({ patientId, onClose, onSuccess }: Props) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [activeTab, setActiveTab] = useState<'profile' | 'finance' | 'medical' | 'history' | 'statement' | 'payments' | 'notices'>('profile')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showStatement, setShowStatement] = useState(false)

  // Payment Form States
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [paymentDate, setPaymentDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false)

  // Allergy Form States
  const [showAllergyForm, setShowAllergyForm] = useState(false)
  const [allergenName, setAllergenName] = useState('')
  const [allergySeverity, setAllgySeverity] = useState('mild')
  const [allergyNotes, setAllergyNotes] = useState('')
  const [isSubmittingAllergy, setIsSubmittingAllergy] = useState(false)

  // Condition Form States
  const [showConditionForm, setShowConditionForm] = useState(false)
  const [conditionName, setConditionName] = useState('')
  const [conditionMedications, setConditionMedications] = useState('')
  const [conditionNotes, setConditionNotes] = useState('')
  const [isSubmittingCondition, setIsSubmittingCondition] = useState(false)

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

  useEffect(() => {
    fetchProfile()
  }, [patientId])

  const fetchProfile = async () => {
    setLoading(true)
    const res = await getPatientProfileAction(patientId)
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
      toast.error(res.error || 'فشل جلب ملف المريض')
      onClose()
    }
    setLoading(false)
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    const res = await updatePatientAction(patientId, formData as any)
    setIsSubmitting(false)
    if (res.success) {
      toast.success('تم تحديث البيانات بنجاح')
      onSuccess()
    } else {
      toast.error(res.error || 'فشل التحديث')
    }
  }

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    const amt = parseFloat(paymentAmount)
    if (isNaN(amt) || amt <= 0) {
      toast.error('يرجى إدخال مبلغ صحيح')
      return
    }

    setIsSubmittingPayment(true)
    const res = await addPatientPaymentAction({
      patient_id: patientId,
      amount: amt,
      payment_method: paymentMethod,
      notes: paymentNotes,
      date: paymentDate
    })
    setIsSubmittingPayment(false)

    if (res.success) {
      toast.success('تم تسجيل الدفعة بنجاح')
      setShowPaymentForm(false)
      setPaymentAmount('')
      setPaymentNotes('')
      setPaymentDate(format(new Date(), 'yyyy-MM-dd'))
      fetchProfile()
    } else {
      toast.error(res.error || 'فشل إضافة الدفعة')
    }
  }

  const handleAddAllergy = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!allergenName.trim()) return
    setIsSubmittingAllergy(true)
    const res = await addPatientAllergyAction({
      patient_id: patientId,
      allergen: allergenName,
      severity: allergySeverity,
      notes: allergyNotes
    })
    setIsSubmittingAllergy(false)
    if (res.success) {
      toast.success('تمت إضافة الحساسية')
      setShowAllergyForm(false)
      setAllergenName('')
      setAllergyNotes('')
      fetchProfile()
    } else {
      toast.error(res.error || 'فشل إضافة الحساسية')
    }
  }

  const handleAddCondition = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!conditionName.trim()) return
    setIsSubmittingCondition(true)
    const res = await addPatientConditionAction({
      patient_id: patientId,
      condition_name: conditionName,
      medications: conditionMedications,
      notes: conditionNotes
    })
    setIsSubmittingCondition(false)
    if (res.success) {
      toast.success('تمت إضافة الحالة المرضية')
      setShowConditionForm(false)
      setConditionName('')
      setConditionMedications('')
      setConditionNotes('')
      fetchProfile()
    } else {
      toast.error(res.error || 'فشل إضافة الحالة المرضية')
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center z-[300]">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl flex flex-col items-center shadow-2xl">
           <Activity className="w-12 h-12 text-purple-600 animate-spin mb-4" />
           <p className="font-black text-slate-500">جاري تحميل ملف العميل...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 z-[300]" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-2xl w-full max-w-5xl max-h-[95vh] overflow-hidden border border-white/20 animate-in zoom-in duration-300 flex flex-col">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-800 via-slate-900 to-black p-8 flex justify-between items-center text-white relative shrink-0">
          <div className="relative z-10 flex items-center gap-6">
            <div className="w-24 h-24 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-[32px] flex items-center justify-center text-4xl shadow-xl border-4 border-white/10">
               👤
            </div>
            <div>
              <h2 className="text-4xl font-black text-white flex items-center gap-3">
                {formData.full_name}
              </h2>
              <div className="flex gap-4 mt-2 opacity-70 font-bold text-sm uppercase tracking-widest">
                 <span className="flex items-center gap-1"><Phone className="w-4 h-4" /> {formData.phone}</span>
                 <span className="flex items-center gap-1"><Award className="w-4 h-4" /> {formData.points_balance} نقطة</span>
                 <span className="bg-white/10 px-3 py-1 rounded-full">{formData.customer_type}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-4">
             <button 
               onClick={() => setShowStatement(true)}
               className="px-6 py-4 bg-blue-600 text-white rounded-2xl font-black hover:bg-blue-500 transition-all flex items-center gap-2 shadow-lg shadow-blue-600/20"
             >
                <FileText className="w-5 h-5" /> كشف الحساب
             </button>
             <button onClick={onClose} className="p-4 bg-white/10 hover:bg-white/20 rounded-2xl transition-colors relative z-10">
               <X className="w-8 h-8" />
             </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex bg-slate-50 dark:bg-slate-800/50 p-2 border-b border-slate-100 dark:border-slate-800 shrink-0 overflow-x-auto no-scrollbar">
           {[
             { id: 'profile', label: 'البيانات الأساسية', icon: User },
             { id: 'finance', label: 'المالية والتأمين', icon: CreditCard },
             { id: 'statement', label: 'كشف الحساب', icon: FileText },
             { id: 'payments', label: 'توريدات نقدية', icon: History },
             { id: 'notices', label: 'إشعارات', icon: AlertCircle },
             { id: 'medical', label: 'الملف الطبي', icon: HeartPulse },
             { id: 'history', label: 'سجل المشتريات', icon: Activity }
           ].map(tab => (
             <button
               key={tab.id}
               onClick={() => setActiveTab(tab.id as any)}
               className={`flex-1 min-w-[120px] flex items-center justify-center gap-3 py-4 rounded-2xl font-black text-sm transition-all ${activeTab === tab.id ? 'bg-white dark:bg-slate-900 text-purple-600 shadow-lg' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
             >
               <tab.icon className="w-5 h-5" />
               {tab.label}
             </button>
           ))}
        </div>

        <div className="p-10 overflow-y-auto flex-1 custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">
          {activeTab === 'profile' && (
            <form onSubmit={handleUpdate} className="space-y-10">
               <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">الاسم بالكامل (عربي)</label>
                    <input
                      type="text"
                      value={formData.full_name}
                      onChange={(e) => setFormData({...formData, full_name: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">Name (English)</label>
                    <input
                      type="text"
                      value={formData.name_en}
                      onChange={(e) => setFormData({...formData, name_en: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all text-left shadow-sm focus:border-purple-500"
                      dir="ltr"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">رقم الهاتف</label>
                    <input
                      type="text"
                      value={formData.phone}
                      onChange={(e) => setFormData({...formData, phone: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
               </div>
               
               <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">رقم الموبايل</label>
                    <input
                      type="text"
                      value={formData.mobile}
                      onChange={(e) => setFormData({...formData, mobile: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">المنطقة</label>
                    <input
                      type="text"
                      value={formData.area}
                      onChange={(e) => setFormData({...formData, area: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">تاريخ الميلاد</label>
                    <input
                      type="date"
                      value={formData.birth_date}
                      onChange={(e) => setFormData({...formData, birth_date: e.target.value})}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                    />
                  </div>
               </div>

               <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">العنوان بالتفصيل</label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData({...formData, address: e.target.value})}
                    className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-purple-500"
                  />
               </div>

               <div className="bg-amber-50 dark:bg-amber-900/10 p-6 rounded-3xl border border-amber-100 dark:border-amber-900/20">
                  <label className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-2 block">ملاحظات إدارية</label>
                  <textarea
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
                 <Save className="w-6 h-6" /> {isSubmitting ? 'جاري الحفظ...' : 'حفظ جميع التعديلات (S)'}
               </button>
            </form>
          )}

          {activeTab === 'finance' && (
            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4">
               <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <FinanceStatCard icon={Award} label="نقاط الولاء" value={formData.points_balance} unit="نقطة" color="from-emerald-500 to-teal-600" />
                  <FinanceStatCard icon={CreditCard} label="رصيد المحفظة" value={data.patient.wallet_balance || 0} unit="ج.م" color="from-purple-500 to-indigo-600" />
                  <FinanceStatCard icon={ShieldCheck} label="حد الائتمان" value={formData.credit_limit} unit="ج.م" color="from-blue-500 to-indigo-600" />
                  <FinanceStatCard icon={History} label="الرصيد الحالي" value={data.currentBalance} unit="ج.م" color="from-slate-700 to-slate-900" />
               </div>

               <div className="bg-white dark:bg-slate-900 p-10 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm space-y-8">
                  <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                     <PlusCircle className="w-8 h-8 text-purple-500" /> شحن محفظة العميل
                  </h3>
                  <div className="flex gap-6 items-end">
                     <div className="flex-1 space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">المبلغ المراد شحنه</label>
                        <input 
                           id="topup-amount"
                           type="number" 
                           placeholder="0.00"
                           className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-purple-500 p-4 rounded-2xl outline-none font-black text-2xl"
                        />
                     </div>
                     <button 
                        onClick={async () => {
                           const amt = (document.getElementById('topup-amount') as HTMLInputElement).value;
                           if (!amt || parseFloat(amt) <= 0) return toast.error('يرجى إدخال مبلغ صحيح');
                           const { updatePatientWalletAction } = await import('@/app/actions/patients');
                           const res = await updatePatientWalletAction(patientId, parseFloat(amt), 'شحن يدوي من الملف الشخصي');
                           if (res.success) {
                              toast.success('تم شحن المحفظة بنجاح');
                              fetchProfile();
                           }
                        }}
                        className="px-12 py-5 bg-purple-600 text-white rounded-2xl font-black hover:bg-purple-700 transition-all shadow-xl shadow-purple-500/20"
                     >
                        تأكيد الشحن
                     </button>
                  </div>
               </div>

               <div className="bg-white dark:bg-slate-900 p-10 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm space-y-8">
                  <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                     <ShieldCheck className="w-8 h-8 text-blue-500" /> إعدادات التعاقد والتحصيل
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">طريقة الدفع الافتراضية</label>
                        <select
                          value={formData.payment_method}
                          onChange={(e) => setFormData({...formData, payment_method: e.target.value})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all appearance-none"
                        >
                           <option value="cash">نقدي (Cash)</option>
                           <option value="credit">آجل (Credit)</option>
                           <option value="visa">فيزا (Visa)</option>
                        </select>
                     </div>
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">رقم التأمين الصحي</label>
                        <input
                          type="text"
                          value={formData.insurance_number}
                          onChange={(e) => setFormData({...formData, insurance_number: e.target.value})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all"
                        />
                     </div>
                     <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">رقم السيارة</label>
                        <input
                          type="text"
                          value={formData.car_number}
                          onChange={(e) => setFormData({...formData, car_number: e.target.value})}
                          className="w-full bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-blue-500 p-4 rounded-2xl outline-none font-bold transition-all"
                        />
                     </div>
                  </div>
               </div>
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
                            <p className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">{a.severity}</p>
                          </div>
                          <button 
                            onClick={async () => {
                               await deletePatientAllergyAction(a.id);
                               fetchProfile();
                            }}
                            className="p-3 hover:bg-rose-100 dark:hover:bg-rose-800 rounded-2xl transition-colors opacity-0 group-hover:opacity-100"
                          >
                             <Trash2 className="w-5 h-5 text-rose-600" />
                          </button>
                       </div>
                     ))}
                     {showAllergyForm ? (
                        <form onSubmit={handleAddAllergy} className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-rose-200 space-y-4 animate-in slide-in-from-top-2 duration-200">
                          <div className="flex justify-between items-center">
                            <h4 className="font-black text-rose-600">إضافة حساسية جديدة</h4>
                            <button type="button" onClick={() => setShowAllergyForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                          </div>
                          <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400">مسبب الحساسية</label>
                            <input 
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
                              <label className="text-[10px] font-black text-slate-400">شدة الحساسية</label>
                              <select 
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
                              <label className="text-[10px] font-black text-slate-400">ملاحظات</label>
                              <input 
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
                          {c.medications && <p className="text-[10px] font-bold text-blue-500 mt-1 uppercase tracking-widest">الأدوية المستخدمة: {c.medications}</p>}
                       </div>
                     ))}
                     {showConditionForm ? (
                        <form onSubmit={handleAddCondition} className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-blue-200 space-y-4 animate-in slide-in-from-top-2 duration-200">
                          <div className="flex justify-between items-center">
                            <h4 className="font-black text-blue-600">إضافة حالة صحية جديدة</h4>
                            <button type="button" onClick={() => setShowConditionForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                          </div>
                          <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400">اسم الحالة المرضية</label>
                            <input 
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
                              <label className="text-[10px] font-black text-slate-400">الأدوية المنتظمة</label>
                              <input 
                                type="text" 
                                value={conditionMedications} 
                                onChange={(e) => setConditionMedications(e.target.value)} 
                                className="w-full bg-slate-50 dark:bg-slate-800 p-3 rounded-xl outline-none font-bold" 
                                placeholder="اختياري" 
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-[10px] font-black text-slate-400">ملاحظات</label>
                              <input 
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
                   <button 
                     onClick={() => setShowPaymentForm(true)}
                     className="px-8 py-4 bg-emerald-600 text-white rounded-2xl font-black hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2"
                   >
                      <PlusCircle className="w-6 h-6" /> إضافة توريد (F1)
                   </button>
                </div>

                 {showPaymentForm && (
                    <form onSubmit={handleAddPayment} className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border-2 border-emerald-500 shadow-xl space-y-6 animate-in slide-in-from-top-4 duration-200">
                       <div className="flex justify-between items-center border-b border-slate-100 dark:border-slate-800 pb-4">
                          <h4 className="text-lg font-black text-slate-800 dark:text-white flex items-center gap-2">
                             💵 تسجيل دفعة جديدة
                          </h4>
                          <button 
                             type="button" 
                             onClick={() => setShowPaymentForm(false)}
                             className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                          >
                             <X className="w-5 h-5" />
                          </button>
                       </div>
                       
                       <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                          <div className="space-y-2">
                             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">مبلغ الدفعة</label>
                             <input 
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
                             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">طريقة الدفع</label>
                             <select
                                value={paymentMethod}
                                onChange={(e) => setPaymentMethod(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold"
                             >
                                <option value="cash">نقدي (Cash)</option>
                                <option value="bank">بنك / شبكة (Bank)</option>
                             </select>
                          </div>

                          <div className="space-y-2">
                             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">تاريخ الدفعة</label>
                             <input 
                                type="date" 
                                value={paymentDate}
                                onChange={(e) => setPaymentDate(e.target.value)}
                                className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold"
                                required
                             />
                          </div>

                          <div className="space-y-2">
                             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider">البيان / ملاحظات</label>
                             <input 
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
                                <td className="px-6 py-4 font-black text-emerald-600 text-lg">{p.amount} ج.م</td>
                                <td className="px-6 py-4 text-slate-500">{p.notes || 'دفعة نقدية'}</td>
                                <td className="px-6 py-4 font-bold">{p.user_name || '---'}</td>
                             </tr>
                          ))}
                      </tbody>
                   </table>
                </div>
             </div>
          )}

          {activeTab === 'notices' && (
             <div className="h-full animate-in fade-in slide-in-from-bottom-4">
                <FinancialNoticeForm targetId={patientId} targetType="customer" />
             </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
               <h3 className="font-black text-slate-800 dark:text-white flex items-center gap-3">
                  <Activity className="w-8 h-8 text-purple-500" /> سجل العمليات والمشتريات
               </h3>
               <div className="space-y-4">
                  {data.purchaseHistory.filter((h: any) => h.drugs).map((inv: any) => (
                    <div key={inv.invoice_id} className="bg-white dark:bg-slate-800/50 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 flex justify-between items-center hover:shadow-2xl hover:border-purple-500 transition-all cursor-pointer group">
                       <div className="flex gap-8 items-center">
                          <div className="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-[24px] flex items-center justify-center text-3xl group-hover:scale-110 transition-transform">
                             📄
                          </div>
                          <div>
                            <p className="font-black text-slate-900 dark:text-white text-xl">فاتورة #{inv.invoice_id.split('-')[0]}</p>
                            <p className="text-sm font-bold text-slate-400 mt-1 line-clamp-1">{inv.drugs}</p>
                          </div>
                       </div>
                       <div className="text-left">
                          <p className="font-black text-purple-600 text-3xl">{inv.total_amount} <span className="text-sm">ج.م</span></p>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">{format(new Date(inv.created_at), 'PPP', { locale: ar })}</p>
                       </div>
                    </div>
                  ))}
               </div>
            </div>
          )}
        </div>

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
