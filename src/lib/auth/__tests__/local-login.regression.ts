const mockDbGet = jest.fn();
const mockDbExecute = jest.fn();

jest.mock('@/lib/db/tauri', () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
}));

jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));

import { loginLocal } from '@/lib/auth/local';

describe('local login audit regression', () => {
  it('records an unknown username without violating the users foreign key', async () => {
    mockDbGet.mockResolvedValue(null);
    mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

    await expect(loginLocal('missing-user', 'secret')).resolves.toEqual({
      success: false,
      error: 'المستخدم غير موجود',
    });
    expect(mockDbExecute).toHaveBeenCalledWith(
      expect.stringContaining('LOGIN_FAILED'),
      [null, expect.stringContaining('missing-user')],
    );
  });
});
