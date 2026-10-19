type UnitKind = 'large' | 'medium' | 'small';

// Rust's eq_ignore_ascii_case only folds ASCII letters, including for custom unit names.
const asciiLower = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());

function matchesConfiguredUnit(unit: string, configured?: string | null): boolean {
  return configured != null && unit === asciiLower(configured.trim());
}

function unitKind(unit: string | undefined, mediumUnit?: string | null, smallUnit?: string | null): UnitKind {
  const value = asciiLower((unit ?? 'large').trim());
  if (value === 'medium' || value === 'strip' || value === 'شريط' || matchesConfiguredUnit(value, mediumUnit)) {
    return 'medium';
  }
  if (value === 'small' || value === 'unit' || value === 'pill' || matchesConfiguredUnit(value, smallUnit)) {
    return 'small';
  }
  return 'large';
}

// Equivalent to Rust's f64::max(1.0), including NaN and nonpositive values.
const clampFactor = (factor: number) => Math.max(1, factor || 1);

export function unitQuantityInLarge(
  quantity: number,
  unit: string | undefined,
  largeToMedium: number,
  mediumToSmall: number,
  mediumUnit?: string | null,
  smallUnit?: string | null,
): number {
  const l2m = clampFactor(largeToMedium);
  const m2s = clampFactor(mediumToSmall);
  switch (unitKind(unit, mediumUnit, smallUnit)) {
    case 'medium': return quantity / l2m;
    case 'small': return quantity / (l2m * m2s);
    default: return quantity;
  }
}

export function largeQuantityInUnit(
  quantity: number,
  unit: string | undefined,
  largeToMedium: number,
  mediumToSmall: number,
  mediumUnit?: string | null,
  smallUnit?: string | null,
): number {
  const l2m = clampFactor(largeToMedium);
  const m2s = clampFactor(mediumToSmall);
  switch (unitKind(unit, mediumUnit, smallUnit)) {
    case 'medium': return quantity * l2m;
    case 'small': return quantity * l2m * m2s;
    default: return quantity;
  }
}
