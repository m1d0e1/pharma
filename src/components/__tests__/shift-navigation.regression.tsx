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

    expect(await screen.findByRole('link', { name: 'فتح وردية جديدة' })).toHaveAttribute('href', '/shifts');
  });

  it('keeps a visible POS redirect when checkout requires an open shift', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/(dashboard)/pos/page.tsx'), 'utf8');

    expect(source).toContain("checkoutError.includes('فتح وردية')");
    expect(source).toContain("router.push('/shifts')");
    expect(source).toMatch(/<button[\s\S]*فتح وردية[\s\S]*<\/button>/);
  });
});
