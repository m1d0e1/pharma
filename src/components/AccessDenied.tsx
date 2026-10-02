'use client'

import React, { useEffect, useState } from 'react'
import { ShieldAlert, ArrowRight, Home, Lock } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
  const router = useRouter()
  const [countdown, setCountdown] = useState(3)

  useEffect(() => {
    if (actionHref) {
      const timer = setInterval(() => setCountdown(c => c - 1), 1000)
      const redirect = setTimeout(() => router.push(actionHref), 3000)
      return () => { clearInterval(timer); clearTimeout(redirect) }
    }
  }, [actionHref, router])
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6" dir="rtl">
      <div className="max-w-2xl w-full bg-white dark:bg-slate-900 rounded-3xl p-6 sm:p-10 shadow-xl border border-slate-100 dark:border-slate-800 text-center">
        <div className="space-y-6">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-rose-100 dark:bg-rose-900/30 rounded-2xl text-rose-600 dark:text-rose-400">
            <ShieldAlert className="w-12 h-12" />
          </div>
          
          <div className="space-y-4">
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center justify-center gap-3">
              <Lock className="w-8 h-8 text-rose-500" />
              {title}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-lg font-bold leading-relaxed max-w-md mx-auto">
              {message}
            </p>
          </div>
          
          <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link 
              href={actionHref}
              className="px-8 py-4 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-2xl font-black shadow-sm hover:bg-slate-800 dark:hover:bg-slate-100 transition-colors flex items-center gap-3 group"
            >
              <Home className="w-5 h-5" />
              {actionText}
              <ArrowRight className="w-5 h-5 group-hover:translate-x-[-4px] transition-transform" />
            </Link>
            
            <button 
              type="button"
              onClick={() => window.history.back()}
              className="px-8 py-4 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-2xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-3"
            >
              الرجوع للخلف
            </button>
          </div>
          <p className="text-sm text-slate-500 mt-2" aria-live="polite">
            سيتم توجيهك إلى الرئيسية خلال {countdown} ثوان...
          </p>
          
        </div>
      </div>
    </div>
  )
}
