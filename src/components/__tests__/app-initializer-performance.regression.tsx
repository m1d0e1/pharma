import { render, screen } from '@testing-library/react';
import AppInitializer from '@/components/AppInitializer';
import { secureCache } from '@/lib/cache/secure_cache';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(() => new Promise<void>(() => {})),
  },
}));

it('renders a new window without waiting for the master-drug cache', () => {
  render(
    <AppInitializer>
      <div>window content</div>
    </AppInitializer>
  );

  expect(screen.getByText('window content')).toBeInTheDocument();
  expect(secureCache.load).toHaveBeenCalledTimes(1);
});
