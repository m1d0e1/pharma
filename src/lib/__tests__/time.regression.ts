import { isBusinessDate, localDate, localMonth, normalizeUtcTimestamp, parseBusinessDate } from '@/lib/time';

describe('transaction time contract', () => {
  it.each([
    [new Date(2026, 8, 1, 0, 30), '2026-09-01'],
    [new Date(2026, 11, 31, 23, 59), '2026-12-31'],
    [new Date(2024, 1, 29, 12), '2024-02-29'],
  ])('uses the system-local calendar date', (date, expected) => {
    expect(localDate(date)).toBe(expected);
    expect(localMonth(date)).toBe(expected.slice(0, 7));
  });

  it.each(['2024-02-29', '2026-09-01'])('accepts real calendar date %s', value => {
    expect(isBusinessDate(value)).toBe(true);
    expect(parseBusinessDate(value).getDate()).toBe(Number(value.slice(-2)));
  });

  it.each(['', 'not-a-date', '2026-02-30', '2025-02-29', '01/02/2026'])('rejects invalid date %s', value => {
    expect(isBusinessDate(value)).toBe(false);
  });

  it('normalizes SQLite UTC values without changing explicit-zone timestamps', () => {
    expect(normalizeUtcTimestamp('2026-09-11 08:06:52')).toBe('2026-09-11T08:06:52Z');
    expect(normalizeUtcTimestamp('2026-09-11T10:06:52+02:00')).toBe('2026-09-11T10:06:52+02:00');
  });
});
