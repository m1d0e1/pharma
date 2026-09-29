import React from 'react';
import { render, screen } from '@testing-library/react';
import { DashboardCharts } from '@/components/dashboard/DashboardCharts';
import SalesCharts from '@/components/dashboard/SalesCharts';

jest.mock('recharts', () => {
  const React = require('react');
  const passthrough = ({ children }: any) => <div>{children}</div>;
  return {
    ResponsiveContainer: passthrough,
    AreaChart: ({ data }: any) => <pre data-testid="area-chart-data">{JSON.stringify(data)}</pre>,
    BarChart: ({ data }: any) => <pre data-testid="bar-chart-data">{JSON.stringify(data)}</pre>,
    PieChart: passthrough,
    Area: () => null,
    Bar: () => null,
    Pie: passthrough,
    Cell: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

describe('dashboard graph calculations', () => {
  it('preserves loss days instead of clamping negative net sales and profit to zero', () => {
    render(
      <DashboardCharts
        trendData={[{
          date: '2026-09-28',
          sales: 0,
          returns: 40,
          cogs: 10,
        }]}
        topItemsData={[]}
      />,
    );

    const chartData = JSON.parse(screen.getByTestId('area-chart-data').textContent || '[]');
    expect(chartData).toEqual([
      expect.objectContaining({
        sales: 0,
        returns: 40,
        cogs: 10,
        net_sales: -40,
        profit: -50,
      }),
    ]);
    expect(screen.getByTestId('bar-chart-data')).toBeInTheDocument();
  });

  it('derives the sales trend badge from the supplied 30-day revenue instead of a fixed percentage', () => {
    const salesHistory = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      revenue: index < 15 ? 100 : 50,
    }));

    render(<SalesCharts salesHistory={salesHistory} topDrugs={[]} categoryData={[]} />);

    expect(screen.getByText(/-50%/)).toBeInTheDocument();
    expect(screen.queryByText('+15% نمو هذا الشهر')).not.toBeInTheDocument();
  });
});
