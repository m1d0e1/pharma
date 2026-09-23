import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PharmacySettingsForm from '@/components/settings/PharmacySettingsForm';
import SyncSettings from '@/components/settings/SyncSettings';
import { updatePharmacyClient } from '@/lib/settings/client';
import { syncFromCloud } from '@/lib/sync/universal';
import { toast } from 'react-hot-toast';

const refresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

jest.mock('@/lib/settings/client', () => ({
  updatePharmacyClient: jest.fn(),
}));

jest.mock('@/lib/sync/universal', () => ({
  syncFromCloud: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

describe('settings form and reference-sync UI interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('submits edited pharmacy fields and exposes the saving state until persistence finishes', async () => {
    let resolveUpdate: (value: { success: boolean }) => void = () => {};
    (updatePharmacyClient as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveUpdate = resolve;
    }));

    render(<PharmacySettingsForm pharmacy={{ name: 'Old Pharmacy', name_en: 'Old EN', phone: '111' }} />);

    fireEvent.change(screen.getByDisplayValue('Old Pharmacy'), { target: { value: 'New Pharmacy' } });
    fireEvent.change(screen.getByDisplayValue('111'), { target: { value: '222' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ البيانات/i }));

    await waitFor(() => expect(updatePharmacyClient).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Pharmacy',
      name_en: 'Old EN',
      phone: '222',
    })));
    const saving = screen.getByRole('button', { name: 'جاري الحفظ...' });
    expect(saving).toBeDisabled();

    resolveUpdate({ success: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تم تحديث بيانات الصيدلية بنجاح'));
    expect(screen.getByRole('button', { name: /حفظ البيانات/i })).toBeEnabled();
  });

  it('surfaces a returned pharmacy persistence error', async () => {
    (updatePharmacyClient as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر حفظ بيانات الصيدلية' });
    render(<PharmacySettingsForm pharmacy={{ name: 'Test Pharmacy' }} />);

    fireEvent.click(screen.getByRole('button', { name: /حفظ البيانات/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر حفظ بيانات الصيدلية'));
    expect(screen.getByRole('button', { name: /حفظ البيانات/i })).toBeEnabled();
  });

  it('restores pharmacy-save controls and preserves edits when persistence throws', async () => {
    (updatePharmacyClient as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<PharmacySettingsForm pharmacy={{ name: 'Old Pharmacy', phone: '111' }} />);

    fireEvent.change(screen.getByDisplayValue('Old Pharmacy'), { target: { value: 'Edited Pharmacy' } });
    fireEvent.click(screen.getByRole('button', { name: /حفظ البيانات/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل تحديث البيانات'));
    expect(screen.getByRole('button', { name: /حفظ البيانات/i })).toBeEnabled();
    expect(screen.getByDisplayValue('Edited Pharmacy')).toBeInTheDocument();
  });

  it('blocks repeated pharmacy form submission while persistence is pending', async () => {
    let resolveUpdate: (value: { success: boolean; error?: string }) => void = () => {};
    (updatePharmacyClient as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveUpdate = resolve;
    }));
    const { container } = render(
      <PharmacySettingsForm pharmacy={{ name: 'Single Save Pharmacy', phone: '111' }} />
    );

    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(updatePharmacyClient).toHaveBeenCalled());
    expect(updatePharmacyClient).toHaveBeenCalledTimes(1);

    resolveUpdate({ success: false, error: 'تعذر الحفظ مؤقتاً' });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر الحفظ مؤقتاً'));
    expect(screen.getByRole('button', { name: /حفظ البيانات/i })).toBeEnabled();
  });

  it('refreshes after successful reference sync and records a visible last-sync timestamp', async () => {
    let resolveSync: (value: { success: boolean; message?: string }) => void = () => {};
    (syncFromCloud as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveSync = resolve;
    }));
    render(<SyncSettings />);

    expect(screen.getByText('آخر مزامنة: لم يتم المزامنة بعد')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /تحديث البيانات المرجعية الآن/ }));
    expect(screen.getByRole('button', { name: 'جاري التحديث...' })).toBeDisabled();

    resolveSync({ success: true, message: 'تم تحديث المرجع' });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تم تحديث المرجع'));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('آخر مزامنة: لم يتم المزامنة بعد')).not.toBeInTheDocument();
    expect(screen.getByText(/آخر مزامنة:/)).toBeInTheDocument();
  });

  it('surfaces both returned and thrown sync failures without refreshing', async () => {
    (syncFromCloud as jest.Mock).mockResolvedValueOnce({ success: false, error: 'السحابة غير متاحة' });
    const view = render(<SyncSettings />);

    fireEvent.click(screen.getByRole('button', { name: /تحديث البيانات المرجعية الآن/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('السحابة غير متاحة'));
    expect(refresh).not.toHaveBeenCalled();

    view.unmount();
    jest.clearAllMocks();
    (syncFromCloud as jest.Mock).mockRejectedValueOnce(new Error('network'));
    render(<SyncSettings />);
    fireEvent.click(screen.getByRole('button', { name: /تحديث البيانات المرجعية الآن/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء تنفيذ المزامنة'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('blocks two same-tick reference-sync events before the disabled state commits', async () => {
    let resolveSync: (value: { success: boolean; error?: string }) => void = () => {};
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveSync = resolve;
    });
    (syncFromCloud as jest.Mock).mockReturnValue(pending);
    render(<SyncSettings />);

    const button = screen.getByRole('button', { name: /تحديث البيانات المرجعية الآن/ });
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(syncFromCloud).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSync({ success: false, error: 'stop' });
      await pending;
    });
  });

  it('keeps a successful sync acknowledged when the post-sync refresh throws', async () => {
    (syncFromCloud as jest.Mock).mockResolvedValueOnce({ success: true, message: 'تمت المزامنة' });
    refresh.mockImplementationOnce(() => {
      throw new Error('refresh failed');
    });
    render(<SyncSettings />);

    fireEvent.click(screen.getByRole('button', { name: /تحديث البيانات المرجعية الآن/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تمت المزامنة'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText('آخر مزامنة: لم يتم المزامنة بعد')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /تحديث البيانات المرجعية الآن/ })).toBeEnabled();
  });
});
