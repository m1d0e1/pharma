import { largeQuantityInUnit, unitQuantityInLarge } from '@/lib/inventory/unit-quantity';

// Mirror the unit-alias contract in src-tauri/src/commands/inventory_units.rs.
describe('inventory unit quantities match the native Rust contract', () => {
  it.each([
    { unit: 'large', unitsPerLarge: 1 },
    { unit: 'box', unitsPerLarge: 1 },
    { unit: 'unknown', unitsPerLarge: 1 },
    { unit: undefined, unitsPerLarge: 1 },
    { unit: 'medium', unitsPerLarge: 12 },
    { unit: ' STRIP ', unitsPerLarge: 12 },
    { unit: 'شريط', unitsPerLarge: 12 },
    { unit: '  شريط  ', unitsPerLarge: 12 },
    { unit: 'small', unitsPerLarge: 120 },
    { unit: ' UnIt ', unitsPerLarge: 120 },
    { unit: 'pill', unitsPerLarge: 120 },
  ])('converts native built-in alias $unit', ({ unit, unitsPerLarge }) => {
    expect(unitQuantityInLarge(unitsPerLarge, unit, 12, 10)).toBeCloseTo(1, 12);
    expect(largeQuantityInUnit(1, unit, 12, 10)).toBeCloseTo(unitsPerLarge, 12);
  });

  it('matches trimmed configured names case-insensitively for ASCII only', () => {
    expect(unitQuantityInLarge(12, '  BLISTER  ', 12, 10, ' blister ', 'Tablet')).toBe(1);
    expect(unitQuantityInLarge(120, '  tAbLeT ', 12, 10, 'Blister', '  Tablet  ')).toBe(1);
    expect(largeQuantityInUnit(1, 'tablet', 12, 10, 'Blister', 'TABLET')).toBe(120);

    // Rust's eq_ignore_ascii_case does not equate distinct Unicode letter cases.
    expect(unitQuantityInLarge(120, 'ärzt', 12, 10, undefined, 'Ärzt')).toBe(120);
    expect(unitQuantityInLarge(120, 'Ärzt', 12, 10, undefined, 'Ärzt')).toBe(1);
  });

  it('accepts legacy SQL NULL unit labels when restoring stock for returns', () => {
    expect(unitQuantityInLarge(2, 'large', 12, 10, null, null)).toBe(2);
    expect(unitQuantityInLarge(120, 'pill', 12, 10, null, null)).toBe(1);
    expect(largeQuantityInUnit(1, 'pill', 12, 10, null, null)).toBe(120);
  });

  it('gives configured medium units precedence over built-in and configured small units', () => {
    expect(unitQuantityInLarge(12, 'unit', 12, 10, 'UNIT', 'unit')).toBe(1);
    expect(largeQuantityInUnit(1, 'unit', 12, 10, 'UNIT', 'unit')).toBe(12);

    // Rust matches a present but empty configured name against a trimmed empty unit.
    expect(unitQuantityInLarge(12, ' ', 12, 10, '', '')).toBe(1);
  });

  it.each([
    { largeToMedium: 0, mediumToSmall: 0, unitsPerLarge: 1 },
    { largeToMedium: -12, mediumToSmall: 0.5, unitsPerLarge: 1 },
    { largeToMedium: Number.NaN, mediumToSmall: 6, unitsPerLarge: 6 },
    { largeToMedium: 4, mediumToSmall: Number.NaN, unitsPerLarge: 4 },
    { largeToMedium: 0.5, mediumToSmall: 10, unitsPerLarge: 10 },
  ])('clamps conversion factors like Rust max(1.0): $largeToMedium / $mediumToSmall', ({ largeToMedium, mediumToSmall, unitsPerLarge }) => {
    expect(unitQuantityInLarge(unitsPerLarge, 'pill', largeToMedium, mediumToSmall)).toBeCloseTo(1, 12);
    expect(largeQuantityInUnit(1, 'pill', largeToMedium, mediumToSmall)).toBeCloseTo(unitsPerLarge, 12);
  });

  it.each([
    { unit: 'large', mediumUnit: undefined, smallUnit: undefined },
    { unit: 'strip', mediumUnit: undefined, smallUnit: undefined },
    { unit: 'شريط', mediumUnit: undefined, smallUnit: undefined },
    { unit: 'unit', mediumUnit: undefined, smallUnit: undefined },
    { unit: 'pill', mediumUnit: undefined, smallUnit: undefined },
    { unit: '  bLiStEr ', mediumUnit: 'Blister', smallUnit: 'Tablet' },
    { unit: '  TaBlEt ', mediumUnit: 'Blister', smallUnit: 'Tablet' },
  ])('round-trips fractional quantities for $unit', ({ unit, mediumUnit, smallUnit }) => {
    for (const quantity of [0.125, 1, 2.75, 120]) {
      const inLarge = unitQuantityInLarge(quantity, unit, 12, 10, mediumUnit, smallUnit);
      expect(largeQuantityInUnit(inLarge, unit, 12, 10, mediumUnit, smallUnit)).toBeCloseTo(quantity, 12);
    }
  });
});
