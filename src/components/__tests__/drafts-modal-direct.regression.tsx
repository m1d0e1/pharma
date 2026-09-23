import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import DraftsModal from '@/components/pos/DraftsModal';
import { useHotkeys } from 'react-hotkeys-hook';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));

const draft = {
  id: 'draft-1',
  patient_name: 'Draft Customer',
  created_at: '2026-09-22T10:00:00Z',
  total_amount: 42,
  payment_method: 'cash',
  items: [{ qty: 2, trade_name_en: 'Draft Drug' }],
};

describe('DraftsModal direct behavior', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stays unmounted while closed and exposes loading and empty states when open', () => {
    const props = { onClose: jest.fn(), onLoadDraft: jest.fn() };
    const { rerender } = render(<DraftsModal isOpen={false} drafts={[]} isLoadingDrafts={false} {...props} />);
    expect(screen.queryByText('📁 المسودات المحفوظة')).not.toBeInTheDocument();

    rerender(<DraftsModal isOpen drafts={[]} isLoadingDrafts {...props} />);
    expect(screen.getByText('جاري تحميل المسودات...')).toBeInTheDocument();

    rerender(<DraftsModal isOpen drafts={[]} isLoadingDrafts={false} {...props} />);
    expect(screen.getByText('لا يوجد مسودات حالياً')).toBeInTheDocument();
  });

  it('delegates draft selection and both explicit and Escape close actions', () => {
    const onClose = jest.fn();
    const onLoadDraft = jest.fn();
    render(<DraftsModal isOpen drafts={[draft]} isLoadingDrafts={false} onClose={onClose} onLoadDraft={onLoadDraft} />);

    fireEvent.click(screen.getByText('Draft Customer').closest('.group') as HTMLElement);
    expect(onLoadDraft).toHaveBeenCalledWith(draft);

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const escCall = (useHotkeys as jest.Mock).mock.calls.find(call => call[0] === 'esc');
    expect(escCall).toBeDefined();
    escCall[1]();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
