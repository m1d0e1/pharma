import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerStatementContent } from '@/components/finance/FinancialComponents';
import { getPatientStatementAction } from '@/app/actions-client/patients';

jest.mock('@/app/actions-client/patients', () => ({
  getPatientStatementAction: jest.fn(),
  getPatientsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/purchases', () => ({ getSuppliersAction: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({ addFinancialNoticeAction: jest.fn() }));

const statement = (id: string, name: string, currentBalance = 0) => ({
  patient: { id, full_name: name, opening_balance: 0 },
  movements: [],
  currentBalance,
});

describe('CustomerStatementContent active profile subclient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the newest patient statement when an older patient request resolves later', async () => {
    let resolveOlder: (value: any) => void = () => {};
    let resolveNewer: (value: any) => void = () => {};
    (getPatientStatementAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNewer = resolve; }));

    const view = render(<CustomerStatementContent patientId="patient-old" />);
    await waitFor(() => expect(getPatientStatementAction).toHaveBeenCalledWith('patient-old'));

    view.rerender(<CustomerStatementContent patientId="patient-new" />);
    await waitFor(() => expect(getPatientStatementAction).toHaveBeenCalledWith('patient-new'));

    await act(async () => {
      resolveNewer({ success: true, data: statement('patient-new', 'Newest Patient', 222) });
    });
    expect(await screen.findByText((_, element) => element?.textContent?.trim() === '222 ج.م')).toBeInTheDocument();

    await act(async () => {
      resolveOlder({ success: true, data: statement('patient-old', 'Stale Patient', 111) });
    });

    expect(screen.getByText((_, element) => element?.textContent?.trim() === '222 ج.م')).toBeInTheDocument();
    expect(screen.queryByText((_, element) => element?.textContent?.trim() === '111 ج.م')).not.toBeInTheDocument();
  });

  it('turns a thrown statement load into a retryable error instead of a permanent spinner', async () => {
    (getPatientStatementAction as jest.Mock)
      .mockRejectedValueOnce(new Error('statement bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: statement('patient-1', 'Recovered Patient', 333) });

    render(<CustomerStatementContent patientId="patient-1" />);

    expect(await screen.findByText('فشل تحميل البيانات')).toBeInTheDocument();
    expect(screen.queryByText('جاري تحميل كشف الحساب...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText((_, element) => element?.textContent?.trim() === '333 ج.م')).toBeInTheDocument();
  });

  it('labels running and filtered balances as visible-movement balances when chain-wide debt includes hidden branch activity', async () => {
    (getPatientStatementAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: {
        patient: { id: 'patient-1', full_name: 'Chain Patient', opening_balance: 100 },
        movements: [
          { doc_no: 'visible-1', type: 'فاتورة بيع', date: '2026-09-01', balance_effect: 55, value: 55 },
        ],
        currentBalance: 226,
      },
    });

    render(<CustomerStatementContent patientId="patient-1" />);
    expect(await screen.findByText((_, element) => element?.textContent?.trim() === '226 ج.م')).toBeInTheDocument();
    expect(screen.getByText('الرصيد المتراكم للحركات المعروضة')).toBeInTheDocument();

    const dates = screen.getAllByDisplayValue('');
    fireEvent.change(dates[0], { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'بحث' }));
    expect(screen.getByText('رصيد نهاية الفترة للحركات المعروضة')).toBeInTheDocument();
  });
});
