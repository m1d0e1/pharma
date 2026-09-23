import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewsBar from '@/components/dashboard/NewsBar';

describe('dashboard NewsBar', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fetches news once per mount and persists an explicit dismiss', async () => {
    const item = { id: 'news-1', text: 'تحديث مرجعي جديد', type: 'general' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [item],
    } as Response);

    render(<NewsBar />);

    expect(await screen.findByText('تحديث مرجعي جديد')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إخفاء' }));
    expect(screen.queryByText('تحديث مرجعي جديد')).not.toBeInTheDocument();
    expect(localStorage.getItem('news_dismissed_id')).toBe('news-1');
    expect(localStorage.getItem('news_bar_enabled')).toBe('false');
  });
});
