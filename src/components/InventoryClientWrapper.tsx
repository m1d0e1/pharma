'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AddInventoryModal from './AddInventoryModal'
import { useHotkeys } from 'react-hotkeys-hook'

interface Props {
  pharmacyId: string
  onSuccess?: () => void
}

export default function InventoryClientWrapper({ pharmacyId, onSuccess }: Props) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const router = useRouter()

  useHotkeys('insert', (e) => {
    e.preventDefault()
    setIsModalOpen(true)
  }, { enableOnFormTags: true })

  const handleSuccess = () => {
    router.refresh() 
    if (onSuccess) {
      onSuccess()
    }
  }

  return (
    <>
      <button 
        onClick={() => setIsModalOpen(true)}
        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl shadow-lg shadow-blue-500/20 transition-all font-bold flex items-center gap-2 transform active:scale-95"
      >
        <span>➕</span> إضافة دواء للمخزون (Insert)
      </button>

      {isModalOpen && (
        <AddInventoryModal 
          pharmacyId={pharmacyId || 'placeholder-id'} 
          onClose={() => setIsModalOpen(false)} 
          onSuccess={handleSuccess} 
        />
      )}
    </>
  )
}
