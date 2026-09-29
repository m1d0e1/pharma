import { getSalesConversionSql } from '@/lib/inventory/reorder-state';

describe('reorder state transaction-safe schema probing', () => {
  it('detects sale conversion snapshots using SELECT-only transaction reads', async () => {
    const seenSql: string[] = [];
    const scopedDb: any = {
      prepare: (sql: string) => ({
        all: async () => {
          seenSql.push(sql.trim());
          if (!/^SELECT\b/i.test(sql.trim())) throw new Error('transaction read guard only accepts SELECT');
          return [];
        },
      }),
    };

    const conversion = await getSalesConversionSql(scopedDb);

    expect(seenSql.length).toBeGreaterThan(0);
    expect(seenSql.every(sql => /^SELECT\b/i.test(sql))).toBe(true);
    expect(conversion.largeFactor).toContain('si.large_to_medium');
    expect(conversion.smallFactor).toContain('si.medium_to_small');
  });
});
