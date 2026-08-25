import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LabelDesigner from '@/components/settings/LabelDesigner';
import { getLabelTemplatesAction, saveLabelTemplateAction } from '@/app/actions-client/labels';

jest.mock('@/app/actions-client/labels', () => ({
  getLabelTemplatesAction: jest.fn(),
  saveLabelTemplateAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

it('loads and saves label settings while marking visual-only tools unavailable', async () => {
  (getLabelTemplatesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (saveLabelTemplateAction as jest.Mock).mockResolvedValue({ success: true });
  const user = userEvent.setup();

  render(<LabelDesigner />);

  await screen.findByRole('heading', { name: 'مصمم الملصقات الذكي' });
  for (const name of ['إضافة قالب جديد', 'إضافة نص', 'إضافة باركود', 'إضافة إطار', 'حذف القالب']) {
    expect(screen.getByRole('button', { name: new RegExp(name) })).toBeDisabled();
  }

  const nameInput = screen.getByRole('textbox');
  await user.clear(nameInput);
  await user.type(nameInput, 'Receipt label');
  await user.click(screen.getByRole('button', { name: 'حفظ القالب' }));

  expect(saveLabelTemplateAction).toHaveBeenCalledWith(expect.objectContaining({ name: 'Receipt label' }));
});
