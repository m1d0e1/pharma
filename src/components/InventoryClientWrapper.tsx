'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AddInventoryModal from './AddInventoryModal'
import { useHotkeys } from 'react-hotkeys-hook'

interface Props {
  pharmacyId: string
  onSuccess?: () => void
  canManageInventory: boolean
}

export default function InventoryClientWrapper({ pharmacyId, onSuccess, canManageInventory }: Props) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const router = useRouter()

  useHotkeys('insert', (e) => {
    if (!canManageInventory) return
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
      {canManageInventory && (
        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl shadow-lg shadow-blue-500/20 transition-all font-bold flex items-center gap-2 transform active:scale-95"
        >
          <span>➕</span> إضافة دواء للمخزون (Insert)
        </button>
      )}

      {canManageInventory && isModalOpen && (
        <AddInventoryModal 
          pharmacyId={pharmacyId || 'local_default'}
          onClose={() => setIsModalOpen(false)} 
          onSuccess={handleSuccess} 
        />
      )}
    </>
  )
}
