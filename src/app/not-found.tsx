import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-8 text-center" dir="rtl">
      <div className="text-9xl font-black text-slate-200 dark:text-slate-800 animate-pulse">404</div>
      <div className="relative -mt-16 bg-white dark:bg-slate-900 p-12 rounded-[3rem] shadow-2xl border border-slate-100 dark:border-slate-800 max-w-lg">
        <div className="text-6xl mb-6">🔍</div>
        <h1 className="text-3xl font-black text-slate-900 dark:text-white mb-4">عذراً، الصفحة غير موجودة</h1>
        <p className="text-slate-500 dark:text-slate-400 mb-8 leading-relaxed">
          يبدو أنك حاولت الوصول لصفحة غير موجودة أو تم نقلها. لا تقلق، يمكنك العودة للوحة التحكم والبدء من جديد.
        </p>
        <Link 
          href="/" 
          className="inline-block bg-blue-600 text-white px-10 py-4 rounded-2xl font-black shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all transform active:scale-95"
        >
          العودة للرئيسية
        </Link>
      </div>
    </div>
  )
}
