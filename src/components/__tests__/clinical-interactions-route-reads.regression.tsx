import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InteractionsPage from '@/app/(dashboard)/interactions/page';
import { getClientSession } from '@/lib/auth/local';
import { dbGet, dbSelect } from '@/lib/db/tauri';

jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbGet: jest.fn(), dbSelect: jest.fn() }));
jest.mock('@/components/interactions/InteractionsClient', () => function ReadOnlyInteractionsStub({ totalCount, initialInteractions, userRole }: any) {
  return <div data-testid="interactions-client" data-total={totalCount} data-role={userRole} data-initial={initialInteractions.length} />;
});

const successfulCounts = (sql: string) => Promise.resolve({ count:
  sql.includes("severity = 'major'") ? 2082 :
  sql.includes('severity =') ? 12 : 191272,
});

describe('interactions page native-backed data and fail-closed reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'synthetic-owner', role: 'owner' });
    (dbGet as jest.Mock).mockImplementation(successfulCounts);
    (dbSelect as jest.Mock).mockResolvedValue([{ ingredient_a: 'Warfarin', ingredient_b: 'Aspirin' }]);
  });

  it('renders Arabic RTL totals and passes a read-only interaction sample to its client', async () => {
    render(<InteractionsPage />);
    const heading = await screen.findByRole('heading', { name: 'فحص التفاعلات الدوائية' });
    expect(heading.closest('[dir="rtl"]')).toBeInTheDocument();
    expect(screen.getByText('إجمالي التفاعلات').parentElement).toHaveTextContent('191272');
    expect(screen.getByText('تفاعلات خطيرة').parentElement?.parentElement).toHaveTextContent('2082');
    expect(screen.getByTestId('interactions-client')).toHaveAttribute('data-total', '191272');
    expect(screen.getByTestId('interactions-client')).toHaveAttribute('data-initial', '1');
    expect(dbSelect).toHaveBeenCalledWith(expect.stringContaining('FROM drug_interactions'));
  });

  it('does not issue any drug-interaction query when no genuine app session exists', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(null);
    render(<InteractionsPage />);
    await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(1));
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('interactions-client')).not.toBeInTheDocument();
  });

  it('refuses to display a false zero when the interaction COUNT read returns no row, and allows retry', async () => {
    (dbGet as jest.Mock).mockResolvedValueOnce(null).mockImplementation(successfulCounts);
    render(<InteractionsPage />);
    expect(await screen.findByText('تعذر تحميل بيانات التفاعلات')).toBeInTheDocument();
    expect(screen.queryByText('إجمالي التفاعلات')).not.toBeInTheDocument();
    expect(dbSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByTestId('interactions-client')).toHaveAttribute('data-total', '191272');
  });

  it('does not show an empty success state when the initial interaction list read is denied', async () => {
    (dbSelect as jest.Mock).mockResolvedValue(null);
    render(<InteractionsPage />);
    expect(await screen.findByText('تعذر تحميل بيانات التفاعلات')).toBeInTheDocument();
    expect(screen.queryByTestId('interactions-client')).not.toBeInTheDocument();
  });
});
