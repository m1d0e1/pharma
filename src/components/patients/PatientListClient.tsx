'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AddPatientModal from '../AddPatientModal'
import PatientProfileModal from './PatientProfileModal'
import { toast } from 'react-hot-toast'
import { User, Phone, MapPin, HeartPulse, CreditCard, ChevronLeft } from 'lucide-react'

interface Patient {
  id: string
  full_name: string
  name_en?: string
  phone: string
  address: string
  notes: string
  points_balance: number
  customer_type: string
  created_at: string
}

interface Props {
  initialPatients: Patient[]
  pharmacyId: string
}

export default function PatientListClient({ initialPatients, pharmacyId }: Props) {
  const [searchTerm, setSearchTerm] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null)
  const router = useRouter()

  const filteredPatients = initialPatients.filter(p => 
    p.full_name.includes(searchTerm) || 
    p.phone.includes(searchTerm) || 
    (p.name_en && p.name_en.toLowerCase().includes(searchTerm.toLowerCase()))
  )

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
              <div className="flex items-center gap-3 text-blue-600 dark:text-blue-400 font-black">
                <Phone className="w-4 h-4" />
                <span>{patient.phone}</span>
              </div>
              
              <div className="flex items-start gap-3 text-sm text-slate-500 font-bold">
                <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="line-clamp-1">{patient.address || 'لا يوجد عنوان مسجل'}</span>
              </div>

              <div className="pt-6 border-t border-slate-50 dark:border-slate-800 flex justify-between items-center group-hover:translate-x-[-4px] transition-transform">
                 <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{patient.customer_type === 'individual' ? 'فردي' : 'متعاقد'}</span>
                 <div className="flex items-center gap-1 text-purple-600 font-black text-sm">
                    عرض الملف الكامل <ChevronLeft className="w-4 h-4" />
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
          onSuccess={() => router.refresh()} 
        />
      )}

      {selectedPatientId && (
        <PatientProfileModal
          patientId={selectedPatientId}
          onClose={() => setSelectedPatientId(null)}
          onSuccess={() => router.refresh()}
        />
      )}
    </div>
  )
}
