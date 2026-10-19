'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import AddInventoryModal from './AddInventoryModal'
import { useHotkeys } from 'react-hotkeys-hook'
import { Plus } from 'lucide-react'

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
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="bg-primary-700 hover:bg-primary-800 text-white px-4 py-2.5 rounded-lg shadow-sm transition-colors font-semibold flex items-center gap-2"
        >
          <Plus className="w-4 h-4" aria-hidden="true" /> إضافة دواء للمخزون (Insert)
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
