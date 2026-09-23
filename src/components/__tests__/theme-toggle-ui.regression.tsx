import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ThemeToggle from '@/components/ThemeToggle';

describe('ThemeToggle active layout control', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('restores a saved dark theme and toggles back to light', async () => {
    localStorage.setItem('theme', 'dark');
    render(<ThemeToggle />);

    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    const button = screen.getByTitle('التبديل للوضع النهاري');
    fireEvent.click(button);

    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByTitle('التبديل للوضع الليلي')).toBeInTheDocument();
  });

  it('defaults to light and persists a user switch to dark', async () => {
    render(<ThemeToggle />);
    await waitFor(() => expect(screen.getByTitle('التبديل للوضع الليلي')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('التبديل للوضع الليلي'));

    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(screen.getByTitle('التبديل للوضع النهاري')).toBeInTheDocument();
  });
});
