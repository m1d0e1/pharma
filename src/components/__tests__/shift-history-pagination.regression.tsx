import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import { getShiftsAction } from '@/app/actions-client/shifts';

jest.mock('@/app/actions-client/shifts', () => ({
  getShiftsAction: jest.fn(),
  openShiftAction: jest.fn(),
  forceCloseAllShiftsAction: jest.fn(),
}));

jest.mock('@/components/shifts/ShiftReceiptsModal', () => ({
  __esModule: true,
  default: () => null,
}));

const row = (id: number, status: 'open' | 'closed' = 'closed') => ({
  id: `history-${id}`,
  status,
  shift_start: '2026-10-01T08:00:00Z',
  shift_end: status === 'open' ? null : '2026-10-01T16:00:00Z',
  starting_cash_amount: 100,
  ending_cash_amount: status === 'open' ? null : 100,
  expected_cash_amount: null,
  cash_difference: null,
  profiles: { full_name: `موظف ${id}`, role: 'pharmacist' },
});
const firstHundred = Array.from({ length: 100 }, (_, index) => row(index));

function view(initialShifts = firstHundred) {
  return render(
    <ShiftManagementClient
      initialShifts={initialShifts}
      currentShift={null}
      hasOpenShift={false}
      userRole="pharmacist"
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (getShiftsAction as jest.Mock).mockResolvedValue({ success: true, data: [], has_more: false, next_page: null });
});

it('makes older shifts reachable from the initial 100 rows without duplicate records', async () => {
  (getShiftsAction as jest.Mock).mockResolvedValueOnce({
    success: true,
    data: [row(100), row(0)],
    has_more: true,
    next_page: 2,
  }).mockResolvedValueOnce({
    success: true,
    data: [row(101)],
    has_more: false,
    next_page: null,
  });

  view();
  expect(screen.getByText('موظف 99')).toBeInTheDocument();
  expect(screen.queryByText('موظف 100')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' }));
  expect(getShiftsAction).toHaveBeenNthCalledWith(1, { status: 'all', page: 1 });
  expect(await screen.findByText('موظف 100')).toBeInTheDocument();
  expect(screen.getAllByText('موظف 0')).toHaveLength(1);
  expect(screen.getByText(/المعروض من سجل الورديات: 101/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' }));
  expect(getShiftsAction).toHaveBeenNthCalledWith(2, { status: 'all', page: 2 });
  expect(await screen.findByText('موظف 101')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'تحميل المزيد من سجل الورديات' })).not.toBeInTheDocument();
  expect(screen.getByText(/المعروض من سجل الورديات: 102/)).toBeInTheDocument();
});

it('keeps page failures and native permission denials visible while allowing a safe retry', async () => {
  (getShiftsAction as jest.Mock).mockResolvedValueOnce({
    success: false, error: 'غير مصرح بعرض المزيد من الورديات',
  }).mockResolvedValueOnce({
    success: true, data: [row(100)], has_more: false, next_page: null,
  });

  view();
  fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('غير مصرح بعرض المزيد من الورديات');
  expect(screen.getByText('موظف 99')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' }));
  expect(await screen.findByText('موظف 100')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(getShiftsAction).toHaveBeenNthCalledWith(2, { status: 'all', page: 1 });
});

it('discards an in-flight old-status page when the user changes filters', async () => {
  let finishPage: (result: unknown) => void = () => {};
  (getShiftsAction as jest.Mock).mockImplementationOnce(
    () => new Promise(resolve => { finishPage = resolve; }),
  ).mockResolvedValueOnce({
    success: true,
    data: [row(200, 'open')],
    has_more: false,
    next_page: null,
  });

  view();
  const loadButton = screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' });
  fireEvent.click(loadButton);
  expect(loadButton).toBeDisabled();
  // Double taps during a pending request cannot load the same page twice.
  fireEvent.click(loadButton);
  expect(getShiftsAction).toHaveBeenCalledTimes(1);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'open' } });
  expect(getShiftsAction).toHaveBeenNthCalledWith(2, { status: 'open' });
  expect(await screen.findByText('افتتحها: موظف 200')).toBeInTheDocument();
  await act(async () => {
    finishPage({ success: true, data: [row(100)], has_more: true, next_page: 2 });
  });
  expect(screen.queryByText('موظف 100')).not.toBeInTheDocument();
  expect(screen.queryByText('موظف 99')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'تحميل المزيد من سجل الورديات' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('open');
});

it('resets to page one on status changes and ignores parent all-history refreshes while filtered', async () => {
  (getShiftsAction as jest.Mock).mockResolvedValueOnce({
    success: true,
    data: Array.from({ length: 100 }, (_, index) => row(200 + index)),
    has_more: true,
    next_page: 1,
  }).mockResolvedValueOnce({
    success: true,
    data: [row(300)],
    has_more: false,
    next_page: null,
  });
  const client = view();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'closed' } });
  expect(await screen.findByText('موظف 299')).toBeInTheDocument();

  client.rerender(
    <ShiftManagementClient
      initialShifts={[row(990)]}
      currentShift={null}
      hasOpenShift={false}
      userRole="pharmacist"
    />,
  );
  expect(screen.getByText('موظف 299')).toBeInTheDocument();
  expect(screen.queryByText('موظف 990')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' }));
  expect(getShiftsAction).toHaveBeenNthCalledWith(2, { status: 'closed', page: 1 });
  expect(await screen.findByText('موظف 300')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'تحميل المزيد من سجل الورديات' })).not.toBeInTheDocument();
});

it('makes the native history page budget explicit and avoids requesting an unsupported page', async () => {
  (getShiftsAction as jest.Mock).mockResolvedValueOnce({
    success: true,
    data: [row(100)],
    has_more: true,
    next_page: 501,
  });
  view();
  fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد من سجل الورديات' }));
  expect(await screen.findByText('موظف 100')).toBeInTheDocument();
  expect(screen.getByText(/وصلت إلى الحد الأعلى لصفحات سجل الورديات/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'تحميل المزيد من سجل الورديات' })).not.toBeInTheDocument();
  expect(getShiftsAction).toHaveBeenCalledTimes(1);
});
