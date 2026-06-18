'use client'

import React from 'react'

export default function Loading() {
  return (
    <div className="space-y-12 md:space-y-14 animate-pulse p-1" dir="rtl">
      {/* Page Header Skeleton */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-3">
          <div className="h-9 w-64 bg-slate-200 dark:bg-slate-800 rounded-2xl"></div>
          <div className="h-4 w-96 bg-slate-200 dark:bg-slate-800 rounded-lg hidden sm:block"></div>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="h-12 w-28 bg-slate-200 dark:bg-slate-800 rounded-2xl"></div>
          <div className="h-12 w-32 bg-slate-200 dark:bg-slate-800 rounded-2xl"></div>
        </div>
      </div>

      {/* Stats Cards Grid Skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-7">
        {[...Array(4)].map((_, idx) => (
          <div key={idx} className="p-7 bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-100 dark:border-slate-800/80 shadow-sm space-y-6">
            <div className="flex justify-between items-center">
              <div className="h-4 w-24 bg-slate-200 dark:bg-slate-800 rounded-lg"></div>
              <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-800"></div>
            </div>
            <div className="h-9 w-36 bg-slate-200 dark:bg-slate-800 rounded-xl mt-2"></div>
            <div className="flex items-center gap-3 pt-2">
              <div className="h-4 w-12 bg-slate-200 dark:bg-slate-800 rounded-md"></div>
              <div className="h-4 w-20 bg-slate-200 dark:bg-slate-800 rounded-md"></div>
            </div>
          </div>
        ))}
      </div>

      {/* Widgets & Content Grid Skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-7">
        {/* Main Content Area */}
        <div className="lg:col-span-2 space-y-7">
          <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-100 dark:border-slate-800/80 p-7 space-y-6">
            <div className="h-6 w-48 bg-slate-200 dark:bg-slate-800 rounded-xl"></div>
            <div className="h-[280px] bg-slate-100/50 dark:bg-slate-800/30 rounded-2xl"></div>
          </div>
        </div>

        {/* Sidebar Activity/Transations Skeleton */}
        <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-100 dark:border-slate-800/80 p-7 space-y-6">
          <div className="h-6 w-36 bg-slate-200 dark:bg-slate-800 rounded-xl"></div>
          <div className="space-y-4">
            {[...Array(4)].map((_, idx) => (
              <div key={idx} className="flex justify-between items-center py-4 border-b border-slate-50 dark:border-slate-800/50 last:border-b-0">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-800"></div>
                  <div className="space-y-2">
                    <div className="h-4 w-28 bg-slate-200 dark:bg-slate-800 rounded-lg"></div>
                    <div className="h-3.5 w-16 bg-slate-200 dark:bg-slate-800 rounded-lg"></div>
                  </div>
                </div>
                <div className="h-5 w-16 bg-slate-200 dark:bg-slate-800 rounded-lg"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
