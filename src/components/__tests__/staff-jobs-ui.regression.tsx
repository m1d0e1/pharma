import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import JobsManagementClient from '@/components/admin/JobsManagementClient';
import toast from 'react-hot-toast';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

it('validates salary ranges, adds a valid job, and confirms deletion', async () => {
  const onAddJob = jest.fn().mockResolvedValue({ success: true });
  const onDeleteJob = jest.fn().mockResolvedValue({ success: true });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();

  render(
    <JobsManagementClient
      initialJobs={[{ id: 7, name_ar: 'صيدلي', name_en: 'Pharmacist', min_salary: 5000, max_salary: 9000 }]}
      onAddJob={onAddJob}
      onDeleteJob={onDeleteJob}
    />,
  );

  await user.type(screen.getByPlaceholderText('مثال: صيدلي، محاسب...'), 'محاسب');
  await user.type(screen.getByPlaceholderText('Example: Pharmacist'), 'Accountant');
  const [minimum, maximum] = screen.getAllByRole('spinbutton');
  await user.clear(minimum);
  await user.type(minimum, '8000');
  await user.clear(maximum);
  await user.type(maximum, '7000');
  await user.click(screen.getByRole('button', { name: 'حفظ الوظيفة' }));

  expect(onAddJob).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith('الحد الأقصى للراتب يجب ألا يقل عن الحد الأدنى');

  await user.clear(maximum);
  await user.type(maximum, '10000');
  await user.click(screen.getByRole('button', { name: 'حفظ الوظيفة' }));
  await waitFor(() => expect(onAddJob).toHaveBeenCalledWith({
    name_ar: 'محاسب', name_en: 'Accountant', min_salary: 8000, max_salary: 10000,
  }));

  await user.click(screen.getByRole('button', { name: 'حذف وظيفة صيدلي' }));
  await waitFor(() => expect(onDeleteJob).toHaveBeenCalledWith(7));
});

it('restores the job form after a thrown add and preserves entered values', async () => {
  const onAddJob = jest.fn().mockRejectedValueOnce(new Error('bridge unavailable'));
  const onDeleteJob = jest.fn().mockResolvedValue({ success: true });
  const user = userEvent.setup();

  render(
    <JobsManagementClient
      initialJobs={[]}
      onAddJob={onAddJob}
      onDeleteJob={onDeleteJob}
    />,
  );

  await user.type(screen.getByPlaceholderText('مثال: صيدلي، محاسب...'), 'مساعد');
  await user.click(screen.getByRole('button', { name: 'حفظ الوظيفة' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل إضافة الوظيفة'));
  expect(screen.getByRole('button', { name: 'حفظ الوظيفة' })).toBeEnabled();
  expect(screen.getByDisplayValue('مساعد')).toBeInTheDocument();
});

it('blocks duplicate job submissions while the add action is still pending', async () => {
  let resolveAdd: (value: { success: boolean }) => void = () => {};
  const onAddJob = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => {
    resolveAdd = resolve;
  }));
  const onDeleteJob = jest.fn().mockResolvedValue({ success: true });

  render(
    <JobsManagementClient
      initialJobs={[]}
      onAddJob={onAddJob}
      onDeleteJob={onDeleteJob}
    />,
  );

  fireEvent.change(screen.getByPlaceholderText('مثال: صيدلي، محاسب...'), { target: { value: 'مساعد' } });
  const save = screen.getByRole('button', { name: 'حفظ الوظيفة' });
  fireEvent.click(save);
  fireEvent.click(save);

  expect(onAddJob).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'جاري الحفظ...' })).toBeDisabled();

  resolveAdd({ success: false });
  await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ الوظيفة' })).toBeEnabled());
});

it('surfaces a thrown job delete without removing the visible job', async () => {
  const onAddJob = jest.fn().mockResolvedValue({ success: true });
  const onDeleteJob = jest.fn().mockRejectedValueOnce(new Error('delete bridge unavailable'));
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  render(
    <JobsManagementClient
      initialJobs={[{ id: 7, name_ar: 'صيدلي', name_en: 'Pharmacist', min_salary: 5000, max_salary: 9000 }]}
      onAddJob={onAddJob}
      onDeleteJob={onDeleteJob}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'حذف وظيفة صيدلي' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل حذف الوظيفة'));
  expect(screen.getByText('صيدلي')).toBeInTheDocument();
});

it('blocks duplicate job deletes while the delete action is pending', async () => {
  let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
  const onAddJob = jest.fn().mockResolvedValue({ success: true });
  const onDeleteJob = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => {
    resolveDelete = resolve;
  }));
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  render(
    <JobsManagementClient
      initialJobs={[{ id: 7, name_ar: 'صيدلي', name_en: 'Pharmacist', min_salary: 5000, max_salary: 9000 }]}
      onAddJob={onAddJob}
      onDeleteJob={onDeleteJob}
    />,
  );

  const deleteButton = screen.getByRole('button', { name: 'حذف وظيفة صيدلي' });
  fireEvent.click(deleteButton);
  fireEvent.click(deleteButton);

  expect(onDeleteJob).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'جاري حذف وظيفة صيدلي' })).toBeDisabled();

  resolveDelete({ success: false, error: 'تعذر الحذف' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'حذف وظيفة صيدلي' })).toBeEnabled());
});
