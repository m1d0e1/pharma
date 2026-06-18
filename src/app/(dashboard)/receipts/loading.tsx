'use client'

import React from 'react'

export default function ReceiptsLoading() {
  return (
    <div className="space-y-8 animate-pulse p-4" dir="rtl">
      <div className="flex justify-between items-center">
        <div className="space-y-2">
          <div className="h-8 w-40 bg-slate-200 dark:bg-slate-700 rounded-lg"></div>
          <div className="h-4 w-60 bg-slate-100 dark:bg-slate-800 rounded-lg"></div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-[30px] border border-slate-100 dark:border-slate-800 p-6 space-y-4 shadow-soft">
        <div className="border border-slate-100 dark:border-slate-800 rounded-2xl overflow-hidden">
          <div className="bg-slate-50 dark:bg-slate-800/50 h-12 flex items-center px-6 border-b border-slate-100 dark:border-slate-800">
            <div className="flex-1 grid grid-cols-4 gap-4">
              <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/2"></div>
              <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3"></div>
              <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3"></div>
              <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/4"></div>
            </div>
          </div>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 flex items-center px-6 border-b border-slate-50 dark:border-slate-800/30">
              <div className="flex-1 grid grid-cols-4 gap-4">
                <div className="h-4 bg-slate-150 dark:bg-slate-800 rounded w-2/3"></div>
                <div className="h-4 bg-slate-150 dark:bg-slate-800 rounded w-1/2"></div>
                <div className="h-4 bg-slate-150 dark:bg-slate-800 rounded w-1/2"></div>
                <div className="h-4 bg-slate-150 dark:bg-slate-800 rounded w-1/3"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
