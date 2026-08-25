import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
