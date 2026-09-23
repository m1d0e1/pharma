import { act, fireEvent, render, screen } from '@testing-library/react';
import AccessDenied from '@/components/AccessDenied';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));

describe('AccessDenied navigation behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    push.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('redirects to the configured safe destination after the countdown', () => {
    render(<AccessDenied actionHref="/safe-destination" actionText="عودة آمنة" />);

    expect(screen.getByRole('link', { name: /عودة آمنة/ })).toHaveAttribute('href', '/safe-destination');
    act(() => jest.advanceTimersByTime(3000));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/safe-destination');
  });

  it('cancels its delayed redirect when the denied surface unmounts', () => {
    const { unmount } = render(<AccessDenied actionHref="/safe-destination" />);
    unmount();

    act(() => jest.advanceTimersByTime(3000));

    expect(push).not.toHaveBeenCalled();
  });

  it('keeps the explicit back action delegated to browser history', () => {
    const backSpy = jest.spyOn(window.history, 'back').mockImplementation(() => undefined);
    render(<AccessDenied actionHref="/safe-destination" />);

    fireEvent.click(screen.getByRole('button', { name: 'الرجوع للخلف' }));

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
