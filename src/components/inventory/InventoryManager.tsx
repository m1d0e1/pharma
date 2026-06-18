'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AddInventoryModal from '@/components/AddInventoryModal'

interface InventoryManagerProps {
  pharmacyId: string
}

export default function InventoryManager({ pharmacyId }: InventoryManagerProps) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const router = useRouter()

  return (
    <>
      <div className="flex gap-3">
        <button className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-6 py-3 rounded-2xl shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-all font-bold flex items-center gap-2">
          <span>📥</span> تصدير Excel
        </button>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl shadow-lg shadow-blue-500/20 transition-all font-bold flex items-center gap-2 transform active:scale-95"
        >
          <span>➕</span> إضافة دواء للمخزون
        </button>
      </div>

      {isModalOpen && (
        <AddInventoryModal 
          pharmacyId={pharmacyId} 
          onClose={() => setIsModalOpen(false)} 
          onSuccess={() => {
            router.refresh()
          }}
        />
      )}
    </>
  )
}
