import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useDialogFocusTrap } from './useDialogFocusTrap';

function Harness() {
  const [open, setOpen] = useState(false);
  const ref = useDialogFocusTrap<HTMLDivElement>(open);

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>فتح</button>
      {open && (
        <div ref={ref} role="dialog" aria-label="اختبار الحصر" tabIndex={-1}>
          <button type="button">الأول</button>
          <button type="button" onClick={() => setOpen(false)}>الأخير</button>
        </div>
      )}
    </div>
  );
}

describe('useDialogFocusTrap', () => {
  it('moves focus inside, wraps Tab in both directions, and restores focus on close', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'فتح' });
    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole('button', { name: 'الأول' });
    const last = screen.getByRole('button', { name: 'الأخير' });
    await waitFor(() => expect(first).toHaveFocus());

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.click(last);
    expect(opener).toHaveFocus();
  });

  it('does not steal focus that already moved inside before deferred autofocus runs', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    const requestFrame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      pendingFrame = callback;
      return 1;
    });
    const cancelFrame = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'فتح' }));

    const last = screen.getByRole('button', { name: 'الأخير' });
    last.focus();
    act(() => {
      pendingFrame?.(0);
    });

    expect(last).toHaveFocus();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });
});
