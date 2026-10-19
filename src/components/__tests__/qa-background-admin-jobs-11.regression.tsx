import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobsManagementClient from '@/components/admin/JobsManagementClient';
import toast from 'react-hot-toast';

jest.mock('react-hot-toast', () => ({
  __esModule: true, default: { success: jest.fn(), error: jest.fn() },
}));

const fixture = { id: 17, name_ar: 'صيدلي أول', name_en: 'Senior Pharmacist', min_salary: 8000, max_salary: 16000 };
const fill = (name: string, low: string, high: string) => {
  fireEvent.change(screen.getByLabelText('المسمى (بالعربي)'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('أقل مرتب'), { target: { value: low } });
  fireEvent.change(screen.getByLabelText('أعلى مرتب'), { target: { value: high } });
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'حفظ الوظيفة' }));

describe('QA background administration job master source and salary controls (mocked writers)', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

  it('rejects whitespace-only Arabic name without creating a new privileged job', async () => {
    const onAddJob = jest.fn().mockResolvedValue({ success: true });
    render(<JobsManagementClient initialJobs={[]} onAddJob={onAddJob} onDeleteJob={jest.fn()} />);
    fill('   ', '2000', '4000');
    submit();
    expect(onAddJob).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال المسمى الوظيفي بالعربي');
  });

  it('refuses an invalid numeric ceiling without a writer call, then permits a valid salary range', async () => {
    const onAddJob = jest.fn().mockResolvedValue({ success: true });
    render(<JobsManagementClient initialJobs={[]} onAddJob={onAddJob} onDeleteJob={jest.fn()} />);
    fill('مدير مالية', '2000', '1e309');
    submit();
    expect(onAddJob).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('الحد الأقصى للراتب يجب ألا يقل عن الحد الأدنى');
    fill('مدير مالية', '2500', '3000');
    submit();
    await waitFor(() => expect(onAddJob).toHaveBeenCalledWith({
      name_ar: 'مدير مالية', name_en: '', min_salary: 2500, max_salary: 3000,
    }));
    expect(onAddJob).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('المسمى (بالعربي)')).toHaveValue('');
  });

  it('cancels a destructive job deletion, preserves refused deletion, then retries only the requested job ID', async () => {
    const onDeleteJob = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'Dependent staff prevents removal' })
      .mockResolvedValueOnce({ success: true });
    const confirm = jest.spyOn(window, 'confirm')
      .mockReturnValueOnce(false).mockReturnValue(true);
    const next = { id: 18, name_ar: 'محاسب', name_en: 'Accountant', min_salary: 3500, max_salary: 9000 };
    const props = { initialJobs: [fixture, next], onAddJob: jest.fn(), onDeleteJob };
    const { rerender } = render(<JobsManagementClient {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'حذف وظيفة صيدلي أول' }));
    expect(onDeleteJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'حذف وظيفة صيدلي أول' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dependent staff prevents removal'));
    expect(screen.getByText('صيدلي أول')).toBeInTheDocument();
    expect(onDeleteJob).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'حذف وظيفة صيدلي أول' }));
    await waitFor(() => expect(onDeleteJob).toHaveBeenCalledTimes(2));
    expect(onDeleteJob.mock.calls).toEqual([[fixture.id], [fixture.id]]);
    rerender(<JobsManagementClient {...props} initialJobs={[next]} />);
    await waitFor(() => expect(screen.queryByText('صيدلي أول')).not.toBeInTheDocument());
    expect(screen.getByText('محاسب')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(3);
  });
});
