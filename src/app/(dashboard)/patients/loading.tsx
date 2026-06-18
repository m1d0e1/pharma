'use client'

import React from 'react'

export default function PatientsLoading() {
  return (
    <div className="space-y-8 animate-pulse p-4" dir="rtl">
      <div className="flex justify-between items-center">
        <div className="space-y-3">
          <div className="h-8 w-48 bg-slate-200 dark:bg-slate-800 rounded-lg"></div>
          <div className="h-4 w-96 bg-slate-200 dark:bg-slate-800 rounded-lg"></div>
        </div>
        <div className="h-12 w-36 bg-slate-200 dark:bg-slate-800 rounded-2xl"></div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-100 dark:border-slate-800 p-6 space-y-4 shadow-sm">
        {/* Table Rows skeleton */}
        {[...Array(6)].map((_, idx) => (
          <div key={idx} className="flex items-center justify-between py-5 border-b border-slate-50 dark:border-slate-900/50">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-slate-200 dark:bg-slate-800"></div>
              <div className="space-y-2">
                <div className="h-5 w-32 bg-slate-200 dark:bg-slate-800 rounded"></div>
                <div className="h-4 w-24 bg-slate-200 dark:bg-slate-800 rounded"></div>
              </div>
            </div>
            <div className="h-8 w-24 bg-slate-200 dark:bg-slate-800 rounded-xl"></div>
          </div>
        ))}
      </div>
    </div>
  )
}
