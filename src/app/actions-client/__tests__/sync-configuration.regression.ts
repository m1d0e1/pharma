jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbExecute: jest.fn(),
  dbGet: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock('@/utils/supabase/client', () => {
  class SupabaseConfigurationError extends Error {
    constructor() {
      super('missing cloud sync config');
      this.name = 'SupabaseConfigurationError';
    }
  }

  return {
    SupabaseConfigurationError,
    createClient: jest.fn(() => {
      throw new SupabaseConfigurationError();
    }),
  };
});

import { syncFromCloudAction } from '../sync';

describe('cloud sync configuration failure', () => {
  it('returns a specific configuration error before attempting sync work', async () => {
    await expect(syncFromCloudAction()).resolves.toEqual({
      success: false,
      error: 'إعدادات المزامنة السحابية غير مكتملة على هذا الجهاز',
    });
  });
});
