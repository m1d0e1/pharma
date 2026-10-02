import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Modal } from './modal';

describe('Modal accessibility', () => {
  it('exposes dialog semantics, moves focus inside, closes with Escape and restores focus', async () => {
    const onClose = jest.fn();
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(
      <Modal isOpen onClose={onClose} title="تأكيد العملية" description="راجع البيانات قبل المتابعة">
        <button type="button">متابعة</button>
      </Modal>
    );

    const dialog = screen.getByRole('dialog', { name: 'تأكيد العملية' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('راجع البيانات قبل المتابعة');
    const close = screen.getByRole('button', { name: 'إغلاق النافذة' });
    expect(close).toHaveAttribute('type', 'button');
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });
});
