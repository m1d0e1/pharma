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

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

export function DashboardCharts({ trendData = [], topItemsData = [] }: DashboardChartsProps) {
  // Format dates and calculate net sales and profit
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

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white/90 backdrop-blur-md p-4 rounded-xl shadow-xl border border-gray-100/50">
          <p className="font-bold text-gray-800 mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center gap-2 text-sm font-medium">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
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
        <div className="bg-white/90 backdrop-blur-md p-4 rounded-xl shadow-xl border border-gray-100/50">
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
      {/* Sales & Profit Area Chart (Takes 2 columns) */}
      <Card className="lg:col-span-2 shadow-xl border-none bg-gradient-to-br from-white to-slate-50/50 backdrop-blur-md overflow-hidden relative">
        <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl -z-10" />
        <CardHeader>
          <CardTitle className="text-lg font-bold text-gray-800 flex justify-between items-center">
            <span>تحليل المبيعات والأرباح (30 يوم)</span>
            <span className="text-sm font-medium px-3 py-1 bg-blue-100 text-blue-700 rounded-full">Net Sales & Profit</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={formattedTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis 
                  dataKey="displayDate" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  dy={10}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  tickFormatter={(val) => `${val / 1000}k`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend verticalAlign="top" height={36} iconType="circle" />
                <Area 
                  type="monotone" 
                  dataKey="net_sales" 
                  name="صافي المبيعات"
                  stroke="#3b82f6" 
                  strokeWidth={3}
                  fillOpacity={1} 
                  fill="url(#colorSales)" 
                  activeDot={{ r: 6, strokeWidth: 0, fill: '#3b82f6' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="profit" 
                  name="الأرباح"
                  stroke="#10b981" 
                  strokeWidth={3}
                  fillOpacity={1} 
                  fill="url(#colorProfit)" 
                  activeDot={{ r: 6, strokeWidth: 0, fill: '#10b981' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Top Selling Items Donut Chart (Takes 1 column) */}
      <Card className="lg:col-span-1 shadow-xl border-none bg-gradient-to-br from-white to-slate-50/50 backdrop-blur-md overflow-hidden relative">
        <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl -z-10" />
        <CardHeader>
          <CardTitle className="text-lg font-bold text-gray-800 flex justify-between items-center">
            <span>الأصناف الأكثر مبيعاً</span>
            <span className="text-sm font-medium px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full">Top 5</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center">
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={topItemsData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="quantity"
                  stroke="none"
                >
                  {topItemsData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
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
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                  <span className="text-gray-700 truncate max-w-[140px]" title={item.name}>{item.name}</span>
                </div>
                <span className="font-bold text-gray-900">{item.quantity}</span>
              </div>
            ))}
            {topItemsData.length === 0 && (
              <p className="text-center text-gray-500 text-sm mt-4">لا توجد بيانات مبيعات كافية</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sales vs Returns Bar Chart (Takes full width below) */}
      <Card className="lg:col-span-3 shadow-xl border-none bg-gradient-to-br from-white to-slate-50/50 backdrop-blur-md overflow-hidden relative">
        <div className="absolute top-0 left-0 w-64 h-64 bg-rose-500/5 rounded-full blur-3xl -z-10" />
        <CardHeader>
          <CardTitle className="text-lg font-bold text-gray-800 flex justify-between items-center">
            <span>المبيعات مقابل المرتجعات</span>
            <span className="text-sm font-medium px-3 py-1 bg-rose-100 text-rose-700 rounded-full">Sales vs Returns</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={formattedTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis 
                  dataKey="displayDate" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  dy={10}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: '#64748b' }}
                  tickFormatter={(val) => `${val / 1000}k`}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f1f5f9', opacity: 0.5 }} />
                <Legend verticalAlign="top" height={36} iconType="circle" />
                <Bar dataKey="sales" fill="#3b82f6" radius={[6, 6, 0, 0]} name="إجمالي المبيعات" maxBarSize={40} />
                <Bar dataKey="returns" fill="#f43f5e" radius={[6, 6, 0, 0]} name="المرتجعات" maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
