import { fireEvent, render, screen } from '@testing-library/react';
import CogsAdjustmentClient from '@/components/sales/CogsAdjustmentClient';
import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/app/actions-client/cogs', () => ({
  getSoldItemsForCogsAdjustmentAction: jest.fn(),
  updateSoldItemCostAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

it('shows persistent unavailable provenance status instead of no-results or usable COGS controls', () => {
  render(<CogsAdjustmentClient />);
  expect(screen.getByRole('alert')).toHaveTextContent(/قيود|موثق|أصلية/);
  expect(screen.getByRole('alert')).toHaveTextContent(/قيد مستقل/);
  expect(screen.getByRole('alert')).toHaveTextContent(/لا يجوز إعادة كتابة تكلفة سطر بيع أو مرتجع/);
  const search = screen.getByRole('textbox', { name: 'بحث باسم الصنف أو رقم الفاتورة' });
  const submit = screen.getByRole('button', { name: 'بحث' });
  expect(search).toBeDisabled();
  expect(submit).toBeDisabled();
  fireEvent.click(submit);
  expect(getSoldItemsForCogsAdjustmentAction).not.toHaveBeenCalled();
  expect(updateSoldItemCostAction).not.toHaveBeenCalled();
  expect(screen.queryByText('لم يتم العثور على نتائج للبحث...')).not.toBeInTheDocument();
});
