import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-8 text-center" dir="rtl">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 p-6 sm:p-10 rounded-3xl shadow-xl border border-slate-100 dark:border-slate-800">
        <div className="text-sm font-black text-slate-400 dark:text-slate-500 mb-3">خطأ 404</div>
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white mb-4">عذراً، الصفحة غير موجودة</h1>
        <p className="text-slate-500 dark:text-slate-400 mb-8 leading-relaxed">
          ربما تم نقل الصفحة أو لم يعد الرابط صحيحاً. يمكنك العودة إلى لوحة التحكم ومتابعة عملك.
        </p>
        <Link 
          href="/" 
          className="inline-block bg-blue-600 text-white px-8 py-4 rounded-2xl font-black shadow-sm hover:bg-blue-700 transition-colors"
        >
          العودة للرئيسية
        </Link>
      </div>
    </div>
  )
}
