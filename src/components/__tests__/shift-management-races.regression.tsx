import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ShiftManagementClient from '@/components/shifts/ShiftManagementClient';
import {
  forceCloseAllShiftsAction,
  getShiftsAction,
  openShiftAction,
} from '@/app/actions-client/shifts';

jest.mock('@/app/actions-client/shifts', () => ({
  forceCloseAllShiftsAction: jest.fn(),
  getShiftsAction: jest.fn(),
  openShiftAction: jest.fn(),
}));

jest.mock('@/components/shifts/ShiftReceiptsModal', () => ({
  __esModule: true,
  default: () => null,
}));

const closedShift = {
  id: 'closed-shift',
  starting_cash_amount: 500,
  ending_cash_amount: 300,
  expected_cash_amount: 300,
  actual_cash: 300,
  transfer_amount: 0,
  receiver_name: null,
  cash_difference: 0,
  status: 'closed' as const,
  shift_start: '2026-09-20T08:00:00Z',
  shift_end: '2026-09-20T16:00:00Z',
  profiles: { full_name: 'وردية أولية', role: 'pharmacist' },
};

const openShift = {
  ...closedShift,
  id: 'open-shift',
  ending_cash_amount: null,
  status: 'open' as const,
  shift_end: null,
};

function renderClient() {
  return render(
    <ShiftManagementClient
      initialShifts={[closedShift]}
      currentShift={null}
      hasOpenShift={false}
      suggestedStartingCash={300}
      userRole="owner"
    />
  );
}

describe('ShiftManagementClient async race regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.confirm = jest.fn(() => true);
    (getShiftsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it('keeps the latest filter result when an older request resolves afterwards', async () => {
    let resolveClosed: (value: unknown) => void = () => {};
    let resolveOpen: (value: unknown) => void = () => {};
    (getShiftsAction as jest.Mock)
      .mockImplementationOnce(() => new Promise(resolve => { resolveClosed = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveOpen = resolve; }));

    renderClient();
    const statusSelect = screen.getByRole('combobox');

    fireEvent.change(statusSelect, { target: { value: 'closed' } });
    fireEvent.change(statusSelect, { target: { value: 'open' } });
    expect(getShiftsAction).toHaveBeenNthCalledWith(1, { status: 'closed' });
    expect(getShiftsAction).toHaveBeenNthCalledWith(2, { status: 'open' });

    await act(async () => {
      resolveOpen({
        success: true,
        data: [{
          ...openShift,
          id: 'latest-open',
          profiles: { full_name: 'نتيجة مفتوحة حديثة', role: 'pharmacist' },
        }],
      });
    });
    expect(screen.getByText(/نتيجة مفتوحة حديثة/)).toBeInTheDocument();

    await act(async () => {
      resolveClosed({
        success: true,
        data: [{
          ...closedShift,
          id: 'stale-closed',
          profiles: { full_name: 'نتيجة مغلقة قديمة', role: 'pharmacist' },
        }],
      });
    });

    expect(statusSelect).toHaveValue('open');
    expect(screen.getByText(/نتيجة مفتوحة حديثة/)).toBeInTheDocument();
    expect(screen.queryByText('نتيجة مغلقة قديمة')).not.toBeInTheDocument();
  });

  it('blocks repeated open-shift events while the first persistence call is pending', async () => {
    let resolveOpen: (value: unknown) => void = () => {};
    (openShiftAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveOpen = resolve;
    }));

    renderClient();
    const openButton = screen.getByRole('button', { name: 'فتح شفت جديد' });

    act(() => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(openShiftAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOpen({ success: false, error: 'تعذر فتح الوردية' });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'فتح شفت جديد' })).toBeEnabled());
  });

  it('blocks repeated force-close events while the first persistence call is pending', async () => {
    let resolveForceClose: (value: unknown) => void = () => {};
    (forceCloseAllShiftsAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveForceClose = resolve;
    }));

    renderClient();
    const forceCloseButton = screen.getByRole('button', { name: 'إغلاق جميع الشفتات اضطرارياً' });

    act(() => {
      forceCloseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      forceCloseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(forceCloseAllShiftsAction).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveForceClose({ success: false, error: 'تعذر الإغلاق الاضطراري' });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'إغلاق جميع الشفتات اضطرارياً' })).toBeEnabled());
  });

  it('does not misreport a completed open-shift write as failed when the follow-up list refresh rejects', async () => {
    (openShiftAction as jest.Mock).mockResolvedValueOnce({ success: true });
    (getShiftsAction as jest.Mock).mockRejectedValueOnce(new Error('shift list unavailable'));

    renderClient();
    fireEvent.click(screen.getByRole('button', { name: 'فتح شفت جديد' }));

    expect(await screen.findByText(/تم فتح الشفت بنجاح/)).toBeInTheDocument();
    expect(screen.getByText(/تم فتح الشفت لكن تعذر تحديث قائمة الورديات/)).toBeInTheDocument();
    expect(screen.queryByText(/حدث خطأ غير متوقع/)).not.toBeInTheDocument();
    expect(openShiftAction).toHaveBeenCalledTimes(1);
  });

  it('does not misreport completed force-close writes as failed when the follow-up list refresh rejects', async () => {
    (forceCloseAllShiftsAction as jest.Mock).mockResolvedValueOnce({ success: true });
    (getShiftsAction as jest.Mock).mockRejectedValueOnce(new Error('shift list unavailable'));

    renderClient();
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق جميع الشفتات اضطرارياً' }));

    expect(await screen.findByText(/تم إغلاق جميع الشفتات المفتوحة بنجاح/)).toBeInTheDocument();
    expect(screen.getByText(/تم الإغلاق لكن تعذر تحديث قائمة الورديات/)).toBeInTheDocument();
    expect(screen.queryByText(/حدث خطأ غير متوقع/)).not.toBeInTheDocument();
    expect(forceCloseAllShiftsAction).toHaveBeenCalledTimes(1);
  });

  it('cancels the delayed page reload when the screen unmounts after opening a shift', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    try {
      (openShiftAction as jest.Mock).mockResolvedValueOnce({ success: true });
      (getShiftsAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [] });
      const view = renderClient();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'فتح شفت جديد' }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(openShiftAction).toHaveBeenCalledTimes(1);
      const reloadCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
      expect(reloadCall).toBeGreaterThanOrEqual(0);
      const reloadHandle = setTimeoutSpy.mock.results[reloadCall].value;
      view.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(reloadHandle);
    } finally {
      jest.clearAllTimers();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('cancels the delayed page reload when the screen unmounts after force-closing shifts', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    try {
      (forceCloseAllShiftsAction as jest.Mock).mockResolvedValueOnce({ success: true });
      (getShiftsAction as jest.Mock).mockResolvedValueOnce({ success: true, data: [] });
      const view = renderClient();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'إغلاق جميع الشفتات اضطرارياً' }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(forceCloseAllShiftsAction).toHaveBeenCalledTimes(1);
      const reloadCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
      expect(reloadCall).toBeGreaterThanOrEqual(0);
      const reloadHandle = setTimeoutSpy.mock.results[reloadCall].value;
      view.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(reloadHandle);
    } finally {
      jest.clearAllTimers();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
