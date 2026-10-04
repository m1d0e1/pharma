const createSupabaseClient = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createSupabaseClient(...args),
}));

import { createClient, SupabaseConfigurationError } from '../client';

describe('Supabase client configuration', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    createSupabaseClient.mockReset();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalAnonKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalAnonKey;
  });

  it('fails before constructing a client when cloud sync configuration is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => createClient()).toThrow(SupabaseConfigurationError);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it('constructs the client only from explicit non-empty configuration', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ' https://example.supabase.co ';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ' anon-key ';
    const sentinel = {};
    createSupabaseClient.mockReturnValue(sentinel);

    expect(createClient()).toBe(sentinel);
    expect(createSupabaseClient).toHaveBeenCalledWith('https://example.supabase.co', 'anon-key');
  });
});
