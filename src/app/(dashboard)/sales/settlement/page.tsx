import React from 'react'
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local'
import { redirect } from 'next/navigation'
import SettlementClient from '@/components/sales/SettlementClient'
import { getUnsettledSalesAction } from '@/app/actions/settlement'
import AccessDenied from '@/components/AccessDenied'

export default async function SettlementPage() {
  const user = await getClientSession()
  if (!user) return <AccessDenied />

  const isAllowed = hasUserPermissionSync(user, 'can_view_settlement')
  if (!isAllowed) {
    return <AccessDenied />
  }

  const result = await getUnsettledSalesAction()
  const unsettledItems = result.success ? result.data : []

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">تسوية مبيعات بدون رصيد</h1>
          <p className="text-slate-500 mt-1 font-bold">قم بربط المبيعات التي تمت بدون رصيد بالدفعات المخزنية المتوفرة.</p>
        </div>
      </div>

      <SettlementClient initialItems={unsettledItems as any[]} />
    </div>
  )
}
