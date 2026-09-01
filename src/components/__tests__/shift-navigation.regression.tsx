import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import ShiftManagement from '@/components/dashboard/ShiftManagement';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';

jest.mock('@/app/actions-client/shifts', () => ({
  getCurrentShiftAction: jest.fn(),
  getCurrentShiftStatsAction: jest.fn(),
}));

describe('unified shift navigation', () => {
  it('opens the canonical shift-management page from the dashboard', async () => {
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: null });

    render(<ShiftManagement />);

    expect(await screen.findByRole('link', { name: 'إدارة الجلسات النقدية' })).toHaveAttribute('href', '/shifts');
  });

  it('does not expose the retired manual-open gate in POS checkout', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/(dashboard)/pos/page.tsx'), 'utf8');

    expect(source).not.toContain("checkoutError.includes('فتح وردية')");
    expect(source).not.toContain("router.push('/shifts')");
  });
});
