export interface DrugUnitMetadata {
  trade_name?: unknown;
  trade_name_en?: unknown;
  large_unit?: unknown;
  medium_unit?: unknown;
  small_unit?: unknown;
  large_to_medium?: unknown;
  medium_to_small?: unknown;
}

export interface DrugUnitProfile {
  largeUnit: string;
  mediumUnit?: string;
  smallUnit?: string;
  largeToMedium: number;
  mediumToSmall: number;
  isSingleContainer: boolean;
}

const normalizeUnitName = (value: unknown) => String(value ?? '').trim();

const positiveFactor = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const SINGLE_PACKAGE_UNIT_TOKENS = [
  'زجاج', 'زجاجة', 'كريم', 'مرهم', 'شراب', 'امبول', 'أمبول', 'حقنة', 'حقن',
  'قطرة', 'بخاخ', 'جيل', 'جل', 'بودرة', 'بودر', 'معجون', 'شامبو',
  'صابون', 'لوشن', 'لبوس', 'فيال', 'سيروم', 'أنبوبة',
];

export function isSinglePackageUnitName(value: unknown): boolean {
  const normalized = normalizeUnitName(value).toLowerCase();
  if (!normalized) return false;
  return SINGLE_PACKAGE_UNIT_TOKENS.some(token => normalized.includes(token.toLowerCase()));
}

function hasExplicitMultipackSignal(name: string): boolean {
  return (
    /\b\d+\s*(?:x|×|\*)\s*\d+(?:[.,]\d+)?\s*(?:ml|gm|g|mg|mcg|iu)\b/i.test(name)
    || /\b\d+\s+(?:sdu|ud|amp(?:oule)?s?|vials?|sachets?|tubes?|bottles?|units?)\b/i.test(name)
    || /\b(?:sdu|single[\s-]?dose|unit[\s-]?dose)\b/i.test(name)
  );
}

export function inferSingleContainerUnitFromName(drug: DrugUnitMetadata): string | null {
  const explicitLarge = normalizeUnitName(drug.large_unit);
  const explicitMedium = normalizeUnitName(drug.medium_unit);
  const explicitSmall = normalizeUnitName(drug.small_unit);

  if (explicitMedium || explicitSmall) return null;
  if (explicitLarge) {
    if (!isSinglePackageUnitName(explicitLarge)) return null;
    return positiveFactor(drug.large_to_medium) > 1 ? null : explicitLarge;
  }

  const name = (normalizeUnitName(drug.trade_name) + ' ' + normalizeUnitName(drug.trade_name_en)).trim();
  if (!name || hasExplicitMultipackSignal(name)) return null;

  if (/\bdrops?\b|قطر(?:ة|ات)|نقط/i.test(name)) return 'زجاجة';
  if (/\bsyrup\b|\bsusp(?:ension)?\.?\b|\bsolution\b|\bsoln\b|شراب|معلق|محلول/i.test(name)) return 'زجاجة';
  if (/\bcream\b|\bointment\b|\boint\.?\b|\bgel\b|كريم|مرهم|جيل|جل/i.test(name)) return 'أنبوبة';
  if (/\bspray\b|\blotion\b|\bshampoo\b|بخاخ|لوشن|شامبو/i.test(name)) return 'زجاجة';

  return null;
}

export function resolveDrugUnitProfile(drug: DrugUnitMetadata): DrugUnitProfile {
  const explicitLarge = normalizeUnitName(drug.large_unit);
  const explicitMedium = normalizeUnitName(drug.medium_unit);
  const explicitSmall = normalizeUnitName(drug.small_unit);
  const inferredSingleUnit = inferSingleContainerUnitFromName(drug);
  const isSingleContainer = !!inferredSingleUnit && !explicitMedium && !explicitSmall;

  if (isSingleContainer) {
    return {
      largeUnit: explicitLarge || inferredSingleUnit!,
      mediumUnit: undefined,
      smallUnit: undefined,
      largeToMedium: 1,
      mediumToSmall: 1,
      isSingleContainer: true,
    };
  }

  const largeToMedium = positiveFactor(drug.large_to_medium);
  const mediumToSmall = positiveFactor(drug.medium_to_small);
  return {
    largeUnit: explicitLarge || 'علبة',
    mediumUnit: explicitMedium || (largeToMedium > 1 ? 'شريط' : undefined),
    smallUnit: explicitSmall || undefined,
    largeToMedium,
    mediumToSmall,
    isSingleContainer: false,
  };
}
