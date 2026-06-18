'use client';
import { useHotkeys } from 'react-hotkeys-hook';

import { useState } from 'react'
import { addPatientAction } from '@/app/actions/patients'
import { toast } from 'react-hot-toast'
import { User, Phone, MapPin, Calendar, CreditCard, HeartPulse, Save, X, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AddPatientModalProps {
  pharmacyId: string
  onClose: () => void
  onSuccess: () => void
}

export default function AddPatientModal({ pharmacyId, onClose, onSuccess }: AddPatientModalProps) {
  
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
const [fullName, setFullName] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [phone, setPhone] = useState('')
  const [mobile, setMobile] = useState('')
  const [address, setAddress] = useState('')
  const [area, setArea] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male')
  const [insuranceNumber, setInsuranceNumber] = useState('')
  const [carNumber, setCarNumber] = useState('')
  const [creditLimit, setCreditLimit] = useState(0)
  const [openingBalance, setOpeningBalance] = useState(0)
  const [pointValue, setPointValue] = useState(1)
  const [customerType, setCustomerType] = useState('individual')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [notes, setNotes] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    const formData = {
      full_name: fullName,
      name_en: nameEn,
      phone,
      mobile,
      address,
      area,
      birth_date: birthDate || null,
      gender,
      insurance_number: insuranceNumber || null,
      car_number: carNumber || null,
      credit_limit: creditLimit,
      opening_balance: openingBalance,
      points_balance: 0,
      point_value: pointValue,
      customer_type: customerType,
      payment_method: paymentMethod,
      notes
    }

    const result = await addPatientAction(formData as any)

    setIsSubmitting(false)

    if (result.success) {
      toast.success('تمت إضافة العميل بنجاح')
      onSuccess()
      onClose()
    } else {
      toast.error(result.error || 'حدث خطأ أثناء إضافة العميل')
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 z-[200]" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-2xl w-full max-w-4xl max-h-[95vh] overflow-hidden border border-white/20 animate-in zoom-in duration-300 flex flex-col">
        
        <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 p-8 flex justify-between items-center text-white relative shrink-0">
          <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none overflow-hidden">
             <div className="absolute -top-10 -left-10 w-40 h-40 bg-white rounded-full blur-3xl"></div>
             <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-white rounded-full blur-3xl"></div>
          </div>
          <div className="relative z-10">
            <h2 className="text-3xl font-black text-white flex items-center gap-3">
               <User className="w-8 h-8" /> إضافة عميل جديد
            </h2>
            <p className="text-blue-100 text-sm mt-1 font-bold opacity-80 uppercase tracking-widest">إنشاء سجل مالي وطبي متكامل للعميل</p>
          </div>
          <button onClick={onClose} className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl transition-all relative z-10">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-10 space-y-10 overflow-y-auto flex-1 custom-scrollbar bg-slate-50/30 dark:bg-slate-950/30">
          
          {/* Personal Info Section */}
          <div className="space-y-6">
            <SectionHeader icon={Activity} label="البيانات الشخصية والأساسية" color="text-blue-600" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <InputField label="الاسم بالكامل (ع) *" value={fullName} onChange={setFullName} placeholder="محمد أحمد..." required icon={User} />
              <InputField label="الاسم (En)" value={nameEn} onChange={setNameEn} placeholder="Name in English..." dir="ltr" />
              <InputField label="رقم الكود" value="تلقائي" onChange={() => {}} disabled placeholder="2" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <InputField label="رقم الهاتف *" value={phone} onChange={setPhone} placeholder="01xxxxxxxxx" required icon={Phone} />
              <InputField label="رقم الموبايل" value={mobile} onChange={setMobile} placeholder="رقم إضافي..." icon={Phone} />
              <InputField label="العنوان" value={address} onChange={setAddress} placeholder="المحافظة، الحي، الشارع..." icon={MapPin} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <InputField label="المنطقة" value={area} onChange={setArea} placeholder="مثال: المعادي..." />
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">تاريخ الميلاد</label>
                <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className="w-full bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-800 p-4 rounded-2xl outline-none font-bold transition-all shadow-sm focus:border-blue-500" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">النوع</label>
                <div className="flex gap-2">
                   {['male', 'female'].map((g) => (
                     <button key={g} type="button" onClick={() => setGender(g as any)} className={`flex-1 py-4 rounded-2xl font-black text-xs transition-all ${gender === g ? 'bg-blue-600 text-white shadow-lg' : 'bg-white dark:bg-slate-800 text-slate-400 border border-slate-100 dark:border-slate-800'}`}>
                       {g === 'male' ? 'ذكر' : 'أنثى'}
                     </button>
                   ))}
                </div>
              </div>
            </div>
          </div>

          {/* Business Info Section */}
          <div className="space-y-6 pt-6 border-t border-slate-100 dark:border-slate-800">
             <SectionHeader icon={Calendar} label="بيانات التعامل والمركبة" color="text-indigo-600" />
             <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">طبيعة العميل</label>
                  <select value={customerType} onChange={(e) => setCustomerType(e.target.value)} className="w-full bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-800 p-4 rounded-2xl outline-none font-bold shadow-sm focus:border-indigo-500 appearance-none">
                     <option value="individual">فرد</option>
                     <option value="company">شركة</option>
                     <option value="vip">VIP</option>
                  </select>
                </div>
                <InputField label="رقم السيارة" value={carNumber} onChange={setCarNumber} placeholder="أ ب ج 123..." />
                <InputField label="رقم التأمين الصحي" value={insuranceNumber} onChange={setInsuranceNumber} placeholder="000-000-000" />
             </div>
          </div>

          {/* Financial Section */}
          <div className="space-y-6 pt-6 border-t border-slate-100 dark:border-slate-800">
            <SectionHeader icon={CreditCard} label="البيانات المالية والمسحوبات" color="text-emerald-600" />
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">طريقة الدفع</label>
                <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className="w-full bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-800 p-4 rounded-2xl outline-none font-bold shadow-sm focus:border-emerald-500 appearance-none">
                   <option value="cash">نقدي (Cash)</option>
                   <option value="credit">آجل (Credit)</option>
                   <option value="visa">فيزا (Visa)</option>
                </select>
              </div>
              <InputField label="الحد الأقصى للرصيد" type="number" value={creditLimit.toString()} onChange={(val) => setCreditLimit(Number(val))} placeholder="0.00" color="text-rose-600" />
              <InputField label="رصيد أول المدة" type="number" value={openingBalance.toString()} onChange={(val) => setOpeningBalance(Number(val))} placeholder="0.00" color="text-emerald-600" />
              <InputField label="قيمة النقطة (ج.م)" type="number" value={pointValue.toString()} onChange={(val) => setPointValue(Number(val))} placeholder="1.00" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2 flex items-center gap-2">
               <HeartPulse className="w-3 h-3 text-rose-500" /> ملاحظات إضافية
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-800 p-4 rounded-3xl outline-none font-bold transition-all resize-none shadow-sm focus:border-purple-500" placeholder="سجل أي ملاحظات خاصة بالعميل أو تاريخه المرضي..." />
          </div>

          <div className="flex gap-4 pt-4 shrink-0">
            <button type="submit" disabled={isSubmitting} className="flex-[2] bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-5 rounded-3xl font-black text-lg hover:shadow-2xl hover:shadow-blue-500/30 transition-all transform active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-3">
              {isSubmitting ? <Activity className="animate-spin w-6 h-6" /> : <><Save className="w-6 h-6" /> حفظ العميل (S)</>}
            </button>
            <button type="button" onClick={onClose} className="flex-1 bg-white dark:bg-slate-800 text-slate-500 py-5 rounded-3xl font-black text-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 transition-all">إغلاق (C)</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SectionHeader({ icon: Icon, label, color }: any) {
  return (
    <div className={cn("flex items-center gap-2", color)}>
       <Icon className="w-5 h-5" />
       <h3 className="font-black text-sm uppercase tracking-widest">{label}</h3>
    </div>
  )
}

function InputField({ label, value, onChange, placeholder, required, type = "text", icon: Icon, disabled, dir, color }: any) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">{label}</label>
      <div className="relative">
        <input
          type={type}
          required={required}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-800 p-4 rounded-2xl outline-none font-black transition-all shadow-sm focus:border-blue-500",
            Icon && "pr-12",
            disabled && "opacity-50 bg-slate-50",
            color
          )}
          placeholder={placeholder}
          dir={dir}
        />
        {Icon && <Icon className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300" />}
      </div>
    </div>
  );
}
