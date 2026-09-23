import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddPatientModal from '@/components/AddPatientModal';
import { addPatientAction } from '@/app/actions-client/patients';
import { useHotkeys } from 'react-hotkeys-hook';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/patients', () => ({ addPatientAction: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

describe('add-patient modal interactions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('validates required name and keeps the form open when the action fails', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    (addPatientAction as jest.Mock).mockResolvedValue({ success: false, error: 'رقم العميل مستخدم بالفعل' });
    render(<AddPatientModal pharmacyId="ph-1" onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole('button', { name: /حفظ العميل/ }));
    expect(addPatientAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال الاسم بالكامل');

    fireEvent.change(screen.getByPlaceholderText('محمد أحمد...'), { target: { value: 'عميل جديد' } });
    fireEvent.change(screen.getByPlaceholderText('01xxxxxxxxx'), { target: { value: '01012345678' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ العميل/ }));

    await waitFor(() => expect(addPatientAction).toHaveBeenCalledWith(expect.objectContaining({
      full_name: 'عميل جديد',
      phone: '01012345678',
      gender: 'male',
      customer_type: 'individual',
      payment_method: 'cash',
    })));
    expect(toast.error).toHaveBeenCalledWith('رقم العميل مستخدم بالفعل');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /إضافة عميل جديد/ })).toBeInTheDocument();
  });

  it('calls success and close after a successful add and registers Escape cancellation', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    (addPatientAction as jest.Mock).mockResolvedValue({ success: true, id: 'patient-new' });
    render(<AddPatientModal pharmacyId="ph-1" onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByPlaceholderText('محمد أحمد...'), { target: { value: 'عميل ناجح' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ العميل/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تمت إضافة العميل بنجاح'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    const escCall = [...(useHotkeys as jest.Mock).mock.calls].reverse().find(call => call[0] === 'esc');
    expect(escCall).toBeDefined();
    escCall?.[1]();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the patient form usable when creation throws', async () => {
    const onClose = jest.fn();
    const onSuccess = jest.fn();
    (addPatientAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<AddPatientModal pharmacyId="ph-1" onClose={onClose} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByPlaceholderText('محمد أحمد...'), { target: { value: 'عميل بعد خطأ' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ العميل/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء إضافة العميل'));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /حفظ العميل/ })).toBeEnabled();
    expect(screen.getByDisplayValue('عميل بعد خطأ')).toBeInTheDocument();
  });

  it('blocks repeated patient creation while the first submission is pending', async () => {
    let resolveAdd: (value: { success: boolean; id?: string; error?: string }) => void = () => {};
    (addPatientAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveAdd = resolve;
    }));
    const { container } = render(
      <AddPatientModal pharmacyId="ph-1" onClose={jest.fn()} onSuccess={jest.fn()} />
    );

    fireEvent.change(screen.getByPlaceholderText('محمد أحمد...'), { target: { value: 'عميل واحد فقط' } });
    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(addPatientAction).toHaveBeenCalled());
    expect(addPatientAction).toHaveBeenCalledTimes(1);

    resolveAdd({ success: false, error: 'تعذر الحفظ' });
    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ العميل/ })).toBeEnabled());
    expect(screen.getByDisplayValue('عميل واحد فقط')).toBeInTheDocument();
  });

  it('keeps every close entry point blocked while patient creation is pending', async () => {
    let resolveAdd: (value: { success: boolean; id?: string }) => void = () => {};
    (addPatientAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
      resolveAdd = resolve;
    }));
    const onClose = jest.fn();
    const onSuccess = jest.fn();

    render(<AddPatientModal pharmacyId="ph-1" onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByPlaceholderText('محمد أحمد...'), { target: { value: 'عميل قيد الحفظ' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ العميل/ }));
    await waitFor(() => expect(addPatientAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /إغلاق/ }));
    const headerClose = screen.getAllByRole('button').find(button => button.querySelector('svg.lucide-x'));
    expect(headerClose).toBeDefined();
    fireEvent.click(headerClose!);
    const escCall = [...(useHotkeys as jest.Mock).mock.calls].reverse().find(call => call[0] === 'esc');
    expect(escCall).toBeDefined();
    escCall?.[1]();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /إضافة عميل جديد/ })).toBeInTheDocument();

    await act(async () => resolveAdd({ success: true, id: 'patient-created' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
