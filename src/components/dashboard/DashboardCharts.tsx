'use client';

import React from 'react';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface TrendData {
  date: string;
  sales: number;
  returns: number;
  cogs: number;
}

interface TopItemData {
  name: string;
  quantity: number;
  revenue: number;
}

interface DashboardChartsProps {
  trendData: TrendData[];
  topItemsData: TopItemData[];
}

const AREA_COLORS = { sales: '#3b82f6', profit: '#10b981' };
const BAR_COLORS = { sales: '#3b82f6', returns: '#f43f5e' };
const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
const PIE_LEGEND_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

export function DashboardCharts({ trendData = [], topItemsData = [] }: DashboardChartsProps) {
  const formattedTrendData = trendData.map(item => {
    const net_sales = (item.sales || 0) - (item.returns || 0);
    const profit = net_sales - (item.cogs || 0);
    return {
      ...item,
      net_sales: Math.max(0, net_sales),
      profit: Math.max(0, profit),
      displayDate: new Date(item.date).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })
    };
  });

  const hasTrendData = formattedTrendData.some(d => d.net_sales > 0 || d.profit > 0);
  const hasTopItems = topItemsData.length > 0;

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-xl border border-gray-100/50">
          <p className="font-bold text-gray-800 mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center gap-2 text-sm font-medium">
              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
              <span className="text-gray-600">{entry.name}:</span>
              <span className="text-gray-900">{Number(entry.value).toLocaleString('en-US')} ج.م</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  const TopItemTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-xl border border-gray-100/50">
          <p className="font-bold text-gray-800 mb-1">{data.name}</p>
          <p className="text-sm text-gray-600">الكمية المباعة: <span className="font-bold text-gray-900">{data.quantity}</span></p>
          <p className="text-sm text-gray-600">الإيرادات: <span className="font-bold text-blue-600">{Number(data.revenue).toLocaleString('en-US')} ج.م</span></p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
      {/* Sales & Profit Area Chart */}
      <Card className="lg:col-span-2 shadow-xl border-none bg-gradient-to-br from-white to-slate-50/50 relative overflow-visible">
        <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl" />
        <CardHeader>
          <CardTitle className="text-lg font-bold text-gray-800 flex justify-between items-center">
            <span>تحليل المبيعات والأرباح (30 يوم)</span>
            <span className="text-sm font-medium px-3 py-1 bg-blue-100 text-blue-700 rounded-full">Net Sales & Profit</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasTrendData ? (
            <div className="h-[320px] flex items-center justify-center text-gray-400 text-sm">
              لا توجد بيانات مبيعات كافية لعرض الرسم البياني
            </div>
          ) : (
          <div className="h-[320px] w-full" style={{ position: 'relative' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={formattedTrendData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={AREA_COLORS.sales} stopOpacity={0.2}/>
                    <stop offset="95%" stopColor={AREA_COLORS.sales} stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={AREA_COLORS.profit} stopOpacity={0.2}/>
                    <stop offset="95%" stopColor={AREA_COLORS.profit} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis 
                  dataKey="displayDate" 
                  axisLine={false} tickLine={false} 
                  tick={{ fontSize: 12, fill: '#64748b' }} dy={10}
                />
                <YAxis 
                  axisLine={false} tickLine={false} 
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  tickFormatter={(val) => `${val / 1000}k`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend verticalAlign="top" height={36} iconType="circle" />
                <Area type="monotone" dataKey="net_sales" name="صافي المبيعات"
                  stroke={AREA_COLORS.sales} strokeWidth={3} fillOpacity={1}
                  fill="url(#colorSales)" activeDot={{ r: 6, strokeWidth: 0, fill: AREA_COLORS.sales }}
                />
                <Area type="monotone" dataKey="profit" name="الأرباح"
                  stroke={AREA_COLORS.profit} strokeWidth={3} fillOpacity={1}
                  fill="url(#colorProfit)" activeDot={{ r: 6, strokeWidth: 0, fill: AREA_COLORS.profit }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          )}
        </CardContent>
      </Card>

      {/* Top Selling Items Donut Chart */}
      <Card className="lg:col-span-1 shadow-xl border-none bg-gradient-to-br from-white to-slate-50/50 relative overflow-visible">
        <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl" />
        <CardHeader>
          <CardTitle className="text-lg font-bold text-gray-800 flex justify-between items-center">
            <span>الأصناف الأكثر مبيعاً</span>
            <span className="text-sm font-medium px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full">Top 5</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center">
          {!hasTopItems ? (
            <div className="h-[250px] flex items-center justify-center text-gray-400 text-sm">
              لا توجد بيانات مبيعات كافية
            </div>
          ) : (
          <>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={topItemsData}
                  cx="50%" cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="quantity"
                  stroke="none"
                >
                  {topItemsData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<TopItemTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="w-full mt-2 space-y-2">
            {topItemsData.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 overflow-hidden">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: PIE_LEGEND_COLORS[idx % PIE_LEGEND_COLORS.length] }} />
                  <span className="text-gray-700 truncate max-w-[140px]" title={item.name}>{item.name}</span>
                </div>
                <span className="font-bold text-gray-900">{item.quantity}</span>
              </div>
            ))}
          </div>
          </>
          )}
        </CardContent>
      </Card>

      {/* Sales vs Returns Bar Chart */}
      <Card className="lg:col-span-3 shadow-xl border-none bg-gradient-to-br from-white to-slate-50/50 relative overflow-visible">
        <div className="absolute top-0 left-0 w-64 h-64 bg-rose-500/5 rounded-full blur-3xl" />
        <CardHeader>
          <CardTitle className="text-lg font-bold text-gray-800 flex justify-between items-center">
            <span>المبيعات مقابل المرتجعات</span>
            <span className="text-sm font-medium px-3 py-1 bg-rose-100 text-rose-700 rounded-full">Sales vs Returns</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasTrendData ? (
            <div className="h-[280px] flex items-center justify-center text-gray-400 text-sm">
              لا توجد بيانات كافية لعرض الرسم البياني
            </div>
          ) : (
          <div className="h-[280px] w-full" style={{ position: 'relative' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={formattedTrendData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis 
                  dataKey="displayDate" axisLine={false} tickLine={false}
                  tick={{ fontSize: 12, fill: '#64748b' }} dy={10}
                />
                <YAxis 
                  axisLine={false} tickLine={false}
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  tickFormatter={(val) => `${val / 1000}k`}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f1f5f9', opacity: 0.5 }} />
                <Legend verticalAlign="top" height={36} iconType="circle" />
                <Bar dataKey="sales" fill={BAR_COLORS.sales} radius={[6, 6, 0, 0]} name="إجمالي المبيعات" maxBarSize={40} />
                <Bar dataKey="returns" fill={BAR_COLORS.returns} radius={[6, 6, 0, 0]} name="المرتجعات" maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
