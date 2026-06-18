'use client'

import React, { useMemo } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { ar } from 'date-fns/locale'
import { cn } from '@/lib/utils'
import { TrendingUp, Trophy, Tag, ShoppingCart, Package } from 'lucide-react'

interface SalesData {
  date: string
  revenue: number
}

interface TopDrug {
  name: string
  sales: number
}

interface CategoryData {
  name: string
  value: number
}

interface ReportsClientProps {
  salesHistory: SalesData[]
  topDrugs: TopDrug[]
  categoryData: CategoryData[]
}

const COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Rose
  '#8b5cf6', // Violet
  '#ec4899'  // Pink
]

const GRADIENTS = [
  'from-blue-500 to-blue-600',
  'from-emerald-500 to-emerald-600',
  'from-amber-500 to-amber-600',
  'from-rose-500 to-rose-600',
  'from-violet-500 to-violet-600',
  'from-pink-500 to-pink-600'
]

export default function ReportsClient({ 
  salesHistory = [], 
  topDrugs = [], 
  categoryData = [] 
}: ReportsClientProps) {
  const chartData = useMemo(() => {
    if (!salesHistory || salesHistory.length === 0) return []
    return salesHistory.map(item => ({
      ...item,
      formattedDate: format(parseISO(item.date), 'dd MMM', { locale: ar })
    }))
  }, [salesHistory])

  const maxSales = useMemo(() => {
    if (topDrugs.length === 0) return 1
    return Math.max(...topDrugs.map(d => d.sales))
  }, [topDrugs])

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-1000" dir="rtl">
      {/* Revenue Over Time Chart - Premium Style */}
      <div className="bg-white dark:bg-slate-900/60 backdrop-blur-xl p-10 rounded-[40px] border border-slate-100 dark:border-slate-800/80 shadow-soft overflow-hidden group relative">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary-500/5 rounded-full -mr-32 -mt-32 blur-3xl group-hover:bg-primary-500/10 transition-all duration-1000"></div>
        
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 relative z-10 gap-6">
          <div className="flex items-center gap-5">
            <div className="w-14 h-14 bg-primary-500 rounded-[20px] flex items-center justify-center text-white shadow-lg shadow-primary-500/20">
               <TrendingUp className="w-7 h-7" />
            </div>
            <div>
              <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                مبيعات آخر 30 يوم
              </h3>
              <p className="text-slate-500 font-bold text-sm">تطور الإيرادات اليومية بالجنيه المصري</p>
            </div>
          </div>
          <div className="flex gap-4">
             <div className="px-6 py-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/30 rounded-2xl flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-emerald-600 dark:text-emerald-400 text-xs font-black">+15% نمو هذا الشهر</span>
             </div>
          </div>
        </div>

        <div className="h-[400px] w-full relative z-10">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" strokeOpacity={0.1} />
              <XAxis 
                dataKey="formattedDate" 
                axisLine={false} 
                tickLine={false} 
                tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 700 }}
                dy={15}
              />
              <YAxis 
                axisLine={false} 
                tickLine={false} 
                tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 700 }}
                tickFormatter={(value) => `${value.toLocaleString('ar-EG')}`}
              />
              <Tooltip 
                contentStyle={{ 
                  borderRadius: '24px', 
                  border: '1px solid rgba(255,255,255,0.1)', 
                  backgroundColor: 'rgba(15, 23, 42, 0.9)',
                  backdropFilter: 'blur(10px)',
                  boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.5)',
                  padding: '16px 20px',
                  textAlign: 'right'
                }}
                labelStyle={{ fontWeight: 900, marginBottom: '8px', color: '#fff', fontSize: '14px' }}
                itemStyle={{ color: '#0ea5e9', fontWeight: 700 }}
              />
              <Area 
                type="monotone" 
                dataKey="revenue" 
                stroke="#0ea5e9" 
                strokeWidth={5}
                fillOpacity={1} 
                fill="url(#colorRevenue)" 
                animationDuration={2500}
                activeDot={{ r: 8, strokeWidth: 0, fill: '#0ea5e9' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Top Selling Drugs - Premium Progress List (Bulletproof Layout) */}
        <div className="bg-white dark:bg-slate-900/60 backdrop-blur-xl p-8 rounded-[40px] border border-slate-100 dark:border-slate-800/80 shadow-soft flex flex-col min-h-[500px]">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 shrink-0 bg-amber-500 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-amber-500/20">
               <Trophy className="w-6 h-6" />
            </div>
            <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">الأكثر مبيعاً</h3>
          </div>
          
          <div className="flex-1 flex flex-col justify-around gap-6">
            {topDrugs.length > 0 ? topDrugs.map((drug, index) => (
              <div key={index} className="flex flex-col gap-2 group/item">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black shadow-sm shrink-0",
                      index === 0 ? "bg-amber-100 text-amber-600 dark:bg-amber-900/40" : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                    )}>
                      {index + 1}
                    </div>
                    <p className="text-sm font-black text-slate-800 dark:text-slate-100 truncate group-hover/item:text-primary-500 transition-colors" title={drug.name}>
                      {drug.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-1.5 rounded-xl border border-slate-100 dark:border-slate-800 shrink-0">
                    <ShoppingCart className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="text-sm font-black text-slate-900 dark:text-white">{(drug.sales ?? 0).toLocaleString('ar-EG')}</span>
                  </div>
                </div>
                
                <div className="w-full h-3 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div 
                    className={cn(
                      "h-full rounded-full transition-all duration-1000 ease-out",
                      GRADIENTS[index % GRADIENTS.length]
                    )}
                    style={{ width: `${Math.max((drug.sales / maxSales) * 100, 2)}%` }}
                  />
                </div>
              </div>
            )) : (
              <div className="flex flex-col items-center justify-center py-20 opacity-20">
                <Package className="w-20 h-20 mb-4" />
                <p className="font-black text-xl">لا توجد بيانات مبيعات</p>
              </div>
            )}
          </div>
        </div>

        {/* Category Distribution - Improved Pie Chart with Custom HTML Legend */}
        <div className="bg-white dark:bg-slate-900/60 backdrop-blur-xl p-8 rounded-[40px] border border-slate-100 dark:border-slate-800/80 shadow-soft flex flex-col min-h-[500px]">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 shrink-0 bg-primary-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary-500/20">
               <Tag className="w-6 h-6" />
            </div>
            <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">توزيع الفئات</h3>
          </div>
          
          <div className="h-[280px] w-full relative mb-6 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={110}
                  paddingAngle={5}
                  dataKey="value"
                  stroke="none"
                  isAnimationActive={false} // Disable animation to prevent layout thrashing
                >
                  {categoryData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={COLORS[index % COLORS.length]} 
                      className="hover:opacity-80 transition-all outline-none cursor-pointer"
                    />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ 
                    borderRadius: '16px', 
                    border: 'none', 
                    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.3)',
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    padding: '12px 16px'
                  }}
                  itemStyle={{ color: '#fff', fontWeight: 900, fontSize: '14px' }}
                  labelStyle={{ display: 'none' }}
                />
              </PieChart>
            </ResponsiveContainer>
            
            {/* Center Summary Text */}
            <div className="absolute top-[50%] left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">إجمالي الفئات</p>
              <p className="text-3xl font-black text-slate-900 dark:text-white leading-none">
                {categoryData.length}
              </p>
            </div>
          </div>

          {/* Custom HTML Legend (Guaranteed no overlap) */}
          <div className="flex-1 flex flex-wrap justify-center items-end gap-x-4 gap-y-3 pb-2 overflow-y-auto custom-scrollbar">
            {categoryData.map((category, index) => (
              <div key={index} className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 px-3 py-1.5 rounded-full border border-slate-100 dark:border-slate-800">
                <span 
                  className="w-3 h-3 rounded-full shrink-0" 
                  style={{ backgroundColor: COLORS[index % COLORS.length] }} 
                />
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate max-w-[150px]" title={category.name}>
                  {category.name}
                </span>
                <span className="text-xs font-black text-slate-900 dark:text-white ml-1 shrink-0">
                  ({category.value})
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

