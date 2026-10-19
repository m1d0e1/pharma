const mockSync = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('../client', () => ({ syncFromCloudClient: (...args: unknown[]) => mockSync(...args) }));

import { syncFromCloud } from '../universal';

it('never opens cloud sync outside the desktop application', async () => {
  await expect(syncFromCloud()).resolves.toMatchObject({ success: false });
  expect(mockSync).not.toHaveBeenCalled();
});
