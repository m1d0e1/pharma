'use client'

import React from 'react'
import { ShieldAlert, ArrowRight, Home, Lock } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface Props {
  title?: string
  message?: string
  actionText?: string
  actionHref?: string
}

export default function AccessDenied({ 
  title = "وصول غير مصرح به", 
  message = "عذراً، ليس لديك الصلاحيات الكافية للوصول إلى هذه الصفحة. يرجى التواصل مع مسؤول النظام إذا كنت تعتقد أن هذا خطأ.",
  actionText = "العودة للرئيسية",
  actionHref = "/"
}: Props) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6" dir="rtl">
      <div className="max-w-2xl w-full bg-white dark:bg-slate-900 rounded-[45px] p-12 shadow-hard border border-slate-100 dark:border-slate-800 relative overflow-hidden text-center">
        {/* Background Decorations */}
        <div className="absolute -top-24 -right-24 w-64 h-64 bg-rose-500/5 blur-[100px] rounded-full" />
        <div className="absolute -bottom-24 -left-24 w-64 h-64 bg-primary-500/5 blur-[100px] rounded-full" />
        
        <div className="relative z-10 space-y-8">
          <div className="inline-flex items-center justify-center w-24 h-24 bg-rose-100 dark:bg-rose-900/30 rounded-[30px] text-rose-600 dark:text-rose-400 mb-4 animate-bounce-slow">
            <ShieldAlert className="w-12 h-12" />
          </div>
          
          <div className="space-y-4">
            <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight flex items-center justify-center gap-3">
              <Lock className="w-8 h-8 text-rose-500" />
              {title}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-lg font-bold leading-relaxed max-w-md mx-auto">
              {message}
            </p>
          </div>
          
          <div className="pt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link 
              href={actionHref}
              className="px-10 py-5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-3xl font-black shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3 group"
            >
              <Home className="w-5 h-5" />
              {actionText}
              <ArrowRight className="w-5 h-5 group-hover:translate-x-[-4px] transition-transform" />
            </Link>
            
            <button 
              onClick={() => window.history.back()}
              className="px-10 py-5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-3xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all flex items-center gap-3"
            >
              الرجوع للخلف
            </button>
          </div>
          
          <div className="pt-12 border-t border-slate-50 dark:border-slate-800">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center justify-center gap-2">
              <span className="w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
              تم تسجيل هذه المحاولة في سجل الرقابة
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
