import { Construction, ArrowRight } from 'lucide-react'
import Link from 'next/link'

export default async function PurchasesPlaceholderPage({ 
  params,
  searchParams
}: { 
  params: Promise<{ slug: string }>,
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { slug } = await params;
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 animate-in zoom-in duration-500">
      <div className="w-24 h-24 bg-amber-100 dark:bg-amber-900/30 text-amber-600 rounded-3xl flex items-center justify-center mb-8 shadow-lg shadow-amber-500/10">
        <Construction className="w-12 h-12" />
      </div>
      <h1 className="text-3xl font-black text-slate-900 dark:text-white mb-4">قيد التطوير</h1>
      <p className="text-slate-500 font-bold max-w-md mx-auto mb-10 leading-relaxed">
        هذا القسم (المشتريات) يتم العمل عليه حالياً وسيتم ربطه بالكامل في التحديث القادم. شكراً لصبرك!
      </p>
      <Link 
        href="/purchases"
        className="flex items-center gap-3 px-8 py-4 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-2xl font-black hover:scale-105 transition-all shadow-xl"
      >
        <ArrowRight className="w-5 h-5" />
        العودة للمشتريات
      </Link>
    </div>
  )
}
