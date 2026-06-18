'use client'

import React from 'react'

export default function ReportsLoading() {
  return (
    <div className="space-y-8 animate-pulse p-4" dir="rtl">
      <div className="flex justify-between items-center">
        <div className="space-y-2">
          <div className="h-8 w-44 bg-slate-200 dark:bg-slate-700 rounded-lg"></div>
          <div className="h-4 w-64 bg-slate-100 dark:bg-slate-800 rounded-lg"></div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-850"></div>
            <div className="h-4 bg-slate-200 dark:bg-slate-700 w-1/2 rounded"></div>
            <div className="h-6 bg-slate-200 dark:bg-slate-700 w-3/4 rounded"></div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 h-80 space-y-4">
          <div className="h-6 bg-slate-200 dark:bg-slate-700 w-1/4 rounded"></div>
          <div className="h-full bg-slate-100 dark:bg-slate-850/50 rounded-2xl w-full"></div>
        </div>
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 h-80 space-y-4">
          <div className="h-6 bg-slate-200 dark:bg-slate-700 w-1/3 rounded"></div>
          <div className="h-full bg-slate-100 dark:bg-slate-850/50 rounded-2xl w-full"></div>
        </div>
      </div>
    </div>
  )
}
