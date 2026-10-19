/** @jest-environment node */
import fs from 'fs';
import { backup, restore } from '@/lib/db/client';

describe('legacy database restore protection', () => {
  it('fails closed before opening or changing the active database, regardless of supplied backup path', () => {
    const openSpy = jest.spyOn(fs, 'writeFileSync');
    try {
      for (const source of ['C:/fake/other-pharmacy.db', '../pharma_local.db', '', 'C:/temp/valid.db']) {
        expect(() => restore(source)).toThrow(/restore is disabled/);
      }
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
  it('refuses the arbitrary-path Node backup helper before opening the live database', () => {
    for (const destination of ['C:/other-branch/records.db', '../pharma_local.db', '']) {
      expect(() => backup(destination)).toThrow(/backup is disabled/);
    }
  });
});
