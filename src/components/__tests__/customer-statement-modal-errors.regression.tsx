import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CustomerStatementModal from '@/components/patients/CustomerStatementModal';
import { getPatientStatementAction, getReceiptDetailsAction } from '@/app/actions-client/patients';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientStatementAction: jest.fn(),
  getReceiptDetailsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock('@/components/receipts/ReceiptDetailsModal', () => function MockReceiptDetailsModal({ invoice }: any) {
  return <div>receipt-detail:{invoice?.id}</div>;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const statement = {
  patient: {
    id: 'patient-1',
    full_name: 'عميل كشف الحساب',
    opening_balance: 0,
    notes: '',
  },
  movements: [],
  items: [],
  notices: [],
  currentBalance: 0,
};

describe('customer statement modal load recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('turns a returned statement failure into a retryable error instead of an unrecoverable card', async () => {
    (getPatientStatementAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'statement unavailable' })
      .mockResolvedValueOnce({ success: true, data: statement });

    render(<CustomerStatementModal patientId="patient-1" onClose={jest.fn()} />);

    expect(await screen.findByText('فشل تحميل كشف حساب العميل')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('عميل كشف الحساب')).toBeInTheDocument();
    expect(getPatientStatementAction).toHaveBeenCalledTimes(2);
  });

  it('recovers from a thrown statement load without leaving the spinner stuck', async () => {
    (getPatientStatementAction as jest.Mock)
      .mockRejectedValueOnce(new Error('statement bridge unavailable'))
      .mockResolvedValueOnce({ success: true, data: statement });

    render(<CustomerStatementModal patientId="patient-1" onClose={jest.fn()} />);

    expect(await screen.findByText('فشل تحميل كشف حساب العميل')).toBeInTheDocument();
    expect(screen.queryByText('جاري تحميل كشف حساب العميل...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    await waitFor(() => expect(getPatientStatementAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('عميل كشف الحساب')).toBeInTheDocument();
  });

  it('keeps the newest receipt detail when an older invoice request resolves later', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    const statementWithReceipts = {
      ...statement,
      movements: [
        {
          type: 'فاتورة بيع', doc_no: 'OLDINV01-1234', date: '2026-09-20', balance_effect: 10,
          value: 10, payment_method: 'cash', user_name: 'old-user', notes: 'old invoice',
        },
        {
          type: 'فاتورة بيع', doc_no: 'NEWINV02-5678', date: '2026-09-21', balance_effect: 20,
          value: 20, payment_method: 'cash', user_name: 'new-user', notes: 'new invoice',
        },
      ],
    };
    (getPatientStatementAction as jest.Mock).mockResolvedValueOnce({ success: true, data: statementWithReceipts });
    (getReceiptDetailsAction as jest.Mock)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    render(<CustomerStatementModal patientId="patient-1" onClose={jest.fn()} />);
    await screen.findByText('عميل كشف الحساب');
    fireEvent.click(screen.getByText('#OLDINV01'));
    await waitFor(() => expect(getReceiptDetailsAction).toHaveBeenCalledWith('OLDINV01-1234'));
    fireEvent.click(screen.getByText('#NEWINV02'));
    await waitFor(() => expect(getReceiptDetailsAction).toHaveBeenCalledWith('NEWINV02-5678'));

    newer.resolve({ success: true, data: { id: 'new-receipt' } });
    expect(await screen.findByText('receipt-detail:new-receipt')).toBeInTheDocument();

    await act(async () => {
      older.resolve({ success: true, data: { id: 'old-receipt' } });
      await older.promise;
    });
    expect(screen.queryByText('receipt-detail:old-receipt')).not.toBeInTheDocument();
    expect(screen.getByText('receipt-detail:new-receipt')).toBeInTheDocument();
  });

  it('does not send non-sale statement documents through the sales-receipt detail loader', async () => {
    (getPatientStatementAction as jest.Mock).mockResolvedValueOnce({
      success: true,
      data: {
        ...statement,
        movements: [{
          type: 'توريد نقدية',
          doc_no: 'PAYMENT-1234',
          date: '2026-09-20',
          balance_effect: -10,
          value: -10,
          payment_method: 'cash',
          user_name: 'cashier',
          notes: 'customer payment',
        }],
        items: [{
          invoice_id: 'RETURN-1234',
          date: '2026-09-20',
          trade_name: 'Returned Drug',
          quantity_sold: -1,
          unit: 'large',
          unit_price: 10,
          action: 'مرتجع',
        }],
      },
    });
    (getReceiptDetailsAction as jest.Mock).mockResolvedValue({ success: false, error: 'not a sales invoice' });

    render(<CustomerStatementModal patientId="patient-1" onClose={jest.fn()} />);
    await screen.findByText('عميل كشف الحساب');

    fireEvent.click(screen.getByText('#PAYMENT-'));
    expect(getReceiptDetailsAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'أصناف المبيعات' }));
    fireEvent.click(screen.getByText('Returned Drug'));
    expect(getReceiptDetailsAction).not.toHaveBeenCalled();
  });

  it('clears a selected receipt when the modal ownership changes to another patient', async () => {
    (getPatientStatementAction as jest.Mock)
      .mockResolvedValueOnce({
        success: true,
        data: {
          ...statement,
          movements: [{
            type: 'فاتورة بيع', doc_no: 'PAT1INV-1234', date: '2026-09-20', balance_effect: 10,
            value: 10, payment_method: 'cash', user_name: 'user-1', notes: 'patient one invoice',
          }],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          ...statement,
          patient: { ...statement.patient, id: 'patient-2', full_name: 'عميل جديد' },
          movements: [],
        },
      });
    (getReceiptDetailsAction as jest.Mock).mockResolvedValueOnce({ success: true, data: { id: 'patient-1-receipt' } });

    const view = render(<CustomerStatementModal patientId="patient-1" onClose={jest.fn()} />);
    await screen.findByText('عميل كشف الحساب');
    fireEvent.click(screen.getByText('#PAT1INV-'));
    expect(await screen.findByText('receipt-detail:patient-1-receipt')).toBeInTheDocument();

    view.rerender(<CustomerStatementModal patientId="patient-2" onClose={jest.fn()} />);
    expect(await screen.findByText('عميل جديد')).toBeInTheDocument();
    expect(screen.queryByText('receipt-detail:patient-1-receipt')).not.toBeInTheDocument();
  });
});
