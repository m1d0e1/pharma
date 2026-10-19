import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddPatientModal from '@/components/AddPatientModal';
import { addPatientAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/patients', () => ({ addPatientAction: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

beforeEach(() => jest.clearAllMocks());

function submitSyntheticPatient(onSuccess: jest.Mock, onClose: jest.Mock) {
  (addPatientAction as jest.Mock).mockResolvedValue({ success: true, id: 'synthetic-patient-committed' });
  render(<AddPatientModal
    pharmacyId="synthetic-pharmacy"
    onSuccess={onSuccess}
    onClose={onClose}
  />);
  fireEvent.change(screen.getByLabelText('الاسم بالكامل (ع) *'), { target: { value: 'مريض تجريبي جديد' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));
}

describe('patient creation: callback failures after confirmed persistence', () => {
  it('still closes after a confirmed save when the parent patient-list refresh callback throws', async () => {
    const onSuccess = jest.fn(() => { throw new Error('synthetic refresh callback failed'); });
    const onClose = jest.fn();
    submitSyntheticPatient(onSuccess, onClose);

    await waitFor(() => expect(addPatientAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'synthetic-patient-committed' }));
    expect(toast.success).toHaveBeenCalledWith('تمت إضافة العميل بنجاح');
    expect(toast.error).toHaveBeenCalledWith('تم حفظ العميل لكن تعذر تحديث القائمة');
    expect(toast.error).not.toHaveBeenCalledWith('حدث خطأ أثناء إضافة العميل');
  });

  it('does not replay a successful patient create when the parent modal-close callback throws', async () => {
    const onSuccess = jest.fn();
    const onClose = jest.fn(() => { throw new Error('synthetic parent close failed'); });
    submitSyntheticPatient(onSuccess, onClose);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('تمت إضافة العميل بنجاح');
    expect(toast.error).toHaveBeenCalledWith('تم حفظ العميل لكن تعذر إغلاق النافذة');
    expect(toast.error).not.toHaveBeenCalledWith('حدث خطأ أثناء إضافة العميل');
    expect(screen.getByRole('button', { name: 'حفظ العميل' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العميل' }));

    expect(addPatientAction).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
