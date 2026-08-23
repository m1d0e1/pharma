import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeDatabaseTimestamps } from '../tauri';

it('stores shift closures as UTC and normalizes them exactly once outside UTC', () => {
  for (const relativePath of [
    'src/app/actions-client/shifts.ts',
    'src/app/actions-client/handover.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
    expect(source).toContain('SET end_time = CURRENT_TIMESTAMP, ending_cash = ?, notes = ?, status = ?');
  }

  const [once] = normalizeDatabaseTimestamps([{
    created_at: '2026-08-22 10:15:30',
    end_time: '2026-08-22 10:15:30',
    date: '2026-08-22 10:15:30',
  }]);
  const [twice] = normalizeDatabaseTimestamps([once]);

  expect(once).toEqual({
    created_at: '2026-08-22T10:15:30Z',
    end_time: '2026-08-22T10:15:30Z',
    date: '2026-08-22 10:15:30',
  });
  expect(twice).toEqual(once);
  expect(new Date(twice.end_time).toISOString()).toBe('2026-08-22T10:15:30.000Z');

  const localHour = execFileSync(process.execPath, [
    '-e',
    `process.stdout.write(String(new Date(${JSON.stringify(twice.end_time)}).getHours()))`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York' },
  });
  expect(localHour).toBe('6');
});
