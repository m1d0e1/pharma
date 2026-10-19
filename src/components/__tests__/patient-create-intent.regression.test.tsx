import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddPatientModal from '@/components/AddPatientModal';
import { addPatientAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/patients', () => ({ addPatientAction: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

describe('patient creation nonce and uncertain IPC retries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retries an unchanged intent with the original nonce and creates a new nonce after editing patient data', async () => {
    (addPatientAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Ambiguous transport' })
      .mockResolvedValueOnce({ success: false, error: 'Ambiguous transport' })
      .mockResolvedValueOnce({ success: true, id: 'new-owned-id' });
    const onSuccess = jest.fn();
    render(<AddPatientModal pharmacyId="tenant-a" onClose={jest.fn()} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('الاسم بالكامل (ع) *'), {
      target: { value: 'Owned Patient Name' },
    });
    const save = screen.getByRole('button', { name: 'حفظ العميل' });
    fireEvent.click(save);
    await waitFor(() => expect(addPatientAction).toHaveBeenCalledTimes(1));
    const first = (addPatientAction as jest.Mock).mock.calls[0][0];
    expect(first.request_id).toMatch(/^[a-f0-9-]{36}$/i);
    expect(toast.error).toHaveBeenCalledWith('Ambiguous transport');

    fireEvent.click(save);
    await waitFor(() => expect(addPatientAction).toHaveBeenCalledTimes(2));
    const retried = (addPatientAction as jest.Mock).mock.calls[1][0];
    expect(retried.request_id).toBe(first.request_id);
    expect(retried.full_name).toBe(first.full_name);

    fireEvent.change(screen.getByLabelText('رقم الهاتف (اختياري)'), {
      target: { value: '01012345678' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(addPatientAction).toHaveBeenCalledTimes(3));
    expect((addPatientAction as jest.Mock).mock.calls[2][0].request_id).not.toBe(first.request_id);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    fireEvent.click(save);
    expect(addPatientAction).toHaveBeenCalledTimes(3);
  });
});
