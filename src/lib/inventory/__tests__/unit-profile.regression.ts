import { inferSingleContainerUnitFromName, resolveDrugUnitProfile } from '@/lib/inventory/unit-profile';

describe('single-container drug unit inference', () => {
  it.each([
    ['DEXATROL EYE/EAR DROPS 5 ML', 'زجاجة'],
    ['BAMBEDIL 1MG/ML SYRUP 120ML', 'زجاجة'],
    ['TOPICAL CREAM 30 GM', 'أنبوبة'],
    ['NASAL SPRAY 15 ML', 'زجاجة'],
  ])('infers a safe one-package unit', (tradeName, expectedUnit) => {
    expect(inferSingleContainerUnitFromName({ trade_name: tradeName })).toBe(expectedUnit);
    expect(resolveDrugUnitProfile({ trade_name: tradeName, large_to_medium: 5 })).toMatchObject({
      largeUnit: expectedUnit,
      largeToMedium: 1,
      mediumToSmall: 1,
      isSingleContainer: true,
    });
  });

  it('does not collapse an explicit multi-pack eye-drop product', () => {
    expect(resolveDrugUnitProfile({
      trade_name: 'AQUALARM INTENSIVE UD EYE DROPS 30 X 0.5ML SDU',
      large_to_medium: 30,
    })).toMatchObject({
      isSingleContainer: false,
      largeToMedium: 30,
      mediumUnit: 'شريط',
    });
  });

  it('preserves explicitly configured bottle-to-packet conversions', () => {
    expect(resolveDrugUnitProfile({
      trade_name: 'CUSTOM DROPS 5 ML',
      large_unit: 'زجاجة',
      medium_unit: 'باكيت',
      small_unit: 'مل',
      large_to_medium: 6,
      medium_to_small: 10,
    })).toEqual({
      largeUnit: 'زجاجة',
      mediumUnit: 'باكيت',
      smallUnit: 'مل',
      largeToMedium: 6,
      mediumToSmall: 10,
      isSingleContainer: false,
    });
  });

  it('preserves an explicit bottle conversion even when the medium-unit label is missing', () => {
    expect(resolveDrugUnitProfile({
      trade_name: 'CONFIGURED LIQUID 100 ML',
      large_unit: 'زجاجة',
      large_to_medium: 6,
    })).toMatchObject({
      largeUnit: 'زجاجة',
      largeToMedium: 6,
      isSingleContainer: false,
    });
  });
});
