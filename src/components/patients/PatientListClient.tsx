'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import AddPatientModal from '../AddPatientModal'
import PatientProfileModal from './PatientProfileModal'
import { toast } from 'react-hot-toast'
import { User, Phone, MapPin, CreditCard, ChevronLeft, Trash2, Pencil } from 'lucide-react'

interface Patient {
  id: string
  full_name: string
  name_en?: string
  phone?: string | null
  address: string
  notes: string
  points_balance: number
  outstanding_balance?: number
  wallet_balance?: number
  credit_limit?: number
  customer_type: string
  created_at: string
}

interface Props {
  initialPatients: Patient[]
  pharmacyId: string
  canDeletePatients: boolean
}

export default function PatientListClient({ initialPatients, pharmacyId, canDeletePatients }: Props) {
  const [searchTerm, setSearchTerm] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null)
  const [patients, setPatients] = useState<Patient[]>(initialPatients)
  const router = useRouter()

  useEffect(() => {
    setPatients(initialPatients)
  }, [initialPatients])

  const fetchPatients = async () => {
    try {
      const { getPatientsAction } = await import('@/app/actions-client/patients')
      const result = await getPatientsAction()
      if (!result.success) throw new Error(result.error)
      setPatients(((result.data || []) as Patient[]).slice(0, 200))
    } catch (err) {
      console.error('Failed to load patients:', err)
    }
  }

  const filteredPatients = patients.filter(p => 
    p.full_name.includes(searchTerm) || 
    (p.phone || '').includes(searchTerm) ||
    (p.name_en && p.name_en.toLowerCase().includes(searchTerm.toLowerCase()))
  )

  const [deletingPatient, setDeletingPatient] = useState<Patient | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDeletePatient = (patient: Patient) => {
    setDeletingPatient(patient);
  }

  const confirmDeletePatient = async () => {
    if (!deletingPatient) return;
    setIsDeleting(true);
    try {
      const { deletePatientAction } = await import('@/app/actions-client/patients');
      const res = await deletePatientAction(deletingPatient.id);
      if (res.success) {
        toast.success('تم حذف المريض بنجاح');
        setDeletingPatient(null);
        await fetchPatients();
        router.refresh();
      } else {
        toast.error(res.error || 'فشل حذف المريض');
      }
    } catch {
      toast.error('حدث خطأ أثناء حذف المريض');
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-4 items-center">
        <div className="relative flex-1">
          <span className="absolute inset-y-0 right-4 flex items-center text-slate-400">🔍</span>
          <input
            type="text"
            placeholder="ابحث عن مريض بالاسم أو رقم الهاتف..."
            className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 pr-12 pl-4 py-4 rounded-3xl focus:ring-2 focus:ring-purple-500 outline-none transition-all font-bold shadow-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="w-full md:w-auto px-8 py-4 bg-purple-600 text-white rounded-3xl font-black shadow-lg shadow-purple-500/20 hover:bg-purple-700 transition-all transform active:scale-95 flex items-center justify-center gap-2"
        >
          <User className="w-5 h-5" /> إضافة مريض
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredPatients.map(patient => (
          <div 
            key={patient.id} 
            onClick={() => setSelectedPatientId(patient.id)}
            className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-xl hover:shadow-2xl transition-all group cursor-pointer border-t-8 border-t-purple-500 relative overflow-hidden"
          >
            <div className="absolute -right-4 -top-4 w-24 h-24 bg-purple-50 dark:bg-purple-900/10 rounded-full blur-2xl group-hover:bg-purple-500/10 transition-colors" />
            
            <div className="flex justify-between items-start mb-6">
              <div className="w-14 h-14 bg-purple-100 dark:bg-purple-900/30 rounded-2xl flex items-center justify-center text-3xl shadow-inner group-hover:scale-110 transition-transform">
                👤
              </div>
              <div className="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl text-[10px] font-black text-slate-500 flex items-center gap-2">
                 <CreditCard className="w-3 h-3" /> {patient.points_balance || 0} نقطة
              </div>
            </div>

            <div className="space-y-1 mb-6">
              <h3 className="text-2xl font-black text-slate-900 dark:text-white leading-tight">{patient.full_name}</h3>
              {patient.name_en && <p className="text-xs font-bold text-slate-400 uppercase tracking-widest" dir="ltr text-right">{patient.name_en}</p>}
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <div className={`rounded-xl px-3 py-2 ${Number(patient.outstanding_balance || 0) < 0 ? 'bg-cyan-50 dark:bg-cyan-950/20' : 'bg-rose-50 dark:bg-rose-950/20'}`}>
                  <p className={`text-[9px] font-black ${Number(patient.outstanding_balance || 0) < 0 ? 'text-cyan-500' : 'text-rose-400'}`}>
                    {Number(patient.outstanding_balance || 0) < 0 ? 'رصيد دائن' : 'المديونية'}
                  </p>
                  <p className={`font-black ${Number(patient.outstanding_balance || 0) < 0 ? 'text-cyan-600' : 'text-rose-600'}`}>
                    {Math.abs(Number(patient.outstanding_balance || 0)).toFixed(2)} ج.م
                  </p>
                </div>
                <div className="rounded-xl bg-purple-50 dark:bg-purple-950/20 px-3 py-2">
                  <p className="text-[9px] font-black text-purple-400">رصيد المحفظة</p>
                  <p className="font-black text-purple-600">{Number(patient.wallet_balance || 0).toFixed(2)} ج.م</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-blue-600 dark:text-blue-400 font-black">
                <Phone className="w-4 h-4" />
                <span>{patient.phone || 'بدون هاتف'}</span>
              </div>
              
              <div className="flex items-start gap-3 text-sm text-slate-500 font-bold">
                <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="line-clamp-1">{patient.address || 'لا يوجد عنوان مسجل'}</span>
              </div>

              <div className="pt-6 border-t border-slate-50 dark:border-slate-800 flex justify-between items-center">
                 <div className="flex items-center gap-2">
                   {canDeletePatients && (
                     <button
                       type="button"
                       onClick={(e) => { e.stopPropagation(); handleDeletePatient(patient); }}
                       className="p-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-xl transition-all"
                       title="حذف المريض"
                     >
                       <Trash2 className="w-4 h-4" />
                     </button>
                   )}
                   <button
                     type="button"
                     onClick={(e) => { e.stopPropagation(); setSelectedPatientId(patient.id); }}
                     className="p-2 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-xl transition-all"
                     title="تعديل بيانات المريض"
                   >
                     <Pencil className="w-4 h-4" />
                   </button>
                   <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">{patient.customer_type === 'individual' ? 'فردي' : 'متعاقد'}</span>
                 </div>
                 <div className="flex items-center gap-1 text-purple-600 font-black text-sm hover:translate-x-[-4px] transition-transform">
                    عرض وتعديل الملف <ChevronLeft className="w-4 h-4" />
                 </div>
              </div>
            </div>
          </div>
        ))}

        {filteredPatients.length === 0 && (
          <div className="col-span-full py-20 text-center bg-slate-50/50 dark:bg-slate-800/20 rounded-[40px] border-2 border-dashed border-slate-200 dark:border-slate-800">
            <div className="text-6xl mb-4 opacity-20">👤</div>
            <p className="text-slate-400 font-black text-xl">لم يتم العثور على مرضى بهذا الاسم.</p>
          </div>
        )}
      </div>

      {isModalOpen && (
        <AddPatientModal 
          pharmacyId={pharmacyId} 
          onClose={() => setIsModalOpen(false)} 
          onSuccess={() => { fetchPatients(); router.refresh(); }} 
        />
      )}

      {selectedPatientId && (
        <PatientProfileModal
          patientId={selectedPatientId}
          onClose={() => setSelectedPatientId(null)}
          onSuccess={() => { fetchPatients(); router.refresh(); }}
        />
      )}

      {deletingPatient && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 z-[350]" dir="rtl">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 max-w-md w-full border border-slate-200 dark:border-slate-800 shadow-2xl space-y-6 animate-in zoom-in duration-200">
            <div className="flex items-center gap-4 text-rose-600">
              <div className="w-12 h-12 bg-rose-100 dark:bg-rose-950/40 rounded-2xl flex items-center justify-center text-2xl">
                ⚠️
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-white">تأكيد حذف المريض</h3>
                <p className="text-xs font-bold text-slate-400 mt-1">إجراء غير قابل للتراجع</p>
              </div>
            </div>
            <p className="font-bold text-slate-700 dark:text-slate-300">
              هل أنت متأكد من حذف المريض <span className="font-black text-rose-600">"{deletingPatient.full_name}"</span>؟
            </p>
            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setDeletingPatient(null)}
                className="px-6 py-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 rounded-xl font-bold transition-all text-slate-600 dark:text-slate-200"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={confirmDeletePatient}
                className="px-6 py-3 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-black transition-all shadow-lg shadow-rose-600/20"
              >
                {isDeleting ? 'جاري الحذف...' : 'نعم، تأكيد الحذف'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
